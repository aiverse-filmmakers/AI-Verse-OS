# Scoped Capability Resolution

Status: implemented OS consumer for Capability Provider Contract v1.

## Purpose

AI-Verse OS owns capability discovery, selection and user-owned placement semantics. It composes four provider classes without turning any of them into a second OS source of truth:

1. `os` — canonical built-ins from `system/capabilities/`.
2. `aiverse-skills` — the optional standalone AI-Verse-Skills distribution, read from its active immutable generation.
3. `local` — private reusable user capabilities, default `~/.aiverse/local-skills/`.
4. `workspace:<workspace-id>` — capabilities owned by the explicitly authorized active workspace at `workspaces/<workspace-id>/skills/`.

The implementation is `scripts/capability-resolver.mjs`. It performs no network access and never recursively scans a home directory. Optional providers are read only from their configured roots.

## Scope rules

A workspace provider is derived from the requested trusted workspace scope; arbitrary workspace paths are not accepted. `workspace:alpha` can see only `workspaces/alpha/skills/`. Another workspace is neither scanned nor returned. The workspace directory must remain physically inside the OS `workspaces/` root and contain `WORKSPACE.yaml`.

Paths and symlinks are resolved physically before a candidate is accepted. An escaping package or symlink is rejected. Directory-backed providers inspect only direct package directories containing `SKILL.md`; they do not deep-scan unrelated trees.

## Practical placement semantics

New user-owned capabilities are placed by practical reuse intent rather than by asking the member to choose a provider or filesystem path.

The OS-owned placement planner accepts meanings such as:

- "only use this in this project" -> the trusted active Workspace provider;
- "use this for all YouTube work" -> the private reusable `local` provider, with YouTube retained as practical context rather than invented as a new provider class;
- "use this everywhere" -> the private reusable `local` provider.

A project-only request fails for practical review when there is no trusted active Workspace. The member is asked to open or choose the project, not to supply a Workspace ID or storage path.

`os` is never a user-authoring target. `aiverse-skills` is also never a user-authoring target: it is the installer-managed distribution whose publication, generations and lifecycle remain owned by AI-Verse-Skills. Saving something for reuse across the member's own work therefore targets `local`, not the installed distribution.

The planner is planning/classification only. It does not move an existing package. If an existing user-owned capability would need to cross providers, the plan explicitly marks that as a separate promotion/migration: current provider-qualified identity is not assumed to survive, provenance/history must be preserved, and affected durable references require admitted repair. Applying that migration belongs to the dedicated promotion/re-scoping flow rather than placement planning.

Machine interface:

```text
planCapabilityPlacement({
  scope: <trusted current scope>,
  placement: "this-project" | "related-work" | "all-my-work" | practical phrase,
  contextLabel?: <practical label such as YouTube>,
  capabilityId: <bare capability id>,
  sourceQualifiedId?: <existing user-owned qualified id>
})
```

The corresponding resolver CLI operation is `plan-placement`. The host supplies trusted scope; the member does not select provider IDs, internal scope IDs or folders.

## Identity and precedence

Qualified identities are preserved:

- `os:<name>`
- `aiverse-skills:<name>`
- `local:<name>`
- `workspace:<workspace-id>:<name>`

The protected bare OS aliases are `onboard`, `workspace`, `grill-me`, `link`, `audit`, `level-up`, and `3d-brain`. A personal, workspace, or distributed capability may keep the same name under its qualified identity, but a bare request for one of those aliases always resolves to OS or fails if the OS capability is unavailable.

For other exact bare-name matches, precedence is active workspace, then personal local, then distributed Skills, then OS. Explicit qualified requests never fall back to another provider.

## Distributed Skills validation

The optional distributed provider is read from `<skills-root>/.aiverse/active.json`. New work pins the active generation once and reads:

- `.aiverse/generations/<generation-id>/.aiverse/installed.json`
- `.aiverse/generations/<generation-id>/.aiverse/capability-index.json`

Before returning any distributed candidate, the resolver validates:

- supported active-pointer schema and active state;
- generation containment inside the lifecycle root;
- manifest schema 3, provider ID, contract ID, and generation identity;
- SHA-256 of the exact `installed.json` bytes against `manifest_sha256`;
- one-to-one index/manifest membership;
- record equality for ID, name, description, visibility, version, path, digest, operators, and dependencies;
- qualified IDs, static metadata shape, and physical package containment.

A stale, malformed, or semantically inconsistent provider is `degraded` and contributes no candidates. A legacy mutable provider is `unsupported`. A genuinely absent or uninstalled optional provider is `absent` and produces no normal warning.

Package content digests are carried as integrity bindings. Full runtime re-verification of selected package bytes and contextual readiness are separate execution/readiness stages and are not claimed by this resolver.

## Discovery and selection

`discoverCapabilities()` ranks the complete authorized candidate set before applying `limit`. This prevents relevant capabilities late in a large provider index from being hidden by an arbitrary first slice.

`selectCapability()` supports both explicit qualified IDs and natural/bare queries. It returns either a concrete generation/digest/path-bound selection or an explicit `unavailable` result; it does not silently substitute another provider for a qualified request.

Discovery currently reports readiness as `UNVERIFIED`, permission as `unknown`, and approval as `not_required` placeholders only. Real connection/runtime readiness is intentionally deferred to the readiness implementation audit item; discovery metadata never grants execution authority.
