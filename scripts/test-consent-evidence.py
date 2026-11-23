#!/usr/bin/env python3
"""FL-09: a permanent bot or automation needs proof that the operator really said yes.

The chat hook records fingerprints of real messages. The host adapter compares a consent claim
against them. A made up fingerprint, an old one, or one from another chat must be refused.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
BRIDGE_DIR = HERE.parent / "system" / "extensions" / "packages" / "ai-verse-codex-learning"


def load(name, path):
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ADAPTER = load("aiverse_os_consent_test_adapter", HERE / "ai_verse_host_adapter.py")
BRIDGE = load("aiverse_os_consent_test_bridge", BRIDGE_DIR / "bridge.py")


def sha(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


class ConsentEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.runtime = self.root / "runtime" / "codex-learning"
        self.session = "session-consent-1"

    def record(self, role, text, session=None):
        BRIDGE.record_consent_digest(self.root, self.runtime, session or self.session, role, text, "turn-1")

    def check(self, consent, session=None):
        ADAPTER._verify_consent_evidence(self.root, consent, session or self.session, "bots.permanent")

    def direct(self, text):
        return {"explicit": True, "mode": "direct_request", "user_message_digest": sha(text)}

    def test_real_message_is_accepted(self):
        self.record("user", "Create me a permanent review bot.")
        self.check(self.direct("Create me a permanent review bot."))

    def test_message_with_trailing_newline_is_accepted_either_way(self):
        self.record("user", "Create the bot.\n")
        self.check(self.direct("Create the bot.\n"))
        self.check(self.direct("Create the bot."))

    def test_made_up_fingerprint_is_refused(self):
        self.record("user", "Hello there.")
        with self.assertRaises(ADAPTER.AdapterError):
            self.check(self.direct("Create me a permanent review bot."))

    def test_nothing_recorded_is_refused(self):
        with self.assertRaises(ADAPTER.AdapterError) as caught:
            self.check(self.direct("Create me a permanent review bot."))
        self.assertIn("real message", str(caught.exception))

    def test_assistant_text_cannot_stand_in_for_the_operator(self):
        self.record("assistant", "I will create the bot now.")
        with self.assertRaises(ADAPTER.AdapterError):
            self.check(self.direct("I will create the bot now."))

    def test_other_chat_is_refused(self):
        self.record("user", "Create the bot.", session="another-session")
        with self.assertRaises(ADAPTER.AdapterError):
            self.check(self.direct("Create the bot."))

    def test_old_message_is_refused(self):
        self.record("user", "Create the bot.")
        path = next((self.runtime / "consent").glob("*.jsonl"))
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        for row in rows:
            row["ts"] = time.time() - 3 * 60 * 60
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        with self.assertRaises(ADAPTER.AdapterError):
            self.check(self.direct("Create the bot."))

    def test_yes_to_a_recommendation_needs_the_recommendation_first(self):
        consent = {"explicit": True, "mode": "affirmative_to_recommendation",
                   "user_message_digest": sha("yes"), "recommendation_message_digest": sha("Shall I create a bot?")}
        self.record("user", "yes")
        with self.assertRaises(ADAPTER.AdapterError):
            self.check(consent)
        self.record("assistant", "Shall I create a bot?")
        with self.assertRaises(ADAPTER.AdapterError):
            self.check(consent)  # the recommendation came after the yes
        self.record("user", "yes")
        self.check(consent)

    def test_only_fingerprints_are_stored(self):
        self.record("user", "My secret plan is purple elephant.")
        stored = next((self.runtime / "consent").glob("*.jsonl")).read_text(encoding="utf-8")
        self.assertNotIn("purple elephant", stored)

    def test_ledger_is_bounded(self):
        for index in range(BRIDGE.CONSENT_KEEP + 50):
            self.record("user", f"message {index}")
        stored = next((self.runtime / "consent").glob("*.jsonl")).read_text(encoding="utf-8").splitlines()
        self.assertLessEqual(len(stored), BRIDGE.CONSENT_KEEP)

    def test_symlinked_ledger_is_ignored(self):
        self.record("user", "Create the bot.")
        path = next((self.runtime / "consent").glob("*.jsonl"))
        real = path.with_suffix(".real")
        path.rename(real)
        try:
            path.symlink_to(real)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with self.assertRaises(ADAPTER.AdapterError):
            self.check(self.direct("Create the bot."))

    def test_the_hook_helper_keeps_quiet_when_it_cannot_write(self):
        # The wiring helper must never raise into the chat hook.
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.root = self.root
        bridge.runtime = self.root.parent / "outside-the-root"
        bridge.record_consent("session-x", "user", "hello")

    def test_both_creation_paths_check_the_proof(self):
        (self.root / "AI-VERSE.yaml").write_text('schema_version: "2.0"\n', encoding="utf-8")
        host = ADAPTER.AIverseOSHost(self.root)
        host._run_multiple_bots_create_durable = lambda manifest: self.fail("created without proof")
        host._run_automations_create_definition = lambda definition: self.fail("created without proof")
        provenance = {"run_id": "run-1", "session_id": self.session}
        bot = {"name": "Reviewer", "role_title": "Reviewer", "mission": "Review things.", "skill_refs": [],
               "runtime": {"adapter": "deterministic"}, "consent": self.direct("Make the bot."), "provenance": provenance}
        with self.assertRaises(ADAPTER.AdapterError) as caught:
            host._request_permanent_bot({}, "operator", bot)
        self.assertIn("real message", str(caught.exception))
        automation = {"name": "Weekly", "objective": "Review.", "trigger": {"kind": "interval", "spec": {"every": "1w"}},
                      "consent": self.direct("Make the automation."), "provenance": provenance}
        with self.assertRaises(ADAPTER.AdapterError) as caught:
            host._request_automation_create({}, "operator", automation)
        self.assertIn("real message", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
