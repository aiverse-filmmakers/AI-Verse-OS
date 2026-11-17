# Action Permission Boundary

AI-Verse OS owns the outer host permission check for outside actions, Data writes and deletions executed through an intelligence layer such as AI-Verse Brain. The intelligence layer keeps its own policy and approval model. Effective authority is the intersection: **denial by either layer blocks execution**.

## Contract

The OS evaluator is `scripts/action-permission.mjs`. It accepts one immutable Brain action permission request on stdin and returns exactly one restrictive decision:

- `allow` — OS adds no restriction of its own. This never overrides a Brain denial or approval requirement.
- `approval_required` — OS requires Brain to hold a valid explicit-user approval bound to that exact action.
- `deny` — the action must not be dispatched.

Every decision is bound to the request fingerprint, scope, and action class. The OS never returns an approval grant and never treats extension registration, capability discovery, connection presence, readiness, or idempotency as authority.

A host adapter must re-evaluate permission at the action boundary rather than caching a durable allow. This lets a workspace pause, policy change, or other revocation stop an action before the external effect occurs.

## Canonical policy inputs

Workspace policy stays in the existing `workspaces/<id>/WORKSPACE.yaml` `approval` section. Operator-wide action policy may be stored locally in the user-owned, gitignored `automations/policies/action-permissions.yaml` file.

The three OS approval categories are:

- `external_actions`
- `destructive_actions`
- `high_stakes_decisions`

Each accepts `allow`, `confirm`, `human-review`, or `deny`. `confirm` and `human-review` both map to the host decision `approval_required`; Brain remains responsible for validating the exact explicit-user approval. `deny` is absolute. Unknown or malformed values fail closed.

If no operator policy file exists, safe defaults are:

```yaml
external_actions: confirm
destructive_actions: confirm
high_stakes_decisions: human-review
```

A workspace uses the same safe defaults for any omitted approval key. Operator and workspace values are intersected by strictness, so a permissive value at one scope cannot weaken a stricter value at the other.

Paused and archived workspaces deny execution.

## Action-class mapping

The OS applies the existing broad approval floors conservatively:

- `read_connected`, `external_write_reversible`, `send_message`, `publish_publicly`, `create_commit_or_pr`, and `merge_or_deploy` -> `external_actions`
- `spend_money` -> `external_actions` + `high_stakes_decisions`
- `delete_data` -> `destructive_actions`
- `change_permissions` and `security_sensitive` -> `destructive_actions` + `high_stakes_decisions`
- `high_stakes_domain_action` -> `high_stakes_decisions`
- `read_local`, `write_local_reversible`, and `modify_canonical_state` -> always `allow` from the OS, by design, as long as the OS can read its own state. The OS still denies every class, local included (fail closed), when the OS root is invalid, the operator policy file is malformed, the workspace manifest is invalid, or the workspace is paused or archived. The OS does not gate local reads, local writes or canonical edits. The agent host (Claude Code or Codex) permissions and sandbox control local work, and Brain policy may still deny or require approval

"Data write" is not an action class. The calling component (Brain or Data) chooses the class it sends, for example `external_write_reversible` or `delete_data`, and the OS gates by that class. This mapping is an outer check for outside actions, Data writes and deletions only, not a replacement for Brain's finer-grained action policy.

## Failure behavior

Once the request binding itself is valid, malformed or unavailable OS policy produces a bound `deny` response. Invalid request envelopes fail instead of manufacturing a decision for a different action. Workspace path traversal, symlink escape, ID mismatch, missing workspace state, incompatible OS layout, and malformed policy all fail closed.
