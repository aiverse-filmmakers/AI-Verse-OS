"""Prospective native transcript capture using the existing approved local hooks.

Only a new, physically bound session can establish a source boundary. Resumed
history is never retrospectively attributed. Native snapshots stay transient;
only visible user and assistant text is passed to the private v1 archive.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from claude_capture import CaptureBlocked, _supplied_source
from chat_archive import ArchiveEvent, ChatArchive, MAX_ARCHIVE_BYTES

PROTOCOL = "native-transcript-prospective/v1"
CODEX_VERSIONS = {"0.167.0", "0.167.0-alpha.3.2"}
CLAUDE_VERSIONS = {"2.1.316"}


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise CaptureBlocked("duplicate transcript key")
            result[key] = value
        return result
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise CaptureBlocked("invalid transcript record")
    return value


def _rows(raw):
    offset = 0
    for line in raw.splitlines(keepends=True):
        if not line.endswith(b"\n"):
            break
        yield offset, line, _json(line)
        offset += len(line)


def _text(record, harness):
    if harness == "claude":
        if record.get("type") not in {"user", "assistant"}:
            return []
        if any(record.get(k) for k in (
            "isMeta", "isSidechain", "isCompactSummary", "isSynthetic")):
            return []
        if "toolUseResult" in record:
            return []
        message = record.get("message", {})
        role = record["type"]
        if not isinstance(message, dict) or message.get("role", role) != role:
            raise CaptureBlocked("ambiguous message role")
        content = message.get("content")
        if isinstance(content, str):
            return [(0, role, content)]
        if not isinstance(content, list):
            raise CaptureBlocked("unsupported message content")
        if role == "user" and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return []
        return [(i, role, b["text"]) for i, b in enumerate(content)
                if isinstance(b, dict) and b.get("type") == "text"
                and isinstance(b.get("text"), str)]
    if record.get("type") != "response_item":
        return []
    message = record.get("payload", {})
    if message.get("type") != "message" or message.get("role") not in {"user", "assistant"}:
        return []
    role = message["role"]
    if message.get("phase") not in {None, "commentary", "final"} or message.get("channel") not in {None, "commentary", "final"}:
        return []
    metadata = message.get("internal_chat_message_metadata_passthrough") or {}
    if role == "user":
        # Native Codex also encodes harness context as user-role messages.
        # Only the actual user.text provenance is eligible for the archive.
        kinds = metadata.get("content_item_kinds", [])
        provenance = metadata.get("content_item_metadata", [])
        if "user.text" not in kinds or not any(
            isinstance(m, dict) and m.get("provenance", {}).get("type") == "user"
            for m in provenance
        ):
            return []
    content = message.get("content")
    if not isinstance(content, list):
        raise CaptureBlocked("unsupported native content")
    return [(i, role, b["text"]) for i, b in enumerate(content)
            if isinstance(b, dict) and b.get("type") in {"input_text", "output_text"}
            and isinstance(b.get("text"), str)]


def _scope(bridge, event, session):
    cwd = Path(event.get("cwd", ""))
    if not cwd.is_absolute() or not cwd.is_dir() or cwd.resolve() != cwd:
        raise CaptureBlocked("physical host cwd required")
    cwd.relative_to(bridge.root)
    selected = bridge.scope(str(cwd), "")
    state = bridge.state(session)
    if state.get("scope") != selected:
        raise CaptureBlocked("current session binding changed")
    authorization = bridge.owner("archive_authorize", {"scope": selected, "session_id": session})
    if authorization.get("scope") != selected or authorization.get("decision") != "allow":
        raise CaptureBlocked("archive permission denied")
    return selected


def capture(bridge, event):
    """Return content-free capture state; never claim complete UI coverage."""
    if bridge.config.get("chat_history") != "prospective":
        return {"status": "disabled"}
    if event.get("capture_opt_out") is True:
        return {"status": "blocked", "reason": "private session"}
    session = event.get("session_id")
    if not isinstance(session, str) or not session or len(session) > 128:
        return {"status": "blocked", "reason": "invalid session"}
    try:
        with bridge.lock(session):
            scope = _scope(bridge, event, session)
            state = bridge.state(session)
            boundary = state.get("chat_history_boundary")
            source = event.get("transcript_path")
            if (event.get("hook_event_name") == "SessionStart"
                    and event.get("source") == "startup" and not boundary):
                # Native hosts can announce startup before the transcript file
                # exists. Remember only this authorized prospective start.
                state["chat_history_pending"] = {"session": session, "scope": scope,
                                                 "harness": bridge.harness}
                bridge.save(state)
            if not isinstance(source, str) or not Path(source).is_absolute():
                raise CaptureBlocked("host transcript path unavailable")
            if (not boundary and event.get("hook_event_name") == "SessionStart"
                    and event.get("source") == "startup"):
                path = Path(source)
                expected_name = (path.stem == session if bridge.harness == "claude"
                                 else path.stem.endswith("-" + session))
                if not expected_name or path.suffix != ".jsonl" or ".." in path.parts:
                    raise CaptureBlocked("native transcript identity mismatch")
                try:
                    path.lstat()
                except FileNotFoundError:
                    # Both native CLIs may flush the file only after the first
                    # reply. Absence observed at authorized startup is the
                    # prospective zero-byte boundary, never an import grant.
                    state["chat_history_boundary"] = {
                        "protocol": PROTOCOL, "scope": scope, "source": source,
                        "start": 0, "prefix_sha256": _digest(b""),
                        "harness": bridge.harness, "session": session}
                    bridge.save(state)
                    return {"status": "recording", "saved": 0}
            # The secure reader requires a native filename matching its session.
            # Codex rollouts include a prefix; validate its exact UUID suffix.
            if bridge.harness == "codex":
                path = Path(source)
                if not path.stem.endswith("-" + session):
                    raise CaptureBlocked("Codex transcript identity mismatch")
                raw = _read_codex(path)
            else:
                raw = _supplied_source(source, session)
            if len(raw) > MAX_ARCHIVE_BYTES:
                raise CaptureBlocked("native source capacity exceeded")
            rows = list(_rows(raw))
            if bridge.harness == "codex":
                if not rows or rows[0][2].get("type") != "session_meta" or rows[0][2].get("payload", {}).get("id") != session:
                    raise CaptureBlocked("native session metadata mismatch")
                if rows[0][2]["payload"].get("cli_version") not in CODEX_VERSIONS:
                    raise CaptureBlocked("native Codex version not qualified")
            if bridge.harness == "claude":
                if any(_text(row, "claude") and row.get("version") not in CLAUDE_VERSIONS
                       for _, _, row in rows):
                    raise CaptureBlocked("native Claude version not qualified")
            if not boundary:
                pending = state.get("chat_history_pending")
                if pending != {"session": session, "scope": scope, "harness": bridge.harness}:
                    raise CaptureBlocked("new session boundary required")
                visible = [(offset, _text(row, bridge.harness)) for offset, _, row in rows
                           if _text(row, bridge.harness)]
                # When startup preceded file creation, the first prompt may
                # already be in the source. Admit only that exact current input.
                if visible:
                    expected = event.get("prompt")
                    if (event.get("hook_event_name") != "UserPromptSubmit"
                            or len(visible) != 1 or len(visible[0][1]) != 1
                            or visible[0][1][0][1:] != ("user", expected)):
                        state.pop("chat_history_pending", None)
                        bridge.save(state)
                        raise CaptureBlocked("existing messages require explicit history import")
                    end = visible[0][0]
                else:
                    end = sum(len(line) for _, line, _ in rows)
                boundary = {"protocol": PROTOCOL, "scope": scope, "source": source,
                            "start": end, "prefix_sha256": _digest(raw[:end]),
                            "harness": bridge.harness, "session": session}
                state["chat_history_boundary"] = boundary
                bridge.save(state)
                if not visible:
                    return {"status": "recording", "saved": 0, "coverage": "native visible text"}
            if (boundary.get("protocol") != PROTOCOL or boundary.get("scope") != scope
                    or boundary.get("source") != source or boundary.get("harness") != bridge.harness
                    or boundary.get("session") != session):
                raise CaptureBlocked("native session boundary changed")
            start = boundary["start"]
            if len(raw) < start or _digest(raw[:start]) != boundary["prefix_sha256"]:
                raise CaptureBlocked("native session prefix changed")
            from bridge import SECRET
            events = []
            for offset, line, row in rows:
                if offset < start:
                    continue
                payload = row.get("payload", {}) if bridge.harness == "codex" else row
                if row.get("type") in {"session_meta", "turn_context"}:
                    if payload.get("cwd") and Path(payload["cwd"]).resolve() != Path(event["cwd"]):
                        raise CaptureBlocked("transcript changed workspace")
                    if row["type"] == "session_meta" and payload.get("id") != session:
                        raise CaptureBlocked("source session changed")
                if bridge.harness == "claude" and row.get("cwd"):
                    record_cwd = Path(row["cwd"])
                    if not record_cwd.is_absolute() or bridge.scope(str(record_cwd), "") != scope:
                        raise CaptureBlocked("Claude transcript changed workspace")
                if bridge.harness == "claude" and row.get("sessionId") not in {None, session}:
                    raise CaptureBlocked("source session changed")
                for index, role, text in _text(row, bridge.harness):
                    if SECRET.search(text):
                        raise CaptureBlocked("visible credential requires operator decision")
                    identity = _digest(f"{session}:{offset}:{index}".encode())
                    events.append(ArchiveEvent(
                        source_event_id=identity, source_byte_offset=offset,
                        source_end_offset=offset + len(line), source_record_sha256=_digest(line),
                        source_record_bytes=line, block_index=index, message_id=identity,
                        sequence=len(events) + 1, role=role, text=text,
                        record_terminated=True, attachment_availability="not_embedded"))
            archive_id = _digest(f"{bridge.harness}:{scope}:{session}:{start}".encode())[:40]
            archive = ChatArchive(bridge.root, scope=scope, authorized_scope=scope,
                archive_id=archive_id, chat_id=archive_id, origin=bridge.harness,
                session_id=session, authorization_check=lambda selected: selected == _scope(bridge, event, session))
            receipt = archive.append_batch(tuple(events))
            return {"status": "pending" if raw and not raw.endswith(b"\n") else "saved",
                    "saved": receipt.saved, "archive_id": archive_id,
                    "coverage": "native visible text; attachments not embedded"}
    except CaptureBlocked as exc:
        return {"status": "blocked", "reason": str(exc)}
    except Exception:
        return {"status": "blocked", "reason": "native capture validation failed"}


def _read_codex(path):
    # Reuse the exact no-follow reader without renaming or copying native data.
    # Its identity check takes the native stem only; record session identity is
    # independently checked by the prospective boundary and native metadata.
    return _supplied_source(str(path), path.stem)
