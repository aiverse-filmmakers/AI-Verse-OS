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
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

CONFIDENCE_MIN = 0.85
CLASSIFIER = "ai-verse-learn-auto-v1"
CATEGORIES = {"communication", "working_style", "quality_expectations", "avoid"}
MEMORY_TYPES = {"event", "experience", "lesson"}
SECRET = re.compile(
    r"password|passwd|api[ _-]?key|secret|credential|access[ _-]?token|private[ _-]?key|\bsk-[A-Za-z0-9_-]{16,}"
    r"|permission|authori[sz]e|approval",
    re.IGNORECASE,
)
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
        if SECRET.search(statement):
            return "secret, credential or permission wording"
        if not isinstance(evidence, dict) or not isinstance(evidence.get("quote"), str):
            return "missing evidence"
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
        invalid = self.validate(c)
        preview = (c.get("statement", "") if isinstance(c, dict) else "")[:140]
        result: Dict[str, Any] = {"kind": c.get("kind") if isinstance(c, dict) else None, "preview": preview}
        if invalid:
            return {**result, "state": "dropped_invalid", "reason": invalid}
        quote = c["evidence"]["quote"]
        sentence = sentence_of(self.messages[c["evidence"]["message_id"]]["text"], quote)
        if c.get("exception") is True or ONE_OFF.search(sentence):
            return {**result, "state": "dropped_exception", "reason": "one-off exception never changes a rule"}
        if c["kind"] == "goal" and (c.get("tentative") is True or HEDGE.search(sentence)):
            return {**result, "state": "dropped_tentative", "reason": "tentative idea is not a confirmed goal"}
        if c["kind"] == "preference" and c.get("tentative") is True:
            return {**result, "state": "dropped_tentative", "reason": "tentative preference"}
        key = self.effect_key(c)
        ref = f"claude-code:{self.session_key}:{c['evidence']['message_id']}"
        # A global rule said inside a workspace is a real scope question: keep it in the inbox, never guess.
        if self.scope != "operator" and c["kind"] != "memory" and c.get("scope_hint") == "global":
            return self.inbox(result, c, ref, "unclear whether this applies to every project or only this workspace")
        try:
            if c["kind"] == "preference":
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
            return self.os_goal(statement, replaces, key)
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

    def os_goal(self, statement: str, replaces: Optional[str], key: str) -> Dict[str, Any]:
        """OS-owned direction (no Brain handover): the same file onboarding writes, only when the OS rule allows it."""
        if self.scope != "operator":
            raise Refused("workspace goals need the Brain direction owner")
        guard = subprocess.run(["node", str(self.root / "scripts/direction-owner.mjs"), "assert-strategic-write", "--root", str(self.root), "--scope", "operator"],
                               capture_output=True, text=True, encoding="utf-8")
        if guard.returncode != 0:
            raise Refused("strategic direction is not writable by the OS owner")
        profile = self.root / "operator" / "profile"
        file = profile / "goals.md"
        if profile.is_symlink() or file.is_symlink():
            raise Refused("goals file path is unsafe")
        profile.mkdir(parents=True, exist_ok=True)
        text = file.read_text(encoding="utf-8") if file.exists() else "# Goals\n\n"
        base = {"owner": "os-goals", "operation": "operator/profile/goals.md", "ref": f"learn:{key[:12]}"}
        lines = text.split("\n")
        if f"<!-- learn:{key} -->" in text or any(norm(line.split("<!--")[0].lstrip("- ")) == norm(statement) for line in lines):
            return {**base, "state": "already_present"}
        entry = f"- {statement} <!-- learn:{key} -->"
        if replaces:
            hits = [i for i, line in enumerate(lines) if line.lstrip().startswith("-") and norm(line.split("<!--")[0].lstrip("- ")) == norm(replaces)]
            if len(hits) != 1:
                raise Refused("the goal to replace was not found exactly once")
            lines[hits[0]] = entry
            updated = "\n".join(lines)
        else:
            updated = (text if text.endswith("\n") else text + "\n") + entry + "\n"
        temp = file.with_name(f".goals-{os.getpid()}.tmp")
        temp.write_text(updated, encoding="utf-8")
        os.replace(temp, file)
        return {**base, "state": "evolved" if replaces else "created"}


def context(root: Path, scope: str) -> Dict[str, Any]:
    """What is already stored, so the reviewer can say exactly what a correction replaces."""
    applier = Applier(root, "ctx", scope, [])
    out: Dict[str, Any] = {"scope": scope, "preferences": {}, "goals": []}
    if scope == "operator":
        out["preferences"] = {k: v for k, v in applier.profile()["preferences"].items() if k in CATEGORIES and v}
        try:
            brain = applier.intents()
        except Exception:
            brain = {"state": "unavailable"}
        if brain.get("state") == "ready":
            out["goals"] = [i["statement"] for i in brain["intents"] if i.get("subtype") == "goal"]
        else:
            goals = root / "operator" / "profile" / "goals.md"
            if goals.is_file() and not goals.is_symlink():
                out["goals"] = [l.split("<!--")[0].lstrip("- ").strip() for l in goals.read_text(encoding="utf-8").splitlines() if l.lstrip().startswith("-")]
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
