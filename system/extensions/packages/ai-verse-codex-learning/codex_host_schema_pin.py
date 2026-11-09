"""3A.9: pinned upstream Codex App Server v2 schema compatibility gate.

This is a TEST-ONLY, read-only schema preflight, not a real Codex launch
and not proof that the executable matches any upstream source commit.
Every production archive/consent/origin authorization remains blocked.

Pinned upstream source:
  https://github.com/openai/codex/commit/e54a5713caf331f42a6eef0166186df5f7563c29
Generated source schemas are read only from a test-supplied checkout in CI.
Their Git blob SHA-1 IDs must match the immutable upstream objects; do
not silently accept a newer moving main or fabricate a host version.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import stat
from typing import Mapping

UPSTREAM_REPO = "openai/codex"
UPSTREAM_COMMIT = "e54a5713caf331f42a6eef0166186df5f7563c29"
UPSTREAM_RELATIVE = "codex-rs/app-server-protocol/schema/json/v2"
SCHEMA_BLOBS = {
    "ThreadStartParams": "5164caf6a208e4e0aa1d21baff108df8430c9d54",
    "ThreadStartResponse": "7d24279f2d160c7edb4a0fbabb61e0c484b449f1",
    "TurnStartParams": "d299d318ded151f436f19eb6445f47fedeae2867",
    "TurnStartResponse": "896122af667ecc0179c645682f7d5ded3018764b",
    "ItemCompletedNotification": "18590c6053667f251c19ad333c8a54ac57d6066a",
    "TurnCompletedNotification": "081f54cbb69d2759b0f7bb2f12394e2869533aeb",
}
UPSTREAM_ITEM_VARIANTS = 19
CURRENT_REQUIRED_ITEM_COMPLETION = frozenset(
    ("completedAtMs", "item", "threadId", "turnId")
)
USER_INPUT_KINDS = frozenset((
    "text", "image", "localImage", "audio", "localAudio",
    "skill", "mention",
))
ASSISTANT_PHASES = frozenset((
    "commentary", "partial_answer", "final_answer",
))
MAX_SCHEMA_FILE_BYTES = 160_000
MAX_ITEM_TEXT_BYTES = 200_000
_SHA1 = re.compile(r"^[0-9a-f]{40}$")

# No flag in this module is a license to record real host data.
_REAL_HOST_RUNTIME_ATTESTED = False
_OS_CONSENT_ISSUER_ATTESTED = False
_AT_EVENT_SCOPE_ISSUER_ATTESTED = False
_COMPLETE_UI_COVERAGE_ATTESTED = False


class HostSchemaBlocked(ValueError):
    """Static diagnostic with no schema payload or personal content."""


def _deny():
    raise HostSchemaBlocked("pinned Codex App Server host schema not admitted")


@dataclass(frozen=True)
class HostSchemaSnapshot:
    upstream_commit: str
    schema_blob_ids: tuple[tuple[str, str], ...]
    item_variants: tuple[str, ...]
    user_input_variants: tuple[str, ...]
    required_item_completion: tuple[str, ...]
    status: str = "upstream_source_schemas_pinned_runtime_unverified"
    runtime_executable_attested: bool = False
    source_stream_authenticated: bool = False
    os_consent_authorized: bool = False
    at_event_scope_authorized: bool = False
    full_ui_coverage_verified: bool = False
    archive_writes_admitted: bool = False


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _deny()
        result[key] = value
    return result


def _load(schema_dir: Path, name: str) -> dict:
    if name not in SCHEMA_BLOBS:
        _deny()
    try:
        path = schema_dir / (name + ".json")
        if not schema_dir.is_absolute() or schema_dir.is_symlink():
            _deny()
        if schema_dir.resolve(strict=True) != schema_dir:
            _deny()
        if path.is_symlink():
            _deny()
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode)
                or not 1 <= info.st_size <= MAX_SCHEMA_FILE_BYTES):
            _deny()
        raw = path.read_bytes()
        if len(raw) != info.st_size:
            _deny()
        # Standard Git blob object ID, not a cryptographic signature.
        object_bytes = b"blob " + str(len(raw)).encode("ascii") + b"\x00" + raw
        blob_id = hashlib.sha1(object_bytes).hexdigest()
        if blob_id != SCHEMA_BLOBS[name]:
            _deny()
        value = json.loads(raw.decode("utf-8", "strict"),
                           object_pairs_hook=_unique)
        if not isinstance(value, dict):
            _deny()
        return value
    except HostSchemaBlocked:
        raise
    except (OSError, UnicodeError, ValueError, TypeError, RecursionError):
        _deny()


def _variants(schema: Mapping, definition: str) -> tuple[str, ...]:
    try:
        entries = schema["definitions"][definition]["oneOf"]
        variants = tuple(
            part["properties"]["type"]["enum"][0] for part in entries
        )
        if len(variants) != len(set(variants)):
            _deny()
        return variants
    except (KeyError, IndexError, TypeError, ValueError):
        _deny()


def verify_upstream_schema_checkout(schema_dir: Path) -> HostSchemaSnapshot:
    """Verify generated upstream schema artifacts at an immutable source pin.

    The trusted CI job must ALSO check the upstream git checkout HEAD is
    exactly UPSTREAM_COMMIT. Reading schema files is not runtime attestation.
    """
    if not isinstance(schema_dir, Path):
        _deny()
    schemas = {name: _load(schema_dir, name) for name in SCHEMA_BLOBS}
    thread_request = schemas["ThreadStartParams"]
    thread_reply = schemas["ThreadStartResponse"]
    turn_request = schemas["TurnStartParams"]
    turn_reply = schemas["TurnStartResponse"]
    complete = schemas["ItemCompletedNotification"]
    turn_complete = schemas["TurnCompletedNotification"]
    items = _variants(complete, "ThreadItem")
    inputs = _variants(complete, "UserInput")
    phases = complete.get("definitions", {}).get("MessagePhase", {}).get("oneOf")
    declared_phases = tuple(
        element.get("enum", [None])[0] for element in phases or []
    )
    if (not {"cwd", "sandbox", "approvalPolicy"} <= set(thread_request.get("properties", {}))
            or not {"thread", "cwd"} <= set(thread_reply.get("properties", {}))
            or not {"threadId", "input"} <= set(turn_request.get("required", []))
            or "turn" not in turn_reply.get("required", [])
            or not CURRENT_REQUIRED_ITEM_COMPLETION <= set(complete.get("required", []))
            or not {"threadId", "turn"} <= set(turn_complete.get("required", []))
            or len(items) != UPSTREAM_ITEM_VARIANTS
            or not {"userMessage", "agentMessage"} <= set(items)
            or set(inputs) != USER_INPUT_KINDS
            or set(declared_phases) != ASSISTANT_PHASES):
        _deny()
    return HostSchemaSnapshot(
        upstream_commit=UPSTREAM_COMMIT,
        schema_blob_ids=tuple(sorted(SCHEMA_BLOBS.items())),
        item_variants=tuple(items),
        user_input_variants=tuple(inputs),
        required_item_completion=tuple(sorted(CURRENT_REQUIRED_ITEM_COMPLETION)),
    )


def validate_synthetic_completion_shape(event: Mapping) -> dict:
    """Check the CURRENT pinned protocol shape, not authenticity or consent.

    Earlier 3A.7/3A.8 test-only notifications without completedAtMs MUST
    fail. This does not ingest real host content, and it cannot mint an
    archive record. Only one text-only item is recognized, not full UI.
    """
    if not isinstance(event, Mapping) or event.get("method") != "item/completed":
        _deny()
    if "id" in event or ("jsonrpc" in event and event["jsonrpc"] != "2.0"):
        _deny()
    params = event.get("params")
    if not isinstance(params, dict):
        _deny()
    if not CURRENT_REQUIRED_ITEM_COMPLETION <= set(params):
        _deny()
    stamp = params.get("completedAtMs")
    if type(stamp) is not int or stamp < 0 or stamp > (1 << 63) - 1:
        _deny()
    for key in ("threadId", "turnId"):
        value = params.get(key)
        if not isinstance(value, str) or not 1 <= len(value) <= 128:
            _deny()
    item = params.get("item")
    if not isinstance(item, dict) or not isinstance(item.get("id"), str):
        _deny()
    kind = item.get("type")
    if kind == "userMessage":
        content = item.get("content")
        if (not isinstance(content, list) or len(content) != 1
                or not isinstance(content[0], dict)
                or content[0].get("type") != "text"):
            _deny()
        value = content[0].get("text")
    elif kind == "agentMessage":
        if item.get("phase") != "final_answer":
            _deny()
        value = item.get("text")
    else:
        _deny()
    if not isinstance(value, str):
        _deny()
    try:
        size = len(value.encode("utf-8", "strict"))
    except UnicodeError:
        _deny()
    if not 1 <= size <= MAX_ITEM_TEXT_BYTES:
        _deny()
    return {
        "status": "current_schema_text_shape_only_not_authenticated",
        "complete_ui_coverage": False,
        "archive_writes_admitted": False,
    }


def admit_real_capture(_schema=None, _host_claims=None, _consent=None) -> dict:
    """No production launcher, consent minting or writer in this slice."""
    return {"status": "blocked",
            "reason": "real executable origin, OS consent, scope and coverage not verified"}
