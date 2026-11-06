"""Synthetic-only Codex hook-field observation and privacy regression tests.

Never run against a user's Codex storage, hooks or actual transcript. No
runtime/host installation or canonical archive write occurs in this module.
"""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[2] / "packages"
    / "ai-verse-codex-learning" / "codex_capture.py"
)
spec = importlib.util.spec_from_file_location("_codex_3a_prospective_fixture",
                                              MODULE_PATH)
c = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = c
spec.loader.exec_module(c)


class CodexProspectiveFixtureTests(unittest.TestCase):
    def setUp(self):
        self.session = "codex-session-01"
        self.cwd = "/synthetic/os/workspaces/film"
        self.root = self.hook("SessionStart", source="startup")

    def hook(self, name, **extra):
        return {
            "session_id": self.session,
            "cwd": self.cwd,
            "hook_event_name": name,
            "transcript_path": "/untrusted/DO-NOT-READ-private-rollout.jsonl",
            **extra,
        }

    def prompt(self, turn="turn-one", value="  Hello 🧪 中文\n\tkeep exact  "):
        return self.hook("UserPromptSubmit", turn_id=turn,
                         permission_mode="default", prompt=value)

    def stop(self, turn="turn-one", value="Result with 🚀\n exact whitespace  "):
        return self.hook("Stop", turn_id=turn, stop_hook_active=False,
                         last_assistant_message=value)

    def start(self):
        state, observation, status = c.observe(None, self.root)
        self.assertEqual(status, "candidate_boundary")
        self.assertIsNone(observation)
        return state

    def test_default_and_mocked_code_gates_never_open_writer(self):
        event = self.prompt()
        self.assertEqual(c.capture_hook(None, event),
                         {"status": "blocked",
                          "reason": "codex host capture unadmitted"})
        with (mock.patch.object(c, "_HOST_EVENTS_ADMITTED", True),
              mock.patch.object(c, "_AT_TIME_SCOPE_ISSUER_ADMITTED", True)):
            self.assertEqual(c.capture_hook(None, event),
                             {"status": "blocked",
                              "reason": "codex scoped writer not implemented"})
        self.assertFalse(c._HOST_EVENTS_ADMITTED)
        self.assertFalse(c._AT_TIME_SCOPE_ISSUER_ADMITTED)

    def test_prospective_user_and_last_assistant_field_preserve_exact_text(self):
        state = self.start()
        event = self.prompt()
        state, user, status = c.observe(state, event)
        self.assertEqual((status, user.role, user.source_field, user.sequence),
                         ("observed", "user", "prompt", 1))
        self.assertEqual(user.text, event["prompt"])
        self.assertEqual(user.coverage, "one_codex_hook_field_not_full_transcript")
        state, assistant, status = c.observe(state, self.stop())
        self.assertEqual((status, assistant.role, assistant.source_field,
                          assistant.sequence),
                         ("observed", "assistant", "last_assistant_message", 2))
        self.assertEqual(assistant.text, self.stop()["last_assistant_message"])
        self.assertEqual(state.phase, "ready")
        self.assertEqual(state.next_sequence, 3)
        self.assertNotIn(user.text, repr(state))
        self.assertNotIn(assistant.text, repr(state))

    def test_two_complete_turns_are_sequenced_without_importing_old_history(self):
        state = self.start()
        observations = []
        for turn in ("turn-one", "turn-two"):
            state, user, _ = c.observe(state, self.prompt(turn, "Prompt " + turn))
            observations.append(user)
            state, assistant, _ = c.observe(
                state, self.stop(turn, "Answer " + turn)
            )
            observations.append(assistant)
        self.assertEqual([x.sequence for x in observations], [1, 2, 3, 4])
        self.assertEqual([x.role for x in observations],
                         ["user", "assistant", "user", "assistant"])
        self.assertEqual(len({x.source_event_id for x in observations}), 4)

    def test_no_read_of_host_transcript_or_private_tool_payload(self):
        state = self.start()
        source = self.prompt()
        source.update({
            "transcript_path": "/secret/archive/unknown.jsonl",
            "tool_response": {"output": "PRIVATE_TOOL_RESPONSE"},
            "thinking": "PRIVATE_REASONING",
        })
        with (mock.patch("builtins.open", side_effect=AssertionError("file read")),
              mock.patch.object(Path, "read_bytes",
                                side_effect=AssertionError("file read")),
              mock.patch.object(Path, "read_text",
                                side_effect=AssertionError("file read"))):
            state, observed, _ = c.observe(state, source)
            state, ignored, status = c.observe(
                state, self.hook("PostToolUse",
                                 tool_response={"output": "PRIVATE_TOOL_RESPONSE"},
                                 thinking="PRIVATE_REASONING"),
            )
            self.assertIsNone(ignored)
            self.assertEqual(status, "ignored_tool")
            state, answer, _ = c.observe(state, self.stop())
        self.assertEqual(observed.text, source["prompt"])
        self.assertNotIn("PRIVATE_TOOL_RESPONSE", repr(state))
        self.assertNotIn("PRIVATE_REASONING", repr(state))
        self.assertEqual(answer.role, "assistant")

    def test_resume_fork_compact_clear_are_not_authorized_new_boundaries(self):
        for source in ("resume", "fork", "compact", "clear", "invalid", None):
            with self.subTest(source=source):
                with self.assertRaises(c.CodexObservationBlocked):
                    c.observe(None, self.hook("SessionStart", source=source))
        state = self.start()
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.root)

    def test_unsolicited_stop_or_prompt_before_start_are_refused(self):
        for event in (self.prompt(), self.stop(), self.hook("PostToolUse")):
            with self.subTest(event=event["hook_event_name"]):
                with self.assertRaises(c.CodexObservationBlocked):
                    c.observe(None, event)

    def test_duplicate_prompt_and_stop_are_idempotent_only_if_exact(self):
        state = self.start()
        state, first, _ = c.observe(state, self.prompt())
        replay, emitted, status = c.observe(state, self.prompt())
        self.assertIsNone(emitted)
        self.assertEqual(status, "replayed_prompt")
        self.assertEqual(replay, state)
        state, assistant, _ = c.observe(state, self.stop())
        replay, emitted, status = c.observe(state, self.stop())
        self.assertEqual(status, "replayed_stop")
        self.assertIsNone(emitted)
        self.assertEqual(replay, state)
        self.assertNotEqual(first.source_event_id, assistant.source_event_id)
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.stop(value="mutated assistant"))
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.prompt())

    def test_changed_prompt_and_overlapping_turn_refuse(self):
        state, _, _ = c.observe(self.start(), self.prompt())
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.prompt(value="altered"))
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.prompt(turn="another"))
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.stop(turn="wrong"))

    def test_changed_cwd_or_session_between_events_refuse(self):
        state = self.start()
        for override in ({"cwd": "/synthetic/os/workspaces/another"},
                         {"session_id": "other-session"}):
            with self.subTest(override=override):
                with self.assertRaises(c.CodexObservationBlocked):
                    c.observe(state, {**self.prompt(), **override})

    def test_interrupt_is_terminal_and_does_not_commit_pending_message(self):
        state, _, _ = c.observe(self.start(), self.prompt())
        state, text, status = c.observe(
            state, self.hook("Interrupt", turn_id="turn-one"))
        self.assertEqual((state.phase, text, status), ("closed", None, "closed"))
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.stop())
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.prompt(turn="future"))
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.root)

    def test_interrupt_wrong_turn_refused(self):
        state, _, _ = c.observe(self.start(), self.prompt())
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.hook("Interrupt", turn_id="foreign"))

    def test_end_session_terminal_and_uncertain_stop_is_refused(self):
        state, _, _ = c.observe(self.start(), self.prompt())
        state, observed, status = c.observe(state, self.hook("SessionEnd"))
        self.assertEqual((state.phase, observed, status),
                         ("closed", None, "closed"))
        with self.assertRaises(c.CodexObservationBlocked):
            c.observe(state, self.stop())

    def test_continuation_and_missing_assistant_field_fail_closed(self):
        state, _, _ = c.observe(self.start(), self.prompt())
        bad = [
            self.hook("Stop", turn_id="turn-one", stop_hook_active=True,
                      last_assistant_message="continuation"),
            self.hook("Stop", turn_id="turn-one",
                      last_assistant_message="missing boolean"),
            self.hook("Stop", turn_id="turn-one", stop_hook_active=False,
                      last_assistant_message=None),
            self.hook("Stop", turn_id="turn-one", stop_hook_active=False,
                      last_assistant_message=""),
        ]
        for event in bad:
            with self.subTest(event=event), self.assertRaises(
                c.CodexObservationBlocked
            ):
                c.observe(state, event)

    def test_invalid_id_cwd_permission_and_text_fails_closed(self):
        cases = [
            {"session_id": "../malicious"},
            {"cwd": "relative/workspace"},
            {"cwd": "/workspace/../escape"},
            {"cwd": "/workspace/./subfolder"},
            {"cwd": "/workspace//subfolder"},
            {"cwd": "/workspace\x00bad"},
            {"turn_id": ".."},
            {"permission_mode": "bypassPermissions"},
            {"permission_mode": "unknown"},
            {"prompt": "\ud800"},
            {"prompt": ""},
            {"prompt": "x" * (c.MAX_TEXT_BYTES + 1)},
        ]
        for update in cases:
            with self.subTest(update=str(list(update))):
                state = self.start()
                with self.assertRaises(c.CodexObservationBlocked) as caught:
                    c.observe(state, {**self.prompt(), **update})
                self.assertNotIn("malicious", str(caught.exception))
                self.assertNotIn("escape", str(caught.exception))

    def test_sequence_budget_rejects_unbounded_turns(self):
        with mock.patch.object(c, "MAX_TURN_PAIRS", 1):
            state, _, _ = c.observe(self.start(), self.prompt())
            state, _, _ = c.observe(state, self.stop())
            with self.assertRaises(c.CodexObservationBlocked):
                c.observe(state, self.prompt(turn="turn-two"))

    def test_no_arbitrary_event_may_become_visible_text(self):
        state = self.start()
        for kind in ("PreModelRequest", "PostModelRequest",
                     "SubagentStop", "PermissionRequest", "PreToolUse"):
            event = self.hook(kind, prompt="PRIVATE_SIDECHAIN",
                              last_assistant_message="PRIVATE_SIDECHAIN",
                              tool_response="PRIVATE_SIDECHAIN")
            state2, observation, status = c.observe(state, event)
            self.assertEqual((state2, observation, status),
                             (state, None, "ignored_unverified_event"))


if __name__ == "__main__":
    unittest.main()
