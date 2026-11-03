#!/usr/bin/env python3
"""Acceptance for the automatic-learning applier: quote verification, scope, owners, and safe refusals.

The operator profile owner runs for real in a temporary Core copy. Brain and Memory are scripted fakes
because they need the provisioned interpreter; their contracts are exercised in the host adapter tests.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import ai_verse_learn_apply as learn  # noqa: E402

REPO = SCRIPTS.parent
MESSAGES = [
    {"id": "u1", "role": "user", "text": "From now on never use exclamation marks. My goal is to launch my store by March."},
    {"id": "a1", "role": "assistant", "text": "I will launch the store by April and never use semicolons."},
    {"id": "u2", "role": "user", "text": "Maybe I should start a podcast someday, not sure."},
    {"id": "u3", "role": "user", "text": "For this one email only, use exclamation marks please."},
]


def candidate(kind="preference", statement="Never use exclamation marks.", quote="never use exclamation marks", message="u1", **extra):
    base = {"kind": kind, "statement": statement, "scope_hint": "workspace", "exception": False, "tentative": False,
            "confidence": 0.9, "replaces": None, "evidence": {"message_id": message, "quote": quote}}
    if kind == "preference":
        base["category"] = "avoid"
    if kind == "memory":
        base["memory_type"] = "lesson"
    base.update(extra)
    return base


class FakeModule:
    @staticmethod
    def _fingerprint(request):
        return "fp"


class FakeHost:
    """Scripted owners: records every request and answers per operation."""

    def __init__(self, brain="ready", intents=None):
        self.calls, self.brain, self.intents = [], brain, intents or []

    def authorize_action(self, request):
        return {"decision": "allow"}

    def request_action(self, request):
        self.calls.append((request["operation"], request["parameters"]))
        op = request["operation"]
        if op == "brain.intent.read":
            if self.brain == "down":
                raise RuntimeError("AI-Verse Brain is unavailable")
            return {"result": {"brain_intents": {"state": self.brain, "owner": "brain" if self.brain == "ready" else "os", "intents": self.intents}}}
        if op == "brain.intent.capture":
            return {"result": {"brain_intent": {"state": "saved", "changed": True, "status": "ACTIVE", "ref": "brain:intent:new"}}}
        if op == "memory.capture":
            return {"result": {"memory_capture": {"state": "captured", "memory_id": "mem-1"}}}
        raise AssertionError(f"unexpected owner operation {op}")


def make_core(tmp: Path) -> Path:
    root = tmp / "core"
    shutil.copytree(REPO / "scripts", root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy(REPO / "AI-VERSE.yaml", root / "AI-VERSE.yaml")
    (root / "operator" / "profile").mkdir(parents=True)
    (root / "workspaces").mkdir()
    return root


def applier(root, scope="operator", host=None):
    return learn.Applier(root, "sess1", scope, MESSAGES, host=(FakeModule, host) if host else None)


class QuoteAndGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.host = FakeHost()
        self.applier = applier(self.tmp, host=self.host)

    def state(self, c):
        return self.applier.handle(c)["state"]

    def test_quote_must_be_in_a_user_message(self):
        assistant = candidate("goal", "Launch by April.", "launch the store by April", "a1")
        self.assertEqual(self.applier.handle(assistant)["reason"], "evidence is not an operator message")
        invented = candidate("goal", "Launch the store by March.", "launch the store by Friday")
        self.assertEqual(self.applier.handle(invented)["reason"], "quote not found in the operator message")
        self.assertEqual(self.host.calls, [])

    def test_quote_matching_ignores_case_punctuation_and_diacritics_rules(self):
        self.assertTrue(learn.contains_words("De acum, răspunde-mi MEREU scurt!", "răspunde-mi mereu"))
        self.assertFalse(learn.contains_words("two words", "two words"))  # fewer than three words is never evidence

    def test_confidence_secret_and_shape_are_rejected(self):
        self.assertEqual(self.state(candidate(confidence=0.5)), "dropped_invalid")
        self.assertEqual(self.state(candidate(statement="My password is hunter2abc.")), "dropped_invalid")
        self.assertEqual(self.state(candidate(category="mood")), "dropped_invalid")
        self.assertEqual(self.state("not an object"), "dropped_invalid")

    def test_tentative_idea_is_never_a_goal_even_when_the_reviewer_misses_it(self):
        podcast = candidate("goal", "Start a podcast.", "start a podcast someday", "u2")
        self.assertEqual(self.state(podcast), "dropped_tentative")
        flagged = candidate("goal", "Launch my store by March.", "launch my store by March", tentative=True)
        self.assertEqual(self.state(flagged), "dropped_tentative")
        self.assertEqual(self.host.calls, [])

    def test_one_off_exception_never_touches_a_rule(self):
        exception = candidate("preference", "Use exclamation marks.", "For this one email only, use exclamation marks", "u3")
        self.assertEqual(self.state(exception), "dropped_exception")
        self.assertEqual(self.state(candidate(exception=True)), "dropped_exception")
        self.assertEqual(self.host.calls, [])

    def test_global_rule_inside_a_workspace_is_asked_not_guessed(self):
        scoped = applier(self.tmp, "workspace:alpha", self.host)
        out = scoped.handle(candidate(scope_hint="global"))
        self.assertEqual(out["state"], "pending_inbox")
        self.assertIn("every project", out["reason"])


class Routing(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_explicit_goal_uses_brain_with_explicit_user_source(self):
        host = FakeHost()
        out = applier(self.tmp, host=host).handle(candidate("goal", "Launch my store by March.", "launch my store by March"))
        self.assertEqual((out["state"], out["owner"]), ("created", "brain"))
        _, params = host.calls[-1]
        self.assertEqual(params["source"], "explicit_user")
        self.assertEqual(params["subtype"], "goal")
        self.assertTrue(params["evidence_ref"].startswith("claude-code:sess1:u1"))

    def test_goal_correction_supersedes_the_exact_intent_with_its_revision(self):
        host = FakeHost(intents=[{"id": "i1", "subtype": "goal", "statement": "Launch my store by March.", "revision": 3}])
        out = applier(self.tmp, host=host).handle(
            candidate("goal", "Launch my store by June.", "launch my store by March", replaces="launch my store by march"))
        self.assertEqual(out["state"], "evolved")
        _, params = host.calls[-1]
        self.assertEqual((params["supersedes"], params["expected_revision"]), ("i1", 3))
        missing = applier(self.tmp, host=FakeHost()).handle(candidate("goal", "Launch by June.", "launch my store by March", replaces="Something else"))
        self.assertEqual(missing["state"], "pending_inbox")

    def test_os_owned_direction_writes_goals_file_once_and_corrects_in_place(self):
        root = make_core(self.tmp)
        host = FakeHost(brain="owner-required")
        a = applier(root, host=host)
        goal = candidate("goal", "Launch my store by March.", "launch my store by March")
        self.assertEqual(a.handle(goal)["state"], "created")
        self.assertEqual(a.handle(goal)["state"], "already_present")
        fixed = candidate("goal", "Launch my store by June.", "launch my store by March", replaces="Launch my store by March.")
        self.assertEqual(a.handle(fixed)["state"], "evolved")
        text = (root / "operator" / "profile" / "goals.md").read_text(encoding="utf-8")
        self.assertIn("by June", text)
        self.assertNotIn("by March", text)
        self.assertEqual(learn.context(root, "operator")["goals"], ["Launch my store by June."])

    def test_unavailable_brain_keeps_the_goal_in_the_inbox(self):
        out = applier(self.tmp, host=FakeHost(brain="down")).handle(candidate("goal", "Launch my store by March.", "launch my store by March"))
        self.assertEqual(out["state"], "pending_inbox")
        self.assertIn("claude-code:sess1:u1", out["inbox"]["refs"][0])
        self.assertNotIn("owner", out)

    def test_workspace_preference_is_memory_not_profile(self):
        host = FakeHost()
        out = applier(self.tmp, "workspace:alpha", host).handle(candidate(scope_hint="workspace"))
        self.assertEqual((out["state"], out["owner"]), ("created", "memory"))
        op, params = host.calls[-1]
        self.assertEqual((op, params["type"]), ("memory.capture", "preference"))
        self.assertFalse(params["admission"]["current_truth"])

    def test_effect_key_is_stable_for_replays(self):
        a = applier(self.tmp, host=FakeHost())
        self.assertEqual(a.effect_key(candidate()), a.effect_key(candidate(statement="never  use EXCLAMATION marks.")))


class RealProfileOwner(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = make_core(self.tmp)

    def make(self):
        return learn.Applier(self.root, "sess1", "operator", MESSAGES)

    def test_ensure_then_replay_then_revision_checked_correction(self):
        first = self.make().handle(candidate())
        self.assertEqual((first["state"], first["owner"]), ("created", "operator-profile"))
        self.assertEqual(self.make().handle(candidate())["state"], "already_present")
        fixed = candidate(statement="Avoid exclamation marks except in greetings.", quote="never use exclamation marks", replaces="Never use exclamation marks.")
        self.assertEqual(self.make().handle(fixed)["state"], "evolved")
        preferences = self.make().profile()["preferences"]["avoid"]
        self.assertEqual(preferences, ["Avoid exclamation marks except in greetings."])
        self.assertEqual(learn.context(self.root, "operator")["preferences"], {"avoid": preferences})

    def test_correction_of_something_not_stored_is_asked_not_appended(self):
        out = self.make().handle(candidate(replaces="Always write long answers."))
        self.assertEqual(out["state"], "pending_inbox")
        self.assertEqual(self.make().profile()["preferences"]["avoid"], [])

    def test_exception_leaves_the_stored_rule_alone(self):
        self.make().handle(candidate())
        exception = candidate(statement="Use exclamation marks.", quote="use exclamation marks please", message="u3")
        self.assertEqual(self.make().handle(exception)["state"], "dropped_exception")
        self.assertEqual(self.make().profile()["preferences"]["avoid"], ["Never use exclamation marks."])


class Command(unittest.TestCase):
    def test_apply_command_shape(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        root = make_core(tmp)
        out = learn.apply(root, {"session_key": "k", "scope": "operator", "messages": MESSAGES, "candidates": [candidate()]})
        self.assertEqual(out["results"][0]["state"], "created")
        with self.assertRaises(learn.Refused):
            learn.apply(root, {"session_key": "k", "scope": "operator", "messages": MESSAGES, "candidates": "bad"})
        json.dumps(out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
