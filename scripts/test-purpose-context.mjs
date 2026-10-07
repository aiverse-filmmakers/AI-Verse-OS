#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readPurposeCurrentContext, resolvePurposeScope } from './purpose-context-core.mjs';

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

  setBrainOwner(root, 'operator');
  const brainRead = readPurposeCurrentContext(root, 'operator');
  assert.equal(brainRead.current.direction_owner, 'brain');
  assert.doesNotMatch(brainRead.current.current_context, /OS STRATEGIC PRIORITY/);
  assert.match(brainRead.current.current_context, /operational decision/);
  assert.deepEqual(brainRead.current.direction_refs, ['brain:intent:goal-1']);

  process.stdout.write('Purpose Context scope/current-context boundary: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
