# Supported Four-Component Host Adapter

AI-Verse OS ships a maintained host adapter for composing AI-Verse OS, Memory, Brain, and Skills through Brain's public JSON-subprocess host contract.

The adapter is:

```text
scripts/ai_verse_host_adapter.py
```

It is a host boundary only. It does not own or duplicate canonical OS, Memory, Brain, or Skills state.

## Responsibilities

The adapter delegates each responsibility to its existing owner:

- current context: AI-Verse OS `scripts/current-context.mjs`
- history recall: the Memory runtime installed at `scripts/ai-verse-memory/memory.py`
- capability discovery and selection: AI-Verse OS `scripts/capability-resolver.mjs`
- action permission: AI-Verse OS `scripts/action-permission.mjs`
- immutable generation pinning: the AI-Verse Skills lifecycle entrypoint
- execution receipt semantics: AI-Verse Skills `execution_receipt_v2.py`
- cognition, Brain policy, approvals, replay safety, and objective verification: AI-Verse Brain

The adapter does not create another goal store, capability registry, memory database, permission system, or scheduler.

## Create a Brain host configuration

From an AI-Verse OS checkout with Memory installed and an external Skills installation:

```bash
python scripts/ai_verse_host_adapter.py \
  --root "$PWD" \
  --skills-root "$HOME/.aiverse/skills" \
  --skills-entrypoint /absolute/path/to/AI-Verse-Skills/installer/aiverse_skills.py \
  --write-config .aiverse/brain-host.json
```

The generated configuration uses Brain's `ai-verse-brain-bridge/1.0` JSON-subprocess contract and stores local paths only. It does not store credential values.

A non-default personal skills provider can be supplied with:

```bash
--local-skills-root /absolute/path/to/local-skills
```

## Use it with Brain

Run a Brain tick through the real OS host:

```bash
ai-verse-brain run-tick "$PWD" \
  --vendor claude \
  --host-adapter "$PWD/.aiverse/brain-host.json" \
  --trigger explicit
```

The same host config can be supplied to Brain cadence hooks instead of using the limited read-only host.

## Supported host operations

The adapter advertises:

- `read_context`
- `retrieve_history`
- `list_capabilities`
- `list_connections`
- `authorize_action`
- `request_action`

Capability discovery remains scoped by OS. Workspace-private capabilities are available only to their validated workspace scope.

## Supported capability execution proof

The maintained adapter currently supplies one intentionally harmless local execution path:

```text
action_class: read_local
operation: capability.read_instructions
```

The request must bind:

- the qualified `aiverse-skills:<id>` capability ID
- the exact expected Skills generation ID
- the exact `aiverse-package-sha256-v1` package digest

Before reading `SKILL.md`, the adapter:

1. re-selects the exact capability through the OS resolver;
2. requires the selected generation and package digest to match the request;
3. pins the active generation through the Skills lifecycle implementation;
4. reads only the package inside that immutable generation;
5. creates and validates an `aiverse-execution-receipt-v2` receipt through Skills' semantic validator;
6. returns the exact execution binding to Brain.

If the active Skills pointer changes after the pin, the in-flight read remains bound to the pinned immutable generation.

This proof is deliberately narrow. It demonstrates the maintained discover -> authorize -> pin -> invoke -> receipt path without pretending that every external operator is automatically executable. Operator-specific execution still requires its own runtime support, live readiness, permissions, approvals, and effect verification.

## Permission behavior

Brain calls the adapter's `authorize_action` operation before dispatch. The adapter delegates that decision to the OS action-permission gate. Brain intersects the result with its own policy.

An OS denial always blocks dispatch. OS `allow` never overrides a Brain denial or approval requirement.

## Acceptance

The public integration is continuously exercised by:

```text
.github/workflows/four-repo-acceptance.yml
scripts/test-ai-verse-host-adapter.py
```

The acceptance path uses the maintained adapter rather than an inline CI-only host and verifies:

- OS ownership-aware current context
- real Memory recall
- real Skills discovery
- Brain runtime composition
- harmless generation-pinned capability execution
- Skills v2 receipt validation and Brain receipt translation
- OS policy denial through the same host interface
- active-generation change during an in-flight pinned execution
- Memory workspace isolation
