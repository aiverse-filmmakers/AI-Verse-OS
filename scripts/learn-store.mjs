// The one durable primitive of automatic learning: a small SQLite database (WAL) at runtime/learn/learn.db, used by the
// worker only. Hooks never open it; they drop one file per event into runtime/learn/spool and the worker ingests those.
//
//   sessions  one row per chat: debounce, backoff, wake time
//   sources   one row per transcript generation (fingerprint): cursor (line, part), anchor, snapshot
//   claims    named leases with an owner token: 'worker' and 'session:<key>'. A lease past its expiry can be taken over
//             by exactly one contender (a single conditional statement), and its former holder fails every ownership check
//   reviews   the screened plan for one reviewed range, written before any owner is called and updated per item
//   receipts, ledger, failures, seen   bookkeeping, holding only codes, counts and cited quotes already screened for secrets
//
// node:sqlite is built into Node 22.13+. On an older Node the store is unavailable and events simply wait in the spool.

import fs from 'node:fs';
import path from 'node:path';
import { learnPaths } from './learn-common.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, session_id TEXT, transcript TEXT, reason TEXT, turns INTEGER DEFAULT 0,
  due_at INTEGER, not_before INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, blocked TEXT);
CREATE TABLE IF NOT EXISTS sources(session TEXT, fp TEXT, line INTEGER DEFAULT 0, part INTEGER DEFAULT 0, anchor_line INTEGER DEFAULT -1,
  anchor TEXT DEFAULT '', backup TEXT, backup_lines INTEGER DEFAULT 0, closed INTEGER DEFAULT 0, PRIMARY KEY(session, fp));
