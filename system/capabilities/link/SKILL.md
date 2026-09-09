---
name: link
description: Use when adding an important file, folder, repository, record source, data system, document collection, workspace source, or external resource that AI-Verse OS must be able to find later. Adds the smallest durable route without copying the same truth into multiple places.
---

# Link

Make important information findable while preserving scope and source authority.

## Read first

Read `AI-VERSE.yaml` and identify the target scope before choosing where a route belongs.

## Step 1 - understand the source

Determine:

- what the source is
- whether it is local, repository-contained, or external
- what scope owns it: operator, workspace, or shared
- what it is authoritative for
- whether it is current truth, durable knowledge, historical material, an asset, or a live source
- whether access is verified

Ask only when the target, authority, or scope is genuinely ambiguous.

## Step 2 - choose the smallest canonical route

Prefer one of these:

- workspace `WORKSPACE.yaml` -> authoritative source route or workspace connection
- workspace `context/CURRENT.md` -> temporary current pointer
- `connections/registry.yaml` -> live external source mechanism
- workspace `knowledge/` -> curated workspace-specific knowledge route/index
- root `knowledge/` -> shared reusable knowledge route/index
- operator current context/profile -> operator-wide route when genuinely relevant across workspaces
- a short README/index beside a local source when that is the cleanest discovery point

Do not add routine source pointers to `AGENTS.md`, `CLAUDE.md`, or `AI-VERSE.yaml`. Those are system contracts.

## Step 3 - describe authority

A durable route should make clear:

1. where the source lives
2. what it contains
3. when to use it
4. what it is authoritative for
5. scope/privacy limits
6. whether access has been verified

Do not paste the whole source into an index.

## Step 4 - verify resolution

Simulate a fresh lookup from the route:

- does the path/URL/source exist?
- can the current runtime actually access it?
- is the route scoped correctly?
- is the description specific enough to know when it matters?
- if external, is the connection registry entry safe and free of secrets?

If verification is impossible, mark it unverified.

## Authority rules

- current scoped context beats older memory for current-state questions
- verified live sources may beat stale snapshots for external current state
- curated knowledge beats raw inbox material
- archives never silently override current truth
- generated indexes and app copies are derived, not canonical

## Legacy compatibility

If an existing installation still uses v1 `connections.md` or root context routes, preserve them. Do not create a second editable source without declaring which one is canonical.

## Output

Report:

- source linked
- scope
- route added
- authority/purpose
- verification status
