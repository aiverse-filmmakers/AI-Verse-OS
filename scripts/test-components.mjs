#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/components.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-verse-components-'));
const root = path.join(temp, 'os');
const home = path.join(temp, 'home');
fs.mkdirSync(path.join(root, 'operator'), { recursive: true });
fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(
  path.join(root, 'AI-VERSE.yaml'),
  'schema_version: "2.0"\narchitecture: unified-workspace\n',
  'utf8',
);

function run(command) {
  const proc = spawnSync(process.execPath, [script, command, '--root', root, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  return JSON.parse(proc.stdout);
}

try {
  const clean = run('doctor');
  assert.equal(clean.ok, true);
  for (const id of ['ai-verse-brain', 'ai-verse-memory', 'ai-verse-data', 'aiverse-skills']) {
    assert.equal(clean.components.find(item => item.id === id)?.state, 'absent');
  }

  fs.mkdirSync(path.join(root, 'scripts', 'ai-verse-memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'ai-verse-memory', 'memory.py'), '# fixture\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'brain', 'installation.json'), '{}\n', 'utf8');

  const plan = run('reconcile');
  assert.equal(plan.mutated, false);
  assert.equal(plan.mode, 'plan-only');
  assert.equal(plan.components.find(item => item.id === 'ai-verse-memory')?.state, 'available-unattached');
  assert.equal(plan.components.find(item => item.id === 'ai-verse-brain')?.state, 'available-unattached');
  assert.ok(plan.actions.some(item => item.component === 'ai-verse-memory'));
  assert.ok(plan.actions.some(item => item.component === 'ai-verse-brain'));

  fs.mkdirSync(path.join(root, '.aiverse', 'extensions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.aiverse', 'extensions', 'registry.json'),
    JSON.stringify({
      schema_version: '1.0',
      custom_top_level: { keep: true },
      extensions: {
        'ai-verse-memory': {
          id: 'ai-verse-memory',
          supported: true,
          installed: true,
          enabled: true,
          engine: 'scripts/ai-verse-memory/memory.py',
          custom: 'keep',
        },
      },
    }, null, 2) + '\n',
    'utf8',
  );
  const attached = run('doctor');
  assert.equal(attached.components.find(item => item.id === 'ai-verse-memory')?.state, 'attached-enabled');
  assert.equal(attached.components.find(item => item.id === 'ai-verse-brain')?.state, 'available-unattached');

  const lock = path.join(root, '.aiverse', 'extensions', 'registry.json.lock');
  fs.writeFileSync(lock, JSON.stringify({ extension_id: 'ai-verse-data' }) + '\n', 'utf8');

  const lockedDoctor = spawnSync(process.execPath, [script, 'doctor', '--root', root, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(lockedDoctor.status, 2);
  const locked = JSON.parse(lockedDoctor.stdout);
  assert.equal(locked.ok, false);
  assert.equal(locked.registry_lock.state, 'present');
  assert.equal(locked.registry_lock.owner, 'ai-verse-data');
  assert.ok(locked.registry_lock.diagnostics.some(item => item.includes('never steals')));

  const lockedReconcile = spawnSync(process.execPath, [script, 'reconcile', '--root', root, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(lockedReconcile.status, 2);
  const lockedPlan = JSON.parse(lockedReconcile.stdout);
  assert.ok(lockedPlan.actions.some(item => item.component === 'extension-registry'));
  assert.equal(fs.existsSync(lock), true, 'doctor/reconcile must never delete the shared lock');
  fs.rmSync(lock);

  process.stdout.write('Component doctor/reconcile acceptance: PASS\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
