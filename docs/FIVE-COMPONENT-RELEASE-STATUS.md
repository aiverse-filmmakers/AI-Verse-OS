# Five-Component Release Readiness Status

**Date:** 2026-09-12  
**Status:** OS, Brain, Memory and Skills release hardening is merged and green. Data PR #13 contains the completed repair set, but its private-repository GitHub Actions jobs are still failing before any runner step starts. The five-component beta must not be called green until Data actually executes and passes its checks.

## Canonical release architecture

See:

- `docs/FIVE-COMPONENT-RELEASE-PRD.md`
- `docs/SHIP-READINESS-AUDIT-2026-09-12.md`

The beta contract separates **package/runtime availability** from **attachment to one AI-Verse OS root**.

Core rules:

- optional components may be installed before or after OS;
- attaching to OS is explicit/idempotent and owned by the component;
- OS uses the local untracked `.aiverse/extensions/registry.json` as the native extension registration contract;
- registration never grants authority;
- optional-component absence is non-fatal;
- tracked OS files are not mutated by extension attachment;
- OS doctor/reconcile is read-only/plan-only for component-owned lifecycle mutations;
- install/update/disable/enable/detach/uninstall preserve canonical user state unless a separate destructive action is explicitly requested.

## Verified public components

### AI-Verse OS

Latest runtime-bearing release-hardening commit:

```text
603bc6575b689334b7896939fd5f89559845125f
```

All OS workflows passed after that runtime change. A later documentation-only commit does not alter runtime behavior.

Release-hardening includes:

- dynamic optional-component discovery;
- Brain host integration without a Skills source-checkout dependency;
- read-only Data routing through the OS permission boundary;
- component doctor/reconcile planning;
- symmetric OS <-> Brain direction ownership handover;
- canonical workspace scope validation matching `WORKSPACE.yaml` (`^[a-z0-9][a-z0-9-]*$`);
- shared extension-registry lock diagnosis without auto-stealing/deleting the lock.

### AI-Verse Brain

Main release revision:

```text
bef8261ad35d126d29aeff5d496f46904125b7b6
```

Post-merge workflows are green:

- CI — `34710865210`
- Skills Receipt Contract — `34710865215`
- OS Direction Ownership Contract — `34710865217`

Brain now:

- attaches through the local extension registry instead of tracked `AI-VERSE.yaml` edits;
- supports attach/disable/detach lifecycle;
- refuses detach while Brain owns strategic direction;
- supports explicit provenance-preserving Brain -> OS direction handback;
- enforces the same canonical workspace-id contract as OS/Data.

### AI-Verse Memory

Main release revision:

```text
f5b417f9e7ce1b3f05bc80d10a483d10f6ad10ee
```

Post-merge Test workflow:

```text
34709185500 — success
```

Memory now:

- uses the local extension registry;
- shares the registry locking discipline;
- supports safe enable/disable/detach;
- preserves canonical Memory;
- supports explicit standalone-Memory -> later-OS migration;
- no longer requires tracked OS registry/AGENTS edits.

### AI-Verse Skills

Main release revision:

```text
3ab838e6e64561bbb7cea8f85d0ebc75b9e84337
```

Post-merge Validate workflow:

```text
34709189075 — success
```

Skills now:

- exposes the provider-v1 installed runtime expected by OS;
- is discoverable from the external immutable provider root;
- no longer requires its source checkout for normal OS host execution;
- has current shipping/provider documentation and Windows launcher support.

## Data canonical release candidate

PR:

```text
AI-Verse-Data #13 — Fix post-release audit findings
branch: fix/post-release-audit
head: f791bba06d832c33c26ee36c9528e52b66c1ac8a
```

The branch is linear from `main` and is the only active Data hardening line.

Completed repair/hardening set:

