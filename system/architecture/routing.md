# Routing Protocol

AI-Verse OS should route from the user's intent to the smallest relevant context and capability rather than scanning everything.

## Default route

```text
request
  -> identify intent
  -> identify scope
  -> load current context
  -> choose capability
  -> retrieve minimum required knowledge
  -> resolve required connections
  -> execute
  -> validate
  -> write back only when warranted
```

## Identify scope

Possible scopes are:

- **system:** architecture, capabilities, updates, health
- **operator:** preferences, goals, cross-workspace priorities
- **workspace:** one isolated unit of work
- **shared:** reusable knowledge or cross-workspace capability

If one workspace is clearly active, do not load unrelated workspaces.

## Load order

For workspace work, prefer:

1. `WORKSPACE.yaml`
2. workspace `context/CURRENT.md`
3. applicable workspace policies/decisions
4. relevant skill
5. only the necessary workspace knowledge/memory/assets
6. live connections when current external state is needed

For operator-wide work, start from operator current context and profile, then retrieve deeper memory/knowledge only as needed.

## Capability selection

Prefer the smallest tool that reliably solves the task:

- deterministic script before probabilistic reasoning when enough
- one focused skill before a giant agent
- agent when coordination across capabilities is genuinely needed
- automation only after the underlying workflow is reliable
- app only when persistent interaction adds value

## Retrieval discipline

- Do not load all memory at startup.
- Do not search every workspace for a clearly scoped request.
- Do not treat semantic similarity as proof of authority.
- Do not re-ask for information already available in canonical context.
- Do not load sensitive workspace information into unrelated scopes.

## Writeback

Not every output deserves memory.

Write back when the result changes current state, creates durable knowledge, records an important decision, improves a reusable capability, or establishes a useful source route.

Transient calculations, intermediate drafts, caches, and generated indexes belong in runtime/output surfaces, not durable memory by default.
