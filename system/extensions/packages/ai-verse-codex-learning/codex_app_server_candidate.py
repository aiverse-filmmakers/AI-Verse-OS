"""Synthetic-only Codex App Server v2 final-item coverage candidate.

This pure adapter is intentionally disconnected from the existing Codex
desktop hooks, App Server processes, installed OS Bridge, and archive writer.
The input JSON object is caller-controlled and does NOT authenticate an
App Server or establish source completeness. A future OS-owned stdio child
transport will need its own process/connection lifetime, consent and
at-event scope proof before the result could be considered for admission.

Documented schema: https://learn.chatgpt.com/docs/app-server
- turn/started and turn/completed delimit a turn.
- item/completed returns a final ThreadItem, unlike deltas.
- userMessage contains content; agentMessage has text, optional phase.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import re
from typing import Any, Mapping, Optional, Tuple

MAX_EVENTS = 512
MAX_MESSAGE_BYTES = 200_000
ITEM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
# Whitelisted non-chat items can never be used as original chat evidence.
NON_CHAT_ITEMS = frozenset((
    "plan", "reasoning", "commandExecution", "fileChange", "mcpToolCall",
    "dynamicToolCall", "collabToolCall", "webSearch", "imageView",
    "enteredReviewMode", "exitedReviewMode", "contextCompaction",
    "functionCallOutput",
))
# Never interpret any inbound JSON claim of "trusted", "signed", "scope",
# "consented", "private", "attested", or "authenticated" as transport proof.
_APP_SERVER_OWNED_TRANSPORT_ADMITTED = False


class CandidateBlocked(ValueError):
    """Static no-content error message."""


@dataclass(frozen=True)
class CandidateState:
    thread_id: str
    turn_id: str
    phase: str
    seen_ids: Tuple[str, ...] = ()
    user_text: Optional[str] = None
    assistant_text: Optional[str] = None
    user_item_id: Optional[str] = None
    assistant_item_id: Optional[str] = None
    other_items: int = 0
    event_count: int = 1


@dataclass(frozen=True)
class CandidateReport:
    """Not a record of trusted visibility, provenance, or consent."""

    thread_id: str
    turn_id: str
    user_item_id: str
    assistant_item_id: str
    user_sha256: str
    assistant_sha256: str
    other_item_count: int
    verdict: str = "untrusted_v2_candidate_not_archivable"
    complete_ui_coverage: bool = False
    authentic_host_origin: bool = False
    authenticated_scope: bool = False
    consent_verified: bool = False
    writer_admitted: bool = False


def _id(value: Any) -> str:
    if not isinstance(value, str) or not ITEM_ID.fullmatch(value):
        raise CandidateBlocked("invalid v2 source identity")
    return value


def _mapping(value: Any) -> Mapping:
    if not isinstance(value, Mapping):
        raise CandidateBlocked("invalid v2 event structure")
    return value


def _text(value: Any) -> str:
    if not isinstance(value, str):
        raise CandidateBlocked("v2 text missing")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError:
        raise CandidateBlocked("v2 text encoding invalid") from None
    if not encoded or len(encoded) > MAX_MESSAGE_BYTES:
        raise CandidateBlocked("v2 text outside size budget")
    return value


def _bound(event: Mapping, state: CandidateState) -> Mapping:
    params = _mapping(event.get("params"))
    if (_id(params.get("threadId")) != state.thread_id
            or _id(params.get("turnId")) != state.turn_id):
        raise CandidateBlocked("cross-thread or cross-turn v2 event")
    return params


def observe(
    state: Optional[CandidateState], event: Mapping
) -> Tuple[CandidateState, Optional[CandidateReport], str]:
    """Read-only synthetic state machine for precisely one prospective turn.

    A complete candidate is still UNSAFE for archiving. It does not prove
    omitted notifications, original process ownership, scope, consent, or
    user-visible completeness. Do not serialize state or messages.
    """
    event = _mapping(event)
    method = event.get("method")
    if not isinstance(method, str) or "id" in event:
        raise CandidateBlocked("invalid notification framing")
    if state is None:
        if method != "turn/started":
            raise CandidateBlocked("missing prospective v2 start")
        params = _mapping(event.get("params"))
        turn = _mapping(params.get("turn"))
        if turn.get("status") != "inProgress":
            raise CandidateBlocked("v2 turn never entered progress")
        if turn.get("items", []) != []:
            raise CandidateBlocked("v2 turn may have earlier items")
        tid = _id(params.get("threadId"))
        turn_id = _id(turn.get("id"))
        if params.get("turnId", turn_id) != turn_id:
            raise CandidateBlocked("v2 start identity conflict")
        return CandidateState(tid, turn_id, "in_progress"), None, "started"

    if state.phase != "in_progress" or state.event_count >= MAX_EVENTS:
        raise CandidateBlocked("v2 stream closed or budget exceeded")
    if method in ("turn/started", "thread/started", "thread/resumed",
                  "thread/forked", "thread/reverted", "turn/steered",
                  "turn/interrupt"):
        raise CandidateBlocked("ambiguous v2 session or turn boundary")
    if method in ("item/agentMessage/delta", "item/plan/delta",
                  "item/reasoning/summaryTextDelta",
                  "item/reasoning/textDelta",
                  "item/commandExecution/outputDelta"):
        _bound(event, state)
        # Never combine streamed fragments or treat them as final text.
        return replace(state, event_count=state.event_count + 1), None, "ignored_delta"
    if method == "item/started":
        _bound(event, state)
        return replace(state, event_count=state.event_count + 1), None, "ignored_started"
    if method == "item/completed":
        params = _bound(event, state)
        item = _mapping(params.get("item"))
        item_id = _id(item.get("id"))
        if item_id in state.seen_ids:
            raise CandidateBlocked("v2 item replay or collision")
        seen = state.seen_ids + (item_id,)
        kind = item.get("type")
        if kind == "userMessage":
            content = item.get("content")
            if (state.user_text is not None or not isinstance(content, list)
                    or len(content) != 1
                    or not isinstance(content[0], Mapping)
                    or content[0].get("type") != "text"):
                raise CandidateBlocked("v2 user input coverage ambiguous")
            text = _text(content[0].get("text"))
            result = replace(state, user_text=text, user_item_id=item_id,
                             seen_ids=seen, event_count=state.event_count + 1)
            return result, None, "user_candidate"
        if kind == "agentMessage":
            phase = item.get("phase")
            if phase != "final_answer" or state.assistant_text is not None:
                # Optional phase, partial answer and commentary are not a
                # certified final reply. Do not claim full rendered coverage.
                raise CandidateBlocked("v2 assistant visibility ambiguous")
            text = _text(item.get("text"))
            result = replace(state, assistant_text=text,
                             assistant_item_id=item_id, seen_ids=seen,
                             event_count=state.event_count + 1)
            return result, None, "assistant_candidate"
        if kind not in NON_CHAT_ITEMS:
            raise CandidateBlocked("unknown v2 item could contain visible text")
        result = replace(state, other_items=state.other_items + 1,
                         seen_ids=seen, event_count=state.event_count + 1)
        return result, None, "ignored_nonchat"

    if method == "turn/completed":
        params = _mapping(event.get("params"))
        turn = _mapping(params.get("turn"))
        if (_id(params.get("threadId")) != state.thread_id
                or _id(turn.get("id")) != state.turn_id
                or turn.get("status") != "completed"
                or state.user_text is None or state.assistant_text is None):
            raise CandidateBlocked("v2 turn not complete or source missing")
        if params.get("turnId", state.turn_id) != state.turn_id:
            raise CandidateBlocked("v2 completion identity conflict")
        report = CandidateReport(
            thread_id=state.thread_id, turn_id=state.turn_id,
            user_item_id=state.user_item_id,
            assistant_item_id=state.assistant_item_id,
            user_sha256=hashlib.sha256(state.user_text.encode("utf-8")).hexdigest(),
            assistant_sha256=hashlib.sha256(
                state.assistant_text.encode("utf-8")
            ).hexdigest(),
            other_item_count=state.other_items,
        )
        return replace(state, phase="closed", event_count=state.event_count + 1), report, "untrusted_candidate"

    raise CandidateBlocked("unsupported v2 lifecycle event")


def archive_admission(_candidate: CandidateReport) -> dict:
    """No caller/JSON assertions can open a writer or mint host provenance."""
    return {
        "status": "blocked",
        "reason": "OS-owned App Server transport, consent and scope issuer unverified",
    }
