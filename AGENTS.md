# AI-Verse OS Runtime Contract

AI-Verse OS is a domain-neutral operating layer for AI-assisted work. It must adapt to the operator's profession, responsibilities, projects, cases, clients, research, products, studies, personal systems, or other work without baking any one domain into the core architecture.

Do not personalize this file with operator facts. User-specific truth belongs under `operator/` and `workspaces/`. Read `AI-VERSE.yaml` as the machine-readable architecture manifest.

## Startup protocol

For substantial work inside AI-Verse OS:

1. Read `AI-VERSE.yaml`.
2. Read this file.
3. If `.aiverse/extensions/registry.json` exists, read it and load only task-relevant extension instructions from entries that are explicitly supported, installed, and enabled. Registration is not proof of health, permission, approval, or execution readiness.
4. When operator current context matters, resolve it with `node scripts/current-context.mjs read --scope operator`; do not bypass that resolver with a raw `operator/context/CURRENT.md` read.
5. Identify whether the request belongs to a workspace. If it does, read that workspace's `WORKSPACE.yaml`, then resolve current context with `node scripts/current-context.mjs read --scope workspace:<id>` before deeper retrieval.
6. Select the smallest relevant skill or deterministic script.
7. Retrieve only the knowledge, memory, assets, and connected data needed for the task.
8. Execute at the lowest autonomy level that reliably works.
9. Validate before handing output to another step or taking an external action.
10. Write back only information that deserves to become durable state.

When a scope is Brain-owned, raw OS goals, priorities, objectives, and other strategic sections are frozen provenance only. They must not be merged, summarized, or routed back into active current direction. The ownership-aware current-context resolver exposes only allowed OS operational state plus Brain direction refs; Brain unavailability never causes fallback to frozen OS strategy.

Do not load the entire OS just because it exists. Prefer scoped retrieval and progressive disclosure.

## Universal architecture

AI-Verse OS separates concerns deliberately:

- `system/` contains architecture, schemas, templates, policies, health rules, and the canonical OS capability sources supplied by AI-Verse OS.
- `operator/` contains the human operator's identity, preferences, goals, current context, memory, inbox, and decisions.
- `knowledge/` contains durable reusable knowledge that is broader than one workspace.
- `workspaces/` isolates substantial scopes of work. A workspace can represent any meaningful unit such as a project, role, practice, client, case, research area, product, team, course, study, personal area, or a custom type.
- `connections/` describes systems and sources the OS can reach. Registry entries are not proof that access works.
- `system/capabilities/` is the canonical editable source for OS-built-in capabilities. `.claude/skills/` and `.agents/skills/` are generated runtime adapter peers. `skills/registry.yaml` is the runtime-neutral capability registry.
- `.aiverse/extensions/registry.json` is local installation metadata for optional extensions. It is gitignored by the OS and must be used instead of modifying upstream-owned runtime contracts or capability registries.
- `agents/` describes orchestration. Agents coordinate capabilities and context; they should not become giant duplicate knowledge stores.
- `automations/` implements cadence through jobs, triggers, and policies.
- `apps/` contains persistent interfaces built on top of the OS. Apps are views and tools, not sources of truth.
- `runtime/` contains disposable caches, indexes, logs, temporary reports, generated state, and the local adapter-ownership ledger.
- `archives/` preserves material that should remain available historically but should not override current truth.

See `system/architecture/README.md` for the full model.

## Local extension rule

Optional extensions must not edit tracked OS files during normal install, update, rollback, or uninstall.

- Register local installation state in `.aiverse/extensions/registry.json`.
- Keep `AGENTS.md`, `AI-VERSE.yaml`, `skills/registry.yaml`, and `system/capabilities/` under OS ownership.
- Extension entries must distinguish `supported`, `installed`, and `enabled`; health is checked live rather than asserted by registration.
- Treat extension instruction, engine, and adapter paths as repository-relative references. Reject absolute paths, `..` traversal, or paths that resolve outside the OS root before loading them.
- Unknown extension entries are preserved by other extensions and by OS updates.
- Runtime adapter synchronization may replace only files recorded as OS-owned whose current digest still matches the last generated digest. Unknown files and locally modified files must be preserved and reported as conflicts.
- A registration never grants workspace access, connection permission, action approval, or Brain authority.
- When `ai-verse-data` is installed and enabled, structured Data operations use `node scripts/data-host.mjs --root <os-root>` through the registered extension engine. Do not open `workspaces/*/data/ai-verse-data.sqlite` directly from runtime or model code. Workspace initialization remains explicit and destructive Data operations must satisfy the OS action-permission boundary.
- See `system/extensions/README.md` for the local registry contract and migration rules.

## Four Cs

Read `references/4cs-framework.md` when evaluating the system.

- **Context:** the OS knows the relevant operator and workspace state.
- **Connections:** the OS can reach required systems and sources.
- **Capabilities:** reusable skills, agents, scripts, and workflows can perform the work.
- **Cadence:** mature workflows can run on schedules or events with appropriate controls.

The Four Cs describe capability layers, not mandatory top-level folders.

## Three Ms

Read `references/3ms-framework.md` when improving a workflow or running `/level-up`.

- **Mindset:** look for where AI can increase leverage before defaulting to the old process.
- **Method:** identify the constraint, remove unnecessary work, map the process, choose autonomy deliberately, and connect it to an outcome.
- **Machine:** build the smallest reliable blocks, validate them, supervise rollout, and keep a kill switch where needed.

## Domain adaptation rule

The core must remain profession-agnostic.

When a domain appears:

