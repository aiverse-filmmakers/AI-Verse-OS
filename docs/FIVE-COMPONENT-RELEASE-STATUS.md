# Five-Component Release Readiness Status

**Date:** 2026-09-12  
**Status:** Release hardening implemented for OS, Brain, Memory and Skills; Data verification is the only remaining technical gate.

## Canonical architecture

See:

- `docs/FIVE-COMPONENT-RELEASE-PRD.md`
- `docs/SHIP-READINESS-AUDIT-2026-09-12.md`

The beta contract separates package/runtime availability from attachment to an OS root. Optional components do not gain authority from installation order and do not mutate tracked OS files.

## Verified merged components

### AI-Verse OS

Main revision:

```text
a076fe730b2e53919c7be9ed6f359b04e795c6bf
```

Post-merge push checks all passed:

- Direction Ownership — `34709177936`
- OS Write Command Boundary — `34709177967`
- OS Brain Permission Contract — `34709178119`
- Repository QC — `34709178037`
- Four Repo Acceptance — `34709177959`
- CLI smoke test — `34709177927`

Release-hardening behavior includes the dynamic optional-component host, real bounded Connections metadata, read-only Data routing, component doctor/reconcile planning and the symmetric direction-ownership contract.

### AI-Verse Brain

Main revision:

```text
9ca1b5d5103e68b85d170660ffea85669533b41a
```

Post-merge push checks all passed:

- Skills Receipt Contract — `34709181223`
- OS Direction Ownership Contract — `34709181216`
- CI — `34709181210`

Brain now attaches through `.aiverse/extensions/registry.json`, can be enabled/disabled/detached without tracked OS edits, blocks detach while Brain owns strategic direction, and supports explicit provenance-preserving Brain -> OS direction handback before removal.

### AI-Verse Memory

Main revision:

```text
f5b417f9e7ce1b3f05bc80d10a483d10f6ad10ee
```

Post-merge Test workflow passed:

```text
34709185500
```

Memory now shares the local extension-registry locking contract, supports safe enable/disable/detach, preserves canonical Memory, and supports explicit migration from a standalone Memory project into an OS installed later in a clean root.

### AI-Verse Skills

Main revision:

```text
3ab838e6e64561bbb7cea8f85d0ebc75b9e84337
```

Post-merge Validate workflow passed:

```text
34709189075
```

Provider-v1 shipping docs are current, the OS host needs only the installed immutable provider rather than a Skills source checkout, and Windows has a PowerShell launcher.

## Data release candidate

Canonical PR:

```text
AI-Verse-Data #13 — Fix post-release audit findings
branch: fix/post-release-audit
```

The branch contains the post-release security/correctness repairs plus:

- supported AI-Verse OS Data engine/session bridge;
- uninstall rollback;
- strict Apps/Bots provenance boundaries;
- real Memory event evidence lookup;
- Dashboard cross-space reference repair;
- explicit list cursor rejection;
- stable malformed-authority errors;
- pinned five-component release acceptance matrix;
- single-job Data release smoke workflow.

The five-component gate is pinned to the exact four verified public revisions listed above and tests representative install orders, late optional-component discovery, Memory recall, Skills resolution, Connections metadata, Data reads, direction handback, detach/reinstall and canonical-state preservation.

## Current Data CI blocker

Fresh GitHub Actions jobs in the private Data repository are currently terminating before a runner starts:

```text
steps: null
no checkout
no setup
no logs
```

This affects:

- normal six-job Data CI;
- the three-order Five-Component Release Acceptance;
- a deliberately minimal one-job Ubuntu Release Smoke.

Because no workflow step executes, these failures are not code/test failure evidence.

A previously successful Data baseline remains:

```text
main: 2497b54e5fbdf0fec4621d218302b3df30dbbc03
CI: 34695862605
```

The current Data repair must **not** be merged until an actual runner executes `npm run check` and the release gate.

## Final release gate

Do not announce/tag the five-component beta until:

1. Data PR #13 receives a real executed green `npm run check`;
2. the Five-Component Release Acceptance actually executes and passes;
3. Data #13 is merged;
4. Data post-merge main CI passes;
5. exact five release revisions are frozen;
6. member install documentation is pinned to immutable tags/refs.

## Owner decisions intentionally not guessed by implementation

These are product/legal/repository-administration choices, not code defects:

- Data is currently private and `UNLICENSED`; decide the member distribution/access/license policy before public redistribution.
- AI-Verse-Skills has no top-level first-party license; decide its first-party license before public redistribution.
- Main-branch protection/required-check policy requires repository administration access and should be enabled for release branches.

No implementation should silently choose these policies on behalf of the owner.