- Apps cannot tunnel delete authority through transaction/bulk;
- Apps/Bots receipt provenance is limited to granted space/entity scope, and hidden-vs-nonexistent receipts return the same bounded denial so receipt existence is not leaked;
- Apps/Bots event pagination requires explicit authorized `spaceId + entity`, preventing hidden event activity leaking through shared pagination metadata;
- malformed App/Bot authority inputs map to stable adapter errors;
- secure Data client preserves the base client's trusted non-enumerable `scope`;
- Apps/Bots/Memory/Dashboard/Connections/Automation wrappers preserve live `closed` state;
- Memory evidence resolves real paginated events and never fabricates canonical-looking events;
- Memory supplied evidence is bound to the exact requested workspace/space/entity/record; all simultaneously supplied event/receipt/idempotency identifiers must agree, and the >200-event regression now truly forces a second provenance page;
- Dashboard cross-space references use schema `spaceId`;
- `records.list.cursor` is rejected instead of silently ignored;
- Connections/Automation malformed/error cases are hardened;
- native uninstall is rollback-safe;
- real `ai-verse-data-host/1.0` engine/session support replaces registration-only materialization;
- Data has explicit `enable`; install/update preserve `enabled:false`, while enable/disable change only Data availability;
- package-before-OS vs native attachment semantics are documented explicitly;
- release/install lifecycle docs are aligned with the real implementation.

## Five-component acceptance gate

Data PR #13 contains:

- `.github/workflows/five-component-acceptance.yml`
- `.github/workflows/release-smoke.yml`

The gate pins exact public runtime revisions:

```text
OS      603bc6575b689334b7896939fd5f89559845125f
Brain   bef8261ad35d126d29aeff5d496f46904125b7b6
Memory  f5b417f9e7ce1b3f05bc80d10a483d10f6ad10ee
Skills  3ab838e6e64561bbb7cea8f85d0ebc75b9e84337
```

It is designed to prove:

- representative optional-component install orders;
- host config created before optional components exist;
- late Memory/Skills/Data/Connections discovery without regenerating host config;
- Memory recall;
- immutable Skills resolution;
- read-only structured Data query routing;
- Data disable -> update remains disabled -> explicit enable -> same host regains Data with preserved records;
- OS -> Brain strategic handover;
- detach blocked while Brain owns direction;
- Brain -> OS export/handback;
- Memory/Data/Brain detach/uninstall and reattach/reinstall with canonical state preserved;
- final component doctors;
- no tracked OS mutation.

## Current Data Actions blocker

Latest PR-head workflow runs:

```text
Release Smoke                     34716477876
CI                                34716477906
Five-Component Release Acceptance 34716477914
```

Observed result:

```text
10 / 10 jobs -> failure before step 1
steps: null
no checkout
no setup
no build/test logs
```

This includes Linux, macOS and Windows jobs and a deliberately minimal one-job Ubuntu smoke workflow.

Historical Data main run `34695862605` also shows the same infrastructure pattern beginning mid-matrix:

- 5 jobs executed every install/build/test/package/CLI step successfully;
- Ubuntu Node 22 terminated before any step with `steps: null`.

Therefore the current red checks are not evidence of a deterministic Data code/test failure. They are also not a substitute for passing tests.

## Merge/release gate

**Do not merge Data PR #13 and do not announce/tag the five-component beta until:**

1. GitHub actually starts the Data jobs;
2. current Data `npm run check` passes;
3. Data package/CLI release smoke passes;
4. Five-Component Release Acceptance executes and passes;
5. Data #13 is merged;
6. Data post-merge `main` CI executes and passes;
7. exact five release revisions/tags are frozen;
8. member install documentation points at immutable release refs rather than moving `main`.

## Product/legal/admin decisions intentionally not guessed

These are not code defects and must remain explicit owner decisions:

- Data is private and currently `UNLICENSED`; choose its member distribution/access/license policy before public redistribution.
- AI-Verse-Skills needs an explicit first-party/top-level distribution/license decision in addition to per-package third-party notices.
- Required checks / branch protection need repository administration access and should be enabled for release branches.
- GitHub Actions billing/quota/payment eligibility for the private Data repository must be checked in account/repository billing settings; the connector cannot read that account state.

## Current verdict

- **OS:** release-hardening code ready; green.
- **Brain:** release-hardening code ready; green.
- **Memory:** release-hardening code ready; green.
- **Skills:** release-hardening code ready; green.
- **Data:** repair implementation complete and statically reviewed; **execution verification blocked externally**.
- **Five-component beta:** architecture/code hardening is effectively complete, but final release remains blocked by the Data runner gate.
