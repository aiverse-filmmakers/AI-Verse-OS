"""Tidying: look back over what was saved, fix what sits in the wrong place, tell the operator, allow undo.

Loaded by bridge.py (pinned by hash). All durable truth stays with the existing owners: Memory, the operator
profile and the project notes. This module keeps only a content light work list and the notes waiting to be
shown, under runtime/codex-learning/reflect/, guarded by one lock shared by every app and process."""
from __future__ import annotations

import contextlib
import os
import re
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path

GUESS = "⚠️ guess"  # the visible provisional marker stored with any assistant-made assertion
LEASE_SECONDS = 180
WORK_SECONDS = 45          # stop starting new work after this much tool time
MAX_PENDING, MAX_RECORDS, MAX_BYTES, MAX_ACTIONS = 20, 40, 24 * 1024, 5
CLAIM_SECONDS = 30
NOTE_ITEMS = 8
ADMISSION = {"durable": True, "historical": True, "current_truth": False, "contains_secret": False,
             "strategic": False, "permission_expansion": False, "privacy_ambiguous": False,
             "external_authority": False}
CURRENT_ADMISSION = {"current": True, "strategic": False, "contains_secret": False, "privacy_ambiguous": False,
                     "high_stakes": False, "data_owned": False, "permission_expansion": False}
PROFILE_EVIDENCE = {"stable": True, "explicit_or_strong": True, "privacy_ambiguous": False,
                    "contains_sensitive": False, "contains_secret": False}
UPGRADE_SCOPE = "workspace:ai-verse-os-development"
UPGRADE_VIEW = "workspaces/ai-verse-os-development/knowledge/AI-VERSE-OS-UPGRADE-LIST.md"


def new_state():
    return {"schema_version": 1, "seq": 0, "entries": [], "lease": None, "generation": 0, "actions": {},
            "batches": [], "rejected": [], "counts": {"shown": 0, "corrected": 0}, "last_delivery_day": None}


