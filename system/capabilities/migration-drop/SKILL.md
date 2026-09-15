---
name: migration-drop
description: Automatically use when a fresh or early AI-Verse session receives a large pasted or exported block of accumulated personal, business, client, project, preference, history, or prior-assistant memory/context from ChatGPT, Hermes, Claude, Codex, another agent, notes export, or a previous AI system, even when the user gives no explicit import instruction. Safely organize the supplied material through existing AI-Verse workspace, Memory, and Data owners without asking the user to choose internal architecture.
---

# Migration Drop

Use this capability to turn an accumulated prior-assistant context dump into useful AI-Verse state without making the user perform a manual migration ceremony.

## Automatic trigger

Treat the current user message as an implicit migration drop when all of these are true:

- this is a fresh or early AI-Verse installation/session;
- the message is primarily accumulated context rather than a normal task;
- it contains multiple durable facts, preferences, clients, projects, business areas, history, lessons, or structured records;
- it plausibly came from another assistant, memory export, profile summary, notes archive, or prior agent system.

The user does **not** need to say "import", "migrate", "remember this", or name AI-Verse subsystems.

Do not trigger merely because a normal work request is long.

If the message contains both a migration-sized context dump and a clear foreground task, organize the safe durable material first or alongside the task, then continue the requested work. Do not make migration a visible prerequisite unless an owner boundary blocks correct routing.

## Core rule

Classify first. Persist only what clearly deserves durable state.

Do not dump the entire source into Memory, Data, or a workspace.

The raw source remains evidence in the current runtime/chat. AI-Verse stores a source fingerprint and owner receipts, not a second raw copy of the whole migration text.

Use the existing canonical owners:

- clear substantial client/project/area -> OS workspace
- durable historical fact, preference, entity, event, experience, workflow, lesson -> Memory
- repeated, current, structured operational truth -> Data
- ambiguous, transient, secret-bearing, current-strategy, permission, credential, Connection, recurring-work, or durable-Bot material -> do not silently promote

Do not create Skills merely because the old system says a workflow existed. A reusable Skill must be learned from supported AI-Verse evidence under the normal Skills lifecycle.

Do not create permanent Bots or Automations from imported claims. Those require the normal explicit consent boundaries.

## Step 1 - inspect the source as evidence

Read the supplied migration text carefully and identify:

- operator-level durable history/preferences that are safe historical Memory;
- named substantial scopes such as clients, projects, products, practices, teams, research areas, or personal areas;
- historical items that clearly belong inside one of those scopes;
- current structured operational records that are repeated and high-confidence enough for Data;
- contradictions, stale statements, tentative ideas, secrets, credentials, permissions, strategic claims, and ambiguous private material that must not be auto-promoted.

Never infer a credential, Connection, permission grant, strategic handover, permanent Bot, recurring Automation, or destructive migration from the dump.

If two statements conflict, do not silently choose one unless the source itself clearly establishes a correction/supersession relationship. Otherwise leave the conflict uncommitted.

## Step 2 - build one bounded migration plan

Prepare one JSON payload with exactly:

```json
{
  "source": {
    "kind": "prior-assistant-memory",
    "text": "<the exact supplied migration text>",
    "label": "<short source label>"
  },
  "plan": {
    "workspaces": [],
    "memories": [],
    "data": []
  }
}
```

Choose a source kind such as `chatgpt-memory`, `hermes-memory`, `claude-memory`, `prior-assistant-memory`, or another short accurate label.

### Workspace items

Each workspace item must match the existing `workspace.ensure` contract:

```json
{
  "workspace": {
    "id": "client-alpha",
    "name": "Client Alpha",
    "type": "client",
    "purpose": "Keep ongoing Client Alpha work isolated.",
    "domains": ["delivery"],
    "canonical_sources": []
  },
  "evidence": {
    "substantial_scope": true,
    "boundary_clear": true,
    "reason": "The migration source clearly describes an ongoing named client."
  },
  "authority": {
    "permission_expansion": false,
    "privacy_ambiguous": false,
    "new_connection": false,
    "new_credential": false
  }
}
```

Create only substantial scopes. Prefer one workspace per clearly distinct client/project/area. Reuse/evolve matching existing workspaces rather than inventing near-duplicates.

Do not include trusted provenance. The migration owner supplies it.

### Memory items

Each Memory item uses the existing safe Memory candidate fields plus an optional target `scope`:

