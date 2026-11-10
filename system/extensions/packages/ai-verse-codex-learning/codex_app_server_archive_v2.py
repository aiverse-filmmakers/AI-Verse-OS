"""3A.8 fixture-only versioned Codex received-wire archive envelope.

This is deliberately NOT the v1 original-provider-source archive. App
Server notification bytes are only exact RECEIVED pipe bytes, not original
provider transcript bytes or a cryptographically authenticated host stream.
The envelope never asserts origin, consent, private-session permission,
scope authority or full-UI coverage. It is encoded ONLY in memory and
no production code calls it. The corresponding isolated Memory v2
decoder must validate this format independently before displaying any
synthetic text. No filesystem operations, archive path or install hooks.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any, Sequence

SCHEMA = "ai-verse.chat-archive-codex-received/v2"
EVIDENCE_SCHEMA = "ai-verse.codex-app-server-source-candidate/v1"
MAX_FRAMES = 128
MAX_FRAME_BYTES = 65536
MAX_TOTAL_WIRE_BYTES = 2_000_000
MAX_ARCHIVE_BYTES = 6_000_000
MAX_ROW_BYTES = 100_000
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SAFE_SCOPE = re.compile(r"^(operator|workspace:[a-z0-9][a-z0-9-]{0,127})$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_RECORDING_ENABLED = False


class V2FixtureBlocked(ValueError):
    """Never echo private source bytes, identifiers or paths."""


def _deny():
    raise V2FixtureBlocked("unverified v2 fixture envelope refused")


def _id(value):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value):
        _deny()
    return value


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _line(record: dict) -> bytes:
    try:
        raw = json.dumps(
            record, sort_keys=True, ensure_ascii=False, allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8", "strict") + b"\n"
    except (TypeError, ValueError, UnicodeError):
        _deny()
    if len(raw) > MAX_ROW_BYTES:
        _deny()
    return raw


def create_synthetic_envelope(
    candidate: Any, exact_frames: Sequence[bytes],
    *, archive_id: str, scope: str,
) -> bytes:
    """Turn only an already-validated 3A.7 fixture into a sealed v2 blob.

    No v1 source offsets or provider-authentication claims are invented.
    The candidate's reported stream/frame hashes are checked against
    exact source-wire bytes, not reconstructed JSON.
    """
    try:
        _id(archive_id)
        if not isinstance(scope, str) or not SAFE_SCOPE.fullmatch(scope):
            _deny()
        if (getattr(candidate, "schema", None) != EVIDENCE_SCHEMA
                or getattr(candidate, "verdict", None) !=
                "exact_supplied_wire_untrusted_not_archivable"):
            _deny()
        for field in (
            "writer_admitted", "original_provider_bytes_authenticated",
            "original_byte_offsets_available", "pinned_host_schema_verified",
            "physical_scope_authenticated", "consent_issued",
            "complete_ui_coverage",
        ):
            if getattr(candidate, field, None) is not False:
                _deny()
        thread = _id(candidate.thread_id)
        turn = _id(candidate.turn_id)
        if (not isinstance(exact_frames, (list, tuple))
                or not 4 <= len(exact_frames) <= MAX_FRAMES
                or len(candidate.observed_frame_sha256) != len(exact_frames)
                or len(candidate.messages) != 2
                or [m.role for m in candidate.messages] != ["user", "assistant"]):
            _deny()
        raw_joined = bytearray()
        for idx, raw in enumerate(exact_frames):
            if (type(raw) is not bytes or not 3 <= len(raw) <= MAX_FRAME_BYTES
                    or not raw.endswith(b"\n")
                    or candidate.observed_frame_sha256[idx] != _sha(raw)):
                _deny()
            raw_joined.extend(raw)
            if len(raw_joined) > MAX_TOTAL_WIRE_BYTES:
                _deny()
        if (_sha(raw_joined) != candidate.observed_stream_sha256
                or len(raw_joined) != candidate.observed_wire_bytes):
            _deny()
        summary = []
        indexes = set()
        for witness in candidate.messages:
            i = witness.observed_frame_index
            if (type(i) is not int or i <= 0 or i >= len(exact_frames)-1
                    or i in indexes or type(witness.exact_received_wire) is not bytes
                    or witness.exact_received_wire != exact_frames[i]
                    or witness.wire_sha256 != _sha(exact_frames[i])
                    or witness.wire_byte_length != len(exact_frames[i])
                    or not isinstance(witness.text_sha256, str)
                    or not _SHA.fullmatch(witness.text_sha256)
                    or not isinstance(witness.text, str)
                    or _sha(witness.text.encode("utf-8")) != witness.text_sha256):
                _deny()
            indexes.add(i)
            summary.append({
                "role": witness.role,
                "item_id": _id(witness.item_id),
                "frame_index": i,
                "text_sha256": witness.text_sha256,
            })
        if summary[0]["frame_index"] >= summary[1]["frame_index"]:
            _deny()

        header = {
            "kind": "header", "schema": SCHEMA, "archive_id": archive_id,
            "scope": scope, "origin": "codex-app-server-received",
            "thread_id": thread, "turn_id": turn,
            "mode": "synthetic_fixture_only",
            "source_class": "exact_received_jsonl_unverified",
            "host_origin_authenticated": False,
            "scope_authenticated": False, "consent_verified": False,
            "complete_ui_coverage": False, "write_admitted": False,
        }
        lines = [_line(header)]
        chain = hashlib.sha256(lines[0]).digest()
        for i, wire in enumerate(exact_frames):
            chain = hashlib.sha256(chain + wire).digest()
            lines.append(_line({
                "kind": "frame", "schema": SCHEMA,
                "index": i,
                "wire_b64": base64.b64encode(wire).decode("ascii"),
                "wire_byte_length": len(wire),
                "wire_sha256": _sha(wire),
                "chain_sha256": chain.hex(),
            }))
        lines.append(_line({
            "kind": "seal", "schema": SCHEMA,
            "frame_count": len(exact_frames),
            "total_received_bytes": len(raw_joined),
            "received_stream_sha256": candidate.observed_stream_sha256,
            "last_chain_sha256": chain.hex(),
            "messages": summary,
            "original_source_offsets": None,
            "host_origin_authenticated": False,
            "scope_authenticated": False,
            "consent_verified": False,
            "complete_ui_coverage": False,
            "write_admitted": False,
        }))
        blob = b"".join(lines)
        if len(blob) > MAX_ARCHIVE_BYTES:
            _deny()
        return blob
    except V2FixtureBlocked:
        raise
    except (AttributeError, IndexError, TypeError, ValueError, UnicodeError):
        _deny()


def admission(_envelope: bytes = b"") -> dict:
    return {"status": "blocked", "reason": "synthetic v2 envelope not a trusted archive"}


def save_real_chat(_envelope: bytes = b"") -> dict:
    # No production persistence path, even with test-patched flag.
    return {"status": "blocked", "reason": "authenticated host and v2 archive writer absent"}
