#!/usr/bin/env node
// Hook entry, durable queue, transcript window, claims, rate ledger and worker lock for automatic learning. No model is used.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { handleEvent } from './learn-hook.mjs';
import {
  acquireLock, claimJob, enqueue, finishClaim, learnPaths, listJobs, loadConfig, readJob, readLedger, recordReview, recoverClaims,
  releaseLock, resolveScope, reviewAllowance, sessionKey, workerRunning, writeCursor,
} from './learn-queue.mjs';
import { readWindow } from './learn-window.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const NOW = 1_800_000_000_000;

function core({ mode } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-learn-hook-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'workspaces', 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'alpha', 'WORKSPACE.yaml'), 'id: alpha\n');
  if (mode) {
    fs.mkdirSync(path.join(root, '.aiverse', 'learn'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aiverse', 'learn', 'config.json'), JSON.stringify({ mode }));
  }
  return root;
}

function transcript(root, lines) {
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  return file;
}

const user = (uuid, content, extra = {}) => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra });
const assistant = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const noWorker = () => {};
const payload = (root, file, extra = {}) => ({ session_id: 'session-1', transcript_path: file, cwd: root, ...extra });

// handleEvent would start the real detached worker, so tests hand it a no-op starter.
const fire = (root, event, data, now = NOW) => handleEvent(root, event, data, now, noWorker);

test('absent or malformed config is off and creates nothing', () => {
  const root = core();
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.')]);
  for (const event of ['stop', 'precompact', 'end', 'start']) assert.equal(fire(root, event, payload(root, file)), false);
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
  fs.mkdirSync(path.join(root, '.aiverse', 'learn'), { recursive: true });
  fs.writeFileSync(path.join(root, '.aiverse', 'learn', 'config.json'), '{not json');
  assert.equal(loadConfig(root).mode, 'off');
  fs.writeFileSync(path.join(root, '.aiverse', 'learn', 'config.json'), JSON.stringify({ mode: 'on', idle_seconds: 'soon' }));
  assert.equal(fire(root, 'stop', payload(root, file)), false);
  assert.equal(loadConfig(root).idle_seconds, 60);
});

test('each stop keeps exactly one job per session with a debounced deadline', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.')]);
  fire(root, 'stop', payload(root, file), NOW);
  fire(root, 'stop', payload(root, file), NOW + 20_000);
  assert.equal(listJobs(root).length, 1);
  const job = readJob(root, sessionKey('session-1'));
  assert.equal(job.turns, 2);
  assert.equal(job.due_at, NOW + 20_000 + 60_000);
  assert.equal(job.scope, 'operator');
  assert.equal(job.session_id, 'session-1');
  for (let i = 0; i < 4; i += 1) fire(root, 'stop', payload(root, file), NOW + 30_000);
  const busy = readJob(root, sessionKey('session-1'));
  assert.equal(busy.reason, 'n_turns');
  assert.equal(busy.due_at, NOW + 30_000);
});

test('loop guards: stop_hook_active and the reviewer environment produce nothing', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.')]);
  assert.equal(fire(root, 'stop', payload(root, file, { stop_hook_active: true })), false);
  process.env.AIVERSE_LEARN_REVIEW = '1';
  try {
    for (const event of ['stop', 'precompact', 'end', 'start']) assert.equal(fire(root, event, payload(root, file)), false);
  } finally {
    delete process.env.AIVERSE_LEARN_REVIEW;
  }
  assert.equal(listJobs(root).length, 0);
});

test('session end and compaction are due immediately and a later stop does not delay them', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.'), assistant('a1', 'ok')]);
  writeCursor(root, sessionKey('session-1'), 1);
  fire(root, 'precompact', payload(root, file, { trigger: 'auto' }), NOW);
  let job = readJob(root, sessionKey('session-1'));
  assert.equal(job.reason, 'before_compaction');
  assert.equal(job.due_at, NOW);
  assert.equal(job.spools[0].from_line, 1);
  assert.equal(job.spools[0].lines, 1);
  assert.equal(fs.readFileSync(job.spools[0].path, 'utf8'), `${JSON.stringify(assistant('a1', 'ok'))}\n`);
  fire(root, 'stop', payload(root, file), NOW + 5000);
  job = readJob(root, sessionKey('session-1'));
  assert.equal(job.reason, 'before_compaction');
  assert.equal(job.due_at, NOW);
  fire(root, 'end', payload(root, file, { reason: 'other' }), NOW + 9000);
  assert.equal(readJob(root, sessionKey('session-1')).reason, 'session_end');
});

