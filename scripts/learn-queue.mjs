// Shared state for automatic learning: config, durable job queue, claims, cursors, rate ledger and worker lock.
// Everything lives under runtime/learn (disposable) except the opt-in config in .aiverse/learn/config.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_REL = '.aiverse/learn/config.json';
export const STALE_MS = 10 * 60 * 1000;
export const DEFAULT_CONFIG = Object.freeze({
  mode: 'off',
  model: 'haiku',
  idle_seconds: 60,
  max_pending_turns: 6,
  min_gap_seconds: 180,
  max_reviews_per_session_per_day: 10,
  max_reviews_per_day: 40,
  window_chars: 24000,
  max_budget_usd: 0.15,
  review_timeout_seconds: 120,
  claude_command: ['claude'],
  python: null,
});

// Absent, unreadable or malformed config means off (fail closed). Only known keys of the right type are used.
export function loadConfig(root) {
  const config = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
    for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      if (Array.isArray(fallback) ? Array.isArray(value) && value.every((item) => typeof item === 'string') && value.length
        : typeof value === typeof (fallback ?? '')) config[key] = value;
    }
  } catch {
    return { ...DEFAULT_CONFIG, mode: 'off' };
  }
  return config;
}

export const isEnabled = (config) => config.mode === 'auto';

export function learnPaths(root) {
  const base = path.join(root, 'runtime', 'learn');
  return {
    base,
    queue: path.join(base, 'queue'),
    claims: path.join(base, 'claims'),
    cursors: path.join(base, 'cursors'),
    receipts: path.join(base, 'receipts'),
    spool: path.join(base, 'spool'),
    dead: path.join(base, 'dead'),
    ledger: path.join(base, 'ledger.json'),
    lock: path.join(base, 'worker.lock'),
  };
}

