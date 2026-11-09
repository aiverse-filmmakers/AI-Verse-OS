"""3A.15 synthetic-only OS-owner consent, scope and session-invalidation model.

A Codex thread/session ID and an RPC response are NOT proof of OS consent.
This file models an independent parent-owned authority for testing; it has
no connection to the live OS identity service, authenticated user sessions,
App Server transport, installation, Memory or an archive writer.

All 'consent', process handles and workspace choices here are *synthetic*.
They must NEVER be treated as proof that a real user consented. Real host
admission, source capture, history import and archival are hard blocked.
Only synthetic preview counters are returned, never message content.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
import re
import stat
import time
from typing import Any, Mapping

MAX_EVENTS = 64
MAX_LEASE_SECONDS = 900.0
SCOPE = re.compile(r"^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$")
IDENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MAX_TIMESTAMP = (1 << 63) - 1


class PreviewBlocked(ValueError):
    """Static denial: never contains paths, source text or identifiers."""


def _deny() -> None:
    raise PreviewBlocked("synthetic Persistent Chats authorization refused")


@dataclass(frozen=True)
class PreviewLease:
    # A private in-process identity, not a serializable or bearer capability.
    _marker: object = field(repr=False, compare=False)


@dataclass(frozen=True)
class PreviewDecision:
    verdict: str = "synthetic_event_consistency_only_not_capture_permission"
    checked_events: int = 0
    authenticated_os_session: bool = False
    authenticated_codex_host: bool = False
    consent_issued_by_os_ui: bool = False
    real_scope_issuer_verified: bool = False
    complete_source_coverage: bool = False
    archive_write_admitted: bool = False


@dataclass
class _Record:
    lease: PreviewLease
    generation: int
    process: object
    scope: str
    cwd: Path
    path_identity: tuple
    thread: str
    turn: str
    expires_at: float
    phase: str = "thread_notice"
    checked_events: int = 0
    closed: bool = False


def _ident(value: Any) -> str:
    if not isinstance(value, str) or not IDENT.fullmatch(value):
        _deny()
    return value


def _scope(value: Any) -> str:
    if not isinstance(value, str) or not SCOPE.fullmatch(value):
        _deny()
    return value


def _directory_identity(root: Path, scope: str, cwd: Path) -> tuple:
    """Check one exact physical synthetic scope, including its ancestors.

    No symlinked directory, foreign owner or group/world-writeable directory
    can represent this fixture. This path check does NOT prove that a real
    OS workspace is authorized or that the filesystem cannot change later.
    """
    if (os.name != "posix" or not isinstance(root, Path)
            or not isinstance(cwd, Path) or not root.is_absolute()
            or not cwd.is_absolute()):
        _deny()
    target = root if scope == "operator" else (
        root / "workspaces" / scope.removeprefix("workspace:")
    )
    if cwd != target:
        _deny()
    try:
        if root.resolve(strict=True) != root or cwd.resolve(strict=True) != cwd:
            _deny()
        paths = (
            (root,) if scope == "operator"
            else (root, root / "workspaces", target)
        )
        result = []
        for part in paths:
            info = part.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o022):
                _deny()
            result.append((info.st_dev, info.st_ino, info.st_uid, info.st_mode))
        return tuple(result)
    except PreviewBlocked:
        raise
    except (OSError, ValueError, RuntimeError, TypeError):
        _deny()


class SyntheticPreviewOwner:
    """Single private-parent fixture ledger; no live OS trust issuer.

    A synthetic scope switch, consent change, process replacement, or
    disconnect irreversibly invalidates the old lease. A fresh opt-in
    cannot restore earlier leases even if the user reselects the old scope.
    """

    def __init__(self, root: Path, owned_process: object):
        if owned_process is None:
            _deny()
        _directory_identity(root, "operator", root)
        self._root = root
        self._process = owned_process
        self._selected: str | None = None
        self._consented = False
        self._generation = 1
        self._allowed: set[str] = set()
        self._active: _Record | None = None

    def _invalidate(self) -> None:
        self._generation += 1
        if self._active is not None:
            self._active.closed = True
        self._active = None

    def set_scope_active(self, scope: str, active: bool) -> None:
        """Synthetic directory registry, not actual OS workspace status."""
        scope = _scope(scope)
        if type(active) is not bool:
            _deny()
        _directory_identity(
            self._root, scope,
            self._root if scope == "operator"
            else self._root / "workspaces" / scope.removeprefix("workspace:")
        )
        self._invalidate()
        if active:
            self._allowed.add(scope)
        else:
            self._allowed.discard(scope)

    def select_scope(self, scope: str) -> None:
        scope = _scope(scope)
        if scope not in self._allowed:
            _deny()
        self._invalidate()
        self._selected = scope

    def set_preview_consent(self, enabled: bool) -> None:
        """Only a test's parent directly changes this; never host JSON."""
        if type(enabled) is not bool:
            _deny()
        self._invalidate()
        self._consented = enabled

    def replace_owned_process(self, new_process: object) -> None:
        if new_process is None:
            _deny()
        self._invalidate()
        self._process = new_process

    def disconnect(self) -> None:
        self._invalidate()
        self._process = None

    def begin_preview(
        self, *, scope: str, cwd: Path, process: object,
        thread_id: str, turn_id: str, purpose: str = "fresh_text_preview",
        private: bool = False, historical: bool = False,
        recording: bool = False,
    ) -> PreviewLease:
        """Bind a synthetic prospective thread only; never admit capture."""
        scope = _scope(scope)
        if (scope not in self._allowed or self._selected != scope
                or not self._consented or process is None
                or process is not self._process
                or purpose != "fresh_text_preview" or private is not False
                or historical is not False or recording is not False):
            _deny()
        tid, turn = _ident(thread_id), _ident(turn_id)
        identity = _directory_identity(self._root, scope, cwd)
        if self._active is not None:
            self._active.closed = True
        lease = PreviewLease(object())
        self._active = _Record(
            lease=lease, generation=self._generation,
            process=process, scope=scope, cwd=cwd,
            path_identity=identity, thread=tid, turn=turn,
            expires_at=time.monotonic() + MAX_LEASE_SECONDS,
        )
        return lease

    def _current(self, lease: PreviewLease, process: object,
                 scope: str) -> _Record:
        record = self._active
        if (not isinstance(lease, PreviewLease) or record is None
                or record.lease is not lease or record.closed
                or record.generation != self._generation
                or not self._consented
                or self._selected != record.scope or scope != record.scope
                or record.scope not in self._allowed
                or self._process is not process or record.process is not process
                or time.monotonic() >= record.expires_at
                or record.checked_events >= MAX_EVENTS):
            _deny()
        if _directory_identity(self._root, record.scope, record.cwd) != record.path_identity:
            _deny()
        return record

    def observe(
        self, lease: PreviewLease, *, process: object,
        scope: str, event: Mapping[str, Any],
    ) -> PreviewDecision:
        """Recheck every transition before observing a disposable event.

        Never save the untrusted event in the ledger or claim host provenance.
        Any refusal closes the current lease, including a malicious frame.
        """
        record = self._active
        try:
            record = self._current(lease, process, scope)
            if (not isinstance(event, Mapping)
                    or ("jsonrpc" in event and event["jsonrpc"] != "2.0")
                    or "id" in event or "result" in event or "error" in event):
                _deny()
            method = event.get("method")
            params = event.get("params")
            if not isinstance(params, Mapping):
                _deny()
            if record.phase == "thread_notice":
                thread = params.get("thread")
                if (method != "thread/started" or not isinstance(thread, Mapping)
                        or thread.get("id") != record.thread
                        or thread.get("sessionId") != record.thread
                        or thread.get("forkedFromId") is not None
                        or thread.get("ephemeral") is not True
                        or thread.get("cwd") != str(record.cwd)
                        or thread.get("turns") != []):
                    _deny()
                record.phase = "turn_notice"
            elif record.phase == "turn_notice":
                turn = params.get("turn")
                if (method != "turn/started"
                        or params.get("threadId") != record.thread
                        or not isinstance(turn, Mapping)
                        or turn.get("id") != record.turn
                        or turn.get("items") != []
                        or turn.get("status") != "inProgress"):
                    _deny()
                record.phase = "streaming"
            elif record.phase == "streaming":
                if method in ("item/started", "item/completed"):
                    if (params.get("threadId") != record.thread
                            or params.get("turnId") != record.turn
                            or not isinstance(params.get("item"), Mapping)):
                        _deny()
                    timestamp = (
                        "startedAtMs" if method == "item/started"
                        else "completedAtMs"
                    )
                    stamp = params.get(timestamp)
                    if type(stamp) is not int or not 0 <= stamp <= MAX_TIMESTAMP:
                        _deny()
                elif method == "turn/completed":
                    turn = params.get("turn")
                    if (params.get("threadId") != record.thread
                            or not isinstance(turn, Mapping)
                            or turn.get("id") != record.turn
                            or turn.get("status") != "completed"):
                        _deny()
                    record.phase = "closed"
                    record.closed = True
                else:
                    _deny()
            else:
                _deny()
            record.checked_events += 1
            return PreviewDecision(checked_events=record.checked_events)
        except PreviewBlocked:
            if record is not None:
                record.closed = True
            raise
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError):
            if record is not None:
                record.closed = True
            _deny()


def authorize_production_capture(_owner=None, _lease=None) -> dict:
    return {"status": "blocked", "reason": "real OS consent and host issuer absent"}


def persist_authenticated_chat(_owner=None, _event=None) -> dict:
    return {"status": "blocked", "reason": "authorized v2 archival not implemented"}
