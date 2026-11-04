"""The maintainer's upgrade list, the friendly words, and the missing helpers reminder."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

from bridge import Refused
from test_parity import HARNESSES, Scenario

REPO = Path(__file__).resolve().parents[4]


def set_config(sc, **values):
    file = sc.root / ".aiverse/extensions/ai-verse-codex-learning/config.json"
    config = json.loads(file.read_text())
    config.update(values)
    file.write_text(json.dumps(config))
    sc.bridge.config.update(values)


def add_development_project(sc):
    folder = sc.root / "workspaces/ai-verse-os-development"
    (folder / "context").mkdir(parents=True)
    (folder / "WORKSPACE.yaml").write_text('schema_version: "2.0"\nid: ai-verse-os-development\nname: "AI-Verse OS Development"\nstatus: active\n')
    (folder / "context/CURRENT.md").write_text("## Current state\n\n- Development fixture.\n")
    return folder


def upgrade(text, quote):
    return {"route": "upgrade", "parameters": {"text": text}, "evidence": [{"source_id": "user", "quote": quote}]}


class MotherListTests(unittest.TestCase):
    def each(self, body, **config):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                sc = Scenario(self, harness)
                set_config(sc, **config)
                body(sc)

    def review(self, sc, candidate):
        return sc.bridge.review(sc.session, sc.turn()["id"], sc.turn()["token"], sc.payload(candidate))

    def test_off_means_nothing_happens(self):
        def body(sc):
            folder = add_development_project(sc)
            text = sc.prompt("It would be better if AI-Verse OS told me what it saved in shorter notes.")
            self.assertNotIn("\"route\":\"upgrade\"", text)
            receipt = self.review(sc, upgrade("AI-Verse OS should make the notes about what was saved shorter.", "AI-Verse OS told me what it saved in shorter notes"))
            self.assertEqual(receipt["effects"], [])
            self.assertEqual(list((folder).rglob("mem-*.md")), [])
            self.assertFalse((folder / "knowledge/AI-VERSE-OS-UPGRADE-LIST.md").exists())
        self.each(body, maintainer_feedback=False)

    def test_on_creates_a_minimal_note_and_the_list_view(self):
        def body(sc):
            folder = add_development_project(sc)
            text = sc.prompt("It would be better if AI-Verse OS told me what it saved in shorter notes.")
            self.assertIn("\"route\":\"upgrade\"", text)
            receipt = self.review(sc, upgrade("AI-Verse OS should make the notes about what was saved shorter.", "AI-Verse OS told me what it saved in shorter notes"))
            self.assertEqual(receipt["effects"][0]["result"]["state"], "saved")
            note = "\n".join(p.read_text() for p in folder.rglob("mem-*.md"))
            self.assertIn("upgrade-note", note)
            self.assertIn("AI-Verse OS should make the notes about what was saved shorter.", note)
            # The view is rebuilt from a chat that may read the development project.
            sc.prompt("Show me the upgrade list please.", cwd=str(folder))
            turn = sc.turn()
            self.assertEqual(sc.cli("reflect", "list", "--session", sc.session, "--turn", turn["id"], "--token", turn["token"]).returncode, 0)
            view = (folder / "knowledge/AI-VERSE-OS-UPGRADE-LIST.md").read_text()
            self.assertIn("Derived view", view)
            self.assertIn("AI-Verse OS should make the notes about what was saved shorter.", view)
            self.assertEqual(sc.cli("reflect", "list").returncode, 2)
        self.each(body, maintainer_feedback=True)

    def test_it_never_copies_another_projects_facts(self):
        def body(sc):
            add_development_project(sc)
            sc.prompt("AI-Verse OS should stop mixing things up, like the Beta Study numbers.")
            with self.assertRaises(Refused):
                self.review(sc, upgrade("AI-Verse OS should stop mixing up the Beta Study notes.", "AI-Verse OS should stop mixing things up"))
        self.each(body, maintainer_feedback=True)

    def test_feedback_from_a_private_project_chat_carries_only_the_request(self):
        def body(sc):
            folder = add_development_project(sc)
            alpha = str(sc.root / "workspaces/alpha")
            sc.prompt("It would be better if AI-Verse OS told me what it saved in shorter notes.", cwd=alpha)
            receipt = self.review(sc, upgrade("AI-Verse OS should make the notes about what was saved shorter.", "AI-Verse OS told me what it saved in shorter notes"))
            self.assertEqual(receipt["effects"][0]["result"]["state"], "saved")
            self.assertEqual(len(list(folder.rglob("mem-*.md"))), 1)
            self.assertEqual(list((sc.root / "workspaces/alpha").rglob("mem-*.md")), [])
            self.assertEqual(list((sc.root / "operator/memory").rglob("mem-*.md")), [])
            # The list view is only rebuilt from a chat that may read the development project.
            self.assertFalse((folder / "knowledge/AI-VERSE-OS-UPGRADE-LIST.md").exists())
            sc.prompt("Show me the upgrade list please.", cwd=str(folder))
            turn = sc.turn()
            self.assertEqual(sc.cli("reflect", "list", "--session", sc.session, "--turn", turn["id"], "--token", turn["token"]).returncode, 0)
            self.assertNotIn("ALPHA PRIVATE", (folder / "knowledge/AI-VERSE-OS-UPGRADE-LIST.md").read_text())
            # And a project chat with the switch on still cannot read the list through the owner door.
            sc.prompt("Back to Alpha Study.", cwd=alpha)
            turn = sc.turn()
            auth = {"session": sc.session, "turn": turn["id"], "token": turn["token"]}
            refused = sc.cli("owner", "reflect_scan", stdin=json.dumps({"projects": [], "limit": 5, "upgrade": True, "auth": auth}))
            self.assertEqual(refused.returncode, 2)
            # An ordinary memory aimed at the development project from another chat is still refused.
            sc.prompt("The validated filter retained all twelve correct records.", cwd=alpha)
            ordinary = {"route": "memory", "scope": "workspace:ai-verse-os-development",
                        "parameters": {"type": "lesson", "text": "The validated filter retained all twelve correct records.", "confidence": .95,
                                       "admission": {"durable": True, "historical": True, "current_truth": False, "contains_secret": False,
                                                     "strategic": False, "permission_expansion": False, "privacy_ambiguous": False,
                                                     "external_authority": False}},
                        "evidence": [{"source_id": "user", "quote": "filter retained all twelve correct records"}]}
            with self.assertRaises(Refused):
                self.review(sc, ordinary)
        self.each(body, maintainer_feedback=True)

    def test_uncertain_or_fact_carrying_text_is_refused(self):
        def body(sc):
            add_development_project(sc)
            sc.prompt("AI-Verse OS should remember that the member count is 81 and the price is 289 dollars.")
            for bad in ("AI-Verse OS should remember that the member count is 81 and the price is 289.",
                        "Remember the member count and price for the community.",
                        "AI-Verse OS should open https://example.com/private for me always.",
                        "AI-Verse OS should email me at someone@example.com every day."):
                with self.assertRaises(Refused):
                    self.review(sc, upgrade(bad, "the member count is 81 and the price is 289 dollars"))
        self.each(body, maintainer_feedback=True)

    def test_a_missing_development_project_is_skipped_quietly(self):
        def body(sc):
            sc.prompt("It would be better if AI-Verse OS told me what it saved in shorter notes.")
            receipt = self.review(sc, upgrade("AI-Verse OS should make the notes shorter please.", "AI-Verse OS told me what it saved in shorter notes"))
            self.assertEqual(receipt["effects"][0]["result"]["state"], "skipped")
        self.each(body, maintainer_feedback=True)

    def test_an_assistant_claim_alone_is_not_a_request(self):
        def body(sc):
            add_development_project(sc)
            sc.prompt("Hello there.")
            sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "Stop", "turn_id": sc.turn()["id"],
                            "permission_mode": "default", "last_assistant_message": "I suggest AI-Verse OS should send longer notes always."})
            bad = upgrade("Send longer notes always.", "AI-Verse OS should send longer notes always")
            bad["evidence"][0]["source_id"] = "assistant"
            with self.assertRaises(Refused):
                self.review(sc, bad)
        self.each(body, maintainer_feedback=True)

    def test_the_switch_survives_a_reinstall(self):
        sc = Scenario(self, "codex")
        set_config(sc, maintainer_feedback=True)
        script = sc.root / ".aiverse/extensions/ai-verse-codex-learning/lifecycle.py"
        for command in ("install", "install"):
            done = subprocess.run([sys.executable, str(script), "--root", str(sc.root), command], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
        config = json.loads((sc.root / ".aiverse/extensions/ai-verse-codex-learning/config.json").read_text())
        self.assertTrue(config["maintainer_feedback"])


class VenturePrivacyTests(unittest.TestCase):
    def test_a_project_chat_never_sees_another_projects_venture_line(self):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                sc = Scenario(self, harness)
                for project, name in (("alpha", "Alpha Study"), ("beta", "Beta Study")):
                    sc.bridge.owner("learn", {"scope": "operator", "session_id": "s", "turn_id": "t", "route": "profile", "refs": ["x:1"],
                        "parameters": {"identity": {"ventures": [{"text": f"Works on {name}", "project": project}]},
                                       "evidence": {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False,
                                                    "contains_sensitive": False, "contains_secret": False, "reason": "seed"}},
                        "effect_id": "seed-" + project})
                in_alpha = sc.prompt("Continue.", cwd=str(sc.root / "workspaces/alpha"))
                self.assertIn("Works on Alpha Study", in_alpha)
                self.assertNotIn("Beta Study", in_alpha)
                self.assertNotIn("project:beta", in_alpha)
                in_beta = sc.prompt("Continue.", cwd=str(sc.root / "workspaces/beta"))
                self.assertNotIn("Alpha Study", in_beta)
                at_root = sc.prompt("Continue.")
                self.assertIn("Works on Alpha Study", at_root)  # the operator's own view is complete
                self.assertIn("Works on Beta Study", at_root)


class WordsAndReminderTests(unittest.TestCase):
    def test_the_friendly_vocabulary_is_in_the_instructions_of_both_apps(self):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                sc = Scenario(self, harness)
                text = sc.prompt("Hello there.")
                for phrase in ("what I know about you", "projects\" instead of workspaces", "what I remember", "AI-Verse OS helpers",
                               "AI-Verse OS is the product; AI-Verse is the group's brand", "Never mention owners, scopes, routing"):
                    self.assertIn(phrase, text)

    def test_the_reflect_capability_is_registered_and_mirrored(self):
        registry = (REPO / "skills/registry.yaml").read_text()
        self.assertIn("id: reflect", registry)
        canonical = (REPO / "system/capabilities/reflect/SKILL.md").read_text()
        for mirror in (".claude/skills/reflect/SKILL.md", ".agents/skills/reflect/SKILL.md"):
            self.assertEqual((REPO / mirror).read_text(), canonical)
        for word in ("When to use", "Inputs", "Method", "Validation", "Failure behavior", "what I know about you"):
            self.assertIn(word, canonical)

    def test_agents_md_guides_helper_repair_without_guessing(self):
        text = (REPO / "AGENTS.md").read_text()
        section = text.split("## Missing helpers rule", 1)[1].split("\n## ", 1)[0]
        for phrase in ("read-only doctor", "Open Settings, then Hooks, and approve the AI-Verse OS ones",
                       "diagnostics identify helpers waiting for approval", "unverified", "switched learning off on purpose",
                       "Never claim an update happened", "Never edit trust records"):
            self.assertIn(phrase, section)

    def test_the_claude_installer_allows_the_reflect_command(self):
        import install
        self.assertIn("reflect", install.CLAUDE_SUBCOMMANDS)


if __name__ == "__main__":
    unittest.main()
