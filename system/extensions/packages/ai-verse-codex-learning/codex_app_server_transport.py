"""Test-only OS-owned stdio subprocess boundary for Codex App Server planning.

This module is intentionally NOT installed, imported by Bridge, or wired
to any archive writer. It launches only a SHA-pinned, disposable synthetic
Python fixture, never Codex. Its independently owned process handle and
private pipes model the future OS-managed App Server connection. No hook
JSON or parsed stream content ever becomes authentication or consent.

Production connect_codex() is unconditionally blocked, even when a
code-level admission flag is patched in a test. No live API credentials,
personal home paths, shell, network endpoint, or existing chat are read.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import time
from typing import Any, Mapping, Optional

# Neither flag is configurable from extension settings or event JSON.
_PRODUCTION_APP_SERVER_ADMITTED = False
_APP_SERVER_HOST_SCOPE_ISSUER_ADMITTED = False

MAX_FRAME_BYTES = 65_536
MAX_RECEIVED_FRAMES = 64
MAX_FIXTURE_SOURCE_BYTES = 2_000_000
MAX_EXECUTABLE_BYTES = 128_000_000
MAX_FRAME_WAIT_SECONDS = 3.0
SHA256 = re.compile(r"^[a-f0-9]{64}$")


class TransportBlocked(ValueError):
    """Only static errors, never exception text or private subprocess bytes."""


@dataclass(frozen=True)
class SyntheticChildSpec:
    """Pinned synthetic-only process, not a production Codex launch plan."""

    executable: Path
    executable_sha256: str
    fixture_script: Path
    fixture_sha256: str
    private_cwd: Path


def _sha256_file(path: Path, expected: str, max_size: int) -> None:
    if not isinstance(expected, str) or not SHA256.fullmatch(expected):
        raise TransportBlocked("invalid synthetic fixture digest")
    if not isinstance(path, Path) or not path.is_absolute():
        raise TransportBlocked("invalid synthetic fixture path")
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            info = os.fstat(descriptor)
            if (not stat.S_ISREG(info.st_mode) or info.st_size > max_size
                    or info.st_size <= 0 or info.st_mode & 0o022):
                raise TransportBlocked("unsafe synthetic fixture file")
            hash_value = hashlib.sha256()
            count = 0
            while True:
                data = os.read(descriptor, 65536)
                if not data:
                    break
                count += len(data)
                if count > max_size:
                    raise TransportBlocked("oversized synthetic fixture file")
                hash_value.update(data)
            if hash_value.hexdigest() != expected:
                raise TransportBlocked("synthetic fixture digest mismatch")
            after = os.fstat(descriptor)
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
                    info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns):
                raise TransportBlocked("synthetic fixture changed while reading")
        finally:
            os.close(descriptor)
    except TransportBlocked:
        raise
    except (OSError, ValueError, TypeError):
        raise TransportBlocked("synthetic fixture cannot be verified") from None


def _validate_spec(spec: SyntheticChildSpec) -> None:
    if os.name != "posix":
        raise TransportBlocked("synthetic POSIX pipe transport only")
    if not isinstance(spec, SyntheticChildSpec):
        raise TransportBlocked("invalid synthetic child specification")
    try:
        python = Path(sys.executable).resolve(strict=True)
        executable = spec.executable
        fixture = spec.fixture_script
        cwd = spec.private_cwd
        if (not all(isinstance(x, Path) and x.is_absolute()
                    for x in (executable, fixture, cwd))
                or executable != python
                or executable.is_symlink() or fixture.is_symlink()
                or cwd.is_symlink()
                or cwd.resolve(strict=True) != cwd
                or fixture.parent != cwd):
            raise TransportBlocked("untrusted synthetic child identity")
        info = cwd.stat()
        fixture_info = fixture.stat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077
                or info.st_uid != os.getuid()
                or fixture_info.st_uid != os.getuid()):
            raise TransportBlocked("synthetic fixture directory not private")
        _sha256_file(executable, spec.executable_sha256, MAX_EXECUTABLE_BYTES)
        _sha256_file(fixture, spec.fixture_sha256, MAX_FIXTURE_SOURCE_BYTES)
    except TransportBlocked:
        raise
    except (OSError, ValueError, TypeError):
        raise TransportBlocked("synthetic child identity unavailable") from None


def _json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise TransportBlocked("duplicate JSON frame key")
        result[key] = value
    return result


def _json_constant(_value):
    raise TransportBlocked("nonfinite JSON frame")


class OwnedFixtureConnection:
    """Holds the real Popen child handle, not an untrusted external PID."""

    def __init__(self, process: subprocess.Popen):
        if not isinstance(process, subprocess.Popen):
            raise TransportBlocked("unowned child process")
        self._process = process
        self._pending = bytearray()
        self._received = 0
        self._closed = False
        self.identity = "synthetic_owned_child_not_authenticated_codex"

    @property
    def pid(self) -> int:
        return self._process.pid

    def _send(self, value: Mapping) -> None:
        if self._closed or self._process.poll() is not None:
            raise TransportBlocked("synthetic process not running")
        wire = json.dumps(
            value, ensure_ascii=False, allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        if len(wire) > MAX_FRAME_BYTES:
            raise TransportBlocked("oversized outbound synthetic frame")
        try:
            self._process.stdin.write(wire)
            self._process.stdin.flush()
        except (OSError, ValueError, BrokenPipeError):
            raise TransportBlocked("synthetic outbound pipe failed") from None

    def read_frame_with_raw(self, timeout=MAX_FRAME_WAIT_SECONDS) -> tuple[dict, bytes]:
        """Read one bounded JSONL frame and retain the EXACT received bytes.

        This remains synthetic-only; raw pipe bytes are NOT host attestation.
        The wire includes the original terminal newline and is never
        reconstructed with json.dumps().

        Read one bounded JSONL frame without trusting child stdout.

        select/os.read are used instead of buffered readline so an incomplete
        line cannot hang indefinitely after a single readable byte.
        """
        if self._closed or self._received >= MAX_RECEIVED_FRAMES:
            raise TransportBlocked("synthetic transport closed or over budget")
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= MAX_FRAME_WAIT_SECONDS:
            raise TransportBlocked("invalid synthetic frame timeout")
        deadline = time.monotonic() + timeout
        try:
            fd = self._process.stdout.fileno()
            while b"\n" not in self._pending:
                if len(self._pending) > MAX_FRAME_BYTES:
                    raise TransportBlocked("oversized incoming synthetic frame")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TransportBlocked("synthetic stdout frame timed out")
                ready, _, _ = select.select([fd], [], [], remaining)
                if not ready:
                    raise TransportBlocked("synthetic stdout frame timed out")
                chunk = os.read(fd, 4096)
                if not chunk:
                    raise TransportBlocked("synthetic child terminated or truncated frame")
                self._pending.extend(chunk)
            raw, _, remainder = self._pending.partition(b"\n")
            self._pending = bytearray(remainder)
            if not raw or len(raw) + 1 > MAX_FRAME_BYTES:
                raise TransportBlocked("oversized or empty synthetic frame")
            frame = json.loads(
                raw.decode("utf-8", "strict"),
                object_pairs_hook=_json_pairs,
                parse_constant=_json_constant,
            )
            if not isinstance(frame, dict):
                raise TransportBlocked("invalid synthetic frame envelope")
            if "jsonrpc" in frame and frame["jsonrpc"] != "2.0":
                raise TransportBlocked("invalid synthetic JSON-RPC version")
            self._received += 1
            # bytearray.partition() returns a mutable bytearray. Freeze the
            # exact received bytes without reserializing or normalizing JSON.
            return frame, bytes(raw) + b"\n"
        except TransportBlocked:
            raise
        except (OSError, UnicodeError, ValueError, TypeError):
            raise TransportBlocked("malformed synthetic stdout frame") from None

    def read_frame(self, timeout=MAX_FRAME_WAIT_SECONDS) -> dict:
        """Legacy parsed-only fixture API. Drops the source-wire witness."""
        frame, _raw = self.read_frame_with_raw(timeout)
        return frame

    def handshake(self) -> None:
        """Initialize the private fixture before exposing notifications."""
        self._send({
            "method": "initialize", "id": 1,
            "params": {"clientInfo": {
                "name": "aiverse_os_synthetic_test",
                "title": "AI-Verse OS disposable fixture",
                "version": "0.0.0-test",
            }},
        })
        answer = self.read_frame()
        if (answer.get("id") != 1 or "error" in answer
                or not isinstance(answer.get("result"), Mapping)
                or "method" in answer):
            raise TransportBlocked("synthetic handshake refused")
        self._send({"method": "initialized"})

    def next_notification(self, timeout=MAX_FRAME_WAIT_SECONDS) -> dict:
        frame, _raw = self.next_notification_with_raw(timeout)
        return frame

    def next_notification_with_raw(
        self, timeout=MAX_FRAME_WAIT_SECONDS
    ) -> tuple[dict, bytes]:
        """Synthetic-only notification with unmodified JSONL source bytes."""
        frame, raw = self.read_frame_with_raw(timeout)
        if (not isinstance(frame.get("method"), str)
                or "id" in frame
                or not isinstance(frame.get("params"), Mapping)):
            raise TransportBlocked("unexpected synthetic RPC frame")
        return frame, raw

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        process = self._process
        try:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=1)
        finally:
            for pipe in (process.stdin, process.stdout):
                if pipe is not None:
                    try:
                        pipe.close()
                    except OSError:
                        pass

    def __enter__(self):
        return self

    def __exit__(self, _type, _value, _tb):
        self.close()


def launch_synthetic_fixture(spec: SyntheticChildSpec) -> OwnedFixtureConnection:
    """Start a disposable pinned Python fixture, never a Codex executable.

    Hash verification is not an atomic proof of executed bytes and is never
    exported as host attestation. This function has no production branch.
    """
    _validate_spec(spec)
    try:
        # No inherited API credentials, home directory, PYTHONPATH, shell,
        # extra FDs, terminal, app-server auth, or personal OS working dir.
        process = subprocess.Popen(
            [str(spec.executable), "-I", "-S", "-u", str(spec.fixture_script)],
            shell=False, cwd=str(spec.private_cwd),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, close_fds=True,
            env={"PYTHONDONTWRITEBYTECODE": "1",
                 "PYTHONNOUSERSITE": "1", "PYTHONIOENCODING": "utf-8"},
            start_new_session=True,
        )
    except (OSError, ValueError):
        raise TransportBlocked("synthetic fixture could not start") from None
    connection = OwnedFixtureConnection(process)
    try:
        connection.handshake()
    except Exception:
        connection.close()
        raise
    return connection


def connect_codex_app_server(_launch_plan: Optional[Any] = None) -> dict:
    """Production transport and consent gates remain unimplemented."""
    if (not _PRODUCTION_APP_SERVER_ADMITTED
            or not _APP_SERVER_HOST_SCOPE_ISSUER_ADMITTED):
        return {"status": "blocked", "reason": "Codex transport unadmitted"}
    # Even a test-patched flag cannot start Codex or save user chat.
    return {"status": "blocked", "reason": "host provenance issuer not implemented"}
