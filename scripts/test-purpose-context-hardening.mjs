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

function fileSnapshot(root) {
  const entries = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) entries.push([rel, sha256(full)]);
      else entries.push([rel, `special:${stat.mode}`]);
    }
  }
  walk(root);
  return entries;
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
    assert.equal(fs.existsSync(path.join(root, '.aiverse', 'purpose.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'PURPOSE.md')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Slice 11.1 Task 3: repeated setup/restart cannot create duplicate Purpose state.
{
  const root = makeRoot();
  try {
    const beforeFiles = fileSnapshot(root);
    const projections = [];
    for (let index = 0; index < 8; index += 1) projections.push(run(root));
    const afterFiles = fileSnapshot(root);

    assert.deepEqual(afterFiles, beforeFiles, 'Purpose reads/restarts must not create or duplicate durable files');
    for (const projection of projections.slice(1)) {
      assert.deepEqual(normalized(projection), normalized(projections[0]));
    }
    assert.equal(projections[0].current_state.length, 1);
    assert.equal(projections[0].current_state[0].statement, 'canonical owner state');
    assert.equal(fs.existsSync(path.join(root, 'PURPOSE.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.aiverse', 'purpose.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('Purpose Context hardening through Task 11.1.3: PASS\n');
