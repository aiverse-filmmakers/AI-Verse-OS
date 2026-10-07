#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readPurposeCurrentContext,
  readPurposeStrategicDirection,
  resolvePurposeScope,
} from './purpose-context-core.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-context-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'client-a', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'client-a', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: "client-a"\n', 'utf8');
  return root;
}

function setBrainOwner(root, scope, refs = ['brain:intent:goal-1']) {
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: { [scope]: { owner: 'brain', state: 'active', handover_id: 'purpose-test', brain_refs: refs } },
  }, null, 2));
}

const root = makeRoot();
try {
  assert.deepEqual(
    Object.fromEntries(Object.entries(resolvePurposeScope(root, 'operator')).filter(([key]) => key !== 'boundary')),
    {
      scope: 'operator',
      scope_kind: 'operator',
      identity: { kind: 'operator', id: 'operator' },
    },
  );

  assert.deepEqual(
    Object.fromEntries(Object.entries(resolvePurposeScope(root, 'workspace:client-a')).filter(([key]) => key !== 'boundary')),
    {
      scope: 'workspace:client-a',
      scope_kind: 'workspace',
      identity: { kind: 'workspace', id: 'client-a' },
    },
  );

  assert.throws(() => resolvePurposeScope(root, 'workspace:Client A'), /invalid scope/);
  assert.throws(() => resolvePurposeScope(root, 'workspace:missing'), /workspace missing does not exist/);
  assert.throws(() => resolvePurposeScope(root, 'workspace:../escape'), /invalid scope/);

  const alias = path.join(root, 'workspaces', 'alias');
  try {
    fs.symlinkSync(path.join(root, 'workspaces', 'client-a'), alias, 'dir');
    assert.throws(() => resolvePurposeScope(root, 'workspace:alias'), /must not be a symlink/);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }

  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '# Current Operator Context', '',
    '## Current priorities', '', '- OS STRATEGIC PRIORITY', '',
    '## Pending decisions', '', '- operational decision', '',
  ].join('\n'));

  const osRead = readPurposeCurrentContext(root, 'operator');
  assert.equal(osRead.current.direction_owner, 'os');
  assert.match(osRead.current.current_context, /OS STRATEGIC PRIORITY/);
  assert.match(osRead.current.current_context, /operational decision/);

  let brainCalls = 0;
  const osStrategic = readPurposeStrategicDirection(root, 'operator', {
    readBrainPurposeSnapshot() {
      brainCalls += 1;
      throw new Error('Brain reader must not be called while OS owns direction');
    },
  });
  assert.equal(osStrategic.strategic.owner, 'ai-verse-os');
  assert.equal(osStrategic.strategic.owner_path, 'current-context');
  assert.match(osStrategic.strategic.current_context, /OS STRATEGIC PRIORITY/);
  assert.equal(brainCalls, 0);

  setBrainOwner(root, 'operator');
  const views = path.join(root, '.aiverse', 'direction', 'views');
  fs.mkdirSync(views, { recursive: true });
  fs.writeFileSync(path.join(views, 'operator.md'), '# generated stale view\n\nNEVER CANONICAL\n');

  const brainRead = readPurposeCurrentContext(root, 'operator');
  assert.equal(brainRead.current.direction_owner, 'brain');
  assert.doesNotMatch(brainRead.current.current_context, /OS STRATEGIC PRIORITY/);
  assert.match(brainRead.current.current_context, /operational decision/);
  assert.deepEqual(brainRead.current.direction_refs, ['brain:intent:goal-1']);

  const brainStrategic = readPurposeStrategicDirection(root, 'operator', {
    readBrainPurposeSnapshot(scope) {
      brainCalls += 1;
      assert.equal(scope, 'operator');
      return {
        schema_version: '1.0',
        scope,
        direction_owner: 'brain',
        status: 'ok',
        read_states: {},
        strategic_objects: {
          intents: [{
            id: 'mission-1',
            kind: 'intent',
            semantic_kind: 'mission',
            scope,
            status: 'ACTIVE',
            revision: 4,
            canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission-1', version: '4' },
            payload: { subtype: 'mission', statement: 'BRAIN CANONICAL MISSION' },
          }],
          gaps: [],
          initiatives: [],
        },
        relationships: [],
        relationship_rejections: [],
      };
    },
  });
  assert.equal(brainStrategic.strategic.owner, 'ai-verse-brain');
  assert.equal(brainStrategic.strategic.owner_path, 'brain-purpose-snapshot');
  assert.equal(brainStrategic.strategic.snapshot.strategic_objects.intents[0].payload.statement, 'BRAIN CANONICAL MISSION');
  assert.equal(brainCalls, 1);
  assert.doesNotMatch(JSON.stringify(brainStrategic.strategic.snapshot), /OS STRATEGIC PRIORITY|NEVER CANONICAL/);

  const unavailable = readPurposeStrategicDirection(root, 'operator');
  assert.equal(unavailable.strategic.status, 'unavailable');
  assert.equal(unavailable.strategic.reason, 'brain_public_reader_unavailable');
  assert.equal(unavailable.strategic.snapshot, null);

  assert.throws(
    () => readPurposeStrategicDirection(root, 'operator', {
      readBrainPurposeSnapshot: () => ({ scope: 'workspace:other', direction_owner: 'brain', status: 'ok' }),
    }),
    /violated declared owner\/scope contract/,
  );

  process.stdout.write('Purpose Context owner-bound reads: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
