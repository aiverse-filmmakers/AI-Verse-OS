"""Local Codex transport for Brain's canonical strategic intents, never a goal store."""
from pathlib import Path
import hashlib
import json
import re
import time
from contextlib import contextmanager
from aiverse_brain.errors import LockConflict
from aiverse_brain.authority import AuthorityTier
from aiverse_brain.controller import BrainController
from aiverse_brain.direction_ownership import DirectionOwnershipService, _bullet_candidates, _dedupe
from aiverse_brain.purpose_snapshot import build_purpose_snapshot, canonical_ref
from aiverse_brain.runtime_lock import RuntimeKeyLock

USER = AuthorityTier.EXPLICIT_USER
CURRENT = {"CONFIRMED", "ACTIVE", "PAUSED"}
SUBTYPES = {"goal", "mission", "strategy", "desired_state", "problem", "boundary", "constraint", "success_definition"}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class CompatibleOwnership(DirectionOwnershipService):
    """Reuse Brain's transaction; support the same priority-heading aliases as OS."""
    def _candidates(self, scope):
        found = super()._candidates(scope)
        if scope == "operator" and self.controller.layout.mode == "native":
            file = self.root / "operator/context/CURRENT.md"
            if file.exists() and not file.is_symlink():
                for heading in ("Current priority", "Priorities"):
                    found.extend(_bullet_candidates(file, heading, "goal", self.root))
        candidates = _dedupe(found)
        expected = getattr(self, "expected_candidates", None)
        if expected is not None and [item.to_dict() for item in candidates] != expected:
            raise ValueError("Import sources changed during handover; review again")
        return candidates


