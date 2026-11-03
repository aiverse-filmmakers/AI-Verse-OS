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

// Under workspaces/<id>/ means that workspace, anywhere else in the Core means operator, outside the Core means null.
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
  return 'operator';
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

// One job file per session. A stop counts a turn and moves the idle deadline; end and compaction are due immediately.
export function enqueue(root, config, event) {
  const { queue } = learnPaths(root);
  const key = sessionKey(event.session_id);
  const now = event.now ?? Date.now();
  const previous = readJob(root, key);
  const turns = (previous?.turns ?? 0) + (event.reason === 'idle' ? 1 : 0);
  // A pending compaction or session-end review stays due now even when another stop arrives.
  const urgent = previous && !['idle', 'n_turns'].includes(previous.reason) && event.reason === 'idle';
  const reason = urgent ? previous.reason : event.reason === 'idle' && turns >= config.max_pending_turns ? 'n_turns' : event.reason;
  const job = {
    version: 1,
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
    spool: event.spool ?? previous?.spool ?? null,
    created_at: previous?.created_at ?? now,
    updated_at: now,
  };
  writeJsonAtomic(path.join(queue, `${key}.json`), job);
  return job;
}

// Claiming is an atomic rename, so exactly one worker owns a job while new hooks keep writing a fresh queue file.
export function claimJob(root, key) {
  const paths = learnPaths(root);
  fs.mkdirSync(paths.claims, { recursive: true });
  const claim = path.join(paths.claims, `${key}.json`);
  try {
    fs.renameSync(path.join(paths.queue, `${key}.json`), claim);
  } catch {
    return null;
  }
  fs.utimesSync(claim, new Date(), new Date());
  return readJson(claim);
}

export function finishClaim(root, key, requeue) {
  const paths = learnPaths(root);
  const claim = path.join(paths.claims, `${key}.json`);
  const queued = path.join(paths.queue, `${key}.json`);
  if (requeue) {
    const newer = readJson(queued);
    // A newer queue file already covers the unreviewed range, so only carry the retry state into it.
    writeJsonAtomic(queued, newer ? { ...newer, attempts: requeue.attempts, not_before: Math.max(newer.not_before ?? 0, requeue.not_before ?? 0) } : requeue);
  }
  fs.rmSync(claim, { force: true });
}

// A worker that died mid-review leaves a claim behind; hand it back to the queue after it goes stale.
export function recoverClaims(root, now = Date.now()) {
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
    if (now - fs.statSync(file).mtimeMs < STALE_MS) continue;
    const job = readJson(file);
    if (job && !fs.existsSync(path.join(paths.queue, name))) writeJsonAtomic(path.join(paths.queue, name), { ...job, due_at: now });
    fs.rmSync(file, { force: true });
    recovered += 1;
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

// Exclusive create; a lock whose owner is gone or silent for ten minutes is replaced once.
export function acquireLock(root, now = Date.now()) {
  const { lock } = learnPaths(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST' || workerRunning(root, now)) return false;
      fs.rmSync(lock, { force: true });
    }
  }
  return false;
}

export const touchLock = (root) => {
  try {
    fs.utimesSync(learnPaths(root).lock, new Date(), new Date());
  } catch {}
};

export const releaseLock = (root) => fs.rmSync(learnPaths(root).lock, { force: true });