class Tidy:
    claim_seconds = CLAIM_SECONDS
    work_seconds = WORK_SECONDS

    def __init__(self, bridge, mod):
        self.b, self.m = bridge, mod
        self.dir = mod.safe(bridge.runtime / "reflect", bridge.root)
        self.file = self.dir / "state.json"
        self.lockfile = self.dir / "lock"

    # ---------------------------------------------------------------- storage
    @property
    def enabled(self):
        return bool(self.b.config.get("reflection_enabled", True))

    @contextlib.contextmanager
    def locked(self, timeout=3):
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.m.safe(self.lockfile, self.b.root)
        fd = os.open(self.lockfile, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "r+") as stream:
            with self.m.file_lock(stream, timeout):
                yield

    def load(self):
        if not self.file.exists():
            return new_state()
        value = self.m.read_json(self.file, self.b.root)
        if value.get("schema_version") != 1:
            raise self.m.Refused("tidy state is incompatible")
        return value

    def store(self, state):
        # Keep the file small: finished entries and old closed batches are dropped.
        state["entries"] = [e for e in state["entries"] if not e.get("done")][-500:]
        state["batches"] = state["batches"][-30:]
        state["rejected"] = state["rejected"][-200:]
        self.m.atomic_json(self.file, state, self.b.root)

    @staticmethod
    def now():
        return time.time()

    # ---------------------------------------------------------------- ledger
    def record(self, turn, candidate, result, kinds):
        """Called after an original-turn owner write. Content free: scope, owner, record reference, evidence trace."""
        if not self.enabled:
            return
        route, ref, changed = candidate["route"], None, False
        if route == "memory":
            capture = result.get("result", {}).get("memory_capture", {})
            changed, ref = capture.get("state") == "captured", capture.get("memory_id")
        elif route == "profile":
            profile = result.get("result", {}).get("operator_profile", {})
            changed, ref = bool(profile.get("changed")), "operator-profile"
        elif route == "current":
            changed, ref = bool(result.get("changed")), result.get("source")
        if not changed:
            return
        try:
            with self.locked():
                state = self.load()
                state["seq"] += 1
                state["entries"].append({"seq": state["seq"], "turn": turn["id"], "scope": candidate["scope"],
                                         "owner": route, "ref": ref, "traced": "user" in kinds,
                                         "at": self.now(), "done": False})
                self.store(state)
        except (self.m.Refused, OSError, ValueError):
            pass  # a ledger problem must never block saving

    def pending(self, state):
        return [e for e in state["entries"] if not e.get("done")]

    def due(self, state):
        pending = self.pending(state)
        if not self.enabled or not pending:
            return False
        lease = state.get("lease")
        if lease and lease["expires"] > self.now():
            return False
        old = self.now() - min(e["at"] for e in pending) > self.b.config.get("reflect_max_age_hours", 6) * 3600
        return len(pending) >= self.b.config.get("reflect_min_entries", 5) or old

    # ---------------------------------------------------------------- what the AI is told each prompt
    def commands(self, session, turn):
        prefix = self.b.command_prefix()
        base = f"{prefix} reflect {{}} --session {self.m.shlex.quote(session)} --turn {self.m.shlex.quote(turn['id'])} --token {self.m.shlex.quote(turn['token'])}"
        return base

    def advert(self, state, compact=False):
        """Text for the start of a prompt: due commands and any tidy note to show. Empty when there is nothing."""
        turn = state.get("turn")
        if not self.enabled or not turn or turn.get("state") != "active":
            return ""
        text = ""
        try:
            with self.locked(0.4):
                data = self.load()
                if self.due(data):
                    base = self.commands(state["session_id"], turn)
                    text += ("\nAI-Verse OS tidying is due. After you finish the operator's request and before your final answer, run "
                             "these three in order and nothing else for tidying: " + base.format("plan") + " ; then "
                             + base.format("apply") + " ; then " + base.format("done")
                             + " . Do not mention tidying, or what it changed, in your answer: the operator gets a separate tidy note later. "
                             "If a command is refused, skip tidying this turn and do not mention it. ")
                if not compact:
                    text += self._claim(data, state, turn)
                    self.store(data)
        except (self.m.Refused, OSError, ValueError):
            return ""
        return text + ("\n" if text else "")

    # ---------------------------------------------------------------- notes
    def readable(self, turn):
        return {"operator", *(turn.get("allowed") or [turn.get("scope", "operator")])}

    def action_scopes(self, action):
        return {"operator", "workspace:" + action["project"]}

    def _claim(self, data, state, turn):
        """Pick one delivery batch for this prompt. It is only acknowledged once the reply showing it is seen."""
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        readable = self.readable(turn)
        batch = next((b for b in data["batches"] if not b["acked"]
                      and (b["turn"] == turn["id"] or self.now() - b["claimed_at"] > self.claim_seconds)), None)
        if batch is None:
            if data["last_delivery_day"] == day:
                return ""
            used = {item["action"] for b in data["batches"] for item in b["items"]}
            ready = [a for aid, a in sorted(data["actions"].items(), key=lambda kv: kv[1].get("applied_at", 0))
                     if a["status"] == "applied" and aid not in used and self.action_scopes(a) <= readable][:NOTE_ITEMS]
            if not ready:
                return ""
            ids = [aid for aid, a in data["actions"].items() if a in ready]
            batch = {"id": secrets.token_hex(2).upper(), "items": [{"n": i + 1, "action": aid} for i, aid in enumerate(ids)],
                     "turn": turn["id"], "claimed_at": self.now(), "acked": False, "day": day}
            data["batches"].append(batch)
        if not all(self.action_scopes(data["actions"][i["action"]]) <= readable for i in batch["items"]):
            return ""  # kept for a turn that may read every project it mentions; nothing is revealed here
        batch["turn"], batch["claimed_at"] = turn["id"], self.now()
        return ("\nA tidy note is waiting. Start your next reply with this note exactly as written, before anything else, "
                "then carry on with the answer. Never place it in the middle of an answer:\n" + self.render(data, batch) + "\n")

    def render(self, data, batch):
        items = [(i["n"], data["actions"][i["action"]]) for i in batch["items"]]
        word = "thing" if len(items) == 1 else "things"
        lines = [f"\U0001f9f9 **AI-Verse OS tidied {len(items)} {word} it knows about you**", ""]
        for number, action in items:
            lines += [f"**{number}. {action['title']}**"] + [f"• {line}" for line in action["detail"]] + [""]
        lines += ["✅ All correct? Just carry on.",
                  "✏️ Something wrong? Say \"undo " + str(items[0][0] if len(items) == 1 else "N") + "\", or tell me what's right.",
                  f"(tidy note {batch['id']})"]
        return "\n".join(lines)

    def waiting_hint(self, state):
        return ""

    def acknowledge(self, state, message):
        """Stop hook: a note counts as delivered only when the reply that contains its id was observed."""
        if not isinstance(message, str) or "tidy note" not in message.lower():
            return
        try:
            with self.locked():
                data = self.load()
                changed = False
                for batch in data["batches"]:
                    if not batch["acked"] and re.search(r"tidy note\s+" + batch["id"], message, re.I):
                        batch.update({"acked": True, "delivered_at": self.now()})
                        data["last_delivery_day"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                        data["counts"]["shown"] += len(batch["items"])
                        changed = True
                if changed:
                    self.store(data)
        except (self.m.Refused, OSError, ValueError):
            pass

    # ---------------------------------------------------------------- shared checks
    def active_turn(self, session, turn_id, token):
        with self.b.lock(session):
            state = self.b.state(session)
            turn = self.b.bound_turn(state, turn_id, token)
            if turn["state"] not in {"active", "review_requested", "reviewed"}:
                raise self.m.Refused("tidying needs the current turn")
            return state, turn

    def fence(self, data, session, turn_id, generation=None):
        lease = data.get("lease")
        if not self.enabled:
            raise self.m.Refused("tidying is switched off")
        if (not lease or lease["session"] != session or lease["turn"] != turn_id or lease["expires"] < self.now()
                or (generation is not None and lease["generation"] != generation)):
            raise self.m.Refused("this tidy pass no longer holds the lease")
        if self.b.cancelled(session, turn_id):
            raise self.m.Refused("the turn was interrupted")
        return lease

    # ---------------------------------------------------------------- plan
    def plan(self, session, turn_id, token):
        state, turn = self.active_turn(session, turn_id, token)
        readable = self.readable(turn)
        projects = sorted(s[10:] for s in readable if s.startswith("workspace:"))
        with self.locked(10):
            data = self.load()
            lease = data.get("lease")
            if lease and lease["expires"] > self.now() and (lease["session"], lease["turn"]) != (session, turn_id):
                raise self.m.Refused("another tidy pass is running")
            if not self.enabled:
                raise self.m.Refused("tidying is switched off")
            data["generation"] += 1
            data["lease"] = {"session": session, "turn": turn_id, "generation": data["generation"],
                             "token": secrets.token_hex(8), "expires": self.now() + LEASE_SECONDS,
                             "started": self.now(), "inspected": [], "plan": [], "truncated": False}
            self.recover(data, session, turn_id)
            pending = [e for e in self.pending(data) if {"operator", e["scope"]} <= readable]
            inspected = pending[:MAX_PENDING]
            truncated = len(pending) > MAX_PENDING
            scan = self.b.owner("reflect_scan", {"projects": projects, "limit": MAX_RECORDS}) if projects else {
                "records": [], "workspaces": {}, "ventures": [], "truncated": False}
            found = self.detect(data, scan, projects)
            truncated = truncated or bool(scan.get("truncated")) or len(found) > MAX_ACTIONS
            items = []
            for item in found:
                known = data["actions"].setdefault(item["id"], {**item, "status": "planned", "generation": data["generation"]})
                if known["status"] == "planned" and len(items) < MAX_ACTIONS:
                    known["generation"] = data["generation"]
                    items.append(known)
            data["lease"].update({"inspected": [e["seq"] for e in inspected], "plan": [i["id"] for i in items],
                                  "truncated": truncated})
            self.store(data)
        shown = [{k: i[k] for k in ("id", "kind", "project", "traced", "reason", "title")} for i in items]
        out = {"pass": "planned", "pending_inspected": len(inspected), "items": shown, "truncated": truncated,
               "limits": {"pending": MAX_PENDING, "records": MAX_RECORDS, "actions": MAX_ACTIONS, "seconds": WORK_SECONDS}}
        while len(str(out).encode()) > MAX_BYTES and out["items"]:
            out["items"].pop()
            out["truncated"] = True
        return out

    def traced(self, record):
        marker = self.m.digest("user")[:16]
        refs = record.get("evidence_refs") or []
        tags = (record.get("tags") or "").lower()
        return (any(f":source:{marker}:" in r for r in refs) and "tidy" not in tags.split(",")
                and GUESS not in record.get("text", ""))

    def rejected(self, kind, project, sources):
        key = self.m.digest([kind, project, sorted(sources)])
        return key

    def detect(self, data, scan, projects):
        refused = {r["key"] for r in data["rejected"]}
        items = []
        records = [r for r in scan.get("records", []) if r["scope"] == "operator" and r["status"] == "active"
                   and r["type"] != "correction" and not r["text"].startswith("Moved to the ")]
        for project in projects:
            info = scan.get("workspaces", {}).get(project)
            if not info or info.get("status") != "active":
                continue
            names = {project, info["name"], *info.get("aliases", [])}
            hits = [r for r in records if any(re.search(r"(?<!\w)" + re.escape(n) + r"(?!\w)", r["text"], re.I)
                                              for n in names if n)][:3]
            hits = [r for r in hits if self.rejected("move", project, [r["id"] + self.m.digest(r["text"])[:12]]) not in refused]
            for flag in (True, False):
                subset = [r for r in hits if self.traced(r) is flag]
                if subset:
                    facts = [r["text"] for r in subset]
                    items.append({"id": "mv" + self.m.digest(["move", project, [r["id"] for r in subset]])[:10], "kind": "move",
                                  "project": project, "name": info["name"], "traced": flag, "records": subset, "facts": facts,
                                  "reason": ("you said it yourself" if flag else "the match is by name only and was not confirmed by you"),
                                  "title": ""})
            if hits:
                subset = [r for r in hits if self.traced(r)] or hits
                flag = all(self.traced(r) for r in subset)
                age = info.get("notes_age_days")
                if age is not None and age >= 14 and self.rejected("notes", project, [r["id"] for r in subset]) not in refused:
                    items.append({"id": "nt" + self.m.digest(["notes", project, [r["id"] for r in subset]])[:10], "kind": "notes",
                                  "project": project, "name": info["name"], "traced": flag, "facts": [r["text"] for r in subset][:3],
                                  "notes_sha256": info.get("notes_sha256"), "reason": "the project notes were more than two weeks old",
                                  "title": ""})
            if project not in scan.get("ventures", []) and self.rejected("venture", project, [project]) not in refused:
                items.append({"id": "vt" + self.m.digest(["venture", project])[:10], "kind": "venture", "project": project,
                              "name": info["name"], "traced": False, "facts": [],
                              "reason": "you have a project for it, but you never said you still run it", "title": ""})
        return items

    # ---------------------------------------------------------------- apply
    def payload(self, state, turn, route, scope, params, refs, effect):
        return {"scope": scope, "session_id": state["session_id"], "turn_id": turn["id"], "route": route,
                "parameters": params, "refs": refs[:30], "effect_id": effect}

    def build_ops(self, state, turn, action):
        aid, project = action["id"], action["project"]
        tag = "tidy" + (",guess" if not action["traced"] else "")
        guess = "" if action["traced"] else f" {GUESS}: moved on a name match, not confirmed by you."
        refs_tidy = [f"tidy:{aid}"]
        if action["kind"] == "move":
            ops = []
            for n, record in enumerate(action["records"]):
                refs = (record.get("evidence_refs") or [])[:25] + refs_tidy
                ops.append({"name": f"copy{n}", "payload": self.payload(state, turn, "memory", "workspace:" + project, {
                    "type": "fact", "text": record["text"] + guess, "confidence": .9, "admission": dict(ADMISSION),
                    "tags": tag + ",moved"}, refs, f"tidy:{aid}:copy{n}")})
                ops.append({"name": f"pointer{n}", "payload": self.payload(state, turn, "memory", "operator", {
                    "type": "correction", "text": f"Moved to the {action['name']} project by AI-Verse OS (tidy {aid}).",
                    "confidence": .9, "admission": dict(ADMISSION), "supersedes": record["id"], "tags": "tidy,pointer"},
                    refs, f"tidy:{aid}:pointer{n}")})
            return ops
        if action["kind"] == "notes":
            text = "; ".join(f[:200] for f in action["facts"]) + (f" {GUESS}: refreshed on a name match." if not action["traced"] else "")
            return [{"name": "notes", "payload": self.payload(state, turn, "current", "workspace:" + project, {
                "heading": "Current state", "text": "Moved from your general notes: " + text, "old_text": "",
                "expected_sha256": action["notes_sha256"], "admission": dict(CURRENT_ADMISSION)}, refs_tidy,
                f"tidy:{aid}:notes")}]
        text = f"Works on {action['name']} {GUESS}: {action['reason']}"
        return [{"name": "venture", "payload": self.payload(state, turn, "profile", "operator", {
            "identity": {"ventures": [{"text": text, "project": project}]},
            "evidence": {**PROFILE_EVIDENCE, "reason": f"AI-Verse OS tidy {aid} (a guess): {action['reason']}"}}, refs_tidy,
            f"tidy:{aid}:venture")}]

    def run_ops(self, ops, results):
        for op in ops:
            if op["name"] in results:
                continue
            operation = "current_remove" if op["payload"]["route"] == "current_remove" else "learn"
            results[op["name"]] = self.b.owner(operation, op["payload"])

    def recover(self, data, session, turn_id):
        """An action cut off part way is finished again from its recorded operations (all are idempotent)."""
        for aid, action in data["actions"].items():
            if action["status"] in {"applying", "undoing"}:
                try:
                    ops = action["ops"] if action["status"] == "applying" else action["comp"]
                    results = action.setdefault("results" if action["status"] == "applying" else "comp_results", {})
                    for op in ops:
                        op["payload"]["session_id"], op["payload"]["turn_id"] = session, turn_id
                    self.run_ops(ops, results)
                    if action["status"] == "applying":
                        self.build_comp(action)
                    self.finish(action)
                except (self.m.Refused, self.m.subprocess.TimeoutExpired):
                    action["status"] = "failed"

    def finish(self, action):
        if action["status"] == "applying":
            self.titles(action)
            action.update({"status": "applied", "applied_at": self.now()})
        else:
            action["status"] = "undone"

    def apply(self, session, turn_id, token, only=None):
        state, turn = self.active_turn(session, turn_id, token)
        started = None
        done, skipped = [], []
        with self.locked(10):
            data = self.load()
            lease = self.fence(data, session, turn_id)
            started = lease["started"]
        for aid in list(lease["plan"]):
            if only and aid != only:
                continue
            if time.time() - started > self.work_seconds:
                skipped.append(aid)
                continue
            with self.locked(15):
                data = self.load()
                lease = self.fence(data, session, turn_id)
                action = data["actions"].get(aid)
                if not action or action["status"] != "planned" or action["generation"] != lease["generation"]:
                    continue
                lease["expires"] = self.now() + LEASE_SECONDS
                action["ops"] = self.build_ops(state, turn, action)
                action["results"] = {}
                action["status"] = "applying"
                self.store(data)  # write ahead: what will be done is recorded before any owner is touched
                try:
                    self.run_ops(action["ops"], action["results"])
                except (self.m.Refused, self.m.subprocess.TimeoutExpired) as error:
                    action["error"] = type(error).__name__
                    self.store(data)  # stays "applying": the next pass finishes it from the record
                    skipped.append(aid)
                    continue
                self.build_comp(action)
                self.finish(action)
                self.store(data)
                done.append(aid)
        return {"pass": "applied", "applied": done, "left_for_later": skipped,
                "truncated": bool(skipped) or bool(lease.get("truncated"))}

    def build_comp(self, action):
        """Reverse steps, as new records: nothing is deleted and later edits are kept."""
        aid, comp = action["id"], []
        template = action["ops"][0]["payload"]
        if action["kind"] == "move":
            for n, record in enumerate(action["records"]):
                copy = action["results"][f"copy{n}"]["result"]["memory_capture"].get("memory_id")
                pointer = action["results"][f"pointer{n}"]["result"]["memory_capture"].get("memory_id")
                base = {k: template[k] for k in ("session_id", "turn_id", "route")}
                refs = [f"tidy:{aid}:undo"]
                comp.append({"name": f"retire{n}", "payload": {**base, "scope": "workspace:" + action["project"], "refs": refs,
                    "parameters": {"type": "correction", "text": "Retracted: the operator undid this tidy move.", "confidence": .9,
                                   "admission": dict(ADMISSION), "supersedes": copy, "tags": "tidy,undone"},
                    "effect_id": f"tidy:{aid}:retire{n}"}})
                comp.append({"name": f"restore{n}", "payload": {**base, "scope": "operator", "refs": refs,
                    "parameters": {"type": "correction", "text": record["text"], "confidence": .9,
                                   "admission": dict(ADMISSION), "supersedes": pointer, "tags": "tidy,restored"},
                    "effect_id": f"tidy:{aid}:restore{n}"}})
        elif action["kind"] == "venture":
            line = action["ops"][0]["payload"]["parameters"]["identity"]["ventures"][0]["text"]
            comp.append({"name": "retire", "payload": {"scope": "operator", "session_id": template["session_id"],
                "turn_id": template["turn_id"], "route": "profile", "refs": [f"tidy:{aid}:undo"],
                "parameters": {"correction": {"section": "identity", "category": "ventures", "previous": line,
                                              "replacement": None, "retire": True},
                               "evidence": {**PROFILE_EVIDENCE, "reason": f"The operator undid tidy {aid}."}},
                "effect_id": f"tidy:{aid}:retire"}})
        else:
            comp.append({"name": "remove", "payload": {"scope": "workspace:" + action["project"],
                "session_id": template["session_id"], "turn_id": template["turn_id"], "route": "current_remove",
                "parameters": {"effect_id": f"tidy:{aid}:notes"}, "refs": [], "effect_id": f"tidy:{aid}:remove"}})
        action["comp"] = comp

    def titles(self, action):
        name, flag = action["name"], "" if action["traced"] else "⚠️ A guess: "
        if action["kind"] == "move":
            many = len(action["facts"]) > 1
            action["title"] = (f"Your {name} details went to the wrong place, so I moved them" if action["traced"]
                               else f"⚠️ A guess: I moved {'some details' if many else 'a detail'} about {name}")
            action["detail"] = ["From: your general profile → To: your " + name + " project",
                                "What: " + "; ".join(f[:160] for f in action["facts"])]
            if not action["traced"]:
                action["detail"].append("Why: " + action["reason"])
        elif action["kind"] == "notes":
            action["title"] = flag + f"Your {name} notes were out of date, so I refreshed them"
            action["detail"] = ["Added: " + "; ".join(f[:160] for f in action["facts"])]
            if not action["traced"]:
                action["detail"].append("Why: " + action["reason"])
        else:
            action["title"] = "⚠️ A guess: your projects list"
            action["detail"] = [f"Added: \"Works on {name}\"", "Why: " + action["reason"]]

    # ---------------------------------------------------------------- done
    def done(self, session, turn_id, token):
        state, turn = self.active_turn(session, turn_id, token)
        with self.locked(10):
            data = self.load()
            lease = self.fence(data, session, turn_id)
            self.recover(data, session, turn_id)
            inspected = set(lease["inspected"])
            unfinished = [a for a in lease["plan"] if data["actions"].get(a, {}).get("status") == "planned"]
            for entry in data["entries"]:
                if entry["seq"] in inspected:
                    entry["done"] = True
            applied = [a for a in lease["plan"] if data["actions"].get(a, {}).get("status") == "applied"]
            result = {"pass": "done", "applied": len(applied), "inspected": len(inspected),
                      "still_pending": len(self.pending(data)), "truncated": bool(lease.get("truncated") or unfinished),
                      "note_waiting": bool(applied)}
            data["lease"] = None
            self.store(data)
        if self.b.config.get("maintainer_feedback"):
            with contextlib.suppress(self.m.Refused, OSError, self.m.subprocess.TimeoutExpired):
                self.write_upgrade_list()
        return result

    # ---------------------------------------------------------------- undo
    def undo(self, session, turn_id, token, note_id, item, mode="undo"):
        state, turn = self.active_turn(session, turn_id, token)
        with self.locked(15):
            data = self.load()
            batch = next((b for b in data["batches"] if b["id"] == note_id.upper() and b["acked"]), None)
            entry = next((i for i in (batch or {"items": []})["items"] if i["n"] == item), None)
            if not entry:
                raise self.m.Refused("that tidy item was not found")
            action = data["actions"][entry["action"]]
            if action["status"] == "undone":
                return {"pass": "undo", "state": "already-undone"}
            if action["status"] != "applied" and mode == "undo":
                raise self.m.Refused("that tidy change is not in a state that can be undone")
            sources = ([r["id"] + self.m.digest(r["text"])[:12] for r in action.get("records", [])]
                       if action["kind"] == "move" else [r["id"] for r in action.get("records", [])] or [action["project"]])
            key = self.rejected(action["kind"], action["project"], sources)
            if not any(r["key"] == key for r in data["rejected"]):
                data["rejected"].append({"key": key, "at": self.now(), "kind": action["kind"]})
            data["counts"]["corrected"] += 1
            if mode == "corrected":
                self.store(data)
                return {"pass": "undo", "state": "noted", "message": "Noted. I will not repeat this tidy."}
            for op in action["comp"]:
                op["payload"]["session_id"], op["payload"]["turn_id"] = session, turn_id
            action["status"] = "undoing"
            action["comp_results"] = {}
            self.store(data)
            try:
                self.run_ops(action["comp"], action["comp_results"])
            except (self.m.Refused, self.m.subprocess.TimeoutExpired):
                self.store(data)
                return {"pass": "undo", "state": "left-as-is",
                        "message": "I could not undo that cleanly, so I left it as it is. Tell me what you want it to say."}
            blocked = [r for r in action["comp_results"].values()
                       if r.get("result", {}).get("operator_profile", {}).get("state") in {"needs-clarification", "stale"}]
            action["status"] = "undone" if not blocked else "applied"
            self.store(data)
        if blocked:
            return {"pass": "undo", "state": "left-as-is",
                    "message": "That line was edited since, so I left it as it is."}
        return {"pass": "undo", "state": "undone"}

    # ---------------------------------------------------------------- status
    def status(self):
        with self.locked():
            data = self.load()
        pending = self.pending(data)
        return {"enabled": self.enabled, "pending": len(pending), "due": self.due(data),
                "tidy_changes_shown": data["counts"]["shown"], "tidy_changes_corrected": data["counts"]["corrected"],
                "lease_held": bool(data.get("lease") and data["lease"]["expires"] > self.now())}

    # ---------------------------------------------------------------- the mother list
    def check_upgrade_text(self, text):
        """Refuse before anything is saved: an upgrade note holds the request only, never another project's facts."""
        text = self.m.bounded_text(text, 600)
        self.m.no_secrets(text)
        names = self.b.owner("reflect_scan", {"projects": [], "limit": 1, "names_only": True}).get("all_names", {})
        for project, words in names.items():
            if project == UPGRADE_SCOPE[10:]:
                continue
            if any(re.search(r"(?<!\w)" + re.escape(w) + r"(?!\w)", text, re.I) for w in words if w):
                raise self.m.Refused("an upgrade note must not mention another project")
        return text, names

    def upgrade_note(self, text, session_state, turn):
        if not self.b.config.get("maintainer_feedback"):
            return {"state": "off"}
        text, names = self.check_upgrade_text(text)
        if not names or UPGRADE_SCOPE[10:] not in names:
            return {"state": "skipped"}
        result = self.b.owner("learn", self.payload(session_state, turn, "memory", UPGRADE_SCOPE, {
            "type": "lesson", "text": "AI-Verse OS upgrade note: " + text, "confidence": .9, "admission": dict(ADMISSION),
            "tags": "upgrade-note,open"}, [f"claude-upgrade:{turn['id']}"], f"upgrade:{turn['id']}:{self.m.digest(text)[:12]}"))
        with contextlib.suppress(self.m.Refused, OSError, self.m.subprocess.TimeoutExpired):
            self.write_upgrade_list()
        return {"state": "saved", "result": result}

    def write_upgrade_list(self):
        scan = self.b.owner("reflect_scan", {"projects": [], "limit": MAX_RECORDS, "upgrade": True})
        notes = scan.get("upgrade_notes", [])
        folder = self.b.root / "workspaces/ai-verse-os-development"
        if not folder.is_dir():
            return None
        lines = ["# AI-Verse OS upgrade list", "",
                 "Derived view, rebuilt by AI-Verse OS from what you asked for. The notes themselves live in what I remember "
                 "for this project. Edit those, not this file.", ""]
        lines += [f"- {n['text'].replace('AI-Verse OS upgrade note: ', '', 1)} ({n['created'][:10]})" for n in notes[:30]] or ["- Nothing yet."]
        if scan.get("truncated"):
            lines += ["", "Note: this list may be incomplete. Only the most recent notes could be read."]
        target = folder / "knowledge/AI-VERSE-OS-UPGRADE-LIST.md"
        self.m.safe(target, self.b.root)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        os.replace(tmp, target)
        return str(target.relative_to(self.b.root))
