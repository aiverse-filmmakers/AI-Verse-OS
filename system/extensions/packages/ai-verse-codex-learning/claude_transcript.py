"""Parse synthetic Claude Code JSONL into ordered, visible text blocks.

Pure fixture parser only. It never reads a transcript path, writes storage, or
claims to reproduce the host UI. Each source_id must identify the same source
across calls. Only text in top-level user/assistant message records is eligible;
tool results, tool calls, thinking, synthetic and sidechain records are excluded.

This is deliberately separate from the installed bridge and lifecycle hooks.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Optional, Tuple


class TranscriptFormatError(ValueError):
    """A newline-terminated transcript record is invalid."""


@dataclass(frozen=True)
class VisibleTextBlock:
    """One original text block, without inserting separators or normalizing text."""

    source_identity: str
    record_identity: str
    source_id: str
    role: str
    text: str
    line_number: int
    byte_offset: int
    block_index: int
    record_sha256: str
    session_id: Optional[str]
    record_uuid: Optional[str]


@dataclass(frozen=True)
class PartialTrailingRecord:
    """Unterminated, unparseable tail. No potentially private raw bytes escape."""

    byte_offset: int
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class ParseResult:
    text_blocks: Tuple[VisibleTextBlock, ...]
    trailing_partial: Optional[PartialTrailingRecord]
    complete_unterminated_record: bool


def _visible_blocks(record: object) -> Tuple[Tuple[int, str], ...]:
    if not isinstance(record, dict):
        return ()
    role = record.get("type")
    if role not in ("user", "assistant"):
        return ()
    if any(record.get(flag) is True for flag in (
        "isMeta", "isSidechain", "isCompactSummary", "isSynthetic"
    )):
        return ()
    # Claude may encode tool results as a user-role message. Never classify
    # such records as a human user message, even if mixed with text blocks.
    if record.get("toolUseResult") is not None:
        return ()

    message = record.get("message")
    if not isinstance(message, dict) or message.get("role", role) != role:
        return ()
    content = message.get("content")
    if isinstance(content, str):
        return ((0, content),)
    if not isinstance(content, list):
        return ()
    if role == "user" and any(
        isinstance(block, dict) and block.get("type") == "tool_result"
        for block in content
    ):
        return ()
    return tuple(
        (index, block["text"])
        for index, block in enumerate(content)
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    )


def parse_claude_jsonl(data: bytes, *, source_id: str) -> ParseResult:
    """Return visible text blocks from already-provided JSONL bytes.

    Ordering follows original physical lines, then the content-block index.
    Text is returned exactly as JSON-decoded, including whitespace and Unicode.
    An immutable source_id plus byte offset, raw-record SHA-256 and block index
    provide stable, append-safe identities without depending on file location.

    An invalid newline-terminated record raises TranscriptFormatError, without
    echoing its contents. An unparseable tail lacking newline is reported as
    trailing_partial without emitting that record. A valid final JSON record
    without a newline is included and flagged as complete_unterminated_record.
    A later append must supply a newline before the next JSON record.
    """
    if not isinstance(data, bytes):
        raise TypeError("data must be bytes")
    if not isinstance(source_id, str) or not source_id or source_id != source_id.strip():
        raise ValueError("source_id must be a nonblank stable identifier")

    output = []
    cursor = 0
    line_number = 1
    trailing_partial = None
    complete_unterminated_record = False
    while cursor < len(data):
        newline = data.find(b"\n", cursor)
        terminated = newline != -1
        end = newline + 1 if terminated else len(data)
        raw = data[cursor:newline] if terminated else data[cursor:end]
        if terminated and raw.endswith(b"\r"):
            raw = raw[:-1]
        if not raw.strip():
            cursor = end
            line_number += 1
            continue
        try:
            record = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            if not terminated:
                tail = data[cursor:end]
                trailing_partial = PartialTrailingRecord(
                    byte_offset=cursor,
                    byte_length=len(tail),
                    sha256=hashlib.sha256(tail).hexdigest(),
                )
                break
            raise TranscriptFormatError(
                f"invalid newline-terminated JSONL at line {line_number}, byte {cursor}"
            ) from exc

        if not terminated:
            complete_unterminated_record = True
        raw_hash = hashlib.sha256(raw).hexdigest()
        record_identity = f"{source_id}:byte:{cursor}:sha256:{raw_hash}"
        session_id = record.get("sessionId") if isinstance(record, dict) else None
        record_uuid = record.get("uuid") if isinstance(record, dict) else None
        if not isinstance(session_id, str):
            session_id = None
        if not isinstance(record_uuid, str):
            record_uuid = None
        for block_index, text in _visible_blocks(record):
            output.append(VisibleTextBlock(
                source_identity=f"{record_identity}:block:{block_index}",
                record_identity=record_identity,
                source_id=source_id,
                role=record["type"],
                text=text,
                line_number=line_number,
                byte_offset=cursor,
                block_index=block_index,
                record_sha256=raw_hash,
                session_id=session_id,
                record_uuid=record_uuid,
            ))
        cursor = end
        line_number += 1

    return ParseResult(
        text_blocks=tuple(output),
        trailing_partial=trailing_partial,
        complete_unterminated_record=complete_unterminated_record,
    )
