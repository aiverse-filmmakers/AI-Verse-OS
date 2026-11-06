"""3A.6: synthetic-only parent-request / server-response turn binding.

This module models a fresh OS-originated thread/start followed by one
turn/start against a disposable owned Python fixture. It does not launch a
real Codex process, resume historical threads, authenticate a remote/local
server, store message bytes, issue consent, or write an OS archive.

A request ID establishes CORRELATION on ONE already-owned, still-alive
synthetic pipe, never authenticity. The downstream 3A.5 policy checks
current physical workspace and consent at EACH transition. Responses are
untrusted JSON and may only establish provisional IDs for this fixture.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
from pathlib import Path
import re
import time
from typing import Any, Mapping, Optional, Tuple

MAX_PROMPT_BYTES = 200_000
MAX_ITEM_NOTIFICATIONS = 64
THREAD_REQUEST_ID = 41
TURN_REQUEST_ID = 42
INTERRUPT_REQUEST_ID = 43
PENDING_THREAD = "synthetic-unassigned-new-thread"
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PRODUCTION_REQUEST_BINDING_ADMITTED = False


class BindingBlocked(ValueError):
    """Error messages must not contain prompts, source IDs or paths."""


@dataclass(frozen=True)
class ParentBinding:
    """Transient synthetic correlation, NOT host or archive attestation."""

    bridge_identity: int
    connection_identity: int
    child_process_identity: int
    cwd: Path
    scope: str
    consent_generation: int
    expires_at: float
    phase: str = "await_thread_response"
    thread_id: Optional[str] = None
    turn_id: Optional[str] = None
    prompt_sha256: Optional[str] = None
    item_notifications: int = 0
    transport_authenticated: bool = False
    event_origin_authenticated: bool = False
    scope_authority_issued: bool = False
    consent_issued: bool = False
    complete_source_coverage: bool = False
    archive_admitted: bool = False


def _deny():
    raise BindingBlocked("synthetic request/response binding refused")


def _ident(value: Any) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        _deny()
    return value


def _guard(state, bridge, connection, consent, policy):
    """Recheck current *synthetic* owner state before every state change.

    Neither an old lease nor a response-supplied "trusted" flag qualifies.
    """
    try:
        if (not isinstance(state, ParentBinding)
                or state.phase in ("abandoned", "completed")
                or id(bridge) != state.bridge_identity
                or id(connection) != state.connection_identity
                or time.monotonic() >= state.expires_at
                or type(getattr(consent, "generation", None)) is not int
                or consent.generation != state.consent_generation):
            _deny()
        plan = policy.OwnerIntent(
            scope=state.scope,
            cwd=state.cwd,
            expected_thread=state.thread_id or PENDING_THREAD,
            purpose="new_text_only_thread",
            mode="preview_only",
            private_session=False,
            historical_import=False,
        )
        current = policy.begin_synthetic_session(
            bridge, connection, plan, consent,
        )
        if (current.process_identity != state.child_process_identity
                or current.scope != state.scope
                or current.cwd != state.cwd
                or current.consent_generation != state.consent_generation):
            _deny()
    except Exception:
        _deny()


def begin_thread(bridge, connection, scope, cwd, consent, policy
                 ) -> Tuple[ParentBinding, dict]:
    """Create a parent-owned FRESH thread/start request for a fake child."""
    try:
        if not isinstance(cwd, Path) or not cwd.is_absolute():
            _deny()
        plan = policy.OwnerIntent(
            scope=scope, cwd=cwd, expected_thread=PENDING_THREAD,
            purpose="new_text_only_thread", mode="preview_only",
            private_session=False, historical_import=False,
        )
        lease = policy.begin_synthetic_session(
            bridge, connection, plan, consent,
        )
        state = ParentBinding(
            bridge_identity=id(bridge),
            connection_identity=id(connection),
            child_process_identity=lease.process_identity,
            cwd=lease.cwd, scope=lease.scope,
            consent_generation=lease.consent_generation,
            expires_at=lease.expires_at,
        )
        # No real model, provider credentials, or executable supplied.
        # These bytes are permitted only to a disposable test child.
        request = {
            "id": THREAD_REQUEST_ID, "method": "thread/start",
            "params": {
                "cwd": str(lease.cwd),
                "ephemeral": True,
                "approvalPolicy": "never",
                "sandbox": "read-only",
                "model": "synthetic-model-never-run",
            },
        }
        return state, request
    except Exception:
        _deny()


def begin_turn(state: ParentBinding, bridge, connection, consent, policy,
               prompt: str) -> Tuple[ParentBinding, dict]:
    """Build exactly one parent-originated text-only turn/start.

    The returned request temporarily contains prompt text for fixture
    dispatch; the returned state stores only a digest. Neither is archived.
    """
    _guard(state, bridge, connection, consent, policy)
    if state.phase != "thread_ready" or state.thread_id is None:
        _deny()
    try:
        encoded = prompt.encode("utf-8", "strict")
        if not encoded or len(encoded) > MAX_PROMPT_BYTES:
            _deny()
    except (AttributeError, TypeError, UnicodeError):
        _deny()
    digest = hashlib.sha256(encoded).hexdigest()
    request = {
        "id": TURN_REQUEST_ID, "method": "turn/start",
        "params": {
            "threadId": state.thread_id,
            "input": [{"type": "text", "text": prompt}],
            "cwd": str(state.cwd),
            "approvalPolicy": "never",
            "sandboxPolicy": {
                "type": "readOnly",
                "access": {"type": "restricted",
                           "includePlatformDefaults": False,
                           "readableRoots": [str(state.cwd)]},
            },
        },
    }
    return replace(state, phase="await_turn_response",
                   prompt_sha256=digest), request


def receive(state: ParentBinding, bridge, connection, consent, policy,
            frame: Mapping) -> Tuple[ParentBinding, str]:
    """Consume one bounded already-decoded fixture frame.

    Source completeness must be separately evaluated by 3A.3; we never
    accept item content as authenticated or emit an archive record.
    An exception requires the caller to abandon the entire session.
    """
    _guard(state, bridge, connection, consent, policy)
    try:
        if (not isinstance(frame, Mapping)
                or ("jsonrpc" in frame and frame["jsonrpc"] != "2.0")):
            _deny()
        phase = state.phase
        if "id" in frame:
            if ("method" in frame or "error" in frame
                    or type(frame["id"]) is not int
                    or not isinstance(frame.get("result"), Mapping)):
                _deny()
            if phase == "await_thread_response":
                if frame["id"] != THREAD_REQUEST_ID:
                    _deny()
                thread = frame["result"].get("thread")
                if not isinstance(thread, Mapping):
                    _deny()
                thread_id = _ident(thread.get("id"))
                if (thread.get("sessionId", thread_id) != thread_id
                        or thread.get("forkedFromId") not in (None, "")
                        or thread.get("ephemeral") is not True
                        or thread.get("cwd", str(state.cwd)) != str(state.cwd)
                        or thread.get("turns") not in (None, [])
                        or thread.get("history") not in (None, [])):
                    _deny()
                return replace(state, thread_id=thread_id,
                               phase="await_thread_notification"), "thread_response_bound"
            if phase == "await_turn_response":
                if frame["id"] != TURN_REQUEST_ID:
                    _deny()
                turn = frame["result"].get("turn")
                if not isinstance(turn, Mapping):
                    _deny()
                turn_id = _ident(turn.get("id"))
                if (turn.get("status") != "inProgress"
                        or turn.get("items") != []
                        or turn.get("error") is not None
                        or frame["result"].get("threadId", state.thread_id)
                        != state.thread_id):
                    _deny()
                return replace(state, turn_id=turn_id,
                               phase="await_turn_notification"), "turn_response_bound"
            _deny()

        method = frame.get("method")
        params = frame.get("params")
        if not isinstance(method, str) or not isinstance(params, Mapping):
            _deny()
        if method == "thread/started" and phase == "await_thread_notification":
            thread = params.get("thread")
            if (not isinstance(thread, Mapping)
                    or _ident(thread.get("id")) != state.thread_id
                    or thread.get("sessionId", state.thread_id) != state.thread_id
                    or thread.get("forkedFromId") not in (None, "")):
                _deny()
            return replace(state, phase="thread_ready"), "thread_notice_bound"

        if (method == "turn/started" and
                phase == "await_turn_notification"):
            turn = params.get("turn")
            if (params.get("threadId") != state.thread_id
                    or not isinstance(turn, Mapping)
                    or _ident(turn.get("id")) != state.turn_id
                    or turn.get("status") != "inProgress"
                    or turn.get("items", []) != []):
                _deny()
            return replace(state, phase="streaming"), "turn_notice_bound"

        if phase == "streaming":
            if method == "turn/completed":
                turn = params.get("turn")
                if (params.get("threadId") != state.thread_id
                        or not isinstance(turn, Mapping)
                        or _ident(turn.get("id")) != state.turn_id
                        or turn.get("status") != "completed"):
                    _deny()
                return replace(state, phase="completed"), "untrusted_turn_completed"
            if method in ("item/started", "item/completed",
                          "item/agentMessage/delta"):
                if (params.get("threadId") != state.thread_id
                        or params.get("turnId") != state.turn_id
                        or state.item_notifications >= MAX_ITEM_NOTIFICATIONS):
                    _deny()
                return replace(
                    state, item_notifications=state.item_notifications + 1
                ), "untrusted_item_event"
        # Reject all unknown messages, server-initiated RPC requests,
        # compaction, fork, resume, steering, unsolicited extra turns,
        # out-of-order notification/response and duplicate replays.
        _deny()
    except Exception:
        _deny()


def cancel(state: ParentBinding) -> Tuple[ParentBinding, Optional[dict]]:
    """Immediately abandon local capture before any cancellation RPC result.

    Returning a synthetic request does not mean remote cancellation succeeded.
    A connection loss, restart, or late reply never restores this state.
    """
    if not isinstance(state, ParentBinding) or state.phase in (
        "completed", "abandoned"):
        _deny()
    request = None
    if state.thread_id and state.turn_id:
        request = {
            "id": INTERRUPT_REQUEST_ID,
            "method": "turn/interrupt",
            "params": {"threadId": state.thread_id, "turnId": state.turn_id},
        }
    return replace(state, phase="abandoned"), request


def disconnect(state: ParentBinding) -> ParentBinding:
    """All old IDs are permanently closed on a transport disconnect."""
    if not isinstance(state, ParentBinding):
        _deny()
    return replace(state, phase="abandoned")


def capture_admission(_state: Optional[ParentBinding] = None) -> dict:
    return {"status": "blocked", "reason": "no authenticated Codex issuer or complete source proof"}


def connect_real_host(_request=None) -> dict:
    # Even a patched flag cannot dispatch requests to a real Codex process.
    return {"status": "blocked", "reason": "real Codex request binding unadmitted"}
