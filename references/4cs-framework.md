# The Four Cs - Context, Connections, Capabilities, Cadence

The Four Cs describe the capability architecture of a useful AI operating system. They are domain-neutral and are used by `/audit` to evaluate real operation.

The Four Cs are conceptual layers, not a requirement to create four duplicated folder trees.

Context comes first. Connections and capabilities can develop in parallel. Cadence should follow only after the underlying workflow is reliable enough to run repeatedly.

## 1. Context

**Question:** Does the AI know enough about the relevant operator and work scope to respond accurately without loading unrelated information?

Useful context may include:

- operator roles and working preferences
- current priorities
- active workspaces
- workspace objectives and current state
- decisions and constraints
- domain terminology or standards when relevant
- source authority and freshness
- pointers to deeper memory and knowledge

### Evidence that Context works

A fresh session can identify the correct scope, find current canonical sources, and answer important questions without guessing or forcing the operator to reconstruct everything manually.

### Common failure modes

- important knowledge exists only in someone's head
- operator-wide and workspace-specific facts are mixed together
- current state is buried inside long history
- the same fact has several editable copies
- archived or tentative material silently overrides current truth
- the AI loads unrelated workspaces into every task
- source authority or freshness is unclear

## 2. Connections

**Question:** Can the AI reach the systems or sources where current work and evidence actually exist?

Connections may include:

- local or cloud files
- repositories
- calendars
- communication systems
- collaboration/project systems
- databases and APIs
- records or specialist software
- analytics or measurement systems
- publishing/delivery systems
- financial or operational systems when relevant
- devices, sensors, or other machine-readable sources
- controlled browser access or approved exports

A connection may use a plugin, API, CLI, script, MCP-style protocol, local adapter, export pipeline, or another mechanism.

### Evidence that Connections work

The AI can retrieve the required real information when asked, and the route's authority, scope, permissions, and freshness are understood.

`connections/registry.yaml` documents the route. The registry itself is not proof that access works.

### Common failure modes

- a source is listed but cannot actually be reached
- authentication expired
- permissions are broader than necessary
- one workspace can access another workspace's restricted source without justification
- a stale export is treated as current while a better live source exists
- integration knowledge exists only in one person's memory
- secrets are stored in repository files

## 3. Capabilities

**Question:** Can the AI reliably perform useful repeatable work within the correct scope and boundaries?

Capabilities may be expressed through:

- skills
- deterministic scripts
- templates
- reusable workflows
- workspace-local procedures
- agents that orchestrate several capabilities
- combinations of these

A strong capability has:

- a recognizable trigger
- explicit scope
- known inputs and authoritative sources
- ordered execution
- decision rules
- permissions/approval boundaries
- guardrails
- a defined output and destination
- verification
- failure behavior
- references instead of repeated rediscovery

### Evidence that Capabilities work

A short request can invoke a documented method that produces a usable result without rebuilding the process from scratch or depending on hidden chat history.

### Common failure modes

- long prompts are mistaken for robust capabilities
- no verification exists
- domain assumptions are undocumented
- workspace-specific facts are embedded inside a supposedly shared skill
- an agent duplicates the knowledge and logic of several skills
- deterministic work is unnecessarily delegated to an LLM
- a capability exists but has never worked successfully on real inputs

## 4. Cadence

**Question:** Can mature workflows run from schedules or events without the operator manually re-triggering every step, while preserving control?

Cadence includes:

- schedules
- event triggers
- queues
- monitors
- alerts
- recurring reports
- approval checkpoints
- retries and deduplication
- exception handling
- escalation and kill switches

Cadence should be earned. Do not schedule an unreliable process simply because a scheduler is available.

### Evidence that Cadence works

A useful output or action occurs when expected, using the correct scope and source, with suitable permissions, logs/evidence, review rules, and failure handling.

### Common failure modes

- automating before the workflow is proven
- no evidence the scheduled job actually runs
- duplicate executions
- silent failures
- no approval for consequential actions
- no monitoring or kill switch
- schedules continue after the underlying process is obsolete
- automation writes state into the wrong workspace or source-of-truth layer

## Dependency model

```text
Context
   ↓
Connections + Capabilities
   ↓
Cadence
```

Context is the base because an AI that cannot find the correct scoped truth makes every later layer less reliable.

Connections and capabilities often grow together. A new source can unlock a capability, while a useful capability can reveal which connection is missing.

Cadence is earned through evidence: first make the workflow correct, then repeatable, then safely triggerable.

## Relationship to architecture v2

The Four Cs map naturally onto the Unified Workspace Architecture without becoming folder names:

- **Context** -> operator/workspace context, memory, knowledge, decisions
- **Connections** -> `connections/` and workspace source routes
- **Capabilities** -> skills, scripts, agents, templates, workflows
- **Cadence** -> automations and runtime execution evidence

Apps may expose any of these layers but do not replace their canonical sources.

## Audit principle

Score Four Cs using evidence, not folder counts.

A registry entry does not prove access. Ten skill folders do not prove useful capability. A job file does not prove cadence. A large memory index does not prove the right context can be retrieved.

`/audit` should distinguish confirmed operation, confirmed defects, verification gaps, stale/conflicting sources, isolation/authority defects, intentional runtime differences, and optional improvements.

The goal is not to maximize a score. The goal is dependable real work in the correct scope.
