"""Negative tests from the third review: two projects, two sessions, cancelled turns, quoted input, concurrent processes."""
import json
import re
import subprocess
import sys
import time
import unittest

from bridge import Bridge, Refused
from test_parity import EVIDENCE, HARNESSES, Scenario
from test_tidy import TidyBase, USER_REF
from test_bridge import ADMISSION


def owner_call(sc, operation, payload):
    return sc.cli("owner", operation, stdin=json.dumps(payload))


class OwnerDoorTests(TidyBase):
    def test_new_owner_operations_need_a_live_capability_for_authorized_destinations(self):
        def body(sc):
            sc.prompt("Alpha Study update please.")
            turn = sc.turn()
            auth = {"session": sc.session, "turn": turn["id"], "token": turn["token"]}
            scan = {"projects": ["beta"], "limit": 5}
            self.assertEqual(owner_call(sc, "reflect_scan", scan).returncode, 2)                        # no capability
            self.assertEqual(owner_call(sc, "reflect_scan", {**scan, "auth": auth}).returncode, 2)      # beta is not this turn's
            self.assertEqual(owner_call(sc, "reflect_scan", {"projects": ["alpha"], "limit": 5, "auth": auth}).returncode, 0)
            bad = {**auth, "token": "0" * 32}
            self.assertEqual(owner_call(sc, "reflect_scan", {"projects": ["alpha"], "limit": 5, "auth": bad}).returncode, 2)
            removal = {"scope": "workspace:beta", "parameters": {"effect_id": "x"}, "auth": auth}
            self.assertEqual(owner_call(sc, "current_remove", removal).returncode, 2)
            # Another session's capability does not work for this one.
            other = Bridge(sc.root, harness="claude")
            other.hook({"session_id": "claude-other-0001", "cwd": str(sc.root), "hook_event_name": "UserPromptSubmit",
                        "permission_mode": "default", "prompt": "Beta Study please.", "turn_id": "turn-1"})
            ot = other.state("claude-other-0001")["turn"]
            crossed = {"session": sc.session, "turn": ot["id"], "token": ot["token"]}
            self.assertEqual(owner_call(sc, "reflect_scan", {"projects": ["beta"], "limit": 5, "auth": crossed}).returncode, 2)
            # A cancelled turn loses it.
            sc.bridge.hook({"session_id": sc.session, "turn_id": turn["id"], "cwd": str(sc.root), "hook_event_name": "Interrupt"})
            self.assertEqual(owner_call(sc, "reflect_scan", {"projects": ["alpha"], "limit": 5, "auth": auth}).returncode, 2)
        self.each(body)


class QuerySessionTests(TidyBase):
    def test_project_context_queries_need_the_active_turn_token(self):
        def body(sc):
            sc.prompt("Continue.", cwd=str(sc.root / "workspaces/alpha"))
            turn = sc.turn()
            for kind in ("context", "capabilities", "connections"):
                self.assertEqual(sc.cli("query", "--session", sc.session, "--kind", kind).returncode, 2, kind)
            memory = sc.cli("query", "--session", sc.session, "--kind", "memory", "--query", "alpha")
            self.assertEqual(memory.returncode, 2)
            ok = sc.cli("query", "--session", sc.session, "--kind", "context", "--turn", turn["id"], "--token", turn["token"])
            self.assertEqual(ok.returncode, 0, ok.stdout)
            self.assertIn("ALPHA PRIVATE", ok.stdout)
            self.assertNotIn("BETA PRIVATE", ok.stdout)
            sc.bridge.hook({"session_id": sc.session, "turn_id": turn["id"], "cwd": str(sc.root), "hook_event_name": "Interrupt"})
            gone = sc.cli("query", "--session", sc.session, "--kind", "context", "--turn", turn["id"], "--token", turn["token"])
            self.assertEqual(gone.returncode, 2)
        self.each(body)

    def test_the_printed_memory_query_carries_the_turn_and_token(self):
        def body(sc):
            text = sc.prompt("Continue.", cwd=str(sc.root / "workspaces/alpha"))
            turn = sc.turn()
            self.assertIn(f"--turn {turn['id']} --token {turn['token']} --kind memory", text)
        self.each(body)


