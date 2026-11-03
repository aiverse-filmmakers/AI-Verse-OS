#!/usr/bin/env node
// The store under real competition and crashes (separate processes, an expired lease, a process killed inside a transaction),
// configuration, the schema, and windows measured in absolute offsets. Needs Node 22.13+ (node:sqlite).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { learnPaths, loadConfig } from './learn-common.mjs';
import { acquire, holds, openStore, release, renew, reserveReview, tx } from './learn-store.mjs';
import { buildWindow, chooseCut } from './learn-worker.mjs';
import { core, hookEventAsync, peek, session, setMode, userLine, writeTranscript } from './test-learn-support.mjs';

const child = (root, body) => new Promise((resolve) => {
  const script = `import { openStore, acquire, renew, holds, tx } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'learn-store.mjs')).href)};
    const db = await openStore(${JSON.stringify(root)}); ${body}`;
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('exit', (code, signal) => resolve({ code, signal, out: out.trim() }));
});

test('config: absent, malformed and unknown modes are off; propose and auto are on; numbers are bounded', () => {
  const root = core();
  const file = path.join(root, '.aiverse', 'learn', 'config.json');
  for (const mode of ['propose', 'auto']) {
    fs.writeFileSync(file, JSON.stringify({ mode }));
    assert.equal(loadConfig(root).mode, mode);
  }
  for (const bad of ['{', JSON.stringify({ mode: 'on' }), JSON.stringify({ mode: true }), JSON.stringify({ model: 'x' }), '[]', 'null']) {
    fs.writeFileSync(file, bad);
    assert.equal(loadConfig(root).mode, 'off', bad);
  }
  fs.rmSync(file);
  assert.equal(loadConfig(root).mode, 'off');
  fs.writeFileSync(file, JSON.stringify({ mode: 'propose', window_chars: 0, idle_seconds: -5, max_budget_usd: 99, review_timeout_seconds: 'x', max_pending_mb: 0 }));
  const c = loadConfig(root);
  assert.deepEqual([c.window_chars, c.idle_seconds, c.max_budget_usd, c.review_timeout_seconds, c.max_pending_mb], [1000, 0, 2, 120, 1]);
  assert.equal('allow_unfenced_auto' in c, false);
});

test('forty hooks at once lose no capture: each is in the journal or in an envelope, and every occurrence is there exactly once', async () => {
  const root = core();
  const transcript = path.join(root, 't.jsonl');
  writeTranscript(transcript, [userLine('u1', 'I always want warm replies.', root), userLine('u2', 'My goal is to finish the report.', root)]);
  const codes = await Promise.all(Array.from({ length: 40 }, (_, i) => hookEventAsync(root, i % 2 ? 'stop' : 'end', { session_id: `s${i % 4}`, transcript_path: transcript, cwd: root })));
  assert.ok(codes.every((c) => c === 0));
  const { ingestEnvelopes } = await import('./learn-store.mjs');
  const { listEnvelopes } = await import('./learn-common.mjs');
  const db = await openStore(root);
  ingestEnvelopes(db, root, listEnvelopes(root));
  db.close();
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM occurrences')[0].n, 8); // 4 sessions x 2 records
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM sessions')[0].n, 4);
  assert.equal(listEnvelopes(root).length, 0);
});

test('six processes race for an expired lease: exactly one wins; the old holder fails every ownership check', async () => {
  const root = core();
  const db = await openStore(root);
  assert.ok(acquire(db, 'worker', 'old-holder', 1, 1000)); // expired long ago
  const start = Date.now() + 1500;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => child(root, `while (Date.now() < ${start}) {} console.log(acquire(db, 'worker', 'racer-${i}', 60000) ? 'won' : 'lost');`)));
  assert.equal(results.filter((r) => r.out === 'won').length, 1, JSON.stringify(results));
  assert.equal(holds(db, 'worker', 'old-holder'), false);
  assert.equal(renew(db, 'worker', 'old-holder', 60000), false);
  assert.equal(release(db, 'worker', 'old-holder').changes, 0); // cannot release another's claim
  db.close();
});

