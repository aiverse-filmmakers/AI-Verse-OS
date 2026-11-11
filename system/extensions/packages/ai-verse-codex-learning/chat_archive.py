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
import tempfile
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

    def _check_authorization(self, *, write=False) -> None:
        _authorize_scope(self.root, self.scope, self.authorization_check)
        placement = placement_receipt(self.root, self.archive_id, self.scope)
        if placement and (placement["status"] != "committed" or placement["to"] != self.scope):
            raise ArchiveBlocked("archive placement changed or is moving")
        if placement and write:
            raise ArchiveBlocked("relocated archive is closed to capture")

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
                data = stream.read(MAX_ARCHIVE_BYTES + 1)
                messages, torn, _, has_header = _scan(data, self.header)
                placement = placement_receipt(self.root, self.archive_id, self.scope)
                if placement and _sha256(data) != placement["target_sha256"]:
                    raise ArchiveBlocked("relocated archive was changed")
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
        self._check_authorization(write=True)
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
            self._check_authorization(write=True)
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
                    self._check_authorization(write=True)
                    wire = (b"" if has_header else _json_bytes(self.header) + b"\n")
                    wire += b"".join(_json_bytes(p) + b"\n" for p in new_records)
                    # Budget failure must not truncate even a torn tail.
                    if (boundary if torn else os.fstat(fd).st_size) + len(wire) > MAX_ARCHIVE_BYTES:
                        raise ArchiveBlocked("archive would exceed shared v1 size budget")
                    if torn:
                        os.ftruncate(fd, boundary)
                        os.fsync(fd)
                        recovered = True
                    os.lseek(fd, 0, os.SEEK_END)
                    _write_all(fd, wire)
                    os.fsync(fd)
                self._check_authorization(write=True)
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
        self._check_authorization(write=True)
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
            self._check_authorization(write=True)
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

def _authorize_scope(root, scope, authorization_check):
    # The caller supplies an OS-authoritative live checker, not a static
    # constructor approval. No provider or private OS state is discovered.
    # The host must bind this checker to its authenticated session.
    _check_path_ancestors(root)
    _no_symlink(root / "AI-VERSE.yaml", kind="file")
    try:
        authorized = authorization_check(scope) is True
    except Exception:
        authorized = False
    if not authorized:
        raise ArchiveBlocked("current scope authorization denied")
    if scope.startswith("workspace:"):
        ws = scope.partition(":")[2]
        workspace_root = root / "workspaces"
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


def placement_key(scope, archive_id):
    _scope_parts(scope)
    _assert_id(archive_id, "archive ID")
    return _sha256((scope + "\0" + archive_id).encode("utf-8"))


PLACEMENT_SCHEMA = "ai-verse.chat-placement/v1"
MAX_PLACEMENT_BYTES = 64_000


def placement_receipt(root: Path, archive_id: str, scope: str):
    """Current OS-owned location; a moving receipt denies every disclosure."""
    _assert_id(archive_id, "archive ID")
    folder = _private_dir(root, STORE_PARTS + ("placements",), create=False)
    if folder is None:
        return None
    key = placement_key(scope, archive_id)
    routes = _private_dir(root, STORE_PARTS + ("placements", "routes"), create=False)
    route_path = routes / (key + ".json") if routes else None
    if route_path is not None and (route_path.exists() or route_path.is_symlink()):
        fd = _regular_open(route_path, os.O_RDONLY)
        with os.fdopen(fd, "rb") as stream:
            route = _strict_json(stream.read(4097))
        if (set(route) != {"schema", "scope", "archive_id", "placement_id"}
                or route["schema"] != "ai-verse.chat-route/v1" or route["scope"] != scope
                or route["archive_id"] != archive_id or not isinstance(route["placement_id"], str)
                or not SHA.fullmatch(route["placement_id"])):
            raise ArchiveBlocked("invalid placement route")
        key = route["placement_id"]
    path = folder / (key + ".json")
    if not path.exists() and not path.is_symlink():
        return None
    fd = _regular_open(path, os.O_RDONLY)
    with os.fdopen(fd, "rb") as stream:
        data = stream.read(MAX_PLACEMENT_BYTES + 1)
    if len(data) > MAX_PLACEMENT_BYTES:
        raise ArchiveBlocked("placement receipt exceeds budget")
    receipt = _strict_json(data)
    if (set(receipt) != {"schema", "archive_id", "status", "from", "to", "previous_scopes",
                         "source_sha256", "target_sha256", "fingerprint", "header", "home_scope", "placement_id"}
            or receipt["schema"] != PLACEMENT_SCHEMA or receipt["archive_id"] != archive_id
            or receipt["status"] not in {"moving", "committed"}
            or not isinstance(receipt["previous_scopes"], list)
            or any(not isinstance(v, str) or not SCOPE.fullmatch(v)
                   for v in [receipt["home_scope"], receipt["from"], receipt["to"], *receipt["previous_scopes"]])
            or any(not isinstance(receipt[k], str) or not SHA.fullmatch(receipt[k])
                   for k in ("source_sha256", "target_sha256", "fingerprint"))
            or not isinstance(receipt["header"], dict)
            or receipt["placement_id"] != key
            or key != placement_key(receipt["home_scope"], archive_id)
            or scope not in {receipt["home_scope"], receipt["from"], receipt["to"], *receipt["previous_scopes"]}):
        raise ArchiveBlocked("invalid placement receipt")
    return receipt


