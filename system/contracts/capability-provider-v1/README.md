# Capability Provider Contract v1

Status: implementation specification, 2026-09-09. Contract ID: `aiverse-capability-provider-v1`.

This directory is the canonical cross-repository contract. AI-Verse-Skills consumes a pinned revision; it does not maintain a second editable specification. Breaking changes require a new contract major version. The provider contract version is independent of the OS architecture schema, Skills catalog schema, package version, and installation generation.

This change specifies the next integration stage. It does not activate external discovery, add CLI commands, move packages, register Brain, or change current OS v2 routing. Existing installations continue to use their current manifest and adapters until a tested migration ships. Advertising this document is not advertising an implemented provider.

## 1. Ownership

| Surface | Canonical owner | Consumer behavior |
|---|---|---|
| OS control capabilities | OS | Discover as `os:*`; currently `.claude/skills/`, future `system/capabilities/` after migration |
| Distributed reusable packages and installation manifest | Skills installer | Read from configured external root; default `~/.aiverse/skills/` |
| Private reusable personal packages | User | Separate optional provider, default `~/.aiverse/local-skills/`; never overwritten by distribution updates |
| Workspace packages | Workspace owner | Discover only within the authorized active workspace's `skills/` |
| Capability index | Provider-generated, derived | Validate against installation generation; never edit as package truth |
| Resolver and local provider configuration | OS | Scope, rank, resolve, and enforce boundaries |
| Connection verification and action permission | OS/host | Recheck in the current execution scope |
| Goals and objective verdicts when Brain is integrated | Brain under an explicit ownership handover | Consume capabilities and evidence, never grant host authority |
| History and provenance | Memory | Supply scoped evidence; never define capability authority |
| Runtime adapters | Respective generator | Replace only files recorded as generator-owned |

Roles compose capabilities. Operator Packs describe software methods and requirements; they do not supply credentials or permission. Authorship is metadata: both the existing foundation packages and future `imported/ai-verse/` packages may be first-party.

A workspace procedure may become a reviewed private reusable capability. Contribution to the distributed library is a separate promotion with provenance, privacy review, verification, and explicit publication intent. The installed distribution is not a writable workshop.

## 2. Identity and scope

Qualified IDs have one of these forms (segments use lowercase letters, digits, and hyphens, beginning with a letter or digit):

- `os:<name>`
- `aiverse-skills:<name>`
- `local:<name>`
- `workspace:<workspace-id>:<name>`

Package version and content digest are separate from ID. Never infer first-party ownership from an ID alone. Resolve a package using `(qualified_id, generation_id, content digest)` and record that binding for execution.

Reserve bare OS entrypoints `onboard`, `workspace`, `grill-me`, `link`, `audit`, `level-up`, and `3d-brain`. A non-OS package may retain its qualified name, but cannot capture those bare aliases. Other bare names prefer an authorized active-workspace match, then personal local, then distributed. Ambiguity within a provider is an error. An explicitly qualified request selects that provider only after scope and trust checks; arbitrary paths never bypass checks.

Provider identities are `os`, `aiverse-skills`, `local`, or `workspace:<workspace-id>`. A capability ID must have its provider identity as prefix. Visibility is `system` for OS, `shared` for distributed/personal, or the exact workspace identity. Visibility is availability for discovery, not execution permission.

## 3. Manifest and index

For external Skills the discovery paths are:

- `<configured-root>/.aiverse/installed.json`: installer-owned installation truth.
- `<configured-root>/.aiverse/capability-index.json`: derived v1 discovery data.

Expand `~` once using the host's explicit user root. Never discover by recursively scanning a home directory or contacting GitHub. OS/local/workspace providers may synthesize the same record model from their authorized metadata without writing an external Skills installation manifest.

The accompanying JSON Schema defines an external index envelope and static records. The example is illustrative; its digest is a placeholder, not a valid installed package.

An external manifest implementing v1 must expose `provider_contract: aiverse-capability-provider-v1`, `provider_id`, and a nonempty immutable `generation_id`, in addition to its installation metadata. The index repeats that generation and records SHA-256 of the exact UTF-8 bytes of `installed.json`. No canonical-JSON rewriting is allowed before hashing. The manifest must not hash the index (avoid a circular dependency).