class IntentService:
    def __init__(self, root):
        self.root = Path(root).resolve()
        for relative in ("operator", "operator/context", "operator/profile", "operator/brain", ".aiverse", ".aiverse/direction", "workspaces"):
            path = self.root / relative
            if path.is_symlink():
                raise ValueError("Symlink in Brain intent boundary")
        self.controller = BrainController(str(self.root))
        self.ownership = CompatibleOwnership(self.controller)
        self.lock = RuntimeKeyLock(self.controller.layout.runtime_dir, namespace="codex-intent")

    @contextmanager
    def guard(self, scope):
        deadline = time.monotonic() + 5
        while True:
            manager = self.lock.acquire(scope)
            try:
                manager.__enter__()
            except LockConflict:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.02)
                continue
            break
        try:
            yield
        finally:
            manager.__exit__(None, None, None)

    def plan(self, scope):
        plan = self.ownership.plan(scope).to_dict()
        plan["fingerprint"] = fingerprint(plan)
        return plan

    def handover(self, scope, expected, confirmed):
        if not confirmed:
            raise ValueError("Explicit confirmation of this import is required")
        if self.ownership.owner(scope) == "brain":
            result = self.ownership.handover(scope, confirm_import=True).to_dict()
        else:
            plan = self.plan(scope)
            if expected != plan["fingerprint"]:
                raise ValueError("Sources changed; review the new handover plan before confirming")
            self.ownership.expected_candidates = plan["import_candidates"]
            result = self.ownership.handover(scope, confirm_import=True).to_dict()
        # Handover confirms intent; activate it through Brain's normal public transition.
        for ref in result.get("brain_refs", []):
            object_id = ref.split(":")[-1]
            item = self.controller.store.load("intent", scope, object_id)
            if item.status == "CONFIRMED":
                self.controller.transition("intent", scope, item.id, "ACTIVE", source=USER, actor="codex:confirmed-handover")
        return result

    def snapshot(self, scope):
        return build_purpose_snapshot(self.controller, scope)

    def capture(self, scope, request, source_ref, operation):
        """Caller has authenticated original-user evidence, never retrieved/tool text."""
        if self.ownership.owner(scope) != "brain":
            return {"state": "owner-required", "scope": scope, "owner": "os",
                    "message": "Use the existing OS owner for this scope; Brain handover is explicit."}
        classification = request.get("classification")
        if classification not in {"operator-goal", "workspace-goal", "correction"}:
            return {"state": "not-strategic", "classification": classification}
        if classification == "operator-goal" and scope != "operator":
            raise ValueError("Operator goals require operator scope")
        if classification == "workspace-goal" and scope == "operator":
            raise ValueError("Workspace goals cannot be promoted to operator scope")
        subtype = request.get("subtype", "goal")
        statement = request.get("statement")
        if subtype not in SUBTYPES or not isinstance(statement, str) or not 1 <= len(statement.strip()) <= 2000:
            raise ValueError("Invalid strategic statement")
        statement = statement.strip()
        confirmed = request.get("explicit_user_declaration") is True
        prior_id = request.get("supersedes")
        expected = request.get("expected_version")
        if classification == "correction" and not prior_id:
            raise ValueError("A correction needs the exact same-scope prior intent")
        if prior_id and not confirmed:
            raise ValueError("Strategic replacement requires an explicit user correction")
        payload_key = {"scope": scope, "statement": statement, "subtype": subtype,
                       "supersedes": prior_id, "expected_version": expected, "confirmed": confirmed}
        fp = fingerprint(payload_key)
        with self.guard(scope):
            existing = self.controller.store.list("intent", scope)
            same_operation = [o for o in existing if o.payload.get("codex_capture", {}).get("operation") == operation]
            if same_operation:
                item = same_operation[0]
                if item.payload["codex_capture"]["fingerprint"] != fp:
                    raise ValueError("Operation reused with different content")
            else:
                duplicate = next((o for o in existing if o.status in CURRENT and
                                  o.payload.get("subtype") == subtype and
                                  o.payload.get("statement", "").casefold() == statement.casefold() and not prior_id), None)
                if duplicate:
                    return {"state": "unchanged", "ref": canonical_ref(duplicate), "status": duplicate.status}
                if prior_id:
                    prior = self.controller.store.load("intent", scope, prior_id)
                    if prior.revision != expected or prior.status not in CURRENT or prior.payload.get("subtype") != subtype:
                        raise ValueError("Stale version, inactive, or incompatible correction target")
                workspace_links = list(prior.payload.get("workspace_links", [])) if prior_id else []
                item = self.controller.create("intent", scope, "PROPOSED", {
                    "subtype": subtype, "statement": statement, "workspace_links": workspace_links,
                    "codex_capture": {"operation": operation, "fingerprint": fp,
                                      "expected_prior_version": expected, "explicit": confirmed}},
                    source=USER if confirmed else AuthorityTier.TEMPORARY_HYPOTHESIS,
                    actor="codex:intent", source_refs=[source_ref], supersedes=prior_id)
            if confirmed:
                if prior_id:
                    prior = self.controller.store.load("intent", scope, prior_id)
                    if prior.status != "SUPERSEDED":
                        if prior.revision != expected:
                            raise ValueError("Prior intent changed before correction activation")
                        self.controller.transition("intent", scope, prior_id, "SUPERSEDED", source=USER, actor="codex:intent")
                if item.status == "PROPOSED":
                    item = self.controller.transition("intent", scope, item.id, "CONFIRMED", source=USER, actor="codex:intent")
                if item.status == "CONFIRMED":
                    item = self.controller.transition("intent", scope, item.id, "ACTIVE", source=USER, actor="codex:intent")
            return {"state": "saved" if confirmed else "awaiting-confirmation", "ref": canonical_ref(item),
                    "status": item.status, "supersedes": item.supersedes}

    def confirm(self, scope, intent_id, expected, source_ref, operation):
        if self.ownership.owner(scope) != "brain":
            raise ValueError("Brain does not own this scope")
        with self.guard(scope):
            item = self.controller.store.load("intent", scope, intent_id)
            if item.payload.get("codex_confirmation") != operation:
                if item.status != "PROPOSED" or item.revision != expected:
                    raise ValueError("Confirmation requires the exact pending intent/version")
                item.payload["codex_confirmation"] = operation
                item.source_refs.append(source_ref)
                item = self.controller.store.save(item, expected_revision=expected)
            if item.status == "PROPOSED":
                item = self.controller.transition("intent", scope, item.id, "CONFIRMED", source=USER, actor="codex:intent-confirm")
            if item.status == "CONFIRMED":
                item = self.controller.transition("intent", scope, item.id, "ACTIVE", source=USER, actor="codex:intent-confirm")
            if item.status != "ACTIVE":
                raise ValueError("Pending intent is no longer confirmable")
            return {"state": "saved", "ref": canonical_ref(item), "status": item.status}

    def link(self, workspace, intent_id, source_ref, operation):
        """Explicit relationship metadata lives on the canonical Brain intent itself."""
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", workspace) or workspace == "_template":
            raise ValueError("Invalid workspace")
        path = self.root / "workspaces" / workspace / "WORKSPACE.yaml"
        if not path.is_file() or any(p.is_symlink() for p in [path, path.parent, path.parent.parent]):
            raise ValueError("Workspace missing or unsafe")
        if self.ownership.owner("operator") != "brain":
            raise ValueError("Operator strategic owner is not Brain")
        with self.guard("operator"):
            intent = self.controller.store.load("intent", "operator", intent_id)
            if intent.status not in {"ACTIVE", "CONFIRMED"}:
                raise ValueError("Link needs a current operator intent")
            links = intent.payload.get("workspace_links", [])
            if any(link.get("scope") == "workspace:" + workspace for link in links):
                return {"state": "linked", "ref": canonical_ref(intent)}
            if len(links) >= 32:
                raise ValueError("Workspace relationship budget exceeded")
            revision = intent.revision
            intent.payload["workspace_links"] = links + [{
                "scope": "workspace:" + workspace, "relation": "executes",
                "canonical_ref": {"owner": "ai-verse-os", "scope": "workspace:" + workspace,
                                  "kind": "current-context", "id": "active"},
                "source_refs": [source_ref], "operation_id": operation}]
            intent.source_refs.append(source_ref)
            intent = self.controller.store.save(intent, expected_revision=revision)
            return {"state": "linked", "ref": canonical_ref(intent)}

    def relevant(self, scope, prompt):
        # No broad strategic injection for greetings and routine micro-requests.
        if len(prompt.strip()) < 45 and not re.search(r"goal|purpose|priorit|strateg|target|obiectiv", prompt, re.I):
            return {"state": "skipped-routine", "scope": scope}
        own = self.snapshot(scope)
        result = {"scope": scope, "direction_owner": own["direction_owner"],
                  "status": own["status"], "strategic_objects": own["strategic_objects"],
                  "relationships": own["relationships"]}
        if scope.startswith("workspace:"):
            # Only Brain's public operator snapshot is filtered; no other workspace is read.
            if self.ownership.owner("operator") == "brain":
                snapshot = self.snapshot("operator")
                linked = []
                for item in snapshot["strategic_objects"]["intents"]:
                    links = [link for link in item["payload"].get("workspace_links", [])
                             if link.get("scope") == scope and link.get("relation") == "executes"]
                    if links:
                        # Other workspace links never enter this workspace's prompt.
                        item["payload"]["workspace_links"] = links
                        linked.append(item)
                if linked:
                    result["linked_operator_intents"] = linked
        # Public snapshot is the owner boundary; emit only useful owner-backed fields.
        for group in [*result["strategic_objects"].values(), result.get("linked_operator_intents", [])]:
            for item in group:
                if "payload" in item:
                    item["payload"] = {key: value for key, value in item["payload"].items()
                                       if key in {"subtype", "statement", "workspace_links", "hypothesis", "outcome", "serves", "desired_state_refs", "interpretation"}}
        # Bound by objects rather than truncating JSON; data omitted is reported explicitly.
        encoded = json.dumps(result, ensure_ascii=False)
        while len(encoded.encode()) > 4500:
            groups = result["strategic_objects"]
            lists = [result.get("linked_operator_intents", []), *groups.values(), result["relationships"]]
            nonempty = [items for items in lists if items]
            if not nonempty:
                return {"scope": scope, "status": "budget-exceeded", "query_required": True}
            max(nonempty, key=lambda v: len(json.dumps(v))).pop()
            result["truncated"] = True
            encoded = json.dumps(result, ensure_ascii=False)
        return result
