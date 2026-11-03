#!/usr/bin/env node
// The hook and the store under real competition: separate processes, an expired lease, a process killed inside a transaction.
// Also the transcript window: scopes, long messages, fingerprints. Needs Node 22.13+ (node:sqlite).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadConfig, learnPaths, resolveScope, sessionKey } from './learn-common.mjs';
import { acquire, holds, ingest, openStore, release, renew, tx } from './learn-store.mjs';
import { fingerprint, readLines, readSource, readWindow, splitText } from './learn-window.mjs';
import { appendTranscript, assistantLine, core, hookEvent, hookEventAsync, NODE, userLine, workspace, writeTranscript } from './test-learn-support.mjs';

const child = (root, body) => new Promise((resolve) => {
  const script = `import { openStore, acquire, renew, holds, tx } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'learn-store.mjs')).href)};
    const db = await openStore(${JSON.stringify(root)}); ${body}`;
  const p = spawn(process.execPath, [...NODE, '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('exit', (code, signal) => resolve({ code, signal, out: out.trim() }));
});

test('config: absent, malformed and unknown modes are off; propose and auto are on', () => {
  const root = core();
  const file = path.join(root, '.aiverse', 'learn', 'config.json');
  for (const mode of ['propose', 'auto']) {
    fs.writeFileSync(file, JSON.stringify({ mode }));
    assert.equal(loadConfig(root).mode, mode);
  }
  for (const bad of ['{', JSON.stringify({ mode: 'on' }), JSON.stringify({ mode: true }), JSON.stringify({ model: 'x' }), '[]']) {
    fs.writeFileSync(file, bad);
    assert.equal(loadConfig(root).mode, 'off', bad);
  }
  fs.rmSync(file);
  assert.equal(loadConfig(root).mode, 'off');
});

test('mode off writes nothing at all, and loop guards stop the hook', () => {
  const root = core({ mode: 'off' });
  const payload = { session_id: 's', transcript_path: path.join(root, 't.jsonl'), cwd: root };
  writeTranscript(payload.transcript_path, [userLine('u1', 'hello there my friend', root)]);
  hookEvent(root, 'stop', payload);
  assert.equal(fs.existsSync(learnPaths(root).base), false);
  fs.writeFileSync(path.join(root, '.aiverse/learn/config.json'), JSON.stringify({ mode: 'propose' }));
  hookEvent(root, 'stop', { ...payload, stop_hook_active: true });
  assert.equal(fs.existsSync(learnPaths(root).spool), false);
  const guarded = hookEvent(root, 'stop', payload);
  assert.equal(guarded.status, 0);
  assert.equal(guarded.stdout + guarded.stderr, '');
  assert.equal(fs.readdirSync(learnPaths(root).spool).length, 1);
});

test('forty hooks at once lose no event, and a corrupt event file is set aside, not dropped', async () => {
  const root = core({ mode: 'propose' });
  const transcript = path.join(root, 't.jsonl');
  writeTranscript(transcript, [userLine('u1', 'hello there my friend', root)]);
  const codes = await Promise.all(Array.from({ length: 40 }, (_, i) => hookEventAsync(root, i % 2 ? 'stop' : 'end', { session_id: `s${i % 4}`, transcript_path: transcript, cwd: root })));
  assert.ok(codes.every((c) => c === 0));
  const { spool } = learnPaths(root);
  assert.equal(fs.readdirSync(spool).filter((n) => n.endsWith('.json')).length, 40);
  assert.equal(fs.readdirSync(spool).filter((n) => n.endsWith('.tmp')).length, 0);
  fs.writeFileSync(path.join(spool, '000000000000001-bad.json'), '{not json');
  const db = await openStore(root);
  assert.equal(ingest(db, root), 40);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 4);
  assert.equal(fs.readdirSync(path.join(spool, 'bad')).length, 1);
  assert.equal(fs.readdirSync(spool).filter((n) => n.endsWith('.json')).length, 0);
  db.close();
});

test('an event file seen twice (crash between commit and delete) is applied once', async () => {
  const root = core({ mode: 'propose' });
  const transcript = path.join(root, 't.jsonl');
  writeTranscript(transcript, [userLine('u1', 'hello there my friend', root)]);
  hookEvent(root, 'stop', { session_id: 's', transcript_path: transcript, cwd: root });
  const { spool } = learnPaths(root);
  const [name] = fs.readdirSync(spool);
  const copy = fs.readFileSync(path.join(spool, name));
  const db = await openStore(root);
  ingest(db, root);
  fs.writeFileSync(path.join(spool, name), copy);
  ingest(db, root);
  assert.equal(db.prepare('SELECT turns FROM sessions').get().turns, 1);
  db.close();
});

test('six processes race for an expired lease: exactly one wins; the old holder fails every ownership check', async () => {
  const root = core({ mode: 'propose' });
  const db = await openStore(root);
  assert.ok(acquire(db, 'session:x', 'old-holder', 1, 1000)); // expired long ago
  const start = Date.now() + 1500;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => child(root,
    `while (Date.now() < ${start}) {} console.log(acquire(db, 'session:x', 'racer-${i}', 60000) ? 'won' : 'lost');`)));
  assert.equal(results.filter((r) => r.out === 'won').length, 1, JSON.stringify(results));
  assert.equal(holds(db, 'session:x', 'old-holder'), false);
  assert.equal(renew(db, 'session:x', 'old-holder', 60000), false);
  assert.equal(release(db, 'session:x', 'old-holder').changes, 0); // cannot release another's claim
  db.close();
});

