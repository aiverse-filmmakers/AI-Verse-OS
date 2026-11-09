"""3A.7: exact received JSONL source evidence candidate, NOT a v1 archive.

Codex App Server v2 is a versioned stream of JSON-RPC notifications. A
decoded dictionary, reconstructed JSON, or current workspace does NOT prove
original provider/host bytes, durable source offsets, scope, consent, or
complete rendered UI visibility.

This pure module accepts only exact newline-terminated UTF-8 *fixture*
frames. It fingerprints the original caller-supplied wire bytes and maps
a narrow, successful, text-only turn. It never reads a real transcript,
launches Codex, imports past threads, writes any file, mints provenance,
or generates synthetic coordinates for the existing OS v1 writer.

A future authenticated transport must hand off the exact raw bytes BEFORE
JSON decoding, independently prove their source and at-event scope, and
either provide genuine v1 coordinates or use a separately reviewed v2
archive format. Passing these fixture checks grants NO authorization.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import re
from typing import Any, Mapping, Optional, Sequence, Tuple

SCHEMA = "ai-verse.codex-app-server-source-candidate/v1"
MAX_FRAMES = 128
MAX_FRAME_BYTES = 65_536
MAX_TOTAL_WIRE_BYTES = 2_000_000
MAX_TEXT_BYTES = 200_000
IDENTITY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
NON_CHAT_ITEMS = frozenset((
    "plan", "reasoning", "commandExecution", "fileChange", "mcpToolCall",
    "dynamicToolCall", "collabToolCall", "webSearch", "imageView",
    "enteredReviewMode", "exitedReviewMode", "contextCompaction",
    "functionCallOutput",
))
DELTA_METHODS = frozenset((
    "item/agentMessage/delta", "item/plan/delta",
    "item/reasoning/summaryTextDelta", "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
))
# This is a nonadmitted contract. A flag cannot turn it into a writer.
_PRODUCTION_SOURCE_EVIDENCE_ADMITTED = False


class SourceEvidenceBlocked(ValueError):
    """All errors are static and contain no private frame, path or text."""


def _deny(reason: str = "untrusted App Server source evidence refused") -> None:
    raise SourceEvidenceBlocked(reason)


def _id(value: Any) -> str:
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        _deny()
    return value


def _map(value: Any) -> Mapping:
    if not isinstance(value, dict):
        _deny()
    return value


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _deny()
        result[key] = value
    return result


def _bad_constant(_value):
    _deny()


def _decode_exact_record(wire: bytes) -> dict:
    # No conversion from a dict, JSON dump, recovered partial line, or
    # guessed source offset is accepted. Retain the wire verbatim.
    if (type(wire) is not bytes or len(wire) < 3
            or len(wire) > MAX_FRAME_BYTES or not wire.endswith(b"\n")
            or b"\n" in wire[:-1] or b"\r" in wire):
        _deny()
    try:
        text = wire[:-1].decode("utf-8", errors="strict")
        decoded = json.loads(
            text, object_pairs_hook=_unique_pairs,
            parse_constant=_bad_constant,
        )
        value = _map(decoded)
        if ("id" in value or "error" in value
                or ("jsonrpc" in value and value["jsonrpc"] != "2.0")
                or not isinstance(value.get("method"), str)
                or not isinstance(value.get("params"), dict)):
            _deny()
        return value
    except SourceEvidenceBlocked:
        raise
    except (ValueError, TypeError, UnicodeError):
        _deny()


def _text(value: Any) -> Tuple[str, str]:
    if not isinstance(value, str):
        _deny()
    try:
        raw = value.encode("utf-8", errors="strict")
    except UnicodeError:
        _deny()
    if not raw or len(raw) > MAX_TEXT_BYTES:
        _deny()
    return value, hashlib.sha256(raw).hexdigest()


@dataclass(frozen=True)
class ItemSourceWitness:
    role: str
    item_id: str
    text_sha256: str
    wire_sha256: str
    wire_byte_length: int
    observed_frame_index: int
    # No original byte offsets exist in this App Server contract.
    original_byte_offset: None = None
    original_end_offset: None = None
    original_provider_record_verified: bool = False
    text: str = field(default="", repr=False)
    exact_received_wire: bytes = field(default=b"", repr=False)


@dataclass(frozen=True)
class SourceEvidenceCandidate:
    thread_id: str
    turn_id: str
    messages: Tuple[ItemSourceWitness, ItemSourceWitness] = field(repr=False)
    observed_frame_sha256: Tuple[str, ...] = ()
    observed_stream_sha256: str = ""
    observed_wire_bytes: int = 0
    ignored_nonchat_items: int = 0
    ignored_delta_frames: int = 0
    schema: str = SCHEMA
    verdict: str = "exact_supplied_wire_untrusted_not_archivable"
    original_provider_bytes_authenticated: bool = False
    original_byte_offsets_available: bool = False
    pinned_host_schema_verified: bool = False
    physical_scope_authenticated: bool = False
    consent_issued: bool = False
    complete_ui_coverage: bool = False
    writer_admitted: bool = False


def evaluate_exact_fixture_frames(
    frames: Sequence[bytes], *, expected_thread: str, expected_turn: str,
) -> SourceEvidenceCandidate:
    """Verify a narrow candidate using only exact supplied JSONL records.

    No real host origin is asserted. A caller can fabricate these bytes.
    Exact bytes are preserved in memory for future format review only,
    never written to an archive or exposed by repr/error strings.
    """
    tid = _id(expected_thread)
    turn_id = _id(expected_turn)
    if (not isinstance(frames, (tuple, list))
            or not 4 <= len(frames) <= MAX_FRAMES):
        _deny()
    seen_ids = set()
    started_items: dict[str, tuple[str, int]] = {}
    completed_items = set()
    messages = []
    records = []
    wire_total = 0
    nonchat = 0
    deltas = 0
    stream_sha = hashlib.sha256()
    phase = "before_start"
    for index, wire in enumerate(frames):
        event = _decode_exact_record(wire)
        wire_total += len(wire)
        if wire_total > MAX_TOTAL_WIRE_BYTES:
            _deny()
        stream_sha.update(wire)
        records.append(hashlib.sha256(wire).hexdigest())
        method = event["method"]
        params = _map(event["params"])
        if phase == "before_start":
            if method != "turn/started":
                _deny()
            turn = _map(params.get("turn"))
            if (_id(params.get("threadId")) != tid
                    or _id(turn.get("id")) != turn_id
                    or turn.get("status") != "inProgress"
                    or turn.get("items") != []
                    or params.get("turnId", turn_id) != turn_id):
                _deny()
            phase = "streaming"
            continue
        if phase != "streaming":
            _deny()
        if method == "turn/completed":
            turn = _map(params.get("turn"))
            if (index != len(frames) - 1
                    or _id(params.get("threadId")) != tid
                    or _id(turn.get("id")) != turn_id
                    or params.get("turnId", turn_id) != turn_id
                    or turn.get("status") != "completed"
                    or started_items - completed_items
                    or len(messages) != 2
                    or [x.role for x in messages] != ["user", "assistant"]):
                _deny()
            phase = "closed"
            continue
        if (_id(params.get("threadId")) != tid
                or _id(params.get("turnId")) != turn_id):
            _deny()
        if method in DELTA_METHODS:
            # Official stable v2 deltas have an itemId and are always
            # associated with a started item of the matching kind.
            # Without that association a missing or foreign item might be
            # silently treated as non-chat context. This is a deliberately
            # narrow fixture, not a full UI or source completeness claim.
            expected_kind = {
                "item/agentMessage/delta": "agentMessage",
                "item/plan/delta": "plan",
                "item/reasoning/summaryTextDelta": "reasoning",
                "item/reasoning/textDelta": "reasoning",
                "item/commandExecution/outputDelta": "commandExecution",
            }.get(method)
            item_id = _id(params.get("itemId"))
            delta = params.get("delta")
            if (expected_kind is None or item_id not in started_items
                    or item_id in completed_items
                    or started_items[item_id][0] != expected_kind
                    or not isinstance(delta, str)
                    or len(delta.encode("utf-8", "strict")) > MAX_TEXT_BYTES):
                _deny()
            if method == "item/reasoning/summaryTextDelta":
                idx = params.get("summaryIndex")
                if type(idx) is not int or not 0 <= idx <= 1000:
                    _deny()
            if method == "item/reasoning/textDelta":
                idx = params.get("contentIndex")
                if type(idx) is not int or not 0 <= idx <= 1000:
                    _deny()
            deltas += 1
            continue
        if method == "item/started":
            stamp = params.get("startedAtMs")
            if type(stamp) is not int or not 0 <= stamp <= (1 << 63) - 1:
                _deny()
            item = _map(params.get("item"))
            item_id = _id(item.get("id"))
            if item_id in started_items or item_id in completed_items:
                _deny()
            if item.get("type") not in (
                    "userMessage", "agentMessage", *NON_CHAT_ITEMS):
                _deny()
            started_items[item_id] = (item.get("type"), stamp)
            continue
        if method != "item/completed":
            _deny()
        stamp = params.get("completedAtMs")
        if type(stamp) is not int or not 0 <= stamp <= (1 << 63) - 1:
            _deny()
        item = _map(params.get("item"))
        item_id = _id(item.get("id"))
        if item_id in seen_ids:
            _deny()
        seen_ids.add(item_id)
        completed_items.add(item_id)
        kind = item.get("type")
        if item_id in started_items:
            started_kind, started_clock = started_items[item_id]
            if kind != started_kind or stamp < started_clock:
                _deny()
        if kind in NON_CHAT_ITEMS:
            nonchat += 1
            continue
        if kind == "userMessage":
            content = item.get("content")
            if (messages or not isinstance(content, list)
                    or len(content) != 1
                    or not isinstance(content[0], dict)
                    or content[0].get("type") != "text"):
                _deny()
            value, text_sha = _text(content[0].get("text"))
            role = "user"
        elif kind == "agentMessage":
            if (len(messages) != 1 or messages[0].role != "user"
                    or item.get("phase") != "final_answer"):
                _deny()
            value, text_sha = _text(item.get("text"))
            role = "assistant"
        else:
            _deny()
        messages.append(ItemSourceWitness(
            role=role,
            item_id=item_id,
            text_sha256=text_sha,
            wire_sha256=records[-1],
            wire_byte_length=len(wire),
            observed_frame_index=index,
            text=value,
            exact_received_wire=wire,
        ))
    if phase != "closed":
        _deny()
    return SourceEvidenceCandidate(
        thread_id=tid,
        turn_id=turn_id,
        messages=(messages[0], messages[1]),
        observed_frame_sha256=tuple(records),
        observed_stream_sha256=stream_sha.hexdigest(),
        observed_wire_bytes=wire_total,
        ignored_nonchat_items=nonchat,
        ignored_delta_frames=deltas,
    )


def convert_to_v1_archive(_candidate: SourceEvidenceCandidate) -> dict:
    """NEVER invent original-source byte coordinates or a scope issuer."""
    return {
        "status": "blocked",
        "reason": "v1 requires authenticated source offsets and host attribution",
    }


def source_admission(_candidate: SourceEvidenceCandidate) -> dict:
    """No synthetic fixture can authenticate a source or permit a write."""
    return {"status": "blocked", "reason": "source evidence candidate is not authorized"}
