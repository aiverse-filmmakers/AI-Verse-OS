# The Four Cs - Context, Connections, Capabilities, Cadence

The Four Cs describe the architecture of a useful AI operating system. They are also the main structure used by `/audit`.

The layers build on one another. Context comes first. Connections and capabilities can develop in parallel. Cadence comes after the workflow already works reliably when triggered manually.

## 1. Context

**Question:** Does the AI know enough about the operator and the work to respond accurately?

Useful context can include:

- who the operator is
- business model and audience
- priorities
- active projects
- brand and voice guidance
- decisions and constraints
- durable reference knowledge
- source authority and freshness

### Evidence that Context works

A fresh session can answer important questions by finding the correct saved sources instead of guessing or requiring the operator to restate everything.

### Common failure modes

- important knowledge exists only in the operator's head
- the same fact appears in several places and conflicts
- current information is mixed with old archived material
- the AI cannot discover the correct file from the operating manual
- context exists but is too large or poorly routed to be useful

## 2. Connections

**Question:** Can the AI reach the systems where live work and information exist?

Examples include:

- email
- calendar
- cloud storage
- GitHub
- Skool or community platforms
- project management
- CRM
- analytics
- finance systems
- social platforms
- local files
- APIs and databases

A connection may use a plugin, MCP, API, CLI, script, export pipeline, or carefully controlled browser automation.

### Evidence that Connections work

The AI can retrieve relevant real information when asked, and the connection's source, permissions, and freshness are understood.

### Common failure modes

- a tool is listed in `connections.md` but is not actually connected
- authentication expired
- the AI reads a stale export while a live source exists
- permissions are broader than necessary
- the connection works but nobody documented how it works

## 3. Capabilities

**Question:** Can the AI reliably perform useful multi-step work?

Capabilities are expressed through skills, scripts, SOPs, reusable workflows, templates, and combinations of those pieces.

A strong capability has:

- a clear trigger
- known inputs
- execution steps
- decision rules
- guardrails
- a defined output
- verification
- references instead of repeated rediscovery

### Evidence that Capabilities work

A short request triggers a repeatable workflow that produces a usable result without rebuilding the method from scratch every session.

### Common failure modes

- long prompts are mistaken for robust skills
- no verification exists
- the skill depends on undocumented assumptions
- the workflow silently changes important user assets
- several skills duplicate the same logic and drift apart
- a skill is installed but has never been used successfully

## 4. Cadence

**Question:** Can mature workflows operate without the operator manually re-triggering every step?

Cadence includes:

- scheduled runs
- event triggers
- recurring reports
- monitors
- alerts
- queues
- approval checkpoints
- exception handling

Cadence should be the last layer added to a workflow. Do not schedule a process that is still unreliable when run manually.

### Evidence that Cadence works

A useful output arrives or an action occurs at the expected time or event, with appropriate logs, review rules, and failure handling.

### Common failure modes

- automating before the workflow is proven
- no monitoring or kill switch
- duplicate runs
- hidden costs
- no human review for risky outputs
- schedules continue after the workflow is obsolete

## Dependency model

```text
Context
  ↓
Connections + Capabilities
  ↓
Cadence
```

Context is the base because an AI that cannot find the correct truth will make every later layer less reliable.

Connections and capabilities can grow together. A new connection often unlocks a new skill, while a useful skill often reveals which connection is missing.

Cadence is earned through evidence. First make the workflow correct. Then make it repeatable. Then automate when it runs.

## Audit principle

The Four Cs should be scored using evidence, not folder counts.

Having `connections.md` does not prove a connection works. Having ten skill folders does not prove useful capabilities. Having a scheduled job does not prove cadence is healthy.

`/audit` should distinguish:

- confirmed working evidence
- confirmed defects
- verification gaps
- stale information
- intentional differences between runtimes
- optional improvements

The goal is not to maximize a score. The goal is to make AI-Verse OS more dependable for real work.
