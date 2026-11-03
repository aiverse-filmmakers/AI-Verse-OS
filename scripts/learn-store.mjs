// The one durable store of automatic learning: a small SQLite database (WAL, synchronous=FULL, secure_delete) at
// runtime/learn/learn.db. It is working state: see the PR notes on where durable observations will live.
//
//   occurrences  the journal: one row per original human message, unique by (harness, session, uuid), with its authoritative
//                scope binding, its source lineage and screened text. Text is removed only after it was reviewed
//   items        what the reviewer found: the screened candidate, written BEFORE any owner is called, with the exact quote, its
//                place in the message (UTF-16 code units), the date, the scope, and later the actual inbox receipt
//   sessions     one row per chat: wake time and backoff;  captures  how far the transcript was read;  gaps  records too large to hold
//   secrets      salted hashes of credential values seen anywhere, so the value is dropped wherever it reappears
//   claims       the single worker lease;  ledger  review accounting;  counters / failures / seen_candidates  codes and hashes only
//
// The hook and the worker both open it. node:sqlite is built into Node 22.13+. A database that is not ours, or of another version, is
// REFUSED, never reset: this schema is the first one that holds anything worth keeping.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { learnPaths } from './learn-common.mjs';
import { CONTRACT_VERSION, IDENTIFIER, labelled, metadataOf, SAFE_PATH, secretValues, tokensOf } from './learn-capture.mjs';

export const APPLICATION_ID = 0x41495645; // "AIVE"
export const VERSION = 3;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, session_id TEXT, transcript TEXT, reason TEXT, turns INTEGER DEFAULT 0,
  due_at INTEGER, not_before INTEGER DEFAULT 0, blocked TEXT);
CREATE TABLE IF NOT EXISTS captures(session TEXT PRIMARY KEY, path TEXT, off INTEGER, anchor TEXT);
CREATE TABLE IF NOT EXISTS gaps(session TEXT, seq INTEGER, bytes INTEGER, at INTEGER, PRIMARY KEY(session, seq));
CREATE TABLE IF NOT EXISTS occurrences(id INTEGER PRIMARY KEY AUTOINCREMENT, harness TEXT NOT NULL, session TEXT NOT NULL, uuid TEXT NOT NULL,
  seq INTEGER, ts TEXT, scope TEXT NOT NULL, src_session TEXT, cli TEXT, contract INTEGER, text TEXT, size INTEGER DEFAULT 0, done_to INTEGER DEFAULT 0,
  state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, not_before INTEGER DEFAULT 0, at INTEGER, UNIQUE(harness, session, uuid));
CREATE INDEX IF NOT EXISTS occurrences_open ON occurrences(session, state, id);
CREATE TABLE IF NOT EXISTS secrets(h TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, scope TEXT, key TEXT UNIQUE, state TEXT, rev INTEGER DEFAULT 0,
  not_before INTEGER DEFAULT 0, body TEXT, result TEXT, at INTEGER, done_at INTEGER);
CREATE TABLE IF NOT EXISTS seen_candidates(session TEXT, h TEXT, PRIMARY KEY(session, h));
CREATE TABLE IF NOT EXISTS claims(name TEXT PRIMARY KEY, owner TEXT, lease_until INTEGER);
CREATE TABLE IF NOT EXISTS ledger(day TEXT, session TEXT, n INTEGER DEFAULT 0, cost REAL DEFAULT 0, last_at INTEGER DEFAULT 0, PRIMARY KEY(day, session));
CREATE TABLE IF NOT EXISTS counters(session TEXT, code TEXT, n INTEGER DEFAULT 0, PRIMARY KEY(session, code));
CREATE TABLE IF NOT EXISTS failures(id INTEGER PRIMARY KEY, session TEXT, at INTEGER, code TEXT);
`;

const refuse = (message) => Object.assign(new Error(message), { code: 'store_incompatible' });

// The storage folder must be a real private directory inside the Core, and the database a plain file: no symlink anywhere on the way.
function privateDirectory(root, base) {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(base);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw refuse('learning storage folder is not a plain directory');
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(base);
  if (path.relative(realRoot, real).startsWith('..')) throw refuse('learning storage folder escapes the Core');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) fs.chmodSync(base, 0o700);
}

export async function openStore(root, { busyMs = 15000 } = {}) {
  const { DatabaseSync } = await import('node:sqlite'); // throws on a Node without it: callers treat that as 'store_unavailable'
  const { base, db: file } = learnPaths(root);
  privateDirectory(root, base);
  if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile())) throw refuse('learning database is not a plain file');
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.floor(busyMs)}; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;`);
    // An empty database is initialised; anything else must be exactly ours at exactly this version. The check is repeated inside the
    // write lock, so two processes opening a new database at once cannot both initialise it, and neither ever drops anything.
    const identity = () => ({
      app: db.prepare('PRAGMA application_id').get().application_id,
      version: db.prepare('PRAGMA user_version').get().user_version,
      tables: db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n,
    });
    const verify = (id) => { if (id.app !== APPLICATION_ID || id.version !== VERSION) throw refuse('learning database is not ours or has another schema version'); };
    const first = identity();
    if (first.tables > 0) verify(first);
    else {
      tx(db, () => {
        const again = identity();
        if (again.tables > 0) { verify(again); return; }
        db.exec(SCHEMA);
        db.exec(`PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${VERSION}`);
      });
    }
    db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES(?, ?)').run('salt', crypto.randomBytes(16).toString('hex'));
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

