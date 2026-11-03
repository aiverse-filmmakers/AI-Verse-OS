// Shared by the hook and the worker: configuration, paths, scope, and the one durable fallback file (the envelope).
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
  return { base, db: path.join(base, 'learn.db'), spool: path.join(base, 'spool'), status: path.join(base, 'status.json') };
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

// A visible health state (a file the member or a status tool can read). Best effort: when the disk is the problem it may not be
// writable, and the caller reports the failure through its exit code instead.
export function setStatus(root, code) {
  try {
    const { base, status } = learnPaths(root);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(status, JSON.stringify({ code, at: new Date().toISOString() }));
  } catch {}
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
  if (id && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(id) && fs.existsSync(path.join(realRoot, 'workspaces', id, 'WORKSPACE.yaml'))) return `workspace:${id}`;
  return 'unresolved';
}

// -- the envelope: a durable capture the hook leaves when the database is busy or unavailable ----------------------------
// One file, created under a name that carries the digest of its own content. It is only trusted, ingested and deleted when the
// name, the digest, the schema and the location all agree; a foreign or altered file is left exactly as it is.

const ENVELOPE_NAME = /^env-(\d{15})-([0-9a-f]{8})-([0-9a-f]{16})\.json(\.tmp)?$/;
const SCOPE = /^(?:operator|unresolved|workspace:[a-z0-9][a-z0-9._-]{0,127})$/;
const REASONS = ['idle', 'before_compaction', 'session_end', 'session_start'];

export function validEnvelope(value) {
  const ok = (v, type) => typeof v === type;
  if (!value || value.v !== 1 || !/^[0-9a-f]{16}$/.test(value.key) || !ok(value.session_id, 'string') || !ok(value.transcript_path, 'string')) return false;
  if (!REASONS.includes(value.reason) || !Number.isFinite(value.at) || !value.config || !Number.isFinite(value.config.idle_seconds) || !Number.isFinite(value.config.max_pending_turns)) return false;
  return Array.isArray(value.records) && value.records.every((r) => r && ok(r.uuid, 'string') && r.uuid && ok(r.text, 'string')
    && (r.ts === null || ok(r.ts, 'string')) && Number.isFinite(r.seq) && SCOPE.test(r.scope));
}

// io is the file API (tests inject failures); crash is a test seam that kills the process at a named point.
export function writeEnvelope(root, batch, { io = fs, crash = () => {} } = {}) {
  const { spool } = learnPaths(root);
  io.mkdirSync(spool, { recursive: true });
  const body = JSON.stringify({ v: 1, ...batch });
  const digest = sha(body, 16);
  const name = `env-${String(Date.now()).padStart(15, '0')}-${crypto.randomBytes(4).toString('hex')}-${digest}.json`;
  const temp = path.join(spool, `${name}.tmp`);
  let fd = null;
  try {
    fd = io.openSync(temp, 'wx');
    io.writeSync(fd, body);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = null;
    crash('envelope_before_rename');
    io.renameSync(temp, path.join(spool, name));
    if (process.platform !== 'win32') {
      const dir = io.openSync(spool, 'r');
      try { io.fsyncSync(dir); } finally { io.closeSync(dir); }
    }
  } catch (error) {
    if (fd !== null) try { io.closeSync(fd); } catch {}
    try { io.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
  return name;
}

// Every envelope in the spool that is whole and ours. A finished temp file (the process died after its fsync, before the rename)
// is recovered the same way once it is old enough that no writer can still be filling it.
export function listEnvelopes(root, now = Date.now()) {
  const { spool } = learnPaths(root);
  let names = [];
  try { names = fs.readdirSync(spool); } catch { return []; }
  const found = [];
  for (const name of names.sort()) {
    const m = ENVELOPE_NAME.exec(name);
    if (!m) continue;
    const file = path.join(spool, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || (m[4] && now - st.mtimeMs < 60000)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (sha(text, 16) !== m[3]) continue;
      const value = JSON.parse(text);
      if (validEnvelope(value)) found.push({ file, name, value });
    } catch {}
  }
  return found;
}

// The one deletion path of the pipeline: the file must still be a plain file in the spool whose content matches its own name.
export function removeEnvelope(root, file) {
  const { spool } = learnPaths(root);
  try {
    const m = ENVELOPE_NAME.exec(path.basename(file));
    const st = fs.lstatSync(file);
    if (!m || !st.isFile() || st.isSymbolicLink() || fs.realpathSync(path.dirname(file)) !== fs.realpathSync(spool)) return false;
    if (sha(fs.readFileSync(file, 'utf8'), 16) !== m[3]) return false;
    fs.rmSync(file);
    return true;
  } catch {
    return false;
  }
}
