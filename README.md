# AI-Verse OS

**AI-Verse OS** is the host constitution for AI-Verse. It owns workspace scope, host structure, current operating context, routing, permission floors, and component composition. It does not take canonical Brain, Memory, Data, Skills, Connections, or automation state away from their owning components.

**AI-Verse Community:** https://www.skool.com/bogdans-ai-verse-4398

## Install

Requirements:

- Git
- Node.js 22+ for the complete five-component beta
- Python when optional Python components are used
- macOS, Linux, or Windows

Install the current OS development/public-beta candidate:

```bash
npx --yes github:aiverse-filmmakers/AI-Verse-OS install
```

Or install the command globally:

```bash
npm install -g github:aiverse-filmmakers/AI-Verse-OS
ai-verse-os install
```

Installation only makes the OS runtime available. It does **not** attach sibling components, initialize their canonical stores, transfer Brain authority, authorize external accounts, or grant broader permissions.

The previously frozen five-component first-member beta remains reproducible from exact immutable refs:

- [Five-Component First Member Beta Install](docs/FIVE-COMPONENT-BETA-INSTALL.md)
- [Five-Component Release Status](docs/FIVE-COMPONENT-RELEASE-STATUS.md)

Do not substitute moving `main` branches when reproducing that frozen gate.

## Setup

After installation:

```bash
ai-verse-os setup --dir ./AI-Verse-OS
```

The default `detected` profile configures the OS and reconciles only components actually detected around that OS root. Optional absent components do not make a standalone OS unhealthy.

To require the complete core composition:

```bash
ai-verse-os setup --dir ./AI-Verse-OS --profile core
```

`core` means:

```text
OS + Brain + Memory + Skills + Data
```

Setup is explicit and idempotent. It records local setup state under `.aiverse/os/`, which is ignored by Git so normal updates do not dirty tracked OS files.

OS setup may execute only a narrowly allowlisted owner command when the owner contract is known and safe. It never fabricates sibling lifecycle metadata. When a component requires its own migration or setup command, OS reports the exact owner action instead of stealing ownership.

Useful component lifecycle commands:

```bash
ai-verse-os components status --json
ai-verse-os components doctor --json
ai-verse-os components reconcile --json
ai-verse-os components reconcile --apply --json
ai-verse-os components descriptor brain --json
```

## Verify

Fast status:

```bash
ai-verse-os status --dir ./AI-Verse-OS
```

Deeper read-only verification:

```bash
ai-verse-os doctor --dir ./AI-Verse-OS
```

Require the complete core profile:

```bash
ai-verse-os status --dir ./AI-Verse-OS --profile core
ai-verse-os doctor --dir ./AI-Verse-OS --profile core
```

All public lifecycle surfaces support machine-readable output:

```bash
ai-verse-os status --json
ai-verse-os doctor --json
ai-verse-os setup --json
ai-verse-os update --json
ai-verse-os descriptor --json
ai-verse-os components status --json
ai-verse-os components doctor --json
ai-verse-os components descriptor brain --json
```

Public lifecycle states are:

```text
absent
installed
setup-required
disabled
unhealthy
migration-required
ready
```

The OS doctor states the depth it actually checked. It covers structural, setup, attachment/discovery, runtime, dependency, and composed-system readiness. It does not claim owner-specific operational checks that it did not execute.

Lifecycle exit behavior is stable:

- `0`: command succeeded and the requested readiness target is satisfied
- `2`: valid command, but the requested component/profile is not ready
- `1`: invalid invocation or an unexpected lifecycle failure

Descriptors are introspection surfaces and return successfully even when the described component is absent or not ready.

## Use

After `setup` and a green `doctor`:

```bash
ai-verse-os onboard
```

This opens the first-use handoff. In the supported capable AI runtime, start with a real request. AI-Verse learns missing context progressively and asks only when information is actually needed for safe/correct work. The existing seven-question intake remains available when you deliberately want a full intake.

Core OS capabilities include:

- `/onboard`
- `/workspace`
- `/grill-me`
- `/link`
- `/audit`
- `/level-up`
- `/3d-brain`

### Owner-routed write boundary

Extensions and coordination layers do not receive a generic primitive that edits canonical OS files.

The compatibility transport command remains:

```bash
node scripts/write-command.mjs enqueue --root <OS_ROOT> < request.json
```

It queues a bounded request and reports that no canonical effect occurred.

Public-beta OS also supports:

```bash
node scripts/write-command.mjs submit --root <OS_ROOT> < request.json
node scripts/write-command.mjs dispatch --root <OS_ROOT> < request.json
```

At the current OS boundary, the only canonical handler is the OS-owned `candidate.route` operation. It re-checks current permission at the final effect edge and places the candidate into the appropriate operator/workspace inbox as **unclassified material**.

