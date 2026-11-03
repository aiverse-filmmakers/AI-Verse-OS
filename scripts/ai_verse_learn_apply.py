#!/usr/bin/env python3
"""Deterministic screening and routing for automatic learning.

The reviewer's JSON is untrusted data. Three commands, JSON on stdin and stdout:

  context  what is already stored for the scope (so the reviewer can name what a correction replaces)
  plan     screen every candidate against the operator's own messages. No writes. Each candidate becomes `rejected`
           (a fixed reason code, nothing else), `proposal` (to be kept in the OS inbox for the member to approve in plain
           words) or `auto` (the narrowest class that may be saved without asking).
  commit   carry out ONE planned item under the current mode: write an `auto` item through its existing owner, or build the
           inbox request for a proposal. Anything that fails, or any mode other than `auto`, becomes a proposal.

Auto means exactly this: operator scope, a NEW explicit preference or goal (no correction), one cited operator sentence that
the statement reproduces near-verbatim (same words in the same order, same negations in the same order, same numbers),
no hedge, condition, quotation, third-party attribution, permission wording or secret-like text anywhere in that message.
Everything else is a proposal. Raw exception text is never kept: reasons are fixed codes.
"""

from __future__ import annotations

import argparse
import os
import time
import hashlib
import importlib.util
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

CONFIDENCE_MIN = 0.85
CLASSIFIER = "ai-verse-learn-auto-v2"
CATEGORIES = {"communication", "working_style", "quality_expectations", "avoid"}
MEMORY_TYPES = {"event", "experience", "lesson"}

REASONS = {
    "propose_mode": "automatic saving is off, so everything is only proposed",
    "correction": "it changes something already stored",
    "memory": "it is a past event or lesson, which is never saved without asking",
    "workspace": "it came from a workspace conversation",
    "unscoped": "it is not clear which workspace or the operator profile it belongs to",
    "tentative": "it sounded tentative",
    "conditional": "the sentence carries a condition or exception",
    "third_party": "the sentence looks quoted or attributed to someone else",
    "permission": "it mentions permissions or approvals",
    "not_verbatim": "the statement is not close enough to what you wrote",
    "negation_mismatch": "the statement does not mirror the negation in what you wrote",
    "multi_sentence": "it is not supported by one single sentence of yours",
    "question": "what you wrote was a question, not an instruction",
    "retraction": "you seem to have changed your mind in the same message or a later one",
    "conflicts_stored": "something already stored is on the same topic and is not the same",
    "stored_unavailable": "what is already stored could not be read, so novelty cannot be checked",
    "competing": "another sentence in the same conversation window is about the same thing and says something different",
    "goal_owner_unavailable": "no goal owner is active yet",
    "fenced": "the worker no longer held the right to write",
    "owner_unavailable": "the owner that would save it was not available",
    "owner_refused": "the owner asked for clarification instead of saving",
}