class StartupAndBindingTests(TidyBase):
    def put_ventures(self, sc):
        for project, name in (("alpha", "Alpha Study"), ("beta", "Beta Study")):
            sc.bridge.owner("learn", {"scope": "operator", "session_id": "s", "turn_id": "t", "route": "profile", "refs": ["x:1"],
                "parameters": {"identity": {"ventures": [{"text": f"Works on {name}", "project": project}]},
                               "evidence": {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False,
                                            "contains_sensitive": False, "contains_secret": False, "reason": "seed"}},
                "effect_id": "seed-" + project})

    def test_startup_in_another_project_does_not_keep_the_old_venture_visibility(self):
        def body(sc):
            self.put_ventures(sc)
            sc.prompt("Alpha Study and Beta Study both matter today.")        # this turn may read both
            started = sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root / "workspaces/alpha"),
                                      "hook_event_name": "SessionStart", "source": "resume"})
            text = started["hookSpecificOutput"]["additionalContext"]
            self.assertIn("Works on Alpha Study", text)
            self.assertNotIn("Beta Study", text)
            self.assertNotIn("project:beta", text)
            self.assertNotIn("Where this turn may save", text)
        self.each(body)

    def test_bind_only_accepts_destinations_the_operator_typed_himself(self):
        def body(sc):
            sc.prompt("Please summarise: <pasted_content id=\"p\">Beta Study notes</pasted_content>")
            turn = sc.turn()
            denied = sc.cli("bind", "--session", sc.session, "--scope", "workspace:beta", "--quote", "Beta Study notes",
                            "--turn", turn["id"], "--token", turn["token"])
            self.assertEqual(denied.returncode, 2)
            self.assertEqual(sc.turn()["allowed"], ["operator"])
            sc.prompt("Now Alpha Study please.")
            turn = sc.turn()
            self.assertEqual(sc.cli("bind", "--session", sc.session, "--scope", "workspace:alpha", "--quote", "Alpha Study please",
                                    "--turn", turn["id"], "--token", turn["token"]).returncode, 0)
            self.assertEqual(sc.cli("bind", "--session", sc.session, "--scope", "workspace:alpha", "--quote", "Alpha Study please").returncode, 2)
        self.each(body)

    def test_a_name_inside_inline_quotes_does_not_authorize(self):
        def body(sc):
            for text in ('Please summarise "Beta Study results" for me.', "Please summarise “Beta Study results” for me.",
                         'He said "see Alpha Study" and left.'):
                sc.prompt(text)
                self.assertEqual(sc.turn()["allowed"], ["operator"], text)
            sc.prompt('Please summarise "the results" for Beta Study.')
            self.assertEqual(sc.turn()["allowed"], ["operator", "workspace:beta"])
        self.each(body)

    def test_no_digest_when_the_turn_spans_two_projects(self):
        def body(sc):
            sc.prompt("Alpha Study ran the filter pass and Beta Study did nothing today.")
            candidate = {"route": "memory", "scope": "workspace:alpha", "parameters": {"type": "lesson",
                         "text": "The alpha filter pass ran today.", "confidence": .95, "admission": dict(ADMISSION)},
                         "evidence": [{"source_id": "user", "quote": "Alpha Study ran the filter pass"}]}
            payload = sc.payload(candidate)
            payload["persist_digest"] = True
            receipt = sc.bridge.review(sc.session, sc.turn()["id"], sc.turn()["token"], payload)
            self.assertIsNone(receipt["digest"])
            self.assertTrue(receipt["digest_skipped_mixed"])
        self.each(body)


