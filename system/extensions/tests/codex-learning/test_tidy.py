"""Tidying: ledger, due, lease, plan, apply, note, undo, recovery, limits, privacy (both apps)."""
import json
import os
import re
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

import bridge as bridge_module
from bridge import Bridge, Refused, digest
from test_bridge import ADMISSION
from test_parity import EVIDENCE, HARNESSES, Scenario

USER_REF = "{h}:turn:seed:source:" + digest("user")[:16] + ":sha256:" + "0" * 64
OTHER_REF = "{h}:turn:seed:source:" + digest("assistant")[:16] + ":sha256:" + "1" * 64


class TidyBase(unittest.TestCase):
    def each(self, body):
        for harness in HARNESSES:
            with self.subTest(harness=harness):
                sc = Scenario(self, harness)
                manifest = sc.root / "workspaces/beta/WORKSPACE.yaml"
                manifest.write_text(manifest.read_text() + 'aliases:\n  - "Skoolish"\n')
                body(sc)

    def seed(self, sc, text, ref, scope="operator", tags=""):
        params = {"type": "fact", "text": text, "confidence": .9, "admission": dict(ADMISSION)}
        if tags:
            params["tags"] = tags
        result = sc.bridge.owner("learn", {"scope": scope, "session_id": "seed", "turn_id": "seed", "route": "memory",
                                           "parameters": params, "refs": [ref.format(h=sc.harness)],
                                           "effect_id": "seed:" + digest(text)[:12]})
        return result["result"]["memory_capture"]["memory_id"]

    def ledger(self, sc, count=5, scope="workspace:beta", traced=True):
        tidy = sc.bridge.tidy()
        for index in range(count):
            tidy.record({"id": f"seed-{index}"}, {"route": "memory", "scope": scope},
                        {"result": {"memory_capture": {"state": "captured", "memory_id": f"mem-seed-{index}"}}},
                        ["user"] if traced else ["tool"])

    def seed_world(self, sc):
        self.ledger(sc)
        self.seed(sc, "Beta Study now has 81 members and 289 dollars a month.", USER_REF)
        self.seed(sc, "Skoolish probably has a leaderboard for affiliates.", OTHER_REF)
        notes = sc.root / "workspaces/beta/context/CURRENT.md"
        old = time.time() - 20 * 86400
        os.utime(notes, (old, old))

    def prompt_about_beta(self, sc, text="Tell me where Beta Study stands today."):
        return sc.prompt(text)

    def run_pass(self, sc):
        turn = sc.turn()
        tidy = sc.bridge.tidy()
        plan = tidy.plan(sc.session, turn["id"], turn["token"])
        applied = tidy.apply(sc.session, turn["id"], turn["token"])
        done = tidy.done(sc.session, turn["id"], turn["token"])
        return plan, applied, done


