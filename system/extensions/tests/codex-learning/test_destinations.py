"""Per-turn destinations: aliases, pasted names, ambiguity, two destinations, no carry-over, evidence scope."""
import json
import unittest

from bridge import Bridge, Refused
from test_bridge import ADMISSION
from test_parity import EVIDENCE, HARNESSES, Scenario

STATEMENT = "The community now has eighty one members and keeps growing."


def memory(text, quote, scope=None, source_id="user"):
    value = {"route": "memory", "parameters": {"type": "lesson", "text": text, "confidence": .95,
                                                "admission": dict(ADMISSION)},
             "evidence": [{"source_id": source_id, "quote": quote}]}
    if scope:
        value["scope"] = scope
    return value


def profile(text, quote, **extra):
    return {"route": "profile", "parameters": {"identity": {"notes": [text]}, "evidence": dict(EVIDENCE)},
            "evidence": [{"source_id": "user", "quote": quote}], **extra}


class DestinationTests(unittest.TestCase):
    def each(self, body):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                scenario = Scenario(self, harness)
                manifest = scenario.root / "workspaces/beta/WORKSPACE.yaml"
                manifest.write_text(manifest.read_text() + 'aliases:\n  - "Skoolish"\n')
                body(scenario)

    def review(self, sc, *candidates, persist=False):
        payload = sc.payload(*candidates)
        payload["persist_digest"] = persist
        return sc.bridge.review(sc.session, sc.turn()["id"], sc.turn()["token"], payload)

    def files(self, sc, where):
        return list((sc.root / where).rglob("mem-*.md"))

    def test_an_alias_saves_into_the_project_and_a_general_fact_goes_to_the_profile(self):
        def body(sc):
            sc.prompt(f"{STATEMENT} Skoolish is going well. Also I am a filmmaker based in Romania.")
            self.assertEqual(sc.turn()["allowed"], ["operator", "workspace:beta"])
            self.assertEqual(sc.bridge.state(sc.session)["scope"], "workspace:beta")
            receipt = self.review(sc, memory(STATEMENT, "community now has eighty one members", "workspace:beta"),
                                  profile("The operator is a filmmaker based in Romania.", "I am a filmmaker based in Romania"))
            self.assertEqual([e["scope"] for e in receipt["effects"]], ["workspace:beta", "operator"])
            self.assertEqual(len(self.files(sc, "workspaces/beta")), 1)
            self.assertEqual(len(self.files(sc, "operator/memory")), 0)
            self.assertIn("filmmaker based in Romania", (sc.root / "operator/profile/identity.md").read_text())
            self.assertTrue(receipt["digest_skipped_mixed"] is False)
        self.each(body)

    def test_two_destinations_in_one_review_and_the_digest_is_skipped(self):
        def body(sc):
            sc.prompt("Alpha Study finished the filter pass and Beta Study finished the colour pass today.")
            self.assertEqual(set(sc.turn()["allowed"]), {"operator", "workspace:alpha", "workspace:beta"})
            receipt = self.review(
                sc, memory("The alpha filter pass was finished today.", "Alpha Study finished the filter pass", "workspace:alpha"),
                memory("The beta colour pass was finished today.", "Beta Study finished the colour pass", "workspace:beta"),
                persist=True)
            self.assertEqual(receipt["scopes"], ["workspace:alpha", "workspace:beta"])
            self.assertTrue(receipt["digest_skipped_mixed"])
            self.assertIsNone(receipt["digest"])
            self.assertEqual(len(self.files(sc, "workspaces/alpha")), 1)
            self.assertEqual(len(self.files(sc, "workspaces/beta")), 1)
        self.each(body)

    def test_an_ambiguous_name_asks_and_writes_nothing(self):
        def body(sc):
            manifest = sc.root / "workspaces/alpha/WORKSPACE.yaml"
            manifest.write_text(manifest.read_text() + 'aliases:\n  - "Skoolish"\n')
            text = sc.prompt("Skoolish passed the milestone this morning.")
            turn = sc.turn()
            self.assertEqual(turn["allowed"], ["operator"])
            self.assertEqual(turn["ambiguous"][0]["could_mean"], ["workspace:alpha", "workspace:beta"])
            self.assertIn("ask the operator one plain question", text)
            with self.assertRaises(Refused):
                self.review(sc, memory("The milestone passed this morning.", "passed the milestone this morning", "workspace:beta"))
        self.each(body)

    def test_a_pasted_or_quoted_project_name_does_not_bind(self):
        def body(sc):
            sc.prompt("Please summarise this.\n<pasted_content id=\"abc\">Notes from Beta Study and workspace:alpha</pasted_content>")
            self.assertEqual(sc.turn()["allowed"], ["operator"])
            sc.prompt("Look at this:\n> Alpha Study said hello\n```\nBeta Study log\n```\nThanks.")
            self.assertEqual(sc.turn()["allowed"], ["operator"])
            self.assertEqual(sc.bridge.state(sc.session)["scope"], "operator")
            sc.prompt("Now about Beta Study itself.")
            self.assertEqual(sc.turn()["allowed"], ["operator", "workspace:beta"])
        self.each(body)

    def test_the_next_turn_returns_to_the_folders_own_scope(self):
        def body(sc):
            sc.prompt("Alpha Study is on track.")
            self.assertEqual(sc.bridge.state(sc.session)["scope"], "workspace:alpha")
            sc.prompt("Thanks, that is all.")
            self.assertEqual(sc.bridge.state(sc.session)["scope"], "operator")
            self.assertEqual(sc.turn()["allowed"], ["operator"])
            folder = str(sc.root / "workspaces/alpha")
            sc.prompt("Continue.", cwd=folder)
            self.assertEqual(sc.turn()["allowed"], ["workspace:alpha"])
            sc.prompt("And again.", cwd=folder)
            self.assertEqual(sc.bridge.state(sc.session)["scope"], "workspace:alpha")
        self.each(body)

    def test_evidence_from_one_project_cannot_write_to_another(self):
        def body(sc):
            sc.prompt("Alpha Study ran the validation successfully.")
            with self.assertRaises(Refused):
                self.review(sc, memory("The validation ran successfully.", "Alpha Study ran the validation", "workspace:beta"))
            # Tool text supports only the turn's own scope, even when the operator named two projects.
            sc.prompt("Alpha Study and Beta Study are both in play.")
            sc.bridge.hook({"session_id": sc.session, "turn_id": sc.turn()["id"], "cwd": str(sc.root), "hook_event_name": "PostToolUse",
                            "permission_mode": "default", "tool_use_id": "tool-1",
                            "tool_response": {"output": "The beta pipeline reported twelve verified records today."}})
            with self.assertRaises(Refused):
                self.review(sc, memory("The beta pipeline verified twelve records.", "beta pipeline reported twelve verified records",
                                       "workspace:beta", "tool:tool-1"))
        self.each(body)

    def test_a_project_chat_may_send_only_a_plain_general_fact_to_the_profile(self):
        def body(sc):
            folder = str(sc.root / "workspaces/alpha")
            sc.prompt("By the way I am a morning person who dislikes long meetings.", cwd=folder)
            fact = profile("The operator is a morning person who dislikes long meetings.", "morning person who dislikes long meetings",
                           scope="operator")
            with self.assertRaises(Refused):
                self.review(sc, fact)  # no explicit admission
            admitted = dict(fact, general_fact={"stated_by_operator_about_self": True, "contains_project_figures": False})
            receipt = self.review(sc, admitted)
            self.assertEqual(receipt["effects"][0]["scope"], "operator")
            self.assertIn("morning person", (sc.root / "operator/profile/identity.md").read_text())
        self.each(body)

    def test_a_general_fact_with_figures_or_project_text_is_refused(self):
        def body(sc):
            folder = str(sc.root / "workspaces/alpha")
            sc.prompt("This project earns 289 dollars a month.", cwd=folder)
            fact = profile("The operator earns 289 dollars a month.", "earns 289 dollars a month", scope="operator",
                           general_fact={"stated_by_operator_about_self": True, "contains_project_figures": False})
            with self.assertRaises(Refused):
                self.review(sc, fact)
            tool = dict(profile("The operator likes tea.", "likes tea", scope="operator",
                                general_fact={"stated_by_operator_about_self": True, "contains_project_figures": False}))
            tool["evidence"] = [{"source_id": "assistant", "quote": "likes tea"}]
            with self.assertRaises(Refused):
                self.review(sc, tool)
        self.each(body)

    def test_query_scope_reads_only_inside_the_turns_destinations_with_the_turn_token(self):
        def body(sc):
            sc.prompt("Alpha Study update please.")
            turn = sc.turn()
            auth = ["--turn", turn["id"], "--token", turn["token"]]
            ok = sc.cli("query", "--session", sc.session, "--kind", "context", "--scope", "workspace:alpha", *auth)
            self.assertEqual(ok.returncode, 0, ok.stdout)
            self.assertIn("ALPHA PRIVATE", ok.stdout)
            denied = sc.cli("query", "--session", sc.session, "--kind", "context", "--scope", "workspace:beta", *auth)
            self.assertEqual(denied.returncode, 2)
            self.assertNotIn("BETA PRIVATE", denied.stdout)
            # Session id alone, a wrong token, another session, and a stale turn are all refused.
            self.assertEqual(sc.cli("query", "--session", sc.session, "--kind", "context", "--scope", "workspace:alpha").returncode, 2)
            self.assertEqual(sc.cli("query", "--session", sc.session, "--kind", "context", "--scope", "workspace:alpha",
                                    "--turn", turn["id"], "--token", "0" * 32).returncode, 2)
            self.assertEqual(sc.cli("query", "--session", sc.session + "-other", "--kind", "context", "--scope", "workspace:alpha", *auth).returncode, 2)
            sc.prompt("A new turn without alpha.")
            self.assertEqual(sc.cli("query", "--session", sc.session, "--kind", "context", "--scope", "workspace:alpha", *auth).returncode, 2)
            # Cancelled turns lose it as well.
            fresh = sc.turn()
            sc.prompt("Alpha Study again.")
            fresh = sc.turn()
            sc.bridge.hook({"session_id": sc.session, "turn_id": fresh["id"], "cwd": str(sc.root), "hook_event_name": "Interrupt"})
            self.assertEqual(sc.cli("query", "--session", sc.session, "--kind", "context", "--scope", "workspace:alpha",
                                    "--turn", fresh["id"], "--token", fresh["token"]).returncode, 2)
        self.each(body)

    def test_startup_resume_and_compaction_never_carry_a_project_over(self):
        def body(sc):
            alpha = str(sc.root / "workspaces/alpha")
            sc.prompt("Continue.", cwd=alpha)
            first = sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "SessionStart", "source": "resume"})
            self.assertNotIn("ALPHA PRIVATE", first["hookSpecificOutput"]["additionalContext"])
            sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "SessionStart", "source": "compact"})
            beta = sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root / "workspaces/beta"), "hook_event_name": "SessionStart", "source": "startup"})
            text = beta["hookSpecificOutput"]["additionalContext"]
            self.assertIn("BETA PRIVATE", text)
            self.assertNotIn("ALPHA PRIVATE", text)
            self.assertNotIn("A tidy note is waiting", text)
        self.each(body)

    def test_a_long_message_never_authorizes_a_project_on_a_client_that_does_not_mark_pastes(self):
        long_text = "Notes I pasted: Beta Study did well. " + "Filler sentence about nothing. " * 60
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                sc = Scenario(self, harness)
                sc.prompt(long_text)
                turn = sc.turn()
                if harness == "codex":
                    self.assertEqual(turn["allowed"], ["operator"])
                    self.assertTrue(turn["ambiguous"])
                else:
                    self.assertIn("workspace:beta", turn["allowed"])  # Claude marks pastes, so unmarked prose is the operator's own
                sc.prompt("Now about Beta Study, in a short message.")
                self.assertIn("workspace:beta", sc.turn()["allowed"])


if __name__ == "__main__":
    unittest.main()
