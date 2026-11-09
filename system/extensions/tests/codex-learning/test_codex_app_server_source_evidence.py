"""3A.7 exact JSONL source evidence candidate regression suite.

All records are synthetic. A disposable Python fixture is used to prove
pipe byte fidelity, never to establish Codex event origin or consent.
"""
from dataclasses import replace
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


PACKAGE = Path(__file__).resolve().parents[2] / "packages" / "ai-verse-codex-learning"


def load(alias, path):
    spec = importlib.util.spec_from_file_location(alias, PACKAGE / path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


evidence = load("_3a7_source_evidence", "codex_app_server_source_evidence.py")
transport = load("_3a7_fixture_transport", "codex_app_server_transport.py")
parser = load("_3a7_legacy_candidate", "codex_app_server_candidate.py")


FAKE_CHILD = r"""
import json
import sys

def send(value):
    # Deliberately preserve presentation whitespace and native Unicode.
    wire = json.dumps(value, ensure_ascii=False, separators=(", ", ": "))
    sys.stdout.buffer.write(wire.encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()

request = json.loads(sys.stdin.readline())
send({"id": request["id"], "result": {"serverInfo": {
    "name": "fake-not-codex"}}})
assert json.loads(sys.stdin.readline())["method"] == "initialized"
send({"method":"turn/started", "params":{
    "threadId":"thread-fixture-7",
    "turn":{"id":"turn-fixture-7", "status":"inProgress", "items":[]}}})
send({"method":"item/completed", "params":{
    "threadId":"thread-fixture-7", "turnId":"turn-fixture-7",
    "item":{"id":"u-7", "type":"userMessage",
            "content":[{"type":"text", "text":" user 🧪 中文 \n "}]}}})
send({"method":"item/completed", "params":{
    "threadId":"thread-fixture-7", "turnId":"turn-fixture-7",
    "item":{"id":"a-7", "type":"agentMessage", "phase":"final_answer",
            "text":" response 🚀\n "}}})
send({"method":"turn/completed", "params":{
    "threadId":"thread-fixture-7",
    "turn":{"id":"turn-fixture-7", "status":"completed"}}})
"""


class SourceWireContractTests(unittest.TestCase):
    thread = "thread-fixture-7"
    turn = "turn-fixture-7"
    secret = " PRIVATE-SYNTHETIC-SOURCE "

    def event(self, method, **params):
        return {"method": method, "params": params}

    def start(self):
        return self.event("turn/started", threadId=self.thread,
                          turn={"id": self.turn, "status": "inProgress", "items": []})

    def user(self, text=None, ident="u-7", content=None):
        return self.event("item/completed", threadId=self.thread,
                          turnId=self.turn, item={"id": ident, "type": "userMessage",
                          "content": ([{"type":"text", "text": self.secret if text is None else text}]
                                      if content is None else content)})

    def assistant(self, text=None, phase="final_answer", ident="a-7"):
        return self.event("item/completed", threadId=self.thread,
                          turnId=self.turn, item={"id": ident, "type": "agentMessage",
                          "phase": phase, "text": " synthetic reply " if text is None else text})

    def end(self, status="completed"):
        return self.event("turn/completed", threadId=self.thread,
                          turn={"id": self.turn, "status": status})

    def wire(self, item, *, compact=True):
        return json.dumps(item, ensure_ascii=False,
                          separators=(",", ":") if compact else (", ", ": ")
                          ).encode("utf-8") + b"\n"

    def rows(self):
        return [self.wire(self.start()), self.wire(self.user()),
                self.wire(self.assistant()), self.wire(self.end())]

    def evaluate(self, rows):
        return evidence.evaluate_exact_fixture_frames(
            rows, expected_thread=self.thread, expected_turn=self.turn
        )

    def blocked(self, fn):
        with self.assertRaises(evidence.SourceEvidenceBlocked) as caught:
            fn()
        self.assertNotIn(self.secret, str(caught.exception))
        self.assertNotIn("thread-fixture", str(caught.exception))

    def test_valid_exact_raw_record_is_preserved_without_v1_offsets(self):
        rows = self.rows()
        rows[1] = self.wire(self.user(), compact=False)
        result = self.evaluate(rows)
        self.assertEqual(result.schema, evidence.SCHEMA)
        self.assertEqual(len(result.messages), 2)
        original = result.messages[0]
        self.assertEqual(original.role, "user")
        self.assertEqual(original.text, self.secret)
        self.assertEqual(original.exact_received_wire, rows[1])
        self.assertEqual(original.wire_sha256, hashlib.sha256(rows[1]).hexdigest())
        self.assertEqual(original.text_sha256,
                         hashlib.sha256(self.secret.encode("utf-8")).hexdigest())
        self.assertEqual(original.wire_byte_length, len(rows[1]))
        self.assertEqual(original.observed_frame_index, 1)
        self.assertIsNone(original.original_byte_offset)
        self.assertIsNone(original.original_end_offset)
        self.assertFalse(original.original_provider_record_verified)
        self.assertEqual(result.observed_stream_sha256,
                         hashlib.sha256(b"".join(rows)).hexdigest())
        self.assertEqual(result.observed_frame_sha256,
                         tuple(hashlib.sha256(x).hexdigest() for x in rows))
        self.assertEqual(result.observed_wire_bytes, sum(map(len, rows)))
        self.assertNotIn(self.secret, repr(result))
        self.assertNotIn(self.secret, repr(original))

    def test_decoding_and_reserializing_cannot_substitute_original_wire(self):
        compact = self.rows()
        spaced = list(compact)
        spaced[1] = self.wire(self.user(), compact=False)
        first = self.evaluate(compact)
        second = self.evaluate(spaced)
        self.assertEqual(first.messages[0].text, second.messages[0].text)
        self.assertEqual(first.messages[0].text_sha256,
                         second.messages[0].text_sha256)
        self.assertNotEqual(first.messages[0].wire_sha256,
                            second.messages[0].wire_sha256)
        self.assertEqual(second.messages[0].exact_received_wire, spaced[1])

    def test_source_fidelity_does_not_grant_archive_persistence(self):
        result = self.evaluate(self.rows())
        for flag in ("original_provider_bytes_authenticated",
                     "original_byte_offsets_available",
                     "pinned_host_schema_verified",
                     "physical_scope_authenticated",
                     "consent_issued", "complete_ui_coverage", "writer_admitted"):
            self.assertIs(getattr(result, flag), False)
        self.assertEqual(evidence.convert_to_v1_archive(result)["status"], "blocked")
        self.assertEqual(evidence.source_admission(result)["status"], "blocked")
        with mock.patch.object(evidence, "_PRODUCTION_SOURCE_EVIDENCE_ADMITTED", True):
            self.assertEqual(evidence.convert_to_v1_archive(result)["status"],
                             "blocked")
            self.assertEqual(evidence.source_admission(result)["status"], "blocked")
        self.assertFalse(evidence._PRODUCTION_SOURCE_EVIDENCE_ADMITTED)

    def test_no_reconstructed_json_dict_string_or_unterminated_record(self):
        rows = self.rows()
        for corrupt in (rows[1][:-1], rows[1] + b"\n",
                        rows[1].replace(b"\n", b"\r\n"),
                        json.loads(rows[1]), rows[1].decode("utf-8"),
                        bytearray(rows[1])):
            bad = list(rows)
            bad[1] = corrupt
            with self.subTest(type=type(corrupt).__name__):
                self.blocked(lambda: self.evaluate(bad))

    def test_duplicate_keys_nan_bad_utf8_and_json_error_refused(self):
        rows = self.rows()
        for corrupt in (
            b'{"method":"item/completed","method":"turn/completed","params":{}}\n',
            b'{"method":"item/completed","params":{"value":NaN}}\n',
            b'{"method":"item/completed","params":{\xff}}\n',
            b'{"method":"item/completed","params":not-json}\n',
            b"\xef\xbb\xbf" + rows[1],
            rows[1].replace(b"}\n", b"}\n{}"),
        ):
            bad = list(rows)
            bad[1] = corrupt
            with self.subTest(sample=corrupt[:22]):
                self.blocked(lambda: self.evaluate(bad))

    def test_mixed_thread_turn_or_completion_identity_refuse(self):
        rows = self.rows()
        for position, event in (
            (0, self.event("turn/started", threadId="foreign",
                           turn={"id":self.turn, "status":"inProgress", "items":[]})),
            (1, self.event("item/completed", threadId="foreign", turnId=self.turn,
                           item={"id":"u-7","type":"userMessage",
                                 "content":[{"type":"text","text":"wrong"}]})),
            (2, self.event("item/completed", threadId=self.thread,
                           turnId="foreign", item={"id":"a-7",
                           "type":"agentMessage","phase":"final_answer",
                           "text":"wrong"})),
            (3, self.event("turn/completed", threadId=self.thread,
                           turn={"id":"foreign","status":"completed"})),
        ):
            bad = list(rows)
            bad[position] = self.wire(event)
            with self.subTest(position=position):
                self.blocked(lambda: self.evaluate(bad))

    def test_unknown_notification_or_server_request_never_becomes_evidence(self):
        for extra in (
            self.event("thread/resumed", threadId=self.thread, turnId=self.turn),
            self.event("item/unexpected", threadId=self.thread, turnId=self.turn),
            {"id": 22, "method": "item/completed", "params": {}},
            {"jsonrpc": "1.0", "method": "item/completed", "params": {}},
        ):
            rows = self.rows()
            rows.insert(2, self.wire(extra))
            self.blocked(lambda: self.evaluate(rows))

    def test_missing_user_assistant_end_and_out_of_order_refused(self):
        frames = self.rows()
        for bad in (frames[:1] + frames[2:],
                    frames[:2] + frames[3:],
                    frames[:-1],
                    [frames[1], frames[0], frames[2], frames[3]],
                    [frames[0], frames[2], frames[1], frames[3]],
                    frames + [frames[-1]]):
            self.blocked(lambda: self.evaluate(bad))

    def test_replayed_item_ids_and_duplicate_text_events_refused(self):
        rows = self.rows()
        replayed = list(rows)
        replayed.insert(2, rows[1])
        self.blocked(lambda: self.evaluate(replayed))
        duplicate = list(rows)
        duplicate.insert(2, self.wire(self.user(ident="u-8")))
        self.blocked(lambda: self.evaluate(duplicate))
        colliding = list(rows)
        colliding[2] = self.wire(self.assistant(ident="u-7"))
        self.blocked(lambda: self.evaluate(colliding))

    def test_non_final_assistant_and_multi_block_user_refused(self):
        for phase in ("commentary", "partial_answer", "", None):
            rows = self.rows()
            rows[2] = self.wire(self.assistant(phase=phase))
            self.blocked(lambda: self.evaluate(rows))
        for content in (
            [{"type":"image","url":"PRIVATE_IMAGE"}],
            [{"type":"text","text":"one"},{"type":"text","text":"two"}],
            [{"type":"text","text":"one"},{"type":"localImage","path":"/tmp/a"}],
        ):
            rows = self.rows()
            rows[1] = self.wire(self.user(content=content))
            self.blocked(lambda: self.evaluate(rows))

    def test_failed_or_interrupted_turn_never_produces_source(self):
        for status in ("interrupted", "failed", "inProgress", "unknown"):
            rows = self.rows()
            rows[3] = self.wire(self.end(status))
            self.blocked(lambda: self.evaluate(rows))

    def test_unfinished_item_started_cannot_be_hidden(self):
        rows = self.rows()
        started = self.event("item/started", threadId=self.thread,
                             turnId=self.turn,
                             item={"id":"unfinished", "type":"userMessage"})
        rows.insert(1, self.wire(started))
        self.blocked(lambda: self.evaluate(rows))

    def test_matching_item_start_and_completion_are_bounded(self):
        rows = self.rows()
        started = self.event("item/started", threadId=self.thread,
                             turnId=self.turn,
                             item={"id":"u-7", "type":"userMessage"})
        rows.insert(1, self.wire(started))
        report = self.evaluate(rows)
        self.assertEqual([x.role for x in report.messages], ["user", "assistant"])

    def test_tool_and_delta_records_are_excluded_without_ui_completeness_claim(self):
        rows = self.rows()
        nonchat = self.event("item/completed", threadId=self.thread,
                             turnId=self.turn, item={"id":"tool-7",
                                "type":"commandExecution",
                                "output":self.secret})
        delta = self.event("item/agentMessage/delta",
                           threadId=self.thread, turnId=self.turn,
                           delta="UNTRUSTED_PARTIAL")
        rows.insert(2, self.wire(nonchat))
        rows.insert(3, self.wire(delta))
        report = self.evaluate(rows)
        self.assertEqual(report.ignored_nonchat_items, 1)
        self.assertEqual(report.ignored_delta_frames, 1)
        self.assertFalse(report.complete_ui_coverage)
        self.assertNotIn(self.secret, repr(report))
        self.assertEqual([m.role for m in report.messages],
                         ["user", "assistant"])

    def test_source_wire_budget_and_frame_count_fail_closed(self):
        frames = self.rows()
        huge = b" " * evidence.MAX_FRAME_BYTES + b"\n"
        bad = list(frames)
        bad[1] = huge
        self.blocked(lambda: self.evaluate(bad))
        with mock.patch.object(evidence, "MAX_TOTAL_WIRE_BYTES",
                               sum(map(len, frames)) - 1):
            self.blocked(lambda: self.evaluate(frames))
        with mock.patch.object(evidence, "MAX_FRAMES", 3):
            self.blocked(lambda: self.evaluate(frames))

    def test_source_text_budget_and_invalid_surrogate_fail_closed(self):
        for value in ("", "x" * (evidence.MAX_TEXT_BYTES + 1)):
            rows = self.rows()
            rows[1] = self.wire(self.user(text=value))
            self.blocked(lambda: self.evaluate(rows))
        rows = self.rows()
        rows[1] = (
            b'{"method":"item/completed","params":{"threadId":"thread-fixture-7",'
            b'"turnId":"turn-fixture-7","item":{"id":"u-7","type":"userMessage",'
            b'"content":[{"type":"text","text":"\\ud800"}]}}}\n'
        )
        self.blocked(lambda: self.evaluate(rows))

    def test_forged_authentication_flags_never_change_candidate_status(self):
        frames = self.rows()
        user = self.user()
        user["params"]["consent_verified"] = True
        user["params"]["scope"] = "workspace:alpha"
        user["params"]["host_attested"] = True
        user["params"]["item"]["signed"] = True
        frames[1] = self.wire(user)
        report = self.evaluate(frames)
        self.assertFalse(report.original_provider_bytes_authenticated)
        self.assertFalse(report.consent_issued)
        self.assertFalse(report.physical_scope_authenticated)
        self.assertFalse(report.writer_admitted)

    def test_legacy_candidate_parser_agrees_only_on_narrow_synthetic_result(self):
        frames = self.rows()
        state = None
        for frame in frames:
            state, legacy, _ = parser.observe(state, json.loads(frame))
        report = self.evaluate(frames)
        self.assertEqual(legacy.user_sha256, report.messages[0].text_sha256)
        self.assertEqual(legacy.assistant_sha256, report.messages[1].text_sha256)
        self.assertFalse(legacy.writer_admitted)
        self.assertFalse(report.writer_admitted)

    def test_actual_disposable_pipe_preserves_wire_bytes_before_decoding(self):
        if os.name != "posix":
            self.skipTest("fixture child only supported on POSIX")
        with tempfile.TemporaryDirectory(prefix="aiverse-3a7-evidence-") as folder:
            root = Path(folder).resolve(strict=True)
            self.assertFalse(root.stat().st_mode & 0o077)
            script = root / "fake.py"
            script.write_text(FAKE_CHILD, encoding="utf-8")
            script.chmod(0o600)
            python = Path(sys.executable).resolve(strict=True)
            spec = transport.SyntheticChildSpec(
                executable=python,
                executable_sha256=hashlib.sha256(python.read_bytes()).hexdigest(),
                fixture_script=script,
                fixture_sha256=hashlib.sha256(script.read_bytes()).hexdigest(),
                private_cwd=root,
            )
            with transport.launch_synthetic_fixture(spec) as connection:
                raw_frames = []
                for _ in range(4):
                    decoded, wire = connection.next_notification_with_raw()
                    self.assertEqual(json.loads(wire), decoded)
                    self.assertTrue(wire.endswith(b"\n"))
                    raw_frames.append(wire)
                self.assertIn(b'": "', raw_frames[1])
                report = self.evaluate(raw_frames)
                self.assertEqual(report.messages[0].text, " user 🧪 中文 \n ")
                self.assertEqual(report.messages[1].text, " response 🚀\n ")
                self.assertEqual(report.messages[0].exact_received_wire,
                                 raw_frames[1])
                self.assertEqual(report.messages[0].wire_sha256,
                                 hashlib.sha256(raw_frames[1]).hexdigest())
                self.assertFalse(report.writer_admitted)
                self.assertFalse((root / "archives").exists())


if __name__ == "__main__":
    unittest.main()
