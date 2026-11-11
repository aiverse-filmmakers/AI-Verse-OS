"""Claude Code transcript catch-up transport. OFF until explicit post-pilot approval.

No scanning and no guessed paths: only the host's absolute transcript_path for
its own session_id. The 1A JSONL reader remains unverified against real Claude
versions and is used here only as a synthetic-fixture contract until pilot.
The capture module does not install hooks or persist source raw tool records.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

MAX_SOURCE_BYTES = 8_000_000
MAX_RECORDS = 25_000
_NATIVE_OS_OPEN = os.open  # Platform capability, unaffected by synthetic open-race injection.
# Until a separately reviewed, version-scoped live pilot has proved host coverage,
# no persisted configuration flag can activate real-world capture.
_HOST_COVERAGE_ADMITTED = False
# A separate reviewed OS owner must attest each source record AT OBSERVATION
# TIME before a history can ever be archived. No live issuer exists in 1C.
# Keep independent of the host-coverage gate so neither can be bypassed by
# persisted config or a retroactively fabricated session-state JSON ledger.
_HISTORY_PROVENANCE_ISSUER_ADMITTED = False


class CaptureBlocked(ValueError):
    status = "blocked"


def _module(filename: str, name: str):
    # Only sibling source modules from the same installed extension may load.
    # Resolution must not silently follow a substituted symlink.
    if filename not in {"claude_transcript.py", "chat_archive.py"}:
        raise CaptureBlocked("unapproved source module")
    path = Path(__file__).absolute().parent / filename
    if path.is_symlink() or not path.is_file():
        raise CaptureBlocked("capture dependency missing or substituted")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise CaptureBlocked("capture module missing")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _identity(info) -> tuple:
    return (info.st_dev, info.st_ino)


def _file_snapshot(info) -> tuple:
    # Device and inode alone are inadequate: an unlink/replace can reuse an
    # inode immediately, especially in rapid synthetic and real local writes.
    return (_identity(info), info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _normal_file(info):
    return stat.S_ISREG(info.st_mode)


def _normal_dir(info):
    return stat.S_ISDIR(info.st_mode)


def _supplied_source(path_string: str, session_id: str, *, visit=None):
    """Read ONLY the session's supplied path through no-follow directory FDs.

    Checks every directory inode both before and after opening the file, not
    just the leaf path. Any replacement, symlink, truncated/changing file, or
    unsupported dir_fd platform fails closed without opening a substitute.
    """
    if not isinstance(path_string, str) or not path_string:
        raise CaptureBlocked("transcript_path missing")
    path = Path(path_string)
    if (not path.is_absolute() or path.suffix != ".jsonl"
            or path.stem != session_id or "\x00" in path_string
            or any(part in {"..", "."} for part in path.parts)):
        raise CaptureBlocked("transcript_path does not match supplied session")
    if not isinstance(session_id, str) or len(session_id) > 128:
        raise CaptureBlocked("invalid source session")
    nofollow = getattr(os, "O_NOFOLLOW", None)
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if nofollow is None or directory_flag is None or _NATIVE_OS_OPEN not in os.supports_dir_fd:
        raise CaptureBlocked("secure directory descriptor opens unavailable")

    # All components are opened relative to the previously verified directory.
    # Retaining descriptors makes parent replacement visible in the final check.
    parts = path.parts[1:]
    if not parts:
        raise CaptureBlocked("transcript filename missing")
    handles = []
    path_prefixes = []
    try:
        base = Path(path.anchor)
        root_stat = base.lstat()
        if not _normal_dir(root_stat) or stat.S_ISLNK(root_stat.st_mode):
            raise CaptureBlocked("source root is not a physical directory")
        parent = os.open(base, os.O_RDONLY | directory_flag | nofollow)
        handles.append(parent)
        path_prefixes.append((base, _file_snapshot(root_stat)))
        if _file_snapshot(os.fstat(parent)) != _file_snapshot(root_stat):
            raise CaptureBlocked("source directory changed during open")
        current = base
        for part in parts[:-1]:
            current = current / part
            before = current.lstat()
            if not _normal_dir(before) or stat.S_ISLNK(before.st_mode):
                raise CaptureBlocked("transcript directory is not physical")
            fd = os.open(part, os.O_RDONLY | directory_flag | nofollow, dir_fd=parent)
            handles.append(fd)
            parent = fd
            if _file_snapshot(os.fstat(fd)) != _file_snapshot(before):
                raise CaptureBlocked("transcript directory changed during open")
            path_prefixes.append((current, _file_snapshot(before)))

        pre = path.lstat()
        if not _normal_file(pre) or stat.S_ISLNK(pre.st_mode):
            raise CaptureBlocked("transcript is not a physical regular file")
        fd = os.open(parts[-1], os.O_RDONLY | nofollow, dir_fd=parent)
        handles.append(fd)
        initial = os.fstat(fd)
        if not _normal_file(initial) or _file_snapshot(initial) != _file_snapshot(pre):
            raise CaptureBlocked("transcript changed during open")
        if visit is None:
            if initial.st_size > MAX_SOURCE_BYTES:
                raise CaptureBlocked("transcript exceeds fixture read budget")
            data_parts = []
            remaining = MAX_SOURCE_BYTES + 1
            while remaining > 0:
                block = os.read(fd, min(65536, remaining))
                if not block:
                    break
                data_parts.append(block)
                remaining -= len(block)
            data = b"".join(data_parts)
            count = len(data)
            if count > MAX_SOURCE_BYTES:
                raise CaptureBlocked("transcript exceeds fixture read budget")
        else:
            # The prospective reader consumes bounded individual records and
            # discards hidden source rows. The same open descriptors and final
            # identity checks still protect the entire native source snapshot.
            with os.fdopen(os.dup(fd), "rb") as stream:
                data = visit(stream, initial.st_size)
            count = os.lseek(fd, 0, os.SEEK_CUR)
        after = os.fstat(fd)
        if count != initial.st_size or _file_snapshot(after) != _file_snapshot(initial):
            raise CaptureBlocked("transcript changed during read")
        post = path.lstat()
        if _file_snapshot(post) != _file_snapshot(initial) or not _normal_file(post):
            raise CaptureBlocked("transcript path changed during read")
        for folder_path, expected in path_prefixes:
            observed = folder_path.lstat()
            if not _normal_dir(observed) or _file_snapshot(observed) != expected:
                raise CaptureBlocked("transcript directory identity changed during read")
        return data
    except (FileNotFoundError, PermissionError, OSError, ValueError) as exc:
        if isinstance(exc, CaptureBlocked):
            raise
        raise CaptureBlocked("transcript unavailable or changed during open") from None
    finally:
        for fd in reversed(handles):
            os.close(fd)


def _host_authorized_scope(bridge, event: dict, session: str) -> str:
    """Use the existing OS-bound session and owner resolver, not caller claims."""
    if bridge.harness != "claude":
        raise CaptureBlocked("not a Claude Code session")
    if not isinstance(event.get("cwd"), str):
        raise CaptureBlocked("missing host cwd")
    cwd = Path(event["cwd"])
    if not cwd.is_absolute() or ".." in cwd.parts or "\x00" in event["cwd"]:
        raise CaptureBlocked("host cwd must be absolute and unambiguous")
    # The physical cwd binding must agree with active OS state. Never use a
    # workspace mentioned in a prompt as permission to archive a mixed chat.
    try:
        cwd.relative_to(bridge.root)
    except ValueError:
        raise CaptureBlocked("host cwd escapes selected OS") from None
    # Reject symlink parents as well as a symlink leaf. A lexical cwd inside
    # OS is not enough when an intermediate workspace path can be redirected.
    cursor = cwd
    while True:
        try:
            info = cursor.lstat()
        except OSError:
            raise CaptureBlocked("host cwd unavailable") from None
        if not _normal_dir(info) or stat.S_ISLNK(info.st_mode):
            raise CaptureBlocked("host cwd contains nonphysical directory")
        if cursor == bridge.root:
            break
        if cursor == cursor.parent:
            raise CaptureBlocked("host cwd escapes selected OS")
        cursor = cursor.parent
    try:
        physical_scope = bridge.scope(str(cwd), "")
        state = bridge.state(session)
        if state.get("session_id") != session or state.get("scope") != physical_scope:
            raise CaptureBlocked("OS session scope is not bound to physical cwd")
        turn = state.get("turn") or {}
        if turn and turn.get("scope") != physical_scope:
            raise CaptureBlocked("mixed or stale workspace binding")
        if turn:
            # No whole-transcript proof for chats with more than one project.
            # Restrict capture to a single physically bound destination.
            if turn.get("allowed") != [physical_scope] or turn.get("ambiguous"):
                raise CaptureBlocked("multi-scope or unresolved conversation")
        if turn and turn.get("state") in {"interrupted", "scope_unresolved"}:
            raise CaptureBlocked("cancelled or unbound turn")
        if turn and bridge.cancelled(session, turn.get("id")):
            raise CaptureBlocked("session turn was cancelled")
        if physical_scope.startswith("workspace:"):
            manifest = bridge.manifest(physical_scope.split(":", 1)[1])
            if manifest.get("status") != "active":
                raise CaptureBlocked("workspace is not active")
        context = bridge.owner("archive_authorize", {"scope": physical_scope,
                                                      "session_id": session})
        if (not isinstance(context, dict) or context.get("scope") != physical_scope
                or context.get("decision") != "allow"):
            raise CaptureBlocked("OS permission authority refused archive write")
        return physical_scope
    except CaptureBlocked:
        raise
    except Exception:
        raise CaptureBlocked("OS scope authorization unavailable") from None


def _require_at_time_scope_provenance(
    bridge, event: dict, session: str, scope: str, raw: bytes
) -> None:
    """Fail closed unless *every* historical completed record was scoped when seen.

    The callback's present cwd, present turn, and each transcript row's claimed
    cwd are NOT historical authorization. Only a separately OS-issued,
    per-record at-time provenance ledger can permit replay. This draft has no
    live ledger issuer: legacy/resumed history lacking such proof is refused,
    never retrospectively endorsed from today's scope.
    """
    if not _HISTORY_PROVENANCE_ISSUER_ADMITTED:
        raise CaptureBlocked("OS at-record historical provenance issuer is unverified")
    evidence = bridge.state(session).get("capture_scope_provenance")
    if not isinstance(evidence, dict) or set(evidence) != {
        "schema_version", "issuer", "session_id", "transcript_path", "records"
    }:
        raise CaptureBlocked("historical source scope provenance unavailable")
    if (type(evidence["schema_version"]) is not int
            or evidence["schema_version"] != 1
            or evidence["issuer"] != "os-authorized-at-record"
            or evidence["session_id"] != session
            or evidence["transcript_path"] != event.get("transcript_path")
            or not isinstance(evidence["records"], list)):
        raise CaptureBlocked("historical source scope provenance does not match")
    bound_records = evidence["records"]
    if len(bound_records) > MAX_RECORDS:
        raise CaptureBlocked("historical provenance exceeds record budget")

    cursor = 0
    checked = 0
    while cursor < len(raw):
        newline = raw.find(b"\n", cursor)
        if newline < 0:
            # An incomplete last record is provisional, not archivable.
            break
        complete = raw[cursor:newline + 1]
        if not complete.strip():
            raise CaptureBlocked("historical record has no scoped provenance")
        if checked >= len(bound_records):
            raise CaptureBlocked("historical source scope provenance missing")
        proof = bound_records[checked]
        digest = hashlib.sha256(complete).hexdigest()
        expected = {
            "offset": cursor, "end": newline + 1,
            "sha256": digest, "scope": scope,
        }
        if (not isinstance(proof, dict) or set(proof) != set(expected)
                or type(proof.get("offset")) is not int
                or type(proof.get("end")) is not int
                or proof != expected):
            raise CaptureBlocked("historical record lacks same-scope provenance")
        # Source identity is verified across *all* completed rows, including
        # tool and sidechain rows that the visible-text parser later excludes.
        try:
            record = json.loads(
                complete.decode("utf-8"),
                object_pairs_hook=lambda pairs: _reject_duplicate_pairs(pairs),
            )
        except (ValueError, UnicodeError):
            raise CaptureBlocked("historical source record invalid") from None
        if not isinstance(record, dict) or record.get("sessionId") != session:
            raise CaptureBlocked("historical record session identity mismatch")
        checked += 1
        cursor = newline + 1
    if checked != len(bound_records):
        raise CaptureBlocked("historical provenance does not match source length")


def _reject_duplicate_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise CaptureBlocked("historical record has duplicate fields")
        value[key] = item
    return value


def capture_hook(bridge, event: dict) -> dict:
    """Catch up one supplied Claude session, never search unrelated history.

    The writer derives a verified incremental checkpoint from committed OS
    JSONL rows on every callback. One batch compares the source prefix once
    and commits only new rows with a durable fsync. No external cursor can
    jump over an unverified or unfinished source record.
    """
    if not bridge.config.get("capture_enabled", False):
        return {"status": "disabled"}
    if not _HOST_COVERAGE_ADMITTED or bridge.config.get("capture_coverage_verified") is not True:
        return {"status": "blocked", "reason": "live host coverage unverified"}
    if event.get("capture_opt_out") is True:
        return {"status": "blocked", "reason": "private-session opt out"}
    session = event.get("session_id")
    if (not isinstance(session, str) or not session
            or len(session) > 128 or any(ch in session for ch in "/\\\x00")):
        return {"status": "blocked", "reason": "invalid session"}

    try:
        scope = _host_authorized_scope(bridge, event, session)
        raw = _supplied_source(event.get("transcript_path"), session)
        # Authorize the entire history before constructing or writing an OS
        # archive. A resumed transcript cannot be laundered into today's cwd.
        _require_at_time_scope_provenance(bridge, event, session, scope, raw)
        parser = _module("claude_transcript.py", "_claude_fixture_parser_1c")
        archive_mod = _module("chat_archive.py", "_portable_archive_1c")
        parsed = parser.parse_claude_jsonl(raw, source_id="claude:" + session)
        if len(parsed.text_blocks) > MAX_RECORDS:
            raise CaptureBlocked("source record budget exceeded")
        # An exact archive cannot redact a credential and remain verbatim.
        # Until the explicit rollout policy is decided, reject the entire
        # snapshot when an existing OS credential heuristic identifies a secret.
        from bridge import SECRET
        if any(SECRET.search(block.text) for block in parsed.text_blocks):
            raise CaptureBlocked("secret-like visible text requires operator decision")
        archive_id = hashlib.sha256(("claude-code\0" + scope + "\0" + session).encode()).hexdigest()[:40]

        def os_auth(requested: str) -> bool:
            return requested == scope and _host_authorized_scope(bridge, event, session) == scope

        archive = archive_mod.ChatArchive(
            bridge.root, scope=scope, authorized_scope=scope,
            archive_id=archive_id, chat_id=archive_id,
            origin="claude-code", session_id=session,
            authorization_check=os_auth,
        )
        # Each callback is a single verified, prefix-aware commit, not a
        # replay through one full archive scan and fsync per text block.
        # The archive itself is the durable checkpoint. A shortened or edited
        # earlier source row fails before writing any new rows.
        complete = [
            (block, raw.find(b"\n", block.byte_offset))
            for block in parsed.text_blocks
        ]
        complete = [(block, newline) for block, newline in complete if newline >= 0]
        events = []
        for block, newline in complete:
            record = raw[block.byte_offset:newline + 1]
            if block.session_id != session:
                raise CaptureBlocked("record belongs to a different/unknown session")
            source_event_id = hashlib.sha256(
                (session + "\0" + str(block.byte_offset) + "\0"
                 + str(block.block_index)).encode()
            ).hexdigest()
            events.append(archive_mod.ArchiveEvent(
                source_event_id=source_event_id,
                source_byte_offset=block.byte_offset,
                source_end_offset=newline + 1,
                source_record_sha256=hashlib.sha256(record).hexdigest(),
                source_record_bytes=record, block_index=block.block_index,
                message_id=source_event_id,
                sequence=len(events) + 1,
                role=block.role, text=block.text, record_terminated=True,
                attachment_availability="not_embedded",
            ))
        receipt = archive.append_batch(tuple(events))
        pending = bool(parsed.trailing_partial or parsed.complete_unterminated_record)
        return {
            "status": "pending" if pending else "saved",
            "saved": receipt.saved,
            "replayed": receipt.replayed,
            "archive_id": archive_id,
        }
    except Exception:
        # No raw source, path, prompts, or credentials in caller-visible errors.
        return {"status": "blocked", "reason": "identity, coverage, or authorization validation failed"}