class TidyTests(TidyBase):
    def test_due_advert_has_the_exact_commands_and_nothing_when_not_due(self):
        def body(sc):
            quiet = sc.prompt("Hello there, how are you?")
            self.assertNotIn("tidying is due", quiet)
            self.ledger(sc, count=4)
            self.assertNotIn("tidying is due", sc.prompt("Still quiet please."))
            self.ledger(sc, count=1)
            text = sc.prompt("Now it should be due.")
            turn = sc.turn()
            for action in ("plan", "apply", "done"):
                self.assertIn(f"reflect {action} --session {sc.session} --turn {turn['id']} --token {turn['token']}", text)
        self.each(body)

    def test_the_review_and_tidy_commands_survive_every_supported_budget(self):
        def body(sc):
            self.ledger(sc, count=5)
            for limit in (24000, 14000, 9000, 6000, 4096):
                sc.bridge.config["context_max_bytes"] = limit
                text = sc.prompt("Hello there, what is next today?")
                turn = sc.turn()
                self.assertLessEqual(len(text.encode()), limit)
                for action in ("plan", "apply", "done"):
                    self.assertIn(f"reflect {action} --session {sc.session} --turn {turn['id']} --token {turn['token']}", text, limit)
                self.assertIn(f"review --session {sc.session} --turn {turn['id']} --token {turn['token']}", text, limit)
        self.each(body)

    def test_an_old_single_entry_makes_it_due(self):
        def body(sc):
            self.ledger(sc, count=1)
            state = sc.bridge.tidy().load()
            state["entries"][0]["at"] = time.time() - 7 * 3600
            sc.bridge.tidy().store(state)
            self.assertIn("tidying is due", sc.prompt("Hello again."))
        self.each(body)

    def test_one_pass_fixes_the_traced_items_flags_a_guess_and_the_note_matches(self):
        def body(sc):
            self.seed_world(sc)
            started = time.monotonic()
            sc.prompt("Tell me where Beta Study stands today.")
            plan, applied, done = self.run_pass(sc)
            self.assertLess(time.monotonic() - started, 60)
            kinds = sorted((i["kind"], i["traced"]) for i in plan["items"])
            self.assertEqual(kinds, [("move", False), ("move", True), ("notes", True), ("venture", False)])
            self.assertEqual(len(applied["applied"]), 4)
            beta = "\n".join(p.read_text() for p in (sc.root / "workspaces/beta").rglob("mem-*.md"))
            self.assertIn("81 members and 289 dollars", beta)
            self.assertIn("⚠️ guess", beta)  # the guessed copy keeps its marker
            operator = "\n".join(p.read_text() for p in (sc.root / "operator/memory").rglob("mem-*.md"))
            self.assertIn("Moved to the Beta Study project", operator)
            self.assertIn("status: superseded", operator)
            self.assertIn("Works on Beta Study ⚠️ guess", (sc.root / "operator/profile/identity.md").read_text())
            self.assertIn("81 members", (sc.root / "workspaces/beta/context/CURRENT.md").read_text())
            self.assertEqual(done["still_pending"], 0)
            # Next reply: the note is delivered once, in the agreed format.
            text = sc.prompt("Thanks. What next for Beta Study?")
            note = text.split("exactly as written, before anything else, then carry on with the answer. Never place it in the middle of an answer:\n", 1)[1].split("\nBound scope:", 1)[0].strip()
            self.assertTrue(note.startswith("\U0001f9f9 **AI-Verse OS tidied 4 things it knows about you**\n\n**1. "))
            self.assertIn("• From: your general profile → To: your Beta Study project", note)
            self.assertIn("**4. ⚠️ A guess: your projects list**", note)
            self.assertIn("• Why: you have a project for it, but you never said you still run it", note)
            self.assertIn("✅ All correct? Just carry on.", note)
            self.assertIn("✏️ Something wrong? Say \"undo N\", or tell me what's right.", note)
            for banned in ("workspace", "scope", "owner", "bridge", "Memory", "profile\"", "hook"):
                self.assertNotIn(banned, note.replace("your general profile", ""))
        self.each(body)

    def test_note_is_acknowledged_only_after_the_reply_is_seen_and_then_not_repeated(self):
        def body(sc):
            self.seed_world(sc)
            sc.prompt("Tell me where Beta Study stands today.")
            self.run_pass(sc)
            first = sc.prompt("Thanks for Beta Study.")
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", first).group(1)
            # A prompt that arrives at the same moment (another app) does not get a second copy.
            other = Bridge(sc.root, harness="claude")
            twin = other.hook({"session_id": "claude-twin-0001", "cwd": str(sc.root), "hook_event_name": "UserPromptSubmit",
                               "permission_mode": "default", "prompt": "Beta Study too.", "turn_id": "turn-1"})
            self.assertNotIn("A tidy note is waiting", twin["hookSpecificOutput"]["additionalContext"])
            # Interrupted delivery: no reply seen, so after the claim lapses the next prompt carries the same note.
            with patch.object(sc.bridge.tidy(), "claim_seconds", 0):
                again = sc.prompt("Anything else on Beta Study?")
            self.assertIn(f"(tidy note {note_id})", again)
            sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "Stop",
                            "turn_id": sc.turn()["id"], "permission_mode": "default",
                            "last_assistant_message": f"Here you go.\n(tidy note {note_id})"})
            later = sc.prompt("One more thing about Beta Study.")
            self.assertNotIn("A tidy note is waiting", later)
            self.assertEqual(sc.bridge.tidy().status()["tidy_changes_shown"], 4)
        self.each(body)

    def test_second_pass_changes_nothing_and_no_new_work_means_no_pass(self):
        def body(sc):
            self.seed_world(sc)
            sc.prompt("Tell me where Beta Study stands today.")
            self.run_pass(sc)
            sc.prompt("Beta Study again please.")
            self.ledger(sc, count=5)
            before = {p: p.read_text() for p in sc.root.rglob("*.md") if "runtime" not in str(p)}
            plan, applied, done = self.run_pass(sc)
            self.assertEqual(plan["items"], [])
            self.assertEqual(applied["applied"], [])
            after = {p: p.read_text() for p in sc.root.rglob("*.md") if "runtime" not in str(p)}
            self.assertEqual(before, after)
            self.assertNotIn("tidying is due", sc.prompt("Nothing new to tidy."))
        self.each(body)

    def test_undo_reverses_one_item_by_adding_records_and_keeps_later_edits(self):
        def body(sc):
            self.seed_world(sc)
            sc.prompt("Tell me where Beta Study stands today.")
            plan, applied, done = self.run_pass(sc)
            text = sc.prompt("Thanks for Beta Study.")
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", text).group(1)
            sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "Stop", "turn_id": sc.turn()["id"],
                            "permission_mode": "default", "last_assistant_message": f"ok\n(tidy note {note_id})"})
            # Item order follows the pass; find the guess about the projects list.
            data = sc.bridge.tidy().load()
            batch = next(b for b in data["batches"] if b["id"] == note_id)
            number = next(i["n"] for i in batch["items"] if data["actions"][i["action"]]["kind"] == "venture")
            turn = sc.turn()
            result = sc.bridge.tidy().undo(sc.session, turn["id"], turn["token"], note_id, number)
            self.assertEqual(result["state"], "undone")
            self.assertNotIn("Works on Beta Study", (sc.root / "operator/profile/identity.md").read_text())
            history = (sc.root / "operator/profile/AUTO-ORGANIZATION.json").read_text()
            self.assertIn("Works on Beta Study", history)  # nothing is physically deleted
            # Remembered: reflecting again does not re-add it while the inputs are unchanged.
            sc.prompt("Beta Study once more.")
            self.ledger(sc, count=5)
            plan2, _, _ = self.run_pass(sc)
            self.assertNotIn("venture", [i["kind"] for i in plan2["items"]])
            self.assertEqual(sc.bridge.tidy().status()["tidy_changes_corrected"], 1)
        self.each(body)

    def test_undo_of_a_move_restores_the_general_fact_and_retires_the_copy(self):
        def body(sc):
            self.seed_world(sc)
            sc.prompt("Tell me where Beta Study stands today.")
            self.run_pass(sc)
            text = sc.prompt("Thanks for Beta Study.")
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", text).group(1)
            sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "Stop", "turn_id": sc.turn()["id"],
                            "permission_mode": "default", "last_assistant_message": f"ok\n(tidy note {note_id})"})
            data = sc.bridge.tidy().load()
            batch = next(b for b in data["batches"] if b["id"] == note_id)
            number = next(i["n"] for i in batch["items"]
                          if data["actions"][i["action"]]["kind"] == "move" and data["actions"][i["action"]]["traced"])
            turn = sc.turn()
            self.assertEqual(sc.bridge.tidy().undo(sc.session, turn["id"], turn["token"], note_id, number)["state"], "undone")
            active = {}
            for path in (sc.root).rglob("mem-*.md"):
                text = path.read_text()
                if "status: active" in text:
                    active[path.name] = text
            joined = "\n".join(active.values())
            self.assertIn("now has 81 members and 289 dollars", joined)       # restored in general memory
            self.assertIn("Retracted: the operator undid", joined)             # the project copy retired, not deleted
            self.assertEqual(len(list((sc.root / "workspaces/beta").rglob("mem-*.md"))), 3)
        self.each(body)

    def test_undo_after_an_intervening_edit_keeps_the_edit(self):
        def body(sc):
            self.seed_world(sc)
            sc.prompt("Tell me where Beta Study stands today.")
            self.run_pass(sc)
            text = sc.prompt("Thanks for Beta Study.")
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", text).group(1)
            sc.bridge.hook({"session_id": sc.session, "cwd": str(sc.root), "hook_event_name": "Stop", "turn_id": sc.turn()["id"],
                            "permission_mode": "default", "last_assistant_message": f"ok\n(tidy note {note_id})"})
            identity = sc.root / "operator/profile/identity.md"
            identity.write_text(identity.read_text().replace("Works on Beta Study", "Runs Beta Study"))
            data = sc.bridge.tidy().load()
            batch = next(b for b in data["batches"] if b["id"] == note_id)
            number = next(i["n"] for i in batch["items"] if data["actions"][i["action"]]["kind"] == "venture")
            turn = sc.turn()
            result = sc.bridge.tidy().undo(sc.session, turn["id"], turn["token"], note_id, number)
            self.assertEqual(result["state"], "left-as-is")
            self.assertIn("Runs Beta Study", identity.read_text())
        self.each(body)

    def test_only_projects_in_view_are_tidied_and_notes_stay_private(self):
        def body(sc):
            self.seed_world(sc)
            self.seed(sc, "Alpha Study has twelve verified records today.", USER_REF)
            sc.prompt("Tell me where Beta Study stands today.")
            plan, _, _ = self.run_pass(sc)
            self.assertEqual({i["project"] for i in plan["items"]}, {"beta"})
            self.assertIn("Alpha Study has twelve", "\n".join(
                p.read_text() for p in (sc.root / "operator/memory").rglob("mem-*.md") if "status: active" in p.read_text()))
            # A prompt in private project alpha must not receive beta's note.
            text = sc.prompt("What is up with Alpha Study?")
            self.assertNotIn("A tidy note is waiting", text)
            self.assertNotIn("81 members", text)
            self.assertNotIn("Beta Study", text.split("Owner data (JSON)", 1)[0].split("Words for", 1)[0])
        self.each(body)


