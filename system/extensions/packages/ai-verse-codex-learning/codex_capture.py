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
import math
from pathlib import Path
import re
import stat
import time
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
        # The existing AI-Verse learning bridge can generate an artificial
        # Stop continuation that looks like UserPromptSubmit. It is NOT an
        # original human message, even if the hook delivers a prompt string.
        # Refuse the full prospective sequence instead of misattributing it.
        if "AI_VERSE_REVIEW_CONTINUATION" in value:
            raise CodexObservationBlocked("internal continuation is not visible user text")
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



@dataclass(frozen=True)
class OSCorrelation:
    """Read-only scope match, NOT authenticated host event provenance.

    No capability/authorization token is present or minted. This object
    cannot be used as proof for canonical archive writes.
    """

    session_id: str
    turn_id: str
    scope: str
    source_event_id: str
    status: str = "correlated_untrusted_hook_not_authorized"


def correlate_current_os_turn(
    bridge, event: Mapping, state: ProspectiveState,
    observation: HookTextObservation,
) -> OSCorrelation:
    """Cross-check a synthetic Codex hook field against *current* OS state.

    The existing Bridge is the source of physical-workspace and current-turn
    checks, not the event's claimed scope. A forged JSON hook can still pass
    these checks when executed by the same local user. NO historical/session
    issuer, consent proof, or full conversation coverage is created here.
    This function is NOT dispatched from Bridge.hook, nor wired to any writer.

    The bridge's per-session lock is held through all state and cancellation
    checks, and workspace status is read again on every invocation. A caller
    must discard an earlier correlation if any later operation takes place.
    """
    try:
        if (not isinstance(event, Mapping)
                or not isinstance(state, ProspectiveState)
                or not isinstance(observation, HookTextObservation)):
            raise CodexObservationBlocked("invalid binding input")
        if getattr(bridge, "harness", None) != "codex" or not bridge.registered():
            raise CodexObservationBlocked("OS Codex connection not active")
        session = _identity(event.get("session_id"), "session")
        cwd = _cwd(event.get("cwd"))
        turn_id = _identity(event.get("turn_id"), "turn")
        if (session != state.session_id or cwd != state.cwd
                or observation.session_id != session
                or observation.turn_id != turn_id):
            raise CodexObservationBlocked("session or turn identity mismatch")
        if (observation.sequence != state.next_sequence - 1
                or observation.source_event_id != _source_id(
                    session, turn_id, observation.source_field)):
            raise CodexObservationBlocked("observation identity is unbound")
        if observation.role == "user":
            if (event.get("hook_event_name") != "UserPromptSubmit"
                    or observation.source_field != "prompt"
                    or state.phase != "pending"
                    or state.pending_turn != turn_id):
                raise CodexObservationBlocked("prompt observation is not current")
        elif observation.role == "assistant":
            if (event.get("hook_event_name") != "Stop"
                    or observation.source_field != "last_assistant_message"
                    or event.get("stop_hook_active") is not False
                    or state.phase != "ready"
                    or state.previous_turn != turn_id):
                raise CodexObservationBlocked("assistant observation is not current")
        else:
            raise CodexObservationBlocked("unsupported observed role")

        text, text_sha = _text(event.get(observation.source_field),
                               observation.source_field)
        if (text != observation.text or text_sha != observation.text_sha256
                or event.get("permission_mode") not in
                ("default", "acceptEdits")):
            raise CodexObservationBlocked("event text or permission is unbound")

        # Resolve physical folder before the OS state lookup. No symlinks or
        # implicit cwd/manifest binding are allowed in this candidate path.
        root = Path(bridge.root).resolve(strict=True)
        physical = Path(cwd)
        if physical.resolve(strict=True) != physical:
            raise CodexObservationBlocked("physical working directory ambiguous")
        relative = physical.relative_to(root).parts
        current = root
        for part in relative:
            current = current / part
            mode = current.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise CodexObservationBlocked("unsafe physical working directory")
        if relative and relative[0] == "workspaces":
            if len(relative) < 2:
                raise CodexObservationBlocked("workspace root has no bound owner")
            workspace_id = relative[1]
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", workspace_id):
                raise CodexObservationBlocked("workspace owner invalid")
            selected = "workspace:" + workspace_id
        else:
            selected = "operator"

        with bridge.lock(session):
            bound = bridge.state(session)
            turn = bound.get("turn")
            if (bound.get("session_id") != session
                    or bound.get("scope") != selected
                    or not isinstance(turn, dict)
                    or turn.get("id") != turn_id
                    or turn.get("scope") != selected
                    or turn.get("allowed") != [selected]
                    or turn.get("ambiguous") != []
                    or turn.get("state") not in ("active", "review_requested")):
                raise CodexObservationBlocked("OS turn or scope does not match")
            created = turn.get("created")
            ttl = bridge.config.get("state_ttl_seconds")
            if (isinstance(created, bool)
                    or not isinstance(created, (int, float))
                    or not math.isfinite(created)
                    or type(ttl) is not int
                    or not 0 <= time.time() - created <= ttl):
                raise CodexObservationBlocked("OS turn freshness expired")
            if (turn.get("permission_mode") != event.get("permission_mode")
                    or turn.get("permission_mode") not in
                    ("default", "acceptEdits")
                    or bridge.cancelled(session, turn_id)):
                raise CodexObservationBlocked("OS turn permission or cancellation")
            if selected != "operator":
                details = bridge.manifest(selected.partition(":")[2])
                if details.get("status") != "active":
                    raise CodexObservationBlocked("workspace not active")
            if observation.role == "user":
                # Prompt is the only hook field for which the existing OS
                # bridge independently stored a same-turn field digest.
                if turn.get("prompt_hash") != text_sha:
                    raise CodexObservationBlocked("OS prompt does not match")
                sources = turn.get("sources")
                if (not isinstance(sources, dict)
                        or not isinstance(sources.get("user"), dict)
                        or sources["user"].get("sha256") != text_sha):
                    raise CodexObservationBlocked("OS user source not matched")
            else:
                # The current OS bridge has no authoritative assistant text
                # digest. This is correlation ONLY, never source attestation.
                if not isinstance(turn.get("prompt_hash"), str):
                    raise CodexObservationBlocked("OS original turn missing")
        return OSCorrelation(
            session_id=session, turn_id=turn_id, scope=selected,
            source_event_id=observation.source_event_id,
        )
    except Exception:
        # All failures are static: never leak user text, filesystem paths,
        # OS error messages, hook JSON, or private session identifiers.
        raise CodexObservationBlocked("OS hook correlation unavailable") from None


def capture_hook(_bridge, _event: Mapping) -> dict:
    """Production safety gate. No authenticated host issuer exists in 3A."""
    if not _HOST_EVENTS_ADMITTED or not _AT_TIME_SCOPE_ISSUER_ADMITTED:
        return {"status": "blocked", "reason": "codex host capture unadmitted"}
    # Even a test-patched gate is not an activation: there is deliberately
    # no persistence, writer, observer state or hook registration here.
    return {"status": "blocked", "reason": "codex scoped writer not implemented"}
