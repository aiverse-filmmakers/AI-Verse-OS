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
            self.ledger(sc, count=4, scope="operator")
            self.assertNotIn("tidying is due", sc.prompt("Still quiet please."))
            self.ledger(sc, count=1, scope="operator")
            text = sc.prompt("Now it should be due.")
            turn = sc.turn()
            for action in ("plan", "apply", "done"):
                self.assertIn(f"reflect {action} --session {sc.session} --turn {turn['id']} --token {turn['token']}", text)
        self.each(body)

    def test_the_review_and_tidy_commands_survive_every_supported_budget(self):
        def body(sc):
            self.ledger(sc, count=5, scope="operator")
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
            self.ledger(sc, count=1, scope="operator")
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


class TidyWholeTests(TidyBase):
    """`reflect all`: the only change is removing a true repeat in the same place; any chat; private across projects."""

    DUP = "The studio invoices every client on the first of the month."
    KEY = "invoices every client"

    @staticmethod
    def twin(text):
        return text.replace(" ", "  ", 1)  # the same words, spaced differently

    def pair(self, sc, text, scope="operator", tags=""):
        self.seed(sc, text, USER_REF, scope=scope, tags=tags)
        self.seed(sc, self.twin(text), USER_REF, scope=scope, tags=tags)

    def all_pass(self, sc, mode="recent"):
        turn = sc.turn()
        return sc.bridge.tidy().all(sc.session, turn["id"], turn["token"], mode)

    def finish(self, sc, limit=3, mode="recent", cwd=None):
        """Repeated passes until a pass finishes everything; returns each result."""
        results = []
        for _ in range(20):
            sc.prompt("Please look over everything you know.", cwd=cwd)
            with patch.object(sc.bridge.tidy(), "whole_records", limit):
                results.append(self.all_pass(sc, mode))
            if not results[-1]["more_to_check"]:
                return results
        self.fail("the cursor never finished")

    def changed(self, results):
        return sum(r["changed"] + r["changed_in_other_projects"] for r in results)

    def active_text(self, sc, scope="operator"):
        base = sc.root / ("operator" if scope == "operator" else "workspaces/" + scope) / "memory"
        return "\n".join(p.read_text() for p in base.rglob("mem-*.md") if "status: active" in p.read_text())

    def files(self, sc):
        return {p: p.read_text() for p in sc.root.rglob("mem-*.md")}

    def age(self, sc, key, days):
        for path in sc.root.rglob("mem-*.md"):
            if key in path.read_text():
                path.write_text(re.sub(r"(?m)^created_at: .*$", "created_at: " + time.strftime(
                    "%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() - days * 86400)), path.read_text()))

    def test_true_repeats_are_removed_over_batches_and_nothing_is_hard_deleted(self):
        def body(sc):
            self.pair(sc, self.DUP)
            for n in range(6):
                self.seed(sc, f"Unrelated saved note number {n} about the weekly rhythm.", USER_REF)
            self.assertEqual(self.changed(self.finish(sc)), 1)
            self.assertEqual(self.active_text(sc).count(self.KEY), 1)
            self.assertEqual("\n".join(self.files(sc).values()).count(self.KEY), 2)
            before = self.files(sc)
            self.assertEqual(self.changed(self.finish(sc)), 0)
            self.assertEqual(before, self.files(sc), "a second pass changes nothing")
        self.each(body)

    def test_the_note_says_removed_and_undo_restores_tags_evidence_and_leaves_the_kept_copy_alone(self):
        def body(sc):
            self.pair(sc, self.DUP, tags="billing,monthly")
            self.finish(sc)
            kept = [t for t in self.files(sc).values() if self.KEY in t and "status: active" in t]
            self.assertEqual(len(kept), 1)
            text = sc.prompt("Thanks.")
            note = text.split("Never place it in the middle of an answer:\n", 1)[1].split("\nBound scope:", 1)[0].strip()
            self.assertIn("**1. Something you saved twice was removed**", note)
            self.assertIn("• I removed the repeat and kept the first copy.", note)
            for banned in ("workspace", "scope", "owner", "bridge", "Memory", "hook"):
                self.assertNotIn(banned, note)
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", note).group(1)
            sc.bridge.tidy().acknowledge({"session_id": sc.session}, note)
            sc.prompt("Undo it.")
            turn = sc.turn()
            self.assertEqual(sc.bridge.tidy().undo(sc.session, turn["id"], turn["token"], note_id, 1)["state"], "undone")
            self.assertEqual(self.active_text(sc).count(self.KEY), 2)
            restored = [t for t in self.files(sc).values() if "restored" in t and "status: active" in t]
            self.assertEqual(len(restored), 1)
            self.assertIn("billing", restored[0])
            self.assertIn("was-fact", restored[0])
            self.assertIn("source:" + digest("user")[:16], restored[0])  # the evidence came back
            self.assertEqual([t for t in self.files(sc).values() if t in kept and "status: active" in t], kept)
            self.assertEqual(self.changed(self.finish(sc)), 0, "an undone removal is not repeated")
        self.each(body)

    def test_the_same_thing_in_a_project_and_in_overall_memory_is_left_alone(self):
        def body(sc):
            self.seed(sc, self.DUP, USER_REF)
            self.seed(sc, self.twin(self.DUP), USER_REF, scope="workspace:beta")
            self.assertEqual(self.changed(self.finish(sc)), 0)
            self.assertEqual(self.active_text(sc).count(self.KEY), 1)
            self.assertEqual(self.active_text(sc, "beta").count(self.KEY), 1)
            self.seed(sc, self.DUP.replace(" ", "   ", 1), USER_REF, scope="workspace:beta")  # a true repeat inside the project
            self.assertEqual(self.changed(self.finish(sc)), 1)
            self.assertEqual(self.active_text(sc, "beta").count(self.KEY), 1)
            self.assertEqual(self.active_text(sc).count(self.KEY), 1)
        self.each(body)

    def test_different_things_are_not_repeats(self):
        def body(sc):
            for a, b in (("Prefers C++ for all of the rendering engine code.", "Prefers C# for all of the rendering engine code."),
                         ("Moves the price of the new plan by +5% next quarter.", "Moves the price of the new plan by -5% next quarter."),
                         ("Meetings with the board are held on the first Monday.", "Meetings with the board are held on the first Monday?")):
                self.seed(sc, a, USER_REF)
                self.seed(sc, b, USER_REF)
            self.seed(sc, "A short saved note about the very long list " + "of details " * 70, USER_REF)  # shortened when scanned
            self.seed(sc, "A short saved note about the very long list  " + "of details " * 70, USER_REF)
            before = self.files(sc)
            self.assertEqual(self.changed(self.finish(sc, mode="full")), 0)
            self.assertEqual(before, self.files(sc))
        self.each(body)

    def test_whole_passes_never_move_refresh_or_guess_even_when_a_project_is_named(self):
        def body(sc):
            self.seed_world(sc)  # facts naming Beta Study, old project notes, a project without a venture line
            self.pair(sc, "Beta Study sends its newsletter on Fridays after lunch.")
            identity = sc.root / "operator/profile/identity.md"
            profile = identity.read_text() if identity.exists() else ""
            notes = (sc.root / "workspaces/beta/context/CURRENT.md").read_text()
            self.assertEqual(self.changed(self.finish(sc, mode="full")), 1)  # only the repeat, kept where it was
            self.assertEqual(profile, identity.read_text() if identity.exists() else "")
            self.assertEqual(notes, (sc.root / "workspaces/beta/context/CURRENT.md").read_text())
            self.assertEqual(self.active_text(sc, "beta"), "")
            self.assertEqual(self.active_text(sc).count("newsletter on Fridays"), 1)
        self.each(body)

    def test_a_tidy_covers_seven_days_but_compares_with_older_records(self):
        def body(sc):
            self.pair(sc, self.DUP)
            self.age(sc, self.KEY, 40)  # both too old for a 7 day tidy
            self.assertEqual(self.changed(self.finish(sc, mode="recent")), 0)
            self.seed(sc, self.DUP.replace(" every", "   every"), USER_REF)  # saved now; compared with the old copies
            self.assertEqual(self.changed(self.finish(sc, mode="recent")), 1)
            old = [t for t in self.files(sc).values() if self.KEY in t and "status: active" in t]
            self.assertEqual(len(old), 2, "the old records were never changed")
            self.assertEqual(self.changed(self.finish(sc, mode="full")), 1)
        self.each(body)

    def test_a_batch_that_is_not_finished_says_so_and_retries_from_the_same_place(self):
        def body(sc):
            for n in range(7):
                self.pair(sc, f"Repeated saved note number {n} about the weekly rhythm.")
            sc.prompt("Tidy.")
            first = self.all_pass(sc)
            self.assertEqual(first["changed"], 5)  # five changes per pass
            self.assertTrue(first["more_to_check"])
            state = sc.bridge.tidy().load()["whole"]
            self.assertIsNone(state.get("last_tidy"), "an unfinished pass is not a finished tidy")
            sc.prompt("Tidy again.")
            second = self.all_pass(sc)
            self.assertEqual(second["changed"], 2)
            self.assertFalse(second["more_to_check"])
            self.assertTrue(sc.bridge.tidy().load()["whole"]["last_tidy"])
        self.each(body)

    def test_an_action_left_half_done_stops_the_pass_from_completing(self):
        def body(sc):
            self.pair(sc, self.DUP)
            tidy = sc.bridge.tidy()
            sc.prompt("Tidy.")
            with patch.object(tidy, "run_ops", side_effect=bridge_module.Refused("owner busy")):
                result = self.all_pass(sc)
            self.assertTrue(result["more_to_check"])
            self.assertEqual(result["changed"], 0)
            self.assertIsNone(tidy.load()["whole"].get("last_tidy"))
            self.assertEqual(self.changed(self.finish(sc)), 1)  # the next pass finishes it
            self.assertTrue(tidy.load()["whole"]["last_tidy"])
        self.each(body)

    def test_saves_made_during_a_full_pass_are_counted_from_its_start(self):
        def body(sc):
            for n in range(3):
                self.pair(sc, f"Repeated saved note number {n} about the weekly rhythm.")
            tidy = sc.bridge.tidy()
            sc.prompt("Start.")
            with patch.object(tidy, "whole_records", 1):
                self.assertTrue(self.all_pass(sc, "full")["more_to_check"])
            start = tidy.load()["whole"]["cycle_start"]
            self.pair(sc, "Saved while a long pass was running, twice over.")
            self.finish(sc, limit=1, mode="full")
            state = tidy.load()["whole"]
            self.assertEqual(state["last_tidy"], start)  # the next small pass counts from the start, not the end
            self.assertEqual(state["last_full"], start)
        self.each(body)

    def test_applied_changes_and_undelivered_notes_are_never_pruned(self):
        def body(sc):
            tidy = sc.bridge.tidy()
            data = tidy.load()
            for n in range(70):
                data["actions"][f"a{n}"] = {"id": f"a{n}", "kind": "dup", "project": "operator", "status": "applied", "applied_at": n,
                                            "title": "t", "detail": ["d"]}
            for n in range(35):
                data["batches"].append({"id": f"{n:04X}", "items": [{"n": 1, "action": f"a{n}"}], "turn": "x", "claimed_at": 0,
                                        "acked": n >= 5, "day": "2026-01-01"})
            tidy.store(data)
            data = tidy.load()
            self.assertEqual(len(data["actions"]), 70)
            self.assertTrue(all(any(b["id"] == f"{n:04X}" for b in data["batches"]) for n in range(5)), "unacknowledged notes stay")
        self.each(body)

    def test_a_chat_only_claims_notes_it_may_read_and_the_others_stay_queued(self):
        def body(sc):
            tidy = sc.bridge.tidy()
            data = tidy.load()
            for aid, project in (("beta1", "beta"), ("gen1", "operator")):
                data["actions"][aid] = {"id": aid, "kind": "dup", "project": project, "status": "applied", "applied_at": 1,
                                        "title": f"Title {aid}", "detail": ["d"], "authorized": ["operator"]}
            data["batches"] = [{"id": "AAAA", "items": [{"n": 1, "action": "beta1"}], "turn": "x", "claimed_at": 0, "acked": False, "day": "d"},
                               {"id": "BBBB", "items": [{"n": 1, "action": "gen1"}], "turn": "y", "claimed_at": 0, "acked": False, "day": "d"}]
            tidy.store(data)
            text = sc.prompt("Hello there.")
            self.assertIn("Title gen1", text)
            self.assertNotIn("Title beta1", text)
            self.assertEqual([b["id"] for b in tidy.load()["batches"] if not b["acked"]], ["AAAA", "BBBB"])
        self.each(body)

    def test_legacy_entries_a_chat_cannot_read_do_not_hide_the_automatic_pass(self):
        def body(sc):
            self.ledger(sc, count=25, scope="workspace:beta")
            general = sc.prompt("Plain chat.")
            self.assertIn("reflect all --auto", general)
            self.assertNotIn("reflect plan", general)
            inside = sc.prompt("Inside beta.", cwd=str(sc.root / "workspaces/beta"))
            self.assertIn("reflect plan", inside)
        self.each(body)

    def test_the_monthly_trigger_works_before_the_first_finished_tidy(self):
        def body(sc):
            tidy = sc.bridge.tidy()
            self.ledger(sc, count=1, scope="operator")
            state = tidy.load()
            for entry in state["entries"]:
                entry["done"] = True
            tidy.store(state)
            self.assertNotIn("reflect all", sc.prompt("Fresh."))
            state = tidy.load()
            state["whole"]["origin"] = time.time() - 31 * 86400
            tidy.store(state)
            self.assertIn("reflect all --auto", sc.prompt("A month after the first save."))
        self.each(body)

    def test_it_is_offered_in_any_chat_after_enough_saves_a_month_or_a_long_time(self):
        def body(sc):
            self.ledger(sc, count=25, scope="operator")
            tidy = sc.bridge.tidy()
            state = tidy.load()
            for entry in state["entries"]:
                entry["done"] = True
            tidy.store(state)
            text = sc.prompt("Inside the project.", cwd=str(sc.root / "workspaces/beta"))
            self.assertIn("tidying of everything saved is due", text)
            self.assertIn(f"reflect all --auto --session {sc.session} --turn {sc.turn()['id']} --token {sc.turn()['token']}", text)
            self.finish(sc, mode="auto")  # never tidied: a full pass
            self.assertNotIn("reflect all", sc.prompt("Quiet again."))
            self.ledger(sc, count=1, scope="operator")
            state = tidy.load()
            for entry in state["entries"]:
                entry["done"] = True
            state["whole"]["last_tidy"] = time.time() - 31 * 86400
            state["whole"]["last_run"] = 0
            tidy.store(state)
            self.assertIn("reflect all --auto", sc.prompt("A month later."))
            self.finish(sc, mode="auto")  # small: last full pass is recent
            self.assertFalse(tidy.load()["whole"]["full"])
            state = tidy.load()
            state["whole"]["last_full"] = time.time() - 121 * 86400
            state["whole"]["last_run"] = 0
            tidy.store(state)
            self.assertIn("reflect all --auto", sc.prompt("Four months later."))
            self.finish(sc, mode="auto")
            self.assertTrue(tidy.load()["whole"]["full"])
        self.each(body)

    def test_it_works_in_a_project_chat_and_other_projects_are_only_counted(self):
        def body(sc):
            self.pair(sc, "Beta Study sends its newsletter on Fridays after lunch.", scope="workspace:beta")
            self.pair(sc, "Alpha Study keeps twelve verified records in its ledger.", scope="workspace:alpha")
            self.pair(sc, self.DUP)
            beta = str(sc.root / "workspaces/beta")
            sc.prompt("What next?", cwd=beta)
            turn, tidy = sc.turn(), sc.bridge.tidy()
            plan = tidy.plan(sc.session, turn["id"], turn["token"], whole="recent")
            self.assertEqual(plan["in_other_projects"], 1)
            self.assertNotIn("alpha", json.dumps(plan).lower())
            self.assertEqual(sorted(i["project"] for i in plan["items"]), ["beta", "operator"])
            applied = tidy.apply(sc.session, turn["id"], turn["token"])
            self.assertEqual(len(applied["applied"]), 3)  # the other project's repeat was removed too
            tidy.done(sc.session, turn["id"], turn["token"])
            tidy.claim_seconds = -1
            shown = sc.prompt("What next for Beta?", cwd=beta)
            note = shown.split("Never place it in the middle of an answer:\n", 1)[1].split("\nBound scope:", 1)[0]
            self.assertIn("Beta Study", note)
            self.assertNotIn("Alpha", note)
            self.assertNotIn("twelve verified", note)
            self.assertRegex(note, r"\(1 more change in your other projects will be shown in a chat about them\.\)")
            tidy.acknowledge({"session_id": sc.session}, note)
            state = tidy.load()
            state["last_delivery_day"] = None  # the daily limit is not under test
            tidy.store(state)
            later = sc.prompt("What about Alpha?", cwd=str(sc.root / "workspaces/alpha"))
            later_note = later.split("Never place it in the middle of an answer:\n", 1)[1].split("\nBound scope:", 1)[0]
            self.assertIn("Alpha Study", later_note)
            self.assertNotIn("Beta Study", later_note)
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", later_note).group(1)
            tidy.acknowledge({"session_id": sc.session}, later_note)
            turn = sc.turn()
            self.assertEqual(tidy.undo(sc.session, turn["id"], turn["token"], note_id, 1)["state"], "undone")
        self.each(body)

    def test_a_project_chat_that_names_another_project_still_sees_only_its_own(self):
        def body(sc):
            self.pair(sc, "Beta Study sends its newsletter on Fridays after lunch.", scope="workspace:beta")
            self.pair(sc, "Alpha Study keeps twelve verified records in its ledger.", scope="workspace:alpha")
            beta, tidy = str(sc.root / "workspaces/beta"), sc.bridge.tidy()
            sc.prompt("Compare this with Alpha Study.", cwd=beta)
            self.assertEqual(sorted(sc.turn()["allowed"]), ["workspace:alpha", "workspace:beta"])
            turn = sc.turn()
            plan = tidy.plan(sc.session, turn["id"], turn["token"], whole="recent")
            self.assertEqual([i["project"] for i in plan["items"]], ["beta"])
            self.assertEqual(plan["in_other_projects"], 1)
            self.assertNotIn("alpha", json.dumps(plan).lower())
            tidy.apply(sc.session, turn["id"], turn["token"])
            tidy.done(sc.session, turn["id"], turn["token"])
            tidy.claim_seconds = -1
            note = sc.prompt("Compare this with Alpha Study.", cwd=beta)
            self.assertIn("Beta Study", note)
            self.assertNotIn("twelve verified", note)
            tidy.acknowledge({"session_id": sc.session}, note.split("Never place it in the middle of an answer:\n", 1)[1].split("\nBound scope:", 1)[0])
            state = tidy.load()
            state["last_delivery_day"] = None
            tidy.store(state)
            later = sc.prompt("Alpha again.", cwd=str(sc.root / "workspaces/alpha"))
            text = later.split("Never place it in the middle of an answer:\n", 1)[1].split("\nBound scope:", 1)[0]
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", text).group(1)
            tidy.acknowledge({"session_id": sc.session}, text)
            sc.prompt("Compare this with Alpha Study.", cwd=beta)
            turn = sc.turn()
            with self.assertRaises(Refused):
                tidy.undo(sc.session, turn["id"], turn["token"], note_id, 1)
        self.each(body)

    def edit(self, sc, key, **changes):
        """Change saved fields of the records containing key (to make records that look alike differ, or match)."""
        for path in sc.root.rglob("mem-*.md"):
            text = path.read_text()
            if key not in text:
                continue
            for name, value in changes.items():
                if name == "why":
                    text = text.rstrip("\n") + "\n\n# Why it matters\n\n" + value + "\n"
                else:
                    text = re.sub(rf"(?m)^{name}: .*$", f"{name}: {value}", text)
            path.write_text(text)

    def test_records_with_a_different_reason_or_weight_are_not_repeats(self):
        def body(sc):
            self.pair(sc, self.DUP)
            self.pair(sc, "The studio pays contractors within ten days of the invoice.")
            for path in sc.root.rglob("mem-*.md"):  # change only the spaced-out twin of each pair
                text = path.read_text()
                if "The  studio" not in text:
                    continue
                if self.KEY in text:
                    path.write_text(text.rstrip("\n") + "\n\n# Why it matters\n\nCash flow depends on it.\n")
                else:
                    path.write_text(re.sub(r"(?m)^importance: .*$", "importance: 5", text))
            self.assertEqual(self.changed(self.finish(sc, mode="full")), 0)
        self.each(body)

    def test_undo_restores_the_reason_weight_and_certainty(self):
        def body(sc):
            self.pair(sc, self.DUP)
            self.edit(sc, self.KEY, why="Cash flow depends on it.", importance="4", confidence="0.80")
            self.assertEqual(self.changed(self.finish(sc)), 1)
            note = sc.prompt("Thanks.").split("Never place it in the middle of an answer:\n", 1)[1].split("\nBound scope:", 1)[0]
            note_id = re.search(r"\(tidy note ([0-9A-F]{4})\)", note).group(1)
            sc.bridge.tidy().acknowledge({"session_id": sc.session}, note)
            sc.prompt("Undo it.")
            turn = sc.turn()
            self.assertEqual(sc.bridge.tidy().undo(sc.session, turn["id"], turn["token"], note_id, 1)["state"], "undone")
            restored = [t for t in self.files(sc).values() if "restored" in t and "status: active" in t]
            self.assertEqual(len(restored), 1)
            self.assertIn("importance: 4", restored[0])
            self.assertIn("confidence: 0.80", restored[0])
            self.assertIn("Cash flow depends on it.", restored[0])
        self.each(body)

    def test_a_tidy_may_run_after_the_learning_review_of_the_same_turn(self):
        def body(sc):
            self.pair(sc, self.DUP)
            sc.prompt("Please tidy up.")
            turn = sc.turn()
            sc.bridge.review(sc.session, turn["id"], turn["token"], sc.payload())
            self.assertEqual(sc.turn()["state"], "reviewed")
            result = sc.bridge.tidy().all(sc.session, turn["id"], turn["token"], "recent")
            self.assertEqual(result["changed"], 1)
            with self.assertRaises(Refused):  # no other owner operation opens up
                sc.bridge.owner("current_remove", {"scope": "operator", "parameters": {"effect_id": "x", "line_sha256": "0" * 64},
                                                   "auth": {"session": sc.session, "turn": turn["id"], "token": turn["token"]}})
        self.each(body)

    def test_possible_duplicate_goals_are_only_suggested_and_never_merged(self):
        def body(sc):
            goals = {"strategic_objects": {"intents": [
                {"payload": {"statement": "Grow the newsletter to ten thousand readers."}},
                {"payload": {"statement": "Grow the newsletter to 10 thousand readers"}},
                {"payload": {"statement": "Learn to paint with oil."}}]}}
            self.seed(sc, self.DUP, USER_REF)
            original = Bridge.owner

            def owner(bridge, operation, payload):  # the reader runs in this process so the goals can be faked
                return bridge_module.run_owner(bridge, operation, payload) if operation == "reflect_scan" else original(bridge, operation, payload)
            fake = type("S", (), {"snapshot": lambda self, scope: goals})()
            with patch.object(Bridge, "owner", owner), patch.object(Bridge, "intent_service", lambda bridge: fake):
                self.assertEqual(self.changed(self.finish(sc, mode="recent")), 0)  # a 7 day tidy does not look at goals
                self.finish(sc, mode="full")
            note = sc.prompt("Thanks.")
            self.assertIn("some of your goals may be the same goal", note)
            self.assertIn("Grow the newsletter", note)
            self.assertIn("I cannot join goals yet", note)
            self.assertNotIn("Learn to paint", note)
        self.each(body)
