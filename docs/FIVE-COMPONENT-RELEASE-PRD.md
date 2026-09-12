# PRD + Architecture — Five-Component Release Hardening

**Product:** AI-Verse OS first member beta  
**Date:** 2026-09-13  
**Status:** Implemented and frozen for the first-member beta  
**Components in gate:** AI-Verse OS, Brain, Memory, Data, Skills  
**Source audit:** `docs/SHIP-READINESS-AUDIT-2026-09-12.md`

**Implementation outcome:** R1-R7 are complete for the controlled first-member beta. The immutable release refs, verification evidence, and member install procedure are recorded in `docs/FIVE-COMPONENT-RELEASE-STATUS.md` and `docs/FIVE-COMPONENT-BETA-INSTALL.md`. Full Git commit SHAs are used as the allowed equivalent immutable release refs, so the beta does not depend on a mutable release branch. Existing license metadata remains authoritative and this freeze creates no new redistribution rights.

## 1. Release objective

Ship the first usable AI-Verse system without another foundational feature cycle.

The release succeeds when a member can install the five completed components in any practical order, attach them to an AI-Verse OS root without editing tracked OS files, remove/reinstall optional components without destroying user-owned state, update the OS cleanly, and run one supported host composition whose capabilities expand or contract dynamically as optional components appear or disappear.

This is release hardening, not a redesign of component internals.

## 2. Non-goals

This release does not add:

- Dashboard;
- Multiple Bots;
- Apps UI;
- a Brain-owned scheduler;
- automatic Data-to-Memory mirroring;
- universal execution for every Skills operator;
- semantic/vector Memory;
- npm/PyPI publication as a requirement;
- broad new reasoning behavior.

## 3. Product invariants

1. **No tracked OS mutation by optional component installers.**
   Normal install, attach, update, disable, detach, rollback and uninstall must not modify `AI-VERSE.yaml`, `AGENTS.md`, `CLAUDE.md`, `skills/registry.yaml` or `system/`.

2. **Package availability is not OS attachment.**

   ```text
   package/runtime available
   != attached to an OS root
   != enabled
   != healthy
   != initialized for a scope
   != authorized
   ```

3. **Installation chronology is not authority.**
   Installing a component first must never grant it more authority than installing it last.

4. **Missing optional components are absence, not corruption.**
   The host remains usable with OS only. A missing Memory/Skills/Data/Brain capability is reported as unavailable.

5. **Canonical user state survives software lifecycle.**
   Disable/detach/uninstall preserves canonical Memory, Brain state, Data databases and immutable Skills generations by default unless an explicit destructive purge exists.

6. **One local attachment registry.**
   `.aiverse/extensions/registry.json` is the single OS-root attachment registry for optional extensions.

7. **One owner per truth.**
   OS owns host structure, scope and permission floors. Brain owns Brain state only after explicit direction handover. Memory owns historical atomic memory only. Data owns structured records. Skills owns immutable package generations.

8. **Fail closed on incompatible present components.**
   Do not guess migrations, paths, authority or downgrade semantics.

## 4. Target lifecycle model

### 4.1 Machine/package level

A component may be installed before any OS exists.

Machine/package state may include:

- executable/library available;
- version;
- package/runtime root;
- immutable package generations where applicable.

This state grants no OS authority.

### 4.2 OS-root attachment level

For a given OS root, extension state is recorded in:

```text
.aiverse/extensions/registry.json
```

Registry state remains:

```json
{
  "schema_version": "1.0",
  "extensions": {
    "<component-id>": {
      "id": "<component-id>",
      "supported": true,
      "installed": true,
      "enabled": true,
      "version": "...",
      "source": "...",
      "instructions": "... optional ...",
      "engine": "... optional ...",
      "adapters": []
    }
  }
}
```

Unknown fields are preserved. Health is live, never durable truth.

### 4.3 Component states

The OS and doctors must distinguish:

```text
absent
available-unattached
attached-disabled
attached-unhealthy
attached-healthy
incompatible
migration-required
```

A component-specific workspace may additionally be uninitialized/initialized.

## 5. Shared extension registry mutation contract

All extension writers must follow the same mutation semantics:

1. validate compatible OS root;
2. ensure `.aiverse/extensions/` is a real non-symlink directory;
3. acquire `.aiverse/extensions/registry.json.lock` with exclusive create;
4. never steal a stale lock automatically;
5. read the latest registry while holding the lock;
6. validate schema `1.0`;
7. preserve unknown top-level fields;
8. preserve unrelated extension entries;
9. preserve unknown fields on the caller's own entry where safe;
10. stage same-directory temporary file;
11. verify the raw registry has not changed since the locked read;
12. atomically replace;
13. release lock;
14. never edit tracked OS files as a side effect.