// BEGIN IMMEDIATE takes the write lock up front, so two writers never deadlock; an exception rolls everything back.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

// -- the worker lease (the only claim: one serial worker) -------------------------------------------------------------------

export function acquire(db, name, owner, ttlMs, now = Date.now()) {
  return db.prepare(`INSERT INTO claims(name, owner, lease_until) VALUES(?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until
    WHERE claims.lease_until < ? OR claims.owner = excluded.owner`).run(name, owner, now + ttlMs, now).changes === 1;
}
export const renew = (db, name, owner, ttlMs, now = Date.now()) =>
  db.prepare('UPDATE claims SET lease_until = ? WHERE name = ? AND owner = ? AND lease_until >= ?').run(now + ttlMs, name, owner, now).changes === 1;
export const holds = (db, name, owner, now = Date.now()) =>
  Boolean(db.prepare('SELECT 1 FROM claims WHERE name = ? AND owner = ? AND lease_until >= ?').get(name, owner, now));
export const release = (db, name, owner) => db.prepare('DELETE FROM claims WHERE name = ? AND owner = ?').run(name, owner);

// -- capture: records become occurrences, once --------------------------------------------------------------------------

const hasher = (db) => {
  const salt = db.prepare("SELECT v FROM meta WHERE k = 'salt'").get().v;
  return (value) => crypto.createHash('sha256').update(salt + value).digest('hex').slice(0, 32);
};
const knownHashes = (db) => new Set(db.prepare('SELECT h FROM secrets').all().map((r) => r.h));
const mentions = (text, hashes, h) => [...tokensOf(text)].some((t) => hashes.has(h(t)));

// True when the text names a credential or repeats a value already known to be one. Applied to EVERY field the pipeline persists
// or renders (statement, quote, replacement, the rendered proposal).
export const isSecretText = (db, text) => labelled(text) || mentions(text, knownHashes(db), hasher(db));

