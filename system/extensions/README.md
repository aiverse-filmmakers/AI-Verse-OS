# Local Extension Registry

AI-Verse OS keeps optional extension installation state outside upstream-tracked system files.

The local registry path is:

`/.aiverse/extensions/registry.json`

The directory is gitignored by AI-Verse OS. Extension installers must register there instead of modifying `AGENTS.md`, `AI-VERSE.yaml`, or `skills/registry.yaml`.

## Registry envelope

The registry is UTF-8 JSON with this shape:

```json
{
  "schema_version": "1.0",
  "extensions": {
    "example-extension": {
      "id": "example-extension",
      "supported": true,
      "installed": true,
      "enabled": true,
      "version": "1.0.0",
      "source": "example-project",
      "instructions": "relative/path/INSTRUCTIONS.md",
      "engine": "relative/path/engine.py",
      "adapters": [
        ".claude/skills/example-extension/SKILL.md",
        ".agents/skills/example-extension/SKILL.md"
      ]
    }
  }
}
```

Unknown top-level fields and unknown extension entries must be preserved by extension installers. An installer updating its own entry should preserve unknown fields on that entry unless they conflict with the current contract.

## Semantics

- `supported` means the installed OS generation recognizes this extension contract.
- `installed` means the extension installer completed its local installation step.
- `enabled` means the operator has not disabled the extension.
- Health is not stored as a durable truth in this registry. It must be checked live by the extension or host.
- Registration does not grant workspace visibility, connection permission, action permission, approval, or Brain authority.
- Extension paths are repository-relative references. Consumers must reject absolute paths, `..` traversal, NULs, drive-prefixed paths, and paths that resolve outside the OS root.

## Runtime hook

`AGENTS.md` is the stable upstream runtime hook. When the local registry exists, a runtime reads it during startup and loads only task-relevant instruction files from extensions that are supported, installed, and enabled.

An extension installer must never append its own permanent standing block to tracked `AGENTS.md` once this hook exists.

The optional `engine` field is an extension-owned executable/module reference, not automatic authority. OS-owned host code may load a registered engine only after validating the registry entry and path, and must still apply current workspace, permission, approval, and component-specific policy before effects. For AI-Verse Data, the maintained boundary is `scripts/data-host.mjs`; the host never opens Data's SQLite files directly.

## Legacy migration

Older AI-Verse Memory installers modified tracked `AGENTS.md` and `skills/registry.yaml` directly. A compatible Memory installer may migrate only the exact legacy block/stanza it previously owned:

- remove the exact recognized Memory marker block from `AGENTS.md`
- remove the exact recognized `ai-verse-memory` capability stanza from `skills/registry.yaml`
- preserve all unrelated content byte-for-byte where practical
- leave ambiguous or user-modified legacy blocks untouched and report them instead of guessing
- preserve installed Memory engine files and Claude/Codex adapters
- write the new Memory registration into `.aiverse/extensions/registry.json`

After a recognized migration from a previously clean OS checkout, tracked OS files should match upstream again so `ai-verse-os update` can run normally.

## Ownership

AI-Verse OS owns this contract and the stable runtime hook. Each extension owns only its local registry entry and its own installed files. OS updates must not delete the local registry, and extension updates must not edit unrelated registrations.


## Public-beta lifecycle projection

AI-Verse OS projects component state through:

```text
ai-verse-os/component-lifecycle-v1
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

The OS surfaces:

```bash
ai-verse-os components status --json
ai-verse-os components doctor --json
ai-verse-os components reconcile --json
ai-verse-os components reconcile --apply --json
ai-verse-os components descriptor <component> --json
```

The descriptor exposes the information needed by Distribution, including component identity/version, compatibility, package source, setup requirements, supported lifecycle, current state, health/readiness, migration requirement, requested scopes/capabilities, separate authority transfer, and canonical-state preservation semantics.

Reconciliation is owner-preserving. OS may invoke only an explicitly allowlisted public command of the owning component when that command is available and the action does not transfer authority. Otherwise OS reports the owner action and stops.

OS never invents a sibling installer contract, removes a sibling lock, silently migrates a sibling canonical store, or treats integrity/registration as permission.
