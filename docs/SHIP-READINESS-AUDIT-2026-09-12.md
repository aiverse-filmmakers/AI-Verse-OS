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
