# AI-Verse Shipping Readiness Audit

**Date:** 2026-09-12  
**Status:** In progress  
**Scope:** AI-Verse OS, Brain, Memory, Data, Skills  
**Goal:** Decide whether the finished components are ready for member shipping and make installation/reinstallation/order as future-proof as practical.

## Audited revisions

- AI-Verse OS main: `d04f9eee5e195b85843c7206d09dc86d4335784d`
- AI-Verse Brain main: `0ad15248b377771194b49403f8afb4973d6d7a7a`
- AI-Verse Memory main: `65c4ad09cb29382aaebda47164440da321caf517`
- AI-Verse Data main: `2497b54e5fbdf0fec4621d218302b3df30dbbc03`
- AI-Verse Skills main: `741f055e8e127e61ccaf0f450c7cf83df2a9a6b6`
- Data audit repair PR #13 head: `695dd9b4af9b5edfda567627eb036fc176e0bbc9`

## Current high-level verdict

The core architecture is strong enough to ship after a focused integration/lifecycle hardening pass. The main remaining risks are not fundamental engine design. They are cross-repository version skew, install/attach semantics, stale docs/health checks, lifecycle ownership, and acceptance tests that currently prepare the environment in ways a normal member installer does not.

## Findings recorded so far

### OS

- Current main CI is green across Repository QC, Direction Ownership, OS Brain Permission Contract, OS Write Command Boundary, Four Repo Acceptance, and Data Host Boundary.
- The local extension contract under `.aiverse/extensions/registry.json` is the correct long-term optional-extension boundary.
- OS correctly keeps local extension state gitignored.
- Main is currently unprotected, so green CI is not enforced before direct pushes.
- The current four-repo acceptance does not include Data.
- The current four-repo acceptance patches `AI-VERSE.yaml` to insert Brain support before Brain initializes, so it proves prepared composition rather than the exact member install path.

### Brain

- Core Brain tests and release CI are green on current main.
- Brain correctly refuses to silently create a parallel native store on incompatible OS hosts.
- Native writes require an explicit Brain registration and installation marker.
- Release blocker: stock current OS has no `extensions.brain` entry, while Brain intentionally refuses to patch `AI-VERSE.yaml`. A member installing Brain into stock OS therefore hits a native initialization blocker.
- Brain's supported full OS host adapter currently depends on paths to both an installed Skills root and the Skills repository installer entrypoint. This unnecessarily couples runtime use to retaining a Skills source checkout.
- Brain currently uses a special `AI-VERSE.yaml` extension slot model while Memory/Data use the local extension registry. This is an extension-generation mismatch that should be unified or explicitly justified.

### Memory

- Core Memory CI is green on Linux/macOS/Windows and native installation currently preserves tracked OS files.
- Current installer correctly registers Memory in `.aiverse/extensions/registry.json` and can migrate exact legacy edits out of tracked OS files.
- Workspace/source isolation and native path protections are strong.
- README is stale and still claims native installation writes `skills/registry.yaml` and `AGENTS.md`.
- Native `doctor` is stale too: it still checks for the old `skills/registry.yaml` registration and old Memory marker in `AGENTS.md`, even though the installer has moved to the local extension registry.
- Memory has no clear detach/uninstall lifecycle command comparable to Data/Skills.
- Installing Memory before OS currently selects standalone mode. There is no general later "attach this existing standalone installation to newly installed OS" lifecycle yet.

### Skills

- Core registry validation is green on current main.
- The provider-v1 implementation is real: immutable generations, capability index, OS scoped discovery, generation pinning, receipt semantics, and readiness v2 exist.
- Some shipping/project-state docs are stale and still claim OS provider discovery is not implemented.
- Skills is naturally order-independent because it installs externally under `~/.aiverse/skills/`; OS can discover it later without Skills mutating the OS tree.
- The full networked E2E install workflow is path/schedule-triggered and should be checked as part of release evidence for the exact release revision.
- Some third-party sources remain marked `upstream-package` / `per-package-verify`; redistribution/legal review remains a release consideration independent of runtime correctness.

### Data

- Data main's original release CI is green, but main still contains the issues found in the previous deep audit.
- Audit repair PR #13 contains targeted fixes for Apps delete tunneling, App/Bot provenance scope, Memory fake/limited event lookup, Dashboard cross-space references, cursor handling, uninstall rollback, malformed authority inputs, stale release metadata, and an OS host engine/session bridge.
- Data PR #13 is not merged and its CI currently fails before executing runner steps; therefore repaired Data is not yet verified.
- Data PR #12 is a separate older hardening branch and has diverged from PR #13. The two repair lines need consolidation rather than both being kept alive.
- Data main remains `0.1.0-alpha.0` and `UNLICENSED`, so it should not be presented as a finalized public/member release until version/license intent is resolved.
- Data's architecture already explicitly requires sibling-independent install order and local extension registry coexistence.

## Installation-order conclusion so far

Arbitrary install order is possible, but it should not be implemented as a combinatorial matrix of every sequence.

The future-proof model should distinguish:

```text
package installed
!= attached to OS
!= registered with OS
!= enabled
!= healthy
!= workspace initialized
!= authorized
```

Desired lifecycle:

```text
component installed
    |
    +-- compatible OS exists -> attach/register safely
    |
    +-- no OS exists -> remain standalone/external/unattached

OS appears later
    -> reconcile installed components
    -> attach compatible components
    -> preserve standalone data until deliberate migration
```

This allows:

- Memory before OS
- Brain before OS
- Skills before OS
- Data before OS
- OS before any/all components
- reinstall after uninstall
- independent upgrades
- optional absence of siblings