The index is regenerated from the manifest and validated package metadata. Each indexed record must correspond to exactly one manifest package with matching ID, path, version, and digest. IDs must be unique. Indexes cannot grant package trust, add uninstalled packages, or store global execution readiness. Schema validity alone is insufficient: the consumer must validate generation, manifest hash, membership, provider/ID/visibility consistency, and paths.

`path` is a POSIX relative directory path from the pinned generation root. Reject absolute paths, empty segments, `.`/`..`, backslashes, drive prefixes, and NULs. Resolve symlinks and require both the package and selected resources to stay within that generation. Workspace roots must themselves resolve within the authorized workspace. Verify selected package content before execution using its declared digest algorithm; v1 defines the portable `aiverse-package-sha256-v1` algorithm: recursively enumerate regular files excluding any `.git` segment, sort by UTF-8 bytes of POSIX relative path, and hash each UTF-8 relative path followed by NUL, raw file bytes, and a final NUL. Recompute this versioned digest when migrating legacy installations; do not assume an unversioned platform-dependent digest is identical. Escaping symlinks are rejected before hashing. A digest is integrity evidence, not a trust grant.

Old manifests without a v1 envelope are legacy, not corrupt. Current behavior remains available until migration; a future v1 consumer reports `unsupported` and must not pretend legacy metadata satisfies v1. Unsupported major versions are rejected; recognized v1 envelopes are validated strictly.

## 4. Readiness is contextual

Static index state is only `valid` or `broken`. Requirements list operators and dependencies; they never assert connectivity. Live readiness belongs in the OS result, not the installed index.

For each selected candidate the host assesses package integrity, runtime/tool compatibility, connection usability, scope permission, and action approval independently. Assessments identify scope, runtime, check time, expiry, and evidence references; no credentials belong in the catalog. Expired or missing evidence is unknown, not success. Connection changes invalidate cached results.

A discovery summary can use:

- `BROKEN`: package or provider integrity failed.
- `DORMANT`: a required runtime/dependency/connection is known unavailable.
- `UNVERIFIED`: a prerequisite cannot be established.
- `READY`: prerequisites verified for this scope/runtime at this time.

Return separate `permission` (`allowed`, `denied`, `unknown`) and `approval` (`not_required`, `required`, `granted`) fields. `READY` never means an action is approved. Execution requires current prerequisites, permitted scope, satisfied approval, and the host's action policy. If Brain applies, its gate can further restrict but cannot expand OS/host authority. An installed binary or environment flag alone is not verified connection access.

## 5. Discovery and invocation interface

The OS resolver accepts a request with `scope`, `query`, optional `intent_refs`, optional `objective_refs`, `runtime_id`, optional `qualified_id`, and bounded `limit`. References carry context selection hints, never authority. The host derives authorized roots and scope from trusted state rather than trusting model-supplied paths.

Results contain qualified ID, provider, visibility, description, package version, generation, relative path, digest, requirements, and contextual readiness. Apply relevance ranking before the limit; a capability beyond the first 50 catalog entries must remain discoverable. An explicit missing capability returns a specific unavailable/degraded result rather than silently choosing a different implementation.

Load metadata first, then the selected `SKILL.md`, then required resources. Pin one generation across instructions, scripts, and references. A provider counts as runtime-supported only after a real discover -> select -> load resources -> invoke -> receipt test passes for that runtime. A directory listing is not invocation support.

Provider states are `absent`, `healthy`, `degraded`, and `unsupported`. Absent optional providers incur no network, installation, recursive scan, or normal startup warning. Damaged or unsupported providers do not crash OS; exclude their candidates and expose diagnostics. If the task explicitly requests an unavailable provider, explain the limitation. Aggregate health; delegate package diagnostics to Skills rather than duplicating its doctor.

## 6. Generation lifecycle

Install, update, rollback, and uninstall remain Skills-owned and serialized. Stage and validate a complete generation before activation. Atomically publish an active-generation reference or use an equivalent mechanism that gives readers one coherent generation; two separate directory renames alone are not sufficient for concurrent readers or crash recovery.

A discovery operation pins the active generation once. Subsequent reads never resolve through a changing active pointer. Retain referenced generations for in-flight work; new work after uninstall sees the provider as absent. Uninstall does not silently remove files from running work or authorize further effects. Explicit cancellation and permission revocation remain host concerns. Crash recovery must distinguish staged, active, and retained generations. An expired execution lease cannot delete a still-active generation without proving it is unused.

