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
});

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
      if (ok) config[key] = value;
    }
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return config;
}

export const isEnabled = (config) => config.mode === 'propose' || config.mode === 'auto';

export function learnPaths(root) {
  const base = path.join(root, 'runtime', 'learn');
  return { base, db: path.join(base, 'learn.db'), spool: path.join(base, 'spool'), snapshots: path.join(base, 'snapshots') };
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
