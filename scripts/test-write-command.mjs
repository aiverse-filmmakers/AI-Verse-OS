#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WRITE_COMMAND_PROVIDER,
  computeWriteCommandFingerprint,
  dispatchWriteCommand,
  enqueueWriteCommand,
  submitWriteCommand,
} from './write-command.mjs';

function fixture(status = 'active') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-write-command-'));
  fs.mkdirSync(path.join(root, 'operator'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), [
    'schema_version: "2.0"',
    'architecture: unified-workspace',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'workspaces', 'alpha', 'WORKSPACE.yaml'), [
    'schema_version: "2.0"',
    'id: alpha',
    `status: ${status}`,
    'approval:',
    '  external_actions: "allow"',
    '  destructive_actions: "confirm"',
    '  high_stakes_decisions: "human-review"',
    '',
  ].join('\n'));
  return root;
}

function request(overrides = {}) {
  const base = {
    schema_version: '1.0',
    request_id: 'req-write-1',
    scope: 'workspace:alpha',
    operation: 'candidate.route',
    parameters: {
      candidate_kind: 'knowledge',
      summary: 'Validated observation ready for owner routing',
      refs: ['artifact:one'],
    },
    idempotency_key: 'candidate-route-1',
    requested_by: 'ai-verse-multiple-bots',
    reason: 'Route a bounded write candidate to the OS owner boundary',
    created_at: '2026-09-12T00:00:00Z',
    provenance: {
      source: 'multiple-bots',
      task_id: 'task_example',
      artifact_refs: ['artifact_one'],
    },
  };
  const merged = { ...base, ...overrides };
  merged.request_fingerprint = computeWriteCommandFingerprint(merged);
  return merged;
}