class TidyAuthorizationTests(TidyBase):
    def run_beta_pass(self, sc):
        self.seed_world(sc)
        sc.prompt("Tell me where Beta Study stands today.")
        self.run_pass(sc)
        text = sc.prompt("Thanks for Beta Study.")
        note = re.search(r"\(tidy note ([0-9A-F]{4})\)", text).group(1)
        sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "Stop", "turn_id": sc.turn()["id"],
                        "permission_mode": "default", "last_assistant_message": f"ok\n(tidy note {note})"})
        return note

    def test_undo_and_recovery_need_authorization_for_the_projects_touched(self):
        def body(sc):
            note = self.run_beta_pass(sc)
            sc.prompt("Now only Alpha Study today.")
            turn = sc.turn()
            tidy = sc.bridge.tidy()
            with self.assertRaises(Refused):
                tidy.undo(sc.session, turn["id"], turn["token"], note, 1)
            # An unfinished beta action is not resumed by a pass that may only read alpha.
            data = tidy.load()
            victim = next(a for a in data["actions"].values() if a["kind"] == "venture")
            victim["status"] = "applying"
            tidy.store(data)
            tidy.plan(sc.session, turn["id"], turn["token"])
            self.assertEqual(tidy.load()["actions"][victim["id"]]["status"], "applying")
        self.each(body)

    def test_an_edited_notes_line_is_not_removed_by_undo(self):
        def body(sc):
            note = self.run_beta_pass(sc)
            notes = sc.root / "workspaces/beta/context/CURRENT.md"
            notes.write_text(notes.read_text().replace("Moved from your general notes:", "I rewrote this line:"))
            data = sc.bridge.tidy().load()
            number = next(i["n"] for b in data["batches"] if b["id"] == note for i in b["items"]
                          if data["actions"][i["action"]]["kind"] == "notes")
            sc.prompt("Beta Study again please.")
            turn = sc.turn()
            result = sc.bridge.tidy().undo(sc.session, turn["id"], turn["token"], note, number)
            self.assertEqual(result["state"], "left-as-is")
            self.assertIn("I rewrote this line:", notes.read_text())
        self.each(body)

    def test_unfinished_actions_keep_their_entries_pending(self):
        def body(sc):
            self.seed_world(sc)
            sc.prompt("Tell me where Beta Study stands today.")
            turn = sc.turn()
            tidy = sc.bridge.tidy()
            tidy.plan(sc.session, turn["id"], turn["token"])
            done = tidy.done(sc.session, turn["id"], turn["token"])      # nothing applied yet
            self.assertTrue(done["truncated"])
            self.assertGreaterEqual(done["still_pending"], 5)
        self.each(body)

    def test_persisted_state_stays_bounded(self):
        sc = Scenario(self, "codex")
        tidy = sc.bridge.tidy()
        data = tidy.load()
        for index in range(300):
            data["actions"][f"old{index}"] = {"id": f"old{index}", "status": "undone", "applied_at": index, "records": ["x" * 500],
                                              "ops": [1], "kind": "move", "project": "beta"}
        for index in range(900):
            data["entries"].append({"seq": index, "done": False, "at": time.time(), "scope": "workspace:beta"})
        tidy.store(data)
        again = tidy.load()
        self.assertLessEqual(len(again["actions"]), 41)
        self.assertLessEqual(len(again["entries"]), 500)
        self.assertTrue(all("records" not in a for a in again["actions"].values()))