export const sessionKey = (sessionId) => crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`);
  fs.renameSync(temp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Under workspaces/<id>/ means that workspace, elsewhere in the Core means operator. Outside the Core, or inside a
// workspaces/ folder that has no manifest, there is no safe scope (null): such text is never promoted to operator.
export function resolveScope(root, cwd) {
  let realRoot;
  let realCwd;
  try {
    realRoot = fs.realpathSync(root);
    realCwd = fs.realpathSync(cwd);
  } catch {
    return null;
  }
  const relative = path.relative(realRoot, realCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const [top, id] = relative.split(path.sep);
  if (top === 'workspaces' && id && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)
    && fs.existsSync(path.join(realRoot, 'workspaces', id, 'WORKSPACE.yaml'))) return `workspace:${id}`;
  return top === 'workspaces' && id ? null : 'operator';
}

export function readJob(root, key) {
  return readJson(path.join(learnPaths(root).queue, `${key}.json`));
}

export function listJobs(root) {
  const { queue } = learnPaths(root);
  let names = [];
  try {
    names = fs.readdirSync(queue).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((name) => readJson(path.join(queue, name))).filter((job) => job && job.key);
}

export const dueAt = (job) => Math.max(job.due_at ?? 0, job.not_before ?? 0);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Short critical section around a read-modify-write. mkdir is atomic on every platform; a holder that died is
// taken over after `staleMs`. Throws when the mutex cannot be had, so a caller never writes unprotected.
export function withMutex(dir, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(dir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > staleMs) fs.rmdirSync(dir);
      } catch {}
      if (Date.now() > deadline) throw new Error('learning queue is busy');
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
}

const jobMutex = (root, key) => path.join(learnPaths(root).base, 'mutex', key);
const mergeSpools = (...lists) => [...new Map(lists.flat().filter(Boolean).map((spool) => [spool.path, spool])).values()];

// One job file per session. A stop counts a turn and moves the idle deadline; end and compaction are due immediately.
// Compaction snapshots (spools) accumulate: a later event never replaces an earlier unprocessed one.
export function enqueue(root, config, event) {
  const { queue } = learnPaths(root);
  const key = sessionKey(event.session_id);
  const now = event.now ?? Date.now();
  return withMutex(jobMutex(root, key), () => {
    const previous = readJob(root, key);
    const turns = (previous?.turns ?? 0) + (event.reason === 'idle' ? 1 : 0);
    // A pending compaction or session-end review stays due now even when another stop arrives.
    const urgent = previous && !['idle', 'n_turns'].includes(previous.reason) && event.reason === 'idle';
    const reason = urgent ? previous.reason : event.reason === 'idle' && turns >= config.max_pending_turns ? 'n_turns' : event.reason;
    const job = {
      version: 2,
      key,
      session_id: event.session_id,
      transcript_path: event.transcript_path,
      cwd: event.cwd,
      scope: event.scope,
      reason,
      turns,
      attempts: previous?.attempts ?? 0,
      not_before: previous?.not_before ?? 0,
      due_at: reason === 'idle' ? now + config.idle_seconds * 1000 : urgent ? previous.due_at : now,
      spools: mergeSpools(previous?.spools ?? [], [event.spool]),
      created_at: previous?.created_at ?? now,
      updated_at: now,
    };
    writeJsonAtomic(path.join(queue, `${key}.json`), job);
    return job;
  });
}

// Claiming is an atomic rename, so exactly one worker owns a job while new hooks keep writing a fresh queue file.
export function claimJob(root, key) {
  const paths = learnPaths(root);
  fs.mkdirSync(paths.claims, { recursive: true });
  const claim = path.join(paths.claims, `${key}.json`);
  return withMutex(jobMutex(root, key), () => {
    try {
      fs.renameSync(path.join(paths.queue, `${key}.json`), claim);
    } catch {
      return null;
    }
    fs.utimesSync(claim, new Date(), new Date());
    return readJson(claim);
  });
}

// Hand a claim back (requeue) or finish it (null). Work that arrived during the review stays; spools are merged, never dropped.
export function finishClaim(root, key, requeue) {
  const paths = learnPaths(root);
  const claim = path.join(paths.claims, `${key}.json`);
  const queued = path.join(paths.queue, `${key}.json`);
  withMutex(jobMutex(root, key), () => {
    if (requeue) {
      const newer = readJson(queued);
      writeJsonAtomic(queued, newer
        ? { ...newer, attempts: requeue.attempts, not_before: Math.max(newer.not_before ?? 0, requeue.not_before ?? 0), spools: mergeSpools(requeue.spools ?? [], newer.spools ?? []) }
        : requeue);
    }
    fs.rmSync(claim, { force: true });
  });
}

// A claim whose worker is gone is orphaned. With no live worker any claim qualifies at once (`force`); otherwise only a stale one.
export function recoverClaims(root, now = Date.now(), { force = false } = {}) {
  const paths = learnPaths(root);
  let names = [];
  try {
    names = fs.readdirSync(paths.claims).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const name of names) {
    const file = path.join(paths.claims, name);
    const key = name.slice(0, -5);
    withMutex(jobMutex(root, key), () => {
      let age;
      try {
        age = now - fs.statSync(file).mtimeMs;
      } catch {
        return;
      }
      if (!force && age < STALE_MS) return;
      const job = readJson(file);
      const queued = path.join(paths.queue, name);
      if (job) {
        const newer = readJson(queued);
        writeJsonAtomic(queued, newer ? { ...newer, spools: mergeSpools(job.spools ?? [], newer.spools ?? []), attempts: Math.max(newer.attempts ?? 0, job.attempts ?? 0) } : { ...job, due_at: now });
      }
      fs.rmSync(file, { force: true });
      recovered += 1;
    });
  }
  return recovered;
}

export function readCursor(root, key) {
  return readJson(path.join(learnPaths(root).cursors, `${key}.json`))?.line ?? 0;
}

export function writeCursor(root, key, line) {
  writeJsonAtomic(path.join(learnPaths(root).cursors, `${key}.json`), { line, updated_at: Date.now() });
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

// Counters only: review counts per day and the last review time per session. Never knowledge.
export function readLedger(root, now = Date.now()) {
  const stored = readJson(learnPaths(root).ledger);
  const day = dayOf(now);
  return stored?.day === day ? stored : { day, total: 0, cost_usd: 0, sessions: {}, last: stored?.last ?? {} };
}

export function reviewAllowance(ledger, key, config, now = Date.now(), { ignoreGap = false } = {}) {
  if ((ledger.sessions[key] ?? 0) >= config.max_reviews_per_session_per_day || ledger.total >= config.max_reviews_per_day) {
    return { ok: false, not_before: Date.parse(`${dayOf(now)}T00:00:00Z`) + 24 * 3600 * 1000 };
  }
  const gapEnds = (ledger.last[key] ?? 0) + config.min_gap_seconds * 1000;
  return !ignoreGap && gapEnds > now ? { ok: false, not_before: gapEnds } : { ok: true };
}

export function recordReview(root, key, costUsd, now = Date.now()) {
  const ledger = readLedger(root, now);
  ledger.total += 1;
  ledger.cost_usd = Number((ledger.cost_usd + (costUsd || 0)).toFixed(6));
  ledger.sessions[key] = (ledger.sessions[key] ?? 0) + 1;
  ledger.last[key] = now;
  writeJsonAtomic(learnPaths(root).ledger, ledger);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function workerRunning(root, now = Date.now()) {
  const { lock } = learnPaths(root);
  try {
    const info = readJson(lock);
    return Boolean(info) && alive(info.pid) && now - fs.statSync(lock).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

let heldToken = null;

// The lock appears atomically and already complete (write a private file, then hard-link it into place), so a
// competing starter never sees a half-written lock. Replacing a dead owner is serialized by a mutex.
export function acquireLock(root, now = Date.now()) {
  const { lock, base } = learnPaths(root);
  fs.mkdirSync(base, { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const mine = `${lock}.${process.pid}.${token}`;
  fs.writeFileSync(mine, JSON.stringify({ pid: process.pid, token, at: now }));
  const tryLink = () => {
    try {
      fs.linkSync(mine, lock);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  };
  try {
    if (tryLink()) {
      heldToken = token;
      return true;
    }
    if (workerRunning(root, now)) return false;
    const won = withMutex(path.join(base, 'mutex', 'worker-lock'), () => {
      if (workerRunning(root, now)) return false;
      fs.rmSync(lock, { force: true });
      return tryLink();
    });
    if (won) heldToken = token;
    return won;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

export const touchLock = (root) => {
  try {
    fs.utimesSync(learnPaths(root).lock, new Date(), new Date());
  } catch {}
};

// Only the owner removes the lock, so a worker that lost it (stale takeover) cannot delete its successor's.
export function releaseLock(root) {
  const { lock } = learnPaths(root);
  if (readJson(lock)?.token === heldToken) fs.rmSync(lock, { force: true });
  heldToken = null;
}