Manifest, index, package, and adapter generation must agree. Copy-based adapters must refresh transactionally or refuse a generation mismatch. Rollback selects a previously validated generation and invalidates discovery caches. Personal/workspace packages, OS, and user state are outside the distribution's update/uninstall ownership. No fixed count such as 100 is a permanent invariant; use the pinned profile/release manifest.

## 7. Extension and migration compatibility

This contract does not change `AI-VERSE.yaml` schema 2.0 or the existing registry. Future provider registration must be separate from capability indexes and preserve a distinction between supported, installed, enabled, and healthy. Registration does not grant permissions or activate Brain direction ownership. An incompatible OS must be reported explicitly, not silently treated as standalone.

Before replacing the current registry, provide a legacy reader/migration for Memory's `ai-verse-memory` entry. Preserve its `AGENTS.md` marker and both runtime adapters. New generators track their exact owned files and source digests; they must not clear whole adapter roots or overwrite locally changed/unowned files. Migrations report conflicts and preserve user state. Test both installation orders: Memory before migration and Memory after migration.

The next extension registration implementation must keep local registrations outside upstream-tracked system files so OS updates remain usable. Do not advertise `extensions.brain` until initialization and all runtime write paths enforce the same registration contract.

Canonical built-ins may later move to `system/capabilities/`; until then the current source remains authoritative. Shipped 3D Brain templates belong in system-owned template storage, separate from user-configured `apps/3d-brain/`. A system invocation capability may remain. Generated adapters have one canonical source and must not create a second editable methodology store.

## 8. Brain and receipt boundary

The OS host adapter implements Brain capability discovery using this resolver. It passes relevant goal/objective hints rather than returning an arbitrary first slice of the catalog. This specification does not add that adapter or alter Brain's current read-only host.

The host normalizes Skills receipts into Brain action outcomes. Skills `success` may map to Brain `succeeded` only when the host verifies the result; side effects require a durable host receipt ID. `trace_id` is correlation, not proof. `partial`, `blocked`, and `aborted` require effect-aware mapping: report failed with `effect_occurred=false` only if no effect is proven; otherwise preserve uncertainty or a verified partial effect record and block unsafe replay. Unknown outcomes are `uncertain`. Bind receipts to qualified capability ID, generation/digest, scope, request fingerprint, and idempotency key.

Skills verification checks provide evidence. The host maps evidence to Brain criterion IDs and preserves evaluator provenance/independence. Brain owns objective verdicts; mandatory OS/host verification floors still apply. No capability or provider metadata can close an objective, change policy, or manufacture an approval.

## 9. Required implementation acceptance cases

These are release gates for the future implementation, not claims that current code passes:

1. OS without external Skills performs no external install/network/deep scan and retains system/workspace capabilities.
2. Standalone Skills install/update/rollback/uninstall leaves OS Git state unchanged; OS update leaves Skills and personal packages unchanged.
3. Duplicate IDs, stale manifest hash, mismatched generation, injected package, unsupported version, and escaping paths are rejected.
4. Scope A cannot enumerate scope B or access B via a symlink. Protected bare aliases cannot be shadowed.
5. Relevant capabilities beyond entry 50 are selected; only selected resources are loaded.
6. An unauthenticated CLI and expired connection evidence never imply execution readiness; readiness never grants approval.
7. Update during invocation cannot mix instruction/script generations; rollback, copy adapters, concurrent updates, and interrupted activation recover consistently.
8. A private reusable package survives distribution update and uninstall; publishing remains a separate action.
9. Memory's marker, registry entry, and adapters survive migration in both installation orders; unowned/modified adapters are preserved.
10. OS schema remains compatible until an intentional architecture migration. Missing Brain support cannot be mistaken for enabled integration.
11. Each supported runtime proves discovery, resource resolution, invocation, and a verified receipt with the same generation binding.
12. Receipt tests cover success, no-effect failure, partial effects, timeout after dispatch, duplicate delivery, and evaluation evidence without unauthorized objective closure.

## 10. Delivery sequence

First finalize this contract and its producer mapping. Next fix the separately identified Memory/Brain correctness defects before autonomous integration. Then implement Skills index publication plus OS discovery and one runtime path. Migrate built-in sources only after that works. Complete the Brain host adapter and direction ownership handover as a separate stage, followed by the four-component acceptance suite.
