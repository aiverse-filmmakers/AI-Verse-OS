#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, '..');
const cli = path.join(scriptsDir, 'purpose-context.mjs');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-hardening-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- protect canonical owner truth', '',
    '## Current state', '', '- canonical owner state', '',
  ].join('\n'), 'utf8');
  return root;
}

function run(root, scope = 'operator') {
  const result = spawnSync(process.execPath, [cli, 'read', '--root', root, '--scope', scope], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function normalized(value) {
  const copy = structuredClone(value);
  if (copy.provenance) {
    copy.provenance.generated_at = '<volatile>';
    for (const read of copy.provenance.owner_reads ?? []) {
      read.observed_at = '<volatile>';
      if (read.freshness?.as_of) read.freshness.as_of = '<volatile>';
    }
  }
  return copy;
}

// Slice 11.1 Task 1: deleting generated Purpose views/caches cannot delete or alter canonical state.
{
  const root = makeRoot();
  try {
    const owner = path.join(root, 'operator', 'context', 'CURRENT.md');
    const manifest = path.join(root, 'AI-VERSE.yaml');
    const ownerHash = sha256(owner);
    const manifestHash = sha256(manifest);
    const before = run(root);

    assert.equal(fs.existsSync(path.join(root, 'PURPOSE.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.aiverse', 'purpose.json')), false);

    const cacheRoot = path.join(root, '.generated-purpose-cache');
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.writeFileSync(path.join(cacheRoot, 'purpose-view.json'), JSON.stringify({
      scope: 'operator',
      current_state: [{ statement: 'STALE GENERATED PURPOSE STATE' }],
    }), 'utf8');
    fs.writeFileSync(path.join(cacheRoot, 'purpose-copy.json'), JSON.stringify(before), 'utf8');
    fs.rmSync(cacheRoot, { recursive: true, force: true });

    assert.equal(sha256(owner), ownerHash);
    assert.equal(sha256(manifest), manifestHash);
    assert.equal(fs.existsSync(cacheRoot), false);

    const afterDelete = run(root);
    assert.deepEqual(normalized(afterDelete), normalized(before));
    assert.equal(afterDelete.current_state[0].statement, 'canonical owner state');
    assert.doesNotMatch(JSON.stringify(afterDelete), /STALE GENERATED PURPOSE STATE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Slice 11.1 Task 2: independent process restarts rebuild the same owner-backed Purpose projection.
{
  const root = makeRoot();
  try {
    const owner = path.join(root, 'operator', 'context', 'CURRENT.md');
    const ownerHash = sha256(owner);
    const firstProcess = run(root);
    const restartedProcess = run(root);
    const secondRestart = run(root);

    assert.deepEqual(normalized(restartedProcess), normalized(firstProcess));
    assert.deepEqual(normalized(secondRestart), normalized(firstProcess));
    assert.equal(firstProcess.scope, 'operator');
    assert.equal(restartedProcess.current_state[0].statement, 'canonical owner state');
    assert.equal(secondRestart.provenance.projection_owner, 'ai-verse-os');
    assert.equal(sha256(owner), ownerHash);

    // Every read above is a fresh child process. No restart-local state may be required to rebuild.
    assert.equal(fs.existsSync(path.join(root, '.aiverse', 'purpose.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'PURPOSE.md')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('Purpose Context hardening through Task 11.1.2: PASS\n');
