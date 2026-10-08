# Purpose Context v1

Purpose Context is a read-only, scope-bound projection that answers why the current work matters, where the scope is going, and how current work connects to strategic direction.

## Ownership

Purpose Context is not a canonical store. It does not own mission, goals, strategy, KPI truth, history, or operational state.

- OS owns scope identity, current-context resolution, and the projection surface.
- Strategic semantics come only from the declared strategic direction owner.
- When OS owns direction, the projection uses the ownership-aware OS current-context read.
- When Brain owns direction, callers must supply Brain's public Purpose snapshot read. OS must never parse Brain private storage or substitute frozen OS strategy when that read is unavailable.
- Data-owned current values remain canonical in Data. Purpose may carry only transient scalar/status projections with exact Data refs, owner timestamps, and provenance. Neither OS nor Brain may persist or promote copied Data rows as canonical Purpose/current-state truth.
- Memory composition must continue to use public owner reads and preserve provenance.

### Initiative operational status boundary

Brain's canonical initiative object already owns the current initiative lifecycle status when Brain owns strategic direction. The public Brain Purpose snapshot carries that status on each current initiative, and OS projects the same owner-backed object under `initiatives` without translating or copying the status into a second domain.

Purpose must not create `initiative_operational_status`, `project_operational_status`, or a Dashboard/OS status store that can drift from Brain. When a distinct project/initiative operational owner is introduced in the future, it must enter through an explicit owner contract rather than being inferred from generic Data rows or current-context prose.

### Data current-value boundary

Phase 5.1 freezes the following ownership rule before full current-state composition:

- canonical current measured values remain owned by `ai-verse-data`;
- OS may accept only bounded transient `value`, `stale`, or `missing` projections from the Data Purpose read surface;
- every retained current value keeps its exact `ai-verse-data` source ref;
- `0`, `false`, and `null` are legitimate present values and are never converted to missing state by truthiness;
- freshness evidence comes from the canonical Data record timestamp, not projection/query execution time;
- raw Data rows and row metadata such as `data`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, or deletion metadata must not cross the Purpose boundary;
- transient Data projections must not be written into OS current-context files, Brain strategic objects, Purpose caches, or any other canonical store;
- full Purpose current-state composition and Data outage behavior remain Slice 5.2 work.

## Scope

Supported scopes are exactly:

- `operator`
- `workspace:<id>`

Scope resolution uses canonical OS validation and physical workspace boundaries. Cross-workspace scanning is not part of v1.

## Profiles

Workspace projection profiles are runtime read behavior, not persisted workspace authority or configuration.

- accepted caller requests are `auto`, `basic`, and `rich`;
- operator scope resolves to `operator_default` and does not accept workspace `basic`/`rich` labels;
- workspace `auto` begins at `workspace_basic` and resolves to `workspace_rich` only when a rich-only domain is both owner-backed and relevant/requested;
- workspace type, name, age, perceived importance, free-text purpose, file count, and unused byte budget cannot select rich mode by themselves;
- `basic` suppresses rich-only narratives, KPIs, and optional owner-backed domains while retaining required truth-state/provenance diagnostics;
- `rich` only broadens the eligible read set and cannot fabricate unavailable data or bypass owner authority;
- profile selection may be reported under `provenance.profile` as non-authoritative diagnostics.

Slice 2.3 explicitly froze that v1 does **not** add or read a `purpose_context` profile/configuration block in `WORKSPACE.yaml`. Caller profile flags and deterministic auto-resolution are the only v1 selection inputs. Unknown workspace metadata cannot silently enable, disable, or enrich Purpose Context.

## Public surfaces

Library:

```js
composePurposeContext(root, scope, options)
composeProfiledPurposeContext(root, scope, options)
```

CLI:

```bash
node scripts/purpose-context.mjs read --scope operator
node scripts/purpose-context.mjs read --scope workspace:ai-verse --profile auto
node scripts/purpose-context.mjs read --scope workspace:ai-verse --profile rich --relevant-domain kpis
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
