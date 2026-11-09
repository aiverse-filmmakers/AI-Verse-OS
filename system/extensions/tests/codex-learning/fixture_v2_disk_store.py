"""3A.17 disposable POSIX v2 archive fixture disk round-trip, NOT production.

This module is kept under tests/ and is never installed as a writer.
Its input is only a synthetic, untrusted Codex-received v2 fixture, not a
user chat. It implements exclusive publication of one fixture, preserving
the exact envelope bytes, with file/directory fsync and no overwrite.
A prior successful file survives a losing writer. Pending temp files are
not archive records. The SHA-256 receipt does NOT attest event provenance.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat

SCHEMA = "ai-verse.chat-archive-codex-received/v2"
MAX_BYTES = 6_000_000
MAX_FRAMES = 128
MAX_FRAME_BYTES = 65_536
MAX_ROW_BYTES = 100_000
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_FALSE_FLAGS = (
    "host_origin_authenticated", "scope_authenticated", "consent_verified",
    "complete_ui_coverage", "write_admitted",
)


class DiskFixtureBlocked(ValueError):
    """No content, source path or secret data in any refusal."""


def _deny() -> None:
    raise DiskFixtureBlocked("private synthetic v2 disk fixture refused")


@dataclass(frozen=True)
class FixtureReceipt:
    archive_id: str
    bytes: int
    sha256: str
    verdict: str = "disposable_fixture_only_not_authenticated_or_archivable"
    real_host_authenticated: bool = False
    real_scope_authorized: bool = False
    os_consent_verified: bool = False
    production_archive_admitted: bool = False


def _json(raw: bytes) -> dict:
    def pairs(rows):
        obj = {}
        for k, v in rows:
            if k in obj:
                _deny()
            obj[k] = v
        return obj

    try:
        obj = json.loads(
            raw.decode("utf-8", "strict"), object_pairs_hook=pairs,
            parse_constant=lambda _: _deny(),
        )
        if not isinstance(obj, dict):
            _deny()
        return obj
    except (ValueError, UnicodeError, TypeError):
        _deny()


def _validate_envelope(blob: bytes, archive_id: str) -> None:
    """Verify exact untrusted fixture chain independently of producer.

    This validates integrity only. A forged envelope remains untrusted and
    must never be treated as OS-issued consent or original provider data.
    """
    if (type(blob) is not bytes or not 1 <= len(blob) <= MAX_BYTES
            or not blob.endswith(b"\n")):
        _deny()
    rows = blob.splitlines(keepends=True)
    if not 6 <= len(rows) <= MAX_FRAMES + 2:
        _deny()
    if any(not x.endswith(b"\n") or len(x) > MAX_ROW_BYTES for x in rows):
        _deny()
    head, end = _json(rows[0]), _json(rows[-1])
    if (head.get("kind") != "header" or head.get("schema") != SCHEMA
            or head.get("archive_id") != archive_id
            or head.get("origin") != "codex-app-server-received"
            or head.get("mode") != "synthetic_fixture_only"
            or head.get("source_class") != "exact_received_jsonl_unverified"
            or end.get("kind") != "seal" or end.get("schema") != SCHEMA
            or end.get("original_source_offsets", "missing") is not None):
        _deny()
    if any(head.get(f) is not False or end.get(f) is not False for f in _FALSE_FLAGS):
        _deny()
    if type(end.get("frame_count")) is not int or end["frame_count"] != len(rows) - 2:
        _deny()
    received = bytearray()
    chain = hashlib.sha256(rows[0]).digest()
    for index, source in enumerate(rows[1:-1]):
        entry = _json(source)
        if (entry.get("kind") != "frame" or entry.get("schema") != SCHEMA
                or type(entry.get("index")) is not int
                or entry["index"] != index
                or type(entry.get("wire_byte_length")) is not int
                or not isinstance(entry.get("wire_sha256"), str)
                or not isinstance(entry.get("chain_sha256"), str)):
            _deny()
        try:
            wire = base64.b64decode(entry["wire_b64"], validate=True)
        except (ValueError, TypeError, KeyError):
            _deny()
        if (not 1 <= len(wire) <= MAX_FRAME_BYTES
                or len(wire) != entry["wire_byte_length"]
                or not wire.endswith(b"\n")
                or hashlib.sha256(wire).hexdigest() != entry["wire_sha256"]):
            _deny()
        chain = hashlib.sha256(chain + wire).digest()
        if entry["chain_sha256"] != chain.hex():
            _deny()
        received.extend(wire)
        if len(received) > 2_000_000:
            _deny()
    if (type(end.get("total_received_bytes")) is not int
            or end["total_received_bytes"] != len(received)
            or end.get("last_chain_sha256") != chain.hex()
            or end.get("received_stream_sha256") !=
            hashlib.sha256(received).hexdigest()
            or not isinstance(end.get("messages"), list)
            or len(end["messages"]) != 2
            or [m.get("role") if isinstance(m, dict) else None
                for m in end["messages"]] != ["user", "assistant"]):
        _deny()


def _directory(root: Path) -> int:
    if (os.name != "posix" or not isinstance(root, Path)
            or not root.is_absolute()):
        _deny()
    try:
        if root.resolve(strict=True) != root:
            _deny()
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open(root, flags)
        info = os.fstat(fd)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            os.close(fd)
            _deny()
        return fd
    except DiskFixtureBlocked:
        raise
    except (OSError, ValueError, RuntimeError, TypeError, AttributeError):
        _deny()


def _name(archive_id: str) -> str:
    if not isinstance(archive_id, str) or not _NAME.fullmatch(archive_id):
        _deny()
    return archive_id + ".synthetic-codex-v2.jsonl"


def _read_at(fd: int, filename: str) -> bytes:
    try:
        handle = os.open(
            filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd
        )
    except (OSError, ValueError, TypeError):
        _deny()
    try:
        info = os.fstat(handle)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077
                or not 1 <= info.st_size <= MAX_BYTES):
            _deny()
        chunks = []
        total = 0
        while True:
            part = os.read(handle, 65536)
            if not part:
                break
            total += len(part)
            if total > MAX_BYTES:
                _deny()
            chunks.append(part)
        again = os.fstat(handle)
        if ((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
             info.st_mode, info.st_nlink) !=
            (again.st_dev, again.st_ino, again.st_size, again.st_mtime_ns,
             again.st_mode, again.st_nlink)):
            _deny()
        return b"".join(chunks)
    finally:
        os.close(handle)


def publish_synthetic(root: Path, archive_id: str, envelope: bytes) -> FixtureReceipt:
    """Create only a new fixture in caller-owned 0700 temporary root.

    No overwrite, even when content matches. O_EXCL and hardlink publication
    avoid name collision while preserving any existing committed fixture.
    """
    name = _name(archive_id)
    _validate_envelope(envelope, archive_id)
    fd = _directory(root)
    tmp = ".uncommitted-" + secrets.token_hex(16)
    created = False
    published = False
    try:
        try:
            os.stat(name, dir_fd=fd, follow_symlinks=False)
            _deny()
        except FileNotFoundError:
            pass
        tmp_fd = os.open(
            tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW |
            os.O_CLOEXEC, 0o600, dir_fd=fd
        )
        created = True
        try:
            cursor = 0
            while cursor < len(envelope):
                wrote = os.write(tmp_fd, envelope[cursor:cursor + 65536])
                if wrote <= 0:
                    _deny()
                cursor += wrote
            os.fsync(tmp_fd)
        finally:
            os.close(tmp_fd)
        # Same directory: hardlink creates the final name only if absent.
        # A second writer never replaces a committed file.
        os.link(tmp, name, src_dir_fd=fd, dst_dir_fd=fd,
                follow_symlinks=False)
        published = True
        os.fsync(fd)
        os.unlink(tmp, dir_fd=fd)
        created = False
        os.fsync(fd)
        return FixtureReceipt(
            archive_id=archive_id, bytes=len(envelope),
            sha256=hashlib.sha256(envelope).hexdigest()
        )
    except DiskFixtureBlocked:
        raise
    except (OSError, TypeError, ValueError, OverflowError):
        _deny()
    finally:
        # An interrupted post-publication cleanup may leave a temp hardlink;
        # never delete the final published file during cleanup or recovery.
        if created:
            try:
                os.unlink(tmp, dir_fd=fd)
                os.fsync(fd)
            except OSError:
                pass
        os.close(fd)


def read_synthetic(root: Path, archive_id: str, receipt: FixtureReceipt) -> bytes:
    """Read back exact bytes only with a separate receipt and full recheck."""
    name = _name(archive_id)
    if (not isinstance(receipt, FixtureReceipt)
            or receipt.archive_id != archive_id
            or type(receipt.bytes) is not int
            or not 1 <= receipt.bytes <= MAX_BYTES
            or not isinstance(receipt.sha256, str)
            or not _SHA.fullmatch(receipt.sha256)
            or receipt.real_host_authenticated
            or receipt.real_scope_authorized
            or receipt.os_consent_verified
            or receipt.production_archive_admitted):
        _deny()
    fd = _directory(root)
    try:
        blob = _read_at(fd, name)
        if (len(blob) != receipt.bytes
                or hashlib.sha256(blob).hexdigest() != receipt.sha256):
            _deny()
        _validate_envelope(blob, archive_id)
        return blob
    finally:
        os.close(fd)


def admit_real_archive(_anything=None) -> dict:
    return {"status": "blocked", "reason": "synthetic fixture is not real capture"}
