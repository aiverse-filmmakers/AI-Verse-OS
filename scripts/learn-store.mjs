// The one durable store of automatic learning: a small SQLite database (WAL, synchronous=FULL) at runtime/learn/learn.db.
//
//   occurrences  the journal: one row per original human message, unique by (harness, session, uuid), with its authoritative
//                scope binding and screened text. Text is removed only after it was reviewed; nothing unfinished is ever pruned
//   items        what the reviewer found: the screened plan, one row per candidate, written BEFORE any owner is called, with the
//                exact quote, its place in the message, the date, the scope, and later the owner's result
//   sessions     one row per chat: wake time and backoff;  captures  how far the transcript was read
//   secrets      salted hashes of credential values seen anywhere, so the value is dropped wherever it reappears
//   claims       the single worker lease;  ledger  review accounting;  counters / failures  codes and counts only
//
// Both the hook and the worker open it (the hook only when Node has node:sqlite; otherwise it leaves an envelope, see
// learn-common). node:sqlite is built into Node 22.13+. There are no migrations: nothing shipped before this schema.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { learnPaths, removeEnvelope, validEnvelope } from './learn-common.mjs';
import { labelled, secretValues, tokensOf } from './learn-capture.mjs';

const VERSION = 2;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, session_id TEXT, transcript TEXT, reason TEXT, turns INTEGER DEFAULT 0,
  due_at INTEGER, not_before INTEGER DEFAULT 0, blocked TEXT);
CREATE TABLE IF NOT EXISTS captures(session TEXT PRIMARY KEY, path TEXT, off INTEGER, anchor TEXT);
CREATE TABLE IF NOT EXISTS occurrences(id INTEGER PRIMARY KEY AUTOINCREMENT, harness TEXT NOT NULL, session TEXT NOT NULL, uuid TEXT NOT NULL,
  seq INTEGER, ts TEXT, scope TEXT NOT NULL, text TEXT, size INTEGER DEFAULT 0, done_to INTEGER DEFAULT 0, state TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0, not_before INTEGER DEFAULT 0, at INTEGER, UNIQUE(harness, session, uuid));
CREATE INDEX IF NOT EXISTS occurrences_open ON occurrences(session, state, id);
CREATE TABLE IF NOT EXISTS secrets(h TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, scope TEXT, key TEXT UNIQUE, state TEXT,
  not_before INTEGER DEFAULT 0, body TEXT, result TEXT, at INTEGER, done_at INTEGER);
CREATE TABLE IF NOT EXISTS claims(name TEXT PRIMARY KEY, owner TEXT, lease_until INTEGER);
CREATE TABLE IF NOT EXISTS ledger(day TEXT, session TEXT, n INTEGER DEFAULT 0, cost REAL DEFAULT 0, last_at INTEGER DEFAULT 0, PRIMARY KEY(day, session));
CREATE TABLE IF NOT EXISTS counters(session TEXT, code TEXT, n INTEGER DEFAULT 0, PRIMARY KEY(session, code));
CREATE TABLE IF NOT EXISTS failures(id INTEGER PRIMARY KEY, session TEXT, at INTEGER, code TEXT);
`;

export async function openStore(root, { busyMs = 15000 } = {}) {
  const { DatabaseSync } = await import('node:sqlite'); // throws on a Node without it: callers treat that as 'store_unavailable'
  const { base, db: file } = learnPaths(root);
  fs.mkdirSync(base, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${Math.floor(busyMs)}; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;`);
  if (db.prepare('PRAGMA user_version').get().user_version < VERSION) {
    // development databases from before this schema held only disposable queue state; nothing shipped, so nothing is converted
    tx(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version >= VERSION) return; // another process finished the reset first
      for (const old of ['sources', 'handoffs', 'reviews', 'receipts', 'seen_records', 'seen_text', 'seen', 'sessions', 'ledger', 'counters', 'failures', 'claims']) db.exec(`DROP TABLE IF EXISTS ${old}`);
      db.exec(SCHEMA);
      db.exec(`PRAGMA user_version = ${VERSION}`);
    });
  }
  db.exec(SCHEMA);
  db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES(?, ?)').run('salt', crypto.randomBytes(16).toString('hex'));
  return db;
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
const mentions = (text, hashes, h) => [...tokensOf(text)].some((t) => hashes.has(h(t)));