# Whole-message screening: any of these anywhere in the cited operator message rejects the candidate.
SECRET = re.compile(
    r"pass(?:word|wd|phrase|code)|\bpwd\b|\bpin\b|secret|credential|api[ _-]?key|(?:access|refresh|auth|bearer|session)[ _-]?token"
    r"|\btoken\b|private[ _-]?key|recovery[ _-]?code|\b(?:ssn|iban|cvv|passport)\b|social security|credit[ _-]?card"
    r"|\bsk-[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9+/_-]{28,}\b|\b(?:\d[ -]?){13,19}\b",
    re.IGNORECASE,
)
PERMISSION = re.compile(r"permission|authori[sz]e|approv", re.IGNORECASE)
NEGATORS = {"never", "not", "no", "dont", "don", "doesn", "didn", "won", "cannot", "cant", "without", "avoid", "stop", "nolonger", "nu", "niciodata", "fara", "nicio"}
STOPWORDS = set("a an the and or of to in on for with my me i you your is are be it this that as at by from so do does am we our if but also please always now can will just want".split())
ADDABLE = {"i", "my", "me", "to"}
CONDITION = re.compile(r"\b(if|unless|except|when|whenever|only|but|however|although|though|while|until|sometimes|usually|mostly)\b", re.IGNORECASE)
ATTRIBUTION = re.compile(r"\b(said|says|wrote|writes|replied|asked|told me|according to|email from|message from|quote[sd]?|client wants|boss wants|he wants|she wants|they want)\b", re.IGNORECASE)
HEDGE = re.compile(r"\b(maybe|perhaps|might|someday|some day|one day|not sure|thinking (?:about|of)|considering|what if|poate|cândva|candva)\b", re.IGNORECASE)
ONE_OFF = re.compile(r"\b(just|only) (?:for )?(?:this|today)|\bthis (?:one )?(?:time|once|email|message)\b|\bone[- ]off\b|\bdoar (?:de data asta|acum|pentru acesta)\b", re.IGNORECASE)
QUESTION = re.compile(r"^\W*(?:should|could|would|can|shall|(?:do|does|did)(?!\s+not\b)(?!n['\u2019]t)|is|are|am|will|what|how|why|when|where|which|who)\b", re.IGNORECASE)
RETRACT = re.compile(r"\b(?:actually|changed my mind|scratch that|ignore that|never ?mind|on second thought|i meant|forget (?:that|it)|correction|instead)\b", re.IGNORECASE)
SELF_FRAME = re.compile(r"^\W*(?:my (?:preference|rule|goal|priority|instruction)\b|i (?:prefer|want|like|need|always|never|decided)\b)", re.IGNORECASE)
# Words a faithful statement may drop. Dropping any other word (fewer, only, in my emails...) can flip or widen the meaning.
DELETABLE = STOPWORDS | {"goal", "priority", "preference", "rule", "instruction", "going", "forward", "remember", "note", "is", "was", "get", "new", "decided", "need", "thanks", "thank", "ok", "okay"}
NO_LONGER = re.compile(r"\b(?:no longer|not anymore|nu mai)\b", re.IGNORECASE)


class Refused(Exception):
    pass


def tokens(text: str) -> List[str]:
    folded = unicodedata.normalize("NFKC", text).casefold()
    return re.findall(r"\w+", NO_LONGER.sub(" nolonger ", folded))


def norm(text: str) -> str:
    return " ".join(tokens(text))


def contains_words(haystack: str, needle: str) -> bool:
    h, n = tokens(haystack), tokens(needle)
    return len(n) >= 3 and any(h[i : i + len(n)] == n for i in range(len(h) - len(n) + 1))


def sentence_of(text: str, quote: str) -> Optional[str]:
    """The ONE sentence (or line) of the message that holds the whole quote, else None."""
    return next((s for s in re.split(r"(?<=[.!?])\s+|\n+", text) if contains_words(s, quote)), None)


def quoted_by_someone_else(sentence: str, quote: str) -> bool:
    """The quote sits inside quotation marks that the operator did not frame as their own (My preference is "..." is theirs)."""
    for match in re.finditer(r"[\"\u201c\u201e\u00ab]([^\"\u201d\u00bb]{3,})[\"\u201d\u00bb]", sentence):
        if contains_words(match.group(1), quote) and not SELF_FRAME.match(sentence):
            return True
    return False


def near_verbatim(statement: str, sentence: str) -> Optional[str]:
    """None when the statement reproduces the sentence (deleting words only); else the reason code. Word overlap is never
    enough: order, negations and numbers must match exactly."""
    s, t = tokens(statement), tokens(sentence)
    if [w for w in s if w in NEGATORS] != [w for w in t if w in NEGATORS]:
        return "negation_mismatch"
    if [w for w in s if w.isdigit()] != [w for w in t if w.isdigit()]:
        return "not_verbatim"
    rest = iter(t)
    if not all(w in rest for w in s if w not in ADDABLE):  # `in` on an iterator consumes it: an ordered subsequence test
        return "not_verbatim"
    # every word of the sentence is kept except filler: a deleted qualifier ("fewer", "only") would change the meaning
    spare = list(s)
    for w in t:
        if w in spare:
            spare.remove(w)
        elif w not in DELETABLE:
            return "not_verbatim"
    return None