def _atomic_private(path, wire):
    # Rename within the same verified private directory, then durably commit it.
    fd, name = tempfile.mkstemp(prefix=".placement-", dir=path.parent)
    try:
        _write_all(fd, wire)
        os.fsync(fd)
        os.close(fd)
        fd = None
        if path.is_symlink():
            raise ArchiveBlocked("symlink placement target refused")
        os.replace(name, path)
        _sync_directory(path.parent)
    finally:
        if fd is not None:
            os.close(fd)
        if os.path.exists(name):
            os.unlink(name)


def _sync_directory(path):
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def _scope_parts(scope):
    if not isinstance(scope, str) or not SCOPE.fullmatch(scope):
        raise ArchiveBlocked("invalid archive scope")
    return ("operator",) if scope == "operator" else ("workspaces", scope.partition(":")[2])


def _move_path(root, scope, archive_id, *, create=False):
    folder = _private_dir(root, STORE_PARTS + _scope_parts(scope), create=create)
    return None if folder is None else folder / (archive_id + ".jsonl")


def _read_move_file(path):
    if path is None:
        raise ArchiveBlocked("archive is absent")
    fd = _regular_open(path, os.O_RDONLY)
    with os.fdopen(fd, "rb") as stream:
        data = stream.read(MAX_ARCHIVE_BYTES + 1)
    if not data or len(data) > MAX_ARCHIVE_BYTES or not data.endswith(b"\n"):
        raise ArchiveBlocked("only a complete bounded archive can move")
    return data


def _relocated(data, archive_id, source_scope, destination_scope):
    header = _strict_json(data.split(b"\n", 1)[0])
    if (set(header) != {"kind", "schema", "archive_id", "chat_id", "origin", "session_id", "scope"}
            or header.get("kind") != "header" or header.get("schema") != SCHEMA
            or header.get("archive_id") != archive_id or header.get("scope") != source_scope):
        raise ArchiveBlocked("move source identity mismatch")
    for name in ("archive_id", "chat_id", "origin", "session_id"):
        _assert_id(header[name], name)
    messages, torn, _, valid = _scan(data, header)
    if torn or not valid:
        raise ArchiveBlocked("incomplete move source")
    moved_header = {**header, "scope": destination_scope}
    moved = [_json_bytes(moved_header)]
    for message in messages:
        record = {**message, "scope": destination_scope}
        record.pop("archive_record_sha256")
        record["archive_record_sha256"] = _sha256(_json_bytes(record))
        moved.append(_json_bytes(record))
    wire = b"\n".join(moved) + b"\n"
    if len(wire) > MAX_ARCHIVE_BYTES:
        raise ArchiveBlocked("relocated archive exceeds shared size budget")
    return header, wire, len(messages)


def plan_move(root, archive_id, source_scope, destination_scope, authorization_check):
    """Read-only preview, content-free and bound to exact current source bytes."""
    root = Path(root).absolute()
    _assert_id(archive_id, "archive ID")
    if source_scope == destination_scope:
        raise ArchiveBlocked("archive already has this home")
    for scope in (source_scope, destination_scope):
        _scope_parts(scope)
        _authorize_scope(root, scope, authorization_check)
    receipt = placement_receipt(root, archive_id, source_scope)
    if receipt and (receipt["status"] != "committed" or receipt["to"] != source_scope):
        raise ArchiveBlocked("archive placement changed or is moving")
    source = _move_path(root, source_scope, archive_id)
    data = _read_move_file(source)
    if receipt and _sha256(data) != receipt["target_sha256"]:
        raise ArchiveBlocked("relocated archive was changed")
    header, wire, count = _relocated(data, archive_id, source_scope, destination_scope)
    destination = _move_path(root, destination_scope, archive_id)
    if destination is not None and (destination.exists() or destination.is_symlink()):
        raise ArchiveBlocked("destination archive already exists")
    plan = {"archive_id": archive_id, "from": source_scope, "to": destination_scope,
            "source_sha256": _sha256(data), "target_sha256": _sha256(wire), "messages": count}
    plan["fingerprint"] = _sha256(_json_bytes(plan))
    for scope in (source_scope, destination_scope):
        _authorize_scope(root, scope, authorization_check)
    return plan