OS owns the contract. Components may implement it locally but must pass the same conformance tests.

## 6. OS architecture changes

### 6.1 Generic component host

Rename the conceptual "four-component host" to the **AI-Verse OS Host Adapter**.

It must start with only:

```text
--root <os-root>
```

Optional configuration:

```text
--skills-root <path>
--local-skills-root <path>
```

No source-repository path is required.

At every operation it discovers live availability:

- Memory from the local extension registry plus validated engine path;
- Skills from the immutable provider root, defaulting to `~/.aiverse/skills`;
- Data from the local extension registry plus validated Data engine;
- Connections from the OS connection registry;
- OS built-in/local/workspace capabilities from existing resolver.

A host config generated today must continue working if Memory, Skills or Data are attached tomorrow.

### 6.2 Host operations

Brain bridge v1 operations retained:

- `read_context`
- `retrieve_history`
- `list_capabilities`
- `list_connections`
- `authorize_action`
- `request_action`

Add one backward-compatible optional operation:

- `query_data`

Brain must tolerate hosts that do not advertise it.

`query_data` is read-only and routes through the registered Data engine/OS Data host boundary. No direct SQLite access.

### 6.3 Optional degradation

- no Memory -> `retrieve_history` returns `[]`;
- no external Skills -> built-in OS/local/workspace capabilities still return;
- no Data -> `query_data` is not advertised or returns explicit unavailable;
- no connections -> `list_connections` returns `[]`;
- malformed/incompatible present component -> dependent operation fails closed with component-specific diagnostic, but unrelated host operations remain usable.

### 6.4 OS component doctor/reconcile

Add:

```text
node scripts/components.mjs doctor --root <root>
node scripts/components.mjs reconcile --root <root>
```

First release behavior:

- validate extension registry;
- enumerate attached components;
- inspect health/readiness without mutating canonical user state;
- discover external Skills provider;
- discover available Brain command when possible;
- report legacy Brain tracked-manifest registration;
- report installed-but-unattached known components when discoverable;
- `reconcile` performs only safe local attachment/migration actions with explicit component-owned commands; it never migrates standalone canonical user data implicitly.

The CLI may later expose this as `ai-verse-os components ...`.

## 7. Brain architecture changes

### 7.1 Native registration

Remove native write readiness dependence on tracked `AI-VERSE.yaml extensions.brain`.

AI-VERSE.yaml remains the OS architecture manifest, not member installation state.

Brain attachment lives in:

```text
.aiverse/extensions/registry.json
extensions["ai-verse-brain"]
```

Brain entry has:

- `id: ai-verse-brain`
- `supported: true`
- `installed: true`
- `enabled: true|false`
- Brain package version/source
- no false claim of health.

### 7.2 Brain commands

Add:

```text
ai-verse-brain attach <root> --apply
ai-verse-brain detach <root> --apply
```

`init <root> --apply` may attach idempotently when the host is compatible, but normal native writes still require a valid attached+enabled entry.

Attach does not hand strategic direction to Brain.

### 7.3 Direction handback

Add explicit:

```text
ai-verse-brain direction-owner <root> --scope <scope> --handover-to-os --apply --confirm-export
```

Required properties:

- only current Brain-owned scope may hand back;
- generate/export a bounded OS direction view before owner flip;
- preserve Brain objects as provenance;
- atomically flip ownership;
- OS never guesses from stale Brain files;
- interruption is resumable/fail-closed;
- detach is blocked while any scope is Brain-owned.

### 7.4 Host protocol

Add optional `query_data` to Brain HostAdapter/bridge dispatch and context assembly only where the cognition task explicitly requests structured current data. It remains bounded evidence, not Brain canonical state.

## 8. Memory architecture changes

### 8.1 Current native model

Native Memory uses the local extension registry only.

Remove stale doctor/README requirements for:

- Memory stanza in `skills/registry.yaml`;
- permanent Memory block in tracked `AGENTS.md`.

Legacy cleanup may remove exact old owned blocks, but new installs do not create them.

### 8.2 Lifecycle

Add native commands:

```text
install/attach
disable
detach/uninstall
```

Names may remain installer-specific, but semantics are mandatory.

Detach/uninstall removes:

- Memory extension registry entry;
- Memory-owned engine/runtime adapter files where safe;
- derived Memory SQLite index if explicitly treated as rebuildable software/runtime state.

It preserves:

- operator/workspace atomic Memory Markdown;
- canonical current context/profile/decisions;
- unresolved legacy store unless explicit migration/purge.

### 8.3 Registry concurrency

Memory adopts the shared lock + latest-read + lost-update contract.

## 9. Skills architecture changes

Skills remains external and does not register as an OS local extension.

Required release changes:

