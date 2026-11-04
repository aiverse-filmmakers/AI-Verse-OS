"""Claude Code adapter checks: labels, event adapter, note files, install lifecycle, corrections."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import unittest
from unittest.mock import patch

from bridge import Bridge, EXT, Refused
from test_bridge import ADMISSION, fixture

BRIDGE_FILE = EXT / "bridge.py"


def memory_candidate(text="The validated filter retained all twelve correct records.", quote=None):
    return {"route": "memory", "parameters": {"type": "lesson", "text": text, "confidence": .95,
                                              "admission": dict(ADMISSION)},
            "evidence": [{"source_id": "user", "quote": quote or "filter retained all twelve correct records."}]}


def review_payload(candidates=None):
    return {"topic": "Filter verification", "summary": "The filtering result was verified.",
            "outcomes": [], "unresolved": [], "candidates": candidates or [], "persist_digest": False}


class ClaudeFixture(unittest.TestCase):
    harness = "claude"

    def setUp(self):
        self.temp, self.root = fixture()
        self.addCleanup(self.temp.cleanup)
        self.bridge = Bridge(self.root, harness=self.harness)
        self.session = "claude-session-0001"

    def event(self, kind, **extra):
        return {"session_id": self.session, "cwd": str(self.root), "hook_event_name": kind,
                "permission_mode": "default", **extra}

    def start(self, prompt="The validated filter retained all twelve correct records.", **extra):
        return self.bridge.hook(self.event("UserPromptSubmit", turn_id="turn-1", prompt=prompt, **extra))

    def turn(self):
        return self.bridge.state(self.session)["turn"]

    def cli(self, *args, stdin="", harness=None, root=None):
        command = [sys.executable, str(self.root / ".aiverse/extensions/ai-verse-codex-learning/bridge.py"),
                   "--root", str(root or self.root)]
        if harness:
            command += ["--harness", harness]
        return subprocess.run(command + list(args), input=stdin, capture_output=True, text=True, timeout=60)


class HarnessLabelTests(ClaudeFixture):
    def captured_owner_calls(self, bridge):
        calls = []
        original = bridge.owner

        def recording(operation, payload):
            calls.append((operation, payload))
            return original(operation, payload)
        return calls, patch.object(bridge, "owner", recording)

    def run_review(self, bridge, session):
        bridge.hook({"session_id": session, "turn_id": "turn-1", "cwd": str(self.root),
                     "hook_event_name": "UserPromptSubmit", "permission_mode": "default",
                     "prompt": "The validated filter retained all twelve correct records."})
        turn = bridge.state(session)["turn"]
        return bridge.review(session, turn["id"], turn["token"], review_payload([memory_candidate()]))

    def test_claude_labels_on_effects_and_refs(self):
        calls, hook = self.captured_owner_calls(self.bridge)
        with hook:
            receipt = self.run_review(self.bridge, self.session)
        learn = [payload for operation, payload in calls if operation == "learn"][0]
        self.assertTrue(learn["effect_id"].startswith("claude:"), learn["effect_id"])
        self.assertTrue(all(ref.startswith("claude:turn:") for ref in learn["refs"]), learn["refs"])
        self.assertEqual(receipt["effects"][0]["result"]["result"]["memory_capture"]["state"], "captured")
        files = [f.read_text() for f in (self.root / "operator/memory").rglob("*.md")]
        self.assertTrue(any("claude-code:completed-turn" in text for text in files))
        self.assertFalse(any("codex-desktop" in text for text in files))

    def test_default_harness_keeps_codex_labels(self):
        codex = Bridge(self.root)
        calls, hook = self.captured_owner_calls(codex)
        with hook:
            self.run_review(codex, "codex-session-0001")
        learn = [payload for operation, payload in calls if operation == "learn"][0]
        self.assertTrue(learn["effect_id"].startswith("codex:"))
        self.assertTrue(all(ref.startswith("codex:turn:") for ref in learn["refs"]))
        files = [f.read_text() for f in (self.root / "operator/memory").rglob("*.md")]
        self.assertTrue(any("codex-desktop:completed-turn" in text for text in files))

    def test_owner_subprocess_inherits_the_harness(self):
        recorded = []
        original = subprocess.run

        def spy(command, *args, **kwargs):
            recorded.append(list(command))
            return original(command, *args, **kwargs)
        with patch("bridge.subprocess.run", spy):
            Bridge(self.root, harness="claude").owner("describe", {})
            Bridge(self.root).owner("describe", {})
        self.assertEqual(recorded[0][2:6], ["--root", str(self.root), "--harness", "claude"])
        self.assertEqual(recorded[1][2:5], ["--root", str(self.root), "owner"])
        self.assertNotIn("--harness", recorded[1])

    def test_cli_owner_call_writes_claude_labels(self):
        payload = {"scope": "operator", "session_id": "s1", "turn_id": "t1", "route": "memory",
                   "parameters": memory_candidate()["parameters"],
                   "refs": ["claude:turn:t1:source:abcd:sha256:" + "0" * 64],
                   "effect_id": "claude:s1:t1:0:feed"}
        result = self.cli("owner", "learn", stdin=json.dumps(payload), harness="claude")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(json.loads(result.stdout)["ok"])
        files = [f.read_text() for f in (self.root / "operator/memory").rglob("*.md")]
        self.assertTrue(any("claude-code:completed-turn" in text for text in files))

    def test_printed_commands_use_the_claude_prefix(self):
        text = self.start()["hookSpecificOutput"]["additionalContext"]
        self.assertIn("--harness claude review --session", text)
        self.assertIn("--harness claude query --session", text)
        self.assertIn("--harness claude sources --session", text)
        self.assertIn("--input-file", text)
        codex_text = Bridge(self.root).hook({
            "session_id": "codex-session-0002", "turn_id": "turn-9", "cwd": str(self.root),
            "hook_event_name": "UserPromptSubmit", "permission_mode": "default",
            "prompt": "Check it."})["hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("--harness", codex_text)
        self.assertNotIn("--input-file", codex_text)
        self.assertIn("review --session", codex_text)

    def test_diagnostics_rows_carry_the_harness(self):
        self.start()
        Bridge(self.root).hook({"session_id": "codex-session-0003", "turn_id": "turn-9", "cwd": str(self.root),
                                "hook_event_name": "UserPromptSubmit", "permission_mode": "default",
                                "prompt": "Check it."})
        rows = [json.loads(line) for line in (self.root / "runtime/codex-learning/events.jsonl").read_text().splitlines()]
        self.assertEqual({row["harness"] for row in rows}, {"claude", "codex"})

    def test_intent_actor_follows_the_harness_and_shared_keys_stay(self):
        text = (EXT / "intent.py").read_text()
        self.assertNotIn('actor="codex:', text)
        self.assertIn("self.harness", text)
        for kept in ("namespace=\"codex-intent\"", "codex_capture", "codex_confirmation", "codex-correction-link:"):
            self.assertIn(kept, text)


class InputFileTests(ClaudeFixture):
    def note(self, text, name="note.json"):
        folder = self.root / "runtime/codex-learning/claude-input"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / name
        path.write_text(text)
        return path

    def review_args(self, path):
        turn = self.turn()
        return ["review", "--session", self.session, "--turn", turn["id"], "--token", turn["token"],
                "--input-file", str(path)]

    def test_review_reads_the_note_and_deletes_it(self):
        self.start()
        path = self.note(json.dumps(review_payload([memory_candidate()])))
        result = self.cli(*self.review_args(path), harness="claude")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)["state"], "reviewed")
        self.assertFalse(path.exists())

    def test_note_deleted_when_the_review_is_refused(self):
        self.start()
        bad = review_payload()
        bad["summary"] = ""
        path = self.note(json.dumps(bad))
        result = self.cli(*self.review_args(path), harness="claude")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(path.exists())

    def test_note_deleted_when_learning_is_disabled(self):
        self.start()
        config = self.root / ".aiverse/extensions/ai-verse-codex-learning/config.json"
        value = json.loads(config.read_text())
        value["enabled"] = False
        config.write_text(json.dumps(value))
        path = self.note(json.dumps(review_payload()))
        result = self.cli(*self.review_args(path), harness="claude")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(path.exists())

    def test_note_deleted_when_it_is_not_valid_json(self):
        self.start()
        path = self.note("{not json")
        result = self.cli(*self.review_args(path), harness="claude")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(path.exists())

    def test_paths_outside_the_folder_are_refused_and_left_alone(self):
        self.start()
        outside = self.root / "runtime/codex-learning/elsewhere.json"
        outside.write_text(json.dumps(review_payload()))
        sibling = self.root / "operator/profile/preferences.md"
        for target in (outside, sibling, self.root / "runtime/codex-learning/claude-input/../elsewhere.json"):
            result = self.cli(*self.review_args(target), harness="claude")
            self.assertEqual(result.returncode, 2, target)
            self.assertIn("input file", json.loads(result.stdout)["error"])
        self.assertTrue(outside.exists())
        self.assertTrue(sibling.exists())

    def test_symlink_notes_and_folders_are_refused(self):
        self.start()
        real = self.root / "runtime/codex-learning/real.json"
        real.write_text(json.dumps(review_payload()))
        folder = self.root / "runtime/codex-learning/claude-input"
        link = folder / "link.json"
        link.symlink_to(real)
        result = self.cli(*self.review_args(link), harness="claude")
        self.assertEqual(result.returncode, 2)
        self.assertTrue(real.exists())
        link.unlink()
        folder.rmdir()
        folder.symlink_to(self.root / "operator")
        result = self.cli(*self.review_args(folder / "x.json"), harness="claude")
        self.assertEqual(result.returncode, 2)

    def test_relative_hidden_and_nested_paths_are_refused(self):
        self.start()
        self.note("{}", "keep.json")
        folder = self.root / "runtime/codex-learning/claude-input"
        (folder / "nested").mkdir()
        (folder / "nested/deep.json").write_text("{}")
        (folder / ".hidden.json").write_text("{}")
        for target in ("claude-input/keep.json", folder / "nested/deep.json", folder / ".hidden.json"):
            result = self.cli(*self.review_args(target), harness="claude")
            self.assertEqual(result.returncode, 2, target)

    def test_size_limit_is_kept(self):
        self.start()
        path = self.note(" " * 2_000_001)
        result = self.cli(*self.review_args(path), harness="claude")
        self.assertEqual(result.returncode, 2)
        self.assertIn("budget", json.loads(result.stdout)["error"])
        self.assertFalse(path.exists())

    def test_codex_refuses_input_file_and_keeps_stdin(self):
        Bridge(self.root).hook({"session_id": "codex-session-0004", "turn_id": "turn-9", "cwd": str(self.root),
                                "hook_event_name": "UserPromptSubmit", "permission_mode": "default",
                                "prompt": "The validated filter retained all twelve correct records."})
        turn = Bridge(self.root).state("codex-session-0004")["turn"]
        path = self.note(json.dumps(review_payload()))
        base = ["review", "--session", "codex-session-0004", "--turn", turn["id"], "--token", turn["token"]]
        refused = self.cli(*base, "--input-file", str(path))
        self.assertEqual(refused.returncode, 2)
        self.assertTrue(path.exists())
        accepted = self.cli(*base, stdin=json.dumps(review_payload()))
        self.assertEqual(accepted.returncode, 0, accepted.stdout)

    def test_intent_sources_and_query_accept_note_files(self):
        self.start()
        quote = self.note('A "quoted" {brace} sentence', "quote.txt")
        result = self.cli("sources", "--session", self.session, "--match", "--input-file", str(quote),
                          harness="claude")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertFalse(quote.exists())
        intent_note = self.note('{"classification":"operator-goal"}', "intent.json")
        turn = self.turn()
        result = self.cli("intent", "capture", "--scope", "operator", "--session", self.session,
                          "--turn", turn["id"], "--token", turn["token"], "--input-file", str(intent_note),
                          harness="claude")
        self.assertFalse(intent_note.exists())
        self.assertNotIn("only available to the Claude adapter", result.stdout)



class ClaudeEventTests(ClaudeFixture):
    """Events shaped like the real Claude Code ones recorded in Step 1: no turn_id."""

    def claude_event(self, kind, **extra):
        return {"session_id": self.session, "transcript_path": "/x/y.jsonl", "cwd": str(self.root),
                "hook_event_name": kind, "permission_mode": "default", **extra}

    def prompt(self, text="The validated filter retained all twelve correct records."):
        return self.bridge.hook(self.claude_event("UserPromptSubmit", prompt=text, prompt_id="p-1"))

    def set_config(self, **values):
        file = self.root / ".aiverse/extensions/ai-verse-codex-learning/config.json"
        config = json.loads(file.read_text())
        config.update(values)
        file.write_text(json.dumps(config))
        self.bridge = Bridge(self.root, harness="claude")

    def test_a_session_start_returns_profile_context(self):
        result = self.bridge.hook(self.claude_event("SessionStart", source="startup"))
        text = result["hookSpecificOutput"]["additionalContext"]
        self.assertEqual(result["hookSpecificOutput"]["hookEventName"], "SessionStart")
        self.assertIn("Use brief evidence-based answers", text)

    def test_b_prompt_creates_a_claude_turn(self):
        text = self.prompt()["hookSpecificOutput"]["additionalContext"]
        turn = self.turn()
        self.assertTrue(turn["id"].startswith("claude-"))
        self.assertRegex(turn["id"], r"^claude-[0-9a-f]{32}$")
        self.assertIn("--harness claude review --session", text)
        self.assertIn("--turn claude-", text)

    def test_c_first_tool_use_adds_a_source_and_reminds_once(self):
        self.prompt()
        first = self.bridge.hook(self.claude_event("PostToolUse", tool_name="Bash", tool_use_id="toolu_01",
                                                    tool_input={"command": "echo hi"},
                                                    tool_response={"stdout": "Evidence was verified.", "stderr": ""}))
        self.assertIn("--harness claude review", first["hookSpecificOutput"]["additionalContext"])
        self.assertIn("tool:toolu_01", self.turn()["sources"])
        second = self.bridge.hook(self.claude_event("PostToolUse", tool_name="Bash", tool_use_id="toolu_02",
                                                     tool_response={"stdout": "More."}))
        self.assertEqual(second, {})

    def test_d_review_with_the_synthesized_turn_is_routed(self):
        self.prompt()
        turn = self.turn()
        receipt = self.bridge.review(self.session, turn["id"], turn["token"],
                                     review_payload([memory_candidate()]))
        self.assertEqual(receipt["effects"][0]["result"]["result"]["memory_capture"]["state"], "captured")

    def test_e_two_prompts_make_two_turns_and_the_old_review_is_refused(self):
        self.prompt("First ask: the validated filter retained all twelve correct records.")
        old = self.turn()
        self.prompt("Second ask is about something else entirely.")
        new = self.turn()
        self.assertNotEqual(old["id"], new["id"])
        with self.assertRaises(Refused):
            self.bridge.review(self.session, old["id"], old["token"], review_payload())

    def test_f_stop_without_message_returns_empty_when_review_mode_is_off(self):
        self.set_config(review_mode="off")
        self.prompt()
        self.assertEqual(self.bridge.hook(self.claude_event("Stop", stop_hook_active=False)), {})
        self.assertEqual(self.bridge.hook(self.claude_event("Stop")), {})

    def test_g_context_stays_inside_the_budget_with_the_full_review_command(self):
        (self.root / "operator/profile/preferences.md").write_text("# Preferences\n\n" + "Prefers short plain answers. " * 300)
        (self.root / "operator/profile/identity.md").write_text("# Identity\n\n" + "Founder of a small studio. " * 300)
        (self.root / "operator/context/CURRENT.md").write_text("# Context\n\n## Current state\n\n" + "- Working on the course.\n" * 400)
        ownership = self.root / ".aiverse/direction/ownership.json"
        ownership.parent.mkdir(parents=True, exist_ok=True)
        for limit in (4096, 6000, 14000, 24000):
            self.set_config(context_max_bytes=limit)
            with patch.object(Bridge, "owner", self.rich_owner):
                text = self.prompt("What goals and priorities matter?")["hookSpecificOutput"]["additionalContext"]
            turn = self.turn()
            self.assertLessEqual(len(text.encode()), min(limit, 9000), limit)
            call = (f"--harness claude review --session {self.session} --turn {turn['id']} --token {turn['token']}")
            self.assertIn(call, text, limit)
            self.assertIn("--input-file", text)
            self.assertEqual(text.count("{"), text.count("}"), "owner JSON must not be cut in half")
            if "Owner data (JSON):\n" in text:
                json.loads(text.split("Owner data (JSON):\n", 1)[1])

    @staticmethod
    def rich_owner(self, operation, payload):
        if operation == "intent_context":
            return {"scope": "operator", "strategic_objects": {"intents": [
                {"id": f"intent-{i}", "payload": {"statement": "A long strategic goal statement. " * 12}}
                for i in range(25)]}}
        if operation == "retrieve_history_progressive":
            return {"items": [{"id": f"mem-{i}", "summary": "A long remembered outcome. " * 20} for i in range(8)]}
        if operation == "read_context":
            return {"scope": "operator", "current_context": "Context text. " * 600, "direction_owner": "brain"}
        raise Refused("unavailable")

    RULE = "Never use dashes when communicating with me or writing content for me."
    AVOID = "Avoid vague praise and filler openings."

    def large_profile(self):
        filler = lambda n, k: "\n".join(f"- {k} preference number {i} describes a detailed working habit." for i in range(n))
        (self.root / "operator/profile/preferences.md").write_text(
            "# Working Preferences\n\n## Durable writeback\n\n" + filler(10, "Writeback") +
            "\n\n### Communication\n\n" + filler(8, "Voice") + "\n- " + self.RULE + " Use commas instead.\n" +
            filler(25, "Tone") + "\n\n### Working style\n\n" + filler(40, "Style") +
            "\n\n### Quality expectations\n\n" + filler(30, "Quality") +
            "\n\n### Avoid\n\n- " + self.AVOID + "\n" + filler(10, "Avoid") + "\n")
        (self.root / "operator/profile/identity.md").write_text("# Identity\n\n" + "Founder of a small studio. " * 60)
        self.assertGreater(len((self.root / "operator/profile/preferences.md").read_bytes()), 7500)

    def test_i_communication_rules_arrive_first_at_session_start_and_prompt_submit(self):
        self.large_profile()
        for limit in (6000, 14000):
            self.set_config(context_max_bytes=limit)
            with patch.object(Bridge, "owner", self.rich_owner):
                start = self.bridge.hook(self.claude_event("SessionStart", source="startup"))
                prompt = self.prompt("What goals and priorities matter?")
            for result in (start, prompt):
                text = result["hookSpecificOutput"]["additionalContext"]
                self.assertIn(self.RULE, text, limit)
                self.assertIn(self.AVOID, text, limit)
                if "operator_profile" in text:
                    self.assertLess(text.index("operator_key_preferences"), text.index("operator_profile"))
                self.assertLessEqual(len(text.encode()), min(limit, 9000), limit)
            turn = self.turn()
            call = f"--harness claude review --session {self.session} --turn {turn['id']} --token {turn['token']}"
            self.assertIn(call, prompt["hookSpecificOutput"]["additionalContext"])
            json.loads(prompt["hookSpecificOutput"]["additionalContext"].split("Owner data (JSON):\n", 1)[1])

    def test_j_codex_context_has_no_key_preference_block(self):
        self.large_profile()
        codex = Bridge(self.root)
        with patch.object(Bridge, "owner", self.rich_owner):
            text = codex.hook(self.event("UserPromptSubmit", turn_id="turn-1", prompt="Hello there friend"))[
                "hookSpecificOutput"]["additionalContext"]
        self.assertNotIn("operator_key_preferences", text)

    def keys_at(self, prefs, limit=14000, event="prompt"):
        (self.root / "operator/profile/preferences.md").write_text(prefs)
        self.set_config(context_max_bytes=limit)
        with patch.object(Bridge, "owner", self.rich_owner):
            result = (self.prompt("What goals and priorities matter?") if event == "prompt" else
                      self.bridge.hook(self.claude_event("SessionStart", source="startup")))
        text = result["hookSpecificOutput"]["additionalContext"]
        self.assertLessEqual(len(text.encode()), min(limit, 9000), limit)
        return text, json.loads(text.split("Owner data (JSON):\n", 1)[1]).get("operator_key_preferences", {})

    def test_k_full_preferences_survive_the_minimum_budgets_with_large_intent(self):
        prefs = ("# Prefs\n\n### Communication\n\n- " + self.RULE + "\n- Keep answers short.\n\n"
                 "### Working style\n\n- Style item.\n\n### Avoid\n\n- " + self.AVOID + "\n- Avoid jargon.\n")
        for limit in (4096, 6000):
            for event in ("prompt", "start"):
                text, keys = self.keys_at(prefs, limit, event)
                self.assertEqual(keys, {"communication": [self.RULE, "Keep answers short."],
                                        "avoid": [self.AVOID, "Avoid jargon."]}, (limit, event))

    def test_l_many_long_rules_do_not_push_out_later_rules_or_the_avoid_section(self):
        rules = "\n".join(f"- Rule {i} must be followed: " + "x" * 190 for i in range(12))
        prefs = f"### Communication\n\n{rules}\n- {self.RULE}\n\n### Avoid\n\n- {self.AVOID}\n"
        for limit in (9000, 6000):
            text, keys = self.keys_at(prefs, limit)
            self.assertIn(self.RULE, keys["communication"], limit)
            self.assertEqual(keys["avoid"], [self.AVOID], limit)

    def test_m_long_items_are_kept_whole(self):
        long_rule = "Never do this thing. " + "Detail. " * 110
        self.assertGreater(len(long_rule), 900)
        text, keys = self.keys_at(f"### Communication\n\n- {long_rule}\n- {self.RULE}\n", 14000)
        self.assertEqual(keys["communication"][0], long_rule)

    def test_n_sections_are_labelled_and_nested_headings_stay_inside(self):
        prefs = ("## Communication\n\n- Be brief.\n\n### Punctuation\n\n- " + self.RULE + "\n\n"
                 "## Working style\n\n- Not a key rule.\n\n### Avoid\n\n- " + self.AVOID + "\n\n#### Detail\n\n- Avoid emoji.\n")
        text, keys = self.keys_at(prefs)
        self.assertEqual(keys, {"communication": ["Be brief.", self.RULE], "avoid": [self.AVOID, "Avoid emoji."]})
        self.assertNotIn("Not a key rule.", keys["communication"])

    def test_h_invalid_events_are_handled_without_a_crash(self):
        for bad in ({"hook_event_name": "UserPromptSubmit", "cwd": str(self.root), "prompt": "x"},
                    {"session_id": "bad id!", "hook_event_name": "UserPromptSubmit", "cwd": str(self.root), "prompt": "x"},
                    {"session_id": 7, "hook_event_name": "Stop", "cwd": str(self.root)},
                    self.claude_event("UserPromptSubmit", prompt=["not", "text"]),
                    self.claude_event("UserPromptSubmit", prompt=12),
                    "not an object", None):
            with self.assertRaises(Refused):
                self.bridge.hook(bad)
        for kind in ("PostToolUse", "Stop", "SessionEnd"):
            self.assertEqual(self.bridge.hook(self.claude_event(kind)), {})

    def test_cli_hook_is_quiet_for_bad_input_and_for_a_disabled_connection(self):
        shell = self.cli("hook", stdin=json.dumps(self.claude_event("UserPromptSubmit", prompt=3)), harness="claude")
        self.assertEqual(shell.returncode, 0)
        self.assertIn("AI-Verse hook unavailable", json.loads(shell.stdout)["systemMessage"])
        self.set_config(enabled=False)
        quiet = self.cli("hook", stdin=json.dumps(self.claude_event("UserPromptSubmit", prompt="Hello")), harness="claude")
        self.assertEqual(json.loads(quiet.stdout), {})



class ClaudeInstallTests(unittest.TestCase):
    """claude-install / claude-doctor / claude-remove in disposable package copies."""

    def setUp(self):
        import hashlib
        import tempfile
        import shutil
        from install import FILES, ID, VERSION
        self.hashlib, self.shutil, self.FILES, self.ID, self.VERSION = hashlib, shutil, FILES, ID, VERSION
        self.temp = tempfile.TemporaryDirectory(prefix="aiverse-claude-install-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "Core | Test"
        self.root.mkdir()
        (self.root / "AI-VERSE.yaml").write_text("architecture: unified-workspace\n")
        self.extension = self.root / ".aiverse/extensions" / ID
        self.extension.mkdir(parents=True)
        self.source = EXT
        self.copy_package(self.source)
        self.write_receipt()
        (self.root / ".codex").mkdir()
        (self.root / ".codex/hooks.json").write_text('{"hooks": {}}\n')
        (self.root / ".aiverse/extensions/registry.json").write_text(json.dumps({
            "schema_version": "1.0", "extensions": {ID: {"id": ID, "supported": True, "installed": True,
                                                         "enabled": True, "version": VERSION}}}))
        (self.extension / "config.json").write_text(json.dumps({"schema_version": 1, "enabled": True}))
        self.python = sys.executable
        self.settings = self.root / ".claude/settings.local.json"
        self.record = self.extension / "claude-adapter.json"

    def sha(self, path):
        return self.hashlib.sha256(Path(path).read_bytes()).hexdigest()

    def copy_package(self, source):
        for name in self.FILES:
            (self.extension / name).write_bytes((source / name).read_bytes())

    def write_receipt(self):
        files = {name: self.sha(self.extension / name) for name in self.FILES}
        (self.extension / "install-receipt.json").write_text(json.dumps(
            {"version": self.VERSION, "files": files, "python": sys.executable}))

    def install_module(self, source=None):
        import importlib
        import install
        return importlib.reload(install) if source is None else install

    def run_install(self, *args):
        return subprocess.run([sys.executable, str(self.extension / "install.py"), "--root", str(self.root), *args],
                              capture_output=True, text=True, timeout=60)

    def cmd(self, name, *extra):
        result = self.run_install(name, "--python", self.python, *extra)
        return result.returncode, json.loads(result.stdout)

    def state(self):
        return {"codex": (self.root / ".codex/hooks.json").read_bytes(),
                "registry": (self.root / ".aiverse/extensions/registry.json").read_bytes(),
                "config": (self.extension / "config.json").read_bytes(),
                "receipt": (self.extension / "install-receipt.json").read_bytes()}

    def load(self):
        return json.loads(self.settings.read_text())

    def bridge_hooks(self, settings=None):
        from lifecycle import is_ours_claude
        settings = settings or self.load()
        return [h for groups in settings.get("hooks", {}).values() for g in groups for h in g["hooks"]
                if is_ours_claude(h, self.root)]

    OTHER = {"hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [{"type": "command", "command": "echo mine"}]}],
                       "Stop": [{"hooks": [{"type": "command", "command": "echo stop"}]}]},
             "permissions": {"allow": ["Bash(ls:*)"], "deny": ["Bash(rm:*)"]},
             "env": {"A": "1"}}

    def test_merge_keeps_other_hooks_permissions_and_keys(self):
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps(self.OTHER, indent=2))
        before = self.state()
        code, out = self.cmd("claude-install")
        self.assertEqual(code, 0, out)
        settings = self.load()
        self.assertEqual(settings["env"], {"A": "1"})
        self.assertEqual(settings["permissions"]["deny"], ["Bash(rm:*)"])
        self.assertIn("Bash(ls:*)", settings["permissions"]["allow"])
        self.assertEqual(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "echo mine")
        self.assertEqual(settings["hooks"]["Stop"][0]["hooks"][0]["command"], "echo stop")
        self.assertEqual(len(self.bridge_hooks()), 5)
        self.assertIs(settings["autoMemoryEnabled"], False)
        rules = settings["permissions"]["allow"]
        for name in ("review", "sources", "query", "intent"):
            self.assertTrue(any(rule.startswith("Bash(") and f"--harness claude {name}:*)" in rule for rule in rules), name)
        self.assertTrue(any(rule.startswith("Edit(//") and rule.endswith("/runtime/codex-learning/claude-input/**)")
                           for rule in rules))
        sessions = {event: groups[0].get("matcher") for event, groups in settings["hooks"].items()
                    if event in ("SessionStart",)}
        self.assertEqual(sessions["SessionStart"], "startup|resume|clear|compact")
        timeouts = {e: [h["timeout"] for g in gs for h in g["hooks"] if "--harness" in h.get("command", "")]
                    for e, gs in settings["hooks"].items()}
        self.assertEqual(timeouts["SessionEnd"], [3])
        self.assertEqual(timeouts["UserPromptSubmit"], [30])
        self.assertEqual(self.state(), before)  # Codex hooks, registry, config and receipt untouched.

    def test_repeat_install_has_no_duplicates_and_keeps_the_baseline(self):
        self.settings.parent.mkdir()
        original = json.dumps(self.OTHER, indent=2)
        self.settings.write_text(original)
        self.cmd("claude-install")
        first = self.settings.read_bytes()
        baseline = json.loads(self.record.read_text())["original"]
        self.cmd("claude-install")
        self.assertEqual(self.settings.read_bytes(), first)
        self.assertEqual(len(self.bridge_hooks()), 5)
        record = json.loads(self.record.read_text())
        self.assertEqual(record["original"], baseline)
        self.assertTrue(record["exact_restore_ok"])

    def test_remove_restores_original_bytes(self):
        self.settings.parent.mkdir()
        original = json.dumps(self.OTHER, indent=1).encode()
        self.settings.write_bytes(original)
        self.cmd("claude-install")
        code, out = self.cmd("claude-remove")
        self.assertEqual(out["restore"], "exact")
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertFalse(self.record.exists())

    def test_absent_file_case_deletes_the_file_again(self):
        self.assertFalse(self.settings.exists())
        self.cmd("claude-install")
        self.assertTrue(self.settings.exists())
        self.cmd("claude-remove")
        self.assertFalse(self.settings.exists())
        self.assertFalse(self.record.exists())

    def test_preexisting_rule_and_memory_setting_survive_remove_after_an_edit(self):
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps({"autoMemoryEnabled": True, "permissions": {"allow": ["Bash(ls:*)"]}}))
        self.cmd("claude-install")
        added = json.loads(self.record.read_text())["added_allow_rules"]
        self.assertNotIn("Bash(ls:*)", added)
        # Pre-existing identical allow rule: install again after pre-seeding one of ours must not claim it.
        edited = self.load()
        edited["note"] = "user edit"
        self.settings.write_text(json.dumps(edited, indent=2))
        code, out = self.cmd("claude-remove")
        self.assertEqual(out["restore"], "selective")
        left = self.load()
        self.assertEqual(left["note"], "user edit")
        self.assertEqual(left["autoMemoryEnabled"], True)
        self.assertEqual(left["permissions"]["allow"], ["Bash(ls:*)"])
        self.assertNotIn("hooks", left)

    def test_a_rule_that_was_already_there_is_never_claimed_or_removed(self):
        self.settings.parent.mkdir()
        module = self.install_module()
        rules = module._claude_rules(self.root, str(Path(self.python).absolute()))
        self.settings.write_text(json.dumps({"permissions": {"allow": [rules[0]]}}))
        self.cmd("claude-install")
        self.assertNotIn(rules[0], json.loads(self.record.read_text())["added_allow_rules"])
        edited = self.load()
        edited["x"] = 1
        self.settings.write_text(json.dumps(edited))
        self.cmd("claude-remove")
        self.assertEqual(self.load()["permissions"]["allow"], [rules[0]])

    def test_install_edit_install_remove_keeps_the_edit(self):
        self.cmd("claude-install")
        edited = self.load()
        edited["extra"] = {"keep": True}
        edited["permissions"]["allow"].append("Bash(git status:*)")
        self.settings.write_text(json.dumps(edited, indent=2))
        self.cmd("claude-install")
        self.assertFalse(json.loads(self.record.read_text())["exact_restore_ok"])
        self.assertEqual(len(self.bridge_hooks()), 5)
        code, out = self.cmd("claude-remove")
        left = self.load()
        self.assertEqual(left["extra"], {"keep": True})
        self.assertEqual(left["permissions"]["allow"], ["Bash(git status:*)"])
        self.assertEqual(self.bridge_hooks(left), [])
        self.assertNotIn("autoMemoryEnabled", left)

    def test_remove_lists_entries_the_user_changed_and_leaves_them(self):
        self.cmd("claude-install")
        edited = self.load()
        handler = edited["hooks"]["Stop"][0]["hooks"][0]
        handler["timeout"] = 99
        edited["autoMemoryEnabled"] = True
        self.settings.write_text(json.dumps(edited))
        code, out = self.cmd("claude-remove")
        self.assertTrue(any("Stop" in item for item in out["left_in_place"]), out)
        self.assertTrue(any("autoMemoryEnabled" in item for item in out["left_in_place"]), out)
        left = self.load()
        self.assertEqual(left["hooks"]["Stop"][0]["hooks"][0]["timeout"], 99)
        self.assertIs(left["autoMemoryEnabled"], True)
        self.assertFalse(self.record.exists())

    def test_malformed_settings_are_refused_untouched(self):
        self.settings.parent.mkdir()
        for text in ("{not json", "[1, 2]", '{"hooks": []}', '{"permissions": {"allow": "x"}}'):
            self.settings.write_text(text)
            code, out = self.cmd("claude-install")
            self.assertEqual(code, 2, text)
            self.assertEqual(self.settings.read_text(), text)
            self.assertFalse(self.record.exists())

    def test_write_failure_rolls_back_both_files(self):
        import install
        self.settings.parent.mkdir()
        original = json.dumps(self.OTHER).encode()
        self.settings.write_bytes(original)
        real = install._atomic_write_bytes
        calls = []

        def failing(path, payload):
            calls.append(path.name)
            if path.name == "claude-adapter.json":
                raise OSError("simulated disk failure")
            return real(path, payload)
        with patch.object(install, "_atomic_write_bytes", failing):
            with self.assertRaises(OSError):
                install.claude_install(self.root, {"python": self.python})
        self.assertIn("claude-adapter.json", calls)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertFalse(self.record.exists())

    def test_refuses_when_the_package_is_not_installed_or_modified(self):
        (self.extension / "install-receipt.json").unlink()
        code, out = self.cmd("claude-install")
        self.assertEqual(code, 2)
        self.assertFalse(self.settings.exists())
        self.write_receipt()
        (self.extension / "REVIEW-SCHEMA.md").write_text("tampered")
        code, out = self.cmd("claude-install")
        self.assertEqual(code, 2)
        self.assertFalse(self.settings.exists())

    def test_claude_rows_do_not_make_codex_setup_report_execution(self):
        import install
        self.cmd("claude-install")
        build = self.sha(self.extension / "bridge.py")
        rows = [{"build": build, "event": "UserPromptSubmit", "harness": "claude"},
                {"build": build, "event": "review", "state": "reviewed", "harness": "claude"}]
        runtime = self.root / "runtime/codex-learning"
        runtime.mkdir(parents=True)
        (runtime / "events.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        with patch("install.shutil.which", return_value=None):
            result = install.setup(self.root)
        self.assertFalse(result["execution_observed"])
        self.assertFalse(result["review_observed"])
        legacy = [{"build": build, "event": "UserPromptSubmit"},
                  {"build": build, "event": "review", "state": "reviewed"}]
        (runtime / "events.jsonl").write_text("".join(json.dumps(r) + "\n" for r in legacy))
        with patch("install.shutil.which", return_value=None):
            result = install.setup(self.root)
        self.assertTrue(result["execution_observed"])
        self.assertTrue(result["review_observed"])
        summary = Bridge(self.root).execution_summary()
        self.assertTrue(summary["current_build_prompt_observed"])
        (runtime / "events.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        summary = Bridge(self.root).execution_summary()
        self.assertFalse(summary["current_build_prompt_observed"])
        self.assertFalse(summary["current_build_review_observed"])

    def test_doctor_counts_only_claude_rows_and_is_read_only(self):
        self.cmd("claude-install")
        build = self.sha(self.extension / "bridge.py")
        runtime = self.root / "runtime/codex-learning"
        runtime.mkdir(parents=True)
        (runtime / "events.jsonl").write_text(json.dumps({"build": build, "event": "UserPromptSubmit"}) + "\n")
        before = {p: p.read_bytes() for p in (self.settings, self.record)}
        code, out = self.cmd("claude-doctor", "--json")
        self.assertEqual(out["state"], "installed")
        self.assertFalse(out["execution_observed"])
        rows = [{"build": build, "event": "UserPromptSubmit", "harness": "claude"},
                {"build": build, "event": "review", "state": "reviewed", "harness": "claude"}]
        (runtime / "events.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        code, out = self.cmd("claude-doctor", "--json")
        self.assertEqual(out["state"], "ready")
        self.assertEqual({p: p.read_bytes() for p in before}, before)

    def test_update_flow_stale_build_is_reported_and_refreshed(self):
        self.settings.parent.mkdir()
        self.settings.write_text(json.dumps(self.OTHER, indent=2))
        self.cmd("claude-install")
        baseline = json.loads(self.record.read_text())["original"]
        build_a = self.sha(self.extension / "bridge.py")
        # Build B: different bridge bytes, same version, correctly refreshed package hashes.
        build_b = Path(self.temp.name) / "package-b"
        self.shutil.copytree(self.source, build_b, ignore=self.shutil.ignore_patterns("__pycache__", "hooks.json"))
        (build_b / "bridge.py").write_text((build_b / "bridge.py").read_text() + "\n# build B marker\n")
        manifest = json.loads((build_b / "PACKAGE.json").read_text())
        manifest["files"] = {name: self.hashlib.sha256((build_b / name).read_bytes()).hexdigest() for name in self.FILES}
        (build_b / "PACKAGE.json").write_text(json.dumps(manifest))
        self.copy_package(build_b)  # What an update does to the installed package files.
        self.write_receipt()
        settings_after_update = self.settings.read_bytes()
        build_b_sha = self.sha(self.extension / "bridge.py")
        self.assertNotEqual(build_a, build_b_sha)
        self.assertEqual(self.settings.read_bytes(), settings_after_update)  # install B left Claude settings alone
        # The doctor must run from the installed (new) package.
        def doctor():
            result = subprocess.run([sys.executable, str(self.extension / "install.py"), "--root", str(self.root),
                                     "claude-doctor", "--json"], capture_output=True, text=True, timeout=60)
            return json.loads(result.stdout)
        # Installed files now differ from SOURCE only if SOURCE is the old tree; the installed copy is its own source.
        report = doctor()
        self.assertEqual(report["state"], "refresh-needed", report)
        self.assertIs(report["build_matches"], False)
        code, out = self.cmd("claude-install")
        self.assertEqual(code, 0, out)
        record = json.loads(self.record.read_text())
        self.assertEqual(record["original"], baseline)
        self.assertEqual(record["build"], build_b_sha)
        settings = self.load()
        self.assertEqual(settings["env"], {"A": "1"})
        self.assertEqual(len(self.bridge_hooks(settings)), 5)
        self.assertTrue(all(build_b_sha in h["command"] for h in self.bridge_hooks(settings)))
        self.assertEqual(doctor()["state"], "installed")

    def test_removal_keeps_and_lists_a_group_whose_matcher_was_edited(self):
        self.cmd("claude-install")
        edited = self.load()
        edited["hooks"]["SessionStart"][0]["matcher"] = "startup"
        self.settings.write_text(json.dumps(edited))
        code, out = self.cmd("claude-remove")
        self.assertTrue(any("SessionStart" in item for item in out["left_in_place"]), out)
        self.assertEqual(self.load()["hooks"]["SessionStart"][0]["matcher"], "startup")

    def test_refresh_refuses_to_overwrite_an_edited_hook_and_changes_nothing(self):
        self.cmd("claude-install")
        edited = self.load()
        edited["hooks"]["Stop"][0]["hooks"][0]["timeout"] = 77
        self.settings.write_text(json.dumps(edited))
        before = (self.settings.read_bytes(), self.record.read_bytes())
        code, out = self.cmd("claude-install")
        self.assertEqual(code, 2)
        self.assertIn("edited", out["error"])
        self.assertEqual((self.settings.read_bytes(), self.record.read_bytes()), before)

    def test_doctor_does_not_report_ready_when_learning_is_disabled(self):
        self.cmd("claude-install")
        build = self.sha(self.extension / "bridge.py")
        runtime = self.root / "runtime/codex-learning"
        runtime.mkdir(parents=True)
        rows = [{"build": build, "event": "UserPromptSubmit", "harness": "claude"},
                {"build": build, "event": "review", "state": "reviewed", "harness": "claude"}]
        (runtime / "events.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        self.assertEqual(self.cmd("claude-doctor", "--json")[1]["state"], "ready")
        config = self.extension / "config.json"
        config.write_text(json.dumps({"schema_version": 1, "enabled": False}))
        out = self.cmd("claude-doctor", "--json")[1]
        self.assertEqual(out["state"], "disabled")
        self.assertFalse(out["learning_enabled"])
        config.write_text(json.dumps({"schema_version": 1, "enabled": True}))
        registry = self.root / ".aiverse/extensions/registry.json"
        value = json.loads(registry.read_text())
        value["extensions"][self.ID]["enabled"] = False
        registry.write_text(json.dumps(value))
        self.assertEqual(self.cmd("claude-doctor", "--json")[1]["state"], "disabled")

    def test_settings_json_hook_command_runs_the_installed_bridge_end_to_end(self):
        """Run the generated hook command exactly as Claude Code would."""
        import shlex as _shlex
        fix_temp, fix_root = fixture()
        self.addCleanup(fix_temp.cleanup)
        extension = fix_root / ".aiverse/extensions" / self.ID
        import hashlib
        files = {name: hashlib.sha256((extension / name).read_bytes()).hexdigest() for name in self.FILES}
        (extension / "install-receipt.json").write_text(json.dumps(
            {"version": self.VERSION, "files": files, "python": sys.executable}))
        registry = json.loads((fix_root / ".aiverse/extensions/registry.json").read_text())
        registry["extensions"][self.ID]["version"] = self.VERSION
        (fix_root / ".aiverse/extensions/registry.json").write_text(json.dumps(registry))
        result = subprocess.run([sys.executable, str(extension / "install.py"), "--root", str(fix_root),
                                 "claude-install", "--python", sys.executable], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout)
        settings = json.loads((fix_root / ".claude/settings.local.json").read_text())
        command = settings["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
        event = {"session_id": "cli-session-0001", "cwd": str(fix_root), "hook_event_name": "UserPromptSubmit",
                 "permission_mode": "default", "prompt": "Quick check of the installed hook."}
        good = subprocess.run(command, shell=True, input=json.dumps(event), capture_output=True, text=True, timeout=60)
        output = json.loads(good.stdout)
        self.assertIn("--harness claude review --session cli-session-0001", output["hookSpecificOutput"]["additionalContext"])
        wrong_build = command.replace(" --build ", " --build 0000", 1)
        bad = subprocess.run(wrong_build, shell=True, input=json.dumps(event), capture_output=True, text=True, timeout=60)
        self.assertIn("AI-Verse hook unavailable", json.loads(bad.stdout)["systemMessage"])
        config = extension / "config.json"
        value = json.loads(config.read_text())
        value["enabled"] = False
        config.write_text(json.dumps(value))
        off = subprocess.run(command, shell=True, input=json.dumps(event), capture_output=True, text=True, timeout=60)
        self.assertEqual(json.loads(off.stdout), {})
        value["enabled"] = True
        config.write_text(json.dumps(value))
        # Now run the printed review and intent commands through a shell, as the model would, with a note file.
        text = output["hookSpecificOutput"]["additionalContext"]
        line = [part for part in text.split("Run this review command: ")[1].split("\n")[0:1]][0]
        note = _shlex.split(line)[-1]
        Path(note).write_text(json.dumps(review_payload()))
        reviewed = subprocess.run(line, shell=True, capture_output=True, text=True, timeout=60, cwd=fix_root)
        self.assertEqual(json.loads(reviewed.stdout)["state"], "reviewed", reviewed.stdout)
        self.assertFalse(Path(note).exists())
        turn_args = _shlex.split(line)
        intent_line = line.replace(" review ", " intent capture --scope operator ", 1).replace(
            "-review.json", "-intent.json")
        intent_note = _shlex.split(intent_line)[-1]
        Path(intent_note).write_text(json.dumps({"classification": "operator-goal"}))
        intent = subprocess.run(intent_line, shell=True, capture_output=True, text=True, timeout=60, cwd=fix_root)
        self.assertFalse(Path(intent_note).exists())
        self.assertNotIn("input file", intent.stdout.lower())



EVIDENCE = {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False,
            "contains_sensitive": False, "contains_secret": False, "reason": "Explicit durable preference."}


class ProfileCorrectionTests(ClaudeFixture):
    """Real host adapter and real profile owner in the fixture; no mocked owner."""

    def setUp(self):
        super().setUp()
        self.n = 0

    def profile_candidate(self, text, quote):
        return {"route": "profile", "parameters": {"preferences": {"communication": [text]},
                                                   "evidence": dict(EVIDENCE)},
                "evidence": [{"source_id": "user", "quote": quote}]}

    def correction_candidate(self, previous, replacement, quote, **extra):
        return {"route": "profile", "parameters": {"correction": {
            "category": "communication", "previous": previous, "replacement": replacement,
            "**": None} if False else {"category": "communication", "previous": previous,
                                         "replacement": replacement},
            "evidence": dict(EVIDENCE), **extra},
            "evidence": [{"source_id": "user", "quote": quote}]}

    def turn_and_review(self, bridge, prompt, candidate, session=None, cwd=None, **extra):
        self.n += 1
        session = session or self.session
        bridge.hook({"session_id": session, "cwd": cwd or str(self.root), "hook_event_name": "UserPromptSubmit",
                     "permission_mode": "default", "prompt": prompt, **extra})
        turn = bridge.state(session)["turn"]
        return bridge.review(session, turn["id"], turn["token"], review_payload([candidate]))

    def preferences(self):
        return (self.root / "operator/profile/preferences.md").read_text()

    def seed_bullets(self):
        self.turn_and_review(self.bridge, "I prefer answers as short bullet points, not long paragraphs.",
                             self.profile_candidate("Prefers answers as short bullet points, not long paragraphs.",
                                                    "prefer answers as short bullet points"))
        self.assertIn("short bullet points", self.preferences())

    def inprocess_owner(self, mutate_on_correct=None):
        import bridge as bridge_module
        real = bridge_module.host_action

        def wrapper(module, host, scope, operation, parameters, effect_id, action_class="write_local_reversible"):
            request = real(module, host, scope, operation, parameters, effect_id, action_class)
            if operation == "operator.profile.correct" and mutate_on_correct:
                mutate_on_correct()
            return request

        original = Bridge.owner

        def owner(bridge, operation, payload):
            if operation in {"learn", "defer"}:
                return bridge_module.run_owner(bridge, operation, payload)
            return original(bridge, operation, payload)
        return patch.object(bridge_module, "host_action", wrapper), patch.object(Bridge, "owner", owner)

    def test_instruction_contains_the_category_sentence_for_both_apps(self):
        sentence = "Notice durable things in what the user says: identity facts, communication preferences and pet peeves"
        self.assertIn(sentence, self.bridge.instruction({"session_id": "s", "turn": None}))
        self.assertIn(sentence, Bridge(self.root).instruction({"session_id": "s", "turn": None}))

    def test_correction_replaces_the_earlier_preference_and_keeps_the_quote(self):
        self.seed_bullets()
        receipt = self.turn_and_review(
            self.bridge, "Actually, I changed my mind: give me answers as short paragraphs instead of bullet points.",
            self.correction_candidate("Prefers answers as short bullet points, not long paragraphs.",
                                      "Prefers answers as short paragraphs instead of bullet points.",
                                      "give me answers as short paragraphs instead of bullet points"))
        state = receipt["effects"][0]["result"]["result"]["operator_profile"]["state"]
        self.assertIn(state, {"evolved", "created"})
        text = self.preferences()
        self.assertIn("short paragraphs", text)
        self.assertNotIn("short bullet points, not long paragraphs", text)
        history = "\n".join(p.read_text() for p in (self.root / "operator/profile").rglob("*") if p.is_file())
        self.assertIn('user said: \\"give me answers as short paragraphs instead of bullet points\\"', history)
        self.assertIn("claude-code:user", history)

    def test_capture_keeps_the_quote_in_the_provenance_reason(self):
        self.seed_bullets()
        history = "\n".join(p.read_text() for p in (self.root / "operator/profile").rglob("*") if p.is_file())
        self.assertIn('user said: \\"prefer answers as short bullet points\\"', history)

    def test_repeating_the_same_correction_creates_no_duplicate(self):
        self.seed_bullets()
        candidate = self.correction_candidate("Prefers answers as short bullet points, not long paragraphs.",
                                              "Prefers answers as short paragraphs instead of bullet points.",
                                              "give me answers as short paragraphs instead of bullet points")
        prompt = "Actually, I changed my mind: give me answers as short paragraphs instead of bullet points."
        self.turn_and_review(self.bridge, prompt, candidate)
        once = self.preferences()
        again = self.turn_and_review(self.bridge, prompt, candidate)
        self.assertEqual(self.preferences().count("short paragraphs instead of bullet points"),
                         once.count("short paragraphs instead of bullet points"))
        self.assertEqual(self.preferences().count("Prefers answers as short"), once.count("Prefers answers as short"))

    def test_a_change_between_read_and_correct_is_retried_once(self):
        self.seed_bullets()
        calls = []

        def touch():
            calls.append(1)
            if len(calls) == 1:
                path = self.root / "operator/profile/preferences.md"
                path.write_text(path.read_text() + "\n<!-- edited by someone else -->\n")
        first, second = self.inprocess_owner(touch)
        with first, second:
            self.turn_and_review(
                self.bridge, "Actually, I changed my mind: give me answers as short paragraphs instead of bullet points.",
                self.correction_candidate("Prefers answers as short bullet points, not long paragraphs.",
                                          "Prefers answers as short paragraphs instead of bullet points.",
                                          "give me answers as short paragraphs instead of bullet points"))
        self.assertEqual(len(calls), 2)
        self.assertIn("short paragraphs instead of bullet points", self.preferences())
        self.assertIn("edited by someone else", self.preferences())

    def test_a_correction_that_stays_stale_becomes_a_pending_proposal(self):
        self.seed_bullets()
        before = self.preferences()

        def touch():
            path = self.root / "operator/profile/preferences.md"
            path.write_text(path.read_text() + "\n<!-- again -->\n")
        first, second = self.inprocess_owner(touch)
        with first, second:
            receipt = self.turn_and_review(
                self.bridge, "Actually, I changed my mind: give me answers as short paragraphs instead of bullet points.",
                self.correction_candidate("Prefers answers as short bullet points, not long paragraphs.",
                                          "Prefers answers as short paragraphs instead of bullet points.",
                                          "give me answers as short paragraphs instead of bullet points"))
        self.assertEqual(receipt["effects"][0]["state"], "owner_unavailable")
        self.assertIsNotNone(receipt["effects"][0]["pending_owner_receipt"])
        self.assertNotIn("short paragraphs instead of bullet points", self.preferences())
        self.assertTrue(list((self.root / "operator/inbox").glob("write-candidate-*.json")))
        self.assertIn("short bullet points", self.preferences())
        self.assertTrue(before.split("<!--")[0] in self.preferences())

    def test_secret_in_a_correction_is_refused(self):
        self.seed_bullets()
        candidate = self.correction_candidate("Prefers answers as short bullet points, not long paragraphs.",
                                              "Use the password is hunter22 for answers.",
                                              "give me answers as short paragraphs")
        with self.assertRaises(Refused):
            self.turn_and_review(self.bridge, "Please give me answers as short paragraphs.", candidate)
        self.assertNotIn("hunter22", self.preferences())

    def test_a_workspace_scoped_turn_cannot_correct_the_operator_profile(self):
        self.seed_bullets()
        candidate = self.correction_candidate("Prefers answers as short bullet points, not long paragraphs.",
                                              "Prefers answers as short paragraphs instead of bullet points.",
                                              "give me answers as short paragraphs instead of bullet points")
        with self.assertRaises(Refused):
            self.turn_and_review(self.bridge, "Actually, give me answers as short paragraphs instead of bullet points.",
                                 candidate, session="claude-workspace-0001", cwd=str(self.root / "workspaces/alpha"))
        self.assertIn("short bullet points", self.preferences())

    def test_codex_refuses_a_correction_object_exactly_as_before(self):
        codex = Bridge(self.root)
        candidate = self.correction_candidate("Use brief evidence-based answers.", "Use paragraphs please.",
                                              "give me answers as short paragraphs")
        with self.assertRaisesRegex(Refused, "unbounded profile parameters"):
            self.turn_and_review(codex, "Please give me answers as short paragraphs.", candidate,
                                 session="codex-session-0009", turn_id="turn-codex-1")

    def test_bad_correction_shapes_are_refused(self):
        for bad in ({"category": "identity", "previous": "a b c", "replacement": "d e f"},
                    {"category": "communication", "previous": "same text", "replacement": "same text"},
                    {"category": "communication", "previous": "a b c"},
                    {"category": "communication", "previous": "a b c", "replacement": "d e f", "extra": 1}):
            candidate = self.correction_candidate("x", "y", "give me answers as short paragraphs")
            candidate["parameters"]["correction"] = bad
            with self.assertRaises(Refused):
                self.turn_and_review(self.bridge, "Please give me answers as short paragraphs.", candidate)

    def test_query_profile_is_claude_only_and_refused_in_a_workspace(self):
        self.seed_bullets()
        good = self.cli("query", "--session", self.session, "--kind", "profile", harness="claude")
        self.assertEqual(good.returncode, 0, good.stdout)
        data = json.loads(good.stdout)["result"] if "result" in json.loads(good.stdout) else json.loads(good.stdout)
        self.assertRegex(json.dumps(data), r"preferences_source_sha256")
        self.assertIn("short bullet points", json.dumps(data))
        codex = self.cli("query", "--session", self.session, "--kind", "profile")
        self.assertEqual(codex.returncode, 2)
        self.bridge.hook({"session_id": "claude-workspace-0002", "cwd": str(self.root / "workspaces/alpha"),
                          "hook_event_name": "UserPromptSubmit", "permission_mode": "default", "prompt": "Continue."})
        denied = self.cli("query", "--session", "claude-workspace-0002", "--kind", "profile", harness="claude")
        self.assertEqual(denied.returncode, 2)


if __name__ == "__main__":
    unittest.main()
