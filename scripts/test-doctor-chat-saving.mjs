#!/usr/bin/env node
// FL-29: doctor says plainly when chat saving is paused because an app changed its chat file shape,
// and stops saying it once an OS update changes the reader.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = path.resolve('bin/ai-verse-os.mjs');
const reader = path.resolve('system/extensions/packages/ai-verse-codex-learning/prospective_capture.py');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiv-chat-pause-'));
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
fs.copyFileSync(path.resolve('scripts/components.mjs'), path.join(root, 'scripts', 'components.mjs'));
fs.copyFileSync(path.resolve('scripts/fixed-order.mjs'), path.join(root, 'scripts', 'fixed-order.mjs'));
const installedReader = path.join(root, '.aiverse', 'extensions', 'ai-verse-codex-learning', 'prospective_capture.py');
fs.mkdirSync(path.dirname(installedReader), { recursive: true });
fs.copyFileSync(reader, installedReader);
const build = crypto.createHash('sha256').update(fs.readFileSync(installedReader)).digest('hex');

function doctor(args = []) {
  const proc = spawnSync(process.execPath, [cli, 'doctor', '--dir', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, AI_VERSE_SKILLS_ROOT: path.join(home, '.aiverse', 'skills') },
  });
  return proc;
}
function writePause(value) {
  const file = path.join(root, 'runtime', 'codex-learning', 'chat-saving-paused.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

try {
  assert.equal(spawnSync(process.execPath, [cli, 'setup', '--dir', root, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, AI_VERSE_SKILLS_ROOT: path.join(home, '.aiverse', 'skills') } }).status, 0);

  let proc = doctor(['--json']);
  assert.deepEqual(JSON.parse(proc.stdout).checks.chat_saving, { ok: true, paused: [] });

  writePause({ claude: { reason: 'chat record has no message', app_version: '3.0.0', build, at: '2026-11-23T10:00:00+00:00', announced: true } });
  const json = JSON.parse(doctor(['--json']).stdout);
  assert.equal(json.checks.chat_saving.ok, false);
  assert.equal(json.checks.chat_saving.paused[0].app, 'claude');
  assert.equal(json.checks.chat_saving.paused[0].app_version, '3.0.0');
  assert.equal(json.ready, true, 'a paused chat saver does not make the whole OS not ready');
  const text = doctor().stdout;
  assert.match(text, /Chat saving is paused for Claude Code 3\.0\.0/);
  assert.match(text, /next AI-Verse OS update/);

  // A pause written by an older reader is history once the reader is updated.
  writePause({ claude: { reason: 'old', app_version: '3.0.0', build: 'f'.repeat(64), at: 'x', announced: true } });
  assert.deepEqual(JSON.parse(doctor(['--json']).stdout).checks.chat_saving.paused, []);

  // A damaged note never breaks doctor.
  fs.writeFileSync(path.join(root, 'runtime', 'codex-learning', 'chat-saving-paused.json'), '{not json', 'utf8');
  assert.deepEqual(JSON.parse(doctor(['--json']).stdout).checks.chat_saving.paused, []);

  process.stdout.write('doctor chat saving pause: PASS\n');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
