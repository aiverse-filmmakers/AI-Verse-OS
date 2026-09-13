# OS Write Command Boundary

AI-Verse OS owns canonical operator/workspace host state. Extensions and intelligence layers request OS-owned writes through this boundary rather than editing canonical files directly.

## Public-beta commands

```text
node scripts/write-command.mjs enqueue --root <ai-verse-os-root>
node scripts/write-command.mjs dispatch --root <ai-verse-os-root>
node scripts/write-command.mjs submit --root <ai-verse-os-root>
```

Each command accepts one immutable JSON request on stdin and returns one JSON receipt on stdout.

The request contains:

- `schema_version`
- `request_id`
- `scope`: `operator` or `workspace:<id>`
- symbolic `operation`
- bounded structured `parameters`
- `idempotency_key`
- `requested_by`
- `reason`
- `created_at`
- bounded `provenance`
- SHA-256 `request_fingerprint` over the exact immutable request

## Enqueue remains transport-only

`enqueue` preserves the Phase 3.7 compatibility contract. It validates the host, request, scope, fingerprint and current OS permission floor, then writes only disposable runtime state under:

```text
runtime/write-commands/
  queue/
  receipts/
```

Its receipt reports that no canonical effect occurred.

An enqueue receipt is never permission to perform a later canonical mutation.

## Dispatch and submit

`dispatch` consumes an already queued command. `submit` performs enqueue followed by dispatch.

Before a canonical effect, dispatch re-checks the current action permission at the final edge. A workspace that became paused, a changed policy, or another current denial blocks the effect even if enqueue previously succeeded.

The final-edge action is classified as `modify_canonical_state`, not as a disposable runtime write.

## Current canonical handler

Public-beta OS registers exactly one canonical handler:

```text
candidate.route
```

It may write only to the OS-owned unclassified inbox for the request scope:

```text
operator/inbox/
workspaces/<id>/inbox/
```

The routed record remains explicitly:

```text
canonical_owner: ai-verse-os
canonical_layer: inbox
status: unclassified
promotion_occurred: false
```

Receipt is not validation.

The handler does not promote material into:

- operator/workspace current context
- Knowledge
- Decisions
- Brain goals or strategy
- Memory
- Data
- Skills
- Connections
- Automations

Those owners retain their own canonical mutation, provenance, authorization, migration and idempotency rules.

Unknown operations fail closed before canonical mutation.

## Idempotency

The pair `scope + idempotency_key` is bound to one exact request fingerprint.

- identical enqueue replay returns the same command/receipt
- semantic drift with the same idempotency key fails
- duplicate dispatch of a completed request returns the completed receipt
- the canonical inbox filename is deterministic from the request binding
- an existing canonical idempotency record with a different fingerprint fails closed

The runtime queue remains disposable. Canonical inbox completion therefore has its own durable idempotency check at the actual owner boundary.

## Permission

Enqueue is `write_local_reversible` because it writes only disposable runtime state.

Dispatch re-evaluates permission as `modify_canonical_state` immediately before the OS-owned inbox effect.

Permission response fingerprints and scopes must match the exact immutable command.

## Security

The boundary rejects:

- incompatible OS roots
- inactive workspace scopes
- malformed or unknown request fields
- invalid operation/IDs
- oversized or deeply nested parameters
- invalid or forged fingerprints
- unsafe runtime or inbox symlinks
- malformed/incomplete idempotency records
- unsupported canonical operations
- final-edge permission denial

The request parameters are bounded symbolic structured data, not arbitrary filesystem paths supplied to a generic OS write primitive.
