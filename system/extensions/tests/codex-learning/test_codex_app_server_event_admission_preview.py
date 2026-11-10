"""3A.39 synthetic-only original event shape checks, NEVER real recording."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock

PACKAGE = (Path(__file__).resolve().parents[2] / "packages"
           / "ai-verse-codex-learning")
spec = importlib.util.spec_from_file_location(
    "_aiverse_3a39_event_preview",
    PACKAGE / "codex_app_server_event_admission_preview.py")
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)

THREAD = "synthetic-thread-39"
TURN = "synthetic-turn-39"
SENTINEL = "SYNTHETIC_PRIVATE_TEXT_MUST_NEVER_LEAVE_FIXTURE"


def start(thread=THREAD, turn=TURN):
    return {"method": "turn/started",
            "params": {"threadId": thread,
                       "turn": {"id": turn, "status": "inProgress", "items": []}}}


def item(kind, item_id, *, thread=THREAD, turn=TURN, timestamp=100,
         text=SENTINEL, phase="final_answer"):
    entry = {"id": item_id, "type": kind}
    if kind == "userMessage":
        entry["content"] = [{"type": "text", "text": text}]
    else:
        entry["phase"] = phase
        entry["text"] = text
    return {"method": "item/completed",
            "params": {"threadId": thread, "turnId": turn,
                       "completedAtMs": timestamp, "item": entry}}


def end(thread=THREAD, turn=TURN):
    return {"method": "turn/completed",
            "params": {"threadId": thread,
                       "turn": {"id": turn, "status": "completed"}}}


class EventPreviewTests(unittest.TestCase):
    def setUp(self):
        self.owner = m.SyntheticOwner("operator", "/scratch/operator", 1001)
        self.source = self.owner._source
        self.gate = m.ProspectiveEventPreview(self.owner)

    def refused(self, fn):
        with self.assertRaises(m.PreviewRejected) as error:
            fn()
        self.assertEqual(str(error.exception),
                         "synthetic event attribution denied")
        self.assertNotIn(SENTINEL, str(error.exception))

    def test_complete_structural_sequence_never_admits_a_record(self):
        observations = [
            self.gate.observe(self.source, start()),
            self.gate.observe(self.source, item("userMessage", "user-1")),
            self.gate.observe(self.source, item("agentMessage", "agent-1")),
            self.gate.observe(self.source, end()),
        ]
        self.assertEqual([x.observed_events for x in observations],
                         [1, 2, 3, 4])
        self.assertTrue(observations[-1].candidate_complete)
        for report in observations:
            self.assertFalse(report.authentic_host_origin)
            self.assertFalse(report.device_owner_authenticated)
            self.assertFalse(report.recording_consent_issued)
            self.assertFalse(report.complete_ui_coverage)
            self.assertFalse(report.archive_write_admitted)
            self.assertFalse(report.memory_retrieval_admitted)
            self.assertNotIn(SENTINEL, repr(report))
        self.assertFalse(self.gate.recording_permitted())
        self.assertFalse(self.gate.persist(SENTINEL))
        self.assertFalse(self.gate.retrieve_memory())
        self.refused(lambda: self.gate.observe(self.source, end()))

    def test_missing_start_and_non_prospective_history_refuse(self):
        self.refused(lambda: self.gate.observe(
            self.source, item("userMessage", "u")))
        self.refused(lambda: self.gate.observe(self.source, start()))

    def test_cross_thread_turn_and_duplicate_item_fail_terminally(self):
        for bad in (item("userMessage", "u", thread="other"),
                    item("userMessage", "u", turn="other"),
                    item("commandExecution", "tool", text=SENTINEL),
                    item("agentMessage", "a", phase="commentary"),
                    item("agentMessage", "a", phase="partial_answer")):
            gate = m.ProspectiveEventPreview(self.owner)
            gate.observe(self.source, start())
            self.refused(lambda b=bad, g=gate: g.observe(self.source, b))
            self.refused(lambda g=gate: g.observe(self.source,
                                                  item("userMessage", "fresh")))
        gate = m.ProspectiveEventPreview(self.owner)
        gate.observe(self.source, start())
        gate.observe(self.source, item("userMessage", "u"))
        self.refused(lambda: gate.observe(self.source, item("userMessage", "u")))

    def test_unsupported_multimodal_and_deltas_are_not_visible_text(self):
        bad_image = item("userMessage", "u")
        bad_image["params"]["item"]["content"] = [
            {"type": "image", "url": "synthetic://image"}]
        for bad in (bad_image,
                    {"method": "item/agentMessage/delta",
                     "params": {"threadId": THREAD, "turnId": TURN,
                                "delta": SENTINEL}},
                    {"method": "thread/resumed", "params": {}},
                    {"method": "item/completed", "id": 11, "params": {}}):
            gate = m.ProspectiveEventPreview(self.owner)
            gate.observe(self.source, start())
            self.refused(lambda g=gate, b=bad: g.observe(self.source, b))

    def test_bad_timestamps_encoding_and_byte_budget(self):
        for stamp in (-1, True, 1 << 63, "123"):
            gate = m.ProspectiveEventPreview(self.owner)
            gate.observe(self.source, start())
            self.refused(lambda g=gate, s=stamp: g.observe(
                self.source, item("userMessage", "u", timestamp=s)))
        for value in ("", "\ud800", "A" * (m.MAX_TEXT_BYTES + 1)):
            gate = m.ProspectiveEventPreview(self.owner)
            gate.observe(self.source, start())
            self.refused(lambda g=gate, v=value: g.observe(
                self.source, item("userMessage", "u", text=v)))

    def test_no_completed_turn_without_both_text_items(self):
        self.gate.observe(self.source, start())
        self.gate.observe(self.source, item("userMessage", "u"))
        self.refused(lambda: self.gate.observe(self.source, end()))

    def test_foreign_source_and_revoked_or_replaced_owner_fail_closed(self):
        self.refused(lambda: self.gate.observe(object(), start()))
        self.refused(lambda: self.gate.observe(self.source, start()))
        for replacement in (
            lambda o: o.replace("film", "/scratch/film", 1002),
            lambda o: o.replace("operator", "/scratch/operator", 1001),
            lambda o: o.revoke(),
        ):
            owner = m.SyntheticOwner("operator", "/scratch/operator", 1001)
            gate = m.ProspectiveEventPreview(owner)
            old_source = owner._source
            gate.observe(old_source, start())
            replacement(owner)
            self.refused(lambda g=gate, s=old_source: g.observe(
                s, item("userMessage", "u")))
            self.assertFalse(gate.recording_permitted())

    def test_3a42_assistant_before_user_fails_terminally(self):
        self.gate.observe(self.source, start())
        self.refused(lambda: self.gate.observe(
            self.source, item("agentMessage", "a-first")))
        self.refused(lambda: self.gate.observe(
            self.source, item("userMessage", "user-after")))

    def test_3a42_non_monotonic_items_and_replay_are_rejected(self):
        self.gate.observe(self.source, start())
        self.gate.observe(self.source, item(
            "userMessage", "user-first", timestamp=500))
        self.refused(lambda: self.gate.observe(
            self.source, item("agentMessage", "a", timestamp=499)))
        self.refused(lambda: self.gate.observe(self.source, end()))

    def test_3a42_claimed_auth_and_invalid_envelopes_do_not_issue_rights(self):
        bads = [
            {"method": "turn/started", "params": start()["params"],
             "consentVerified": True},
            {"method": "turn/started", "params": start()["params"],
             "authenticated": True},
            {"method": "turn/started", "params": start()["params"],
             "jsonrpc": "1.0"},
            {"method": "turn/started", "params": start()["params"],
             "emittedAtMs": -1},
            {"method": "turn/started", "params": start()["params"],
             "emittedAtMs": True},
            {"method": "turn/started", "params": start()["params"],
             "emittedAtMs": 1 << 63},
        ]
        for bad in bads:
            owner = m.SyntheticOwner("operator", "/scratch/operator", 1001)
            gate = m.ProspectiveEventPreview(owner)
            with self.subTest(bad=list(bad)):
                self.refused(lambda b=bad, g=gate, src=owner._source:
                             g.observe(src, b))
                self.assertFalse(gate.recording_permitted())
                self.assertFalse(gate.persist(SENTINEL))
        # Optional v2 envelope emission time is allowed, but never
        # interpreted as a trusted OS timestamp or consent.
        owner = m.SyntheticOwner("operator", "/scratch/operator", 1001)
        gate = m.ProspectiveEventPreview(owner)
        valid = start()
        valid["emittedAtMs"] = 100
        report = gate.observe(owner._source, valid)
        self.assertEqual(report.status, "synthetic_shape_only_not_authentic")
        self.assertFalse(report.archive_write_admitted)

    def test_3a42_no_second_user_or_unordered_completed_turn(self):
        self.gate.observe(self.source, start())
        self.gate.observe(self.source, item("userMessage", "user-first"))
        self.refused(lambda: self.gate.observe(
            self.source, item("userMessage", "user-two")))
        owner = m.SyntheticOwner("operator", "/scratch/operator", 1001)
        gate = m.ProspectiveEventPreview(owner)
        src = owner._source
        gate.observe(src, start())
        gate.observe(src, item("userMessage", "u"))
        gate.observe(src, item("agentMessage", "a"))
        self.assertFalse(gate.recording_permitted())
        completed = gate.observe(src, end())
        self.assertTrue(completed.candidate_complete)
        self.assertFalse(completed.authentic_host_origin)
        self.assertFalse(completed.recording_consent_issued)

    def test_3a46_nested_consent_fields_fail_closed(self):
        examples = []
        x = start()
        x["params"]["claimedConsent"] = True
        examples.append(x)
        x = start()
        x["params"]["turn"]["recordingAuthorized"] = True
        examples.append(x)
        x = item("userMessage", "u")
        x["params"]["scope"] = "film"
        examples.append(x)
        x = item("userMessage", "u")
        x["params"]["item"]["authenticated"] = True
        examples.append(x)
        x = item("userMessage", "u")
        x["params"]["item"]["content"][0]["consentVerified"] = True
        examples.append(x)
        x = item("agentMessage", "a")
        x["params"]["item"]["hostSigned"] = True
        examples.append(x)
        x = end()
        x["params"]["turn"]["signed"] = True
        examples.append(x)
        for example in examples:
            owner = m.SyntheticOwner("operator", "/scratch/operator", 1001)
            gate = m.ProspectiveEventPreview(owner)
            src = owner._source
            method = example["method"]
            if method != "turn/started":
                gate.observe(src, start())
            if method == "turn/completed":
                gate.observe(src, item("userMessage", "u"))
                gate.observe(src, item("agentMessage", "a"))
            self.refused(lambda e=example, g=gate, s=src: g.observe(s, e))
            self.assertFalse(gate.persist(SENTINEL))

    def test_3a46_monotonic_emission_stamp_never_proves_trusted_time(self):
        events = [start(), item("userMessage", "u"),
                  item("agentMessage", "a"), end()]
        for number, event in enumerate(events):
            event["emittedAtMs"] = 1000 + number
            verdict = self.gate.observe(self.source, event)
            self.assertFalse(verdict.authentic_host_origin)
            self.assertFalse(verdict.recording_consent_issued)
        self.assertTrue(verdict.candidate_complete)
        owner = m.SyntheticOwner("operator", "/scratch/operator", 1001)
        gate = m.ProspectiveEventPreview(owner)
        e = start()
        e["emittedAtMs"] = 300
        gate.observe(owner._source, e)
        older = item("userMessage", "u")
        older["emittedAtMs"] = 299
        self.refused(lambda: gate.observe(owner._source, older))
        self.assertFalse(gate.recording_permitted())
        self.refused(lambda: gate.observe(owner._source, end()))

    def test_3a46_missing_optional_emission_stamp_stays_deny_only(self):
        self.gate.observe(self.source, start())
        self.gate.observe(self.source, item("userMessage", "u"))
        result = self.gate.observe(self.source, item("agentMessage", "a"))
        self.assertFalse(result.archive_write_admitted)
        self.assertFalse(self.gate.retrieve_memory(SENTINEL))

    def test_bounded_events_and_invalid_owner(self):
        with mock.patch.object(m, "MAX_EVENTS", 1):
            gate = m.ProspectiveEventPreview(self.owner)
            gate.observe(self.source, start())
            self.refused(lambda: gate.observe(
                self.source, item("userMessage", "u")))
        for workspace, cwd, pid in (("../x", "/scratch", 1),
                                    ("operator", "relative", 1),
                                    ("operator", "/scratch", False),
                                    ("operator", "/scratch", 0)):
            self.refused(lambda w=workspace, c=cwd, p=pid:
                         m.SyntheticOwner(w, c, p))

    def test_no_text_is_kept_in_state_or_verdict(self):
        self.gate.observe(self.source, start())
        self.gate.observe(self.source, item("userMessage", "u"))
        self.assertNotIn(SENTINEL, repr(self.gate.__dict__))
        self.assertFalse(self.gate.persist(SENTINEL))
        self.assertFalse(self.gate.retrieve_memory(SENTINEL))


if __name__ == "__main__":
    unittest.main()
