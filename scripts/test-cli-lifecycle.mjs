#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('bin/ai-verse-os.mjs');
const components = path.resolve('scripts/components.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-verse-cli-lifecycle-'));
const root = path.join(temp, 'os');
const home = path.join(temp, 'home');

function touch(relative, content = '# fixture\n') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(home, { recursive: true });
touch('README.md');
touch('AGENTS.md');
touch('CLAUDE.md');
touch('AI-VERSE.yaml', 'schema_version: "2.0"\narchitecture: unified-workspace\n');
touch('system/architecture/README.md');
touch('system/schemas/workspace.schema.yaml');
touch('workspaces/_template/WORKSPACE.yaml');
touch('skills/registry.yaml');
touch('.claude/skills/onboard/SKILL.md');
touch('.agents/skills/onboard/SKILL.md');
touch('.claude/skills/3d-brain/SKILL.md');
touch('.agents/skills/3d-brain/SKILL.md');
touch('operator/README.md');
touch('workspaces/README.md');
fs.mkdirSync(path.join(root, 'operator', 'inbox'), { recursive: true });
fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
fs.copyFileSync(components, path.join(root, 'scripts', 'components.mjs'));

function invoke(args, expected) {
  const proc = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AI_VERSE_SKILLS_ROOT: path.join(home, '.aiverse', 'skills'),
    },
  });
  assert.equal(proc.status, expected, proc.stderr || proc.stdout);
  return proc.stdout.trim() ? JSON.parse(proc.stdout) : null;
}

try {
  const pre = invoke(['status', '--dir', root, '--json'], 2);
  assert.equal(pre.state, 'setup-required');
  assert.equal(pre.ready, false);

  const descriptor = invoke(['descriptor', '--dir', root, '--json'], 0);
  assert.equal(descriptor.current_state, 'setup-required');
  assert.equal(descriptor.authority_transfer_separate, true);
  assert.equal(descriptor.enable_disable_supported, false);
  assert.equal(descriptor.setup_grants.permission_broadening, false);

  const first = invoke(['setup', '--dir', root, '--json'], 0);
  assert.equal(first.state, 'ready');
  assert.equal(first.ready, true);
  assert.equal(first.changed, true);
  assert.equal(first.grants.component_authority_transfer, false);
  assert.equal(first.grants.external_account_authorization, false);
  assert.equal(first.grants.permission_broadening, false);

  const second = invoke(['setup', '--dir', root, '--json'], 0);
  assert.equal(second.state, 'ready');
  assert.equal(second.changed, false);
  assert.equal(second.setup.setup_at, first.setup.setup_at);

  const status = invoke(['status', '--dir', root, '--json'], 0);
  assert.equal(status.state, 'ready');
  assert.equal(status.profile, 'detected');

  const doctor = invoke(['doctor', '--dir', root, '--json'], 0);
  assert.equal(doctor.ready, true);
  assert.equal(doctor.depth_checked.system_composed, true);
  assert.equal(doctor.depth_checked.operational, false);

  const componentDescriptor = invoke([
    'components', 'descriptor', 'brain', '--dir', root, '--json',
  ], 0);
  assert.equal(componentDescriptor.components[0].component_id, 'ai-verse-brain');
  assert.equal(componentDescriptor.components[0].current_state, 'absent');

  const coreSetup = invoke(['setup', '--dir', root, '--profile', 'core', '--json'], 2);
  assert.equal(coreSetup.state, 'setup-required');
  assert.equal(coreSetup.ready, false);
  assert.equal(coreSetup.setup.profile, 'core');

  const persistedCore = invoke(['status', '--dir', root, '--json'], 2);
  assert.equal(persistedCore.profile, 'core');
  assert.equal(persistedCore.state, 'setup-required');

  const setupFile = path.join(root, '.aiverse', 'os', 'setup.json');
  const stale = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
  stale.schema_version = '0.9';
  fs.writeFileSync(setupFile, JSON.stringify(stale, null, 2) + '\n', 'utf8');

  const migration = invoke(['status', '--dir', root, '--json'], 2);
  assert.equal(migration.state, 'migration-required');
  assert.equal(migration.migration_required, true);

  const repaired = invoke(['setup', '--dir', root, '--profile', 'detected', '--json'], 0);
  assert.equal(repaired.state, 'ready');
  assert.equal(repaired.setup.profile, 'detected');

  process.stdout.write('CLI lifecycle acceptance: PASS\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
