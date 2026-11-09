"""3A.16 bounded synthetic Codex item lifecycle correlation, NOT capture.

Pinned research: Codex rust-v0.167.0 generated v2 ItemStartedNotification
and ItemCompletedNotification require threadId, turnId, item, and integer
millisecond startedAtMs/completedAtMs respectively. They do NOT establish
host provenance, consent, source completeness, or a global event sequence.

No real streams are opened. This fixture only remembers an item ID, type
and lifecycle clock in memory. It never stores item bodies, external paths,
messages, or archives. All production recording is unconditionally blocked.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any, Mapping

MAX_ITEMS = 32
MAX_EVENTS = 64
MAX_MS = (1 << 63) - 1
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_TYPES = frozenset(("userMessage", "agentMessage"))
_ALLOWED = frozenset(("item/started", "item/completed"))


class ReplayBlocked(ValueError):
    """Fixed reason, never includes source message/IDs."""


def _deny() -> None:
    raise ReplayBlocked("unverified synthetic item lifecycle refused")


def _ident(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        _deny()
    return value


def _clock(value: Any) -> int:
    if type(value) is not int or not 0 <= value <= MAX_MS:
        _deny()
    return value


@dataclass(frozen=True)
class ReplayPreview:
    verdict: str = "synthetic_lifecycle_consistent_not_archivable"
    seen_events: int = 0
    tracked_items: int = 0
    complete_items: int = 0
    authenticated_host: bool = False
    physical_scope_authenticated: bool = False
    os_consent_verified: bool = False
    archive_admitted: bool = False


class SyntheticItemLedger:
    """Strict short fixture with identity and completion, not message content.

    No item/agentMessage/delta: deltas are not sufficient evidence of a
    complete source. A userMessage may appear completed without a separate
    start in narrow synthetic sequences. An agentMessage requires a start
    followed by completion, same type and nondecreasing per-item time.
    This is deliberately NOT claimed to handle every Codex UI path.
    """

    def __init__(self, thread_id: str, turn_id: str):
        self._thread_id = _ident(thread_id)
        self._turn_id = _ident(turn_id)
        self._records: dict[str, tuple[str, int | None, bool]] = {}
        self._events = 0
        self._closed = False
        self._blocked = False

    def _observe(self, frame: Mapping[str, Any]) -> ReplayPreview:
        if (self._closed or self._blocked or self._events >= MAX_EVENTS
                or not isinstance(frame, Mapping)
                or ("jsonrpc" in frame and frame["jsonrpc"] != "2.0")
                or "id" in frame or "result" in frame or "error" in frame):
            _deny()
        method = frame.get("method")
        if method not in _ALLOWED:
            _deny()
        params = frame.get("params")
        if (not isinstance(params, Mapping)
                or params.get("threadId") != self._thread_id
                or params.get("turnId") != self._turn_id):
            _deny()
        item = params.get("item")
        if not isinstance(item, Mapping):
            _deny()
        item_id = _ident(item.get("id"))
        item_type = item.get("type")
        if not isinstance(item_type, str) or item_type not in _TYPES:
            _deny()
        if item_id not in self._records and len(self._records) >= MAX_ITEMS:
            _deny()
        prior = self._records.get(item_id)
        clock_key = (
            "startedAtMs" if method == "item/started" else "completedAtMs"
        )
        clock = _clock(params.get(clock_key))
        if method == "item/started":
            if prior is not None:
                _deny()
            self._records[item_id] = (item_type, clock, False)
        else:
            if prior is not None:
                kind, started, completed = prior
                if completed or kind != item_type:
                    _deny()
                if started is not None and clock < started:
                    _deny()
            elif item_type != "userMessage":
                _deny()
            self._records[item_id] = (
                item_type, prior[1] if prior else None, True
            )
        self._events += 1
        return ReplayPreview(
            seen_events=self._events,
            tracked_items=len(self._records),
            complete_items=sum(r[2] for r in self._records.values()),
        )

    def observe(self, frame: Mapping[str, Any]) -> ReplayPreview:
        try:
            return self._observe(frame)
        except Exception:
            self._blocked = True
            _deny()

    def close(self) -> ReplayPreview:
        if self._blocked or self._closed or self._events == 0:
            self._blocked = True
            _deny()
        if any(not entry[2] for entry in self._records.values()):
            self._blocked = True
            _deny()
        self._closed = True
        return ReplayPreview(
            seen_events=self._events,
            tracked_items=len(self._records),
            complete_items=len(self._records),
        )

    def revoke(self) -> None:
        self._blocked = True
        self._records.clear()


def authorize_real_archive(_ledger=None, _claims=None) -> dict:
    return {"status": "blocked", "reason": "real host and OS consent not attested"}
