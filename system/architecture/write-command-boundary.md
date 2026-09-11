# OS Write Command Boundary

AI-Verse OS owns canonical operator/workspace state. Extensions and intelligence layers must request writes through an owner-controlled command boundary rather than directly editing canonical files.

## Phase 3.7 contract

The OS command is:

```text
node scripts/write-command.mjs enqueue --root <ai-verse-os-root>
```

It accepts one immutable JSON request on stdin and returns one JSON receipt on stdout.

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

## What Phase 3.7 does

Phase 3.7 validates the host, exact scope, bounded request shape, fingerprint and OS action-permission floor, then places the command into OS-owned disposable runtime state under:

```text
runtime/write-commands/
  queue/
  receipts/
```

The receipt explicitly reports:

```json
{
  "status": "queued",
  "effect_occurred": false,
  "canonical_effect_occurred": false,
  "result": {
    "queue_state": "pending_handler",
    "canonical_handler_dispatched": false
  }
}
```

This is transport and ownership enforcement only.

## What Phase 3.7 does not do

The dispatcher does not directly mutate:

- operator profile
- current context
- knowledge
- decisions
- Memory
- Skills
- Automations
- connection state
- Brain-owned state

Knowledge/decision candidate routing and canonical promotion are later integration work. A future handler must re-check the exact current owner/policy/approval state immediately before any canonical mutation.

## Idempotency

The pair `scope + idempotency_key` is bound to one exact request fingerprint.

- identical replay returns the same command/receipt
- semantic drift with the same idempotency key fails
- concurrent duplicate enqueue cannot silently create two commands

Runtime state is deliberately disposable. Future canonical handlers must therefore also enforce their own durable idempotency at the actual owner write boundary.

## Permission

The enqueue operation is classified as `write_local_reversible` because Phase 3.7 produces only disposable OS runtime state.

The OS action-permission evaluator is still invoked at enqueue time so invalid, paused or out-of-scope workspace requests fail closed.

A future canonical handler must separately evaluate the appropriate canonical-state action immediately before the effect. An enqueue receipt is never permission to perform the later canonical mutation.

## Security

The boundary rejects:

- incompatible OS roots
- inactive workspace scopes
- malformed or unknown request fields
- invalid operation/IDs
- oversized or deeply nested parameters
- invalid or forged fingerprints
- unsafe runtime symlinks
- malformed/incomplete idempotency records

The request parameters are symbolic structured data, not arbitrary filesystem paths supplied to an OS write primitive.
