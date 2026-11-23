#!/usr/bin/env node
// FL-78: the OS connects Claude Code (and Codex when present) by itself, and says so in plain words.
// Runs the real CLI against a scratch copy of this checkout, with a private HOME and no real app needed.
// It proves the files: hooks written and current, rules present, memory choice remembered, nothing
// re asked on a second run, bad settings left untouched, no Codex words for a Claude member.
// It cannot prove that Claude loads the hooks, the restart, the trust prompt or Codex approval.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-verse-connect-'));
const root = path.join(temp, 'os');
const home = path.join(temp, 'home');
const PACKAGE_ID = 'ai-verse-codex-learning';
const settingsFile = path.join(root, '.claude', 'settings.local.json');
const connectFile = path.join(root, '.aiverse', 'os', 'connect.json');

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed`);
  return result.stdout;
}

function copyCheckout() {
  const listed = git(['ls-files', '-co', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean);
  for (const rel of listed) {
    const from = path.join(repo, rel);
    if (!fs.existsSync(from) || fs.lstatSync(from).isDirectory()) continue;
    const to = path.join(root, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// Back to a member who has installed and run setup, but never connected an app.
function reset() {
  for (const rel of ['.aiverse/extensions', '.aiverse/os/connect.json', '.claude/settings.local.json', '.codex', 'runtime/codex-learning']) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
}

function cli(args, apps, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), CI: 'true', ...extraEnv };
  delete env.AI_VERSE_OS_APPS;
  delete env.AI_VERSE_OS_TEST;
  if (apps !== undefined) { env.AI_VERSE_OS_APPS = apps; env.AI_VERSE_OS_TEST = '1'; }
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'ai-verse-os.mjs'), ...args, '--dir', root], { encoding: 'utf8', env, cwd: root, input: '' });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}`, stdout: result.stdout || '' };
}

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function readSettings() { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); }
function bridgeBuild() { return sha(path.join(root, '.aiverse', 'extensions', PACKAGE_ID, 'bridge.py')); }
function hookCommands(settings) {
  return Object.values(settings.hooks || {}).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
}
function noDashProse(text) {
  assert.ok(!/ [-–—] /.test(text), `the report must not use dash punctuation: ${text}`);
}

