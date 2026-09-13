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

function invoke(command, { profile = 'detected', component = null, apply = false, expected = null } = {}) {
  const args = [script, command, '--root', root, '--profile', profile, '--json'];
  if (component) args.splice(2, 0, component);
  if (apply) args.push('--apply');
  const proc = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, AI_VERSE_SKILLS_ROOT: path.join(home, '.aiverse', 'skills') },
  });
  if (expected !== null) assert.equal(proc.status, expected, proc.stderr || proc.stdout);
  const parsed = JSON.parse(proc.stdout || '{}');
  return { proc, parsed };
}

try {
  {
    const { parsed } = invoke('status', { expected: 0 });
    assert.equal(parsed.state, 'ready');
    assert.equal(parsed.ready, true);
    for (const id of ['ai-verse-brain', 'ai-verse-memory', 'ai-verse-data', 'aiverse-skills']) {
      assert.equal(parsed.components.find(item => item.id === id)?.state, 'absent');
    }
  }

  {
    const { parsed } = invoke('status', { component: 'memory', expected: 2 });
    assert.equal(parsed.state, 'absent');
    assert.equal(parsed.ready, false);
    assert.deepEqual(parsed.required_components, ['ai-verse-memory']);
    assert.equal(parsed.components.length, 1);
  }

  {
    const { parsed } = invoke('descriptor', { component: 'custom-missing', expected: 0 });
    assert.equal(parsed.components.length, 1);
    assert.equal(parsed.components[0].component_id, 'custom-missing');
    assert.equal(parsed.components[0].current_state, 'absent');
    assert.equal(parsed.components[0].authority_transfer_separate, true);
  }

  {
    const { parsed } = invoke('status', { profile: 'core', expected: 2 });
    assert.equal(parsed.state, 'setup-required');
    assert.equal(parsed.ready, false);
    assert.deepEqual(new Set(parsed.missing_or_not_ready_required), new Set([
      'ai-verse-brain', 'ai-verse-memory', 'aiverse-skills', 'ai-verse-data',
    ]));
  }

  fs.mkdirSync(path.join(root, 'scripts', 'ai-verse-memory'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'ai-verse-memory', 'memory.py'), '# fixture\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'brain', 'installation.json'), '{}\n', 'utf8');

  {
    const { parsed } = invoke('reconcile', { expected: 2 });
    assert.equal(parsed.state, 'setup-required');
    assert.ok(parsed.actions.some(item => item.component === 'ai-verse-memory' && item.automatic === false));
    assert.ok(parsed.actions.some(item => item.component === 'ai-verse-brain'));
    assert.equal(parsed.mutated, false);
  }

  {
    const envPath = process.platform === 'win32' ? '' : '/definitely-not-present';
    const proc = spawnSync(process.execPath, [
      script, 'reconcile', 'ai-verse-brain', '--root', root, '--profile', 'detected', '--json', '--apply',
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: envPath, HOME: home, USERPROFILE: home, AI_VERSE_SKILLS_ROOT: path.join(home, '.aiverse', 'skills') },
    });
    assert.equal(proc.status, 2, proc.stderr || proc.stdout);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.state, 'setup-required');
    assert.equal(parsed.mutated, false);
  }

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
        'custom-extension': {
          id: 'custom-extension',
          supported: true,
          installed: true,
          enabled: true,
          version: '1.2.3',
        },
      },
    }, null, 2) + '\n',
    'utf8',
  );

  {
    const { parsed } = invoke('doctor', { expected: 2 });
    assert.equal(parsed.state, 'setup-required');
    assert.equal(parsed.components.find(item => item.id === 'ai-verse-memory')?.state, 'ready');
    assert.equal(parsed.components.find(item => item.id === 'custom-extension')?.state, 'ready');
    assert.equal(parsed.components.find(item => item.id === 'ai-verse-brain')?.state, 'setup-required');
    assert.equal(parsed.depth_checked.operational, false);
  }

  {
    const { parsed } = invoke('descriptor', { component: 'custom-extension', expected: 0 });
    assert.equal(parsed.components[0].version, '1.2.3');
    assert.equal(parsed.components[0].current_state, 'ready');
    assert.equal(parsed.components[0].uninstall_preserves_canonical_state, true);
  }

  {
    const registryFile = path.join(root, '.aiverse', 'extensions', 'registry.json');
    const data = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
    data.extensions['custom-extension'].migration_required = true;
    fs.writeFileSync(registryFile, JSON.stringify(data, null, 2) + '\n');
    const { parsed } = invoke('status', { component: 'custom-extension', expected: 2 });
    assert.equal(parsed.state, 'migration-required');
    assert.equal(parsed.migration_required, true);
    delete data.extensions['custom-extension'].migration_required;
    fs.writeFileSync(registryFile, JSON.stringify(data, null, 2) + '\n');
  }

  {
    const lock = path.join(root, '.aiverse', 'extensions', 'registry.json.lock');
    fs.writeFileSync(lock, JSON.stringify({ extension_id: 'ai-verse-data' }) + '\n', 'utf8');
    const { parsed } = invoke('doctor', { expected: 2 });
    assert.equal(parsed.state, 'unhealthy');
    assert.equal(parsed.registry_lock.state, 'present');
    assert.equal(parsed.registry_lock.owner, 'ai-verse-data');
    assert.ok(parsed.registry_lock.diagnostics.some(item => item.includes('never steals')));

    const reconcile = invoke('reconcile', { expected: 2 }).parsed;
    assert.ok(reconcile.actions.some(item => item.component === 'extension-registry'));
    assert.equal(fs.existsSync(lock), true, 'doctor/reconcile must never delete the shared lock');
    fs.rmSync(lock);
  }

  {
    fs.rmSync(path.join(root, 'operator', 'brain'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.ai-verse-brain'), { recursive: true });
    const { parsed } = invoke('status', { component: 'brain', expected: 2 });
    assert.equal(parsed.state, 'migration-required');
    assert.equal(parsed.migration_required, true);
  }

  process.stdout.write('Component lifecycle acceptance: PASS\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
