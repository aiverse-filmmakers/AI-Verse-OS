# Purpose Context v1

Purpose Context is a read-only, scope-bound projection that answers why the current work matters, where the scope is going, and how current work connects to strategic direction.

## Ownership

Purpose Context is not a canonical store. It does not own mission, goals, strategy, KPI truth, history, or operational state.

- OS owns scope identity, current-context resolution, and the projection surface.
- Strategic semantics come only from the declared strategic direction owner.
- When OS owns direction, the projection uses the ownership-aware OS current-context read.
- When Brain owns direction, callers must supply Brain's public Purpose snapshot read. OS must never parse Brain private storage or substitute frozen OS strategy when that read is unavailable.
- Later Data and Memory composition must continue to use public owner reads and preserve their provenance.

## Scope

Supported scopes are exactly:

- `operator`
- `workspace:<id>`

Scope resolution uses canonical OS validation and physical workspace boundaries. Cross-workspace scanning is not part of v1.

## Public surfaces

Library:

```js
composePurposeContext(root, scope, options)
```

CLI:

```bash
node scripts/purpose-context.mjs read --scope operator
node scripts/purpose-context.mjs read --scope workspace:ai-verse
```

The CLI is read-only. It creates no Purpose state or cache. If Brain owns direction and no Brain public reader is available in the calling runtime, the projection fails closed with explicit unavailable strategic-direction state rather than reading Brain internals or falling back to stale OS strategy.

## Stability and budget

- schema version: `1.0`
- default serialized UTF-8 budget: 16,384 bytes
- accepted caller budget: 4,096 to 65,536 bytes
- owner/API arrival order does not define semantic order
- deterministic section caps and pruning enforce the budget
- truncation is explicit in `provenance.budget`
- exact canonical owner refs are preserved for retained claims

## Rebuildability

Purpose output is disposable. Deleting a rendered projection changes no canonical owner state. Re-reading after deletion or process restart reconstructs the projection from current owner reads. Direct owner mutations are visible on the next read because v1 has no Purpose cache.

## Authority and failure behavior

Purpose Context grants no write authority. Durable strategic mutations remain routed to the canonical owner and its confirmation rules.

Malformed scope or ownership records fail closed. Brain-owner unavailability is represented explicitly and must never resurrect frozen OS strategic content.
