"""Synthetic, no-filesystem tests for the pure Claude JSONL fixture parser."""

import importlib.util
import json
import sys
import unittest
from pathlib import Path


PARSER = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "ai-verse-codex-learning"
    / "claude_transcript.py"
)
spec = importlib.util.spec_from_file_location("_fixture_claude_transcript", PARSER)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def row(value, terminator=b"\n"):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + terminator


def message(role, content, *, uuid="record-1", **flags):
    return {
        "type": role,
        "sessionId": "session-abc",
        "uuid": uuid,
        "message": {"role": role, "content": content},
        **flags,
    }


class ClaudeJsonlFixtureTests(unittest.TestCase):
    def parse(self, data, source_id="claude:fixture:session-abc"):
        return module.parse_claude_jsonl(data, source_id=source_id)

    def test_order_and_exact_unicode_whitespace_without_joining_blocks(self):
        human = "  Salut, lume! 👩‍🚀 café 中\n\n\tLine two \r\n"
        answer = "\n  Δοκιμή 🐈\t "
        continuation = "  tail  "
        data = (
            row(message("user", human, uuid="u1"), b"\r\n")
            + row(message("assistant", [
                {"type": "thinking", "thinking": "SECRET_PRIVATE_REASONING"},
                {"type": "text", "text": answer},
                {"type": "tool_use", "id": "tool-1", "name": "Bash", "input": {"secret": "RAW_TOOL"}},
                {"type": "text", "text": continuation},
                {"type": "redacted_thinking", "data": "HIDDEN"},
            ], uuid="a1"))
        )
        result = self.parse(data)
        self.assertEqual([b.role for b in result.text_blocks], ["user", "assistant", "assistant"])
        self.assertEqual([b.text for b in result.text_blocks], [human, answer, continuation])
        self.assertEqual([b.block_index for b in result.text_blocks], [0, 1, 3])
        self.assertEqual([b.line_number for b in result.text_blocks], [1, 2, 2])
        self.assertEqual([b.record_uuid for b in result.text_blocks], ["u1", "a1", "a1"])
        self.assertIsNone(result.trailing_partial)
        self.assertFalse(result.complete_unterminated_record)
        self.assertEqual(result.resume_offset, len(data))

    def test_raw_tool_results_and_nonvisible_records_are_excluded(self):
        records = [
            message("user", [{"type": "tool_result", "tool_use_id": "tool-1", "content": "RAW_TOOL"}]),
            message("user", [
                {"type": "text", "text": "Don't mistake this tool envelope for a human message"},
                {"type": "tool_result", "content": "RAW_TOOL"},
            ]),
            message("user", "Hidden tool response", toolUseResult={"stdout": "RAW_TOOL"}),
            message("user", "Hidden tool response with null envelope", toolUseResult=None),
            message("assistant", [{"type": "thinking", "thinking": "SECRET_PRIVATE_REASONING"}]),
            message("assistant", [{"type": "tool_use", "name": "Read", "input": {"path": "/private"}}]),
            message("user", "META", isMeta=True),
            message("assistant", "SIDECHAIN", isSidechain=True),
            message("assistant", "COMPACTION", isCompactSummary=True),
            message("user", "SYNTHETIC", isSynthetic=True),
            {"type": "progress", "data": {"content": "INTERNAL_PROGRESS"}},
            {"type": "system", "message": {"role": "system", "content": "INTERNAL_SYSTEM"}},
            {"type": "assistant", "message": {"role": "user", "content": "MISMATCH"}},
            message("user", "Human-visible text", uuid="human"),
        ]
        result = self.parse(b"".join(row(record) for record in records))
        self.assertEqual([block.text for block in result.text_blocks], ["Human-visible text"])

    def test_stable_append_safe_source_identity_and_distinct_duplicate_lines(self):
        first = row(message("user", "Same words", uuid="duplicate"))
        original = self.parse(first)
        replayed = self.parse(first)
        appended = self.parse(first + first)
        self.assertEqual(original.text_blocks[0].source_identity, replayed.text_blocks[0].source_identity)
        self.assertEqual(original.text_blocks[0].source_identity, appended.text_blocks[0].source_identity)
        self.assertNotEqual(appended.text_blocks[0].source_identity, appended.text_blocks[1].source_identity)
        self.assertNotEqual(
            original.text_blocks[0].source_identity,
            self.parse(first, source_id="claude:other-session").text_blocks[0].source_identity,
        )
        self.assertEqual(appended.text_blocks[0].byte_offset, 0)
        self.assertEqual(appended.text_blocks[1].byte_offset, len(first))
        self.assertEqual(appended.resume_offset, len(first + first))

    def test_utf8_byte_offsets_after_multibyte_records(self):
        prefix = row(message("user", "👩‍🚀 café 中文\\n", uuid="unicode"), b"\r\n")
        following = row(message("assistant", "follow-up", uuid="next"))
        parsed = self.parse(prefix + following)
        self.assertGreater(len(prefix), len(prefix.decode("utf-8")))
        self.assertEqual(parsed.text_blocks[1].byte_offset, len(prefix))
        self.assertEqual(parsed.text_blocks[1].line_number, 2)
        self.assertEqual(parsed.resume_offset, len(prefix + following))

    def test_identical_text_blocks_in_one_record_remain_distinct(self):
        parsed = self.parse(row(message("assistant", [
            {"type": "text", "text": "repeat"},
            {"type": "thinking", "thinking": "SECRET"},
            {"type": "text", "text": "repeat"},
        ])))
        self.assertEqual([block.text for block in parsed.text_blocks], ["repeat", "repeat"])
        self.assertEqual([block.block_index for block in parsed.text_blocks], [0, 2])
        self.assertNotEqual(parsed.text_blocks[0].source_identity, parsed.text_blocks[1].source_identity)

    def test_partial_trailing_json_is_reported_not_emitted_and_recovers_after_append(self):
        complete = row(message("user", "Before"))
        pending = row(message("assistant", "After"))[:-4]
        partial = self.parse(complete + pending)
        self.assertEqual([block.text for block in partial.text_blocks], ["Before"])
        self.assertEqual(partial.trailing_partial.byte_offset, len(complete))
        self.assertEqual(partial.trailing_partial.byte_length, len(pending))
        self.assertEqual(len(partial.trailing_partial.sha256), 64)
        self.assertFalse(hasattr(partial.trailing_partial, "raw"))
        self.assertFalse(partial.complete_unterminated_record)
        self.assertEqual(partial.resume_offset, len(complete))

        restored = self.parse(complete + pending + row(message("assistant", "After"))[-4:])
        self.assertEqual([block.text for block in restored.text_blocks], ["Before", "After"])
        self.assertIsNone(restored.trailing_partial)
        self.assertEqual(partial.text_blocks[0].source_identity, restored.text_blocks[0].source_identity)
        self.assertEqual(restored.resume_offset, len(complete + pending + row(message("assistant", "After"))[-4:]))

    def test_complete_json_without_terminal_newline_is_included_and_flagged(self):
        data = row(message("assistant", "No newline"), b"")
        result = self.parse(data)
        self.assertEqual([b.text for b in result.text_blocks], ["No newline"])
        self.assertTrue(result.complete_unterminated_record)
        self.assertIsNone(result.trailing_partial)
        # A valid but unterminated final record is provisional for checkpointing.
        self.assertEqual(result.resume_offset, 0)
        appended_newline = self.parse(data + b"\n")
        self.assertEqual(appended_newline.text_blocks[0].source_identity, result.text_blocks[0].source_identity)
        self.assertEqual(appended_newline.resume_offset, len(data) + 1)

    def test_invalid_complete_line_fails_closed_without_echoing_source(self):
        invalid = b'{"type":"user","private":"DO_NOT_ECHO",}\n'
        with self.assertRaises(module.TranscriptFormatError) as caught:
            self.parse(row(message("user", "Valid")) + invalid)
        self.assertIn("line 2", str(caught.exception))
        self.assertNotIn("DO_NOT_ECHO", str(caught.exception))

    def test_partial_multibyte_utf8_is_not_misparsed_as_complete(self):
        broken_tail = b'{"type":"user","message":{"role":"user","content":"\xf0\x9f'
        result = self.parse(row(message("user", "Good")) + broken_tail)
        self.assertEqual(len(result.text_blocks), 1)
        self.assertEqual(result.trailing_partial.byte_length, len(broken_tail))
        self.assertEqual(result.resume_offset, len(row(message("user", "Good"))))
        with self.assertRaises(module.TranscriptFormatError):
            self.parse(broken_tail + b"\n")

    def test_empty_and_whitespace_only_text_are_not_trimmed(self):
        result = self.parse(row(message("user", [
            {"type": "text", "text": ""},
            {"type": "text", "text": " \t\n"},
        ])))
        self.assertEqual([block.text for block in result.text_blocks], ["", " \t\n"])

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaises(TypeError):
            module.parse_claude_jsonl("not bytes", source_id="a")
        for value in ("", "  ", " too much "):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.parse(b"", source_id=value)


if __name__ == "__main__":
    unittest.main()
