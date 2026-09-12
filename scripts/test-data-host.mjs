import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DATA_ENGINE_PROTOCOL,
  OS_DATA_HOST_PROTOCOL,
  invokeDataHost,
} from './data-host.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-verse-os-data-host-'));
  fs.writeFileSync(
    path.join(root, 'AI-VERSE.yaml'),
    'schema_version: "2.0"\narchitecture: unified-workspace\n',
    'utf8',
  );
  fs.mkdirSync(path.join(root, 'operator'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'sales'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'workspaces', 'sales', 'WORKSPACE.yaml'),
    [
      'schema_version: "2.0"',
      'id: "sales"',
      'name: "Sales"',
      'type: "custom"',
      'status: "active"',
      'purpose: "Data host fixture"',
      'approval:',
      '  external_actions: "confirm"',
      '  destructive_actions: "confirm"',
      '  high_stakes_decisions: "human-review"',
      '',
    ].join('\n'),
    'utf8',
  );
  const extensionRoot = path.join(root, '.aiverse', 'extensions', 'ai-verse-data');
  fs.mkdirSync(extensionRoot, { recursive: true });
  const enginePath = path.join(extensionRoot, 'engine.mjs');
  fs.writeFileSync(
    enginePath,
    `import fs from 'node:fs';
const callLog = new URL('./calls.jsonl', import.meta.url);
export function describe() {
  return {
    protocol: ${JSON.stringify(DATA_ENGINE_PROTOCOL)},
    actorBinding: 'human:local-operator',
    authorizationBinding: 'local-operator',
    workspaceInitialization: 'explicit',
    dataProtocol: 'ai-verse-data/0.1'
  };
}
export async function handleRequest(request) {
  fs.appendFileSync(callLog, JSON.stringify(request) + '\\n', 'utf8');
  return { accepted: true, request };
}
`,
    'utf8',
  );
  const registryPath = path.join(root, '.aiverse', 'extensions', 'registry.json');
  fs.writeFileSync(
    registryPath,
    JSON.stringify(
      {
        schema_version: '1.0',
        extensions: {
          'ai-verse-data': {
            id: 'ai-verse-data',
            supported: true,
            installed: true,
            enabled: true,
            version: '0.1.0-alpha.0',
            source: 'AI-Verse-Data',
            instructions: '.aiverse/extensions/ai-verse-data/INSTRUCTIONS.md',
            engine: '.aiverse/extensions/ai-verse-data/engine.mjs',
            adapters: [],
          },
        },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return {
    root,
    registryPath,
    callLog: path.join(extensionRoot, 'calls.jsonl'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function request(overrides = {}) {
  return {
    protocol: OS_DATA_HOST_PROTOCOL,
    request_id: 'req-data-host-1',
    operation: 'request',
    scope: 'workspace:sales',
    reason: 'Test the registered Data host boundary',
    data: {
      operation: 'data.space.list',
      payload: {},
    },
    ...overrides,
  };
}

function calls(f) {
  if (!fs.existsSync(f.callLog)) return [];
  return fs.readFileSync(f.callLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('Data host loads only the enabled registered engine and binds workspace reads', async () => {
  const f = fixture();
  try {
    const result = await invokeDataHost({
      osRoot: f.root,
      request: request(),
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.effect_occurred, false);
    assert.equal(result.permission.decision, 'allow');
    assert.equal(result.result.accepted, true);
    assert.equal(result.result.request.operation, 'data.request');
    assert.equal(result.result.request.workspaceId, 'sales');

    const logged = calls(f);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].data.operation, 'data.space.list');
  } finally {
    f.cleanup();
  }
});

test('Data host allows non-destructive canonical writes after OS policy check', async () => {
  const f = fixture();
  try {
    const result = await invokeDataHost({
      osRoot: f.root,
      request: request({
        request_id: 'req-data-host-write',
        data: {
          operation: 'data.record.create',
          payload: {
            spaceId: 'crm',
            entity: 'deals',
            idempotencyKey: 'host:create:1',
            data: { title: 'Deal' },
          },
        },
      }),
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.effect_occurred, true);
    assert.equal(result.permission.action_class, 'modify_canonical_state');
    assert.equal(calls(f).length, 1);
  } finally {
    f.cleanup();
  }
});

test('Data host blocks destructive record, nested bulk/transaction, and schema migration effects pending approval', async () => {
  const f = fixture();
  try {
    const cases = [
      {
        request_id: 'req-delete',
        data: {
          operation: 'data.record.delete',
          payload: {
            spaceId: 'crm',
            entity: 'deals',
            recordId: 'rec_1',
            expectedVersion: 1,
            idempotencyKey: 'delete:1',
          },
        },
      },
      {
        request_id: 'req-txn-delete',
        data: {
          operation: 'data.transaction.execute',
          payload: {
            idempotencyKey: 'txn:1',
            operations: [
              {
                operation: 'data.record.delete',
                payload: {
                  spaceId: 'crm',
                  entity: 'deals',
                  recordId: 'rec_1',
                  expectedVersion: 1,
                  idempotencyKey: 'delete:2',
                },
              },
            ],
          },
        },
      },
      {
        request_id: 'req-bulk-delete',
        data: {
          operation: 'data.bulk.execute',
          payload: {
            idempotencyKey: 'bulk:1',
            expectedPreviewDigest: '0'.repeat(64),
            operations: [
              {
                operation: 'data.record.delete',
                payload: {
                  spaceId: 'crm',
                  entity: 'deals',
                  recordId: 'rec_1',
                  expectedVersion: 1,
                  idempotencyKey: 'delete:3',
                },
              },
            ],
          },
        },
      },
      {
        request_id: 'req-schema-migration',
        data: {
          operation: 'data.schema.migration.execute',
          payload: {
            spaceId: 'crm',
            entity: 'deals',
            expectedSchemaVersion: 1,
            changes: [{ op: 'remove_field', field: 'legacy' }],
            owner: { kind: 'human', id: 'local-operator' },
            idempotencyKey: 'migration:1',
            expectedPreviewDigest: '0'.repeat(64),
          },
        },
      },
    ];

    for (const item of cases) {
      const result = await invokeDataHost({
        osRoot: f.root,
        request: request(item),
      });
      assert.equal(result.status, 'approval_required');
      assert.equal(result.effect_occurred, false);
      assert.equal(result.permission.action_class, 'delete_data');
    }
    assert.deepEqual(calls(f), []);
  } finally {
    f.cleanup();
  }
});

test('Data host refuses disabled registrations before engine invocation', async () => {
  const f = fixture();
  try {
    const registry = JSON.parse(fs.readFileSync(f.registryPath, 'utf8'));
    registry.extensions['ai-verse-data'].enabled = false;
    fs.writeFileSync(f.registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');

    await assert.rejects(
      () => invokeDataHost({ osRoot: f.root, request: request() }),
      /AI-Verse Data is disabled/,
    );
    assert.deepEqual(calls(f), []);
  } finally {
    f.cleanup();
  }
});

test('Data host forwards explicit discovery and initialization through the engine', async () => {
  const f = fixture();
  try {
    const discover = await invokeDataHost({
      osRoot: f.root,
      request: request({
        request_id: 'req-discover',
        operation: 'discover',
        data: undefined,
      }),
    });
    assert.equal(discover.status, 'succeeded');
    assert.equal(discover.effect_occurred, false);

    const init = await invokeDataHost({
      osRoot: f.root,
      request: request({
        request_id: 'req-init',
        operation: 'init',
        data: undefined,
      }),
    });
    assert.equal(init.status, 'succeeded');
    assert.equal(init.effect_occurred, true);

    const logged = calls(f);
    assert.equal(logged[0].operation, 'workspace.discover');
    assert.equal(logged[1].operation, 'workspace.init');
  } finally {
    f.cleanup();
  }
});
