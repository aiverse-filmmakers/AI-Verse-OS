"""3A.39: synthetic prospective original-event attribution preview.

THIS IS NOT EVENT AUTHENTICATION. No production import, host integration,
recording consent, archive, Memory, filesystem access, provider key, socket
or writer exists here. The caller-owned synthetic facts can be forged.
A real signed native host must independently derive source pipe, parent-owned
Codex PID, process generation, physical workspace and consent *at event time*.

Only anonymous test events from pinned Codex App Server v2 may be checked.
Text is validated transiently, NEVER retained, hashed, logged or serialized.
Even a structurally complete stream cannot authorize any recording.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Mapping

MAX_EVENTS = 128
MAX_TEXT_BYTES = 200_000
ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$")
WORKSPACE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class PreviewRejected(ValueError):
    """Static diagnostic deliberately contains no text, PIDs or paths."""


@dataclass(frozen=True)
class EventVerdict:
    observed_events: int
    candidate_complete: bool = False
    status: str = "synthetic_shape_only_not_authentic"
    authentic_host_origin: bool = False
    device_owner_authenticated: bool = False
    recording_consent_issued: bool = False
    complete_ui_coverage: bool = False
    archive_write_admitted: bool = False
    memory_retrieval_admitted: bool = False


class SyntheticOwner:
    """Disposable fixture, NOT proof of process provenance or scope."""

    def __init__(self, workspace: str, cwd: str, child_pid: int) -> None:
        if not isinstance(workspace, str) or not WORKSPACE.fullmatch(workspace):
            raise PreviewRejected("synthetic event attribution denied")
        if not isinstance(cwd, str) or not cwd.startswith("/") or "\x00" in cwd:
            raise PreviewRejected("synthetic event attribution denied")
        if type(child_pid) is not int or child_pid <= 0:
            raise PreviewRejected("synthetic event attribution denied")
        self._workspace = workspace
        self._cwd = cwd
        self._child_pid = child_pid
        self._generation = 1
        self._source = object()
        self._active = True

    def replace(self, workspace: str, cwd: str, child_pid: int) -> None:
        if not isinstance(workspace, str) or not WORKSPACE.fullmatch(workspace):
            self.revoke()
            raise PreviewRejected("synthetic event attribution denied")
        if not isinstance(cwd, str) or not cwd.startswith("/") or "\x00" in cwd:
            self.revoke()
            raise PreviewRejected("synthetic event attribution denied")
        if type(child_pid) is not int or child_pid <= 0:
            self.revoke()
            raise PreviewRejected("synthetic event attribution denied")
        self._generation += 1
        self._workspace = workspace
        self._cwd = cwd
        self._child_pid = child_pid
        self._source = object()
        self._active = True

    def revoke(self) -> None:
        self._generation += 1
        self._source = object()
        self._active = False


def _id(value: object) -> str:
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise PreviewRejected("synthetic event attribution denied")
    return value


def _mapping(value: object) -> Mapping:
    if not isinstance(value, Mapping):
        raise PreviewRejected("synthetic event attribution denied")
    return value


def _text_only(value: object) -> None:
    if not isinstance(value, str):
        raise PreviewRejected("synthetic event attribution denied")
    try:
        size = len(value.encode("utf-8", "strict"))
    except UnicodeError:
        raise PreviewRejected("synthetic event attribution denied") from None
    if size < 1 or size > MAX_TEXT_BYTES:
        raise PreviewRejected("synthetic event attribution denied")


class ProspectiveEventPreview:
    """Single-turn, zero-storage v2 event sequence guard."""

    def __init__(self, owner: SyntheticOwner) -> None:
        if not isinstance(owner, SyntheticOwner) or not owner._active:
            raise PreviewRejected("synthetic event attribution denied")
        self._owner = owner
        self._binding = (owner._generation, owner._workspace, owner._cwd,
                         owner._child_pid)
        self._source = owner._source
        self._closed = False
        self._thread: str | None = None
        self._turn: str | None = None
        self._ids: set[str] = set()
        self._roles: set[str] = set()
        # The first completed visible message must be the user's prompt.
        # Completing the assistant first is not prospective turn evidence.
        self._expected_role = "user"
        self._last_item_ms: int | None = None
        self._events = 0

    def _current(self, source: object) -> None:
        o = self._owner
        if (self._closed or not o._active or source is not self._source
                or o._source is not self._source
                or (o._generation, o._workspace, o._cwd, o._child_pid)
                != self._binding):
            raise PreviewRejected("synthetic event attribution denied")

    def observe(self, source: object, frame: Mapping) -> EventVerdict:
        """Validate only original prospective v2 shapes, never admit writes.

        The source object is a *test-only in-memory identity*, not an
        independently authenticated pipe or signed transport. Unknown events
        fail closed; future full-UI coverage has not been established.
        """
        try:
            self._current(source)
            frame = _mapping(frame)
            if (self._events >= MAX_EVENTS or "id" in frame
                    or frame.get("jsonrpc", "2.0") != "2.0"
                    or set(frame) - {"method", "params", "jsonrpc", "emittedAtMs"}):
                raise PreviewRejected("synthetic event attribution denied")
            if "emittedAtMs" in frame and (
                    type(frame["emittedAtMs"]) is not int
                    or not 0 <= frame["emittedAtMs"] < (1 << 63)):
                raise PreviewRejected("synthetic event attribution denied")
            method = frame.get("method")
            params = _mapping(frame.get("params"))
            self._events += 1
            if self._thread is None:
                if method != "turn/started":
                    raise PreviewRejected("synthetic event attribution denied")
                self._thread = _id(params.get("threadId"))
                turn = _mapping(params.get("turn"))
                self._turn = _id(turn.get("id"))
                if turn.get("status") != "inProgress" or turn.get("items") != []:
                    raise PreviewRejected("synthetic event attribution denied")
                self._current(source)
                return EventVerdict(self._events)

            if method == "item/completed":
                if (_id(params.get("threadId")) != self._thread
                        or _id(params.get("turnId")) != self._turn):
                    raise PreviewRejected("synthetic event attribution denied")
                stamp = params.get("completedAtMs")
                if type(stamp) is not int or not 0 <= stamp < (1 << 63):
                    raise PreviewRejected("synthetic event attribution denied")
                item = _mapping(params.get("item"))
                item_id = _id(item.get("id"))
                if item_id in self._ids:
                    raise PreviewRejected("synthetic event attribution denied")
                kind = item.get("type")
                if kind == "userMessage":
                    content = item.get("content")
                    if not isinstance(content, list) or len(content) != 1:
                        raise PreviewRejected("synthetic event attribution denied")
                    one = _mapping(content[0])
                    if one.get("type") != "text":
                        raise PreviewRejected("synthetic event attribution denied")
                    _text_only(one.get("text"))
                    role = "user"
                elif kind == "agentMessage" and item.get("phase") == "final_answer":
                    _text_only(item.get("text"))
                    role = "assistant"
                else:
                    raise PreviewRejected("synthetic event attribution denied")
                if (role != self._expected_role or role in self._roles
                        or (self._last_item_ms is not None
                            and stamp < self._last_item_ms)):
                    raise PreviewRejected("synthetic event attribution denied")
                self._ids.add(item_id)
                self._roles.add(role)
                self._last_item_ms = stamp
                self._expected_role = ("assistant" if role == "user"
                                       else "completed")
            elif method == "turn/completed":
                if (_id(params.get("threadId")) != self._thread
                        or _mapping(params.get("turn")).get("id") != self._turn
                        or _mapping(params.get("turn")).get("status") != "completed"
                        or self._roles != {"user", "assistant"}
                        or self._expected_role != "completed"):
                    raise PreviewRejected("synthetic event attribution denied")
                self._closed = True
                return EventVerdict(self._events, candidate_complete=True)
            else:
                raise PreviewRejected("synthetic event attribution denied")
            self._current(source)
            return EventVerdict(self._events)
        except PreviewRejected:
            self._closed = True
            raise
        except (AttributeError, KeyError, TypeError, ValueError, UnicodeError,
                OverflowError, RecursionError):
            self._closed = True
            raise PreviewRejected("synthetic event attribution denied") from None

    def recording_permitted(self) -> bool:
        return False

    def persist(self, *_args, **_kwargs) -> bool:
        return False

    def retrieve_memory(self, *_args, **_kwargs) -> bool:
        return False
