"""3A.11: NON-LAUNCHING candidate runtime file preflight for Persistent Chats.

Codex App Server uses a CLI-owned stdio JSONL transport, but generated
source schemas do not attest the installed Codex executable. A caller's
expected hash is not a signed release or a trusted origin assertion.

This code inspects only a caller-selected isolated *synthetic/test* file
inside an owner-private directory. It never launches Codex, runs version
commands, reads the home directory or creates authorizations/archives.
No production integration imports this module. Any future launch must
separately review artifact acquisition and bind the actual executed bytes
to the authenticated OS-owned child, current consent and physical scope.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import re
import stat

SOURCE_SCHEMA_COMMIT = "e54a5713caf331f42a6eef0166186df5f7563c29"
MAX_CANDIDATE_BYTES = 160_000_000
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RUNTIME_ADMITTED = False
_CONSENT_ISSUER_VERIFIED = False
_SCOPE_ISSUER_VERIFIED = False


class RuntimePreflightBlocked(ValueError):
    """Never includes source data, private paths or file digests."""


def _deny() -> None:
    raise RuntimePreflightBlocked("unverified Codex runtime candidate refused")


@dataclass(frozen=True)
class ProposedRuntime:
    # Caller-originated values, not approved binary provenance.
    private_root: Path
    expected_sha256: str
    source_schema_commit: str = SOURCE_SCHEMA_COMMIT
    executable_name: str = "codex"


@dataclass(frozen=True)
class RuntimeCandidateReceipt:
    """Local read-only comparison, not evidence of the executed program."""
    file_size: int
    observed_sha256: str
    source_schema_commit: str
    verdict: str = "caller_digest_match_not_host_attestation"
    approved_release_verified: bool = False
    executed_bytes_verified: bool = False
    real_host_authenticated: bool = False
    process_owned_by_os: bool = False
    consent_issued_by_os: bool = False
    scope_at_event_verified: bool = False
    archive_write_admitted: bool = False


def inspect_candidate(spec: ProposedRuntime) -> RuntimeCandidateReceipt:
    """Hash exactly one owner-private regular test file, never execute it.

    The parent directory is opened with O_NOFOLLOW and the file is opened
    relative to that descriptor. Both handles are rechecked after hashing.
    This only guards local inspection, not a future pathname-based exec
    or a replacement between inspection and launch.
    """
    if (os.name != "posix" or not isinstance(spec, ProposedRuntime)
            or not isinstance(spec.private_root, Path)
            or not spec.private_root.is_absolute()
            or spec.executable_name != "codex"
            or spec.source_schema_commit != SOURCE_SCHEMA_COMMIT
            or not isinstance(spec.expected_sha256, str)
            or not _SHA256.fullmatch(spec.expected_sha256)):
        _deny()
    root = spec.private_root
    root_fd = None
    executable_fd = None
    try:
        if root.is_symlink() or root.resolve(strict=True) != root:
            _deny()
        dir_flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
        root_fd = os.open(root, dir_flags)
        before_dir = os.fstat(root_fd)
        if (not stat.S_ISDIR(before_dir.st_mode)
                or before_dir.st_uid != os.getuid()
                or before_dir.st_mode & 0o077):
            _deny()
        file_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        executable_fd = os.open(spec.executable_name, file_flags, dir_fd=root_fd)
        before = os.fstat(executable_fd)
        if (not stat.S_ISREG(before.st_mode)
                or before.st_uid != os.getuid()
                or before.st_mode & 0o077
                or not before.st_mode & stat.S_IXUSR
                or not 1 <= before.st_size <= MAX_CANDIDATE_BYTES):
            _deny()
        digest = hashlib.sha256()
        received = 0
        while True:
            chunk = os.read(executable_fd, 65536)
            if not chunk:
                break
            received += len(chunk)
            if received > MAX_CANDIDATE_BYTES:
                _deny()
            digest.update(chunk)
        after = os.fstat(executable_fd)
        after_dir = os.fstat(root_fd)
        path_dir = root.stat()
        signature = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_mode)
        if (received != before.st_size
                or signature(before) != signature(after)
                or signature(before_dir) != signature(after_dir)
                or signature(before_dir) != signature(path_dir)
                or digest.hexdigest() != spec.expected_sha256):
            _deny()
        return RuntimeCandidateReceipt(
            file_size=received, observed_sha256=digest.hexdigest(),
            source_schema_commit=SOURCE_SCHEMA_COMMIT,
        )
    except RuntimePreflightBlocked:
        raise
    except (OSError, TypeError, ValueError, OverflowError):
        _deny()
    finally:
        if executable_fd is not None:
            os.close(executable_fd)
        if root_fd is not None:
            os.close(root_fd)


def admit_real_host(_receipt=None, _claims=None) -> dict:
    """Always deny, even if tests patch the development flags."""
    return {
        "status": "blocked",
        "reason": "runtime issuer, executable launch binding and consent absent",
    }


def connect_real_codex(_receipt=None, _plan=None) -> dict:
    """No subprocess, transport connection or archive writer is available."""
    return {"status": "blocked", "reason": "no authenticated real-host connection"}
