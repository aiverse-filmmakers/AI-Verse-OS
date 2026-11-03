// Shared by the hook and the worker: configuration, paths, scope binding and the visible health state.
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
  max_pending_mb: 256,
  accept_storage_risk: false,
  claude_command: ['claude'],
  python: null,
});

// Numeric settings are clamped so a typo cannot stop progress (window_chars 0) or remove a cost cap.
const BOUNDS = {
  idle_seconds: [0, 3600], max_pending_turns: [1, 100], min_gap_seconds: [0, 86400], max_reviews_per_session_per_day: [1, 100],
  max_reviews_per_day: [1, 500], window_chars: [1000, 200000], max_budget_usd: [0.01, 2], review_timeout_seconds: [10, 600],
  max_pending_mb: [1, 4096],
};

export function loadConfig(root) {
  const config = { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'));
    if (!raw || typeof raw !== 'object' || !MODES.includes(raw.mode)) return { ...DEFAULT_CONFIG };
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
  return { base, db: path.join(base, 'learn.db'), status: path.join(base, 'status') };
}

export const sha = (value, length = 24) => crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
export const sessionKey = (sessionId) => sha(String(sessionId), 16);

// True when this module is the program being run (not imported, not `node -e`).
export function isMain(metaUrl) {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

// The visible health state: one small file per condition in runtime/learn/status/ (<code>.json). Conditions are independent and each
// is written or removed on its own, so two processes updating different conditions can never lose each other's (there is no shared
// file to read, change and rewrite). Best effort, and never through a link: when the disk or the path is the problem the caller
// reports through its exit code as well.
const CODE = /^[a-z][a-z0-9_]{1,40}$/;

function statusDirectory(root, create) {
  const { base, status } = learnPaths(root);
  try {
    for (const dir of [path.dirname(base), base]) if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) return null;
    if (fs.existsSync(status)) return fs.lstatSync(status).isDirectory() ? status : null;
    if (!create) return null;
    fs.mkdirSync(status, { recursive: true, mode: 0o700 });
    return fs.lstatSync(status).isDirectory() && !fs.lstatSync(status).isSymbolicLink() ? status : null;
  } catch {
    return null;
  }
}

export function readStatus(root) {
  const dir = statusDirectory(root, false);
  try {
    return dir ? fs.readdirSync(dir).filter((n) => n.endsWith('.json') && CODE.test(n.slice(0, -5))).map((n) => n.slice(0, -5)).sort() : [];
  } catch {
    return [];
  }
}

export function setStatus(root, code, on = true) {
  if (!CODE.test(code)) return;
  try {
    const dir = statusDirectory(root, on);
    if (!dir) return;
    const file = path.join(dir, `${code}.json`);
    if (!on) { fs.rmSync(file, { force: true }); return; }
    if (fs.existsSync(file)) return;
    const temp = path.join(dir, `.${code}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
    fs.writeFileSync(temp, JSON.stringify({ code, at: new Date().toISOString() }));
    fs.renameSync(temp, file);
  } catch {}
}

// A generation of the configuration: any change to the file, however small, is a new generation. An effect is admitted only under
// the generation it was prepared under, so a switch to off (or any edit) between preparing and doing it stops it.
export function modeGeneration(root) {
  try {
    return sha(fs.readFileSync(path.join(root, CONFIG_REL), 'utf8'), 24);
  } catch {
    return 'absent';
  }
}

// Scope binding of one record, from the cwd it was written in. cwd is an ACCESS boundary, not a statement about meaning:
//   under workspaces/<id>/ with a manifest -> that workspace;  elsewhere in the Core -> operator;
//   no cwd, an unmanifested workspaces/ folder or a path that cannot be resolved -> 'unresolved' (never copied anywhere global);
//   a cwd outside the Core -> null (not captured at all).
export function resolveScope(root, cwd) {
  if (!cwd) return 'unresolved';
  let realRoot;
  let realCwd;
  try {
    realRoot = fs.realpathSync(root);
    realCwd = fs.realpathSync(cwd);
  } catch {
    return 'unresolved';
  }
  const relative = path.relative(realRoot, realCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const [top, id] = relative.split(path.sep);
  if (top !== 'workspaces') return 'operator';
  return validWorkspace(realRoot, id) ? `workspace:${id}` : 'unresolved';
}

// A workspace exists for the pipeline only when its folder is a real directory inside the Core and its manifest names that same id.
export function validWorkspace(root, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) return false;
  try {
    const realRoot = fs.realpathSync(root);
    const dir = path.join(realRoot, 'workspaces', id);
    if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir) return false;
    const manifest = path.join(dir, 'WORKSPACE.yaml');
    if (fs.lstatSync(manifest).isSymbolicLink() || !fs.statSync(manifest).isFile()) return false;
    return new RegExp(`^id:\\s*["']?${id.replace(/[.]/g, '\\.')}["']?\\s*$`, 'm').test(fs.readFileSync(manifest, 'utf8'));
  } catch {
    return false;
  }
}

// Storage the pipeline cannot rely on: a database in a folder a cloud-sync client or a network share manages (SQLite documents that
// WAL does not work over network filesystems and that live database files must not be synced), or a SQLite older than the fix for
// the WAL-reset bug (3.51.3, unless the vendor backported it). Only names are inspected; the filesystem type is not.
const SYNCED = /(?:^|[\\/])(?:Dropbox|OneDrive[^\\/]*|Google ?Drive|iCloud ?Drive|Mobile Documents|CloudStorage|Box|pCloud|MEGA|Nextcloud|ownCloud|Sync)(?:[\\/]|$)|^\\\\|^\/(?:Volumes|mnt|net|run\/media)\//i;
export const looksSynced = (target) => SYNCED.test(target);
export function sqliteTooOld(version) {
  const [a, b, c] = String(version).split('.').map(Number);
  if (!(a >= 3)) return true;
  // fixed in 3.51.3 and backported to the 3.50 line (3.50.7) and the 3.44 line (3.44.6)
  if (a > 3 || b > 51 || (b === 51 && c >= 3)) return false;
  return !((b === 50 && c >= 7) || (b === 44 && c >= 6));
}
