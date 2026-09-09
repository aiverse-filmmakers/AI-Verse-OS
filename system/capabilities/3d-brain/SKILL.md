---
name: 3d-brain
description: Use when someone asks to build a 3D brain, visualize their AI-Verse OS or second brain, turn selected knowledge into an interactive graph, or run /3d-brain or /3D brain. Uses the actual installation without assuming a profession or fixed knowledge categories.
disable-model-invocation: true
argument-hint: "[brain name] [categories or existing app path]"
---

# 3D Brain

Turn the user's actual AI-Verse OS sources into a personalized local 3D knowledge globe. Use the bundled working application rather than inventing a new visual interpretation. Preserve its spherical composition, colored categories, central orb, restrained connection particles, Cinema mode, and interactive growth replay.

The command is `/3d-brain` in Claude Code. In Codex, select the `3d-brain` skill or use `$3d-brain`. Interpret the natural-language phrase “3D brain” the same way. Input comes from arguments and the conversation. No external service, API key, paid asset, or deployment is required.

## 1. Find the AI-Verse OS and candidate sources

Read the applicable operating contract and `AI-VERSE.yaml`. Establish the actual AI-Verse OS root; do not scan an unrelated ancestor or the user's whole home directory.

Resolve this skill's own directory from the loaded `SKILL.md`; package paths below are relative to it, regardless of whether it lives in `.claude/skills`, `.agents/skills`, or another compatible adapter.

Read [the portable spec](references/portable-spec.md) and [the config guide](references/config.md). Check Node.js 22 or newer. Use the user's existing Node runtime. If unavailable, explain that Node is required and follow the host's installation/approval policy.

Run the path-only discovery helper:

```text
node <skill-directory>/scripts/discover.mjs --root <AI-Verse-OS-root>
```

It lists candidate folders without reading their contents. It understands architecture v2 operator, shared-knowledge, and workspace paths while retaining external runtime memory discovery.

Also use explicit source routes in the active workspace manifest or current context when relevant. Do not assume a profession, account, domain vocabulary, or external memory location.

## 2. Ask for the name and categories

Reuse information already supplied and do not repeat answered questions.

1. **Name:** ask what the user wants to call the brain. Accept the exact display name. Do not silently choose an author name or brand.
2. **Categories:** offer the candidate sources actually found, each beside its proposed path. Let the user rename, omit, combine, or add categories. Suggest roughly three to seven for visual clarity; support one to twelve.

The categories should reflect this installation. Generic examples include Operator context, Shared knowledge, one or more Workspaces, Research, Notes, Memory, and Skills. These are examples, not required categories.

The category answer also approves its listed source paths. For a custom category with an unknown path, ask where those files live. External runtime memory may cover broader scopes; state that scope before offering it and include it only if chosen.

Show a compact name/category/path mapping before building. Once those choices are supplied, continue without another generic confirmation. Ask only about unresolved paths, replacing an existing app, or another material ambiguity.

## 3. Scaffold the exact experience

Default output: `<AI-Verse-OS-root>/apps/3d-brain/`. If it already exists, inspect its `brain.config.json` and reuse the app. Do not overwrite it blindly. For a requested replacement, archive the existing version first within the same installation. If unrelated files occupy the destination, choose a new folder or ask the user.

Create setup JSON in an ignored scratch location under the AI-Verse OS. Do not include actual note bodies in the setup file. Use relative paths for sources inside AI-Verse OS and explicit approved paths for outside sources. Give each category a unique ID, label, color, adapter, and one or more real paths.

```text
node <skill-directory>/scripts/scaffold.mjs --root <AI-Verse-OS-root> --config <setup-json> --out apps/3d-brain
```

This copies an explicit allowlist of application files and writes the personalized local config. It refuses an existing destination. The renderer is prebuilt, so `node serve.mjs` works without npm installation. Do not copy `node_modules`, another user's config, graph snapshot, screenshots, memory files, or session logs into the app or skill.

In the generated app folder:

```text
node build.mjs
node serve.mjs
```

Start the server through the host's normal background/launch mechanism. On Windows, background launches must be hidden. Default port is 4640. If occupied, choose an available port and update only this app's config. Never stop an unrelated service. Keep the bind address at `127.0.0.1`.

Read the build's real counts and warnings. A missing folder is a configuration issue, not a reason to invent nodes. Empty categories are allowed and shown honestly. For an entirely empty installation, explain that the brain needs saved sources; do not inflate it with synthetic knowledge unless the user separately asks for a labeled example.

## 4. Preserve behavior and honest connections

The supplied renderer is the visual contract. Retain:

- stable spherical layout, distinct source colors, dark background, glowing central orb, and quiet orbital accents
- real explicit Markdown links and wikilinks, with ambiguous links unresolved
- search, source solo/toggle, inventory, health flags, note reading, and local file reveal
- **Play demo:** one central idea, first real connection, branches springing from parent nodes, accelerating growth, and a complete brain after roughly 29 seconds; disconnected notes join without invented edges
- camera orbit/zoom during growth, central orb from frame one, clean replay reset
- **Cinema:** clean presentation with the growth counter, pause motion, reduced-motion support, responsive controls, and no stale labels

The replay represents connectivity, not invented chronology.

All name-bearing UI comes from `brain.config.json`. Do not regenerate the visuals with an image model or replace the scene with a generic force graph. If code changes are needed, use the package's normal source/build path and retain dependency license notices.

The default adapters read Markdown/text and curated Codex memory. For unsupported source types, explain the gap and use an explicitly approved local export or build/test an adapter. Do not claim a system is connected merely because its name appears in a category.

## 5. Verify and deliver

Follow [the acceptance checklist](references/acceptance.md). Check the generated app, not just the template:

1. Graph API contains the requested name/categories, unique IDs, valid endpoints, and counts matching source scans.
2. Read at least one real note from each nonempty category. Originals remain unchanged.
3. Confirm the requested name and test search, a source solo filter, restoration, and inventory.
4. Watch early, middle, and complete growth. Drag/zoom during growth and verify final count plus replay reset. Test Cinema and pause/resume.
5. Inspect desktop and a narrow viewport. Do not manipulate the user's physical mouse. Browser automation must remain virtual/headless.
6. Check console errors. If visual/browser verification is unavailable, state exactly which checks remain unverified.

Route the app from the narrowest relevant user-owned source, such as the active workspace manifest/current context or operator current context. Do not add personal app routes to `AGENTS.md`, `CLAUDE.md`, or `AI-VERSE.yaml`.

Avoid storing private configs, graph data, or note content in a public repository. Do not deploy or push generated user state without authorization.

Finish with the brain name, local link, app folder, actual note/category counts, and the shortest useful controls: **Play demo**, **Cinema**, drag to orbit, scroll to zoom. Mention source gaps if present.