CREATE TABLE IF NOT EXISTS claims(name TEXT PRIMARY KEY, owner TEXT, lease_until INTEGER);
CREATE TABLE IF NOT EXISTS reviews(session TEXT, fp TEXT, line INTEGER, part INTEGER, body TEXT, PRIMARY KEY(session, fp, line, part));
CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY, session TEXT, at INTEGER, body TEXT);
CREATE TABLE IF NOT EXISTS ledger(day TEXT, session TEXT, n INTEGER DEFAULT 0, cost REAL DEFAULT 0, last_at INTEGER DEFAULT 0, PRIMARY KEY(day, session));
CREATE TABLE IF NOT EXISTS failures(id INTEGER PRIMARY KEY, session TEXT, at INTEGER, code TEXT);
CREATE TABLE IF NOT EXISTS seen(name TEXT PRIMARY KEY, at INTEGER);
`;

export async function openStore(root) {
  const { DatabaseSync } = await import('node:sqlite'); // throws on a Node without it: callers treat that as 'store_unavailable'
  const { base, db: file } = learnPaths(root);
  fs.mkdirSync(base, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
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

// -- leases -------------------------------------------------------------------------------------------------

export function acquire(db, name, owner, ttlMs, now = Date.now()) {
  const done = db.prepare(`INSERT INTO claims(name, owner, lease_until) VALUES(?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until
    WHERE claims.lease_until < ? OR claims.owner = excluded.owner`).run(name, owner, now + ttlMs, now);
  return done.changes === 1;
}
export const renew = (db, name, owner, ttlMs, now = Date.now()) =>
  db.prepare('UPDATE claims SET lease_until = ? WHERE name = ? AND owner = ? AND lease_until >= ?').run(now + ttlMs, name, owner, now).changes === 1;
export const holds = (db, name, owner, now = Date.now()) =>
  Boolean(db.prepare('SELECT 1 FROM claims WHERE name = ? AND owner = ? AND lease_until >= ?').get(name, owner, now));
export const release = (db, name, owner) => db.prepare('DELETE FROM claims WHERE name = ? AND owner = ?').run(name, owner);

// -- ingest: spool files become rows, once ---------------------------------------------------------------------

export function ingest(db, root, now = Date.now()) {
  const { spool } = learnPaths(root);
  let names = [];
  try {
    names = fs.readdirSync(spool).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    const file = path.join(spool, name);
    let event = null;
    try {
      event = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (!event || typeof event.session_id !== 'string') {
      fs.mkdirSync(path.join(spool, 'bad'), { recursive: true });
      fs.renameSync(file, path.join(spool, 'bad', name));
      continue;
    }
    tx(db, () => {
      if (db.prepare('INSERT OR IGNORE INTO seen(name, at) VALUES(?, ?)').run(name, now).changes === 0) return;
      applyEvent(db, event, now);
    });
    fs.rmSync(file, { force: true }); // a crash before this line only means the file is seen again and ignored
    count += 1;
  }
  db.prepare('DELETE FROM seen WHERE at < ?').run(now - 7 * 24 * 3600 * 1000);
  return count;
}

function applyEvent(db, event, now) {
  const key = event.key;
  const previous = db.prepare('SELECT * FROM sessions WHERE key = ?').get(key);
  const cfg = event.config;
  const turns = (previous?.turns ?? 0) + (event.reason === 'idle' ? 1 : 0);
  const pendingReason = previous?.due_at != null ? previous.reason : null;
  const urgent = pendingReason && !['idle', 'n_turns'].includes(pendingReason) && event.reason === 'idle';
  const reason = urgent ? pendingReason : event.reason === 'idle' && turns >= cfg.max_pending_turns ? 'n_turns' : event.reason;
  const due = reason === 'idle' ? (event.at ?? now) + cfg.idle_seconds * 1000 : urgent ? previous.due_at : (event.at ?? now);
  db.prepare(`INSERT INTO sessions(key, session_id, transcript, reason, turns, due_at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET transcript = excluded.transcript, reason = excluded.reason, turns = excluded.turns, due_at = excluded.due_at`)
    .run(key, event.session_id, event.transcript_path, reason, turns, due);
  if (event.snapshot) registerSnapshot(db, key, event.snapshot);
  if (event.snapshot_code) db.prepare('INSERT INTO failures(session, at, code) VALUES(?, ?, ?)').run(key, now, event.snapshot_code);
}

// A snapshot belongs to the transcript generation whose first line it carries. A newer snapshot of the same generation
// replaces the older one (it contains it), so a source holds exactly one.
function registerSnapshot(db, key, snap) {
  const old = db.prepare('SELECT backup FROM sources WHERE session = ? AND fp = ?').get(key, snap.fp)?.backup;
  if (old && old !== snap.path) fs.rmSync(old, { force: true });
  db.prepare(`INSERT INTO sources(session, fp, backup, backup_lines) VALUES(?, ?, ?, ?)
    ON CONFLICT(session, fp) DO UPDATE SET backup = excluded.backup, backup_lines = excluded.backup_lines, closed = 0`)
    .run(key, snap.fp, snap.path, snap.lines);
}

// -- rate ledger ---------------------------------------------------------------------------------------------

export const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

export function allowance(db, key, config, now, ignoreGap) {
  const day = dayOf(now);
  const mine = db.prepare('SELECT n, last_at FROM ledger WHERE day = ? AND session = ?').get(day, key);
  const total = db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM ledger WHERE day = ?').get(day).n;
  if ((mine?.n ?? 0) >= config.max_reviews_per_session_per_day || total >= config.max_reviews_per_day) {
    return { ok: false, not_before: Date.parse(`${day}T00:00:00Z`) + 24 * 3600 * 1000 };
  }
  const last = db.prepare('SELECT MAX(last_at) AS t FROM ledger WHERE session = ?').get(key).t ?? 0;
  const gapEnds = last + config.min_gap_seconds * 1000;
  return !ignoreGap && gapEnds > now ? { ok: false, not_before: gapEnds } : { ok: true };
}

export function recordReview(db, key, cost, now) {
  db.prepare(`INSERT INTO ledger(day, session, n, cost, last_at) VALUES(?, ?, 1, ?, ?)
    ON CONFLICT(day, session) DO UPDATE SET n = n + 1, cost = cost + excluded.cost, last_at = excluded.last_at`).run(dayOf(now), key, cost || 0, now);
}
