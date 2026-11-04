"""Shared scenarios: the same behaviour for harness=codex and harness=claude (adapter tests stay separate)."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

from bridge import Bridge, EXT
from test_bridge import fixture

EVIDENCE = {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False,
            "contains_sensitive": False, "contains_secret": False, "reason": "Explicit durable preference."}

HARNESSES = ("codex", "claude")
EMPTY = {"topic": "task review", "summary": "No durable learning identified", "outcomes": [],
         "unresolved": [], "candidates": [], "persist_digest": False}


class Scenario:
    def __init__(self, test, harness, config=None):
        self.test, self.harness = test, harness
        self.temp, self.root = fixture()
        test.addCleanup(self.temp.cleanup)
        if config:
            file = self.root / ".aiverse/extensions/ai-verse-codex-learning/config.json"
            value = json.loads(file.read_text())
            value.update(config)
            file.write_text(json.dumps(value))
        self.bridge = Bridge(self.root, harness=harness)
        self.session = harness + "-parity-0001"
        self.count = 0

    def prompt(self, text, cwd=None):
        self.count += 1
        event = {"session_id": self.session, "cwd": cwd or str(self.root), "hook_event_name": "UserPromptSubmit",
                 "permission_mode": "default", "prompt": text, "turn_id": f"turn-{self.count}"}
        output = self.bridge.hook(event)
        return output["hookSpecificOutput"]["additionalContext"]

    def turn(self):
        return self.bridge.state(self.session)["turn"]

    def cli(self, *args, stdin=""):
        command = [sys.executable, str(self.root / ".aiverse/extensions/ai-verse-codex-learning/bridge.py"),
                   "--root", str(self.root), "--harness", self.harness]
        return subprocess.run(command + list(args), input=stdin, capture_output=True, text=True, timeout=90)

    def review_args(self):
        turn = self.turn()
        return ["review", "--session", self.session, "--turn", turn["id"], "--token", turn["token"]]

    def review_cli(self, payload):
        """Submit through the real command line using the app's own transport."""
        if self.harness == "claude":
            note = self.root / "runtime/codex-learning/claude-input" / (self.turn()["id"] + "-review.json")
            note.write_text(json.dumps(payload))
            return self.cli(*self.review_args(), "--input-file", str(note))
        return self.cli(*self.review_args(), stdin=json.dumps(payload))

    def profile_candidate(self, section, text, quote):
        return {"route": "profile", "parameters": {section: {"communication": [text]}, "evidence": dict(EVIDENCE)},
                "evidence": [{"source_id": "user", "quote": quote}]}

    def payload(self, *candidates):
        return {"topic": "Parity check", "summary": "Parity scenario.", "outcomes": [], "unresolved": [],
                "candidates": list(candidates), "persist_digest": False}


class ParityTests(unittest.TestCase):
    def each(self, body, config=None):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                body(Scenario(self, harness, config))

    def test_profile_save_then_correct_keeps_the_user_quote(self):
        def body(sc):
            sc.prompt("I prefer answers as short bullet points, not long paragraphs.")
            first = sc.review_cli(sc.payload(sc.profile_candidate(
                "preferences", "Prefers answers as short bullet points, not long paragraphs.",
                "prefer answers as short bullet points")))
            self.assertEqual(first.returncode, 0, first.stdout)
            sc.prompt("Actually give me answers as short paragraphs instead of bullet points.")
            correction = {"route": "profile", "parameters": {"correction": {
                "category": "communication", "previous": "Prefers answers as short bullet points, not long paragraphs.",
                "replacement": "Prefers answers as short paragraphs instead of bullet points."},
                "evidence": dict(EVIDENCE)},
                "evidence": [{"source_id": "user", "quote": "give me answers as short paragraphs instead of bullet points"}]}
            second = sc.review_cli(sc.payload(correction))
            self.assertEqual(second.returncode, 0, second.stdout)
            text = (sc.root / "operator/profile/preferences.md").read_text()
            self.assertIn("short paragraphs", text)
            self.assertNotIn("short bullet points, not long", text)
            history = "\n".join(p.read_text() for p in (sc.root / "operator/profile").rglob("*") if p.is_file())
            label = "claude-code:user" if sc.harness == "claude" else "codex-desktop:user"
            self.assertIn(label, history)
            self.assertIn('user said: \\"give me answers as short paragraphs', history)
            queried = sc.cli("query", "--session", sc.session, "--kind", "profile")
            self.assertEqual(queried.returncode, 0, queried.stdout)
            self.assertIn("preferences_source_sha256", queried.stdout)
        self.each(body)

    def test_key_preferences_come_first_and_the_review_command_survives_every_budget(self):
        def body(sc):
            (sc.root / "operator/profile/preferences.md").write_text(
                "# Prefs\n\n## Communication\n\n- Never use dashes in anything you write for me.\n\n## Avoid\n\n- Avoid vague praise.\n")
            for limit in (24000, 14000, 9000, 4096):
                sc.bridge.config["context_max_bytes"] = limit
                text = sc.prompt("Hello there, what is next today?")
                self.assertLessEqual(len(text.encode()), limit)
                self.assertIn("review --session", text)
                turn = sc.turn()
                self.assertIn(turn["token"], text)
                json.loads(text.split("Owner data (JSON):\n", 1)[1])
                if limit >= 9000:
                    self.assertIn("Never use dashes", text)
        self.each(body)

    def test_empty_review_by_the_apps_own_transport(self):
        def body(sc):
            sc.prompt("Check the folder.")
            result = sc.review_cli(EMPTY)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertEqual(json.loads(result.stdout)["state"], "reviewed")
        self.each(body)

    def test_note_files_work_for_both_apps_and_are_deleted(self):
        def body(sc):
            sc.prompt("Check the folder.")
            note = sc.root / "runtime/codex-learning/claude-input" / "x-review.json"
            note.write_text(json.dumps(EMPTY))
            result = sc.cli(*sc.review_args(), "--input-file", str(note))
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertFalse(note.exists())
        self.each(body)


if __name__ == "__main__":
    unittest.main()
