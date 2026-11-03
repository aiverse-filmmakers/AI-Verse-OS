#!/usr/bin/env python3
"""Deterministic applier for automatic learning.

The reviewer's JSON is untrusted data. This script verifies every candidate against the
operator messages of the reviewed window and writes only through the existing owner routes
of the host adapter (operator profile, Memory, Brain intents). It never writes a second
store. Candidates that cannot be saved safely come back with an `inbox` request so the
worker can keep them in the OS inbox instead of losing them.

Usage: ai_verse_learn_apply.py --root <os-root> context|apply   (JSON on stdin, JSON on stdout)
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

CONFIDENCE_MIN = 0.85
CLASSIFIER = "ai-verse-learn-auto-v1"
CATEGORIES = {"communication", "working_style", "quality_expectations", "avoid"}
MEMORY_TYPES = {"event", "experience", "lesson"}
SECRET = re.compile(
    r"pass(?:word|wd|phrase|code)|\bpin\b|secret|credential|api[ _-]?key|(?:access|refresh|auth|bearer|session)[ _-]?token|\btoken\b|private[ _-]?key"
    r"|recovery[ _-]?code|\b(?:ssn|iban|cvv|passport)\b|social security|credit[ _-]?card|\bsk-[A-Za-z0-9_-]{12,}"
    r"|\b[A-Za-z0-9+/_-]{28,}\b|\b(?:\d[ -]?){13,19}\b|permission|authori[sz]e|approval",
    re.IGNORECASE,
)
NEGATORS = {"never", "not", "no", "dont", "don", "doesn", "didn", "won", "cannot", "cant", "without", "avoid", "stop", "nu", "niciodata", "fara", "nicio"}
STOPWORDS = set("a an the and or of to in on for with my me i you your is are be it this that as at by from so do does am we our if but also please always from now on can will just".split())
ATTRIBUTION = re.compile(r"\b(said|says|wrote|writes|replied|asked|told me|according to|email from|message from|quote[sd]?|client wants|boss wants|he wants|she wants|they want)\b", re.IGNORECASE)
NO_LONGER = re.compile(r"\b(?:no longer|not anymore|nu mai)\b", re.IGNORECASE)
SUPPORT_NEW, SUPPORT_CORRECTION = 0.8, 0.9


# The reviewer may be wrong about tone. A hedged goal is never confirmed, and a one-off is never a rule.
HEDGE = re.compile(
    r"\b(maybe|perhaps|might|someday|some day|one day|not sure|thinking (?:about|of)|considering|what if|poate|cândva|candva)\b",
    re.IGNORECASE,
)
ONE_OFF = re.compile(
    r"\b(just|only) (?:for )?(?:this|today)|\bthis (?:one )?(?:time|once|email|message)\b|\bone[- ]off\b|\bdoar (?:de data asta|acum|pentru acesta)\b",
    re.IGNORECASE,
)


class Refused(Exception):
    pass


def words(text: str) -> List[str]:
    return re.findall(r"\w+", unicodedata.normalize("NFKC", text).casefold())


def norm(text: str) -> str:
    return " ".join(words(text))


def contains_words(haystack: str, needle: str) -> bool:
    h, n = words(haystack), words(needle)
    return len(n) >= 3 and any(h[i : i + len(n)] == n for i in range(len(h) - len(n) + 1))


def sentence_of(text: str, quote: str) -> str:
    """The sentence of an operator message that holds the quote, so a nearby 'just this time' counts as context."""
    return next((s for s in re.split(r"(?<=[.!?])\s+|\n+", text) if contains_words(s, quote)), quote)


def stems(text: str) -> set:
    return {w if w.isdigit() else w[:5] for w in words(text) if w.isdigit() or (w not in STOPWORDS and len(w) > 2)}


def negated(text: str) -> bool:
    return any(w in NEGATORS for w in words(NO_LONGER.sub(" ", text)))


def inside_quotation(text: str, quote: str) -> bool:
    spans = re.findall(r"[\"\u201c\u201e\u00ab]([^\"\u201d\u00bb]{3,})[\"\u201d\u00bb]", text)
    return any(contains_words(span, quote) for span in spans)


def unsupported(statement: str, replaces: Optional[str], text: str, sentence: str, quote: str) -> Optional[str]:
    """Hold a candidate whose statement the operator's own words do not clearly carry. Quote provenance alone is not enough."""
    before = sentence[: max(sentence.casefold().find(quote.casefold()[:12]), 0)]
    if inside_quotation(text, quote) or ATTRIBUTION.search(before):
        return "the evidence looks like quoted or third-party text, not the operator's own instruction"
    if negated(statement) != negated(sentence):
        return "the statement reverses or drops a negation found in the evidence"
    wanted = stems(statement)
    have = stems(text) | (stems(replaces) if replaces else set())
    if wanted and len(wanted & have) / len(wanted) < (SUPPORT_CORRECTION if replaces else SUPPORT_NEW):
        return "the statement contains details the operator did not say"
    if any(w.isdigit() and w not in stems(text) for w in wanted):
        return "the statement contains a number the operator did not say"
    return None


