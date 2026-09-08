# Source of Truth

AI-Verse OS must be able to explain which source wins when two files, memories, indexes, or connected systems disagree.

## Authority principles

### Runtime behavior

`AGENTS.md` is the canonical runtime contract.

Runtime adapters such as `CLAUDE.md` point back to it. Do not maintain parallel full copies of standing instructions.

### Architecture

`AI-VERSE.yaml` is the machine-readable source for paths, ownership, and routing rules. `system/architecture/` explains the intent behind those rules.

### Current state

Use the narrowest applicable current-context source:

1. active workspace `context/CURRENT.md`
2. operator `context/CURRENT.md`
3. deeper memory/knowledge only when needed

Current context may summarize deeper sources, but summaries should point to authoritative evidence when important.

### Workspace identity

A workspace's `WORKSPACE.yaml` is authoritative for its ID, type, scope, declared domains, boundaries, and source routes.

### Knowledge

Curated knowledge wins over unclassified inbox material. Workspace knowledge wins for workspace-specific claims. Root `knowledge/` is for shared reusable knowledge.

### Decisions

Decision logs are append-oriented records of settled choices and reasoning. If a decision changes, add a superseding entry rather than rewriting history.

### Live external data

For questions about current external state, a verified live source may outrank an older local snapshot. The connection registry must describe the route, but a registry entry alone does not prove current access.

### Derived data

The following are never canonical merely because retrieval is convenient:

- vector indexes
- embeddings
- search caches
- generated catalogs
- dashboards
- app-local copies
- summaries without provenance
- temporary reports

They may accelerate discovery, but the underlying source must remain recoverable.

## Conflict handling

When sources conflict:

1. identify scope
2. identify each source's authority and timestamp
3. prefer the narrower current canonical source
4. preserve meaningful provenance
5. do not silently merge incompatible claims
6. if ambiguity remains consequential, surface it or ask for resolution

## Anti-duplication rule

A route, index, or summary may point to truth. It should not become a second independently edited truth unless the architecture explicitly defines synchronization and authority.
