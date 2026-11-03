// Shared fixtures for the automatic-learning tests: a temporary Core, a fake `claude`, transcripts and database peeking.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(SCRIPTS, '..');
export const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
export const NODE = ['--disable-warning=ExperimentalWarning'];

// The fake reviewer: logs what it was given, then answers from FAKE_REVIEW (or FAKE_REVIEW.<scope>).
const FAKE_CLAUDE = `
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), guard: process.env.AIVERSE_LEARN_REVIEW, prompt: input }) + '\\n');
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'quota') { process.stderr.write('Claude usage limit reached'); process.exit(1); }
if (mode === 'fail') { process.stderr.write('boom SECRET-IN-STDERR'); process.exit(1); }
if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
if (mode === 'switchoff') fs.writeFileSync(process.env.FAKE_CONFIG, JSON.stringify({ mode: 'off' }));
if (mode === 'steal') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.FAKE_DB);
  db.exec("UPDATE claims SET owner = 'thief' WHERE name LIKE 'session:%'");
  db.close();
}
const scope = (input.match(/Conversation scope: (\\S+)/) || [])[1] || '';
const scoped = process.env.FAKE_REVIEW + '.' + scope.replace(':', '_');
const file = fs.existsSync(scoped) ? scoped : process.env.FAKE_REVIEW;
process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.0021, structured_output: JSON.parse(fs.readFileSync(file, 'utf8')) }));
`;

export function core(configOverrides = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiverse-learn-'));
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true, filter: (src) => !src.includes('__pycache__') });
  fs.cpSync(path.join(REPO, 'system', 'capabilities', 'learn'), path.join(root, 'system', 'capabilities', 'learn'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'AI-VERSE.yaml'), path.join(root, 'AI-VERSE.yaml'));
  fs.mkdirSync(path.join(root, 'operator', 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'));
  fs.mkdirSync(path.join(root, 'runtime'));
  const fake = path.join(root, 'fake-claude.mjs');
  fs.writeFileSync(fake, FAKE_CLAUDE);
  fs.mkdirSync(path.join(root, '.aiverse', 'learn'), { recursive: true });
  const config = { mode: 'auto', python: PYTHON, claude_command: [fake], idle_seconds: 1, allow_unfenced_auto: true, ...configOverrides };
  fs.writeFileSync(path.join(root, '.aiverse', 'learn', 'config.json'), JSON.stringify(config));
  const env = {
    FAKE_LOG: path.join(root, 'fake.log'), FAKE_REVIEW: path.join(root, 'review.json'), FAKE_CONFIG: path.join(root, '.aiverse', 'learn', 'config.json'),
    FAKE_DB: path.join(root, 'runtime', 'learn', 'learn.db'), FAKE_MODE: 'ok',
  };
  Object.assign(process.env, env); // in-process runs and children inherit the same fixture
  return root;
}

export const setMode = (root, mode, extra = {}) => {
  const file = path.join(root, '.aiverse', 'learn', 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), mode, ...extra }));
};

export const workspace = (root, id) => {
  fs.mkdirSync(path.join(root, 'workspaces', id), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', id, 'WORKSPACE.yaml'), `schema_version: "2.0"\nid: ${id}\nstatus: active\napproval:\n  external_actions: "allow"\n  destructive_actions: "confirm"\n  high_stakes_decisions: "human-review"\n`);
};

export const userLine = (id, text, cwd) => JSON.stringify({ type: 'user', uuid: id, ...(cwd === null ? {} : { cwd }), message: { role: 'user', content: text } });
export const assistantLine = (id, text, cwd) => JSON.stringify({ type: 'assistant', uuid: id, ...(cwd === null ? {} : { cwd }), message: { role: 'assistant', content: [{ type: 'text', text }] } });
export const writeTranscript = (file, lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
export const appendTranscript = (file, lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`);

export const review = (candidates, suffix = '') => fs.writeFileSync(process.env.FAKE_REVIEW + suffix, JSON.stringify({ candidates }));
export const candidate = (kind, statement, quote, message = 'u1', extra = {}) => ({
  kind, statement, scope_hint: 'global', exception: false, tentative: false, confidence: 0.92, replaces: null,
  evidence: { message_id: message, quote }, ...(kind === 'preference' ? { category: 'avoid' } : {}), ...extra,
});

export const calls = () => (fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const preferences = (root) => (fs.existsSync(path.join(root, 'operator/profile/preferences.md')) ? fs.readFileSync(path.join(root, 'operator/profile/preferences.md'), 'utf8') : '');
export const inboxFiles = (root, dir = 'operator/inbox') => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((n) => !n.startsWith('README')) : []);
export const inboxText = (root, dir = 'operator/inbox') => inboxFiles(root, dir).map((n) => fs.readFileSync(path.join(root, dir, n), 'utf8')).join('\n---\n');

// Read-only look into the worker's database.
export function peek(root, sql, ...args) {
  const db = new DatabaseSync(path.join(root, 'runtime', 'learn', 'learn.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}
export function mutate(root, sql, ...args) {
  const db = new DatabaseSync(path.join(root, 'runtime', 'learn', 'learn.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    return db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
}
// Time passes: every lease is over and every wait is up (what minutes of real time would do).
export const timePasses = (root) => { mutate(root, 'UPDATE claims SET lease_until = 0'); mutate(root, 'UPDATE sessions SET not_before = 0'); };
export const receipts = (root) => peek(root, 'SELECT body FROM receipts ORDER BY id').map((r) => JSON.parse(r.body));
export const dumpDb = (root) => JSON.stringify(['sessions', 'sources', 'claims', 'reviews', 'receipts', 'ledger', 'failures', 'seen'].map((t) => peek(root, `SELECT * FROM ${t}`)));

// The real hook code in its own process, without starting a worker (so tests control when the worker runs).
const HOOK_ONLY = "import('./scripts/learn-hook.mjs').then(async (m) => { let input = ''; for await (const c of process.stdin) input += c; m.handleEvent(process.cwd(), process.argv[1], JSON.parse(input), Date.now(), () => {}); });";
export const hookEvent = (root, event, payload) => spawnSync(process.execPath, ['-e', HOOK_ONLY, event], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env: process.env });
export const hookEventAsync = (root, event, payload) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', HOOK_ONLY, event], { cwd: root, env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify(payload));
  child.on('exit', (code) => resolve(code));
});

// Runs the real worker as its own process (waits). `env` can inject a crash point.
export const workerProcess = (root, env = {}, args = ['--drain']) =>
  spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-launch.mjs'), '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
export const workerAsync = (root, env = {}, args = ['--drain']) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'learn-launch.mjs'), '--root', root, ...args], { env: { ...process.env, ...env }, stdio: 'ignore' });
  child.on('exit', (code, signal) => resolve({ code, signal }));
});

export const session = (root, id = 'session-1', file = path.join(root, `${id}.jsonl`)) => ({ session_id: id, transcript_path: file, cwd: root });
export function allText(dir) {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    out += entry.isDirectory() ? allText(p) : fs.readFileSync(p, 'latin1');
  }
  return out;
}
