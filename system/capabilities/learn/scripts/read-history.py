#!/usr/bin/env python3
"""Page through the visible evidence in one bound native chat."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import uuid


PAGE_BYTES = 8_000


class HistoryError(Exception):
    pass


def native_source(host, session):
    if host == "codex":
        home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
        matches = [
            path
            for folder in ("sessions", "archived_sessions")
            for path in (home / folder).rglob(f"rollout-*-{session}.jsonl")
        ]
    else:
        home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
        matches = list((home / "projects").glob(f"*/{session}.jsonl"))
    if len(matches) != 1:
        raise HistoryError("The current session's native file is missing or ambiguous.")
    return matches[0]


def open_source(path):
    if not path.is_absolute() or path.resolve() != path or not path.is_file():
        raise HistoryError("Expected a regular, absolute native transcript path.")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    if sys.platform == "win32":
        flags |= os.O_BINARY
    stream = os.fdopen(os.open(path, flags), "rb")
    info = os.fstat(stream.fileno())
    current = path.stat()
    if not stat.S_ISREG(info.st_mode) or identity(info) != identity(current):
        stream.close()
        raise HistoryError("The native transcript changed while opening.")
    return stream


def identity(info):
    return [info.st_dev, info.st_ino]


def fingerprint(raw):
    return hashlib.sha256(raw).hexdigest()


def message_text(content):
    if isinstance(content, str):
        return content
    return "".join(block.get("text", "") for block in content
                   if block.get("type") in {"text", "input_text", "output_text"})


def matches_request(content, request):
    text = message_text(content)
    if text == request:
        return True
    # Claude Code can record a slash invocation in a native command envelope.
    if request == "/learn":
        return re.fullmatch(
            r"\s*<command-message>learn</command-message>\s*"
            r"<command-name>/learn</command-name>\s*"
            r"(?:<command-args>\s*</command-args>\s*)?", text) is not None
    return False


def review_content(content):
    if isinstance(content, list):
        return [review_content(block) for block in content]
    if isinstance(content, dict):
        kind = content.get("type")
        if kind in {"image", "input_image", "output_image", "image_url", "input_audio",
                    "audio", "document", "resource", "resource_link", "file"}:
            attachment = dict(content)
            if isinstance(attachment.get("data"), str):
                del attachment["data"]
            source = attachment.get("source")
            if isinstance(source, dict) and source.get("type") == "base64":
                attachment["source"] = {key: value for key, value in source.items() if key != "data"}
            for key in ("url", "image_url", "file_data"):
                value = attachment.get(key)
                if isinstance(value, str) and value.startswith("data:"):
                    del attachment[key]
            if attachment != content or kind in {"input_image", "output_image", "resource_link"}:
                attachment["coverage"] = "attachment body is not part of this text review"
                return attachment
        return {key: review_content(value) for key, value in content.items()}
    return content


def claude_event(record):
    role = record.get("type")
    if role not in {"user", "assistant"} or any(record.get(key) for key in
            ("isMeta", "isSidechain", "isCompactSummary", "isSynthetic")):
        return None
    content = record.get("message", {}).get("content", [])
    if isinstance(content, list):
        content = [item for item in content
                   if item["type"] not in {"thinking", "redacted_thinking"}]
    if not content:
        return None
    event = {"role": role, "content": review_content(content), "message_id": record.get("uuid")}
    if "toolUseResult" in record:
        event["tool_result_details"] = review_content(record["toolUseResult"])
    return event


CODEX_CALLS = {"function_call", "custom_tool_call", "mcp_tool_call", "local_shell_call",
               "web_search_call", "image_generation_call", "computer_call", "tool_call"}
CODEX_RESULTS = {"function_call_output", "custom_tool_call_output", "mcp_tool_call_output",
                 "computer_call_output", "tool_call_output", "tool_search_output"}


def codex_event(record):
    if record.get("type") != "response_item":
        return None
    item = record["payload"]
    kind = item["type"]
    if kind == "message":
        role = item.get("role")
        if role not in {"user", "assistant"} or item.get("phase") not in {None, "commentary", "final"}:
            return None
        content = item.get("content", [])
        if role == "user":
            metadata = item.get("internal_chat_message_metadata_passthrough") or {}
            kinds = metadata.get("content_item_kinds")
            details = metadata.get("content_item_metadata")
            # Older hosts have no way to distinguish user input from injected context.
            if not kinds or not details:
                return {"coverage": "user message provenance unavailable"}
            if len(kinds) == len(details) == len(content):
                content = [block for block, category, detail in zip(content, kinds, details)
                           if category.startswith("user.") and detail.get("provenance", {}).get("type") == "user"]
            elif kinds == ["user.text"] and any(
                    value.get("provenance", {}).get("type") == "user" for value in details):
                content = [block for block in content if block.get("type") == "input_text"]
            else:
                return None if not any(kind.startswith("user.") for kind in kinds) else {
                    "coverage": "user message block provenance unavailable"}
        return {"role": role, "content": review_content(content)} if content else None
    if kind in CODEX_CALLS | CODEX_RESULTS | {"tool_search_call"}:
        result = item.get("result")
        if kind == "image_generation_call" and isinstance(result, str) and (
                result.startswith("data:image/") or
                len(result) > PAGE_BYTES and re.fullmatch(r"[A-Za-z0-9+/=]+", result)):
            item = {key: value for key, value in item.items() if key != "result"}
            item["coverage"] = "generated image body is not part of this text review"
        return {"tool_event": kind, "content": review_content(item)}
    if "tool" in kind or kind.endswith(("_call", "_output")):
        return {"coverage": "unsupported tool record", "tool_event": kind}
    return None


def claude_lineage(nodes, tip, gaps):
    ordered = []
    seen = set()
    while tip is not None:
        if tip in seen or tip not in nodes:
            gaps.append("The active Claude branch has a missing or circular parent.")
            break
        seen.add(tip)
        parent, entry, cwd, boundary = nodes[tip]
        ordered.append((entry, cwd))
        if boundary and parent is None:
            gaps.append("A Claude compaction boundary has no original parent.")
        tip = parent
    ordered.reverse()
    if any(left[0][0] >= right[0][0] for left, right in zip(ordered, ordered[1:])):
        raise HistoryError("Claude's parent chain conflicts with the source order.")
    return ordered


def prepare(args):
    session = str(uuid.UUID(args.session))
    if args.host == "codex":
        if not args.turn or args.request_stdin:
            raise HistoryError("Provide the current Codex turn ID.")
        anchor = str(uuid.UUID(args.turn))
    else:
        if bool(args.turn) == args.request_stdin:
            raise HistoryError("Provide the current Claude message UUID or exact request on stdin.")
        anchor = str(uuid.UUID(args.turn)) if args.turn else sys.stdin.read()
        if not anchor.strip():
            raise HistoryError("The current Claude request is empty.")
    cwd = Path(args.cwd).resolve(strict=True)
    source = Path(args.source) if args.source else native_source(args.host, session)
    expected = source.stem == session if args.host == "claude" else source.stem.endswith("-" + session)
    if source.suffix != ".jsonl" or not expected:
        raise HistoryError("The native file name does not match the current session.")

    gaps, entries, nodes = [], [], {}
    tip = None
    current_turn = False
    seen_user = False
    with open_source(source) as stream:
        source_id = identity(os.fstat(stream.fileno()))
        line = 0
        while True:
            offset = stream.tell()
            raw = stream.readline()
            if not raw or not raw.endswith(b"\n"):
                break
            line += 1
            record = json.loads(raw)
            entry = [line, offset, len(raw), fingerprint(raw)]
            kind = record.get("type")
            if args.host == "codex":
                payload = record.get("payload", {})
                if line == 1 and (kind != "session_meta" or payload.get("id") != session
                                  or not payload.get("cwd")):
                    raise HistoryError("Codex session metadata does not match the requested chat.")
                if kind == "session_meta" and payload.get("forked_from_id"):
                    gaps.append("The Codex chat has a fork ancestor. Verify the inherited beginning against the host.")
                if kind in {"session_meta", "turn_context"} and payload.get("cwd"):
                    if Path(payload["cwd"]).resolve() != cwd:
                        raise HistoryError("The Codex chat crosses the current project boundary.")
                if kind == "event_msg" and payload.get("type") == "task_started":
                    current_turn = payload.get("turn_id") == anchor
                if kind == "turn_context" and payload.get("turn_id") == anchor:
                    current_turn = True
                if kind == "compacted" and not seen_user:
                    gaps.append("The Codex log contains compaction before the first verified user message.")
                event = codex_event(record)
                if event:
                    entries.append(entry)
                    if event.get("role") == "user":
                        seen_user = True
                        if current_turn:
                            tip = line
                            break
            elif not record.get("isSidechain") and record.get("uuid"):
                key = record["uuid"]
                if key in nodes:
                    raise HistoryError("Duplicate Claude message UUID in native history.")
                if record.get("sessionId") not in {None, session}:
                    raise HistoryError("The Claude transcript contains a different session.")
                boundary = kind == "system" and record.get("subtype") == "compact_boundary"
                parent = record.get("logicalParentUuid") if boundary else record.get("parentUuid")
                nodes[key] = (parent, entry, record.get("cwd"), boundary)
                event = claude_event(record)
                if event and event["role"] == "user" and message_text(event["content"]):
                    if args.turn and key == anchor:
                        tip = key
                        break
                    if args.request_stdin:
                        tip = key if matches_request(event["content"], anchor) else None
        if tip is None:
            raise HistoryError("The current Learn request is not yet identifiable in the original file.")
        if args.host == "claude":
            all_entries = claude_lineage(nodes, tip, gaps)
            project_paths = [Path(path).resolve() for _, path in all_entries if path]
            if not project_paths or any(path != cwd for path in project_paths):
                raise HistoryError("The Claude branch does not match the current project.")
            entries = [entry for entry, _ in all_entries]

    index = {"source": str(source), "identity": source_id, "host": args.host, "entries": entries}
    with tempfile.NamedTemporaryFile(mode="w", prefix="aiverse-learn-", suffix=".json",
                                     encoding="utf-8", delete=False) as handle:
        json.dump(index, handle)
    return {"index": handle.name, "source": str(source), "first_line": entries[0][0],
            "last_line": entries[-1][0], "indexed_records": len(entries), "gaps": gaps,
            "next": [0, 0]}


def page(args):
    index = json.loads(Path(args.index).read_text(encoding="utf-8"))
    entries = index["entries"]
    record_number, consumed = args.cursor
    if not (0 <= record_number < len(entries)) or consumed < 0:
        raise HistoryError("Use the next cursor returned by the previous page.")
    extract = codex_event if index["host"] == "codex" else claude_event
    blocks = []
    with open_source(Path(index["source"])) as stream:
        if identity(os.fstat(stream.fileno())) != index["identity"]:
            raise HistoryError("The native transcript was replaced. Restart the review.")
        remaining = PAGE_BYTES
        while record_number < len(entries) and remaining >= 256:
            line, offset, length, digest = entries[record_number]
            stream.seek(offset)
            raw = stream.read(length)
            if fingerprint(raw) != digest:
                raise HistoryError("A source record changed. Restart the review.")
            record = json.loads(raw)
            event = extract(record)
            if event:
                if record.get("timestamp"):
                    event["timestamp"] = record["timestamp"]
                payload = json.dumps(event, ensure_ascii=True, separators=(",", ":"))
                if consumed >= len(payload):
                    raise HistoryError("The cursor is outside the source record.")
                # Include escaping and page wrapper overhead in the output budget.
                count = (remaining - 128) // 2
                end = min(consumed + count, len(payload))
                block = {"line": line, "start": consumed, "end": end,
                         "last": end == len(payload), "data": payload[consumed:end]}
                blocks.append(block)
                remaining -= len(json.dumps(block)) + 2
                if end < len(payload):
                    consumed = end
                    break
            record_number += 1
            consumed = 0
    finished = record_number == len(entries)
    return {"records": blocks, "reviewed_through": entries[record_number - 1][0] if record_number else 0,
            "next": None if finished else [record_number, consumed], "end_of_index": finished}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("prepare")
    start.add_argument("--host", choices=("codex", "claude"), required=True)
    start.add_argument("--session", required=True)
    start.add_argument("--turn")
    start.add_argument("--request-stdin", action="store_true")
    start.add_argument("--cwd", required=True)
    start.add_argument("--source")
    read = commands.add_parser("page")
    read.add_argument("--index", required=True)
    read.add_argument("--cursor", type=int, nargs=2, required=True)
    args = parser.parse_args()
    try:
        result = prepare(args) if args.command == "prepare" else page(args)
    except HistoryError as error:
        parser.exit(1, f"History unavailable: {error}\n")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        parser.exit(1, "History unavailable: the original transcript or index is missing, unreadable or invalid.\n")
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
