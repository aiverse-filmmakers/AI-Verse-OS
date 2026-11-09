"""Synthetic Codex App Server v2 notification parsing tests.

No subprocess, Codex CLI, hooks, authentic transcript, private data, OS
installation, canonical archive write, or host transport is exercised.
"""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock


MODULE_PATH = (Path(__file__).resolve().parents[2] / "packages"
               / "ai-verse-codex-learning"
               / "codex_app_server_candidate.py")
spec = importlib.util.spec_from_file_location(
    "_codex_app_server_3a3_candidate_fixture", MODULE_PATH
)
candidate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = candidate
spec.loader.exec_module(candidate)


class AppServerSourceCandidateTests(unittest.TestCase):
    def start(self, thread="test-thread-1", turn="test-turn-1", **extra):
        return {"method": "turn/started", "params": {
            "threadId": thread,
            "turn": {"id": turn, "status": "inProgress", "items": []},
            **extra,
        }}

    def item(self, kind, text=None, *, iid=None, phase=None, **extra):
        identity = iid or "item-" + kind
        row = {"id": identity, "type": kind}
        if kind == "userMessage":
            row["content"] = [{"type": "text",
                               "text": text if text is not None
                               else "  Original user 🧪 中文 \n  "}]
        elif kind == "agentMessage":
            row["text"] = text if text is not None else " Original reply 🚀\n "
            row["phase"] = "final_answer" if phase is None else phase
        elif kind == "commandExecution":
            row.update({"command": "printf synthetic", "commandActions": [],
                        "cwd": "/fixture", "status": "completed"})
        row.update(extra)
        return {"method": "item/completed", "params": {
            "threadId": "test-thread-1",
            "turnId": "test-turn-1",
            "completedAtMs": 1000,
            "item": row,
        }}

    def complete(self, status="completed"):
        return {"method": "turn/completed", "params": {
            "threadId": "test-thread-1",
            "turn": {"id": "test-turn-1", "status": status},
        }}

    def build(self, *, with_tool=False):
        state, report, status = candidate.observe(None, self.start())
        self.assertEqual((status, report), ("started", None))
        state, report, status = candidate.observe(
            state, self.item("userMessage", iid="u-1")
        )
        self.assertEqual((status, report), ("user_candidate", None))
        if with_tool:
            state, report, status = candidate.observe(
                state, self.item("commandExecution", iid="tool-1",
                                 aggregatedOutput="PRIVATE_TOOL_OUTPUT")
            )
            self.assertEqual((status, report), ("ignored_nonchat", None))
        state, report, status = candidate.observe(
            state, self.item("agentMessage", iid="a-1")
        )
        self.assertEqual((status, report), ("assistant_candidate", None))
        return state

    def test_complete_text_only_turn_is_untrusted_not_authorized(self):
        state = self.build(with_tool=True)
        self.assertEqual(state.user_text, "  Original user 🧪 中文 \n  ")
        self.assertEqual(state.assistant_text, " Original reply 🚀\n ")
        closed, report, status = candidate.observe(state, self.complete())
        self.assertEqual((closed.phase, status), ("closed", "untrusted_candidate"))
        self.assertEqual(report.other_item_count, 1)
        self.assertEqual(report.verdict, "untrusted_v2_candidate_not_archivable")
        for key in ("complete_ui_coverage", "authentic_host_origin",
                    "authenticated_scope", "consent_verified", "writer_admitted"):
            self.assertIs(getattr(report, key), False)
        self.assertEqual(candidate.archive_admission(report)["status"], "blocked")
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(closed, self.complete())

    def test_cannot_self_assert_trust_private_consent_or_authority(self):
        start = self.start(trusted=True, authenticated=True,
                           consent=True, private=False, scope="operator")
        state, _, _ = candidate.observe(None, start)
        user = self.item("userMessage", iid="u1",
                         signed=True, attested=True, allowed=True)
        user["params"]["authenticated"] = True
        user["params"]["consent_verified"] = True
        state, _, _ = candidate.observe(state, user)
        state, _, _ = candidate.observe(
            state, self.item("agentMessage", iid="a1",
                             provenance="verified", scope="operator")
        )
        state, report, _ = candidate.observe(state, self.complete())
        self.assertFalse(report.authentic_host_origin)
        self.assertFalse(report.consent_verified)
        self.assertFalse(report.authenticated_scope)
        with mock.patch.object(candidate,
                               "_APP_SERVER_OWNED_TRANSPORT_ADMITTED", True):
            self.assertEqual(candidate.archive_admission(report)["status"], "blocked")
        self.assertFalse(
            (Path(__file__).resolve().parents[2] / "packages"
             / "ai-verse-codex-learning" / "NONEXISTENT-archive.jsonl").exists()
        )

    def test_missing_start_and_resume_history_are_not_imported(self):
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(None, self.item("userMessage"))
        for bad in (
            {"method": "thread/resumed", "params": {}},
            self.start(turn="test-turn-1",
                       resumed=True),
            self.start(thread="test-thread-1", source="resume"),
        ):
            if bad["method"] == "turn/started":
                # Unlike hook SessionStart, v2 events do not promise a
                # trusted fresh-history boundary based on caller metadata.
                state, _, _ = candidate.observe(None, bad)
                self.assertEqual(state.phase, "in_progress")
                self.assertFalse(candidate._APP_SERVER_OWNED_TRANSPORT_ADMITTED)
            else:
                with self.assertRaises(candidate.CandidateBlocked):
                    candidate.observe(None, bad)

    def test_wrong_thread_and_wrong_turn_refuse(self):
        for change in (
            {"threadId": "foreign-thread"},
            {"turnId": "foreign-turn"},
        ):
            state, _, _ = candidate.observe(None, self.start())
            row = self.item("userMessage")
            row["params"].update(change)
            with self.subTest(change=change), self.assertRaises(candidate.CandidateBlocked):
                candidate.observe(state, row)

    def test_missing_user_or_assistant_before_completion_refuses(self):
        state, _, _ = candidate.observe(None, self.start())
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, self.complete())
        state, _, _ = candidate.observe(state, self.item("userMessage"))
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, self.complete())

    def test_failed_and_interrupted_turns_refuse(self):
        for status in ("failed", "interrupted", "inProgress", "unknown"):
            with self.subTest(status=status):
                with self.assertRaises(candidate.CandidateBlocked):
                    candidate.observe(self.build(), self.complete(status))

    def test_duplicate_user_agent_and_item_identity_refuse(self):
        state, _, _ = candidate.observe(None, self.start())
        state, _, _ = candidate.observe(state, self.item("userMessage", iid="u-1"))
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, self.item("userMessage", iid="u-2"))
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, self.item("agentMessage", iid="u-1"))
        state, _, _ = candidate.observe(state, self.item("agentMessage", iid="a-1"))
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, self.item("agentMessage", iid="a-2"))

    def test_unsupported_user_media_or_multiple_blocks_fail(self):
        for content in (
            [{"type": "image", "url": "PRIVATE_IMAGE_URL"}],
            [{"type": "text", "text": "one"}, {"type": "text", "text": "two"}],
            [{"type": "text", "text": "one"}, {"type": "image"}],
            [], "literal-not-list", None,
        ):
            with self.subTest(shape=type(content).__name__):
                state, _, _ = candidate.observe(None, self.start())
                row = self.item("userMessage")
                row["params"]["item"]["content"] = content
                with self.assertRaises(candidate.CandidateBlocked):
                    candidate.observe(state, row)

    def test_nonfinal_or_undesignated_assistant_phase_refuses(self):
        for phase in ("commentary", "partial_answer", "unknown", ""):
            state, _, _ = candidate.observe(None, self.start())
            state, _, _ = candidate.observe(state, self.item("userMessage"))
            with self.subTest(phase=phase), self.assertRaises(candidate.CandidateBlocked):
                candidate.observe(state, self.item("agentMessage", phase=phase))
        state, _, _ = candidate.observe(None, self.start())
        state, _, _ = candidate.observe(state, self.item("userMessage"))
        message = self.item("agentMessage")
        del message["params"]["item"]["phase"]
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, message)

    def test_ignores_tool_reasoning_plan_and_deltas_not_as_chat_text(self):
        state, _, _ = candidate.observe(None, self.start())
        for index, kind in enumerate(sorted(candidate.NON_CHAT_ITEMS)):
            event = self.item(kind, iid="nonchat-" + str(index),
                              text="PRIVATE-NONCHAT-TEXT")
            state, report, status = candidate.observe(state, event)
            self.assertEqual((report, status), (None, "ignored_nonchat"))
        for method in ("item/agentMessage/delta", "item/plan/delta",
                       "item/reasoning/summaryTextDelta",
                       "item/reasoning/textDelta",
                       "item/commandExecution/outputDelta"):
            state, report, status = candidate.observe(
                state, {"method": method, "params": {
                    "threadId": "test-thread-1", "turnId": "test-turn-1",
                    "delta": "PRIVATE-DELTA",
                }}
            )
            self.assertEqual((report, status), (None, "ignored_delta"))
        self.assertNotIn("PRIVATE", repr(state))
        self.assertEqual(state.other_items, len(candidate.NON_CHAT_ITEMS))

    def test_unknown_item_or_lifecycle_event_fails_closed(self):
        state, _, _ = candidate.observe(None, self.start())
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, self.item("unexpectedVisibleItem"))
        for method in ("thread/started", "thread/forked", "turn/steered",
                       "turn/interrupt", "turn/started", "thread/reverted",
                       "unexpected/changed"):
            with self.subTest(method=method), self.assertRaises(candidate.CandidateBlocked):
                candidate.observe(state, {"method": method, "params": {
                    "threadId": "test-thread-1", "turnId": "test-turn-1",
                }})

    def test_caller_injected_notification_id_is_not_a_server_notification(self):
        state, _, _ = candidate.observe(None, self.start())
        payload = self.item("userMessage")
        payload["id"] = 123
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(state, payload)

    def test_invalid_unicode_empty_and_message_size_refuse(self):
        values = ["", "\ud800", "x" * (candidate.MAX_MESSAGE_BYTES + 1)]
        for value in values:
            with self.subTest(length=len(value)):
                state, _, _ = candidate.observe(None, self.start())
                row = self.item("userMessage", text=value)
                with self.assertRaises(candidate.CandidateBlocked):
                    candidate.observe(state, row)

    def test_event_bound_and_start_with_existing_items_fail_closed(self):
        bad = self.start()
        bad["params"]["turn"]["items"] = [{"type": "userMessage"}]
        with self.assertRaises(candidate.CandidateBlocked):
            candidate.observe(None, bad)
        with mock.patch.object(candidate, "MAX_EVENTS", 2):
            state, _, _ = candidate.observe(None, self.start())
            state, _, _ = candidate.observe(state, self.item("userMessage"))
            with self.assertRaises(candidate.CandidateBlocked):
                candidate.observe(state, self.item("agentMessage"))

    def test_no_persisted_files_or_host_connections(self):
        state = self.build()
        _, report, _ = candidate.observe(state, self.complete())
        self.assertEqual(report.writer_admitted, False)
        with mock.patch("builtins.open", side_effect=AssertionError("IO forbidden")):
            with mock.patch.object(Path, "read_bytes",
                                   side_effect=AssertionError("IO forbidden")):
                with mock.patch.object(Path, "write_bytes",
                                       side_effect=AssertionError("IO forbidden")):
                    self.assertEqual(
                        candidate.archive_admission(report)["status"], "blocked"
                    )


if __name__ == "__main__":
    unittest.main()