function snapshotCanonical(root) {
  const paths = [
    'operator',
    'knowledge',
    'decisions',
    'workspaces/alpha',
  ];
  return paths.map((relative) => {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) return [relative, null];
    const items = [];
    for (const entry of fs.readdirSync(target, { recursive: true, withFileTypes: true })) {
      const full = path.join(entry.parentPath ?? entry.path ?? target, entry.name);
      const rel = path.relative(root, full);
      if (entry.isFile()) items.push([rel, crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
      else if (entry.isDirectory()) items.push([rel, 'dir']);
      else items.push([rel, 'other']);
    }
    return [relative, items.sort((a, b) => a[0].localeCompare(b[0]))];
  });
}

{
  const root = fixture();
  try {
    const before = snapshotCanonical(root);
    const result = enqueueWriteCommand({ osRoot: root, request: request() });
    assert.equal(result.provider, WRITE_COMMAND_PROVIDER);
    assert.equal(result.status, 'queued');
    assert.equal(result.effect_occurred, false);
    assert.equal(result.canonical_effect_occurred, false);
    assert.equal(result.replayed, false);
    assert.equal(result.host_permission.decision, 'allow');
    assert.equal(result.scope, 'workspace:alpha');
    assert.equal(result.operation, 'candidate.route');
    assert.match(result.command_id, /^os_write_[a-f0-9]{32}$/);

    const base = path.join(root, 'runtime', 'write-commands');
    assert.equal(fs.readdirSync(path.join(base, 'queue')).length, 1);
    assert.equal(fs.readdirSync(path.join(base, 'receipts')).length, 1);
    assert.deepEqual(snapshotCanonical(root), before, 'Phase 3.7 enqueue must not mutate canonical owner state');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const first = enqueueWriteCommand({ osRoot: root, request: request() });
    const second = enqueueWriteCommand({ osRoot: root, request: request() });
    assert.equal(second.command_id, first.command_id);
    assert.equal(second.queued_at, first.queued_at);
    assert.equal(second.replayed, true);
    assert.equal(fs.readdirSync(path.join(root, 'runtime', 'write-commands', 'queue')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    enqueueWriteCommand({ osRoot: root, request: request() });
    const changed = request({
      parameters: { candidate_kind: 'decision', summary: 'different semantic request' },
    });
    assert.throws(
      () => enqueueWriteCommand({ osRoot: root, request: changed }),
      /idempotency key is already bound to a different write command/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture('paused');
  try {
    assert.throws(
      () => enqueueWriteCommand({ osRoot: root, request: request() }),
      /workspace is paused/i,
    );
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'write-commands')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const forged = request();
    forged.request_fingerprint = '0'.repeat(64);
    assert.throws(
      () => enqueueWriteCommand({ osRoot: root, request: forged }),
      /request_fingerprint does not match/i,
    );
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'write-commands')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.platform !== 'win32') {
  const root = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-write-command-outside-'));
  try {
    fs.rmSync(path.join(root, 'runtime'), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, 'runtime'), 'dir');
    assert.throws(
      () => enqueueWriteCommand({ osRoot: root, request: request() }),
      /unsafe runtime\//i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const invalid = request({ scope: 'workspace:../escape' });
    invalid.request_fingerprint = computeWriteCommandFingerprint(invalid);
    assert.throws(
      () => enqueueWriteCommand({ osRoot: root, request: invalid }),
      /scope is invalid/i,
    );
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'write-commands')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}


{
  const root = fixture();
  try {
    const req = request();
    const result = submitWriteCommand({ osRoot: root, request: req });
    assert.equal(result.status, 'completed');
    assert.equal(result.effect_occurred, true);
    assert.equal(result.canonical_effect_occurred, true);
    assert.equal(result.result.canonical_owner, 'ai-verse-os');
    assert.equal(result.result.canonical_layer, 'inbox');
    assert.equal(result.result.classification_state, 'unclassified');
    assert.equal(result.result.promotion_occurred, false);
    assert.equal(result.effect_permission.action_class, 'modify_canonical_state');

    const candidate = path.join(root, result.result.path);
    assert.equal(fs.existsSync(candidate), true);
    const routed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    assert.equal(routed.status, 'unclassified');
    assert.equal(routed.canonical_owner, 'ai-verse-os');
    assert.equal(routed.candidate.summary, req.parameters.summary);
    assert.equal(routed.promotion_occurred, false);
    assert.equal(fs.existsSync(path.join(root, 'knowledge')), false);
    assert.equal(fs.existsSync(path.join(root, 'decisions')), false);

    const replay = submitWriteCommand({ osRoot: root, request: req });
    assert.equal(replay.status, 'completed');
    assert.equal(replay.replayed, true);
    assert.equal(fs.readdirSync(path.dirname(candidate)).filter(name => name.startsWith('write-candidate-')).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const req = request();
    const queued = enqueueWriteCommand({ osRoot: root, request: req });
    assert.equal(queued.status, 'queued');

    const manifest = path.join(root, 'workspaces', 'alpha', 'WORKSPACE.yaml');
    fs.writeFileSync(manifest, [
      'schema_version: "2.0"',
      'id: alpha',
      'status: paused',
      'approval:',
      '  external_actions: "allow"',
      '  destructive_actions: "confirm"',
      '  high_stakes_decisions: "human-review"',
      '',
    ].join('\n'));

    assert.throws(
      () => dispatchWriteCommand({ osRoot: root, request: req }),
      /workspace is paused/i,
    );
    assert.equal(fs.existsSync(path.join(root, 'workspaces', 'alpha', 'inbox')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const unsupported = request({
      operation: 'memory.remember',
      idempotency_key: 'unsupported-owner-route-1',
    });
    unsupported.request_fingerprint = computeWriteCommandFingerprint(unsupported);
    enqueueWriteCommand({ osRoot: root, request: unsupported });
    assert.throws(
      () => dispatchWriteCommand({ osRoot: root, request: unsupported }),
      /no canonical OS-owned handler is registered/i,
    );
    const receipts = path.join(root, 'runtime', 'write-commands', 'receipts');
    const receipt = JSON.parse(fs.readFileSync(path.join(receipts, fs.readdirSync(receipts)[0]), 'utf8'));
    assert.equal(receipt.status, 'queued');
    assert.equal(receipt.canonical_effect_occurred, false);
    assert.equal(fs.existsSync(path.join(root, 'workspaces', 'alpha', 'inbox')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fixture();
  try {
    const operatorRequest = request({
      request_id: 'req-operator-route-1',
      scope: 'operator',
      idempotency_key: 'operator-route-1',
    });
    operatorRequest.request_fingerprint = computeWriteCommandFingerprint(operatorRequest);
    const result = submitWriteCommand({ osRoot: root, request: operatorRequest });
    assert.equal(result.result.path.startsWith('operator/inbox/'), true);
    assert.equal(fs.existsSync(path.join(root, result.result.path)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('OS write-command boundary acceptance OK');
