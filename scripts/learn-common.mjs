// Shared by the hook (which must stay tiny and never touch the database) and the worker.
// Mode is read from .aiverse/learn/config.json: off | propose | auto. Absent, unreadable or unknown means off.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_REL = '.aiverse/learn/config.json';
export const MODES = ['off', 'propose', 'auto'];
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
  allow_unfenced_auto: false,
});

// Numeric settings are clamped so a typo cannot stop progress (window_chars 0) or remove a cost cap.
const BOUNDS = {
  idle_seconds: [0, 3600], max_pending_turns: [1, 100], min_gap_seconds: [0, 86400], max_reviews_per_session_per_day: [1, 100],
  max_reviews_per_day: [1, 500], window_chars: [1000, 200000], max_budget_usd: [0.01, 2], review_timeout_seconds: [10, 600],
};

export function loadConfig(root) {
  const config = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
    if (!MODES.includes(raw.mode)) return { ...DEFAULT_CONFIG };
    for (const [key, fallback] of Object.entries(DEFAULT_CONFIG)) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      const ok = Array.isArray(fallback)
        ? Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
        : typeof value === typeof (fallback ?? '');
      if (!ok) continue;
      const range = BOUNDS[key];
      config[key] = range && typeof value === 'number' ? (Number.isFinite(value) ? Math.min(range[1], Math.max(range[0], value)) : fallback) : value;
    }
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return config;
}

export const isEnabled = (config) => config.mode === 'propose' || config.mode === 'auto';

export function learnPaths(root) {
  const base = path.join(root, 'runtime', 'learn');
  return { base, db: path.join(base, 'learn.db'), spool: path.join(base, 'spool') };
}

export const sessionKey = (sessionId) => crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
export const sha = (value, length = 24) => crypto.createHash('sha256').update(value).digest('hex').slice(0, length);

// Scope of one message, from the cwd it was written in. Under workspaces/<id>/ with a manifest is that workspace; elsewhere
// in the Core is operator. A workspaces/ folder without a manifest, or a message with no cwd, is 'unscoped' (never promoted
// to operator or to any workspace). A cwd outside the Core is null: not reviewed at all.
export function resolveScope(root, cwd) {
  if (!cwd) return 'unscoped';
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
  if (top !== 'workspaces') return 'operator';
  if (id && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) && fs.existsSync(path.join(realRoot, 'workspaces', id, 'WORKSPACE.yaml'))) return `workspace:${id}`;
  return 'unscoped';
}

// One file per event, written to a private name and renamed into place. No lock, no shared file: concurrent hooks cannot
// collide or lose each other, and a crash leaves either a whole event or nothing.
export function spoolEvent(root, event) {
  const { spool } = learnPaths(root);
  fs.mkdirSync(spool, { recursive: true });
  const name = `${String(Date.now()).padStart(15, '0')}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const temp = path.join(spool, `${name}.tmp`);
  fs.writeFileSync(temp, JSON.stringify(event));
  fs.renameSync(temp, path.join(spool, `${name}.json`));
  return name;
}

// True when this module is the program being run (not imported, not `node -e`).
export function isMain(metaUrl) {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

const DAY = 24 * 3600 * 1000;
export const HANDOFF_MAX_FILES = 50;
export const HANDOFF_MAX_BYTES = 64 * 1024 * 1024;

// Cheap, database-free housekeeping that the hook runs even when learning is off: abandoned temp files, old or excess handoffs
// (oldest first, capped by count and total size), old event files and quarantined events. Never creates anything.
// Only files this pipeline itself creates are ever touched, recognised by their exact generated names; anything else in these
// folders (a note, a copy, a file from another tool) is never deleted.
export const EVENT_NAME = /^\d{15}-\d+-[0-9a-f]{8}\.(?:json|tmp)$/;
export const HANDOFF_NAME = /^[0-9a-f]{16}-\d+-[0-9a-f]{8}\.jsonl(?:\.tmp)?$/;

export function pruneRuntime(root, now = Date.now()) {
  const { base, spool } = learnPaths(root);
  const list = (dir, pattern) => { try { return fs.readdirSync(dir).filter((n) => pattern.test(n)).map((n) => { const f = path.join(dir, n); const st = fs.statSync(f); return st.isFile() ? { f, n, age: now - st.mtimeMs, size: st.size } : null; }).filter(Boolean); } catch { return []; } };
  const drop = (entries, test, maxAge) => entries.filter((e) => test(e.n) && e.age > maxAge).forEach((e) => fs.rmSync(e.f, { force: true }));
  drop(list(spool, EVENT_NAME), (n) => n.endsWith('.tmp'), DAY);
  drop(list(spool, EVENT_NAME), (n) => n.endsWith('.json'), 30 * DAY);
  drop(list(path.join(spool, 'bad'), EVENT_NAME), () => true, 14 * DAY);
  const dir = path.join(base, 'handoff');
  drop(list(dir, HANDOFF_NAME), (n) => n.endsWith('.tmp'), 60 * 60 * 1000);
  drop(list(dir, HANDOFF_NAME), () => true, 30 * DAY);
  const kept = list(dir, HANDOFF_NAME).filter((e) => e.n.endsWith('.jsonl')).sort((a, b) => a.age - b.age); // newest first
  let bytes = 0;
  kept.forEach((e, i) => {
    bytes += e.size;
    if (i >= HANDOFF_MAX_FILES || bytes > HANDOFF_MAX_BYTES) fs.rmSync(e.f, { force: true });
  });
}