test('a process killed inside a transaction leaves no half state and blocks nobody', async () => {
  const root = core({ mode: 'propose' });
  const db = await openStore(root);
  db.prepare("INSERT INTO failures(session, at, code) VALUES('keep', 1, 'before')").run();
  const crashed = await child(root, `tx(db, () => { db.prepare("INSERT INTO failures(session, at, code) VALUES('lost', 1, 'inside')").run(); process.kill(process.pid, 'SIGKILL'); });`);
  assert.equal(crashed.signal === 'SIGKILL' || crashed.code === 137 || crashed.code !== 0, true);
  assert.deepEqual(db.prepare('SELECT session FROM failures ORDER BY id').all().map((r) => r.session), ['keep']);
  const after = await child(root, `console.log(tx(db, () => { db.prepare("INSERT INTO failures(session, at, code) VALUES('next', 1, 'ok')").run(); return 'done'; }));`);
  assert.equal(after.out, 'done');
  // a holder killed while it held a lease: the lease expires and one successor takes it
  await child(root, `acquire(db, 'session:y', 'dead', 200); process.kill(process.pid, 'SIGKILL');`);
  assert.equal(acquire(db, 'session:y', 'live', 60000), false);
  assert.equal(acquire(db, 'session:y', 'live', 60000, Date.now() + 1000), true);
  db.close();
});

// -- window --------------------------------------------------------------------------------------------------

const scopeOf = (root) => (cwd) => resolveScope(root, cwd);

test('scopes: operator, manifest workspace, unmanifested folder and a missing cwd are each their own window; outside the Core is skipped', () => {
  const root = core({ mode: 'propose' });
  workspace(root, 'alpha');
  fs.mkdirSync(path.join(root, 'workspaces', 'ghost'));
  const lines = [
    userLine('o1', 'From now on never use exclamation marks please.', root),
    userLine('w1', 'Client Alpha likes blue headlines in every deck.', path.join(root, 'workspaces', 'alpha')),
    userLine('g1', 'Ghost folder has no manifest so unscoped.', path.join(root, 'workspaces', 'ghost')),
    userLine('n1', 'A message without any cwd at all stays unscoped.', null),
    assistantLine('a1', 'noted', null),
    userLine('x1', 'Something typed outside of the Core entirely.', path.dirname(root)),
    userLine('o2', 'Back in the operator area again later.', root),
  ];
  const seen = [];
  let cursor = { line: 0, part: 0 };
  for (let guard = 0; guard < 10; guard += 1) {
    const w = readWindow(lines, cursor, 24000, scopeOf(root));
    if (w.messages.length) seen.push([w.scope, w.messages.filter((m) => m.role === 'user').map((m) => m.id).join(',')]);
    if (w.atEnd) break;
    cursor = w.next;
  }
  assert.deepEqual(seen, [['operator', 'o1'], ['workspace:alpha', 'w1'], ['unscoped', 'g1,n1'], ['operator', 'o2']]);
});

test('a message longer than the window is delivered whole across parts, in order, nothing dropped', () => {
  const root = core({ mode: 'propose' });
  const sentences = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`);
  sentences.push('My goal is to finish the long migration by June.');
  const long = sentences.join(' ');
  const lines = [userLine('big', long, root), userLine('after', 'A normal message after the long one.', root)];
  let cursor = { line: 0, part: 0 };
  let text = '';
  let windows = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const w = readWindow(lines, cursor, 5000, scopeOf(root));
    windows += 1;
    for (const m of w.messages) if (m.id.startsWith('big')) { text += `${m.text} `; assert.equal(m.full, long); assert.ok(m.text.length <= 5000); }
    if (w.messages.some((m) => m.id === 'after')) break;
    cursor = w.next;
  }
  assert.ok(windows >= 3);
  assert.ok(text.replace(/\s+/g, ' ').includes('My goal is to finish the long migration by June.'));
  assert.equal(text.replace(/\s+/g, ''), long.replace(/\s+/g, ''));
  assert.deepEqual(splitText('abc', 5), ['abc']);
});

test('fingerprint and anchor: a replaced transcript is not read as the old one', () => {
  const root = core({ mode: 'propose' });
  const file = path.join(root, 't.jsonl');
  writeTranscript(file, [userLine('a', 'first message of the first transcript', root), userLine('b', 'second message of the first transcript', root)]);
  const lines = readLines(file);
  const fp = fingerprint(lines);
  const first = readWindow(lines, { line: 0, part: 0 }, 24000, scopeOf(root));
  const source = { fp, line: first.next.line, part: 0, anchor_line: first.anchor_line, anchor: first.anchor, backup: null, backup_lines: 0 };
  appendTranscript(file, [userLine('c', 'third message appended later on', root)]);
  assert.equal(readSource(source, file, 24000, scopeOf(root)).messages[0].id, 'c');
  // same length, same first line, different second line: anchor mismatch
  writeTranscript(file, [userLine('a', 'first message of the first transcript', root), userLine('z', 'completely different second message', root), userLine('c', 'third message appended later on', root)]);
  assert.equal(readSource(source, file, 24000, scopeOf(root)), null);
  // different first line: a different source altogether
  writeTranscript(file, [userLine('n', 'a brand new transcript after compaction', root)]);
  assert.equal(readSource({ ...source, line: 0, anchor_line: -1, anchor: '' }, file, 24000, scopeOf(root)), null);
  assert.notEqual(fingerprint(readLines(file)), fp);
});

test('the session key is stable and not the raw id', () => {
  assert.equal(sessionKey('abc'), sessionKey('abc'));
  assert.ok(!sessionKey('abc').includes('abc'));
});
