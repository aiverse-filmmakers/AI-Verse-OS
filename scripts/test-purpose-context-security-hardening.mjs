#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const cli = path.join(scriptsDir, 'purpose-context.mjs');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-security-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- OPERATOR ONLY PRIORITY', '',
    '## Current state', '', '- OPERATOR ONLY STATE', '',
  ].join('\n'), 'utf8');
  return root;
}

function addWorkspace(root, id, secret) {
  const dir = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(dir, 'context'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'WORKSPACE.yaml'), `schema_version: "2.0"\nid: ${id}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'context', 'CURRENT.md'), [
    '## Objective', '', `${secret} OBJECTIVE`, '',
    '## Current state', '', `- ${secret} STATE`, '',
  ].join('\n'), 'utf8');
}

function run(root, scope) {
  const result = spawnSync(process.execPath, [cli, 'read', '--root', root, '--scope', scope], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

// Slice 11.2 Test 1: operator scope cannot descend into workspace-owned context.
{
  const root = makeRoot();
  try {
    addWorkspace(root, 'alpha', 'ALPHA PRIVATE');
    addWorkspace(root, 'beta', 'BETA PRIVATE');

    const operator = run(root, 'operator');
    const serialized = JSON.stringify(operator);
    assert.equal(operator.scope, 'operator');
    assert.match(serialized, /OPERATOR ONLY STATE/);
    assert.match(serialized, /OPERATOR ONLY PRIORITY/);
    assert.doesNotMatch(serialized, /ALPHA PRIVATE|BETA PRIVATE/);
    for (const read of operator.provenance.owner_reads ?? []) {
      for (const ref of read.canonical_refs ?? []) {
        assert.doesNotMatch(String(ref), /workspace:alpha|workspace:beta|workspaces\/alpha|workspaces\/beta/);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('Purpose Context security hardening through Test 11.2.1: PASS\n');