def move_archive(root, archive_id, source_scope, destination_scope, *,
                 fingerprint, confirmed, authorization_check):
    """Confirmed OS move. Source provider files are never inspected or moved."""
    if confirmed is not True or not isinstance(fingerprint, str) or not SHA.fullmatch(fingerprint):
        raise ArchiveBlocked("explicit move preview confirmation required")
    root = Path(root).absolute()
    _assert_id(archive_id, "archive ID")
    for scope in (source_scope, destination_scope):
        _scope_parts(scope)
        _authorize_scope(root, scope, authorization_check)
    folder = _private_dir(root, STORE_PARTS + ("placements",), create=True)
    with _writer_lock(folder / "moves.lock"):
        source = _move_path(root, source_scope, archive_id)
        if source is None:
            raise ArchiveBlocked("archive is absent")
        with _writer_lock(source.with_suffix(".lock")):
            plan = plan_move(root, archive_id, source_scope, destination_scope, authorization_check)
            if plan["fingerprint"] != fingerprint:
                raise ArchiveBlocked("move preview is stale")
            data = _read_move_file(source)
            header, wire, _ = _relocated(data, archive_id, source_scope, destination_scope)
            if _sha256(data) != plan["source_sha256"] or _sha256(wire) != plan["target_sha256"]:
                raise ArchiveBlocked("move source changed")
            previous = placement_receipt(root, archive_id, source_scope)
            home_scope = previous["home_scope"] if previous else source_scope
            key = placement_key(home_scope, archive_id)
            destination_route = placement_receipt(root, archive_id, destination_scope)
            if destination_route and destination_route["placement_id"] != key:
                raise ArchiveBlocked("destination identity belongs to another chat")
            receipt = {k: plan[k] for k in ("archive_id", "from", "to", "source_sha256", "target_sha256", "fingerprint")}
            receipt.update(schema=PLACEMENT_SCHEMA, status="moving", header=header,
                           home_scope=home_scope, placement_id=key,
                           previous_scopes=list(dict.fromkeys([*(previous["previous_scopes"] if previous else []), source_scope])))
            if len(_json_bytes(receipt)) > MAX_PLACEMENT_BYTES:
                raise ArchiveBlocked("placement receipt exceeds budget")
            # First deny both homes. A crash after this point needs explicit recovery.
            _atomic_private(folder / (key + ".json"), _json_bytes(receipt) + b"\n")
            routes = _private_dir(root, STORE_PARTS + ("placements", "routes"), create=True)
            for selected in (source_scope, destination_scope):
                route = {"schema": "ai-verse.chat-route/v1", "scope": selected,
                         "archive_id": archive_id, "placement_id": key}
                _atomic_private(routes / (placement_key(selected, archive_id) + ".json"),
                                _json_bytes(route) + b"\n")
            return _finish_move(root, receipt, authorization_check)


def _finish_move(root, receipt, authorization_check):
    for scope in (receipt["from"], receipt["to"]):
        _authorize_scope(root, scope, authorization_check)
    routes = _private_dir(root, STORE_PARTS + ("placements", "routes"), create=True)
    for selected in (receipt["from"], receipt["to"]):
        old = placement_receipt(root, receipt["archive_id"], selected)
        if old and old["placement_id"] != receipt["placement_id"]:
            raise ArchiveBlocked("move recovery route conflict")
        route = {"schema": "ai-verse.chat-route/v1", "scope": selected,
                 "archive_id": receipt["archive_id"], "placement_id": receipt["placement_id"]}
        _atomic_private(routes / (placement_key(selected, receipt["archive_id"]) + ".json"),
                        _json_bytes(route) + b"\n")
    source = _move_path(root, receipt["from"], receipt["archive_id"])
    target = _move_path(root, receipt["to"], receipt["archive_id"], create=True)
    with _writer_lock(target.with_suffix(".lock")):
        if source is not None and (source.exists() or source.is_symlink()):
            data = _read_move_file(source)
            if _sha256(data) != receipt["source_sha256"]:
                raise ArchiveBlocked("move recovery source changed")
            header, wire, _ = _relocated(data, receipt["archive_id"], receipt["from"], receipt["to"])
            if header != receipt["header"] or _sha256(wire) != receipt["target_sha256"]:
                raise ArchiveBlocked("move recovery binding changed")
        elif target.exists() and not target.is_symlink():
            wire = _read_move_file(target)
            if _sha256(wire) != receipt["target_sha256"]:
                raise ArchiveBlocked("move recovery target changed")
        else:
            raise ArchiveBlocked("move recovery has no verified source")
        if target.exists() or target.is_symlink():
            if _read_move_file(target) != wire:
                raise ArchiveBlocked("move recovery target conflict")
        else:
            _atomic_private(target, wire)
        for scope in (receipt["from"], receipt["to"]):
            _authorize_scope(root, scope, authorization_check)
        if source is not None and source.exists():
            source.unlink()
            _sync_directory(source.parent)
        receipt = {**receipt, "status": "committed"}
        folder = _private_dir(root, STORE_PARTS + ("placements",), create=False)
        _atomic_private(folder / (receipt["placement_id"] + ".json"), _json_bytes(receipt) + b"\n")
        return {"status": "moved", "archive_id": receipt["archive_id"], "scope": receipt["to"]}