// batch: { key, session_id, transcript_path, reason, at, config: { idle_seconds, max_pending_turns }, records: [{ uuid, ts, seq, scope, text,
// src_session, cli }], gaps: [{ seq, bytes }], offset?: { path, end, anchor } }. One transaction: either the evidence, the committed
// read position and the wake time are all recorded, or none of them.
export function ingestBatch(db, batch, now = Date.now()) {
  const h = hasher(db);
  // Identifiers and paths are admitted in their own formats only (a sentence cannot be an identifier); a batch that fails is refused whole.
  if (!IDENTIFIER.test(batch.session_id) || !SAFE_PATH(batch.transcript_path)) throw Object.assign(new Error('invalid capture source'), { code: 'invalid_source' });
  batch = { ...batch, records: batch.records.filter((r) => IDENTIFIER.test(r.uuid)).map(metadataOf) };
  let discovered = false;
  const result = tx(db, () => {
    const hashes = knownHashes(db);
    const fresh = [];
    const remember = (value) => { const k = h(value); if (!hashes.has(k)) { hashes.add(k); fresh.push(k); } };
    // Contextual screening across messages: every credential value named anywhere in this batch is known before any message is kept.
    for (const r of batch.records) if (labelled(r.text)) for (const v of secretValues(r.text)) remember(v);
    const insert = db.prepare(`INSERT OR IGNORE INTO occurrences(harness, session, uuid, seq, ts, scope, src_session, cli, contract, text, size, state, at)
      VALUES('claude-code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let kept = 0;
    for (const r of batch.records) {
      const secret = labelled(r.text) || mentions(r.text, hashes, h);
      const added = insert.run(batch.key, r.uuid, r.seq, r.ts, r.scope, r.src_session ?? null, r.cli ?? null, CONTRACT_VERSION, secret ? null : r.text,
        secret ? 0 : r.text.length, secret ? 'excluded' : 'pending', now).changes;
      if (added && !secret) kept += 1;
    }
    for (const g of batch.gaps ?? []) {
      if (db.prepare('INSERT OR IGNORE INTO gaps(session, seq, bytes, at) VALUES(?, ?, ?, ?)').run(batch.key, g.seq, g.bytes, now).changes) {
        db.prepare("INSERT INTO counters(session, code, n) VALUES(?, 'oversize_human_record', 1) ON CONFLICT(session, code) DO UPDATE SET n = n + 1").run(batch.key);
      }
    }
    if (fresh.length) {
      for (const k of fresh) db.prepare('INSERT OR IGNORE INTO secrets(h) VALUES(?)').run(k);
      rescreen(db, hashes, h);
    }
    if (batch.offset) db.prepare('INSERT OR REPLACE INTO captures(session, path, off, anchor) VALUES(?, ?, ?, ?)').run(batch.key, batch.offset.path, batch.offset.end, batch.offset.anchor);
    wake(db, batch, now);
    discovered = fresh.length > 0;
    return { kept, gaps: (batch.gaps ?? []).length };
  });
  // A credential found late: the rows that held it were blanked (secure_delete zeroes them); rewrite the log so no old copy lingers.
  const purged = discovered ? purgeWal(db) : true;
  if (!purged) db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('purge_pending', '1')").run();
  return { ...result, purged };
}

// A newly learned credential removes what earlier, still unreviewed evidence and every retained candidate said about it. A candidate
// that already reached an inbox (or was about to) is marked for withdrawal and never recalled again.
function rescreen(db, hashes, h) {
  for (const row of db.prepare("SELECT id, text FROM occurrences WHERE state = 'pending' AND text IS NOT NULL").all()) {
    if (mentions(row.text, hashes, h)) db.prepare("UPDATE occurrences SET text = NULL, size = 0, state = 'excluded' WHERE id = ?").run(row.id);
  }
  for (const row of db.prepare("SELECT id, body, result FROM items WHERE state IN ('pending', 'needs_scope', 'filing', 'done') AND body != '{}'").all()) {
    const item = JSON.parse(row.body);
    if (!mentions(`${item.statement ?? ''} ${item.quote ?? ''} ${item.replaces ?? ''}`, hashes, h)) continue;
    const effect = row.result ? JSON.parse(row.result).effect : null;
    db.prepare("UPDATE items SET state = ?, body = '{}', rev = rev + 1, not_before = 0 WHERE id = ?").run(effect ? 'withdraw_pending' : 'excluded', row.id);
  }
}

// Truncating checkpoint, retried while a reader pins the log (each try waits only briefly, whatever the usual busy timeout is).
// false means old frames may still be in the file.
export function purgeWal(db, tries = 5) {
  const usual = db.prepare('PRAGMA busy_timeout').get().timeout;
  db.exec('PRAGMA busy_timeout = 150');
  try {
    for (let i = 0; i < tries; i += 1) {
      try {
        if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy === 0) return true;
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return false;
  } finally {
    db.exec(`PRAGMA busy_timeout = ${usual}`);
  }
}

// The debounce: an idle stop waits for quiet, a burst of turns or a compaction or the end of a chat is due at once.
function wake(db, batch, now) {
  const previous = db.prepare('SELECT * FROM sessions WHERE key = ?').get(batch.key);
  const cfg = batch.config;
  const turns = (previous?.turns ?? 0) + (batch.reason === 'idle' ? 1 : 0);
  const pendingReason = previous?.due_at != null ? previous.reason : null;
  const urgent = pendingReason && !['idle', 'n_turns'].includes(pendingReason) && batch.reason === 'idle';
  const reason = urgent ? pendingReason : batch.reason === 'idle' && turns >= cfg.max_pending_turns ? 'n_turns' : batch.reason;
  const due = reason === 'idle' ? (batch.at ?? now) + cfg.idle_seconds * 1000 : urgent ? previous.due_at : (batch.at ?? now);
  db.prepare(`INSERT INTO sessions(key, session_id, transcript, reason, turns, due_at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET transcript = excluded.transcript, reason = excluded.reason, turns = excluded.turns, due_at = excluded.due_at`)
    .run(batch.key, batch.session_id, batch.transcript_path, reason, turns, due);
}

// -- review accounting: reserved BEFORE the reviewer is launched, so a crash can never spend uncounted allowance ---------------

export const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

export function reserveReview(db, key, config, now, ignoreGap, allowed = () => true) {
  return tx(db, () => {
    if (!allowed()) return { ok: false, off: true }; // learning was switched off: not even the accounting is written
    const day = dayOf(now);
    const mine = db.prepare('SELECT n FROM ledger WHERE day = ? AND session = ?').get(day, key);
    const total = db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM ledger WHERE day = ?').get(day).n;
    if ((mine?.n ?? 0) >= config.max_reviews_per_session_per_day || total >= config.max_reviews_per_day) {
      return { ok: false, not_before: Date.parse(`${day}T00:00:00Z`) + 24 * 3600 * 1000 };
    }
    const last = db.prepare('SELECT MAX(last_at) AS t FROM ledger WHERE session = ?').get(key).t ?? 0;
    if (!ignoreGap && last + config.min_gap_seconds * 1000 > now) return { ok: false, not_before: last + config.min_gap_seconds * 1000 };
    db.prepare(`INSERT INTO ledger(day, session, n, cost, last_at) VALUES(?, ?, 1, ?, ?)
      ON CONFLICT(day, session) DO UPDATE SET n = n + 1, cost = cost + excluded.cost, last_at = excluded.last_at`).run(day, key, config.max_budget_usd, now);
    return { ok: true, day, reserved: config.max_budget_usd };
  });
}

export const settleReview = (db, key, reservation, actual) =>
  db.prepare('UPDATE ledger SET cost = cost - ? + ? WHERE day = ? AND session = ?').run(reservation.reserved, actual, reservation.day, key);
