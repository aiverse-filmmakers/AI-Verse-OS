"""Synthetic-only Codex hook-field observation and privacy regression tests.

Never run against a user's Codex storage, hooks or actual transcript. No
runtime/host installation or canonical archive write occurs in this module.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
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

    def test_bridge_generated_review_continuation_is_not_human_text(self):
        state = self.start()
        with self.assertRaises(c.CodexObservationBlocked) as caught:
            c.observe(state, self.prompt(
                value="AI_VERSE_REVIEW_CONTINUATION token=synthetic_only"
            ))
        self.assertEqual(str(caught.exception),
                         "internal continuation is not visible user text")

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




class CurrentOSTurnCorrelationTests(unittest.TestCase):
    """Real OS Bridge implementation, but only disposable synthetic OS state."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aiverse-codex-3a-bound-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "os"
        self.root.mkdir()
        (self.root / "AI-VERSE.yaml").write_text(
            'schema_version: "2.0"\narchitecture: unified-workspace\n',
            encoding="utf-8",
        )
        self.ext = self.root / ".aiverse/extensions/ai-verse-codex-learning"
        self.ext.mkdir(parents=True)
        registry = {"schema_version": "1.0", "extensions": {
            "ai-verse-codex-learning": {
                "id": "ai-verse-codex-learning", "supported": True,
                "installed": True, "enabled": True,
            }
        }}
        (self.ext.parent / "registry.json").write_text(json.dumps(registry))
        self.alpha = self.root / "workspaces/alpha"
        self.beta = self.root / "workspaces/beta"
        for w in (self.alpha, self.beta):
            w.mkdir(parents=True)
            self.manifest(w, status="active")
        spec = importlib.util.spec_from_file_location(
            "_real_os_codex_bridge_3a_fixture",
            MODULE_PATH.with_name("bridge.py"),
        )
        self.os_bridge_module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.os_bridge_module
        spec.loader.exec_module(self.os_bridge_module)
        self.bridge = self.os_bridge_module.Bridge(self.root)
        self.session = "fixture-os-session"
        self.turn = "fixture-original-turn"
        self.prompt = "Exact workspace-bound prompt 🧪 中文"
        self.cwd = str(self.alpha)
        self.scope = "workspace:alpha"
        self.seed_turn()

    def manifest(self, folder, status="active"):
        (folder / "WORKSPACE.yaml").write_text(
            f'schema_version: "2.0"\nid: "{folder.name}"\nstatus: {status}\n',
            encoding="utf-8",
        )

    def seed_turn(self, *, scope=None, allowed=None, ambiguous=None,
                  prompt=None, turn=None, age_seconds=0,
                  permission="default", state="active"):
        prompt = self.prompt if prompt is None else prompt
        scope = self.scope if scope is None else scope
        turn = self.turn if turn is None else turn
        sha = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        self.bridge.save({
            "schema_version": 1, "session_id": self.session, "scope": scope,
            "turn": {
                "id": turn, "scope": scope, "allowed": (
                    [scope] if allowed is None else allowed
                ),
                "ambiguous": [] if ambiguous is None else ambiguous,
                "state": state, "created": time.time() - age_seconds,
                "prompt_hash": sha, "permission_mode": permission,
                "sources": {"user": {"sha256": sha}},
            },
        })

    def event(self, kind="UserPromptSubmit", **extra):
        defaults = {
            "session_id": self.session, "cwd": self.cwd,
            "turn_id": self.turn, "hook_event_name": kind,
            "permission_mode": "default",
        }
        if kind == "SessionStart":
            defaults["source"] = "startup"
        elif kind == "UserPromptSubmit":
            defaults["prompt"] = self.prompt
        elif kind == "Stop":
            defaults["stop_hook_active"] = False
            defaults["last_assistant_message"] = "Completed answer (not host proven)"
        return {**defaults, **extra}

    def observation(self, kind="UserPromptSubmit"):
        start = self.event("SessionStart")
        state, _, _ = c.observe(None, start)
        event = self.event()
        state, user, _ = c.observe(state, event)
        if kind == "UserPromptSubmit":
            return event, state, user
        event = self.event("Stop")
        state, assistant, _ = c.observe(state, event)
        return event, state, assistant

    def check(self, kind="UserPromptSubmit"):
        event, state, observation = self.observation(kind)
        return c.correlate_current_os_turn(
            self.bridge, event, state, observation
        )

    def assert_blocked(self, event, state, observation):
        with self.assertRaises(c.CodexObservationBlocked) as caught:
            c.correlate_current_os_turn(
                self.bridge, event, state, observation
            )
        self.assertEqual(str(caught.exception),
                         "OS hook correlation unavailable")
        self.assertNotIn(self.prompt, str(caught.exception))

    def test_current_original_prompt_matches_existing_os_bound_turn(self):
        result = self.check()
        self.assertEqual(result.scope, "workspace:alpha")
        self.assertEqual(result.session_id, self.session)
        self.assertEqual(result.turn_id, self.turn)
        self.assertEqual(result.status,
                         "correlated_untrusted_hook_not_authorized")
        self.assertFalse(hasattr(result, "authorization_token"))
        self.assertFalse(hasattr(result, "issuer"))
        self.assertFalse(
            (self.root / "archives/private-chat-history").exists()
        )

    def test_stop_is_only_correlated_not_attested_as_host_text(self):
        result = self.check("Stop")
        self.assertEqual(result.status,
                         "correlated_untrusted_hook_not_authorized")
        self.assertEqual(result.scope, "workspace:alpha")
        # The OS bridge did not store a digest of the original assistant
        # message. Correlation must NOT imply a signed text witness.
        _, state, observation = self.observation("Stop")
        fake = self.event("Stop", last_assistant_message="Forged answer")
        self.assertNotEqual(fake["last_assistant_message"],
                            observation.text)
        self.assert_blocked(fake, state, observation)

    def test_original_prompt_hash_and_existing_source_must_both_match(self):
        event, state, observation = self.observation()
        self.seed_turn(prompt="different original prompt")
        self.assert_blocked(event, state, observation)
        self.seed_turn()
        saved = self.bridge.state(self.session)
        saved["turn"]["sources"]["user"]["sha256"] = "0" * 64
        self.bridge.save(saved)
        self.assert_blocked(event, state, observation)

    def test_other_session_turn_cwd_and_identity_cannot_rebind(self):
        event, state, observation = self.observation()
        for delta in (
            {"session_id": "other-session"},
            {"turn_id": "foreign-turn"},
            {"cwd": str(self.beta)},
            {"permission_mode": "plan"},
        ):
            with self.subTest(delta=delta):
                self.assert_blocked({**event, **delta}, state, observation)
        self.seed_turn(turn="another-current-turn")
        self.assert_blocked(event, state, observation)

    def test_multi_scope_or_ambiguous_destination_rejected(self):
        event, state, observation = self.observation()
        for allowed, ambiguous in (
            (["workspace:alpha", "workspace:beta"], []),
            (["workspace:alpha", "operator"], []),
            (["workspace:alpha"], [{"name": "beta", "could_mean": []}]),
        ):
            self.seed_turn(allowed=allowed, ambiguous=ambiguous)
            self.assert_blocked(event, state, observation)

    def test_revoked_workspace_is_rechecked_per_correlation(self):
        event, state, observation = self.observation()
        self.assertEqual(
            c.correlate_current_os_turn(
                self.bridge, event, state, observation
            ).scope, "workspace:alpha"
        )
        self.manifest(self.alpha, status="paused")
        self.assert_blocked(event, state, observation)
        self.manifest(self.alpha, status="active")
        self.assertEqual(self.check().scope, "workspace:alpha")

    def test_stale_cancelled_plan_and_reviewed_turn_refuse(self):
        event, state, observation = self.observation()
        self.seed_turn(age_seconds=100000)
        self.assert_blocked(event, state, observation)
        self.seed_turn(state="reviewed")
        self.assert_blocked(event, state, observation)
        self.seed_turn(permission="plan")
        self.assert_blocked(event, state, observation)
        self.seed_turn()
        cancellation = self.bridge.session_path(self.session).with_suffix(
            ".cancel"
        )
        cancellation.write_text(json.dumps({
            "schema_version": 1, "session_id": self.session,
            "original_turn_id": self.turn,
        }))
        self.assert_blocked(event, state, observation)

    def test_symlink_or_missing_cwd_never_claims_workspace(self):
        event, state, observation = self.observation()
        other = self.root / "workspaces/link-to-alpha"
        try:
            other.symlink_to(self.alpha, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable on runner")
        self.assert_blocked(
            {**event, "cwd": str(other)}, state, observation
        )
        self.assert_blocked(
            {**event, "cwd": str(self.root / "absent")},
            state, observation,
        )

    def test_physical_symlink_rejected_even_when_transient_cwd_matches(self):
        # A superficial mismatch test never reaches the physical path
        # validator. Construct a consistent synthetic prospective sequence
        # that uses the symlink at every event, then require OS refusal.
        link = self.root / "workspaces/alpha-link"
        try:
            link.symlink_to(self.alpha, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable on runner")
        self.cwd = str(link)
        event, state, observation = self.observation()
        self.assertEqual(state.cwd, self.cwd)
        self.assert_blocked(event, state, observation)

    def test_textual_project_mention_from_operator_root_is_not_physical_scope(self):
        self.cwd = str(self.root)
        self.scope = "workspace:alpha"
        self.seed_turn()
        event, state, observation = self.observation()
        self.assert_blocked(event, state, observation)

    def test_operator_only_bound_turn_can_be_correlated(self):
        self.cwd = str(self.root)
        self.scope = "operator"
        self.seed_turn()
        result = self.check()
        self.assertEqual(result.scope, "operator")
        self.assertEqual(result.status,
                         "correlated_untrusted_hook_not_authorized")

    def test_not_enabled_connection_and_wrong_harness_refuse(self):
        event, state, observation = self.observation()
        with mock.patch.object(self.bridge, "registered", return_value=False):
            self.assert_blocked(event, state, observation)
        self.bridge.harness = "claude"
        self.assert_blocked(event, state, observation)

    def test_no_persisted_archive_or_host_issuer_even_with_valid_os_match(self):
        response = self.check()
        self.assertFalse(c._HOST_EVENTS_ADMITTED)
        self.assertFalse(c._AT_TIME_SCOPE_ISSUER_ADMITTED)
        self.assertEqual(
            c.capture_hook(self.bridge, self.event()),
            {"status": "blocked", "reason": "codex host capture unadmitted"}
        )
        self.assertEqual(response.status,
                         "correlated_untrusted_hook_not_authorized")
        self.assertFalse(
            (self.root / "archives/private-chat-history").exists()
        )



if __name__ == "__main__":
    unittest.main()
