# Scoped Capability Resolution

Status: implemented OS consumer for Capability Provider Contract v1.

## Purpose

AI-Verse OS owns capability discovery, selection and user-owned placement semantics. It composes the existing four provider classes plus explicit read-only registered external sources without turning any of them into a second OS source of truth:

1. `os` — canonical built-ins from `system/capabilities/`.
2. `aiverse-skills` — the optional standalone AI-Verse-Skills distribution, read from its active immutable generation.
3. `local` — private reusable user capabilities, default `~/.aiverse/local-skills/`.
4. `workspace:<workspace-id>` — capabilities owned by the explicitly authorized active workspace at `workspaces/<workspace-id>/skills/`.
5. `external:<source-id>` — explicitly registered, digest-bound read-only external packages; never inferred from a plugin cache.

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

If an existing user-owned Workspace capability needs wider personal reuse, the planner marks Workspace-to-personal promotion as an admitted separate mutation. Other cross-provider directions remain unsupported unless a future owner contract admits them.

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

## Admitted Workspace-to-personal promotion

Slice 3.4 adds one narrow OS-owned promotion transaction for the proven reuse case: an existing Workspace-owned capability can become a private reusable personal capability. It does not publish into the managed Skills distribution and it does not implement a generic provider migration framework.

The identity relationship is explicit:

- source identity: `workspace:<workspace-id>:<name>`;
- target identity: `local:<name>`;
- `qualified_identity_preserved` is always `false`.

Matching names or bytes do not make these the same identity. A promotion preview binds the exact source generation and `aiverse-package-sha256-v1` digest. Apply requires that preview evidence again. If the source changed, the target name is owned by different bytes, the source is not owned by the active Workspace, or the package contains filesystem structure that cannot be copied safely, the operation stops for review before retiring the source.

Successful apply performs the owner-controlled transaction in this order:

1. verify the exact Workspace source and preview digest;
2. stage and digest-verify the complete package, including custom regular files;
3. publish or explicitly adopt an already-identical personal target;
4. record pending promotion evidence in private local-provider metadata;
5. re-verify the source has not changed;
6. move the original package into a hidden, non-live Workspace history area rather than deleting it;
7. activate the promotion receipt used for exact-ID compatibility repair.

The receipt is stored under the private personal provider metadata area and records the old qualified identity, the new qualified identity, source/target generation and digest evidence, the non-live history location, and `qualified_identity_preserved: false`. It is promotion evidence, not a global identity registry.

An exact request for a retired Workspace-qualified ID may use an active receipt to select the recorded `local` target. The returned candidate keeps its real `local:<name>` identity and the selection includes a separate `promoted-to` compatibility relationship containing the originally requested ID. Discovery does not advertise the retired Workspace ID as another canonical candidate.

This gives already-stored or exact-ID consumers a controlled compatibility path without pretending identity continuity. There is currently no canonical cross-owner database of durable user-capability references to batch-rewrite; if one is later introduced, that owner must publish its own admitted reference-repair contract.

Promotion is idempotent after successful activation. A second apply returns `already-promoted` without creating another live copy. A stale preview, different existing target, invalid promotion evidence, unsupported source, or incomplete prior transaction fails closed for review.

Machine operations exposed by `capability-resolver-cli.mjs` are:

- `plan-promotion` — read-only preview for the active Workspace-owned source;
- `apply-promotion` — explicit mutation requiring the previewed source generation and digest.

These are owner/internal lifecycle surfaces. Normal member placement remains practical-language driven.

## Identity and precedence

Qualified identities are preserved:

- `os:<name>`
- `aiverse-skills:<name>`
- `local:<name>`
- `workspace:<workspace-id>:<name>`

The protected bare OS aliases are `onboard`, `workspace`, `grill-me`, `link`, `audit`, `level-up`, `3d-brain`, and `version`. A personal, workspace, or distributed capability may keep the same name under its qualified identity, but a bare request for one of those aliases always resolves to OS or fails if the OS capability is unavailable.

For other exact bare-name matches, multiple candidates produce `ambiguous` with explicit alternatives. A saved workspace choice wins over an operator identity preference; unavailable saved choices never silently fall back. Without a saved choice, one exact match selects that identity. Equal top natural-language relevance also produces ambiguity. Provider precedence orders search results only; it no longer silently decides exact-name collisions. Explicit qualified requests never fall back to a different provider except when an active OS-owned promotion compatibility receipt explicitly records that the retired Workspace identity was promoted to a specific personal identity. That compatibility result reports the new identity and the relationship; it is not ordinary fallback.

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

`selectCapability()` supports both explicit qualified IDs and natural/bare queries. It returns either a concrete generation/digest/path-bound selection or an explicit `ambiguous`/`unavailable` result. The only cross-provider exact-ID compatibility case is a validated active Workspace-to-personal promotion receipt as described above.

Discovery currently reports readiness as `UNVERIFIED`, permission as `unknown`, and approval as `not_required` placeholders only. Real connection/runtime readiness is intentionally deferred to the readiness implementation audit item; discovery metadata never grants execution authority.

## Shared member library and bindings

See [member skills](member-skills.md) for the Skills-owned member index consumer,
scoped settings, exact preview/apply choices, installation-root binding and the
versioned read-only external-registration contract. Existing qualified IDs and
promotion receipts remain supported. These APIs are local implementation source;
composed runtime/release acceptance is tracked separately.
