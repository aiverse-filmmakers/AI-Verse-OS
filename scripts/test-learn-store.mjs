#!/usr/bin/env node
// The store under real competition and crashes (separate processes, an expired lease, a process killed inside a transaction),
// configuration, the schema, and windows measured in absolute offsets. Needs Node 22.13+ (node:sqlite).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { learnPaths, loadConfig, readStatus } from './learn-common.mjs';
import { acquire, holds, ingestBatch, openStore, purgeWal, release, renew, reserveReview, tx } from './learn-store.mjs';
import { buildWindow, chooseCut } from './learn-worker.mjs';
import { allText, capture, core, hookEvent, hookEventAsync, peek, session, setMode, tempDir, userLine, writeTranscript } from './test-learn-support.mjs';

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

test('forty hooks at once lose nothing: each either records its batch or fails closed (exit 1, nothing written), and one more pass finds every occurrence exactly once', async () => {
  const root = core();
  const transcript = path.join(root, 't.jsonl');
  writeTranscript(transcript, [userLine('u1', 'I always want warm replies.', root), userLine('u2', 'My goal is to finish the report.', root)]);
  const codes = await Promise.all(Array.from({ length: 40 }, (_, i) => hookEventAsync(root, i % 2 ? 'stop' : 'end', { session_id: `s${i % 4}`, transcript_path: transcript, cwd: root })));
  assert.ok(codes.every((c) => c === 0 || c === 1));
  for (let i = 0; i < 4; i += 1) assert.equal(hookEvent(root, 'end', { session_id: `s${i}`, transcript_path: transcript, cwd: root }).status, 0);
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM occurrences')[0].n, 8); // 4 sessions x 2 records, each once
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM sessions')[0].n, 4);
  assert.deepEqual(fs.readdirSync(learnPaths(root).base).filter((n) => !/^learn\.db/.test(n) && n !== 'status.json'), []); // no other file was ever written
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
  await child(root, `acquire(db, 'worker', 'dead', 60000); process.kill(process.pid, 'SIGKILL');`);
  assert.equal(acquire(db, 'worker', 'live', 60000), false);
  assert.equal(acquire(db, 'worker', 'live', 60000, Date.now() + 90000), true); // once the dead holder's lease has run out
  db.close();
});

test('the schema is created once and a database that is not ours, another version, or reached through a link is refused untouched', async () => {
  const root = core();
  const db = await openStore(root);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  assert.ok(['occurrences', 'items', 'sessions', 'secrets', 'captures', 'gaps', 'seen_candidates'].every((t) => tables.includes(t)));
  assert.equal(db.prepare('PRAGMA secure_delete').get().secure_delete, 1);
  assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x41495645);
  db.close();
  (await openStore(root)).close(); // opening a current database changes nothing
  const { DatabaseSync } = await import('node:sqlite');
  const refused = async (setup, check) => {
    const r = core();
    fs.mkdirSync(learnPaths(r).base, { recursive: true });
    const before = setup(r);
    await assert.rejects(openStore(r), (error) => error.code === 'store_incompatible' || /ENOENT|EEXIST/.test(error.code ?? ''));
    check(r, before);
  };
  const sqliteAt = (file, sql) => { const d = new DatabaseSync(file); d.exec(sql); d.close(); };
  await refused((r) => { sqliteAt(learnPaths(r).db, "CREATE TABLE sessions(key TEXT, legacy TEXT); INSERT INTO sessions VALUES('k', 'precious')"); },
    (r) => assert.equal(peek(r, 'SELECT legacy FROM sessions')[0].legacy, 'precious')); // an unrelated or older database is preserved, never reset
  await refused((r) => { sqliteAt(learnPaths(r).db, `CREATE TABLE occurrences(x); PRAGMA application_id = ${0x41495645}; PRAGMA user_version = 99`); },
    (r) => assert.equal(peek(r, 'SELECT name FROM sqlite_master')[0].name, 'occurrences')); // a FUTURE version is refused, not downgraded
  const linked = core();
  const target = tempDir('aiverse-elsewhere-');
  fs.mkdirSync(path.join(linked, 'runtime'), { recursive: true });
  try {
    fs.symlinkSync(target, learnPaths(linked).base);
    await assert.rejects(openStore(linked), (error) => error.code === 'store_incompatible');
    assert.deepEqual(fs.readdirSync(target), []);
  } catch (error) { if (error.code !== 'EPERM') throw error; }
  const dbLinked = core();
  fs.mkdirSync(learnPaths(dbLinked).base, { recursive: true });
  const elsewhere = path.join(target, 'x.db');
  sqliteAt(elsewhere, 'CREATE TABLE t(x)');
  try {
    fs.symlinkSync(elsewhere, learnPaths(dbLinked).db);
    await assert.rejects(openStore(dbLinked), (error) => error.code === 'store_incompatible');
  } catch (error) { if (error.code !== 'EPERM') throw error; }
  // the worker reports it and does nothing else
  const worker = core();
  fs.mkdirSync(learnPaths(worker).base, { recursive: true });
  sqliteAt(learnPaths(worker).db, "CREATE TABLE sessions(key TEXT)");
  const { run } = await import('./learn-worker.mjs');
  assert.equal((await run(worker, { drain: true })).code, 'store_incompatible');
  assert.ok(readStatus(worker).includes('store_incompatible'));
});

test('a purge of the write-ahead log that a reader blocks is noticed, kept pending and finished later; the secret is gone from the log afterwards', async () => {
  const root = core();
  await capture(root, 's1', [{ uuid: 'a', text: 'Always use lilac7 to log in.' }, { uuid: 'b', text: 'I always want warm replies.' }]);
  const reader = new (await import('node:sqlite')).DatabaseSync(learnPaths(root).db);
  reader.exec('BEGIN'); // a pinned reader
  reader.prepare('SELECT COUNT(*) FROM occurrences').get();
  const db = await openStore(root);
  const found = ingestBatch(db, { key: 'k2', session_id: 's2', transcript_path: '/x', reason: 'session_end', at: Date.now(), config: { idle_seconds: 1, max_pending_turns: 6 }, records: [{ uuid: 'c', seq: 0, ts: null, scope: 'operator', text: 'My password is lilac7.' }] });
  assert.equal(found.purged, false);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'purge_pending'").get().v, '1');
  reader.exec('ROLLBACK');
  reader.close();
  assert.equal(purgeWal(db), true);
  db.close();
  assert.equal(allText(root).includes('lilac7'), false);
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