class TidySafetyTests(TidyBase):
    def test_a_second_pass_while_one_holds_the_lease_is_refused_and_a_replaced_holder_stops(self):
        sc = Scenario(self, "codex")
        other = Bridge(sc.root, harness="claude")
        self.ledger(sc, count=5)
        sc.prompt("Beta Study update please.")
        other.hook({"session_id": "claude-two-0001", "cwd": str(sc.root), "hook_event_name": "UserPromptSubmit",
                    "permission_mode": "default", "prompt": "Beta Study too.", "turn_id": "turn-1"})
        turn_two = other.state("claude-two-0001")["turn"]
        turn = sc.turn()
        sc.bridge.tidy().plan(sc.session, turn["id"], turn["token"])
        with self.assertRaises(Refused):
            other.tidy().plan("claude-two-0001", turn_two["id"], turn_two["token"])
        # The lease expires: the second app takes over; the first holder is fenced out.
        data = sc.bridge.tidy().load()
        data["lease"]["expires"] = time.time() - 1
        sc.bridge.tidy().store(data)
        other.tidy().plan("claude-two-0001", turn_two["id"], turn_two["token"])
        with self.assertRaises(Refused):
            sc.bridge.tidy().apply(sc.session, turn["id"], turn["token"])
        with self.assertRaises(Refused):
            sc.bridge.tidy().done(sc.session, turn["id"], turn["token"])

    def test_two_processes_planning_at_once_produce_one_active_pass(self):
        sc = Scenario(self, "codex")
        self.seed_world(sc)
        other = Bridge(sc.root, harness="claude")
        sc.prompt("Beta Study update please.")
        other.hook({"session_id": "claude-two-0002", "cwd": str(sc.root), "hook_event_name": "UserPromptSubmit",
                    "permission_mode": "default", "prompt": "Beta Study too.", "turn_id": "turn-1"})
        turn_two = other.state("claude-two-0002")["turn"]
        turn = sc.turn()
        jobs = []
        for harness, session, t in (("codex", sc.session, turn), ("claude", "claude-two-0002", turn_two)):
            command = [sys.executable, str(sc.root / ".aiverse/extensions/ai-verse-codex-learning/bridge.py"), "--root", str(sc.root)]
            if harness == "claude":
                command += ["--harness", "claude"]
            command += ["reflect", "plan", "--session", session, "--turn", t["id"], "--token", t["token"]]
            jobs.append(subprocess.Popen(command, stdout=subprocess.PIPE, text=True))
        outputs = [json.loads(job.communicate(timeout=90)[0]) for job in jobs]
        winners = [o for o in outputs if o.get("pass") == "planned"]
        self.assertEqual(len(winners), 1, outputs)

    def test_a_crash_midway_is_finished_by_the_next_pass_and_still_produces_a_note(self):
        sc = Scenario(self, "claude")
        manifest = sc.root / "workspaces/beta/WORKSPACE.yaml"
        manifest.write_text(manifest.read_text() + 'aliases:\n  - "Skoolish"\n')
        self.seed_world(sc)
        sc.prompt("Tell me where Beta Study stands today.")
        turn = sc.turn()
        tidy = sc.bridge.tidy()
        tidy.plan(sc.session, turn["id"], turn["token"])
        real = sc.bridge.owner
        calls = {"n": 0}

        def crashing(operation, payload):
            if operation == "learn" and payload["effect_id"].endswith(":pointer0"):
                raise Refused("simulated crash after the copy was written")
            return real(operation, payload)
        sc.bridge.owner = crashing
        tidy.apply(sc.session, turn["id"], turn["token"])
        sc.bridge.owner = real
        self.assertTrue(any(a["status"] == "applying" for a in tidy.load()["actions"].values()))
        before = len(list((sc.root / "workspaces/beta").rglob("mem-*.md")))
        # A later turn (a "restart"): the next pass recovers from the recorded operations and finishes the work.
        sc.prompt("Beta Study after a restart.")
        turn = sc.turn()
        lapsed = tidy.load()
        lapsed["lease"]["expires"] = time.time() - 1  # the crashed pass's lease has run out
        tidy.store(lapsed)
        tidy.plan(sc.session, turn["id"], turn["token"])
        data = tidy.load()
        self.assertFalse(any(a["status"] == "applying" for a in data["actions"].values()))
        recovered = [a for a in data["actions"].values() if a["status"] == "applied"]
        self.assertTrue(recovered)
        after = len(list((sc.root / "workspaces/beta").rglob("mem-*.md")))
        self.assertGreaterEqual(after, before)
        self.assertEqual(len({p.read_text() for p in (sc.root / "workspaces/beta").rglob("mem-*.md")}), after, "no duplicate copies")
        tidy.done(sc.session, turn["id"], turn["token"])
        self.assertIn("A tidy note is waiting", sc.prompt("Beta Study again."))

    def test_hard_limits_on_a_large_backlog(self):
        sc = Scenario(self, "codex")
        self.seed_world(sc)
        self.ledger(sc, count=35)
        for index in range(6):
            self.seed(sc, f"Beta Study detail number {index} was noted.", USER_REF)
        sc.prompt("Tell me where Beta Study stands today.")
        turn = sc.turn()
        tidy = sc.bridge.tidy()
        plan = tidy.plan(sc.session, turn["id"], turn["token"])
        self.assertEqual(plan["pending_inspected"], 20)
        self.assertTrue(plan["truncated"])
        self.assertLessEqual(len(plan["items"]), 5)
        self.assertLessEqual(len(json.dumps(plan).encode()), 24 * 1024)

    def test_time_limit_leaves_work_for_later(self):
        sc = Scenario(self, "codex")
        self.seed_world(sc)
        sc.prompt("Tell me where Beta Study stands today.")
        turn = sc.turn()
        tidy = sc.bridge.tidy()
        tidy.plan(sc.session, turn["id"], turn["token"])
        with patch.object(tidy, "work_seconds", -1):
            applied = tidy.apply(sc.session, turn["id"], turn["token"])
        self.assertEqual(applied["applied"], [])
        self.assertTrue(applied["truncated"])
        done = tidy.done(sc.session, turn["id"], turn["token"])
        self.assertTrue(done["truncated"])

    def test_secrets_and_deletions_are_never_tidied(self):
        sc = Scenario(self, "codex")
        self.ledger(sc, count=5)
        self.seed_world(sc)
        with self.assertRaises(Exception):
            self.seed(sc, "Beta Study api key: sk-abcdefghijklmnopqrstuvwx", USER_REF)
        sc.prompt("Tell me where Beta Study stands today.")
        plan, _, _ = self.run_pass(sc)
        self.assertNotIn("sk-abc", json.dumps(plan))
        self.assertFalse(any(k in {"delete", "permission", "goal"} for k in (i["kind"] for i in plan["items"])))

    def test_a_guess_stays_a_guess_through_a_second_pass(self):
        sc = Scenario(self, "claude")
        manifest = sc.root / "workspaces/beta/WORKSPACE.yaml"
        manifest.write_text(manifest.read_text() + 'aliases:\n  - "Skoolish"\n')
        self.seed_world(sc)
        sc.prompt("Tell me where Beta Study stands today.")
        self.run_pass(sc)
        copies = [p.read_text() for p in (sc.root / "workspaces/beta").rglob("mem-*.md") if "guess" in p.read_text()]
        self.assertTrue(copies)
        tidy = sc.bridge.tidy()
        record = {"evidence_refs": [USER_REF.format(h="claude")], "tags": "tidy,guess,moved",
                  "text": "Skoolish probably has a leaderboard. ⚠️ guess: moved on a name match"}
        self.assertFalse(tidy.traced(record))
        self.assertFalse(tidy.traced({**record, "tags": "", "text": "plain text ⚠️ guess: x"}))
        self.assertTrue(tidy.traced({"evidence_refs": [USER_REF.format(h="claude")], "tags": "", "text": "plain"}))


if __name__ == "__main__":
    unittest.main()
