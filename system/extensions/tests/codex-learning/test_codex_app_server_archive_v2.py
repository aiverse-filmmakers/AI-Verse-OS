"""3A.8 synthetic-only v2 envelope writer contract. No real file IO."""
import base64
from dataclasses import replace
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock


PKG = Path(__file__).resolve().parents[2] / "packages" / "ai-verse-codex-learning"


def load(alias, file):
    spec = importlib.util.spec_from_file_location(alias, PKG / file)
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


source = load("_3a8_source_contract", "codex_app_server_source_evidence.py")
v2 = load("_3a8_v2_writer", "codex_app_server_archive_v2.py")


class V2ArchiveFixtureContractTests(unittest.TestCase):
    def event(self, method, **params):
        return {"method": method, "params": params}

    def frames(self):
        tid, turn = "fixture-thread-8", "fixture-turn-8"
        return [
            self.event("turn/started", threadId=tid,
                       turn={"id": turn, "status": "inProgress", "items": []}),
            self.event("item/completed", threadId=tid, turnId=turn,
                       item={"id": "user-item-8", "type": "userMessage",
                             "content": [{"type": "text",
                                          "text": "  fixture prompt 🧪 中文 \n  "}]}),
            self.event("item/completed", threadId=tid, turnId=turn,
                       item={"id": "assistant-item-8", "type": "agentMessage",
                             "text": "answer \n final 🚀", "phase": "final_answer"}),
            self.event("turn/completed", threadId=tid,
                       turn={"id": turn, "status": "completed"}),
        ]

    def pack(self, frame, *, spaced=False):
        return (json.dumps(
            frame, ensure_ascii=False,
            separators=(", ", ": ") if spaced else (",", ":"),
        ).encode("utf-8") + b"\n")

    def prepare(self):
        records = [self.pack(x, spaced=bool(i%2))
                   for i, x in enumerate(self.frames())]
        candidate = source.evaluate_exact_fixture_frames(
            records, expected_thread="fixture-thread-8",
            expected_turn="fixture-turn-8",
        )
        return candidate, records

    def generate(self, candidate=None, records=None):
        original, raws = self.prepare()
        return v2.create_synthetic_envelope(
            original if candidate is None else candidate,
            raws if records is None else records,
            archive_id="fixture-archive-8", scope="workspace:alpha",
        )

    def blocked(self, func):
        with self.assertRaises(v2.V2FixtureBlocked) as error:
            func()
        self.assertEqual(str(error.exception),
                         "unverified v2 fixture envelope refused")

    def test_envelope_has_distinct_schema_exact_frames_and_seal(self):
        candidate, rows = self.prepare()
        blob = self.generate(candidate, rows)
        parsed = [json.loads(r) for r in blob.splitlines()]
        self.assertEqual(len(parsed), len(rows) + 2)
        header, seal = parsed[0], parsed[-1]
        self.assertEqual(header["schema"], v2.SCHEMA)
        self.assertNotEqual(v2.SCHEMA, "ai-verse.chat-archive/v1")
        self.assertEqual(header["mode"], "synthetic_fixture_only")
        self.assertEqual(header["scope"], "workspace:alpha")
        self.assertEqual(seal["messages"][0]["role"], "user")
        self.assertEqual(seal["messages"][1]["role"], "assistant")
        self.assertIsNone(seal["original_source_offsets"])
        for marker in ("host_origin_authenticated", "scope_authenticated",
                       "consent_verified", "complete_ui_coverage", "write_admitted"):
            self.assertIs(header[marker], False)
            self.assertIs(seal[marker], False)
        for index, raw in enumerate(rows):
            frame = parsed[index+1]
            self.assertEqual(base64.b64decode(frame["wire_b64"]), raw)
            self.assertEqual(frame["wire_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(seal["received_stream_sha256"],
                         hashlib.sha256(b"".join(rows)).hexdigest())

    def test_no_provider_coordinates_or_claim_of_full_coverage(self):
        blob = self.generate()
        self.assertNotIn(b"source_byte_offset", blob)
        self.assertNotIn(b"source_end_offset", blob)
        self.assertNotIn(b"original_provider_record_verified", blob)
        self.assertEqual(v2.admission(blob)["status"], "blocked")
        self.assertEqual(v2.save_real_chat(blob)["status"], "blocked")
        with mock.patch.object(v2, "_RECORDING_ENABLED", True):
            self.assertEqual(v2.save_real_chat(blob)["status"], "blocked")

    def test_deterministic_v2_fixture_envelope(self):
        self.assertEqual(self.generate(), self.generate())

    def test_exact_whitespace_and_unicode_change_wire_not_text_hash(self):
        first = self.generate()
        original, raws = self.prepare()
        decoded = json.loads(raws[1])
        raws[1] = self.pack(decoded, spaced=False)
        modified = source.evaluate_exact_fixture_frames(
            raws, expected_thread=original.thread_id,
            expected_turn=original.turn_id,
        )
        second = self.generate(modified, raws)
        self.assertNotEqual(first, second)
        a = [json.loads(x) for x in first.splitlines()][-1]["messages"]
        b = [json.loads(x) for x in second.splitlines()][-1]["messages"]
        self.assertEqual(a, b)

    def test_mismatched_bytes_and_mutated_candidate_fail_closed(self):
        evidence, rows = self.prepare()
        for mutated in (
            replace(evidence, observed_stream_sha256="0"*64),
            replace(evidence, observed_wire_bytes=1),
            replace(evidence, writer_admitted=True),
            replace(evidence, consent_issued=True),
            replace(evidence, physical_scope_authenticated=True),
            replace(evidence, complete_ui_coverage=True),
        ):
            with self.subTest(field=mutated):
                self.blocked(lambda: self.generate(mutated, rows))
        changed = list(rows)
        changed[1] = changed[1].replace(b"fixture", b"replace")
        self.blocked(lambda: self.generate(evidence, changed))

    def test_reordered_or_truncated_frame_lists_fail(self):
        original, rows = self.prepare()
        for bad in (rows[:3], rows + rows[-1:], list(reversed(rows)),
                    rows[:1] + rows[2:3] + rows[1:2] + rows[3:]):
            self.blocked(lambda: self.generate(original, bad))

    def test_changed_raw_item_bytes_without_hash_change_refuse(self):
        original, rows = self.prepare()
        wrong = replace(original.messages[0], exact_received_wire=b"pretend\n")
        self.blocked(lambda: self.generate(
            replace(original, messages=(wrong, original.messages[1])),
            rows,
        ))

    def test_invalid_archive_id_and_scope_refuse(self):
        source_evidence, rows = self.prepare()
        for archive_id, scope in (
            ("../bad", "workspace:alpha"),
            ("valid", "workspace:../../private"),
            ("valid", "workspace:Unknown"),
            ("", "operator"),
            ("valid", "unbound"),
        ):
            self.blocked(lambda: v2.create_synthetic_envelope(
                source_evidence, rows, archive_id=archive_id, scope=scope
            ))

    def test_tiny_row_budget_prevents_unbounded_wire_output(self):
        with mock.patch.object(v2, "MAX_ROW_BYTES", 128):
            self.blocked(self.generate)
        with mock.patch.object(v2, "MAX_ARCHIVE_BYTES", 256):
            self.blocked(self.generate)

    def test_reject_nonbytes_source_frames_even_if_decodable(self):
        source_evidence, rows = self.prepare()
        mutated = list(rows)
        mutated[1] = bytearray(mutated[1])
        self.blocked(lambda: self.generate(source_evidence, mutated))

    def test_all_operation_is_in_memory_and_no_archive_io(self):
        with (
            mock.patch("builtins.open", side_effect=AssertionError("fixture must not open files")),
            mock.patch.object(Path, "write_bytes", side_effect=AssertionError("fixture must not write")),
            mock.patch.object(Path, "read_bytes", side_effect=AssertionError("fixture must not read")),
        ):
            result = self.generate()
            self.assertTrue(result.endswith(b"\n"))
        self.assertEqual(v2.save_real_chat(result)["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