def load_host(root: Path):
    path = root / "scripts" / "ai_verse_host_adapter.py"
    spec = importlib.util.spec_from_file_location("_aiverse_learn_host", path)
    if spec is None or spec.loader is None:
        raise Refused("host adapter is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules["_aiverse_learn_host"] = module
    spec.loader.exec_module(module)
    return module, module.AIverseOSHost(root)


class Applier:
    def __init__(self, root: Path, session_key: str, scope: str, messages: List[Dict[str, Any]], host=None) -> None:
        self.root, self.session_key, self.scope = root, session_key, scope
        self.messages = {m["id"]: m for m in messages}
        self.module, self.host = host or load_host(root)
        self._profile: Optional[Dict[str, Any]] = None

    def action(self, operation: str, parameters: Dict[str, Any], key: str, write: bool = True, scope: Optional[str] = None):
        request = {
            "action_class": "write_local_reversible" if write else "read_local",
            "scope": scope or self.scope,
            "operation": operation,
            "parameters": parameters,
            "idempotency_key": key,
            "in_scope": True,
            "within_budget": True,
            "reversible": True,
            "reason": "Automatic learning routes a statement the operator made to its existing owner.",
        }
        request["request_fingerprint"] = self.module._fingerprint(request)
        if write and self.host.authorize_action(request).get("decision") != "allow":
            raise Refused("OS action permission refused the owner write")
        return self.host.request_action(request)

    def profile(self, fresh: bool = False) -> Dict[str, Any]:
        if self._profile is None or fresh:
            self._profile = self.action("operator.profile.read", {}, "learn-read", write=False)["result"]["operator_profile"]
        return self._profile

    def intents(self) -> Dict[str, Any]:
        return self.action("brain.intent.read", {}, "learn-read", write=False)["result"]["brain_intents"]

    # -- validation -------------------------------------------------------------------------------------------
    def validate(self, c: Any) -> Optional[str]:
        if not isinstance(c, dict) or c.get("kind") not in {"preference", "goal", "memory"}:
            return "malformed candidate"
        statement, evidence = c.get("statement"), c.get("evidence")
        if not isinstance(statement, str) or not 3 <= len(statement.strip()) <= 500:
            return "statement size"
        if isinstance(c.get("confidence"), bool) or not isinstance(c.get("confidence"), (int, float)) or c["confidence"] < CONFIDENCE_MIN:
            return "confidence below threshold"
        if not isinstance(evidence, dict) or not isinstance(evidence.get("quote"), str):
            return "missing evidence"
        replaces = c.get("replaces")
        if replaces is not None and not isinstance(replaces, str):
            return "malformed candidate"
        if SECRET.search(" ".join([statement, evidence["quote"], replaces or ""])):
            return "secret, credential or permission wording"
        message = self.messages.get(evidence.get("message_id"))
        if not message or message.get("role") != "user":
            return "evidence is not an operator message"
        if not contains_words(message["text"], evidence["quote"]):
            return "quote not found in the operator message"
        if c["kind"] == "preference" and c.get("category") not in CATEGORIES:
            return "unsupported preference category"
        if c["kind"] == "memory" and c.get("memory_type") not in MEMORY_TYPES:
            return "unsupported memory type"
        return None

    def effect_key(self, c: Dict[str, Any]) -> str:
        raw = f"{self.session_key}|{c['evidence']['message_id']}|{c['kind']}|{norm(c['statement'])}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]

    # -- routing ----------------------------------------------------------------------------------------------
    def handle(self, c: Any) -> Dict[str, Any]:
        # Rejected content is never echoed: an invalid or dropped candidate leaves only its kind and the reason.
        result: Dict[str, Any] = {"kind": c.get("kind") if isinstance(c, dict) and isinstance(c.get("kind"), str) else None}
        invalid = self.validate(c)
        if invalid:
            return {**result, "state": "dropped_invalid", "reason": invalid}
        quote = c["evidence"]["quote"]
        text = self.messages[c["evidence"]["message_id"]]["text"]
        sentence = sentence_of(text, quote)
        if c.get("exception") is True or ONE_OFF.search(sentence):
            return {**result, "state": "dropped_exception", "reason": "one-off exception never changes a rule"}
        if c["kind"] == "goal" and (c.get("tentative") is True or HEDGE.search(sentence)):
            return {**result, "state": "dropped_tentative", "reason": "tentative idea is not a confirmed goal"}
        if c["kind"] == "preference" and c.get("tentative") is True:
            return {**result, "state": "dropped_tentative", "reason": "tentative preference"}
        result["preview"] = c["statement"].strip()[:140]
        key = self.effect_key(c)
        ref = f"claude-code:{self.session_key}:{c['evidence']['message_id']}"
        held = unsupported(c["statement"], c.get("replaces"), text, sentence, quote)
        if held:
            return self.inbox(result, c, ref, held)
        # A global rule said inside a workspace is a real scope question: keep it in the inbox, never guess.
        if self.scope != "operator" and c["kind"] != "memory" and c.get("scope_hint") == "global":
            return self.inbox(result, c, ref, "unclear whether this applies to every project or only this workspace")
        try:
            if c["kind"] == "preference":
                if self.scope != "operator" and c.get("replaces"):
                    raise Refused("corrections inside a workspace are not applied automatically")
                return {**result, **(self.preference(c, key, ref) if self.scope == "operator" else self.workspace_memory(c, key, ref, "preference"))}
            if c["kind"] == "goal":
                return {**result, **self.goal(c, key, ref)}
            return {**result, **self.workspace_memory(c, key, ref, c["memory_type"])}
        except Refused as error:
            return self.inbox(result, c, ref, str(error))
        except Exception as error:  # owner unavailable: keep the statement, never report it as saved
            return self.inbox(result, c, ref, f"owner unavailable: {str(error)[:200]}")

    def inbox(self, result: Dict[str, Any], c: Dict[str, Any], ref: str, reason: str) -> Dict[str, Any]:
        summary = f"Not saved automatically ({reason}). {c['kind']}: {c['statement'].strip()}"
        return {**result, "state": "pending_inbox", "reason": reason,
                "inbox": {"candidate_kind": "claude-code-learning-pending", "summary": summary[:1500], "refs": [ref]}}

    def preference(self, c: Dict[str, Any], key: str, ref: str) -> Dict[str, Any]:
        evidence = {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False, "contains_sensitive": False,
                    "contains_secret": False, "reason": "The operator stated this working preference in their own message."}
        provenance = {"trigger_ref": ref, "classifier": CLASSIFIER, "source": "claude-code:user"}
        category, statement, replaces = c["category"], c["statement"].strip(), c.get("replaces")
        if not replaces:
            out = self.action("operator.profile.ensure", {"preferences": {category: [statement]}, "evidence": evidence, "provenance": provenance}, key)
            return self.profile_result(out, "operator.profile.ensure")
        for attempt in range(2):
            profile = self.profile(fresh=attempt > 0)
            previous = next((p for p in profile["preferences"].get(category, []) if norm(p) == norm(replaces)), None)
            if previous is None:
                raise Refused("the preference to replace was not found in the profile")
            out = self.action("operator.profile.correct", {
                "category": category, "previous": previous, "replacement": statement,
                "expected_sha256": profile["preferences_source_sha256"], "evidence": evidence, "provenance": provenance}, key)
            if out["result"]["operator_profile"].get("state") != "stale":
                return self.profile_result(out, "operator.profile.correct")
        raise Refused("the profile changed while correcting it")

    def profile_result(self, out: Dict[str, Any], operation: str) -> Dict[str, Any]:
        state = out["result"]["operator_profile"].get("state")
        base = {"owner": "operator-profile", "operation": operation}
        mapped = {"created": "created", "evolved": "evolved", "existing": "already_present"}.get(state)
        if mapped:
            return {**base, "state": mapped, "ref": "operator/profile/preferences.md"}
        if state in {"needs-clarification", "stale"}:
            raise Refused(f"profile owner asked for clarification ({state})")
        return {**base, "state": "refused", "reason": f"profile owner state {state}"}

    def workspace_memory(self, c: Dict[str, Any], key: str, ref: str, memory_type: str) -> Dict[str, Any]:
        admission = {"durable": True, "historical": True, "current_truth": False, "contains_secret": False, "strategic": False,
                     "permission_expansion": False, "privacy_ambiguous": False, "external_authority": False}
        out = self.action("memory.capture", {
            "text": c["statement"].strip(), "type": memory_type, "confidence": float(c["confidence"]),
            "source": "claude-code:completed-conversation", "evidence_refs": [ref], "effect_id": key, "admission": admission}, key)
        capture = out["result"]["memory_capture"]
        state = capture.get("state")
        base = {"owner": "memory", "operation": "memory.capture", "ref": capture.get("memory_id")}
        if state == "captured":
            return {**base, "state": "created"}
        if state == "existing":
            return {**base, "state": "already_present"}
        return {**base, "state": "refused", "reason": capture.get("reason", f"memory state {state}")}

    def goal(self, c: Dict[str, Any], key: str, ref: str) -> Dict[str, Any]:
        statement, replaces = c["statement"].strip(), c.get("replaces")
        brain = self.intents()
        if brain.get("state") != "ready":
            # No Brain direction owner (a fresh Core): there is no revision-checked owner route for OS-owned goals yet.
            raise Refused("goals are kept for review until the Brain direction owner is active")
        params = {"subtype": "goal", "statement": statement, "operation_id": key, "evidence_ref": ref, "source": "explicit_user"}
        if replaces:
            prior = next((i for i in brain["intents"] if norm(i.get("statement", "")) == norm(replaces)), None)
            if prior is None:
                raise Refused("the goal to replace was not found")
            params.update({"supersedes": prior["id"], "expected_revision": prior["revision"]})
        out = self.action("brain.intent.capture", params, key)
        intent = out["result"]["brain_intent"]
        base = {"owner": "brain", "operation": "brain.intent.capture", "ref": intent.get("ref")}
        if intent.get("state") == "unchanged":
            return {**base, "state": "already_present"}
        if intent.get("changed") and intent.get("status") in {"CONFIRMED", "ACTIVE"}:
            return {**base, "state": "evolved" if replaces else "created"}
        raise Refused(f"Brain did not confirm the goal ({intent.get('state')})")


def context(root: Path, scope: str) -> Dict[str, Any]:
    """What is already stored, so the reviewer can say exactly what a correction replaces.
    Preferences exist only in the operator profile; workspace preference corrections are not applied automatically."""
    applier = Applier(root, "ctx", scope, [])
    out: Dict[str, Any] = {"scope": scope, "preferences": {}, "goals": []}
    if scope == "operator":
        out["preferences"] = {k: v for k, v in applier.profile()["preferences"].items() if k in CATEGORIES and v}
    try:
        brain = applier.intents()
    except Exception:
        return out
    if brain.get("state") == "ready":
        out["goals"] = [i["statement"] for i in brain["intents"] if i.get("subtype") == "goal"]
    return out


def apply(root: Path, request: Dict[str, Any]) -> Dict[str, Any]:
    applier = Applier(root, request["session_key"], request["scope"], request["messages"])
    candidates = request.get("candidates")
    if not isinstance(candidates, list):
        raise Refused("review result has no candidate list")
    return {"results": [applier.handle(c) for c in candidates[:6]]}


def main() -> int:
    parser = argparse.ArgumentParser(prog="ai-verse-learn-apply")
    parser.add_argument("--root", required=True)
    parser.add_argument("command", choices=["context", "apply"])
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()
    try:
        request = json.loads(sys.stdin.read())
        output = context(root, request["scope"]) if args.command == "context" else apply(root, request)
    except Exception as error:
        print(f"ai-verse-learn-apply {args.command}: {error}", file=sys.stderr)
        return 1
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