def load_host(root: Path):
    path = root / "scripts" / "ai_verse_host_adapter.py"
    spec = importlib.util.spec_from_file_location("_aiverse_learn_host", path)
    if spec is None or spec.loader is None:
        raise Refused("owner_unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules["_aiverse_learn_host"] = module
    spec.loader.exec_module(module)
    return module, module.AIverseOSHost(root)


# -- plan: screening, no writes -----------------------------------------------------------------------------

def classify(c: Any, scope: str, messages: Dict[str, Dict[str, Any]], later: List[str], stored: Dict[str, Any], others: List[str]) -> Dict[str, Any]:
    """A rejected result carries a fixed code and the kind, never any candidate content."""

    def reject(code: str) -> Dict[str, Any]:
        kind = c.get("kind") if isinstance(c, dict) and c.get("kind") in {"preference", "goal", "memory"} else None
        return {"kind": kind, "disposition": "rejected", "reason": code}

    if not isinstance(c, dict) or c.get("kind") not in {"preference", "goal", "memory"}:
        return reject("malformed")
    statement, evidence, replaces = c.get("statement"), c.get("evidence"), c.get("replaces")
    if not isinstance(statement, str) or not 3 <= len(statement.strip()) <= 500 or not isinstance(evidence, dict) or not isinstance(evidence.get("quote"), str):
        return reject("malformed")
    if replaces is not None and not isinstance(replaces, str):
        return reject("malformed")
    if isinstance(c.get("confidence"), bool) or not isinstance(c.get("confidence"), (int, float)) or c["confidence"] < CONFIDENCE_MIN:
        return reject("low_confidence")
    message = messages.get(evidence.get("message_id"))
    if not message or message.get("role") != "user":
        return reject("not_operator_message")
    text = message["text"]
    if not contains_words(text, evidence["quote"]):
        return reject("quote_not_found")
    # Contextual secrets: the whole source message is screened, not only the sentence or the statement.
    if SECRET.search(" ".join([message.get("full") or text, statement, evidence["quote"], replaces or ""])):
        return reject("secret_in_source")
    if (c["kind"] == "preference" and c.get("category") not in CATEGORIES) or (c["kind"] == "memory" and c.get("memory_type") not in MEMORY_TYPES):
        return reject("malformed")
    sentence = sentence_of(text, evidence["quote"])
    if c.get("exception") is True or ONE_OFF.search(sentence or text):
        return reject("one_off_exception")

    item = {
        "kind": c["kind"], "statement": statement.strip(), "quote": evidence["quote"], "message_id": evidence["message_id"],
        "category": c.get("category"), "memory_type": c.get("memory_type"), "replaces": replaces, "confidence": float(c["confidence"]),
    }
    if c["kind"] == "memory":
        reason = "memory"
    elif replaces:
        reason = "correction"
    elif scope == "unscoped":
        reason = "unscoped"
    elif scope != "operator":
        reason = "workspace"
    elif c.get("tentative") is True or HEDGE.search(sentence or text):
        reason = "tentative"
    elif sentence is None:
        reason = "multi_sentence"
    elif PERMISSION.search(text):
        reason = "permission"
    elif quoted_by_someone_else(sentence, evidence["quote"]) or ATTRIBUTION.search(sentence):
        reason = "third_party"
    elif sentence.rstrip().endswith("?") or QUESTION.match(sentence):
        reason = "question"
    elif RETRACT.search(text) or any(RETRACT.search(t) for t in later):
        reason = "retraction"
    elif CONDITION.search(sentence):
        reason = "conditional"
    else:
        reason = near_verbatim(statement, sentence)
        if reason is None and not stored_ready(stored, c["kind"]):
            reason = "stored_unavailable"
        elif reason is None and conflicts_with_stored(c["kind"], c.get("category"), statement, stored):
            reason = "conflicts_stored"
        elif reason is None and competing_sentence(sentence, others):
            reason = "competing"
    return {**item, "disposition": "proposal" if reason else "auto", "reason": reason}


GENERIC = STOPWORDS | {"use", "prefer", "like", "need", "keep", "make", "get", "all", "every", "future", "future", "going"}


def stored_ready(stored: Dict[str, Any], kind: str) -> bool:
    """Auto needs the stored state to have been read: preferences for a preference, the Brain goals for a goal."""
    return bool(stored.get("loaded")) and (kind != "goal" or bool(stored.get("goals_loaded")))


def conflicts_with_stored(kind: str, category: Optional[str], statement: str, stored: Dict[str, Any]) -> bool:
    """Fail closed: anything stored in the same category (preferences) or any stored goal that is not this exact text may be what
    this statement contradicts, and topic cannot be judged by word overlap. Only an identical text is a safe repeat."""
    old = list((stored.get("preferences") or {}).get(category) or []) if kind == "preference" else list(stored.get("goals") or [])
    return any(norm(x) != norm(statement) for x in old)


def competing_sentence(sentence: str, others: List[str]) -> bool:
    """Another operator sentence in the window that shares a content word with the cited one but is not the same sentence."""
    mine = {w for w in tokens(sentence) if w not in GENERIC and not w.isdigit()}
    return any(norm(o) != norm(sentence) and mine & {w for w in tokens(o) if w not in GENERIC and not w.isdigit()} for o in others)


def plan(request: Dict[str, Any]) -> Dict[str, Any]:
    messages = {m["id"]: m for m in request["messages"]}
    order = [m["id"] for m in request["messages"] if m["role"] == "user"]
    stored = request.get("stored") or {}
    candidates = request.get("candidates")
    if not isinstance(candidates, list):
        raise Refused("malformed")
    def later_than(c: Any) -> List[str]:
        mid = c.get("evidence", {}).get("message_id") if isinstance(c, dict) and isinstance(c.get("evidence"), dict) else None
        return [messages[i]["text"] for i in order[order.index(mid) + 1 :]] if mid in order else []

    def others_than(c: Any) -> List[str]:
        mid = c.get("evidence", {}).get("message_id") if isinstance(c, dict) and isinstance(c.get("evidence"), dict) else None
        cited = messages.get(mid, {}).get("text", "") if mid else ""
        quote = c.get("evidence", {}).get("quote", "") if isinstance(c, dict) and isinstance(c.get("evidence"), dict) else ""
        mine = sentence_of(cited, quote) if cited and isinstance(quote, str) else None
        found = []
        for m in request["messages"]:
            if m["role"] != "user":
                continue
            for sent in re.split(r"(?<=[.!?])\s+|\n+", m.get("full") or m["text"]):
                if sent.strip() and not (mine and norm(sent) == norm(mine)):
                    found.append(sent)
        return found

    return {"items": [classify(c, request["scope"], messages, later_than(c), stored, others_than(c)) for c in candidates[:6]]}


# -- commit: one item ---------------------------------------------------------------------------------------

class Owners:
    def __init__(self, root: Path, session_key: str, scope: str, host=None, fence=None) -> None:
        self.session_key, self.scope, self.fence = session_key, scope, fence or (lambda: None)
        self.module, self.host = host or load_host(root)

    def action(self, operation: str, parameters: Dict[str, Any], key: str, write: bool = True):
        request = {
            "action_class": "write_local_reversible" if write else "read_local", "scope": self.scope, "operation": operation,
            "parameters": parameters, "idempotency_key": key, "in_scope": True, "within_budget": True, "reversible": True,
            "reason": "Automatic learning saves a statement the operator made through its existing owner.",
        }
        request["request_fingerprint"] = self.module._fingerprint(request)
        if write:
            self.fence()  # immediately before the permission check and again immediately before the mutation
            if self.host.authorize_action(request).get("decision") != "allow":
                raise Refused("owner_refused")
            self.fence()
        return self.host.request_action(request)

    def profile(self) -> Dict[str, Any]:
        return self.action("operator.profile.read", {}, "learn-read", write=False)["result"]["operator_profile"]

    def intents(self) -> Dict[str, Any]:
        return self.action("brain.intent.read", {}, "learn-read", write=False)["result"]["brain_intents"]

    def preference(self, item: Dict[str, Any], key: str, ref: str) -> Dict[str, Any]:
        evidence = {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False, "contains_sensitive": False,
                    "contains_secret": False, "reason": "The operator stated this working preference in their own message."}
        provenance = {"trigger_ref": ref, "classifier": CLASSIFIER, "source": "claude-code:user"}
        out = self.action("operator.profile.ensure", {"preferences": {item["category"]: [item["statement"]]}, "evidence": evidence, "provenance": provenance}, key)
        mapped = {"created": "created", "evolved": "created", "existing": "already_present"}.get(out["result"]["operator_profile"].get("state"))
        if not mapped:
            raise Refused("owner_refused")
        return {"state": mapped, "owner": "operator-profile", "ref": "operator/profile/preferences.md"}

    def goal(self, item: Dict[str, Any], key: str, ref: str) -> Dict[str, Any]:
        brain = self.intents()
        if brain.get("state") != "ready":
            raise Refused("goal_owner_unavailable")
        out = self.action("brain.intent.capture", {"subtype": "goal", "statement": item["statement"], "operation_id": key, "evidence_ref": ref, "source": "explicit_user"}, key)
        intent = out["result"]["brain_intent"]
        if intent.get("state") == "unchanged":
            return {"state": "already_present", "owner": "brain", "ref": intent.get("ref")}
        if intent.get("changed") and intent.get("status") in {"CONFIRMED", "ACTIVE"}:
            return {"state": "created", "owner": "brain", "ref": intent.get("ref")}
        raise Refused("owner_refused")


def effect_key(session_key: str, item: Dict[str, Any]) -> str:
    raw = f"{session_key}|{item['message_id']}|{item['kind']}|{norm(item['statement'])}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def proposal(item: Dict[str, Any], reason: str, ref: str) -> Dict[str, Any]:
    shown = item["kind"] + (f" ({item['category']})" if item.get("category") else "")
    lines = [f"Proposed from a Claude Code conversation, not saved yet. {shown}: {item['statement']}", f'You wrote: "{item["quote"]}"']
    if item.get("replaces"):
        lines.append(f"It would replace: {item['replaces']}")
    lines.append(f"Held because {REASONS[reason]}. Say in plain words that you want it saved, or dropped.")
    return {"state": "proposed", "reason": reason, "inbox": {"candidate_kind": "claude-code-learning-proposal", "summary": " ".join(lines)[:1500], "refs": [ref]}}


def mode_still_auto(root: Path) -> bool:
    try:
        return json.loads((root / ".aiverse" / "learn" / "config.json").read_text(encoding="utf-8")).get("mode") == "auto"
    except Exception:
        return False


def commit(root: Path, request: Dict[str, Any], host=None) -> Dict[str, Any]:
    item, mode, scope, session_key = request["item"], request["mode"], request["scope"], request["session_key"]
    ref = f"claude-code:{session_key}:{item['message_id']}"
    if item["disposition"] != "auto":
        return proposal(item, item["reason"], ref)
    if mode != "auto":
        return proposal(item, "propose_mode", ref)
    key = effect_key(session_key, item)
    deadline, parent = request.get("deadline", float("inf")), request.get("parent_pid")

    def fence() -> None:
        # Evaluated at every owner mutation: the worker's lease is only trusted until the deadline, the worker must still be our
        # parent (POSIX) and the switch must still say auto. Otherwise nothing is written.
        if time.time() * 1000 > deadline or (os.name == "posix" and parent and os.getppid() != parent) or not mode_still_auto(root):
            raise Refused("fenced")

    try:
        owners = Owners(root, session_key, scope, host, fence)
        return owners.preference(item, key, ref) if item["kind"] == "preference" else owners.goal(item, key, ref)
    except Refused as error:
        return proposal(item, str(error) if str(error) in REASONS else "owner_unavailable", ref)
    except Exception:  # never keep the exception text: it could echo content
        return proposal(item, "owner_unavailable", ref)


def context(root: Path, scope: str, host=None) -> Dict[str, Any]:
    """`loaded` is true only when the stored preferences were actually read; `goals_loaded` only when the Brain goals were."""
    out: Dict[str, Any] = {"scope": scope, "preferences": {}, "goals": [], "loaded": False, "goals_loaded": False}
    if scope != "operator":
        return out
    try:
        owners = Owners(root, "ctx", scope, host)
        out["preferences"] = {k: v for k, v in owners.profile()["preferences"].items() if k in CATEGORIES and v}
        out["loaded"] = True
        brain = owners.intents()
        if brain.get("state") == "ready":
            out["goals"] = [i["statement"] for i in brain["intents"] if i.get("subtype") == "goal"]
            out["goals_loaded"] = True
    except Exception:
        pass
    return out


def main() -> int:
    parser = argparse.ArgumentParser(prog="ai-verse-learn-apply")
    parser.add_argument("--root", required=True)
    parser.add_argument("command", choices=["context", "plan", "commit"])
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()
    try:
        request = json.loads(sys.stdin.read())
        run = {"context": lambda: context(root, request["scope"]), "plan": lambda: plan(request), "commit": lambda: commit(root, request)}
        output = run[args.command]()
    except Exception:
        print(f"ai-verse-learn-apply {args.command} failed", file=sys.stderr)
        return 1
    sys.stdout.write(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
