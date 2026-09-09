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
