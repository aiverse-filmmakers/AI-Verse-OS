---
name: 3d-brain
description: Use when someone asks to build a 3D brain, visualize AI-Verse OS or a second brain, turn saved knowledge into an interactive graph, or run /3d-brain.
disable-model-invocation: true
argument-hint: "[brain name] [categories or existing app path]"
---

# 3D Brain

Turn selected AI-Verse OS knowledge into a personalized local visual explorer. The generated application must reflect real saved files and honest relationships. Do not invent knowledge merely to make the graph look more impressive.

## 1. Establish the AI-Verse OS root

Read the applicable `AGENTS.md`, `CLAUDE.md`, and relevant indexes. Work only inside the intended OS or project root. Do not scan unrelated home folders.

Resolve this skill's package directory from the loaded `SKILL.md`.

Run the discovery helper when Node.js is available:

```text
node <skill-directory>/scripts/discover.mjs --root <AI-Verse-OS-root>
```

The helper should list candidate source folders without exposing file contents unnecessarily.

## 2. Choose the display name and categories

Reuse answers already supplied in the conversation.

Ask for:

1. **Brain name.** Use exactly the display name the user chooses.
2. **Categories.** Offer relevant folders actually found in the OS, such as Context, Projects, Skills, Filmmaking, Lessons, References, Decisions, or other real sources.

Three to seven categories usually gives the clearest visualization, but support more when the user needs them.

Do not guess paths for external sources. Ask for the path or use an existing explicit route.

## 3. Create the application

Default destination:

`apps/3d-brain/`

If the destination already exists, inspect it first. Do not overwrite unrelated or personalized content blindly. Archive an older version when replacing it.

Copy the bundled template from `assets/template/` into the destination and create `brain.config.json` based on `references/config.md`.

Then run:

```text
node build.mjs
node serve.mjs
```

Default server:

`http://127.0.0.1:4640`

Keep the bind address local unless the user explicitly asks for network exposure and understands the implications.

## 4. Build from real knowledge

The builder should scan approved Markdown and text sources, then create a graph dataset containing at minimum:

- node ID
- title
- source category
- source path
- relative file path when possible
- explicit links when discoverable
- optional health or freshness flags

Explicit Markdown links or wikilinks can become graph edges. Do not invent edges simply because two notes discuss similar topics unless the UI clearly distinguishes inferred relationships from explicit links.

Original notes must remain unchanged.

## 5. Visual behavior

The bundled template should retain a clear knowledge-globe experience:

- dark presentation background
- visible central brain/orb element
- categories with distinct UI treatment
- stable spatial layout
- restrained connection lines
- search
- category filters
- inventory/counts
- note inspection
- drag to orbit
- scroll to zoom
- a presentation or Cinema mode
- a growth/replay mode when graph ordering can be represented honestly

All user-facing names come from `brain.config.json` rather than being hardcoded.

## 6. Unsupported sources

Markdown and text files are the default supported sources.

For PDFs, cloud drives, databases, Notion, raw meeting formats, or other external systems, use an approved local export or a tested adapter. Do not claim an external source is connected merely because the category name exists.

## 7. Verification

Before finishing:

1. confirm the requested brain name appears in the app
2. confirm configured categories match real paths
3. compare displayed counts with the builder's scan counts
4. open at least one real note from each non-empty category when possible
5. test search
6. test a category filter and restoration
7. test orbit and zoom
8. test Cinema/presentation mode
9. test replay/growth when enabled
10. check for console or server errors when browser verification is available

If visual verification cannot be performed, state exactly what remains unverified.

## 8. Delivery

Report:

- brain name
- local URL
- app folder
- categories
- real node count
- any source gaps
- shortest controls: search, filter, Cinema, drag to orbit, scroll to zoom

Add a small route to the generated app in the appropriate project index or operating manual when useful.

Do not publish private graph data or note content to a public repository without explicit approval.