def recover_move(root, archive_id, *, source_scope, fingerprint, confirmed, authorization_check):
    """Finish only the exact interrupted, previously confirmed transaction."""
    if confirmed is not True:
        raise ArchiveBlocked("explicit move recovery confirmation required")
    root = Path(root).absolute()
    _assert_id(archive_id, "archive ID")
    folder = _private_dir(root, STORE_PARTS + ("placements",), create=False)
    if folder is None:
        raise ArchiveBlocked("no interrupted move")
    with _writer_lock(folder / "moves.lock"):
        receipt = placement_receipt(root, archive_id, source_scope)
        if receipt is None or receipt["fingerprint"] != fingerprint or receipt["status"] != "moving":
            raise ArchiveBlocked("no matching interrupted move")
        source = _move_path(root, receipt["from"], archive_id)
        if source is None:
            raise ArchiveBlocked("move source directory absent")
        with _writer_lock(source.with_suffix(".lock")):
            return _finish_move(root, receipt, authorization_check)


def list_archives(root, scope, authorization_check, *, limit=12, after=None):
    """Bounded tidy preview with a stable scoped continuation, never other homes."""
    import heapq
    root = Path(root).absolute()
    _scope_parts(scope)
    _authorize_scope(root, scope, authorization_check)
    if type(limit) is not int or not 1 <= limit <= 40:
        raise ArchiveBlocked("invalid chat preview limit")
    if after is not None:
        _assert_id(after, "preview continuation")
    folder = _private_dir(root, STORE_PARTS + _scope_parts(scope), create=False)
    if folder is None:
        return {"chats": [], "unavailable": 0, "truncated": False, "next_archive": None}
    files = heapq.nsmallest(limit + 1,
        (p for p in folder.iterdir() if p.suffix == ".jsonl" and ID.fullmatch(p.stem)
         and (after is None or p.stem > after)), key=lambda p: p.name)
    result, unavailable = [], 0
    for path in files[:limit]:
        try:
            receipt = placement_receipt(root, path.stem, scope)
            if receipt and (receipt["status"] != "committed" or receipt["to"] != scope):
                raise ArchiveBlocked("archive is moving")
            fd = _regular_open(path, os.O_RDONLY)
            with os.fdopen(fd, "rb") as stream:
                header_wire = stream.readline(4097)
            if len(header_wire) > 4096 or not header_wire.endswith(b"\n"):
                raise ArchiveBlocked("invalid preview header")
            header = _strict_json(header_wire)
            archive = ChatArchive(root, scope=scope, authorized_scope=scope,
                archive_id=path.stem, chat_id=header.get("chat_id"), origin=header.get("origin"),
                session_id=header.get("session_id"), authorization_check=authorization_check)
            messages = archive.read().messages
            result.append({"archive_id": path.stem, "scope": scope, "messages": len(messages),
                           "excerpt": messages[0]["text"][:240] if messages else ""})
        except (ArchiveBlocked, OSError, UnicodeError):
            unavailable += 1
    _authorize_scope(root, scope, authorization_check)
    for item in result:
        receipt = placement_receipt(root, item["archive_id"], scope)
        if receipt and (receipt["status"] != "committed" or receipt["to"] != scope):
            raise ArchiveBlocked("archive placement changed during preview")
    more = len(files) > limit
    return {"chats": result, "unavailable": unavailable, "truncated": more,
            "next_archive": files[limit - 1].stem if more else None}
