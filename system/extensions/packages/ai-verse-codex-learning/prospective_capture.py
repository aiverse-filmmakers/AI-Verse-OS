"""Prospective native transcript capture using the existing approved local hooks.

Only a new, physically bound session can establish a source boundary. Resumed
history is never retrospectively attributed. Native snapshots stay transient;
only visible user and assistant text is passed to the private v1 archive.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from claude_capture import CaptureBlocked, MAX_SOURCE_BYTES, _supplied_source
from chat_archive import ArchiveEvent, ChatArchive, MAX_ARCHIVE_BYTES, MAX_BATCH_EVENTS, stage_prompt, reconcile_prompts

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



def _snapshot(stream, size, bridge, event, scope, session, start):
    """Stream the native source; retain bounded visible rows, never hidden bulk."""
    rows, prefixes = [], {0: _digest(b"")}
    hasher = hashlib.sha256()
    offset, retained, visible_count = 0, 0, 0
    complete_end, terminated = 0, True
    seen_meta = False
    while True:
        line = stream.readline(MAX_SOURCE_BYTES + 1)
        if not line:
            break
        if len(line) > MAX_SOURCE_BYTES:
            raise CaptureBlocked("native source record exceeds read budget")
        if offset == start:
            prefixes[start] = hasher.hexdigest()
        if not line.endswith(b"\n"):
            # A parseable but unflushed tail is still provisional.
            prefixes[complete_end] = hasher.hexdigest()
            hasher.update(line)
            offset += len(line)
            terminated = False
            break
        row = _json(line)
        visible = _text(row, bridge.harness)
        payload = row.get("payload", {}) if bridge.harness == "codex" else row
        if bridge.harness == "codex" and row.get("type") in {"session_meta", "turn_context"}:
            if payload.get("cwd") and Path(payload["cwd"]).resolve() != Path(event["cwd"]):
                raise CaptureBlocked("transcript changed workspace")
            if row["type"] == "session_meta":
                if seen_meta or offset != 0 or payload.get("id") != session:
                    raise CaptureBlocked("native session metadata mismatch")
                seen_meta = True
        if bridge.harness == "claude":
            if row.get("cwd"):
                cwd = Path(row["cwd"])
                if not cwd.is_absolute() or bridge.scope(str(cwd), "") != scope:
                    raise CaptureBlocked("Claude transcript changed workspace")
            if row.get("sessionId") not in {None, session}:
                raise CaptureBlocked("source session changed")
        if visible or (bridge.harness == "codex" and row.get("type") == "session_meta"):
            retained += len(line)
            visible_count += len(visible)
            if retained > MAX_ARCHIVE_BYTES or visible_count > MAX_BATCH_EVENTS:
                raise CaptureBlocked("native visible source capacity exceeded")
            prefixes[offset] = hasher.hexdigest()
            rows.append((offset, line, row))
        hasher.update(line)
        offset += len(line)
        complete_end = offset
    if complete_end == offset:
        prefixes[complete_end] = hasher.hexdigest()
    elif start == complete_end:
        # The boundary can be exactly before a provisional tail.
        # Its prefix was captured at the start of that tail above.
        pass
    if offset != size:
        raise CaptureBlocked("native source changed during streaming")
    return {"rows": rows, "prefixes": prefixes, "size": size,
            "complete_end": complete_end, "terminated": terminated}

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


def _capture(bridge, event):
    """Return content-free capture state; never claim complete UI coverage."""
    if bridge.config.get("chat_history") != "prospective":
        return {"status": "disabled"}
    session = event.get("session_id")
    if not isinstance(session, str) or not session or len(session) > 128:
        return {"status": "blocked", "reason": "invalid session"}
    journal_id = None
    try:
        with bridge.lock(session):
            scope = _scope(bridge, event, session)
            state = bridge.state(session)
            # A private turn makes the remainder of this native session private.
            # Replaying its whole source later must never backfill that interval.
            if event.get("capture_opt_out") is True:
                state["chat_history_private"] = True
                bridge.save(state)
            if state.get("chat_history_private"):
                raise CaptureBlocked("private session; start a new chat to record")
            epoch = bridge.config.get("chat_history_epoch", "initial")
            boundary = state.get("chat_history_boundary")
            source = event.get("transcript_path")
            # The native transcript may not contain the submitted prompt yet.
            # Preserve the actual hook observation first, under the same fresh
            # boundary and consent. It makes no native-offset/source-ID claim.
            if (event.get("hook_event_name") == "UserPromptSubmit" and boundary
                    and boundary.get("protocol") == PROTOCOL
                    and boundary.get("scope") == scope and boundary.get("source") == source
                    and boundary.get("harness") == bridge.harness
                    and boundary.get("session") == session
                    and boundary.get("epoch", "initial") == epoch):
                prompt = event.get("prompt")
                identity = event.get("turn_id")
                if isinstance(prompt, str) and prompt and "AI_VERSE_REVIEW_CONTINUATION" not in prompt:
                    if not isinstance(identity, str) or not identity:
                        raise CaptureBlocked("prompt observation identity unavailable")
                    pending_archive_id = _digest(f"{bridge.harness}:{scope}:{session}:{boundary['start']}".encode())[:40]
                    pending_archive = ChatArchive(bridge.root, scope=scope, authorized_scope=scope,
                        archive_id=pending_archive_id, chat_id=pending_archive_id,
                        origin=bridge.harness, session_id=session,
                        authorization_check=lambda selected: selected == _scope(bridge, event, session))
                    journal_id = stage_prompt(pending_archive, epoch=epoch,
                                              observation_id=identity, text=prompt)
            if (event.get("hook_event_name") == "SessionStart"
                    and event.get("source") == "startup" and not boundary):
                # Native hosts can announce startup before the transcript file
                # exists. Remember only this authorized prospective start.
                state["chat_history_pending"] = {"session": session, "scope": scope,
                                                 "harness": bridge.harness, "epoch": epoch}
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
                        "harness": bridge.harness, "session": session, "epoch": epoch}
                    bridge.save(state)
                    return {"status": "recording", "saved": 0}
            # The secure reader requires a native filename matching its session.
            # Codex rollouts include a prefix; validate its exact UUID suffix.
            visitor = lambda stream, size: _snapshot(stream, size, bridge, event, scope, session,
                                                     boundary.get("start", 0) if boundary else 0)
            if bridge.harness == "codex":
                path = Path(source)
                if not path.stem.endswith("-" + session):
                    raise CaptureBlocked("Codex transcript identity mismatch")
                snapshot = _read_codex(path, visit=visitor)
            else:
                snapshot = _supplied_source(source, session, visit=visitor)
            rows = snapshot["rows"]
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
                if pending != {"session": session, "scope": scope, "harness": bridge.harness, "epoch": epoch}:
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
                    end = snapshot["complete_end"]
                boundary = {"protocol": PROTOCOL, "scope": scope, "source": source,
                            "start": end, "prefix_sha256": snapshot["prefixes"][end],
                            "harness": bridge.harness, "session": session, "epoch": epoch}
                state["chat_history_boundary"] = boundary
                bridge.save(state)
                if not visible:
                    return {"status": "recording", "saved": 0, "coverage": "native visible text"}
            if (boundary.get("protocol") != PROTOCOL or boundary.get("scope") != scope
                    or boundary.get("source") != source or boundary.get("harness") != bridge.harness
                    or boundary.get("session") != session
                    or boundary.get("epoch", "initial") != epoch):
                raise CaptureBlocked("native session boundary changed")
            start = boundary["start"]
            if snapshot["size"] < start or snapshot["prefixes"].get(start) != boundary["prefix_sha256"]:
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
                        record_terminated=True, attachment_availability="not_embedded",
                        timestamp=row.get("timestamp"), revision=row.get("uuid"),
                        branch=row.get("parentUuid")))
            archive_id = _digest(f"{bridge.harness}:{scope}:{session}:{start}".encode())[:40]
            archive = ChatArchive(bridge.root, scope=scope, authorized_scope=scope,
                archive_id=archive_id, chat_id=archive_id, origin=bridge.harness,
                session_id=session, authorization_check=lambda selected: selected == _scope(bridge, event, session))
            receipt = archive.append_batch(tuple(events))
            pending_count = reconcile_prompts(archive, epoch=epoch)
            interrupted = event.get("hook_event_name") == "Interrupt"
            return {"status": "partial" if interrupted else (
                        "pending" if pending_count or (snapshot["size"] and not snapshot["terminated"]) else "saved"),
                    "saved": receipt.saved, "archive_id": archive_id,
                    "pending_prompts": pending_count,
                    "checkpoint_sequence": receipt.checkpoint_sequence,
                    "source_end_offset": receipt.checkpoint_source_end_offset,
                    "interrupted": interrupted,
                    "coverage": "native visible text; attachments not embedded"}
    except CaptureBlocked as exc:
        return {"status": "blocked", "reason": str(exc),
                **({"pending_journal_id": journal_id} if journal_id else {})}
    except Exception:
        return {"status": "blocked", "reason": "native capture validation failed",
                **({"pending_journal_id": journal_id} if journal_id else {})}


def _read_codex(path, *, visit=None):
    # Reuse the exact no-follow reader without renaming or copying native data.
    # Its identity check takes the native stem only; record session identity is
    # independently checked by the prospective boundary and native metadata.
    return _supplied_source(str(path), path.stem, visit=visit)


def capture(bridge, event):
    receipt = _capture(bridge, event)
    if receipt.get("status") == "disabled":
        return receipt
    try:
        session = event.get("session_id")
        with bridge.lock(session):
            scope = _scope(bridge, event, session)
            state = bridge.state(session)
            state["chat_history_last"] = {**receipt, "scope": scope,
                "epoch": bridge.config.get("chat_history_epoch", "initial")}
            bridge.save(state)
    except Exception:
        # A checkpoint write must never be reported as successful if its current
        # status cannot be retained. Canonical messages already written survive.
        if receipt.get("status") in {"saved", "partial", "pending"}:
            return {"status": "blocked", "reason": "capture status could not be retained"}
    return receipt
