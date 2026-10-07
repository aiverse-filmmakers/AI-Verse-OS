#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePurposeScope } from './purpose-context-core.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-context-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'client-a', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'client-a', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: "client-a"\n', 'utf8');
  return root;
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

  process.stdout.write('Purpose Context scope resolution: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
