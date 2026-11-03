#!/usr/bin/env python3
"""Deterministic screening and routing for automatic learning.

The reviewer's JSON is untrusted data. Three commands, JSON on stdin and stdout:

  context  what is already stored for the scope, and its revision (so the reviewer can name what a correction replaces)
  plan     screen every candidate against the operator's own words. No writes. Each candidate becomes `rejected` (a fixed reason
           code, nothing else), `proposal` (to be kept in the OS inbox for the member to approve in plain words) or `auto`.
  commit   carry out ONE planned item under the current mode: write an `auto` item through its existing owner, or build the inbox
           request for a proposal. Anything that fails, or any mode other than `auto`, becomes a proposal.

Auto is narrow on purpose. It needs: operator scope that is not project-specific, a NEW explicit durable personal preference or
goal, ONE operator sentence that the statement reproduces by deleting filler words only (nothing added, same words in the same
order, same negations, same numbers), no question, task, hedge, condition, quotation, attribution, paste, injection, retraction,
permission wording or secret-like text anywhere in that message or a later one, nothing stored that it could contradict, and
stored state unchanged since planning. On top of that the owners must advertise `supports_fenced_writes`; none does yet, so
every `auto` item is saved as a proposal (`auto_blocked`). Raw exception text is never kept: reasons are fixed codes.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

CONFIDENCE_MIN = 0.85
CLASSIFIER = "ai-verse-learn-auto-v3"
CATEGORIES = {"communication", "working_style", "quality_expectations", "avoid"}
MEMORY_TYPES = {"event", "experience", "lesson"}

REASONS = {
    "propose_mode": "automatic saving is off, so everything is only proposed",
    "auto_blocked": "automatic saving is blocked until the owners can refuse a stale write themselves",
    "correction": "it changes something already stored",
    "memory": "it is a past event or lesson, which is never saved without asking",
    "workspace": "it came from a workspace conversation",
    "unscoped": "it is not clear which workspace or the operator profile it belongs to",
    "scope_unresolved": "it sounds specific to one project, and which project is not known",
    "scope_bound": "the workspace was confirmed after the conversation",
    "tentative": "it sounded tentative",
    "conditional": "the sentence carries a condition or exception",
    "third_party": "the text looks quoted, pasted or attributed to someone else",
    "injection": "the text looks like an instruction aimed at the assistant",
    "permission": "it mentions permissions or approvals",
    "question": "what you wrote was a question, not an instruction",
    "task": "it reads like a request for one piece of work, not a lasting preference",
    "not_durable": "it does not say it is lasting",
    "retraction": "you seem to have changed your mind in the same message or a later one",
    "not_verbatim": "the statement is not close enough to what you wrote",
    "negation_mismatch": "the statement does not mirror the negation in what you wrote",
    "multi_sentence": "it is not supported by one single sentence of yours",
    "conflicts_stored": "something already stored is on the same topic and is not the same",
    "competing": "another sentence in the same conversation is about the same thing and says something different",
    "stored_unavailable": "what is already stored could not be read, so novelty cannot be checked",
    "stale_state": "what is stored changed after this was planned",
    "goal_owner_unavailable": "no goal owner is active yet",
    "owner_unavailable": "the owner that would save it was not available",
    "owner_refused": "the owner asked for clarification instead of saving",
    "fenced": "the worker no longer held the right to write",
}

# Any of these anywhere in the cited message rejects the candidate (the journal already dropped such messages; this is the second net).
SECRET = re.compile(
    r"pass(?:word|wd|phrase|code)|\bpwd\b|\bpin\b|secret|credential|api[ _-]?key|(?:access|refresh|auth|bearer|session)[ _-]?token"
    r"|\btoken\b|private[ _-]?key|recovery[ _-]?code|\b(?:ssn|iban|cvv|passport)\b|social security|credit[ _-]?card"
    r"|\bsk-[A-Za-z0-9_-]{12,}|\b[A-Za-z0-9+/_-]{28,}\b|\b(?:\d[ -]?){13,19}\b",
    re.IGNORECASE,
)
PERMISSION = re.compile(r"permission|authori[sz]e|approv", re.IGNORECASE)
NEGATORS = {"never", "not", "no", "dont", "don", "doesn", "didn", "won", "cannot", "cant", "without", "avoid", "stop", "nolonger", "nu", "niciodata", "fara", "nicio"}
STOPWORDS = set("a an the and or of to in on for with my me i you your is are be it this that as at by from so do does am we our if but also please always now can will just want".split())
# Words a faithful statement may drop. "you" and "your" are NOT among them: dropping them would turn someone's words into the operator's.
DELETABLE = (STOPWORDS - {"you", "your"}) | {"goal", "priority", "preference", "rule", "instruction", "going", "forward", "remember", "note", "is", "was", "get", "new", "decided", "need", "thanks", "thank", "ok", "okay"}
CONDITION = re.compile(r"\b(if|unless|except|when|whenever|only|but|however|although|though|while|until|sometimes|usually|mostly)\b", re.IGNORECASE)
ATTRIBUTION = re.compile(r"\b(said|says|wrote|writes|replied|asked|told me|according to|email from|message from|quote[sd]?|client wants|boss wants|he wants|she wants|they want)\b", re.IGNORECASE)
PASTE = re.compile(r"\b(following|below|attached|forwarded|pasted|copied|quoted)\b.{0,40}\b(email|e-mail|message|text|document|note|letter|brief|transcript|thread|article)\b|\b(email|message) (?:from|below)\b|^\s*>|\n\s*>", re.IGNORECASE)
INJECTION = re.compile(r"ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|rules|messages)|disregard (?:all |the )?(?:previous|prior)|system prompt|you are now\b|new instructions?:", re.IGNORECASE)
HEDGE = re.compile(r"\b(maybe|perhaps|might|someday|some day|one day|not sure|thinking (?:about|of)|considering|what if|poate|cândva|candva)\b", re.IGNORECASE)
ONE_OFF = re.compile(r"\b(just|only) (?:for )?(?:this|today)|\bthis (?:one )?(?:time|once|email|message)\b|\bone[- ]off\b|\bdoar (?:de data asta|acum|pentru acesta)\b", re.IGNORECASE)
NO_LONGER = re.compile(r"\b(?:no longer|not anymore|nu mai)\b", re.IGNORECASE)
QUESTION = re.compile(r"^\W*(?:should|could|would|can|shall|(?:do|does|did)(?!\s+not\b)(?!n['’]t)|is|are|am|will|what|how|why|when|where|which|who)\b", re.IGNORECASE)
RETRACT = re.compile(r"\b(?:actually|changed my mind|scratch that|ignore that|never ?mind|on second thought|i meant|forget (?:that|it)|correction|instead)\b", re.IGNORECASE)
SELF_FRAME = re.compile(r"^\W*(?:my (?:preference|rule|goal|priority|instruction)\b|i (?:prefer|want|like|need|always|never|decided)\b)", re.IGNORECASE)
TASK = re.compile(r"\b(next|this|these|those|today|tonight|tomorrow|yesterday|currently|following|below|above|attached|here)\b", re.IGNORECASE)
DURABLE = re.compile(
    r"\b(always|never|no longer|from now on|going forward|in (?:the )?future|prefer(?:s|red)?|i (?:want|like|love|need|hate|dislike|plan|aim|decided)|i don['’]?t|i do not"
    r"|my (?:goal|priority|preference|rule|aim)|goal is|(?:please )?don['’]?t|(?:please )?do not|avoid|stop)\b", re.IGNORECASE)
GENERIC = STOPWORDS | {"use", "prefer", "like", "need", "keep", "make", "get", "all", "every", "future", "going"}


class Refused(Exception):
    pass


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def tokens(text: str) -> List[str]:
    folded = unicodedata.normalize("NFKC", text).casefold()
    return re.findall(r"\w+", NO_LONGER.sub(" nolonger ", folded))


def norm(text: str) -> str:
    return " ".join(tokens(text))


def sentence_spans(text: str) -> List[Tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(r"[^.!?\n]+[.!?]*", text) if m.group().strip()]


def cited_sentence(message: Dict[str, Any], at: int, length: int) -> Optional[str]:
    """The ONE sentence (or line) of the whole message that holds the whole quote; `at` is its place in the part that was shown."""
    full, begin = nfc(message.get("full") or message["text"]), int(message.get("start") or 0) + at
    return next((full[a:b] for a, b in sentence_spans(full) if a <= begin and begin + length <= b), None)


def quoted_by_someone_else(sentence: str, quote: str) -> bool:
    """The quote sits inside quotation marks that the operator did not frame as their own (My preference is "..." is theirs)."""
    for match in re.finditer(r"[\"“„«]([^\"”»]{3,})[\"”»]", sentence):
        if quote in match.group(1) and not SELF_FRAME.match(sentence):
            return True
    return False


def near_verbatim(statement: str, sentence: str) -> Optional[str]:
    """None when the statement is the sentence with filler words deleted and NOTHING added; else the reason code."""
    s, t = tokens(statement), tokens(sentence)
    if [w for w in s if w in NEGATORS] != [w for w in t if w in NEGATORS]:
        return "negation_mismatch"
    if [w for w in s if w.isdigit()] != [w for w in t if w.isdigit()]:
        return "not_verbatim"
    rest = iter(t)
    if not all(w in rest for w in s):  # `in` on an iterator consumes it: an ordered subsequence test, no word may be added
        return "not_verbatim"
    spare = list(s)
    for w in t:
        if w in spare:
            spare.remove(w)
        elif w not in DELETABLE:
            return "not_verbatim"  # a deleted qualifier ("fewer", "only", "in my emails") would change the meaning
    return None


def conflicts_with_stored(kind: str, category: Optional[str], statement: str, stored: Dict[str, Any]) -> bool:
    """Fail closed. Anything stored in the same category, or on a shared topic word in another category, or any other stored goal,
    that is not this exact text may be what this statement contradicts. Only an identical text is a safe repeat."""
    if kind == "goal":
        return any(norm(x) != norm(statement) for x in (stored.get("goals") or []))
    mine = {w for w in tokens(statement) if w not in GENERIC and not w.isdigit()}
    for cat, olds in (stored.get("preferences") or {}).items():
        for old in olds:
            if norm(old) == norm(statement):
                continue
            if cat == category or mine & {w for w in tokens(old) if w not in GENERIC and not w.isdigit()}:
                return True
    return False


def competing_sentence(sentence: str, others: List[str]) -> bool:
    """Another operator sentence in the window that shares a content word with the cited one but is not the same sentence."""
    mine = {w for w in tokens(sentence) if w not in GENERIC and not w.isdigit()}
    return any(norm(o) != norm(sentence) and mine & {w for w in tokens(o) if w not in GENERIC and not w.isdigit()} for o in others)


def stored_ready(stored: Dict[str, Any], kind: str) -> bool:
    return bool(stored.get("loaded")) and (kind != "goal" or bool(stored.get("goals_loaded")))


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
    full, quote = nfc(message.get("full") or message["text"]), nfc(evidence["quote"])
    # The quote is the operator's own characters, exactly: same case, same punctuation, found in what was shown.
    at = nfc(message["text"]).find(quote)
    if len(quote.strip()) < 4 or at < 0:
        return reject("quote_not_found")
    if SECRET.search(" ".join([full, statement, quote, replaces or ""])):
        return reject("secret_in_source")
    if (c["kind"] == "preference" and c.get("category") not in CATEGORIES) or (c["kind"] == "memory" and c.get("memory_type") not in MEMORY_TYPES):
        return reject("malformed")
    sentence = cited_sentence(message, at, len(quote))
    if c.get("exception") is True or ONE_OFF.search(sentence or full):
        return reject("one_off_exception")

    item = {
        "kind": c["kind"], "statement": statement.strip(), "quote": quote, "message_id": evidence["message_id"], "quote_at": at,
        "category": c.get("category"), "memory_type": c.get("memory_type"), "replaces": replaces, "confidence": float(c["confidence"]),
        "scope_hint": c.get("scope_hint") if c.get("scope_hint") in ("general", "project") else "project",
    }
    if c["kind"] == "memory":
        reason = "memory"
    elif replaces:
        reason = "correction"
    elif scope == "unresolved":
        reason = "unscoped"
    elif scope == "operator" and item["scope_hint"] != "general":
        reason = "scope_unresolved"  # a hint may only veto global routing; it never grants access to any workspace
    elif scope != "operator":
        reason = "workspace"
    elif c.get("tentative") is True or HEDGE.search(sentence or full):
        reason = "tentative"
    elif sentence is None:
        reason = "multi_sentence"
    elif PERMISSION.search(full):
        reason = "permission"
    elif INJECTION.search(full):
        reason = "injection"
    elif PASTE.search(full) or ATTRIBUTION.search(full) or quoted_by_someone_else(sentence, quote):
        reason = "third_party"
    elif sentence.rstrip().endswith("?") or QUESTION.match(sentence):
        reason = "question"
    elif RETRACT.search(full) or any(RETRACT.search(t) for t in later):
        reason = "retraction"
    elif CONDITION.search(sentence):
        reason = "conditional"
    elif TASK.search(re.sub(r"from now on|right now", " ", sentence, flags=re.IGNORECASE)):
        reason = "task"
    elif not DURABLE.search(sentence):
        reason = "not_durable"
    else:
        reason = near_verbatim(statement, sentence)
        if reason is None and not stored_ready(stored, c["kind"]):
            reason = "stored_unavailable"
        elif reason is None and conflicts_with_stored(c["kind"], c.get("category"), statement, stored):
            reason = "conflicts_stored"
        elif reason is None and competing_sentence(sentence, others):
            reason = "competing"
    return {**item, "disposition": "proposal" if reason else "auto", "reason": reason}


def plan(request: Dict[str, Any]) -> Dict[str, Any]:
    messages = {m["id"]: m for m in request["messages"]}
    stored = request.get("stored") or {}
    candidates = request.get("candidates")
    if not isinstance(candidates, list):
        raise Refused("malformed")
    later = [t for t in (request.get("later") or []) if isinstance(t, str)]

    def others_than(c: Any) -> List[str]:
        ev = c.get("evidence") if isinstance(c, dict) and isinstance(c.get("evidence"), dict) else {}
        cited = messages.get(ev.get("message_id"))
        quote = nfc(ev["quote"]) if isinstance(ev.get("quote"), str) else ""
        at = nfc(cited["text"]).find(quote) if cited and quote else -1
        mine = cited_sentence(cited, at, len(quote)) if at >= 0 else None
        found = []
        for m in request["messages"]:
            text = nfc(m.get("full") or m["text"])
            found += [text[a:b] for a, b in sentence_spans(text) if not (mine and norm(text[a:b]) == norm(mine))]
        return found

    items = [classify(c, request["scope"], messages, later, stored, others_than(c)) for c in candidates[:30]]
    return {"items": items, "revision": stored.get("revision")}


# -- commit: one item ---------------------------------------------------------------------------------------

class Owners:
    def __init__(self, root: Path, session_key: str, scope: str, host=None, fence=None) -> None:
        self.session_key, self.scope, self.fence = session_key, scope, fence or (lambda: None)
        self.module, self.host = host or load_host(root)

    @property
    def fenced(self) -> bool:
        return getattr(self.host, "supports_fenced_writes", False) is True

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

    def snapshot(self) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
        profile = self.profile()
        try:
            return profile, self.intents()
        except Exception:
            return profile, None

    def revision(self) -> str:
        """What the stored state looks like right now, in the same form `context` reported it."""
        return stored_revision(*self.snapshot())

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
        status = intent.get("status")
        if intent.get("state") == "unchanged":
            return {"state": "already_present", "owner": "brain", "ref": intent.get("ref")}
        if intent.get("state") == "saved" and status in {"CONFIRMED", "ACTIVE"}:
            if intent.get("changed"):
                return {"state": "created", "owner": "brain", "ref": intent.get("ref")}
            if intent.get("replayed") is True:  # Brain answers only a repeat of THIS operation id with replayed: the goal is already saved
                return {"state": "already_present", "owner": "brain", "ref": intent.get("ref")}
        raise Refused("owner_refused")


def stored_revision(profile: Dict[str, Any], brain: Optional[Dict[str, Any]]) -> str:
    goals = sorted(i["statement"] for i in (brain or {}).get("intents", []) if i.get("subtype") == "goal") if (brain or {}).get("state") == "ready" else []
    return hashlib.sha256(json.dumps([profile.get("preferences_source_sha256"), goals]).encode("utf-8")).hexdigest()[:32]


def effect_key(session_key: str, item: Dict[str, Any]) -> str:
    raw = f"{session_key}|{item['message_id']}|{item['kind']}|{norm(item['statement'])}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def shorten(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def proposal(item: Dict[str, Any], reason: str, ref: str) -> Dict[str, Any]:
    """The inbox text. Only the PRESENTATION is shortened; the exact quote, place and date stay in the evidence record."""
    shown = item["kind"] + (f" ({item['category']})" if item.get("category") else "")
    date = f" on {item['ts'][:10]}" if isinstance(item.get("ts"), str) and item["ts"] else ""
    lines = [f"Proposed from a Claude Code conversation, not saved yet. {shown}: {shorten(item['statement'], 400)}", f'You wrote{date}: "{shorten(item["quote"], 600)}"']
    if item.get("replaces"):
        lines.append(f"It would replace: {shorten(item['replaces'], 200)}")
    lines.append(f"Held because {REASONS[reason]}. Say in plain words that you want it saved, or dropped.")
    return {"state": "proposed", "reason": reason, "inbox": {"candidate_kind": "claude-code-learning-proposal", "summary": shorten(" ".join(lines), 1500), "refs": [ref]}}


def read_config(root: Path) -> Dict[str, Any]:
    try:
        value = json.loads((root / ".aiverse" / "learn" / "config.json").read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}  # anything but an object is no configuration: no auto


def mode_still_auto(root: Path) -> bool:
    return read_config(root).get("mode") == "auto"


def commit(root: Path, request: Dict[str, Any], host=None) -> Dict[str, Any]:
    item, mode, scope, session_key = request["item"], request["mode"], request["scope"], request["session_key"]
    ref = f"claude-code:{session_key}:{item['message_id']}"
    if item["disposition"] != "auto":
        return proposal(item, item["reason"], ref)
    if mode != "auto":
        return proposal(item, "propose_mode", ref)
    deadline, parent = request.get("deadline", float("inf")), request.get("parent_pid")

    def fence() -> None:
        # Evaluated at every owner mutation: the worker's lease is only trusted until the deadline, the worker must still be our
        # parent (POSIX) and the switch must still say auto. Otherwise nothing is written.
        if time.time() * 1000 > deadline or (os.name == "posix" and parent and os.getppid() != parent) or not mode_still_auto(root):
            raise Refused("fenced")

    try:
        owners = Owners(root, session_key, scope, host, fence)
        if not owners.fenced:  # until the owners themselves refuse a stale or revoked write, nothing is written automatically
            return proposal(item, "auto_blocked", ref)
        if item.get("revision") != owners.revision():
            return proposal(item, "stale_state", ref)  # the stored state moved since planning: it must be planned again
        key = effect_key(session_key, item)
        return owners.preference(item, key, ref) if item["kind"] == "preference" else owners.goal(item, key, ref)
    except Refused as error:
        return proposal(item, str(error) if str(error) in REASONS else "owner_unavailable", ref)
    except Exception:  # never keep the exception text: it could echo content
        return proposal(item, "owner_unavailable", ref)


def context(root: Path, scope: str, host=None) -> Dict[str, Any]:
    """`loaded` is true only when the stored preferences were actually read; `goals_loaded` only when the Brain goals were."""
    out: Dict[str, Any] = {"scope": scope, "preferences": {}, "goals": [], "loaded": False, "goals_loaded": False, "revision": None}
    if scope != "operator":
        return out
    try:
        owners = Owners(root, "ctx", scope, host)
        profile, brain = owners.snapshot()
        out["preferences"] = {k: v for k, v in profile["preferences"].items() if k in CATEGORIES and v}
        out["loaded"] = True
        if brain and brain.get("state") == "ready":
            out["goals"] = [i["statement"] for i in brain["intents"] if i.get("subtype") == "goal"]
            out["goals_loaded"] = True
        out["revision"] = stored_revision(profile, brain)
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