test('scope comes from the working folder and a folder outside the Core is ignored', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'Client Alpha likes blue headlines.')]);
  fire(root, 'end', payload(root, file, { cwd: path.join(root, 'workspaces', 'alpha') }));
  assert.equal(readJob(root, sessionKey('session-1')).scope, 'workspace:alpha');
  fs.mkdirSync(path.join(root, 'workspaces', 'unknown'));
  fire(root, 'end', payload(root, file, { session_id: 's2', cwd: path.join(root, 'workspaces', 'unknown') }));
  assert.equal(readJob(root, sessionKey('s2')), null); // a workspaces/ folder without a manifest is never promoted to operator
  assert.equal(fire(root, 'end', payload(root, file, { session_id: 's3', cwd: os.tmpdir() })), false);
  assert.equal(readJob(root, sessionKey('s3')), null);
});

test('queue writes are atomic and a stray temp file or corrupt job is ignored', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.')]);
  fire(root, 'end', payload(root, file));
  const { queue } = learnPaths(root);
  fs.writeFileSync(path.join(queue, 'crashed.json.123.tmp'), '{"half');
  fs.writeFileSync(path.join(queue, 'corrupt.json'), '{"half');
  assert.equal(listJobs(root).length, 1);
  assert.equal(fs.readdirSync(queue).filter((name) => name.startsWith(sessionKey('session-1')) && name.endsWith('.tmp')).length, 0);
});

test('a claim is exclusive, new work during a review survives, and a stale claim returns to the queue', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.')]);
  const key = sessionKey('session-1');
  fire(root, 'end', payload(root, file), NOW);
  assert.ok(claimJob(root, key));
  assert.equal(claimJob(root, key), null);
  fire(root, 'stop', payload(root, file), NOW + 1000);
  finishClaim(root, key, { ...readJob(root, key), attempts: 2, not_before: NOW + 5000 });
  const merged = readJob(root, key);
  assert.equal(merged.attempts, 2);
  assert.equal(merged.reason, 'idle');
  fs.rmSync(path.join(learnPaths(root).queue, `${key}.json`));
  fire(root, 'end', payload(root, file), NOW);
  claimJob(root, key);
  assert.equal(recoverClaims(root, Date.now()), 0);
  assert.equal(recoverClaims(root, Date.now() + 11 * 60 * 1000), 1);
  assert.ok(readJob(root, key));
});

test('transcript window is bounded, ordered, drops tool traffic and never consumes a partial line', () => {
  const root = core();
  const long = 'x'.repeat(900);
  const file = transcript(root, [
    { type: 'queue-operation' },
    user('u1', 'From now on never use exclamation marks.'),
    assistant('a1', long),
    user('t1', [{ type: 'tool_result', content: 'big tool output' }]),
    user('s1', 'sidechain text that is long enough', { isSidechain: true }),
    user('m1', '<system-reminder>hidden</system-reminder>'),
    user('u2', 'ok'),
    user('u3', 'My goal is to launch my store by March.'),
  ]);
  fs.appendFileSync(file, '{"type":"user","uuid":"partial"');
  const window = readWindow(file, 0, 24000);
  assert.deepEqual(window.messages.map((m) => m.id), ['u1', 'a1', 'u2', 'u3']);
  assert.ok(window.messages[1].text.length < 820);
  assert.equal(window.hasEligible, true);
  assert.equal(window.more, false);
  const small = readWindow(file, 0, 60);
  assert.deepEqual(small.messages.map((m) => m.id), ['u1']);
  assert.equal(small.more, true);
  const rest = readWindow(file, small.nextLine, 24000);
  assert.deepEqual(rest.messages.map((m) => m.id), ['a1', 'u2', 'u3']);
  assert.equal(readWindow(file, 999, 100).gap, true);
  assert.equal(readWindow(file, rest.nextLine, 100).hasEligible, false);
});