without relying on install chronology for correctness.

## Major architectural action likely required

Introduce one OS-owned reconciliation/attachment contract for optional components.

Candidate direction:

- local extension registry remains the attachment registry;
- OS owns reconciliation, discovery, compatibility checks and permission floors;
- each component owns its package/runtime and canonical component state;
- installers may attach when a compatible OS is present, but must not require it;
- OS doctor/reconcile can discover installed-but-unattached components and offer/perform safe attachment;
- missing siblings are capability absence, not corruption;
- incompatible versions fail closed with actionable diagnostics;
- uninstall/detach never deletes canonical user state by default.

Brain should likely converge onto this model rather than requiring a tracked `AI-VERSE.yaml` edit solely for installation readiness.

## Remaining audit work

1. Finish lifecycle review for install/update/detach/uninstall/reinstall across all five.
2. Check stale-version compatibility and downgrade behavior.
3. Check extension registry convergence and collision behavior.
4. Verify exact current release/E2E evidence, not only old pinned commits.
5. Design a five-component acceptance matrix including Data.
6. Check first-install UX and commands from a clean member machine.
7. Check upgrade UX from one released generation to the next.
8. Check whether all optional components can be absent without false doctor failures.
9. Produce final verdict split into:
   - MUST FIX BEFORE SHIPPING
   - SHOULD FIX SOON
   - SAFE TO DEFER
   - SHIP-READY AFTER FIXES

## Additional findings from lifecycle/release audit

### Install-order mechanics

- True "component initialized first, OS installed later into the same root" is not supported today. `ai-verse-os install` refuses any non-empty target directory.
- Brain initialized standalone creates `.ai-verse-brain/`; if that directory later appears inside a native OS root, Brain treats it as a parallel-store blocker. There is no supported standalone-Brain -> native-Brain migration/attach path.
- Memory installed without OS immediately creates standalone state. Memory does have a legacy migration command once a native OS exists, but there is no end-to-end OS-later reconciliation flow.
- Skills is the strongest order-independent component because it is external and passively discoverable.
- Data package availability can precede OS, but native Data attachment requires a compatible OS root; package installation and OS attachment therefore need to remain separate concepts.

### Brain lifecycle safety

- There is no supported Brain detach/uninstall lifecycle.
- Strategic direction handover is currently one-way: OS -> Brain exists, but Brain -> OS handback does not.
- If Brain owns a scope and the Brain package/runtime is later removed, the OS intentionally refuses to fall back to frozen strategy. This is safe fail-closed behavior but leaves strategic writes unavailable until a future ownership-transfer mechanism exists.
- A shippable Brain lifecycle therefore needs either a deliberate `handover-to-os`/detach path or an uninstall blocker that refuses removal while any scope is Brain-owned.

### Brain registration / OS update conflict

- The current CI workaround inserts `extensions.brain` into tracked `AI-VERSE.yaml`.
- A real user doing the same would make `ai-verse-os update` refuse to run because the updater blocks on tracked system-file changes.
- Brain installation readiness must therefore not depend on member edits to tracked `AI-VERSE.yaml`.

### Shared extension registry

- Sequential Memory <-> Data installation preserves sibling entries.
- Data implements an explicit registry lock/lost-update check; Memory currently performs atomic replacement but does not use the same shared registry lock. Concurrent installers can therefore race.
- A future-proof ecosystem should expose one OS-owned registry mutation helper/contract rather than letting every extension invent its own concurrency semantics.
- OS `doctor` currently validates core OS files but does not perform a system-wide extension registry/engine health check or reconcile installed-but-unattached components.

### Runtime composition

- Data's repository implements a read-only `createBrainDataAdapter`, but Brain's live `HostAdapter` / JSON bridge has no structured-data retrieval operation.
- The maintained OS Brain host adapter provides context, Memory history, Skills capabilities, connections, permissions and a narrow capability execution path, but does not expose Data answers to Brain.
- Therefore Data and Brain safely coexist, but current supported five-component runtime composition does not yet let Brain query Data through its normal host context path.
- Data -> Memory is also contract-ready on the Data side but not a full consumer integration where Memory automatically participates in Data evidence. This is safer than duplication, but it should not be described as complete bidirectional integration.

### Release reproducibility

- None of OS, Brain, Memory, Data or Skills currently has a Git tag.
- Brain documentation advertises `v0.1.0-beta.1`, but that tag does not exist, so the documented release install command is broken.
- OS, Memory, Skills and Data development install paths mostly follow moving `main`; a member release should pin immutable tags/SHAs.
- Current four-repo acceptance pins runtime revisions that are effectively current for Brain and Skills except for later documentation-only commits, so the runtime proof is still useful, but it is not a substitute for release tags.

### Distribution and platform UX

- Data is currently a private repository and `UNLICENSED`; the documented GitHub install route is not a general member distribution route unless members receive repository/package access.
- AI-Verse-Skills has no top-level LICENSE file. Third-party notices exist, but the first-party distribution/installer itself has no clear repository license.
- Skills README tells users to run `./aiverse-skills`, a POSIX shell launcher. The Python installer is portable, but that advertised command is not a native Windows PowerShell/CMD experience. A Windows wrapper or a package/entrypoint should be added if Windows is a supported member platform.

### Repository governance / housekeeping

- All five current `main` branches are unprotected; required green CI is not enforced before direct pushes.
- OS still has stale open PR #8 even though a four-repo acceptance implementation is already on main.
- Data has two divergent draft hardening PRs (#12 and #13) for overlapping audit work. They should be reconciled to one canonical repair line before merge/release.
