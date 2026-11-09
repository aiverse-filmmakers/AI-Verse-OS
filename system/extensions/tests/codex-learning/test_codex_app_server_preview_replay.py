"""3A.16 strict item lifecycle duplicate and mismatch negative fixtures."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock

PACKAGE = (Path(__file__).resolve().parents[2] / "packages"
           / "ai-verse-codex-learning")
spec = importlib.util.spec_from_file_location(
    "_codex_3a16_preview_replay",
    PACKAGE / "codex_app_server_preview_replay.py"
)
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)

THREAD, TURN = "synthetic-thread-1", "synthetic-turn-1"


def frame(method, item_id="item-1", item_type="agentMessage",
          stamp=1000, thread=THREAD, turn=TURN, **extra):
    clock = "startedAtMs" if method == "item/started" else "completedAtMs"
    params = {
        "threadId": thread, "turnId": turn,
        "item": {"id": item_id, "type": item_type,
                 "text": "PRIVATE_FIXTURE_BODY_NOT_RETAINED"},
        clock: stamp,
    }
    params.update(extra)
    return {"method": method, "params": params}


class PreviewReplayTests(unittest.TestCase):
    def setUp(self):
        self.ledger = gate.SyntheticItemLedger(THREAD, TURN)

    def refused(self, action):
        with self.assertRaises(gate.ReplayBlocked) as exc:
            action()
        self.assertEqual(str(exc.exception),
                         "unverified synthetic item lifecycle refused")
        self.assertNotIn("PRIVATE_FIXTURE_BODY_NOT_RETAINED", str(exc.exception))

    def test_completed_user_and_started_completed_agent_not_archivable(self):
        a = self.ledger.observe(
            frame("item/completed", "user-1", "userMessage", 999)
        )
        self.assertEqual((a.seen_events, a.complete_items), (1, 1))
        b = self.ledger.observe(frame("item/started", "agent-1", stamp=1000))
        self.assertEqual((b.seen_events, b.complete_items), (2, 1))
        c = self.ledger.observe(frame("item/completed", "agent-1", stamp=1001))
        self.assertEqual((c.seen_events, c.complete_items), (3, 2))
        for value in (a, b, c, self.ledger.close()):
            self.assertFalse(value.archive_admitted)
            self.assertFalse(value.os_consent_verified)
            self.assertFalse(value.authenticated_host)
            self.assertNotIn("PRIVATE_FIXTURE_BODY_NOT_RETAINED", repr(value))
        self.refused(lambda: self.ledger.observe(
            frame("item/completed", "user-1", "userMessage")
        ))

    def test_duplicate_and_repeated_completions_irreversibly_refused(self):
        self.ledger.observe(frame("item/started", "agent-1"))
        self.refused(lambda: self.ledger.observe(
            frame("item/started", "agent-1")
        ))
        self.refused(lambda: self.ledger.observe(
            frame("item/completed", "agent-1")
        ))
        self.refused(self.ledger.close)

        next_ledger = gate.SyntheticItemLedger(THREAD, TURN)
        next_ledger.observe(frame("item/completed", "user-1", "userMessage"))
        self.refused(lambda: next_ledger.observe(
            frame("item/completed", "user-1", "userMessage")
        ))

    def test_conflicting_type_clock_and_thread_identity_refused(self):
        bads = [
            frame("item/completed", "agent-1", "agentMessage"),
            frame("item/started", "agent-1", stamp=True),
            frame("item/started", "agent-1", stamp=-1),
            frame("item/started", "agent-1", stamp=1.4),
            frame("item/started", "agent-1", stamp=1 << 63),
            frame("item/started", "agent-1", thread="foreign"),
            frame("item/started", "agent-1", turn="foreign"),
            frame("item/started", "not/a/valid/id"),
            frame("item/agentMessage/delta"),
        ]
        for bad in bads:
            with self.subTest(method=bad["method"], params=bad.get("params", {}).get("threadId")):
                l = gate.SyntheticItemLedger(THREAD, TURN)
                self.refused(lambda: l.observe(bad))
                self.refused(lambda: l.observe(frame("item/started", "agent-1")))

    def test_mismatched_agent_type_and_decreasing_clock_refused(self):
        for completion in (
            frame("item/completed", "agent-1", "userMessage", stamp=1000),
            frame("item/completed", "agent-1", "agentMessage", stamp=999),
        ):
            l = gate.SyntheticItemLedger(THREAD, TURN)
            l.observe(frame("item/started", "agent-1", stamp=1000))
            self.refused(lambda: l.observe(completion))
            self.refused(l.close)

    def test_pending_items_and_empty_session_do_not_close(self):
        self.refused(self.ledger.close)
        l = gate.SyntheticItemLedger(THREAD, TURN)
        l.observe(frame("item/started"))
        self.refused(l.close)

    def test_only_fixed_bounded_items_and_events(self):
        l = gate.SyntheticItemLedger(THREAD, TURN)
        with mock.patch.object(gate, "MAX_ITEMS", 2):
            l.observe(frame("item/completed", "u-1", "userMessage"))
            l.observe(frame("item/completed", "u-2", "userMessage"))
            self.refused(lambda: l.observe(
                frame("item/completed", "u-3", "userMessage")
            ))
        l = gate.SyntheticItemLedger(THREAD, TURN)
        with mock.patch.object(gate, "MAX_EVENTS", 1):
            l.observe(frame("item/completed", "u-1", "userMessage"))
            self.refused(lambda: l.observe(
                frame("item/completed", "u-2", "userMessage")
            ))

    def test_revoke_disables_and_clears_data(self):
        self.ledger.observe(frame("item/completed", "u-1", "userMessage"))
        self.ledger.revoke()
        self.assertEqual(self.ledger._records, {})
        self.refused(lambda: self.ledger.observe(
            frame("item/completed", "u-2", "userMessage")
        ))
        self.refused(self.ledger.close)

    def test_invalid_json_rpc_or_untrusted_envelopes(self):
        for bad in (
            {"jsonrpc": "1.0", **frame("item/completed", "u", "userMessage")},
            {"id": 3, **frame("item/completed", "u", "userMessage")},
            {"error": {}, **frame("item/completed", "u", "userMessage")},
            {"result": {}, **frame("item/completed", "u", "userMessage")},
            {"method": "turn/completed", "params": {}},
            {"method": "item/completed", "params": {"threadId": THREAD, "turnId": TURN, "item": []}},
        ):
            l = gate.SyntheticItemLedger(THREAD, TURN)
            self.refused(lambda: l.observe(bad))
        self.refused(lambda: gate.SyntheticItemLedger("invalid/thread", TURN))

    def test_production_gate_remains_hard_denied(self):
        self.assertEqual(gate.authorize_real_archive(
            self.ledger, {"trusted": True, "consent": True}
        )["status"], "blocked")


if __name__ == "__main__":
    unittest.main()
