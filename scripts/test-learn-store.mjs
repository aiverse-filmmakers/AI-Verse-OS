#!/usr/bin/env node
// The store under real competition and crashes (separate processes, an expired lease, a process killed inside a transaction),
// configuration, the schema, and windows measured in absolute offsets. Needs Node 22.13+ (node:sqlite).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { learnPaths, loadConfig, readStatus, sqliteTooOld } from './learn-common.mjs';
import { DatabaseSync } from 'node:sqlite';
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
  assert.deepEqual(fs.readdirSync(learnPaths(root).base).filter((n) => !/^learn\.db/.test(n) && n !== 'status'), []); // no other file was ever written
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
  db.prepare("INSERT INTO occurrences(harness, session, uuid, origin, scope, text, size, at) VALUES('claude-code', 'k', 'u', 'k', 'operator', ?, ?, 0)").run(text, text.length);
  db.prepare("INSERT INTO occurrences(harness, session, uuid, origin, scope, text, size, at) VALUES('claude-code', 'k', 'v', 'k', 'operator', ?, ?, 0)").run('Second message, identical words.', 32);
  db.prepare("INSERT INTO occurrences(harness, session, uuid, origin, scope, text, size, at) VALUES('claude-code', 'k', 'w', 'k', 'operator', ?, ?, 0)").run('Second message, identical words.', 32);
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

test('opening inspects identity BEFORE changing anything: an empty database of another application or version, or one with only schema objects, is refused untouched', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const refusedAt = async (sql, check) => {
    const root = core();
    fs.mkdirSync(learnPaths(root).base, { recursive: true });
    const d = new DatabaseSync(learnPaths(root).db);
    d.exec(sql);
    d.close();
    await assert.rejects(openStore(root), (error) => error.code === 'store_incompatible');
    const after = new DatabaseSync(learnPaths(root).db);
    check(after);
    after.close();
  };
  // empty, but claimed by another application and a future version: it must not be adopted
  await refusedAt('PRAGMA application_id = 12345; PRAGMA user_version = 99', (d) => {
    assert.deepEqual([d.prepare('PRAGMA application_id').get().application_id, d.prepare('PRAGMA user_version').get().user_version], [12345, 99]);
    assert.equal(d.prepare('PRAGMA journal_mode').get().journal_mode, 'delete'); // not even switched to WAL
  });
  // no table, but a view
  await refusedAt('CREATE VIEW precious AS SELECT 1 AS x', (d) => assert.equal(d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'precious'").get().n, 1));
  // our identity at a version nobody here knows
  await refusedAt(`PRAGMA application_id = ${0x41495645}; PRAGMA user_version = 2`, (d) => assert.equal(d.prepare('PRAGMA user_version').get().user_version, 2));
});

test('the exclusion salt is never regenerated while exclusions exist: the store stops instead', async () => {
  const root = core();
  await capture(root, 's', [{ uuid: 'a', text: 'My password is lilac7.' }]);
  const before = peek(root, "SELECT v FROM meta WHERE k = 'salt'")[0].v;
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(learnPaths(root).db);
  d.exec("DELETE FROM meta WHERE k = 'salt'");
  d.close();
  await assert.rejects(openStore(root), (error) => error.code === 'store_incompatible' && /salt/.test(error.message));
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM meta WHERE k = 'salt'")[0].n, 0); // nothing was invented
  assert.ok(before);
});

test('a link anywhere between the Core and the database is refused before anything is created behind it', async () => {
  const target = tempDir('aiverse-elsewhere-');
  const root = core();
  try {
    fs.symlinkSync(target, path.join(root, 'runtime', 'learn')); // the storage folder itself
    await assert.rejects(openStore(root), (error) => error.code === 'store_incompatible');
    fs.rmSync(path.join(root, 'runtime', 'learn'));
    fs.rmSync(path.join(root, 'runtime'), { recursive: true });
    fs.symlinkSync(target, path.join(root, 'runtime')); // an ancestor
    await assert.rejects(openStore(root), (error) => error.code === 'store_incompatible');
    assert.deepEqual(fs.readdirSync(target), []);
    assert.deepEqual(readStatus(root), []); // and not even a health file was written through the link
  } catch (error) { if (error.code !== 'EPERM') throw error; }
});

test('a populated version 3 database is migrated without loss: every occurrence, the exclusion hashes and the salt carry over, and a second open changes nothing', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = core();
  fs.mkdirSync(learnPaths(root).base, { recursive: true });
  const old = new DatabaseSync(learnPaths(root).db);
  old.exec(`PRAGMA application_id = ${0x41495645}; PRAGMA user_version = 3;
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE sessions(key TEXT PRIMARY KEY, session_id TEXT, transcript TEXT, reason TEXT, turns INTEGER DEFAULT 0, due_at INTEGER, not_before INTEGER DEFAULT 0, blocked TEXT);
    CREATE TABLE captures(session TEXT PRIMARY KEY, path TEXT, off INTEGER, anchor TEXT);
    CREATE TABLE gaps(session TEXT, seq INTEGER, bytes INTEGER, at INTEGER, PRIMARY KEY(session, seq));
    CREATE TABLE occurrences(id INTEGER PRIMARY KEY AUTOINCREMENT, harness TEXT NOT NULL, session TEXT NOT NULL, uuid TEXT NOT NULL, seq INTEGER, ts TEXT, scope TEXT NOT NULL, src_session TEXT, cli TEXT, contract INTEGER, text TEXT, size INTEGER DEFAULT 0, done_to INTEGER DEFAULT 0, state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, not_before INTEGER DEFAULT 0, at INTEGER, UNIQUE(harness, session, uuid));
    CREATE TABLE secrets(h TEXT PRIMARY KEY);
    CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, scope TEXT, key TEXT UNIQUE, state TEXT, rev INTEGER DEFAULT 0, not_before INTEGER DEFAULT 0, body TEXT, result TEXT, at INTEGER, done_at INTEGER);
    CREATE TABLE seen_candidates(session TEXT, h TEXT, PRIMARY KEY(session, h));
    CREATE TABLE claims(name TEXT PRIMARY KEY, owner TEXT, lease_until INTEGER);
    CREATE TABLE ledger(day TEXT, session TEXT, n INTEGER DEFAULT 0, cost REAL DEFAULT 0, last_at INTEGER DEFAULT 0, PRIMARY KEY(day, session));
    CREATE TABLE counters(session TEXT, code TEXT, n INTEGER DEFAULT 0, PRIMARY KEY(session, code));
    CREATE TABLE failures(id INTEGER PRIMARY KEY, session TEXT, at INTEGER, code TEXT);
    INSERT INTO meta VALUES('salt', 'abc123');
    INSERT INTO secrets VALUES('feedface');
    INSERT INTO occurrences(harness, session, uuid, seq, ts, scope, src_session, text, size, state, at) VALUES
      ('claude-code', 'k1', 'u1', 0, '2026-01-02T10:00:00+02:00', 'operator', NULL, 'I always want warm replies.', 27, 'pending', 1),
      ('claude-code', 'k1', 'u2', 1, NULL, 'operator', 'orig-chat', 'My goal is to finish the report.', 33, 'pending', 2),
      ('claude-code', 'k1', 'u3', 2, NULL, 'workspace:alpha', NULL, NULL, 0, 'done', 3);
    INSERT INTO items(session, scope, key, state, body, at) VALUES('k1', 'operator', 'key1', 'done', '{"statement":"kept"}', 5);
    INSERT INTO seen_candidates VALUES('k1', 'oldhash');`);
  old.close();
  const db = await openStore(root);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  assert.deepEqual(db.prepare('SELECT uuid, origin, ts_ms, state FROM occurrences ORDER BY id').all().map((r) => `${r.uuid}|${r.origin === 'k1' ? 'k1' : 'sha'}|${r.ts_ms}|${r.state}`), ['u1|k1|1767340800000|pending', 'u2|sha|null|pending', 'u3|k1|null|done']);
  assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'salt'").get().v, 'abc123');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM secrets').get().n, 1);
  assert.equal(JSON.parse(db.prepare('SELECT body FROM items').get().body).statement, 'kept');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_candidates').get().n, 0); // the meaning of those hashes changed: reviews simply ask again
  assert.ok(db.prepare("SELECT name FROM pragma_table_info('gaps')").all().some((c) => c.name === 'resolved'));
  db.close();
  const again = await openStore(root);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM occurrences').get().n, 3);
  again.close();
});

