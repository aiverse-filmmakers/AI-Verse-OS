#!/usr/bin/env node
// FL-21: doctor may only say a depth was checked when it measured it and it passed.
// A hidden tool, an unready profile or a broken install must show up as false.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('bin/ai-verse-os.mjs');
const components = path.resolve('scripts/components.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-doctor-'));
const root = path.join(temp, 'os');
const home = path.join(temp, 'home');
fs.mkdirSync(home, { recursive: true });

function touch(relative, content = '# fixture\n') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'system/architecture/README.md', 'system/schemas/workspace.schema.yaml',
  'workspaces/_template/WORKSPACE.yaml', 'skills/registry.yaml', '.claude/skills/onboard/SKILL.md', '.agents/skills/onboard/SKILL.md',
  '.claude/skills/3d-brain/SKILL.md', '.agents/skills/3d-brain/SKILL.md', 'operator/README.md', 'workspaces/README.md']) touch(file);
touch('AI-VERSE.yaml', 'schema_version: "2.0"\narchitecture: unified-workspace\n');
fs.mkdirSync(path.join(root, 'operator', 'inbox'), { recursive: true });
fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
fs.copyFileSync(components, path.join(root, 'scripts', 'components.mjs'));
fs.copyFileSync(path.resolve('scripts/fixed-order.mjs'), path.join(root, 'scripts', 'fixed-order.mjs'));

function run(args, envExtra = {}) {
  const proc = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, AI_VERSE_SKILLS_ROOT: path.join(home, '.aiverse', 'skills'), ...envExtra },
  });
  return { proc, json: proc.stdout.trim().startsWith('{') ? JSON.parse(proc.stdout) : null };
}

try {
  assert.equal(run(['setup', '--dir', root, '--json']).proc.status, 0);

  // Healthy detected profile: every depth the doctor measures is true, operational is never claimed.
  const good = run(['doctor', '--dir', root, '--json']).json;
  assert.equal(good.ready, true);
  for (const key of ['structural', 'setup', 'attachment_discovery', 'runtime', 'dependency', 'system_composed']) {
    assert.equal(good.depth_checked[key], true, `${key} should be measured true`);
  }
  assert.equal(good.depth_checked.operational, false);

  // Core profile needs Brain, Memory and Data, which are absent: the composed depth must be false.
  const core = run(['doctor', '--dir', root, '--profile', 'core', '--json']);
  assert.equal(core.proc.status, 2);
  assert.equal(core.json.depth_checked.system_composed, false, 'unready composition must not be reported as checked and passed');

  // Tools hidden: no python, no git on PATH and no private copy. runtime and dependency must turn false.
  const nothing = path.join(temp, 'empty');
  fs.mkdirSync(nothing);
  const hidden = run(['doctor', '--dir', root, '--json'], {
    PATH: nothing,
    AI_VERSE_TOOLCHAIN_DIR: path.join(temp, 'no-private-tools'),
    AI_VERSE_PRIVATE_TOOLCHAIN: 'off',
  });
  assert.equal(hidden.proc.status, 2);
  assert.equal(hidden.json.depth_checked.runtime, false, 'missing tools must not report runtime as checked and passed');
  assert.equal(hidden.json.depth_checked.dependency, false);
  assert.equal(hidden.json.ready, false);

  // A damaged install: structural turns false.
  fs.rmSync(path.join(root, 'README.md'));
  const broken = run(['doctor', '--dir', root, '--json']);
  assert.equal(broken.json.depth_checked.structural, false);
  assert.equal(broken.json.ready, false);

  // No install at all: nothing is claimed.
  const none = run(['doctor', '--dir', path.join(temp, 'nowhere'), '--json']);
  assert.ok(Object.values(none.json.depth_checked).every(value => value === false));

  // The component inspector alone starts nothing, so it never claims runtime or dependency.
  const inspected = spawnSync(process.execPath, [components, 'doctor', '--root', root, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  const parsed = JSON.parse(inspected.stdout);
  assert.equal(parsed.depth_checked.runtime, false);
  assert.equal(parsed.depth_checked.dependency, false);

  process.stdout.write('doctor honesty: PASS\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
