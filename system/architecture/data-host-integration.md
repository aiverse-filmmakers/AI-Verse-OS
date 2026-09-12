# AI-Verse Data Host Integration

AI-Verse Data remains an optional extension. AI-Verse OS does not vendor its database engine, own its records, or open its SQLite files directly.

The supported OS boundary is:

```text
node scripts/data-host.mjs --root <ai-verse-os-root>
```

It accepts one JSON request on stdin and returns one JSON response on stdout.

## Ownership

AI-Verse OS owns:

- trusted OS and workspace identity;
- extension registration discovery;
- action-permission floors;
- the decision to dispatch an operator request.

AI-Verse Data owns:

- Data Spaces and schemas;
- canonical structured records;
- query/aggregate execution;
- relations and transactions;
- idempotency;
- mutation events and receipts;
- Data database integrity, migration, backup, and recovery.

The OS host never opens `ai-verse-data.sqlite`.

## Extension loading

The host reads:

```text
.aiverse/extensions/registry.json
```

and requires `extensions["ai-verse-data"]` to be:

```text
supported: true
installed: true
enabled: true
```

The registered engine path must be repository-relative, remain inside the OS root, and resolve to a regular non-symlink file.

The engine must expose:

```js
describe()
handleRequest(request)
```

and identify the Data host protocol as:

```text
ai-verse-data-host/1.0
```

Registration is still not proof of permission. Every OS request is checked again at dispatch time.

## OS request protocol

The OS-side envelope is:

```json
{
  "protocol": "ai-verse-os-data-host/1.0",
  "request_id": "req-123",
  "operation": "request",
  "scope": "workspace:sales",
  "reason": "Show active deals",
  "data": {
    "operation": "data.query",
    "payload": {
      "spaceId": "crm",
      "entity": "deals",
      "limit": 50
    }
  }
}
```

Supported host operations are:

- `describe`
- `discover`
- `init`
- `request`

Workspace initialization is explicit. A normal Data request never creates a missing workspace database as a side effect.

## Permission mapping

The host maps Data operations onto the OS action-permission boundary before calling Data.

Read-only operations use `read_local`.

Ordinary canonical writes use `modify_canonical_state`.

The following use the stricter `delete_data` class:

- `data.record.delete`;
- a transaction containing `data.record.delete`;
- a bulk execution containing `data.record.delete`;
- `data.schema.migration.execute`.

If OS policy returns `approval_required`, the Data engine is not invoked and the host returns a no-effect approval-required result. The current boundary does not forge or self-satisfy human approval.

## Actor binding

The native interactive OS bridge does not accept model-supplied actor or authorization objects.

The installed Data engine binds this path to:

```text
actor: human:local-operator
authorization: local-operator
workspace: exact OS-resolved workspace
```

Bot, Worker, App, Brain, Memory, Dashboard, Connections, and Automation integrations continue to use their dedicated Data adapter contracts.

## Failure behavior

The host fails closed when:

- the OS root is incompatible;
- the Data registration is absent, unsupported, uninstalled, or disabled;
- the registered engine path is unsafe;
- the engine host protocol is incompatible;
- the workspace scope is malformed or inactive;
- OS permission denies the action;
- destructive action approval is still required;
- Data rejects the request, schema, record, transaction, migration, or database state.

No fallback opens SQLite directly.

## Acceptance

`scripts/test-data-host.mjs` verifies:

- enabled registered-engine loading;
- exact workspace forwarding;
- read dispatch;
- non-destructive canonical write dispatch;
- destructive direct and nested mutation approval blocking;
- disabled-extension fail-closed behavior;
- explicit discovery and initialization forwarding.

The dedicated CI matrix runs this test on Node 22 and Node 24 across Linux, macOS, and Windows.
