"""3A.5 synthetic owner-choice, session and consent policy for Codex App Server.

There is NO trusted host-origin issuer in this file. A caller-controlled
ConsentRecord, OS Bridge or JSON event is NOT evidence of consent or auth.
This module exists only to exercise a future OS-owned protocol boundary in
synthetic tests. It never launches a real Codex server, installs hooks,
reads personal transcripts, creates an archive, or retains message bodies.

Production is unconditionally disabled, even with test-patched flags.
"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import stat
import subprocess
import time
from typing import Any, Mapping, Optional

MAX_SESSION_SECONDS = 3600
MAX_EVENTS = 512
SCOPE = re.compile(r"^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$")
IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PRODUCTION_HOST_ISSUER_ADMITTED = False
_PRODUCTION_CONSENT_ISSUER_ADMITTED = False


class PolicyBlocked(ValueError):
    """Static error text only. Never emit private paths, event data or IDs."""


@dataclass(frozen=True)
class OwnerIntent:
    """An artificial parent-side choice. Never derive this from host JSON."""

    scope: str
    cwd: Path
    expected_thread: str
    purpose: str = "new_text_only_thread"
    mode: str = "preview_only"
    private_session: bool = False
    historical_import: bool = False


class SyntheticConsent:
    """Mutable, fixture-owned current consent state, not an auth issuer."""

    def __init__(self, opted_in: bool = False):
        self.opted_in = opted_in
        self.revoked = False
        self.generation = 1

    def revoke(self) -> None:
        self.revoked = True
        self.generation += 1

    def set_opt_in(self, enabled: bool) -> None:
        # A new synthetic yes is not permission to revive an old lease.
        self.opted_in = enabled
        self.generation += 1


@dataclass(frozen=True)
class SyntheticLease:
    """In-memory correlation lease, NOT portable archive authorization."""

    root: Path
    cwd: Path
    scope: str
    thread_id: str
    process_identity: int
    consent_generation: int
    expires_at: float
    checked_events: int = 0
    closed: bool = False


@dataclass(frozen=True)
class PolicyResult:
    status: str = "synthetic_policy_match_not_authenticated_or_archivable"
    transport_authenticated: bool = False
    host_event_attested: bool = False
    scope_attested_at_event: bool = False
    consent_issued_by_os_ui: bool = False
    original_source_coverage_verified: bool = False
    archive_write_admitted: bool = False


def _block() -> None:
    raise PolicyBlocked("synthetic Codex trust/consent check refused")


def _physical_scope(bridge: Any, requested_cwd: Path) -> str:
    """Derive one scope from an existing physical OS folder, never JSON."""
    try:
        root = Path(bridge.root)
        if not root.is_absolute() or root.resolve(strict=True) != root:
            _block()
        if not isinstance(requested_cwd, Path) or not requested_cwd.is_absolute():
            _block()
        if requested_cwd.resolve(strict=True) != requested_cwd:
            _block()
        relative = requested_cwd.relative_to(root).parts
        cursor = root
        if stat.S_ISLNK(cursor.lstat().st_mode):
            _block()
        for segment in relative:
            cursor = cursor / segment
            mode = cursor.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                _block()
        if not relative:
            return "operator"
        if (len(relative) < 2 or relative[0] != "workspaces"
                or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", relative[1])):
            _block()
        scope = "workspace:" + relative[1]
        meta = bridge.manifest(relative[1])
        if meta.get("id") != relative[1] or meta.get("status") != "active":
            _block()
        return scope
    except Exception:
        _block()


def _fixture_child_identity(connection: Any) -> int:
    """The only accepted connection here is a disposable Python fixture."""
    try:
        if (getattr(connection, "identity", None)
                != "synthetic_owned_child_not_authenticated_codex"
                or getattr(connection, "_closed", True)):
            _block()
        process = connection._process
        if (not isinstance(process, subprocess.Popen)
                or process.poll() is not None or process.pid < 1):
            _block()
        return id(process)  # Local Python object identity, never signed proof.
    except Exception:
        _block()


def begin_synthetic_session(
    bridge: Any, connection: Any, intent: OwnerIntent,
    consent: SyntheticConsent,
) -> SyntheticLease:
    """Preview constraints only. Not a current user authorization flow."""
    if (not isinstance(intent, OwnerIntent)
            or not isinstance(consent, SyntheticConsent)
            or type(consent.opted_in) is not bool
            or not consent.opted_in or consent.revoked
            or not isinstance(intent.scope, str) or not SCOPE.fullmatch(intent.scope)
            or not isinstance(intent.expected_thread, str)
            or not IDENTITY.fullmatch(intent.expected_thread)
            or intent.purpose != "new_text_only_thread"
            or intent.mode != "preview_only"
            or intent.private_session is not False
            or intent.historical_import is not False):
        _block()
    try:
        if getattr(bridge, "harness", None) != "codex" or not bridge.registered():
            _block()
        physical = _physical_scope(bridge, intent.cwd)
        if physical != intent.scope:
            _block()
        process_identity = _fixture_child_identity(connection)
        return SyntheticLease(
            root=Path(bridge.root), cwd=intent.cwd, scope=intent.scope,
            thread_id=intent.expected_thread,
            process_identity=process_identity,
            consent_generation=consent.generation,
            expires_at=time.monotonic() + MAX_SESSION_SECONDS,
        )
    except Exception:
        _block()


def check_synthetic_event(
    bridge: Any, connection: Any, intent: OwnerIntent,
    consent: SyntheticConsent, lease: SyntheticLease, event: Mapping,
) -> tuple[SyntheticLease, PolicyResult]:
    """Per-event preview only. Never a stable permission token.

    Every event rechecks parent choice, revoked consent, expiry, child
    identity, physically bound workspace and current OS workspace status.
    Host JSON "consent"/"scope"/"trust" fields are ignored entirely.
    The caller must discard the whole lease on any exception or disconnect.
    """
    if (not isinstance(lease, SyntheticLease)
            or lease.closed or lease.checked_events >= MAX_EVENTS
            or not isinstance(intent, OwnerIntent)
            or not isinstance(consent, SyntheticConsent)
            or not isinstance(event, Mapping)):
        _block()
    try:
        if (time.monotonic() > lease.expires_at or consent.revoked
                or consent.opted_in is not True
                or consent.generation != lease.consent_generation
                or _fixture_child_identity(connection) != lease.process_identity
                or not bridge.registered()
                or getattr(bridge, "harness", None) != "codex"
                or Path(bridge.root) != lease.root
                or intent.cwd != lease.cwd or intent.scope != lease.scope
                or intent.expected_thread != lease.thread_id
                or intent.mode != "preview_only"
                or intent.private_session is not False
                or intent.historical_import is not False
                or _physical_scope(bridge, lease.cwd) != lease.scope):
            _block()
        method = event.get("method")
        params = event.get("params")
        # Notifications do not carry a JSON-RPC id. A child-origin
        # request with a familiar method name must never be admitted as
        # ordinary conversation traffic or trigger an implicit approval.
        if ("id" in event or ("jsonrpc" in event
                              and event["jsonrpc"] != "2.0")
                or not isinstance(method, str)
                or not isinstance(params, Mapping)):
            _block()
        # The thread ID originates from the parent-side new-thread plan,
        # not from a server-supplied thread/start or history listing.
        if params.get("threadId") != lease.thread_id:
            _block()
        if method not in (
                "turn/started", "item/started", "item/completed",
                "turn/completed", "item/agentMessage/delta",
                "item/reasoning/summaryTextDelta"):
            _block()
        # Do not expose any transport-origin event body to the consent
        # policy's return value, including raw text and images.
        return (
            SyntheticLease(
                root=lease.root, cwd=lease.cwd, scope=lease.scope,
                thread_id=lease.thread_id,
                process_identity=lease.process_identity,
                consent_generation=lease.consent_generation,
                expires_at=lease.expires_at,
                checked_events=lease.checked_events + 1,
                closed=method == "turn/completed",
            ),
            PolicyResult(),
        )
    except Exception:
        _block()


def capture_admission(_lease: Optional[SyntheticLease] = None) -> dict:
    """No synthetic policy decision can authorize persistence."""
    return {
        "status": "blocked",
        "reason": "authenticated host event, consent issuer and source coverage absent",
    }


def connect_real_codex(_args=None) -> dict:
    """No real host operation, even with simulated admission flags."""
    if (not _PRODUCTION_HOST_ISSUER_ADMITTED
            or not _PRODUCTION_CONSENT_ISSUER_ADMITTED):
        return {"status": "blocked", "reason": "real Codex connection unadmitted"}
    return {"status": "blocked", "reason": "production trust implementation absent"}