// batch: { key, session_id, transcript_path, reason, at, config: { idle_seconds, max_pending_turns }, records: [{ uuid, ts, seq, scope,
// text }], offset?: { path, end, anchor } }. One transaction: either the evidence and the wake time are both recorded, or neither.
export function ingestBatch(db, batch, now = Date.now()) {
  const h = hasher(db);
  let discovered = false;
  const result = tx(db, () => {
    const hashes = new Set(db.prepare('SELECT h FROM secrets').all().map((r) => r.h));
    const fresh = [];
    const remember = (value) => { const k = h(value); if (!hashes.has(k)) { hashes.add(k); fresh.push(k); } };
    // Contextual screening across messages: every credential value named anywhere in this batch is known before any message is kept.
    for (const r of batch.records) if (labelled(r.text)) for (const v of secretValues(r.text)) remember(v);
    const insert = db.prepare(`INSERT OR IGNORE INTO occurrences(harness, session, uuid, seq, ts, scope, text, size, state, at)
      VALUES('claude-code', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let kept = 0;
    for (const r of batch.records) {
      const secret = labelled(r.text) || mentions(r.text, hashes, h);
      const added = insert.run(batch.key, r.uuid, r.seq, r.ts, r.scope, secret ? null : r.text, secret ? 0 : r.text.length, secret ? 'excluded' : 'pending', now).changes;
      if (added && !secret) kept += 1;
    }
    if (fresh.length) {
      for (const k of fresh) db.prepare('INSERT OR IGNORE INTO secrets(h) VALUES(?)').run(k);
      rescreen(db, hashes, h);
    }
    if (batch.offset) db.prepare('INSERT OR REPLACE INTO captures(session, path, off, anchor) VALUES(?, ?, ?, ?)').run(batch.key, batch.offset.path, batch.offset.end, batch.offset.anchor);
    wake(db, batch, now);
    discovered = fresh.length > 0;
    return { kept };
  });
  // A credential found late: the rows that held it were blanked (secure_delete zeroes them); rewrite the log so no old copy lingers.
  if (discovered) try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  return result;
}

// A newly learned credential also removes what earlier, still unreviewed evidence and unfiled candidates said about it.
function rescreen(db, hashes, h) {
  for (const row of db.prepare("SELECT id, text FROM occurrences WHERE state = 'pending' AND text IS NOT NULL").all()) {
    if (mentions(row.text, hashes, h)) db.prepare("UPDATE occurrences SET text = NULL, size = 0, state = 'excluded' WHERE id = ?").run(row.id);
  }
  for (const row of db.prepare("SELECT id, body FROM items WHERE state IN ('pending', 'needs_scope')").all()) {
    const item = JSON.parse(row.body);
    if (mentions(`${item.statement} ${item.quote}`, hashes, h)) db.prepare("UPDATE items SET state = 'excluded', body = '{}' WHERE id = ?").run(row.id);
  }
}

export const candidateIsSecret = (db, text) => {
  const h = hasher(db);
  const hashes = new Set(db.prepare('SELECT h FROM secrets').all().map((r) => r.h));
  return labelled(text) || mentions(text, hashes, h);
};

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

// Envelopes left by a hook that could not reach the database. A malformed one, a foreign one and an altered one are skipped
// and left alone; they never block the valid ones.
export function ingestEnvelopes(db, root, list, now = Date.now()) {
  let count = 0;
  for (const { file, value } of list) {
    if (!validEnvelope(value)) continue;
    ingestBatch(db, value, now);
    removeEnvelope(root, file);
    count += 1;
  }
  return count;
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