test('storage that cannot be relied on is refused unless the member explicitly accepts the risk; independent health conditions never overwrite each other', async () => {
  const synced = tempDir('aiverse-learn-');
  const core_ = path.join(synced, 'Dropbox', 'Core');
  fs.mkdirSync(core_, { recursive: true });
  await assert.rejects(openStore(core_, { config: { accept_storage_risk: false } }), (error) => error.code === 'storage_unsafe');
  assert.equal(fs.existsSync(path.join(core_, 'runtime')), false); // nothing was created
  (await openStore(core_, { config: { accept_storage_risk: true } })).close();
  const here = core({ accept_storage_risk: false });
  const verdict = await openStore(here, { config: loadConfig(here) }).then((d) => { d.close(); return 'opens'; }, (error) => error.code);
  const version = (() => { const d = new DatabaseSync(':memory:'); const v = d.prepare('SELECT sqlite_version() AS v').get().v; d.close(); return v; })();
  assert.equal(verdict, sqliteTooOld(version) ? 'storage_unsafe' : 'opens'); // this machine's SQLite decides, by the documented rule
  // twenty processes each raise a different condition at the same moment: none is lost
  const root = core();
  const codes = Array.from({ length: 20 }, (_, i) => `condition_${i}`);
  const results = await Promise.all(codes.map((code) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { setStatus } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'learn-common.mjs')).href)}; setStatus(${JSON.stringify(root)}, ${JSON.stringify(code)});`], { stdio: 'ignore' });
    child.on('exit', resolve);
  })));
  assert.ok(results.every((c) => c === 0));
  assert.deepEqual(readStatus(root), [...codes].sort());
});
