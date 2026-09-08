---
name: link
description: Use when adding a project, file, folder, repository, data source, lesson library, or important reference that AI-Verse OS must be able to find later. Adds the smallest useful route from the operating manual or an existing index and verifies that the route resolves.
---

# Link

Make important information findable without copying the same content into several places.

## Goal

Given a target source and its intended purpose, add the smallest durable route that lets a fresh AI session discover it.

Examples:

- `/link projects/client-a "current client project"`
- `/link references/filmmaking "directing and AI filmmaking knowledge"`
- `/link /path/to/local/folder "source footage metadata"`
- `/link https://github.com/example/repo "production codebase"`

## Step 1 - understand the source

Determine:

- what the source is
- whether it is inside the repository, local, or external
- what it should be used for
- whether it is current truth, reference knowledge, historical material, or a live connection

Ask only when the target or intended use is genuinely ambiguous.

## Step 2 - find the correct route

Read `AGENTS.md` and `CLAUDE.md` plus any nearer scoped operating manual or index.

Prefer an existing routing pattern. Do not create a second index when one already serves the purpose.

Possible routes include:

- a bullet under `Where things live`
- a project index
- a reference index
- a connection entry
- a scoped `AGENTS.md` or `CLAUDE.md`
- a short README inside a source folder

## Step 3 - add the smallest useful pointer

A good route tells the AI:

1. where the source lives
2. what it contains
3. when to use it
4. which source is authoritative if duplicates exist

Do not paste the entire source into the operating manual.

## Step 4 - verify resolution

From the route you added, simulate a fresh lookup:

- can the source actually be reached?
- does the path exist?
- is the description specific enough to know when it matters?
- if the source is external, is its mechanism documented in `connections.md` when appropriate?

If verification is impossible, label it unverified instead of claiming success.

## Source authority rules

- Current canonical context beats brainstorm captures.
- Live connected data generally beats stale exports for current-state questions.
- Archived information should not silently override current context.
- A skill should reference durable knowledge rather than duplicate it whenever possible.

## Rules

- Prefer one pointer over copied content.
- Do not reorganize unrelated files.
- Do not create a hot cache unless the workflow specifically needs one.
- Do not write credentials or secrets into routes.
- Keep shared operating-manual edits synchronized between `AGENTS.md` and `CLAUDE.md`.

## Output

Report briefly:

- what was linked
- where the route was added
- what the source is for
- whether the route was verified
