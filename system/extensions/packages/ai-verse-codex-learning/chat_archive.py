"""OS-owned, portable private chat archive: slice 1B, no host integration.

Source input is an explicitly authorized, complete, normalized event. The
slice 1A Claude parser is fixture-only and is never called by this module.
No discovery of provider paths, hooks, personal installations, or Memory writes.

The archive is canonical user-owned data inside the selected OS folder, NOT
disposable runtime state. Its JSONL and lockfiles stay private and gitignored.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
import re
import stat
from typing import Callable, Optional, Tuple

SCHEMA = "ai-verse.chat-archive/v1"
STORE_PARTS = ("archives", "private-chat-history", "v1")
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
SCOPE = re.compile(r"^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$")
SHA = re.compile(r"^[0-9a-f]{64}$")
ATTACHMENTS = {"none", "not_embedded", "unknown"}
OPTIONAL = ("timestamp", "revision", "branch")
# Shared OS writer / Memory v1 reader capacity contract. Every writer entry
# point enforces these bounds so it never creates a valid archive that Memory
# refuses solely because of an incompatible file-size or message-count limit.
MAX_ARCHIVE_BYTES = 64_000_000
MAX_ARCHIVE_MESSAGES = 40_000


class ArchiveBlocked(ValueError):
    status = "blocked"


class ArchiveConflict(ArchiveBlocked):
    """The immutable source event identity was reused with different bytes."""


@dataclass(frozen=True)
class ArchiveEvent:
    source_event_id: str
    source_byte_offset: int           # Absolute byte offset, never relative to a resumed chunk.
    source_end_offset: int            # Exclusive end AFTER a completed source JSONL newline.
    source_record_sha256: str         # SHA-256 of raw source record INCLUDING newline.
    source_record_bytes: bytes = field(repr=False)  # Transient verification only; never persisted.
    block_index: int
    message_id: str
    sequence: int                     # Monotone per-chat sequence, starting at 1.
    role: str
    text: str
    record_terminated: bool           # False means provisional: must not write.
    attachment_availability: str = "unknown"
    timestamp: Optional[str] = None
    revision: Optional[str] = None
    branch: Optional[str] = None


@dataclass(frozen=True)
class AppendReceipt:
    status: str                       # saved | replayed | pending
    archive_id: str
    source_event_id: str
    recovered_torn_tail: bool = False


@dataclass(frozen=True)
class ReadResult:
    status: str                       # saved | partial | missing
    archive_id: str
    messages: Tuple[dict, ...]
    torn_tail_bytes: int = 0


MAX_BATCH_EVENTS = 25_000


@dataclass(frozen=True)
class BatchReceipt:
    """A durable checkpoint derived only from verified canonical archive rows.

    The receipt is informational. On restart the archive, never this receipt,
    determines the committed prefix and replay decision.
    """
    status: str
    archive_id: str
    saved: int
    replayed: int
    checkpoint_sequence: int
    checkpoint_source_end_offset: int
    checkpoint_source_record_sha256: str
    recovered_torn_tail: bool = False


def _batch_payload(event: ArchiveEvent) -> dict:
    """Build the SAME v1 wire record as append(), with complete raw-source proof."""
    if not isinstance(event, ArchiveEvent):
        raise ArchiveBlocked("expected a normalized ArchiveEvent")
    _assert_id(event.source_event_id, "source event ID")
    _assert_id(event.message_id, "message ID")
    for value in (event.source_byte_offset, event.source_end_offset,
                  event.block_index, event.sequence):
        if type(value) is not int or value < 0:
            raise ArchiveBlocked("invalid source coordinate")
    if event.sequence < 1 or event.source_end_offset <= event.source_byte_offset:
        raise ArchiveBlocked("invalid source completion or sequence")
    if event.record_terminated is not True or type(event.source_record_bytes) is not bytes:
        raise ArchiveBlocked("batch contains incomplete source evidence")
    if not event.source_record_bytes.endswith(b"\n"):
        raise ArchiveBlocked("batch contains unterminated source record")
    if len(event.source_record_bytes) != event.source_end_offset - event.source_byte_offset:
        raise ArchiveBlocked("source byte span does not match evidence")
    if (not isinstance(event.source_record_sha256, str)
            or not SHA.fullmatch(event.source_record_sha256)
            or event.source_record_sha256 != _sha256(event.source_record_bytes)):
        raise ArchiveBlocked("source record digest does not match bytes")
    if not isinstance(event.role, str) or event.role not in ("user", "assistant"):
        raise ArchiveBlocked("only visible user/assistant text can be archived")
    if not isinstance(event.text, str):
        raise ArchiveBlocked("source text must be verbatim string")
    if (not isinstance(event.attachment_availability, str)
            or event.attachment_availability not in ATTACHMENTS):
        raise ArchiveBlocked("invalid attachment availability")
    for key in OPTIONAL:
        value = getattr(event, key)
        if value is not None and (not isinstance(value, str) or len(value) > 256):
            raise ArchiveBlocked("invalid metadata")
    payload = {
        "kind": "message", "schema": SCHEMA,
        "archive_id": None, "scope": None, "origin": None, "session_id": None,
        "source_event_id": event.source_event_id,
        "source_byte_offset": event.source_byte_offset,
        "source_end_offset": event.source_end_offset,
        "source_record_sha256": event.source_record_sha256,
        "block_index": event.block_index, "message_id": event.message_id,
        "sequence": event.sequence, "role": event.role, "text": event.text,
        "attachment_availability": event.attachment_availability,
        "text_sha256": _sha256(event.text.encode("utf-8")),
        "timestamp": event.timestamp, "revision": event.revision,
        "branch": event.branch,
    }
    return payload


def _assert_id(value: str, name: str) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ArchiveBlocked(f"invalid {name}")
    return value


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _json_bytes(value: dict) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      allow_nan=False, separators=(",", ":")).encode("utf-8")


def _strict_json(data: bytes) -> dict:
    def no_duplicate_pairs(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ArchiveBlocked("duplicate JSON object member")
            out[key] = value
        return out

    def nonfinite(_):
        raise ArchiveBlocked("nonfinite JSON value")

    try:
        parsed = json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicate_pairs,
                            parse_constant=nonfinite)
    except (ValueError, UnicodeError) as exc:
        raise ArchiveBlocked("archive contains malformed complete JSONL") from None
    if not isinstance(parsed, dict):
        raise ArchiveBlocked("archive record must be an object")
    return parsed


def _no_symlink(path: Path, *, kind: str) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise ArchiveBlocked(f"{kind} is absent") from None
    if stat.S_ISLNK(info.st_mode):
        raise ArchiveBlocked(f"symlink {kind} refused")
    if kind == "directory" and not stat.S_ISDIR(info.st_mode):
        raise ArchiveBlocked("archive path is not a directory")
    if kind == "file" and not stat.S_ISREG(info.st_mode):
        raise ArchiveBlocked("archive path is not a regular file")


def _check_path_ancestors(path: Path) -> None:
    """Refuse symlink components from the filesystem root to the selected OS."""
    cursor = path.absolute()
    while True:
        _no_symlink(cursor, kind="directory")
        if cursor == cursor.parent:
            break
        cursor = cursor.parent


def _private_dir(root: Path, parts: Tuple[str, ...], *, create: bool) -> Optional[Path]:
    current = root
    for index, part in enumerate(parts):
        current = current / part
        if not current.exists() and not current.is_symlink():
            if not create:
                return None
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
        _no_symlink(current, kind="directory")
        # Only directories below the public OS archives/ directory are private.
        if index >= 1:
            if stat.S_IMODE(current.stat().st_mode) & 0o077:
                raise ArchiveBlocked("private archive directory exposes group/other permissions")
    return current


def _regular_open(path: Path, flags: int, *, create: bool = False) -> int:
    if path.is_symlink():
        raise ArchiveBlocked("symlink archive file refused")
    options = flags | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    if create:
        options |= os.O_CREAT
    try:
        fd = os.open(path, options, 0o600)
    except OSError as exc:
        raise ArchiveBlocked("cannot open private archive file") from exc
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        os.close(fd)
        raise ArchiveBlocked("archive file is not private and regular")
    return fd


@contextlib.contextmanager
def _writer_lock(path: Path):
    fd = _regular_open(path, os.O_RDWR, create=True)
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            raise OSError("short archive write")
        view = view[count:]


def _validate_record(record: dict) -> None:
    if record.get("kind") != "message" or record.get("schema") != SCHEMA:
        raise ArchiveBlocked("unexpected message schema")
    _assert_id(record.get("source_event_id"), "source event ID")
    _assert_id(record.get("message_id"), "message ID")
    for key in ("source_byte_offset", "source_end_offset", "block_index", "sequence"):
        value = record.get(key)
        if type(value) is not int or value < (1 if key == "sequence" else 0):
            raise ArchiveBlocked("invalid archived source position or sequence")
    if record["source_end_offset"] <= record["source_byte_offset"]:
        raise ArchiveBlocked("invalid source record end offset")
    if record.get("role") not in ("user", "assistant") or not isinstance(record.get("text"), str):
        raise ArchiveBlocked("invalid visible message")
    if record.get("attachment_availability") not in ATTACHMENTS:
        raise ArchiveBlocked("invalid attachment status")
    for key in OPTIONAL:
        value = record.get(key)
        if value is not None and (not isinstance(value, str) or len(value) > 256):
            raise ArchiveBlocked("invalid optional metadata")
    if not isinstance(record.get("source_record_sha256"), str) or not SHA.fullmatch(record["source_record_sha256"]):
        raise ArchiveBlocked("invalid source-record integrity")
    if record.get("text_sha256") != _sha256(record["text"].encode("utf-8")):
        raise ArchiveBlocked("archived text integrity mismatch")
    integrity = record.get("archive_record_sha256")
    without_integrity = {k: v for k, v in record.items() if k != "archive_record_sha256"}
    if integrity != _sha256(_json_bytes(without_integrity)):
        raise ArchiveBlocked("archive record integrity mismatch")
    allowed = {
        "kind", "schema", "archive_id", "scope", "origin", "session_id",
        "source_event_id", "source_byte_offset", "source_end_offset",
        "source_record_sha256", "block_index", "message_id", "sequence",
        "role", "text", "attachment_availability", "text_sha256",
        "archive_record_sha256", *OPTIONAL,
    }
    if set(record) != allowed:
        raise ArchiveBlocked("invalid archive record fields")


def _scan(data: bytes, expected: dict) -> tuple:
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ArchiveBlocked("archive exceeds shared v1 size budget")
    boundary = data.rfind(b"\n") + 1
    tail_size = len(data) - boundary
    completed = data[:boundary]
    if not completed:
        return (), tail_size, boundary, False
    lines = completed.split(b"\n")[:-1]
    if len(lines) - 1 > MAX_ARCHIVE_MESSAGES:
        raise ArchiveBlocked("archive exceeds shared v1 message budget")
    if any(not line for line in lines):
        raise ArchiveBlocked("empty archive record")
    header = _strict_json(lines[0])
    if header != expected:
        raise ArchiveBlocked("archive scope or identity does not match")
    by_event = {}
    by_offset = {}
    by_block = set()
    messages = []
    for line in lines[1:]:
        record = _strict_json(line)
        _validate_record(record)
        for key in ("archive_id", "scope", "origin", "session_id"):
            if record[key] != expected[key]:
                raise ArchiveBlocked("archive binding mismatch")
        if record["sequence"] != len(messages) + 1:
            raise ArchiveBlocked("archive sequence is not continuous")
        event_id = record["source_event_id"]
        if event_id in by_event:
            raise ArchiveBlocked("duplicate immutable source event ID in archive")
        by_event[event_id] = record
        origin_position = record["source_byte_offset"]
        block_position = (origin_position, record["block_index"])
        if block_position in by_block:
            raise ArchiveBlocked("duplicate block at the same source byte position")
        by_block.add(block_position)
        fingerprint = record["source_record_sha256"]
        if origin_position in by_offset and by_offset[origin_position] != fingerprint:
            raise ArchiveBlocked("conflicting source record bytes at the same offset")
        by_offset[origin_position] = fingerprint
        messages.append(record)
    return tuple(messages), tail_size, boundary, True


class ChatArchive:
    """One authorized chat, scoped to one OS folder, without any provider IO."""

    def __init__(self, os_root: Path, *, scope: str, authorized_scope: str,
                 archive_id: str, chat_id: str, origin: str, session_id: str,
                 authorization_check: Callable[[str], bool]):
        self.root = Path(os_root).absolute()
        if not SCOPE.fullmatch(scope) or scope != authorized_scope:
            raise ArchiveBlocked("caller is not bound to the requested scope")
        if not callable(authorization_check):
            raise ArchiveBlocked("live scope authorization checker is required")
        self.authorization_check = authorization_check
        self.scope = scope
        self.archive_id = _assert_id(archive_id, "archive ID")
        self.origin = _assert_id(origin, "origin")
        self.session_id = _assert_id(session_id, "provider session ID")
        self.chat_id = _assert_id(chat_id, "chat ID")
        suffix = ("operator",) if scope == "operator" else ("workspaces", scope.partition(":")[2])
        self.parts = STORE_PARTS + suffix
        self.header = {
            "kind": "header", "schema": SCHEMA, "archive_id": archive_id,
            "chat_id": chat_id, "origin": origin, "session_id": session_id,
            "scope": scope,
        }
        # Refuse invalid initial bindings as well as later revocations.
        self._check_authorization()

    def _check_authorization(self) -> None:
        # The caller supplies an OS-authoritative live checker, not a static
        # constructor approval. No provider or private OS state is discovered.
        # The host must bind this checker to its authenticated session.
        _check_path_ancestors(self.root)
        _no_symlink(self.root / "AI-VERSE.yaml", kind="file")
        try:
            authorized = self.authorization_check(self.scope) is True
        except Exception:
            authorized = False
        if not authorized:
            raise ArchiveBlocked("current scope authorization denied")
        if self.scope.startswith("workspace:"):
            ws = self.scope.partition(":")[2]
            workspace_root = self.root / "workspaces"
            _no_symlink(workspace_root, kind="directory")
            workspace_dir = workspace_root / ws
            _no_symlink(workspace_dir, kind="directory")
            manifest = workspace_dir / "WORKSPACE.yaml"
            _no_symlink(manifest, kind="file")
            ids = []
            try:
                for line in manifest.read_text(encoding="utf-8").splitlines():
                    match = re.fullmatch(
                        r"id:\s*['\"]?([a-z0-9][a-z0-9-]{0,127})['\"]?\s*(?:#.*)?", line
                    )
                    if match:
                        ids.append(match.group(1))
            except (OSError, UnicodeError):
                raise ArchiveBlocked("workspace manifest is unreadable") from None
            if ids != [ws]:
                raise ArchiveBlocked("current workspace manifest ID does not match scope")

    def _path(self, *, create: bool) -> Optional[Path]:
        folder = _private_dir(self.root, self.parts, create=create)
        return None if folder is None else folder / (self.archive_id + ".jsonl")

    def read(self) -> ReadResult:
        self._check_authorization()
        path = self._path(create=False)
        if path is None or (not path.exists() and not path.is_symlink()):
            return ReadResult("missing", self.archive_id, ())
        fd = _regular_open(path, os.O_RDONLY)
        try:
            with os.fdopen(fd, "rb") as stream:
                messages, torn, _, has_header = _scan(
                    stream.read(MAX_ARCHIVE_BYTES + 1), self.header
                )
        except OSError as exc:
            raise ArchiveBlocked("cannot read archive") from exc
        # Recheck after reading and before returning any private content.
        # This closes the ordinary revoke-during-read window.
        self._check_authorization()
        if not has_header:
            # A zero-byte file can be left behind by a failed initial write.
            return ReadResult("partial", self.archive_id, (), torn)
        return ReadResult("partial" if torn else "saved", self.archive_id, messages, torn)

    def append_batch(self, events) -> BatchReceipt:
        """Verify the complete source prefix once, then durably append its suffix.

        A fresh invocation (including a restart) derives its checkpoint from
        the canonical JSONL itself, not a client cursor or sidecar. All rows
        are checked before any new rows are written. This turns catch-up from
        repeated quadratic full-file scans into one linear scan and fsync per
        callback. The archive remains byte-compatible v1 JSONL.
        """
        self._check_authorization()
        if not isinstance(events, (tuple, list)) or len(events) > MAX_BATCH_EVENTS:
            raise ArchiveBlocked("invalid or oversized batch")
        payloads = []
        event_ids = set()
        seen_blocks = set()
        by_offset = {}
        previous_offset = -1
        for sequence, event in enumerate(events, 1):
            payload = _batch_payload(event)
            payload.update({
                "archive_id": self.archive_id, "scope": self.scope,
                "origin": self.origin, "session_id": self.session_id,
            })
            payload["archive_record_sha256"] = _sha256(_json_bytes(payload))
            _validate_record(payload)
            if payload["sequence"] != sequence:
                raise ArchiveBlocked("batch source sequence is not continuous from one")
            event_id = payload["source_event_id"]
            if event_id in event_ids:
                raise ArchiveConflict("batch duplicates immutable source event ID")
            event_ids.add(event_id)
            offset = payload["source_byte_offset"]
            block = (offset, payload["block_index"])
            if block in seen_blocks:
                raise ArchiveConflict("batch reuses source record block")
            seen_blocks.add(block)
            fingerprint = payload["source_record_sha256"]
            if offset in by_offset and by_offset[offset] != fingerprint:
                raise ArchiveConflict("batch changes source record at same position")
            by_offset[offset] = fingerprint
            if offset < previous_offset:
                raise ArchiveBlocked("batch source offsets move backwards")
            previous_offset = offset
            payloads.append(payload)

        if not payloads:
            # A zero-message catch-up must not create an empty archive.
            # If the archive exists, however, it must not silently lose history.
            path = self._path(create=False)
            if path is None or (not path.exists() and not path.is_symlink()):
                return BatchReceipt("saved", self.archive_id, 0, 0, 0, 0, "")
        path = self._path(create=True)
        with _writer_lock(path.with_suffix(".lock")):
            self._check_authorization()
            if path.exists() or path.is_symlink():
                fd = _regular_open(path, os.O_RDWR)
                try:
                    with os.fdopen(fd, "rb", closefd=False) as stream:
                        messages, torn, boundary, has_header = _scan(
                            stream.read(MAX_ARCHIVE_BYTES + 1), self.header
                        )
                except BaseException:
                    os.close(fd)
                    raise
            else:
                fd = _regular_open(path, os.O_RDWR, create=True)
                messages, torn, boundary, has_header = (), 0, 0, False
            try:
                # This is a *verified* prefix checkpoint. Compare complete
                # rows, not just the last offset, because any earlier source
                # mutation must fail even when the tail looks unchanged.
                if len(messages) > len(payloads):
                    raise ArchiveBlocked("source replay omits committed history")
                for index, committed in enumerate(messages):
                    if committed != payloads[index]:
                        raise ArchiveConflict("source replay changed committed history")
                count = len(messages)
                new_records = payloads[count:]
                if len(payloads) > MAX_ARCHIVE_MESSAGES:
                    raise ArchiveBlocked("archive would exceed shared v1 message budget")
                recovered = False
                if new_records:
                    # A validation conflict anywhere in the new suffix was
                    # refused above, before the first write or tail recovery.
                    self._check_authorization()
                    if torn:
                        os.ftruncate(fd, boundary)
                        os.fsync(fd)
                        recovered = True
                    os.lseek(fd, 0, os.SEEK_END)
                    wire = (b"" if has_header else _json_bytes(self.header) + b"\n")
                    wire += b"".join(_json_bytes(p) + b"\n" for p in new_records)
                    if (boundary if torn else os.fstat(fd).st_size) + len(wire) > MAX_ARCHIVE_BYTES:
                        raise ArchiveBlocked("archive would exceed shared v1 size budget")
                    _write_all(fd, wire)
                    os.fsync(fd)
                self._check_authorization()
            except OSError as exc:
                raise ArchiveBlocked("archive batch write or checkpoint failed") from exc
            finally:
                os.close(fd)
        final = payloads[-1] if payloads else None
        return BatchReceipt(
            "saved", self.archive_id, len(payloads) - count, count,
            len(payloads),
            final["source_end_offset"] if final else 0,
            final["source_record_sha256"] if final else "",
            recovered_torn_tail=recovered,
        )

    def append(self, event: ArchiveEvent) -> AppendReceipt:
        self._check_authorization()
        if not isinstance(event, ArchiveEvent):
            raise ArchiveBlocked("expected a normalized ArchiveEvent")
        _assert_id(event.source_event_id, "source event ID")
        _assert_id(event.message_id, "message ID")
        for value in (event.source_byte_offset, event.source_end_offset, event.block_index, event.sequence):
            if type(value) is not int or value < 0:
                raise ArchiveBlocked("invalid source coordinate")
        if event.sequence < 1 or event.source_end_offset <= event.source_byte_offset:
            raise ArchiveBlocked("invalid source completion or sequence")
        if not isinstance(event.record_terminated, bool):
            raise ArchiveBlocked("source termination must be explicit")
        if not isinstance(event.source_record_bytes, bytes):
            raise ArchiveBlocked("source record evidence must be bytes")
        # A provisional JSON value may be parseable without a newline. It is
        # still uncommitted and cannot advance the source checkpoint.
        if not event.record_terminated or not event.source_record_bytes.endswith(b"\n"):
            return AppendReceipt("pending", self.archive_id, event.source_event_id)
        if len(event.source_record_bytes) != event.source_end_offset - event.source_byte_offset:
            raise ArchiveBlocked("source end offset does not match UTF-8 byte evidence")
        if (not isinstance(event.source_record_sha256, str)
                or not SHA.fullmatch(event.source_record_sha256)
                or event.source_record_sha256 != _sha256(event.source_record_bytes)):
            raise ArchiveBlocked("source record SHA-256 does not match bytes")
        if event.role not in ("user", "assistant") or not isinstance(event.text, str):
            raise ArchiveBlocked("only visible user/assistant text can be archived")
        if event.attachment_availability not in ATTACHMENTS:
            raise ArchiveBlocked("invalid attachment availability")
        for key in OPTIONAL:
            value = getattr(event, key)
            if value is not None and (not isinstance(value, str) or len(value) > 256):
                raise ArchiveBlocked("invalid metadata")
        payload = {
            "kind": "message", "schema": SCHEMA,
            "archive_id": self.archive_id, "scope": self.scope,
            "origin": self.origin, "session_id": self.session_id,
            "source_event_id": event.source_event_id,
            "source_byte_offset": event.source_byte_offset,
            "source_end_offset": event.source_end_offset,
            "source_record_sha256": event.source_record_sha256,
            "block_index": event.block_index,
            "message_id": event.message_id,
            "sequence": event.sequence, "role": event.role, "text": event.text,
            "attachment_availability": event.attachment_availability,
            "text_sha256": _sha256(event.text.encode("utf-8")),
            "timestamp": event.timestamp, "revision": event.revision, "branch": event.branch,
        }
        payload["archive_record_sha256"] = _sha256(_json_bytes(payload))
        path = self._path(create=True)
        with _writer_lock(path.with_suffix(".lock")):
            # A queued writer cannot use stale authorization after waiting
            # for another writer. Recheck before any bytes are changed.
            self._check_authorization()
            if path.exists() or path.is_symlink():
                fd = _regular_open(path, os.O_RDWR)
                try:
                    with os.fdopen(fd, "rb", closefd=False) as stream:
                        data = stream.read(MAX_ARCHIVE_BYTES + 1)
                finally:
                    # Keep fd open for recovery and append, including on Windows.
                    pass
                try:
                    messages, torn, boundary, has_header = _scan(data, self.header)
                    # An empty file has no committed header and is recoverable.
                except BaseException:
                    os.close(fd)
                    raise
            else:
                fd = _regular_open(path, os.O_RDWR, create=True)
                messages, torn, boundary, has_header = (), 0, 0, False

            try:
                by_event = {item["source_event_id"]: item for item in messages}
                prior = by_event.get(event.source_event_id)
                if prior is not None:
                    if prior == payload:
                        return AppendReceipt("replayed", self.archive_id, event.source_event_id)
                    raise ArchiveConflict("immutable source event changed on replay")
                if event.sequence != len(messages) + 1:
                    raise ArchiveBlocked("out-of-order or missing source sequence")
                if len(messages) + 1 > MAX_ARCHIVE_MESSAGES:
                    raise ArchiveBlocked("archive would exceed shared v1 message budget")
                same_origin = [
                    item for item in messages
                    if item["source_byte_offset"] == event.source_byte_offset
                ]
                if same_origin and any(
                    item["source_record_sha256"] != event.source_record_sha256
                    for item in same_origin
                ):
                    raise ArchiveConflict("source record changed at its original byte offset")
                if any(item["block_index"] == event.block_index for item in same_origin):
                    raise ArchiveConflict("distinct events cannot reuse the same source block")
                if messages and event.source_byte_offset < messages[-1]["source_byte_offset"]:
                    raise ArchiveBlocked("source offsets are out of order")
                header_wire = b"" if has_header else _json_bytes(self.header) + b"\n"
                message_wire = _json_bytes(payload) + b"\n"
                if ((boundary if torn else os.fstat(fd).st_size)
                        + len(header_wire) + len(message_wire) > MAX_ARCHIVE_BYTES):
                    raise ArchiveBlocked("archive would exceed shared v1 size budget")
                if torn:
                    os.ftruncate(fd, boundary)
                    os.fsync(fd)
                os.lseek(fd, 0, os.SEEK_END)
                if header_wire:
                    _write_all(fd, header_wire)
                _write_all(fd, message_wire)
                os.fsync(fd)
            except OSError as exc:
                raise ArchiveBlocked("archive write or durable checkpoint failed") from exc
            finally:
                os.close(fd)
        return AppendReceipt("saved", self.archive_id, event.source_event_id,
                             recovered_torn_tail=bool(torn))