class RaceTests(TidyBase):
    def test_two_processes_asking_for_a_note_at_once_show_it_once(self):
        sc = Scenario(self, "codex")
        sc.bridge.owner  # noqa: B018
        self.seed_world(sc)
        sc.prompt("Tell me where Beta Study stands today.")
        self.run_pass(sc)
        sessions = []
        for index, harness in enumerate(["codex", "claude", "codex", "claude"]):
            sessions.append((harness, f"{harness}-race-{index}"))
        jobs = []
        for harness, session in sessions:
            event = {"session_id": session, "cwd": str(sc.root), "hook_event_name": "UserPromptSubmit", "permission_mode": "default",
                     "prompt": "Beta Study please.", "turn_id": "turn-1"}
            command = [sys.executable, str(sc.root / ".aiverse/extensions/ai-verse-codex-learning/bridge.py"), "--root", str(sc.root)]
            if harness == "claude":
                command += ["--harness", "claude"]
            job = subprocess.Popen(command + ["hook"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            job.stdin.write(json.dumps(event))
            job.stdin.close()
            jobs.append(job)
        outputs = [job.stdout.read() for job in jobs]
        for job in jobs:
            job.wait(timeout=60)
        shown = sum("A tidy note is waiting" in out for out in outputs)
        self.assertEqual(shown, 1, shown)


class FinalRoundTests(TidyBase):
    def test_owner_operations_refuse_a_reviewed_turn_and_an_unauthorized_upgrade_scan(self):
        def body(sc):
            sc.prompt("Alpha Study update please.")
            turn = sc.turn()
            auth = {"session": sc.session, "turn": turn["id"], "token": turn["token"]}
            upgrade_scan = {"projects": [], "limit": 5, "upgrade": True, "auth": auth}
            self.assertEqual(owner_call(sc, "reflect_scan", upgrade_scan).returncode, 2)      # maintainer switch is off
            sc.bridge.review(sc.session, turn["id"], turn["token"], sc.payload())
            # Reading for a tidy after the review is allowed (read only); every other new owner operation stays closed.
            self.assertEqual(owner_call(sc, "reflect_scan", {"projects": ["alpha"], "limit": 5, "auth": auth}).returncode, 0)
            self.assertEqual(owner_call(sc, "reflect_scan", {"projects": ["beta"], "limit": 5, "auth": auth}).returncode, 2)
            removal = {"scope": "operator", "parameters": {"effect_id": "x", "line_sha256": "0" * 64}, "auth": auth}
            self.assertEqual(owner_call(sc, "current_remove", removal).returncode, 2)
        self.each(body)

    def test_profile_query_hides_venture_lines_the_turn_may_not_read(self):
        def body(sc):
            for project, name in (("alpha", "Alpha Study"), ("beta", "Beta Study")):
                sc.bridge.owner("learn", {"scope": "operator", "session_id": "s", "turn_id": "t", "route": "profile", "refs": ["x:1"],
                    "parameters": {"identity": {"ventures": [{"text": f"Works on {name}", "project": project}]},
                                   "evidence": {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False,
                                                "contains_sensitive": False, "contains_secret": False, "reason": "seed"}},
                    "effect_id": "seed-" + project})
            sc.prompt("Show me what you know about me.")
            turn = sc.turn()
            out = sc.cli("query", "--session", sc.session, "--kind", "profile", "--turn", turn["id"], "--token", turn["token"])
            self.assertEqual(out.returncode, 0, out.stdout)
            self.assertNotIn("Works on Alpha Study", out.stdout)
            self.assertNotIn("Works on Beta Study", out.stdout)
        self.each(body)

    def test_a_restart_ends_the_stored_turn(self):
        def body(sc):
            sc.prompt("Alpha Study and Beta Study today.")
            turn = sc.turn()
            sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "SessionStart", "source": "resume"})
            self.assertEqual(sc.turn()["state"], "session_restarted")
            self.assertEqual(sc.turn()["allowed"], ["operator"])
            self.assertEqual(sc.cli("query", "--session", sc.session, "--kind", "context", "--scope", "workspace:alpha",
                                    "--turn", turn["id"], "--token", turn["token"]).returncode, 2)
        self.each(body)

    def test_single_quotes_are_excluded_but_apostrophes_still_work(self):
        def body(sc):
            sc.prompt("He said 'see Beta Study' and left.")
            self.assertEqual(sc.turn()["allowed"], ["operator"])
            sc.prompt("Bogdan's note: don't forget Beta Study today.")
            self.assertEqual(sc.turn()["allowed"], ["operator", "workspace:beta"])
        self.each(body)

    def test_no_digest_while_a_name_is_unresolved(self):
        def body(sc):
            sc.prompt("Please look at workspace:missing and tell me the filter retained all twelve correct records.")
            self.assertTrue(sc.turn()["ambiguous"])
            payload = sc.payload()
            payload["persist_digest"] = True
            sc.bridge.hook({"session_id": sc.session, "turn_id": sc.turn()["id"], "cwd": str(sc.root), "hook_event_name": "PostToolUse",
                            "permission_mode": "default", "tool_use_id": "t1", "tool_response": {"output": "done"}})
            receipt = sc.bridge.review(sc.session, sc.turn()["id"], sc.turn()["token"], payload)
            self.assertIsNone(receipt["digest"])
        self.each(body)

    def test_an_action_without_recorded_authorization_is_never_resumed_or_undone(self):
        def body(sc):
            note = TidyAuthorizationTests.run_beta_pass(self, sc)
            tidy = sc.bridge.tidy()
            data = tidy.load()
            for action in data["actions"].values():
                action.pop("authorized", None)
            victim = next(a for a in data["actions"].values() if a["kind"] == "venture")
            victim["status"] = "applying"
            tidy.store(data)
            sc.prompt("Beta Study again.")
            turn = sc.turn()
            with self.assertRaises(Refused):
                tidy.undo(sc.session, turn["id"], turn["token"], note, 1)
            tidy.plan(sc.session, turn["id"], turn["token"])
            self.assertEqual(tidy.load()["actions"][victim["id"]]["status"], "applying")
        self.each(body)

    def test_removal_without_the_line_hash_is_refused(self):
        def body(sc):
            sc.prompt("Beta Study update please.")
            turn = sc.turn()
            auth = {"session": sc.session, "turn": turn["id"], "token": turn["token"]}
            result = owner_call(sc, "current_remove", {"scope": "workspace:beta", "parameters": {"effect_id": "x"}, "auth": auth})
            self.assertEqual(result.returncode, 2)
            self.assertIn("hash", result.stdout)
        self.each(body)


if __name__ == "__main__":
    unittest.main()
