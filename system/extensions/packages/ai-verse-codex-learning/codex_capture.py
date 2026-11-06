"""Prospective Codex hook-field observation contract. Not admitted for capture.

Codex publishes UserPromptSubmit.prompt and Stop.last_assistant_message,
but explicitly does not guarantee transcript_path's file format. This
module NEVER opens transcript_path, discovers chat files, writes archives,
or registers hooks. Normalized observations exist only transiently in
synthetic fixtures. Neither a hook JSON payload nor a SessionStart event
is proof of authenticated at-time scope, consent, host coverage, or full
chat/UI visibility.

Real OS archive writes remain blocked pending an independently reviewed
authenticated host issuer, explicit private-session policy, source
coverage verification, and owner-scoped write authorization.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
from typing import Mapping, Optional, Tuple

# Not a config switch. This module has NO admitted writer/issuer or installer.
_HOST_EVENTS_ADMITTED = False
_AT_TIME_SCOPE_ISSUER_ADMITTED = False
MAX_TEXT_BYTES = 200_000
MAX_TURN_PAIRS = 20_000
IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
SUPPORTED_PERMISSIONS = frozenset(
    ("default", "acceptEdits", "plan", "dontAsk")
)


class CodexObservationBlocked(ValueError):
    """Static error text only: no event payloads, paths or private text."""


@dataclass(frozen=True)
class ProspectiveState:
    """Transient synthetic-only order state, NOT provenance or a cursor."""

    session_id: str
    cwd: str
    phase: str
    next_sequence: int
    pending_turn: Optional[str] = None
    pending_prompt_sha256: Optional[str] = None
    previous_turn: Optional[str] = None
    previous_assistant_sha256: Optional[str] = None


@dataclass(frozen=True)
class HookTextObservation:
    """Transient field-exact snippet, never a claim of complete transcript."""

    session_id: str
    turn_id: str
    sequence: int
    role: str
    source_field: str
    source_event_id: str
    text_sha256: str
    text: str
    coverage: str = "one_codex_hook_field_not_full_transcript"


def _identity(value, label: str) -> str:
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise CodexObservationBlocked("invalid " + label)
    return value


def _cwd(value) -> str:
    if not isinstance(value, str) or "\x00" in value:
        raise CodexObservationBlocked("invalid physical cwd")
    path = Path(value)
    # pathlib normalizes "/./" and repeated separators, so inspect the raw
    # components BEFORE that normalization. A changed physical binding must
    # never be hidden by a lexical rewrite.
    if (not path.is_absolute() or str(path) != value
            or any(part in (".", "..") for part in re.split(r"[\\/]", value))):
        raise CodexObservationBlocked("invalid physical cwd")
    # Lexical validation only. Host/OS authority must establish the physical
    # workspace and reject symlinks separately at event observation time.
    return value


def _text(value, field: str) -> Tuple[str, str]:
    if not isinstance(value, str):
        raise CodexObservationBlocked("missing or invalid " + field)
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise CodexObservationBlocked("non-Unicode host text") from None
    if not encoded or len(encoded) > MAX_TEXT_BYTES:
        raise CodexObservationBlocked("host text outside byte budget")
    return value, hashlib.sha256(encoded).hexdigest()


def _source_id(session: str, turn: str, field: str) -> str:
    return hashlib.sha256(
        (session + "\x00" + turn + "\x00" + field).encode("utf-8")
    ).hexdigest()


def _observation(state, turn, role, field, text, text_sha):
    return HookTextObservation(
        session_id=state.session_id,
        turn_id=turn,
        sequence=state.next_sequence,
        role=role,
        source_field=field,
        source_event_id=_source_id(state.session_id, turn, field),
        text_sha256=text_sha,
        text=text,
    )


def observe(
    state: Optional[ProspectiveState], event: Mapping
) -> Tuple[ProspectiveState, Optional[HookTextObservation], str]:
    """Synthetic-only prospective state machine, pure and filesystem-free.

    No data from earlier turns is imported. Only a *candidate* startup
    boundary can initialize a new state. Source fields are not authentication:
    callers MUST NOT persist observations or treat this function as an issuer.
    On any exception, fail closed and discard the entire state.
    """
    if not isinstance(event, Mapping):
        raise CodexObservationBlocked("invalid hook event")
    session = _identity(event.get("session_id"), "session")
    cwd = _cwd(event.get("cwd"))
    kind = event.get("hook_event_name")
    if kind == "SessionStart":
        if state is not None:
            raise CodexObservationBlocked("duplicate or ambiguous session boundary")
        if event.get("source") != "startup":
            # Resume, fork, compact and clear do not certify the source has
            # no older/unattributed records. No retroactive history import.
            raise CodexObservationBlocked("session lacks fresh startup boundary")
        return ProspectiveState(session, cwd, "ready", 1), None, "candidate_boundary"

    if state is None or state.phase == "closed":
        raise CodexObservationBlocked("no open prospective session boundary")
    if session != state.session_id or cwd != state.cwd:
        raise CodexObservationBlocked("session or cwd changed")
    if state.next_sequence > 2 * MAX_TURN_PAIRS:
        raise CodexObservationBlocked("prospective sequence budget exceeded")

    if kind in ("Interrupt", "SessionEnd"):
        # An interrupted or ended session cannot silently resume a pending
        # record. A fresh, independently verified boundary is required.
        turn = event.get("turn_id")
        if kind == "Interrupt" and state.pending_turn is not None:
            if turn != state.pending_turn:
                raise CodexObservationBlocked("interrupt turn mismatch")
        return ProspectiveState(
            session, cwd, "closed", state.next_sequence
        ), None, "closed"

    if kind == "PostToolUse":
        # The hook may contain tools, reasoning or file results. They are
        # NEVER visible-chat evidence. This branch reads none of that data.
        return state, None, "ignored_tool"

    if kind == "UserPromptSubmit":
        if event.get("permission_mode") not in SUPPORTED_PERMISSIONS:
            raise CodexObservationBlocked("unverified permission mode")
        turn = _identity(event.get("turn_id"), "turn")
        value, digest = _text(event.get("prompt"), "prompt")
        if state.phase == "pending":
            if turn == state.pending_turn and digest == state.pending_prompt_sha256:
                return state, None, "replayed_prompt"
            raise CodexObservationBlocked("overlapping or changed prompt")
        if turn == state.previous_turn:
            raise CodexObservationBlocked("old turn was reintroduced")
        if state.phase != "ready":
            raise CodexObservationBlocked("session state not ready for prompt")
        observation = _observation(state, turn, "user", "prompt", value, digest)
        next_state = ProspectiveState(
            session, cwd, "pending", state.next_sequence + 1,
            pending_turn=turn, pending_prompt_sha256=digest,
            previous_turn=state.previous_turn,
            previous_assistant_sha256=state.previous_assistant_sha256,
        )
        return next_state, observation, "observed"

    if kind == "Stop":
        if event.get("stop_hook_active") is not False:
            raise CodexObservationBlocked("stop continuation state unverified")
        turn = _identity(event.get("turn_id"), "turn")
        value, digest = _text(event.get("last_assistant_message"),
                              "last assistant message")
        if state.phase == "ready" and turn == state.previous_turn:
            if digest == state.previous_assistant_sha256:
                return state, None, "replayed_stop"
            raise CodexObservationBlocked("past assistant text changed")
        if state.phase != "pending" or turn != state.pending_turn:
            raise CodexObservationBlocked("stop has no bound current prompt")
        observation = _observation(
            state, turn, "assistant", "last_assistant_message", value, digest
        )
        next_state = ProspectiveState(
            session, cwd, "ready", state.next_sequence + 1,
            previous_turn=turn, previous_assistant_sha256=digest,
        )
        return next_state, observation, "observed"

    # Neither arbitrary host fields nor tool/subagent/model payloads are
    # eligible visible conversation observations.
    return state, None, "ignored_unverified_event"


def capture_hook(_bridge, _event: Mapping) -> dict:
    """Production safety gate. No authenticated host issuer exists in 3A."""
    if not _HOST_EVENTS_ADMITTED or not _AT_TIME_SCOPE_ISSUER_ADMITTED:
        return {"status": "blocked", "reason": "codex host capture unadmitted"}
    # Even a test-patched gate is not an activation: there is deliberately
    # no persistence, writer, observer state or hook registration here.
    return {"status": "blocked", "reason": "codex scoped writer not implemented"}
