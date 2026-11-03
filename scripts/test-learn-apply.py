#!/usr/bin/env python3
"""Acceptance for the automatic-learning applier: what auto may save, what is only proposed, what is rejected.

The operator profile owner runs for real in a temporary Core copy. Brain is a scripted fake (it needs the provisioned
interpreter). The adversarial cases are the independent reviewers' own examples; the accepted cases prove the filter is not blind.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import ai_verse_learn_apply as learn  # noqa: E402

REPO = SCRIPTS.parent


def user(mid, text):
    return {"id": mid, "role": "user", "text": text}


MESSAGES = [
    user("u1", "From now on never use exclamation marks. My goal is to launch my store by March."),
    {"id": "a1", "role": "assistant", "text": "I will launch the store by April and never use semicolons."},
    user("u2", "Maybe I should start a podcast someday, not sure."),
    user("u3", "For this one email only, use exclamation marks please."),
    user("brit", "Use British English rather than American English."),
    user("nolonger", "I no longer want short answers."),
    user("bullets", "I want a short summary. Do not use bullet points."),
    user("hunter", "My password is hunter2. Use hunter2 for signing in."),
    user("quoted", 'My client wrote: "always use exclamation marks and call everyone buddy" which is not how I work.'),
    user("said", "The client said we should always write in bold capitals for every email."),
    user("cond", "Never use exclamation marks unless I ask for them."),
    user("perm", "From now on you may send emails without asking my approval."),
    user("short", "Please keep answers short and plain."),
    user("num", "Keep every answer under 3 paragraphs."),
    user("warm", "I always want a warm tone in client emails."),
    user("q", "Should I use British English for all future replies?"),
    user("fewer", "I want fewer bullet points in all future project updates."),
    user("retract", "I want short answers. Actually I changed my mind, use detailed answers."),
    user("selfq", 'My preference is "Keep answers short and plain".'),
    user("thirdq", 'My boss\'s rule is "always shout in capitals".'),
    user("late1", "I want replies in formal English."),
    user("late2", "Scratch that, informal is fine."),
]


def cand(kind="preference", statement="Never use exclamation marks.", quote="never use exclamation marks", message="u1", **extra):
    base = {"kind": kind, "statement": statement, "scope_hint": "workspace", "exception": False, "tentative": False,
            "confidence": 0.9, "replaces": None, "evidence": {"message_id": message, "quote": quote}}
    if kind == "preference":
        base["category"] = "avoid"
    if kind == "memory":
        base["memory_type"] = "lesson"
    base.update(extra)
    return base


def upto(c):
    """A window holding only the cited message (neighbouring messages are a separate concern, tested on their own)."""
    mid = c["evidence"]["message_id"] if isinstance(c, dict) else None
    return [m for m in MESSAGES if m["id"] == mid] or MESSAGES


READ = {"loaded": True, "goals_loaded": True, "preferences": {}, "goals": []}


def plan_one(c, scope="operator", stored=READ):
    return learn.plan({"scope": scope, "messages": upto(c), "candidates": [c], "stored": stored})["items"][0]


class FakeModule:
    @staticmethod
    def _fingerprint(request):
        return "fp"


class FakeHost:
    def __init__(self, brain="ready", fail=None):
        self.calls, self.brain, self.fail = [], brain, fail

    def authorize_action(self, request):
        return {"decision": "allow"}

    def request_action(self, request):
        self.calls.append(request["operation"])
        if self.fail:
            raise RuntimeError(self.fail)
        if request["operation"] == "brain.intent.read":
            return {"result": {"brain_intents": {"state": self.brain, "intents": []}}}
        if request["operation"] == "brain.intent.capture":
            return {"result": {"brain_intent": {"state": "saved", "changed": True, "status": "ACTIVE", "ref": "brain:intent:new"}}}
        raise AssertionError(request["operation"])


def make_core(tmp: Path) -> Path:
    root = tmp / "core"
    shutil.copytree(REPO / "scripts", root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(REPO / "AI-VERSE.yaml", root / "AI-VERSE.yaml")
    (root / "operator" / "profile").mkdir(parents=True)
    (root / "workspaces").mkdir()
    return root


def committed(c, mode="auto", scope="operator", host=None, root=None, **extra):
    item = plan_one(c, scope)
    base = root or Path(tempfile.mkdtemp())
    (base / ".aiverse" / "learn").mkdir(parents=True, exist_ok=True)
    (base / ".aiverse" / "learn" / "config.json").write_text(json.dumps({"mode": mode, "allow_unfenced_auto": True}))
    return learn.commit(base, {"item": item, "mode": mode, "scope": scope, "session_key": "k", **extra}, host=(FakeModule, host or FakeHost()))


class AutoIsNarrow(unittest.TestCase):
    """Auto: a NEW explicit preference or goal that one cited operator sentence carries near-verbatim. Everything else is held."""

    def disposition(self, c, scope="operator"):
        item = plan_one(c, scope)
        return item["disposition"], item.get("reason")

    def test_self_quoted_preferences_and_goals_are_accepted(self):
        self.assertEqual(self.disposition(cand()), ("auto", None))
        self.assertEqual(self.disposition(cand("goal", "Launch my store by March.", "launch my store by March")), ("auto", None))
        self.assertEqual(self.disposition(cand(statement="Keep answers short and plain.", quote="keep answers short and plain", message="short", category="communication")), ("auto", None))
        self.assertEqual(self.disposition(cand(statement="Keep every answer under 3 paragraphs.", quote="Keep every answer under 3 paragraphs", message="num", category="quality_expectations")), ("auto", None))
        self.assertEqual(self.disposition(cand(statement="I always want a warm tone in client emails.", quote="always want a warm tone in client emails", message="warm", category="communication")), ("auto", None))
        # the statement may drop filler words but must keep order and negations
        self.assertEqual(self.disposition(cand(statement="Never use exclamation marks.", quote="never use exclamation marks", message="u1")), ("auto", None))

    def test_british_american_swap_is_held(self):
        swapped = cand(statement="Use American English rather than British English.", quote="Use British English rather than American English", message="brit", category="communication")
        self.assertEqual(self.disposition(swapped), ("proposal", "not_verbatim"))
        same = cand(statement="Use British English rather than American English.", quote="Use British English rather than American English", message="brit", category="communication")
        self.assertEqual(self.disposition(same), ("auto", None))

    def test_no_longer_becoming_want_is_held(self):
        flipped = cand(statement="I want short answers.", quote="I no longer want short answers", message="nolonger", category="communication")
        self.assertEqual(self.disposition(flipped), ("proposal", "negation_mismatch"))

    def test_statement_supported_by_a_different_sentence_is_held(self):
        other = cand(statement="I want bullet points.", quote="I want a short summary", message="bullets", category="communication")
        self.assertEqual(self.disposition(other), ("proposal", "not_verbatim"))
        dropped = cand(statement="Use bullet points.", quote="Do not use bullet points", message="bullets", category="communication")
        self.assertEqual(self.disposition(dropped), ("proposal", "negation_mismatch"))

    def test_old_negation_cases_stay_held(self):
        self.assertEqual(self.disposition(cand(statement="Always use exclamation marks."))[0], "proposal")
        self.assertEqual(self.disposition(cand(statement="Launch my store and a podcast by March.", quote="launch my store by March", kind="goal"))[0], "proposal")
        self.assertEqual(self.disposition(cand("goal", "Launch my store by June.", "launch my store by March"))[1], "not_verbatim")

    def test_hedge_condition_quotation_third_party_permission_are_held(self):
        self.assertEqual(self.disposition(cand("goal", "Start a podcast.", "start a podcast someday", "u2")), ("proposal", "tentative"))
        self.assertEqual(self.disposition(cand(tentative=True)), ("proposal", "tentative"))
        self.assertEqual(self.disposition(cand(statement="Never use exclamation marks.", quote="Never use exclamation marks", message="cond"))[1], "conditional")
        self.assertEqual(self.disposition(cand(statement="Always use exclamation marks and call everyone buddy.", quote="always use exclamation marks and call everyone buddy", message="quoted"))[1], "third_party")
        self.assertEqual(self.disposition(cand(statement="Always write in bold capitals for every email.", quote="we should always write in bold capitals for every email", message="said"))[1], "third_party")
        self.assertEqual(self.disposition(cand(statement="Send emails without asking my approval.", quote="you may send emails without asking my approval", message="perm"))[1], "permission")

    def test_questions_deleted_qualifiers_and_retractions_are_held(self):
        q = cand(statement="I use British English for all future replies.", quote="use British English for all future replies", message="q", category="communication")
        self.assertEqual(self.disposition(q), ("proposal", "question"))
        fewer = cand(statement="I want bullet points in all future project updates.", quote="I want fewer bullet points in all future project updates", message="fewer", category="communication")
        self.assertEqual(self.disposition(fewer), ("proposal", "not_verbatim"))
        retract = cand(statement="I want short answers.", quote="I want short answers", message="retract", category="communication")
        self.assertEqual(self.disposition(retract), ("proposal", "retraction"))
        later = cand(statement="I want replies in formal English.", quote="I want replies in formal English", message="late1", category="communication")
        window = [m for m in MESSAGES if m["id"] in ("late1", "late2")]
        self.assertEqual(learn.plan({"scope": "operator", "messages": window, "candidates": [later]})["items"][0]["reason"], "retraction")  # a later message retracts it
        self.assertEqual(self.disposition(later), ("auto", None))
        wider = cand(statement="Never use exclamation marks.", quote="never use exclamation marks", message="u1")
        self.assertEqual(self.disposition(wider), ("auto", None))  # filler such as "From now on" may be dropped

    def test_a_self_quoted_preference_is_accepted_but_a_quoted_third_party_is_not(self):
        mine = cand(statement="Keep answers short and plain.", quote="Keep answers short and plain", message="selfq", category="communication")
        self.assertEqual(self.disposition(mine), ("auto", None))
        theirs = cand(statement="Always shout in capitals.", quote="always shout in capitals", message="thirdq", category="communication")
        self.assertEqual(self.disposition(theirs), ("proposal", "third_party"))

    def test_an_unmarked_contradiction_of_stored_state_is_not_a_new_save(self):
        request = {"scope": "operator", "messages": upto(cand()), "candidates": [cand()], "stored": {**READ, "preferences": {"avoid": ["Use exclamation marks sparingly."]}}}
        self.assertEqual(learn.plan(request)["items"][0]["reason"], "conflicts_stored")
        request["stored"] = {**READ, "preferences": {"avoid": ["Never use exclamation marks."]}}
        self.assertEqual(learn.plan(request)["items"][0]["disposition"], "auto")  # the identical text is just already present

    def test_novelty_fails_closed_on_the_reviewers_exact_probes(self):
        short = user("s1", "I want detailed answers.")
        detail = cand(statement="I want detailed answers.", quote="I want detailed answers", message="s1", category="communication")
        stored = {**READ, "preferences": {"communication": ["Keep replies short and plain."]}}
        out = learn.plan({"scope": "operator", "messages": [short], "candidates": [detail], "stored": stored})["items"][0]
        self.assertEqual((out["disposition"], out["reason"]), ("proposal", "conflicts_stored"))
        both = user("s2", "I want short answers. I prefer detailed answers.")
        first = cand(statement="I want short answers.", quote="I want short answers", message="s2", category="communication")
        out = learn.plan({"scope": "operator", "messages": [both], "candidates": [first], "stored": READ})["items"][0]
        self.assertEqual((out["disposition"], out["reason"]), ("proposal", "competing"))
        other_message = [user("s3", "I want short answers."), user("s4", "Later I prefer detailed answers.")]
        c3 = cand(statement="I want short answers.", quote="I want short answers", message="s3", category="communication")
        out = learn.plan({"scope": "operator", "messages": other_message, "candidates": [c3], "stored": READ})["items"][0]
        self.assertEqual(out["reason"], "competing")
        for unread in (None, {}, {"loaded": False, "preferences": {}, "goals": []}):  # stored state could not be read
            self.assertEqual(learn.plan({"scope": "operator", "messages": [short], "candidates": [detail], "stored": unread})["items"][0]["reason"], "stored_unavailable")
        goal = cand("goal", "Launch my store by March.", "launch my store by March")
        self.assertEqual(learn.plan({"scope": "operator", "messages": upto(goal), "candidates": [goal], "stored": {**READ, "goals_loaded": False}})["items"][0]["reason"], "stored_unavailable")
        stored_goal = {**READ, "goals": ["Launch my store by June."]}
        self.assertEqual(learn.plan({"scope": "operator", "messages": upto(goal), "candidates": [goal], "stored": stored_goal})["items"][0]["reason"], "conflicts_stored")

    def test_corrections_memories_workspace_unscoped_are_never_auto(self):
        self.assertEqual(self.disposition(cand(replaces="Always write long answers."))[1], "correction")
        self.assertEqual(self.disposition(cand("memory", "I learned never to use exclamation marks.", "never use exclamation marks"))[1], "memory")
        self.assertEqual(self.disposition(cand(), scope="workspace:alpha")[1], "workspace")
        self.assertEqual(self.disposition(cand(), scope="unscoped")[1], "unscoped")

    def test_quote_spanning_two_sentences_is_held(self):
        spanning = cand("goal", "Never use exclamation marks. My goal is to launch my store by March.", "marks. My goal is to launch my store")
        self.assertEqual(self.disposition(spanning)[1], "multi_sentence")

    def test_exception_is_rejected_not_proposed(self):
        out = plan_one(cand(statement="Use exclamation marks.", quote="use exclamation marks please", message="u3"))
        self.assertEqual((out["disposition"], out["reason"]), ("rejected", "one_off_exception"))
        self.assertEqual(plan_one(cand(exception=True))["reason"], "one_off_exception")


class RejectedContentIsNeverEchoed(unittest.TestCase):
    def test_whole_source_message_is_screened_for_contextual_secrets(self):
        # The reviewer's own example: the candidate sentence alone looks harmless.
        out = plan_one(cand(statement="Use hunter2 for signing in.", quote="Use hunter2 for signing in", message="hunter"))
        self.assertEqual((out["disposition"], out["reason"]), ("rejected", "secret_in_source"))
        self.assertEqual(set(out), {"kind", "disposition", "reason"})
        self.assertNotIn("hunter2", json.dumps(out))

    def test_other_secret_shapes_leave_no_content(self):
        cases = [
            cand(statement="Token sk-abcdefghijklmnopqrstuvwxyz0123456789 works."),
            cand(statement="Use card 4111 1111 1111 1111 always."),
            cand(statement="Key QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0xvbmc"),
            cand(replaces="My api key is abc"),
        ]
        for c in cases:
            out = plan_one(c)
            self.assertEqual(out["reason"], "secret_in_source", out)
            for leaked in ("sk-abc", "4111", "QWxhZ", "api key"):
                self.assertNotIn(leaked, json.dumps(out))

    def test_token_word_is_rejected_but_permission_word_only_holds(self):
        messages = [user("t1", "Keep token limits in mind, never use exclamation marks.")]
        out = learn.plan({"scope": "operator", "messages": messages, "candidates": [cand(message="t1")]})["items"][0]
        self.assertEqual(out["reason"], "secret_in_source")  # the word token alone is enough: held back rather than guessed
        messages = [user("t2", "Our approval workflow is slow, never use exclamation marks.")]
        out = learn.plan({"scope": "operator", "messages": messages, "candidates": [cand(message="t2")]})["items"][0]
        self.assertEqual(out["disposition"], "proposal")  # a permission word becomes a proposal, not a rejection

    def test_provenance_and_shape_rejections_are_fixed_codes(self):
        self.assertEqual(plan_one(cand("goal", "Launch by April.", "launch the store by April", "a1"))["reason"], "not_operator_message")
        self.assertEqual(plan_one(cand("goal", "Launch the store by March.", "launch the store by Friday"))["reason"], "quote_not_found")
        self.assertEqual(plan_one(cand(confidence=0.5))["reason"], "low_confidence")
        self.assertEqual(plan_one(cand(category="mood"))["reason"], "malformed")
        self.assertEqual(plan_one("not an object")["reason"], "malformed")
        self.assertTrue(learn.contains_words("De acum, răspunde-mi MEREU scurt!", "răspunde-mi mereu"))
        self.assertFalse(learn.contains_words("two words", "two words"))


class Commit(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_propose_mode_writes_nothing_and_keeps_quote_and_provenance(self):
        host = FakeHost()
        out = committed(cand(), mode="propose", host=host)
        self.assertEqual((out["state"], out["reason"]), ("proposed", "propose_mode"))
        self.assertEqual(host.calls, [])
        self.assertIn('You wrote: "never use exclamation marks"', out["inbox"]["summary"])
        self.assertEqual(out["inbox"]["refs"], ["claude-code:k:u1"])
        self.assertEqual(out["inbox"]["candidate_kind"], "claude-code-learning-proposal")

    def test_fence_stops_the_write_when_the_deadline_passed_the_parent_changed_or_the_switch_is_off(self):
        host = FakeHost()
        late = committed(cand(), host=host, deadline=1)
        self.assertEqual(host.calls, [])
        self.assertEqual((late["state"], late["reason"]), ("proposed", "fenced"))
        if os.name == "posix":
            orphan = committed(cand(), host=host, parent_pid=1 if os.getppid() != 1 else 2)
            self.assertEqual(orphan["reason"], "fenced")
            self.assertEqual(host.calls, [])
        host = FakeHost()
        root = Path(tempfile.mkdtemp())
        item = plan_one(cand())
        (root / ".aiverse" / "learn").mkdir(parents=True)
        (root / ".aiverse" / "learn" / "config.json").write_text(json.dumps({"mode": "off", "allow_unfenced_auto": True}))
        off = learn.commit(root, {"item": item, "mode": "auto", "scope": "operator", "session_key": "k"}, host=(FakeModule, host))
        self.assertEqual(off["reason"], "fenced")
        self.assertEqual(host.calls, [])

    def test_fence_is_rechecked_at_the_mutation_after_the_brain_read(self):
        class Slow(FakeHost):
            def request_action(self, request):
                if request["operation"] == "brain.intent.read":
                    self.on_read()
                return super().request_action(request)

        goal = cand("goal", "Launch my store by March.", "launch my store by March")
        # time advances past the deadline during the Brain read
        host = Slow()
        base = Path(tempfile.mkdtemp())
        real = learn.time.time
        clock = [real()]
        learn.time.time = lambda: clock[0]
        try:
            host.on_read = lambda: clock.__setitem__(0, clock[0] + 60)
            out = committed(goal, host=host, root=base, deadline=(clock[0] + 30) * 1000)
        finally:
            learn.time.time = real
        self.assertEqual((out["state"], out["reason"]), ("proposed", "fenced"))
        self.assertNotIn("brain.intent.capture", host.calls)
        # auto is switched off during the Brain read
        host = Slow()
        root = Path(tempfile.mkdtemp())
        host.on_read = lambda: (root / ".aiverse" / "learn" / "config.json").write_text(json.dumps({"mode": "off", "allow_unfenced_auto": True}))
        out = committed(goal, host=host, root=root)
        self.assertEqual(out["reason"], "fenced")
        self.assertNotIn("brain.intent.capture", host.calls)
        # the same for a preference write
        host = Slow()
        root = Path(tempfile.mkdtemp())
        host.on_read = lambda: None
        item = plan_one(cand())
        (root / ".aiverse" / "learn").mkdir(parents=True)
        (root / ".aiverse" / "learn" / "config.json").write_text(json.dumps({"mode": "auto", "allow_unfenced_auto": True}))
        owners = learn.Owners(root, "k", "operator", (FakeModule, host), fence=lambda: (_ for _ in ()).throw(learn.Refused("fenced")))
        with self.assertRaises(learn.Refused):
            owners.preference(item, "key", "ref")
        self.assertEqual(host.calls, [])

    def test_auto_is_blocked_by_default_because_the_owner_write_cannot_be_fenced(self):
        host = FakeHost()
        root = Path(tempfile.mkdtemp())
        (root / ".aiverse" / "learn").mkdir(parents=True)
        (root / ".aiverse" / "learn" / "config.json").write_text(json.dumps({"mode": "auto"}))
        out = learn.commit(root, {"item": plan_one(cand()), "mode": "auto", "scope": "operator", "session_key": "k"}, host=(FakeModule, host))
        self.assertEqual((out["state"], out["reason"]), ("proposed", "auto_blocked"))
        self.assertEqual(host.calls, [])

    def test_a_config_that_is_not_an_object_means_no_auto_and_no_crash(self):
        for raw in ("[]", "null", "123", '"auto"', "{", '{"mode": 5}', '{"mode": ["auto"], "allow_unfenced_auto": "yes"}'):
            host = FakeHost()
            root = Path(tempfile.mkdtemp())
            (root / ".aiverse" / "learn").mkdir(parents=True)
            (root / ".aiverse" / "learn" / "config.json").write_text(raw)
            out = learn.commit(root, {"item": plan_one(cand()), "mode": "auto", "scope": "operator", "session_key": "k"}, host=(FakeModule, host))
            self.assertEqual(out["state"], "proposed", raw)
            self.assertEqual(host.calls, [], raw)
            self.assertFalse(learn.mode_still_auto(root), raw)

    def test_auto_goal_goes_through_brain_only_when_ready(self):
        self.assertEqual(committed(cand("goal", "Launch my store by March.", "launch my store by March"))["state"], "created")
        down = committed(cand("goal", "Launch my store by March.", "launch my store by March"), host=FakeHost(brain="owner-required"))
        self.assertEqual((down["state"], down["reason"]), ("proposed", "goal_owner_unavailable"))

    def test_owner_exception_text_is_not_kept(self):
        host = FakeHost(fail="boom: password hunter2 leaked in a traceback")
        out = committed(cand("goal", "Launch my store by March.", "launch my store by March"), host=host)
        self.assertEqual((out["state"], out["reason"]), ("proposed", "owner_unavailable"))
        self.assertNotIn("hunter2", json.dumps(out))

    def test_held_item_is_a_proposal_even_in_auto_mode(self):
        host = FakeHost()
        out = committed(cand(replaces="Always write long answers."), host=host)
        self.assertEqual((out["state"], out["reason"]), ("proposed", "correction"))
        self.assertIn("It would replace", out["inbox"]["summary"])
        self.assertEqual(host.calls, [])


class RealProfileOwner(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = make_core(self.tmp)

    def commit(self, c, mode="auto"):
        item = plan_one(c)
        (self.root / ".aiverse" / "learn").mkdir(parents=True, exist_ok=True)
        (self.root / ".aiverse" / "learn" / "config.json").write_text(json.dumps({"mode": mode, "allow_unfenced_auto": True}))
        return learn.commit(self.root, {"item": item, "mode": mode, "scope": "operator", "session_key": "k"})

    def test_auto_preference_written_through_the_owner_once(self):
        first = self.commit(cand())
        self.assertEqual((first["state"], first["owner"]), ("created", "operator-profile"))
        self.assertEqual(self.commit(cand())["state"], "already_present")
        text = (self.root / "operator/profile/preferences.md").read_text()
        self.assertEqual(text.count("Never use exclamation marks."), 1)
        self.assertEqual(learn.context(self.root, "operator")["preferences"], {"avoid": ["Never use exclamation marks."]})

    def test_propose_mode_leaves_the_profile_untouched(self):
        self.assertEqual(self.commit(cand(), mode="propose")["state"], "proposed")
        self.assertFalse((self.root / "operator/profile/preferences.md").exists() and "exclamation" in (self.root / "operator/profile/preferences.md").read_text())

    def test_command_line_shape(self):
        import subprocess
        request = {"scope": "operator", "messages": upto(cand()), "candidates": [cand()], "stored": READ}
        run = subprocess.run([sys.executable, str(SCRIPTS / "ai_verse_learn_apply.py"), "--root", str(self.root), "plan"], input=json.dumps(request), capture_output=True, text=True)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(json.loads(run.stdout)["items"][0]["disposition"], "auto")
        bad = subprocess.run([sys.executable, str(SCRIPTS / "ai_verse_learn_apply.py"), "--root", str(self.root), "plan"], input="{", capture_output=True, text=True)
        self.assertEqual((bad.returncode, bad.stderr.strip()), (1, "ai-verse-learn-apply plan failed"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