```json
{
  "scope": "workspace:client-alpha",
  "type": "lesson",
  "text": "A durable historical item supported by the migration source.",
  "importance": 3,
  "confidence": 0.95,
  "why": "Why this will matter later.",
  "tags": "client-alpha,migration",
  "admission": {
    "durable": true,
    "historical": true,
    "current_truth": false,
    "contains_secret": false,
    "strategic": false,
    "permission_expansion": false,
    "privacy_ambiguous": false,
    "external_authority": false
  }
}
```

Use `operator` scope for cross-workspace history/preferences and `workspace:<id>` for scope-specific history.

Do not provide `source`, `evidence_refs`, `effect_id`, or `workspace`. AI-Verse binds trusted migration provenance.

Do not create a Memory row for every sentence. Consolidate only when doing so does not erase materially distinct facts. Keep exact dates/numbers/identifiers where they matter.

### Data items

Use Data only for **current + structured + operational + repeated** truth.

A Data item contains `scope`, `candidate`, and optionally `evidence_spans`:

```json
{
  "scope": "workspace:client-alpha",
  "evidence_spans": [
    "<exact short excerpt from the migration source supporting the record>",
    "<another distinct exact excerpt from the source supporting the same current fact>"
  ],
  "candidate": {
    "suggested_owner": "data",
    "summary": "Current client contact state.",
    "confidence": 0.95,
    "repeated_evidence": true,
    "current_truth": true,
    "structured_operational": true,
    "contains_secret": false,
    "privacy_ambiguous": false,
    "permission_expansion": false,
    "destructive": false,
    "structure": {
      "space": {
        "spaceId": "crm",
        "name": "CRM",
        "authority": "local_canonical"
      },
      "schema": {
        "spaceId": "crm",
        "entity": "contacts",
        "name": "Contacts",
        "fields": {
          "name": {"type": "string", "required": true},
          "status": {"type": "string"}
        }
      }
    },
    "match": {"field": "name", "value": "Client Alpha"},
    "record": {"data": {"name": "Client Alpha", "status": "active"}}
  }
}
```

The natural-key match field must exist in both the schema and record.

Only set `repeated_evidence:true` when the source actually gives repeated support. When possible, include at least two **distinct exact excerpts** from the supplied source in `evidence_spans`. AI-Verse verifies that those excerpts really exist before producing trusted evidence references.

If current/repeated status is uncertain, do not force the item into Data. Preserve only eligible historical Memory and let later work establish current structured truth.

Do not provide trusted Data fields such as candidate IDs, scope inside the candidate, evidence refs, timestamps, actor, approval, authorization, or idempotency.

## Step 3 - execute through the same owner path

### Codex / Claude Code / direct runtime

From the AI-Verse OS root, invoke:

```bash
python3 scripts/migration-import.py --root .
```

Send the JSON payload above on stdin. Use a temporary runtime file only if the host runtime cannot provide stdin directly. If a temporary file is necessary:

- place it only under `runtime/`;
- never commit it;
- use restrictive local permissions where available;
- delete it immediately after the import attempt, including on failure.

Do not call owner databases directly and do not manually write Memory/Data canonical files as a shortcut.

### Gateway runtime

Use the existing `aiverse_action` tool:

- `action_class`: `write_local_reversible`
- `operation`: `migration.import`
- parameters: **only** `plan`

Do not send `source` through the tool. Gateway binds the exact user migration message as trusted source evidence.

## Step 4 - handle bounded limits safely

One import accepts at most:

- 1 MiB source text;
- 32 workspace candidates;
- 128 Memory candidates;
- 128 Data candidates.

If the source exceeds the supported bound, process it in logical source chunks that preserve the original wording and stable scope boundaries. Do not silently truncate.

## Step 5 - finish naturally

After the owner route succeeds, continue in normal user language.

A concise first-use response may say that the useful context was organized and that AI-Verse is ready to work.

Do not make the user review Memory vs Data vs Workspace choices.

Mention skipped/ambiguous material only when it materially affects what the user expects AI-Verse to know.

## Safety invariants

- raw migration text is not copied into canonical AI-Verse state wholesale;
- secrets and credential-like material are not persisted;
- workspace isolation remains authoritative;
- imported claims do not grant permissions or Connections;
- imported recurring work does not create Automations;
- imported role descriptions do not create permanent Bots;
- imported strategic claims do not transfer Brain/OS strategic authority;
- Data remains workspace-bound and owner-gated;
- Memory remains historical and owner-gated;
- exact replay is idempotent;
- owner refusal is final;
- ambiguity is safer than invented certainty.