try {
  copyCheckout();
  fs.mkdirSync(home, { recursive: true });

  // 0. Setup the member would already have run.
  const first = cli(['setup', '--json'], 'none');
  assert.ok(first.status === 0, first.out);
  assert.ok(!fs.existsSync(path.join(root, '.aiverse/extensions', PACKAGE_ID)), 'no app found: nothing may be installed');

  // 1. No app on the computer: say so, one action, change nothing.
  {
    const r = cli(['connect'], 'none');
    assert.match(r.out, /no Claude Code or Codex was found/);
    assert.match(r.out, /Install Claude Code or Codex, then run: ai-verse-os connect/);
    assert.match(r.out, /Nothing on your computer was changed/);
    assert.ok(!fs.existsSync(settingsFile), 'no settings file may be written');
    assert.ok(!fs.existsSync(path.join(root, '.aiverse/extensions', PACKAGE_ID)), 'no package may be installed');
    noDashProse(r.out);
  }

  // 2. Claude member, a run that cannot ask: connected, memory left on, the one command given.
  {
    reset();
    const r = cli(['connect'], 'claude');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /OS connected: 5 of 5 helpers on/);
    assert.match(r.out, /quit and reopen Claude Code/);
    assert.match(r.out, /trust the folder/);
    assert.match(r.out, /cannot be saved/);
    assert.match(r.out, /ai-verse-os connect --turn-off-claude-memory/);
    assert.ok(!/Codex/i.test(r.out), `a Claude member must not see Codex steps: ${r.out}`);
    noDashProse(r.out);

    const settings = readSettings();
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    const build = bridgeBuild();
    const commands = hookCommands(settings);
    assert.equal(commands.length, 5);
    for (const command of commands) assert.ok(command.includes(build), 'every hook carries the installed build');
    assert.equal(settings.permissions.allow.length, 7);
    assert.ok(!('autoMemoryEnabled' in settings), 'memory is left on when the run could not ask');
    assert.ok(!fs.existsSync(connectFile), 'a choice that was never asked must not be stored');
    const record = JSON.parse(fs.readFileSync(path.join(root, '.aiverse', 'extensions', PACKAGE_ID, 'claude-adapter.json'), 'utf8'));
    assert.ok(!('auto_memory_choice' in record), 'the adapter record must not hold an unasked choice');

    // status and doctor print the same plain line, read only.
    const s = cli(['status'], 'claude');
    assert.match(s.out, /OS connected: 5 of 5 helpers on/);
    assert.ok(!/Codex/i.test(s.out));
    const d = cli(['doctor'], 'claude');
    assert.match(d.out, /OS connected: 5 of 5 helpers on/);
    const dj = JSON.parse(cli(['doctor', '--json'], 'claude').stdout);
    assert.equal(dj.connection.connected, true);
    assert.equal(dj.connection.claude.hooks_current, 5);
    assert.equal(dj.connection.claude.ran_in_chat, false);
  }

  // 3. A second run changes nothing, says so, and does not touch the settings bytes.
  {
    const before = fs.readFileSync(settingsFile);
    const r = cli(['connect'], 'claude');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /OS connected: 5 of 5 helpers on/);
    assert.match(r.out, /Nothing changed/);
    assert.ok(Buffer.compare(before, fs.readFileSync(settingsFile)) === 0);
    // A second setup says the same and still does not ask again or flip anything.
    const again = cli(['setup'], 'claude');
    assert.match(again.out, /Nothing changed/);
    assert.ok(Buffer.compare(before, fs.readFileSync(settingsFile)) === 0);
  }

  // 4. Turning memory off is explicit, remembered, and survives a stale refresh.
  {
    const r = cli(['connect', '--turn-off-claude-memory'], 'claude');
    assert.equal(r.status, 0, r.out);
    assert.equal(readSettings().autoMemoryEnabled, false);
    assert.equal(JSON.parse(fs.readFileSync(connectFile, 'utf8')).claude_memory, 'off');
    // An update brings a changed helper file: the installed copy and the hooks are now out of date.
    const sourceDir = path.join(root, 'system', 'extensions', 'packages', PACKAGE_ID);
    fs.appendFileSync(path.join(sourceDir, 'bridge.py'), '\n# changed by an update\n', 'utf8');
    const manifestFile = path.join(sourceDir, 'PACKAGE.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.files['bridge.py'] = sha(path.join(sourceDir, 'bridge.py'));
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const lines = cli(['status'], 'claude').out;
    assert.match(lines, /OS not connected yet/);
    assert.match(lines, /One action: run  ai-verse-os connect/);
    const repaired = cli(['connect'], 'claude');
    assert.match(repaired.out, /OS connected: 5 of 5 helpers on/, repaired.out);
    assert.equal(readSettings().autoMemoryEnabled, false, 'a refresh must not flip the remembered choice');
    // And back on, only because the member asked.
    cli(['connect', '--keep-claude-memory'], 'claude');
    assert.ok(readSettings().autoMemoryEnabled !== false);
  }

  // 5. Proof it ran in a chat comes from the events file, for this build only.
  {
    const events = path.join(root, 'runtime', 'codex-learning', 'events.jsonl');
    fs.mkdirSync(path.dirname(events), { recursive: true });
    fs.writeFileSync(events, `${JSON.stringify({ harness: 'claude', build: '0'.repeat(64), event: 'UserPromptSubmit' })}\n`, 'utf8');
    assert.match(cli(['status'], 'claude').out, /quit and reopen Claude Code/, 'an old build must not count as a run');
    fs.appendFileSync(events, `${JSON.stringify({ harness: 'claude', build: bridgeBuild(), event: 'UserPromptSubmit' })}\n`, 'utf8');
    const ran = cli(['status'], 'claude').out;
    assert.match(ran, /has run them in a chat/);
    assert.ok(!/quit and reopen/.test(ran));
  }

  // 6. Hand installed member whose memory is already off: kept as is, remembered, never asked.
  {
    reset();
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({ autoMemoryEnabled: false, permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`, 'utf8');
    const r = cli(['connect'], 'claude');
    assert.equal(r.status, 0, r.out);
    const settings = readSettings();
    assert.equal(settings.autoMemoryEnabled, false);
    assert.ok(settings.permissions.allow.includes('Bash(ls:*)'), 'the member\'s own rules stay');
    assert.equal(settings.permissions.allow.length, 8);
  }

  // 7. A settings file we cannot read is refused untouched, in plain words.
  {
    reset();
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, '{ this is not json', 'utf8');
    const r = cli(['connect'], 'claude');
    assert.equal(r.status, 3, 'an incomplete connection exits 3');
    assert.match(r.out, /could not be read, so it was left exactly as it was/);
    assert.match(r.out, /run: ai-verse-os connect/);
    assert.ok(!/Traceback|\bat .*\.mjs/.test(r.out), 'no stack trace for a member');
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ this is not json');
    noDashProse(r.out);
  }

  // 7b. A read only settings file is refused untouched, with exit 3 and a plain message.
  if (process.platform !== 'win32' && !(process.getuid && process.getuid() === 0)) {
    reset();
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const original = `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`;
    fs.writeFileSync(settingsFile, original, 'utf8');
    fs.chmodSync(settingsFile, 0o444);
    try {
      const r = cli(['connect'], 'claude');
      assert.equal(r.status, 3, r.out);
      assert.match(r.out, /is read only, so it was left exactly as it was/);
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), original);
      assert.equal(fs.statSync(settingsFile).mode & 0o777, 0o444);
      const s = cli(['setup'], 'claude');
      assert.equal(s.status, 3, s.out);
      noDashProse(r.out);
    } finally {
      fs.chmodSync(settingsFile, 0o644);
    }
  }

  // 7c. The app override is for tests only: without AI_VERSE_OS_TEST=1 it is ignored.
  {
    reset();
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), CI: 'true', AI_VERSE_OS_APPS: 'claude' };
    delete env.AI_VERSE_OS_TEST;
    const r = spawnSync(process.execPath, [path.join(root, 'bin', 'ai-verse-os.mjs'), 'connect', '--dir', root], { encoding: 'utf8', env, cwd: root, input: '' });
    // A machine that really has Claude on PATH cannot show the difference, so only assert when it has none.
    if (spawnSync('claude', ['--version'], { env }).error) {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /no Claude Code or Codex was found/);
      assert.ok(!fs.existsSync(settingsFile));
    }
  }

  // 8. A Codex only member: Codex words only, no Claude settings written.
  {
    reset();
    const r = cli(['connect'], 'codex');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /OS connected for Codex: 6 of 6 helpers on/);
    assert.match(r.out, /Settings, then Hooks/);
    assert.ok(!/Claude/.test(r.out), `a Codex member must not see Claude steps: ${r.out}`);
    assert.ok(!fs.existsSync(settingsFile), 'no Claude settings for a Codex member');
    noDashProse(r.out);
  }

  // 9. The installer required list did not grow, and the legacy brand string is absent from the new files.
  {
    const cliSource = fs.readFileSync(path.join(repo, 'bin', 'ai-verse-os.mjs'), 'utf8');
    const required = cliSource.slice(cliSource.indexOf('const required = ['), cliSource.indexOf('];', cliSource.indexOf('const required = [')));
    assert.ok(!required.includes('connect-claude'), 'connect-claude.mjs must not be in the installer required list');
    const legacy = ['A', 'I', 'O', 'S'].join('');
    for (const rel of ['bin/connect-claude.mjs', 'scripts/test-connect-claude.mjs']) {
      assert.ok(!fs.readFileSync(path.join(repo, rel), 'utf8').includes(legacy), `${rel} must not contain the legacy brand string`);
    }
  }

  console.log('connect claude tests passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
