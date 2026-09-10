# Automation Policies

Policies define how automated execution is controlled.

Common concerns include approval, permissions, retries, rate limits, notification, external side effects, destructive actions, privacy boundaries, escalation, and kill switches.

High-stakes domains should use stricter policies than low-consequence internal tasks.

## Action permission policy

The optional local file `automations/policies/action-permissions.yaml` is the operator-wide OS permission floor used by `scripts/action-permission.mjs`. This directory is user-owned and gitignored, so changing local permission policy does not dirty the upstream OS checkout.

The file is deliberately small and strict:

```yaml
schema_version: "1.0"
approval:
  external_actions: "confirm"
  destructive_actions: "confirm"
  high_stakes_decisions: "human-review"
```

Each approval value must be exactly one of `allow`, `confirm`, `human-review`, or `deny`.

- `allow` means OS adds no stronger restriction; it never overrides another layer's denial.
- `confirm` and `human-review` mean an exact explicit-user approval is required by the execution layer.
- `deny` blocks the action.

If this file is absent, the example values above are the built-in safe defaults. If the file exists but is malformed, has unknown fields, duplicate fields, an unsupported schema version, or an unknown approval value, action permission fails closed.

Workspace-scoped actions also intersect this operator floor with `workspaces/<id>/WORKSPACE.yaml` `approval` values. Missing workspace approval keys use the same safe defaults, so a permissive operator setting cannot silently weaken a workspace that omitted a safety field.

See `system/architecture/action-permissions.md` for the action-class mapping and Brain/host intersection contract.