test('slash commands and short replies alone are not eligible', () => {
  const root = core();
  const file = transcript(root, [user('u1', '/learn'), user('u2', 'yes'), assistant('a1', 'Done, anything else for the project today?')]);
  assert.equal(readWindow(file, 0, 1000).hasEligible, false);
});

test('rate ledger enforces the gap, the session cap and the daily cap', () => {
  const root = core({ mode: 'auto' });
  const config = loadConfig(root);
  const key = sessionKey('session-1');
  assert.equal(reviewAllowance(readLedger(root, NOW), key, config, NOW).ok, true);
  recordReview(root, key, 0.002, NOW);
  const gap = reviewAllowance(readLedger(root, NOW + 1000), key, config, NOW + 1000);
  assert.equal(gap.ok, false);
  assert.equal(gap.not_before, NOW + 180_000);
  assert.equal(reviewAllowance(readLedger(root, NOW + 1000), key, config, NOW + 1000, { ignoreGap: true }).ok, true);
  for (let i = 0; i < 9; i += 1) recordReview(root, key, 0, NOW + 2000);
  assert.equal(reviewAllowance(readLedger(root, NOW + 3000), key, config, NOW + 3000, { ignoreGap: true }).ok, false);
  const nextDay = NOW + 25 * 3600 * 1000;
  assert.equal(readLedger(root, nextDay).total, 0);
  assert.ok(readLedger(root, NOW).cost_usd > 0);
});

test('only one worker holds the lock and a dead owner is replaced', () => {
  const root = core({ mode: 'auto' });
  assert.equal(acquireLock(root), true);
  assert.equal(acquireLock(root), false);
  assert.equal(workerRunning(root), true);
  releaseLock(root);
  fs.mkdirSync(learnPaths(root).base, { recursive: true });
  fs.writeFileSync(learnPaths(root).lock, JSON.stringify({ pid: 2 ** 30, at: NOW }));
  assert.equal(workerRunning(root), false);
  assert.equal(acquireLock(root), true);
  releaseLock(root);
});

test('the hook process prints nothing, exits 0 on bad input and is quick', () => {
  const root = core({ mode: 'off' });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const name of ['learn-hook.mjs', 'learn-queue.mjs', 'learn-window.mjs']) fs.copyFileSync(path.join(SCRIPTS, name), path.join(root, 'scripts', name));
  for (const event of ['stop', 'precompact', 'end', 'start']) {
    for (const input of ['{not json', '', JSON.stringify(payload(root, path.join(root, 'none.jsonl')))]) {
      const started = Date.now();
      const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-hook.mjs'), event], { input, encoding: 'utf8' });
      assert.equal(run.status, 0);
      assert.equal(run.stdout, '');
      assert.equal(run.stderr, '');
      assert.ok(Date.now() - started < 3000);
    }
  }
  assert.equal(fs.existsSync(path.join(root, 'runtime')), false);
});

test('the shipped Claude settings switch built-in memory off and register the four quiet hooks', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.autoMemoryEnabled, false);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart', 'Stop']);
  for (const entries of Object.values(settings.hooks)) {
    const command = entries[0].hooks[0].command;
    assert.match(command, /^node "\$CLAUDE_PROJECT_DIR\/scripts\/learn-hook\.mjs" (start|stop|precompact|end)$/);
  }
  assert.ok(settings.hooks.SessionEnd[0].hooks[0].timeout <= 5);
});

// -- concurrency and recovery (real competing processes) ----------------------------------------------------

const QUEUE_URL = new URL('./learn-queue.mjs', import.meta.url).href;
const runNode = (code, args) => spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], { encoding: 'utf8' });

test('real competing processes: exactly one gets the worker lock, and a loser cannot release it', () => {
  const root = core({ mode: 'auto' });
  const code = `import {acquireLock, releaseLock} from '${QUEUE_URL}';
    const got = acquireLock(process.argv[1]);
    if (got) { await new Promise(r => setTimeout(r, 700)); releaseLock(process.argv[1]); }
    else releaseLock(process.argv[1]);
    process.stdout.write(got ? 'won' : 'lost');`;
  const children = Array.from({ length: 6 }, () => new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, root], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    });
  }));
  return Promise.all(children).then((results) => {
    assert.equal(results.filter((r) => r === 'won').length, 1);
    assert.equal(results.filter((r) => r === 'lost').length, 5);
    assert.equal(fs.existsSync(learnPaths(root).lock), false);
  });
});

