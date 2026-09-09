#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts/sync-runtime-adapters.mjs');

function write(root, relative, content) {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

function digest(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function run(root, ...args) {
  return spawnSync(process.execPath, [GENERATOR, '--root', root, ...args], {
    encoding: 'utf8',
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-adapter-sync-'));
try {
  write(root, 'system/capabilities/demo/SKILL.md', 'demo-v1\n');
  write(root, '.claude/skills/demo/SKILL.md', 'demo-v1\n');
  write(root, '.agents/skills/demo/SKILL.md', 'demo-v1\n');
  write(root, '.claude/skills/ai-verse-memory/SKILL.md', 'memory-claude\n');
  write(root, '.agents/skills/ai-verse-memory/SKILL.md', 'memory-codex\n');
  write(root, '.agents/skills/custom-local/SKILL.md', 'custom-local\n');

  let result = run(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const statePath = path.join(root, 'runtime/adapters/os-owned.json');
  const state1 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(Object.keys(state1.files).sort(), [
    '.agents/skills/demo/SKILL.md',
    '.claude/skills/demo/SKILL.md',
  ]);
  assert.equal(state1.files['.agents/skills/demo/SKILL.md'].last_generated_sha256, digest('demo-v1\n'));
  assert.equal(read(root, '.claude/skills/ai-verse-memory/SKILL.md'), 'memory-claude\n');
  assert.equal(read(root, '.agents/skills/ai-verse-memory/SKILL.md'), 'memory-codex\n');
  assert.equal(read(root, '.agents/skills/custom-local/SKILL.md'), 'custom-local\n');

  write(root, 'system/capabilities/demo/SKILL.md', 'demo-v2\n');
  write(root, '.agents/skills/demo/SKILL.md', 'locally-edited-codex\n');
  result = run(root);
  assert.equal(result.status, 2, `expected conflict exit 2, got ${result.status}\n${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /locally modified since the last OS generation; preserved/);
  assert.equal(read(root, '.claude/skills/demo/SKILL.md'), 'demo-v2\n');
  assert.equal(read(root, '.agents/skills/demo/SKILL.md'), 'locally-edited-codex\n');
  assert.equal(read(root, '.claude/skills/ai-verse-memory/SKILL.md'), 'memory-claude\n');
  assert.equal(read(root, '.agents/skills/ai-verse-memory/SKILL.md'), 'memory-codex\n');
  assert.equal(read(root, '.agents/skills/custom-local/SKILL.md'), 'custom-local\n');

  const state2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state2.files['.claude/skills/demo/SKILL.md'].last_generated_sha256, digest('demo-v2\n'));
  assert.equal(state2.files['.agents/skills/demo/SKILL.md'].last_generated_sha256, digest('demo-v1\n'));

  write(root, '.agents/skills/demo/SKILL.md', 'demo-v1\n');
  result = run(root, 'demo');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(read(root, '.agents/skills/demo/SKILL.md'), 'demo-v2\n');
  assert.equal(read(root, '.claude/skills/demo/SKILL.md'), 'demo-v2\n');

  write(root, 'system/capabilities/obsolete/old.txt', 'old-generated\n');
  write(root, '.claude/skills/obsolete/old.txt', 'old-generated\n');
  write(root, '.agents/skills/obsolete/old.txt', 'old-generated\n');
  result = run(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.rmSync(path.join(root, 'system/capabilities/obsolete'), { recursive: true, force: true });
  write(root, '.agents/skills/obsolete/custom.txt', 'keep-me\n');
  result = run(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(root, '.claude/skills/obsolete/old.txt')), false);
  assert.equal(fs.existsSync(path.join(root, '.agents/skills/obsolete/old.txt')), false);
  assert.equal(read(root, '.agents/skills/obsolete/custom.txt'), 'keep-me\n');

  write(root, '.agents/skills/demo/SKILL.md', 'user-change-after-generation\n');
  fs.rmSync(path.join(root, 'system/capabilities/demo'), { recursive: true, force: true });
  result = run(root);
  assert.equal(result.status, 2, `expected stale-modified conflict, got ${result.status}`);
  assert.match(result.stderr, /canonical source was removed but local target changed; preserved and ownership released/);
  assert.equal(read(root, '.agents/skills/demo/SKILL.md'), 'user-change-after-generation\n');
  assert.equal(fs.existsSync(path.join(root, '.claude/skills/demo/SKILL.md')), false);

  const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(finalState.files).some((key) => key.includes('/demo/')), false);
  assert.equal(Object.keys(finalState.files).some((key) => key.includes('ai-verse-memory')), false);

  process.stdout.write('Adapter sync acceptance: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
