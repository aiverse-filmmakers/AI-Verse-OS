# Workspace Infrastructure Generation

AI-Verse-OS owns Workspace structural semantics.

This document defines the current read-only structural generation used by infrastructure upgrade planning. It does not create a relocation engine and does not replace `WORKSPACE.yaml` as the Workspace identity source.

## Current generation

```text
workspace-id-slot-v1
```

A Workspace conforms to `workspace-id-slot-v1` when:

- it is a real direct child directory of `workspaces/`;
- its direct child directory name is a valid Workspace ID;
- it contains a real, readable `WORKSPACE.yaml` file;
- the manifest contains a valid top-level `id`;
- the manifest `id` exactly matches the direct child directory name;
- its canonical identity evidence does not conflict with another Workspace;
- it does not contain another nested `WORKSPACE.yaml` that would imply an unsupported nested Workspace/relocation layout.

`workspaces/_template/` is an OS template and is not a real Workspace.

An installation with no real Workspaces is structurally current.

## What does not define generation

Generation is not whole-directory equality and is not template completeness.

The following do not make a conforming Workspace stale:

- optional Workspace subdirectories being absent;
- additional user-created files or directories;
- free-form `type` or `domains` metadata;
- user-owned assets, outputs, knowledge, memory, decisions, inbox material or local capabilities;
- ordering or formatting differences in supported manifest YAML;
- other additive owner/user manifest fields allowed by the Workspace schema.

The template documents the full available contract. Active Workspaces may contain only the parts they actually use.

## Identity and storage

Canonical logical identity remains:

```text
WORKSPACE.yaml:id
```

The current supported storage slot remains:

```text
workspaces/<workspace-id>
```

The path is not a second independent logical identity. It is the currently supported physical slot derived from the owner-controlled Workspace ID.

Arbitrary nested or relocated Workspace storage is not supported by this generation. A future owner/System contract may admit relocation, but this generation does not infer identity from similar content or discover a moved Workspace through guesswork.

## Fail-closed findings

The detector returns `BLOCKED/REVIEW` rather than normalizing or moving state when it sees identity/structure it cannot prove safe, including:

- a Workspace directory that is a symlink;
- a direct Workspace directory without a readable `WORKSPACE.yaml`;
- an invalid direct-child Workspace ID;
- a missing or invalid manifest ID;
- a manifest ID that does not match its supported slot;
- duplicate/conflicting manifest IDs;
- a nested `WORKSPACE.yaml` below a real or category-like direct child.

These findings are review conditions, not automatic migration instructions.

## Detector

Read-only owner operation:

```text
node scripts/workspace-infrastructure.mjs detect --root <AI-Verse-root>
```

The detector emits JSON with:

- owner `ai-verse-os`;
- domain `workspace-infrastructure`;
- current generation `workspace-id-slot-v1`;
- aggregate `current` or `blocked-review` state;
- `CURRENT` or `BLOCKED/REVIEW` disposition;
- independently identified Workspace observations;
- machine-readable findings.

Exit code is `0` only for a current structure and `2` for `BLOCKED/REVIEW`.

Detection is read-only. It does not create folders, rewrite manifests, move Workspaces, repair references, grant authority or delete custom state.

## Relationship to the Workspace owner

`scripts/workspace-owner.mjs` remains the canonical create/evolve primitive. The infrastructure detector does not duplicate its mutation logic.

The detector only answers whether existing Workspace storage/identity evidence conforms to the current structural generation. Any future migration belongs to an explicitly admitted OS owner operation and remains separately gated by the Safe Infrastructure upgrade contract.