test('real competing processes: concurrent hooks never lose an event or a compaction snapshot', () => {
  const root = core({ mode: 'auto' });
  const code = `import {enqueue, loadConfig} from '${QUEUE_URL}';
    const [root, n] = process.argv.slice(1);
    for (let i = 0; i < 8; i++) enqueue(root, loadConfig(root), { session_id: 's', transcript_path: '/x/s.jsonl', cwd: root, scope: 'operator',
      reason: i % 4 === 0 ? 'before_compaction' : 'idle', spool: i % 4 === 0 ? { path: '/spool/' + n + '-' + i, from_line: i, lines: 1 } : null });`;
  return Promise.all(Array.from({ length: 4 }, (_, n) => new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => spawn(process.execPath, ['--input-type=module', '-e', code, root, String(n)], { stdio: 'inherit' }).on('close', resolve));
  }))).then(() => {
    const job = readJob(root, sessionKey('s'));
    assert.equal(job.spools.length, 8); // 4 processes x 2 compactions each, none overwritten
    assert.equal(job.turns, 24); // 4 x 6 idle stops, none lost
  });
});

test('a crashed worker leaves a claim that is recovered at once when no worker is alive, spools included', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.')]);
  const key = sessionKey('session-1');
  writeCursor(root, key, 0);
  fire(root, 'precompact', payload(root, file), NOW);
  claimJob(root, key);
  fire(root, 'precompact', payload(root, file), NOW + 1000); // a newer queue file with its own snapshot appears meanwhile
  assert.equal(recoverClaims(root, Date.now()), 0); // fresh claim, not forced
  assert.equal(recoverClaims(root, Date.now(), { force: true }), 1);
  assert.equal(readJob(root, key).spools.length, 2);
  assert.equal(fs.existsSync(path.join(learnPaths(root).claims, `${key}.json`)), false);
});

test('SessionStart starts the worker for a pending job and recovers an orphaned claim immediately', () => {
  const root = core({ mode: 'auto' });
  const file = transcript(root, [user('u1', 'From now on never use exclamation marks.')]);
  const key = sessionKey('session-1');
  fire(root, 'end', payload(root, file), NOW);
  claimJob(root, key); // the worker died right after claiming
  const started = [];
  handleEvent(root, 'start', {}, Date.now(), (r) => started.push(r));
  assert.deepEqual(started, [root]);
  assert.ok(readJob(root, key));
});

test('messages carry their own scope: a session that changes workspace is split, and an unknown workspace folder is skipped', () => {
  const root = core();
  fs.mkdirSync(path.join(root, 'workspaces', 'unknown'));
  const scopeOf = (cwd) => resolveScope(root, cwd);
  const at = (cwd, id, text) => user(id, text, { cwd });
  const file = transcript(root, [
    at(root, 'o1', 'Please remember I like short answers in general.'),
    at(path.join(root, 'workspaces', 'alpha'), 'w1', 'Client Alpha likes blue headlines in every deck.'),
    at(path.join(root, 'workspaces', 'unknown'), 'x1', 'Private note that has no manifest at all here.'),
    at(root, 'o2', 'Back at the top level now, my goal is a podcast.'),
  ]);
  const first = readWindow(file, 0, 24000, { scopeOf });
  assert.deepEqual([first.scope, first.messages.map((m) => m.id), first.more], ['operator', ['o1'], true]);
  const second = readWindow(file, first.nextLine, 24000, { scopeOf });
  assert.deepEqual([second.scope, second.messages.map((m) => m.id)], ['workspace:alpha', ['w1']]);
  const third = readWindow(file, second.nextLine, 24000, { scopeOf });
  assert.deepEqual([third.scope, third.messages.map((m) => m.id)], ['operator', ['o2']]); // x1 skipped, never operator
});

test('a very long operator message is reviewed up to the cap and the rest is recorded, not silently dropped', () => {
  const root = core();
  const file = transcript(root, [user('u1', `${'word '.repeat(5000)}and my goal is to ship by June`)]);
  const [message] = readWindow(file, 0, 40000).messages;
  assert.ok(message.unreviewed_chars > 0);
  assert.ok(message.text.endsWith('[trimmed]'));
});