test('a process killed inside a transaction leaves no half state and blocks nobody', async () => {
  const root = core();
  const db = await openStore(root);
  db.prepare("INSERT INTO failures(session, at, code) VALUES('keep', 1, 'before')").run();
  const crashed = await child(root, `tx(db, () => { db.prepare("INSERT INTO failures(session, at, code) VALUES('lost', 1, 'inside')").run(); process.kill(process.pid, 'SIGKILL'); });`);
  assert.ok(crashed.signal === 'SIGKILL' || crashed.code !== 0);
  assert.deepEqual(db.prepare('SELECT session FROM failures ORDER BY id').all().map((r) => r.session), ['keep']);
  assert.equal((await child(root, `console.log(tx(db, () => { db.prepare("INSERT INTO failures(session, at, code) VALUES('next', 1, 'ok')").run(); return 'done'; }));`)).out, 'done');
  await child(root, `acquire(db, 'worker', 'dead', 200); process.kill(process.pid, 'SIGKILL');`);
  assert.equal(acquire(db, 'worker', 'live', 60000), false);
  assert.equal(acquire(db, 'worker', 'live', 60000, Date.now() + 1000), true);
  db.close();
});

test('the schema is created once; a development database from before it is reset, not converted', async () => {
  const root = core();
  fs.mkdirSync(learnPaths(root).base, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(learnPaths(root).db);
  old.exec("CREATE TABLE sources(session TEXT, fp TEXT); CREATE TABLE handoffs(session TEXT); CREATE TABLE sessions(key TEXT PRIMARY KEY, legacy TEXT); INSERT INTO sessions VALUES('k', 'x')");
  old.close();
  const db = await openStore(root);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(['occurrences', 'items', 'sessions', 'secrets', 'captures'].every((t) => tables.includes(t)));
  assert.ok(!tables.includes('sources') && !tables.includes('handoffs'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
  db.close();
  (await openStore(root)).close(); // opening a current database changes nothing
});

test('windows are measured in absolute offsets: any budget, changed at any time, covers every character exactly once', async () => {
  const root = core();
  const text = Array.from({ length: 60 }, (_, i) => `Sentence ${i} says something quite ordinary.`).join(' ') + ' The end.';
  const db = await openStore(root);
  db.prepare("INSERT INTO occurrences(harness, session, uuid, scope, text, size, at) VALUES('claude-code', 'k', 'u', 'operator', ?, ?, 0)").run(text, text.length);
  db.prepare("INSERT INTO occurrences(harness, session, uuid, scope, text, size, at) VALUES('claude-code', 'k', 'v', 'operator', ?, ?, 0)").run('Second message, identical words.', 32);
  db.prepare("INSERT INTO occurrences(harness, session, uuid, scope, text, size, at) VALUES('claude-code', 'k', 'w', 'operator', ?, ?, 0)").run('Second message, identical words.', 32);
  let seen = '';
  const budgets = [500, 3000, 400, 900, 1500, 400, 10000];
  for (let i = 0; i < 40; i += 1) {
    const win = buildWindow(db, 'k', budgets[i % budgets.length], 0);
    if (!win) break;
    for (const seg of win.segs) {
      assert.equal(seg.start, db.prepare('SELECT done_to FROM occurrences WHERE id = ?').get(seg.occurrence).done_to);
      if (seg.uuid === 'u') seen += seg.text;
      db.prepare("UPDATE occurrences SET done_to = ?, state = CASE WHEN ? >= size THEN 'done' ELSE state END WHERE id = ?").run(seg.end, seg.end, seg.occurrence);
    }
  }
  assert.equal(seen, text); // not one character skipped or repeated
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 0);
  assert.equal(chooseCut('😀'.repeat(10), 5), 4); // never inside a surrogate pair
  db.close();
});

test('the review allowance is reserved before the reviewer is launched, and counted even if nothing ever settles it', async () => {
  const root = core();
  const db = await openStore(root);
  const cfg = { ...loadConfig(root), max_reviews_per_session_per_day: 2, min_gap_seconds: 0 };
  const t = Date.now();
  assert.equal(reserveReview(db, 'k', cfg, t, false).ok, true);
  assert.equal(reserveReview(db, 'k', cfg, t, false).ok, true);
  assert.equal(reserveReview(db, 'k', cfg, t, false).ok, false); // two reservations, no settlement, the cap holds
  assert.equal(reserveReview(db, 'k', cfg, t, false, () => false).off, true); // off: nothing at all is written
  assert.equal(db.prepare('SELECT SUM(n) AS n FROM ledger').get().n, 2);
  db.close();
});
