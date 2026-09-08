---
name: link
description: Use when adding a project, file, folder, repository, data source, lesson library, or important reference that AI-Verse OS must be able to find later. Adds the smallest useful route from the operating manual or an existing index and verifies that the route resolves.
---

# Link

Make important information findable without copying the same content into several places.

## Goal

Given a target source and its intended purpose, add the smallest durable route that lets a fresh AI session discover it.

## Execution

1. Understand the source, its location, purpose, and authority.
2. Read the applicable `AGENTS.md`, `CLAUDE.md`, and existing indexes.
3. Prefer the project's current routing pattern instead of creating a duplicate index.
4. Add a small pointer that states where the source lives, what it contains, when it matters, and which source is authoritative when duplicates exist.
5. Verify that the path or external route actually resolves.
6. If the source is a live external system, update `connections.md` when appropriate.

## Source authority

- canonical current context beats brainstorm captures
- live connected data generally beats stale exports for current-state questions
- archives should not silently override current context
- skills should reference durable knowledge rather than duplicate it

## Rules

- Prefer one route over copied content.
- Do not reorganize unrelated files.
- Do not write secrets into routes.
- Mark unresolved or unverified routes honestly.
- Keep shared operating-manual edits synchronized between `AGENTS.md` and `CLAUDE.md`.

## Output

Report what was linked, where the route was added, what it is for, and whether the route was verified.