- OS host defaults to `~/.aiverse/skills`;
- host reads/pins installed immutable generation directly, with no Skills source checkout requirement;
- move receipt validation needed by the host into OS-local validation code or a stable installed provider artifact;
- update stale docs to provider-v1 reality;
- add a Windows-native launcher/entrypoint if Windows is advertised;
- first-party license remains a release-owner decision and must be resolved before public redistribution.

## 10. Data architecture changes

Data remains a local OS extension.

Before release:

- consolidate the post-release audit repair line;
- merge only after full build/test/package verification;
- Data engine exposes the supported OS host protocol;
- generic OS host routes read-only `query_data` through Data engine;
- Data absence never breaks unrelated host operations;
- uninstall preserves canonical workspace DB;
- registry mutation follows shared contract.

Data public license/distribution remains an explicit release-owner decision.

## 11. Connections behavior

The generic host must return real bounded connection metadata instead of unconditional `[]`.

For v1:

- read OS-owned `connections/registry.yaml`;
- expose only id/status/type/provider-like metadata needed for Brain orientation;
- never expose credentials/secrets;
- validate workspace scope before workspace-specific entries if later supported;
- malformed registry fails only `list_connections`, not unrelated host operations.

## 12. Release acceptance matrix

A new **Five-Component Acceptance** is the final gate.

### 12.1 Clean install story

On a clean environment:

1. install OS using the documented member command;
2. install/attach Memory;
3. install/attach Brain;
4. install Skills external provider;
5. install/attach Data;
6. initialize one workspace Data DB explicitly;
7. run doctors;
8. run one Brain tick through the generic OS host.

### 12.2 Order permutations

The gate must cover representative order classes, not all 120 permutations:

A. OS -> Memory -> Brain -> Skills -> Data  
B. Skills package -> Brain package -> OS -> attach Brain -> Memory -> Data  
C. OS -> Data -> Brain -> Skills -> Memory  
D. OS with no optional components -> create host config -> add Memory/Skills/Data later -> same host config sees them  
E. detach/reinstall Memory and Data while preserving canonical state.

### 12.3 Safety assertions

- no tracked OS file modified by component attach/install;
- OS update remains clean;
- registry sibling entries survive every mutation;
- registry concurrent writers fail/retry safely rather than lose entries;
- Brain cannot detach while it owns direction;
- explicit Brain -> OS handback restores OS strategic write authority;
- Memory workspace isolation remains intact;
- Data workspace isolation remains intact;
- Data delete permissions remain hardened;
- Skills execution remains pinned to immutable generation;
- no optional component absence breaks base host;
- all doctors report absence as informational, not failure;
- canonical state byte/hash checks survive disable/detach/reinstall where applicable.

## 13. Release artifact policy

Member beta must use immutable revisions.

Required before announcing release:

- exact Git tags or equivalent immutable release refs for all five repos;
- docs install commands use those refs;
- CI runs on those exact refs;
- branch protection / required checks on release branches;
- no open superseded hardening PRs creating ambiguity.

Moving `main` remains a development channel, not the member release artifact.

## 14. Implementation sequence

### Phase R1 — OS contract + generic host
- shared registry contract docs/tests;
- generic optional-component host;
- real connections listing;
- remove Skills source-checkout dependency;
- component doctor/reconcile foundation.

### Phase R2 — Brain attach + lifecycle
- local registry attach;
- remove tracked manifest dependency;
- attach/detach commands;
- Brain -> OS direction handback;
- optional Data host operation support.

### Phase R3 — Memory lifecycle convergence
- shared registry lock;
- doctor/docs correction;
- disable/detach/uninstall preserving canonical Memory.

### Phase R4 — Skills distribution cleanup
- installed-provider-only host pin/receipt path;
- docs;
- Windows launcher;
- release metadata cleanup excluding license choice.

### Phase R5 — Data canonical repair
- consolidate audit PRs;
- verify repair;
- merge to one release candidate.

### Phase R6 — Five-component gate
- exact public install/attach path;
- order classes A-E;
- update/detach/reinstall;
- host dynamic discovery;
- full CI.

### Phase R7 — Release freeze
- no feature additions;
- choose unresolved licenses/distribution policy;
- create immutable tags;
- protect release branches;
- publish member-beta install instructions.

## 15. Definition of done

The five-component beta is ship-ready when:

1. every MUST-FIX audit item has a test or explicit release decision;
2. no optional component requires a tracked OS edit;
3. generic host works with OS alone and dynamically gains optional capabilities;
4. Brain attach/detach and direction handback are safe;
5. Memory detach preserves canonical memories;
6. Data audit repairs are merged and green;
7. one five-component acceptance workflow is green on exact release revisions;
8. member install docs use immutable refs;
9. no known overlapping source of truth remains;
10. the release is frozen for real-world usage rather than expanded with new architecture.