1. Learn its terminology, entities, constraints, quality standards, and sources from evidence.
2. Keep domain-specific context inside the relevant workspace first.
3. Store workspace-specific durable knowledge under that workspace's `knowledge/`.
4. Promote knowledge to root `knowledge/` only when it is genuinely reusable beyond one workspace.
5. Keep workspace-only skills under the workspace when practical; promote a skill to the shared capability layer only when its method is sufficiently reusable and portable.
6. Add stricter verification and approval for regulated, safety-critical, financial, legal, medical, security-sensitive, or otherwise high-stakes work.
7. Never infer that a domain-specific workflow is safe merely because a similar workflow exists in another domain.

Do not create permanent root folders such as `medicine/`, `filmmaking/`, `coding/`, or `marketing/` by default. Create domain structure only when real usage justifies it.

## Workspace rule

A workspace is the universal isolation primitive.

Every substantial workspace should have a `WORKSPACE.yaml` manifest. Use `system/schemas/workspace.schema.yaml` and `workspaces/_template/` as the contract.

A workspace should answer:

- What is this scope?
- Why does it exist?
- What type is it?
- Which domains does it touch?
- What is currently active?
- Which sources are authoritative?
- Which connections may it use?
- Which outputs does it produce?
- What privacy or approval constraints apply?

Do not force a workspace into a fixed industry taxonomy. `type` and `domains` are extensible strings.

## Knowledge lifecycle

Raw information must be classified before it becomes truth.

Typical flow:

`inbox -> classify -> current context / memory / knowledge / decision / capability / archive`

Use these distinctions:

- **Inbox:** unclassified incoming material.
- **Context:** what matters now.
- **Memory:** what happened and may matter later.
- **Knowledge:** durable information, procedures, models, terminology, or conclusions that should be reusable.
- **Decision:** a settled choice plus reasoning and constraints.
- **Skill:** repeatable AI-guided execution logic.
- **Automation:** a trigger or schedule that runs reliable work.
- **Archive:** preserved material that is no longer current.

Do not promote tentative brainstorming into canonical facts. Do not let old memory silently override current context.

## Source-of-truth order

When sources disagree, use the narrowest applicable canonical source and preserve provenance.

1. `AGENTS.md` wins for runtime behavior.
2. `AI-VERSE.yaml` wins for architecture and routing paths.
3. `system/architecture/` explains architecture intent.
4. A workspace's `WORKSPACE.yaml` wins for workspace identity and declared boundaries.
5. Ownership-aware current scoped context from `scripts/current-context.mjs` wins over raw current files and older memory for current-state questions.
6. Decisions explain why settled choices changed.
7. Curated knowledge wins over raw inbox material.
8. Archives and frozen pre-handover strategy never silently override active truth.
9. Search indexes, embeddings, caches, generated catalogs, and summaries are derived views, never canonical truth by themselves.

See `system/architecture/source-of-truth.md`.

## Capability rule

A capability should contain execution logic, not a duplicate encyclopedia.

Prefer:

- skills for repeatable AI-guided work
- scripts for deterministic work
- templates for repeated artifact shapes
- knowledge for durable information
- agents for orchestration across capabilities
- automations for schedules and event triggers
- apps for persistent interfaces

Use `SKILL-AUTHORING.md` when creating or promoting a capability.

## Installed foundation capabilities

- `/onboard`: establish domain-neutral operator context and initial workspace routes.
- `/workspace`: create or evolve a universal isolated workspace.
- `/grill-me`: capture knowledge still in the operator's head without mixing confirmed facts and exploration.
- `/link`: make a source findable without duplicating it.
- `/audit`: verify architecture, Four Cs, routing, freshness, isolation, and evidence.
- `/level-up`: use the Three Ms to ship one useful improvement.
- `/3d-brain`: build a local visual knowledge explorer from selected sources.

## Writeback rules

Write durable state only when it has a clear home and future value.

- operator facts -> `operator/profile/`
- operator current priorities/state -> `operator/context/`
- operator history/learnings -> `operator/memory/`
- operator decisions -> `operator/decisions/`
- shared reusable knowledge -> `knowledge/`
- workspace current state -> `workspaces/<id>/context/`
- workspace memory -> `workspaces/<id>/memory/`
- workspace durable knowledge -> `workspaces/<id>/knowledge/`
- workspace decisions -> `workspaces/<id>/decisions/`
- live source registry -> `connections/registry.yaml`
- generated or disposable state -> `runtime/`

If no canonical location exists, consult `EXPANSIONS.md` before creating a new top-level folder.

## Privacy and safety

- Never store passwords, API keys, private keys, recovery codes, session tokens, or authentication secrets in the repository.
- User-owned state is gitignored by default in the public template. Do not defeat that protection casually.
- Respect workspace privacy boundaries. Do not leak one workspace's private context into another workspace without a legitimate reason.
- Treat external actions, publishing, financial operations, destructive changes, and high-stakes domain decisions as requiring appropriate approval and verification.
- When a live connection cannot be tested, call it unverified rather than connected.

## Legacy compatibility

Older installations may contain `context/`, `references/`, `decisions/`, and `connections.md` from architecture v1.

Preserve them. Do not delete or bulk-move existing user information without explicit migration intent. For new canonical user state, use the v2 paths in `AI-VERSE.yaml`. During migration, record which source is current rather than keeping two editable copies indefinitely.

## Working rules

- Answer the task before adding optional ideas.
- Do not invent missing facts.
- Reuse known context instead of re-asking for it.
- Ask only questions whose answers materially change the result.
- Prefer canonical sources over duplicate notes.
- Prefer deterministic operations when they are reliable enough.
- Use the lowest autonomy level that works.
- Validate outputs before chaining them.
- Keep the universal core small. Let real work earn additional structure.