It does not automatically promote the candidate into Knowledge, Decisions, Memory, Data, Skills, Brain, Connections, or Automations. Those owners retain their own canonical write rules.

## Update / disable / uninstall

Update tracked OS runtime files without touching ignored user-owned state:

```bash
ai-verse-os update --dir ./AI-Verse-OS
```

If tracked OS files need to be restored deliberately:

```bash
ai-verse-os reinstall --force --dir ./AI-Verse-OS
```

Reinstall restores tracked runtime files from `origin/main` while preserving ignored canonical user state, component attachment state, and `.aiverse/os/setup.json`.

AI-Verse OS itself has no meaningful enabled/disabled toggle in the public beta. Optional components expose enable/disable through their own lifecycle where meaningful.

The CLI does not recursively delete an OS root because that root may contain canonical user-owned state. Removing the OS directory is therefore an explicit operator/distribution action after preserving the user-owned paths you intend to keep. Destructive purge is not part of normal uninstall semantics.

## What setup grants / does not grant

OS setup grants only enough local host configuration to verify and compose the selected profile.

It does **not** grant:

- Brain strategic direction ownership
- permission to write canonical Memory
- permission to create or mutate Data records
- permission to execute arbitrary Skills
- external account authorization
- connection credentials
- broader action permissions
- destructive migration authority
- cross-workspace visibility
- hosted/team identity or RBAC

Registration, readiness, authorization, approval, and authority are separate concepts.

## Architecture

AI-Verse OS v2 uses the Unified Workspace Architecture.

The machine-readable map is `AI-VERSE.yaml`. Detailed architecture lives in `system/architecture/`.

The core rules are:

1. one canonical owner for each responsibility;
2. operator and workspace scope remain explicit;
3. user-owned state is preserved across normal OS lifecycle operations;
4. optional components add capability without becoming hidden duplicate truth;
5. derived indexes, dashboards, caches, and reports are not canonical merely because they are convenient.

## System versus user ownership

System-owned tracked OS material includes:

```text
AGENTS.md
CLAUDE.md
AI-VERSE.yaml
system/
skills/registry.yaml
.claude/skills/
.agents/skills/
scripts/
```

User-owned state includes:

```text
operator/
knowledge/
workspaces/
connections/registry.yaml
agents/registry.yaml
automations/jobs/
automations/triggers/
automations/policies/
apps/
```

Local lifecycle/attachment state under `.aiverse/` is intentionally outside tracked upstream system files.

`runtime/` is derived/disposable. If deleting runtime destroys irreplaceable truth, that truth is in the wrong layer.

## Source of truth

At a high level:

- `AGENTS.md` owns runtime behavior
- `AI-VERSE.yaml` owns architecture and routing declarations
- owner/workspace current context owns current OS state while OS owns that scope
- Brain-owned direction wins only after explicit handover
- Memory owns historical memory
- Data owns structured operational records
- Skills owns reusable distributed capability packages
- indexes/caches/dashboards are projections, not independent truth

See `system/architecture/source-of-truth.md`.

## Component composition

The local extension attachment registry is:

```text
.aiverse/extensions/registry.json
```

OS reads that registry, validates safe repository-relative runtime paths, and applies the host permission floor. Registration alone grants no authority.

Skills is intentionally discoverable from its external immutable provider root and does not need a fake local OS attachment entry.

See `system/extensions/README.md`.

## Universal workspace model

A workspace is the universal isolation primitive. It can represent a project, client, research area, product, role, course, team, personal area, or another custom scope.

The core does not hardcode industries or professions. Domain structure is learned inside the relevant workspace and only promoted to shared knowledge/capabilities when reuse is proven.

## Privacy by default

The public repository is a template. User-owned state is Git-ignored by default. Never store secrets in the repository.

Connection registries contain routes and metadata, not raw credentials.

## Legacy installations

Architecture v1 used root `context/`, `references/`, `decisions/`, and `connections.md`. Existing state must be preserved and migrated deliberately.

A legacy or standalone component that needs canonical-state migration is reported as `migration-required`. OS setup does not silently create a competing store or transfer authority.

## Public-beta scope

This repository's public-beta target is the OS host/lifecycle contract described above.

The following are separate owners or later system tracks, not missing OS implementation:

- AI-Verse Gateway
- AI-Verse Automations runtime
- Dashboard
- Apps
- Connections product/provider coverage
- hosted multi-user identity/RBAC
- marketplace/package ecosystem expansion
- enterprise policy/control planes

The one-product installer/profile UX belongs to `aiverse-filmmakers/ai-verse-distribution`, which consumes the OS/component machine-readable lifecycle contract rather than moving sibling ownership into OS.

## License

See `LICENSE` and `THIRD-PARTY-NOTICES.md`.
