// Shared fixtures for the automatic-learning tests: a temporary Core, a fake `claude`, transcripts and database peeking.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sessionKey } from './learn-common.mjs';
import { ingestBatch, openStore } from './learn-store.mjs';

export const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(SCRIPTS, '..');
export const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// -- housekeeping of the tests themselves ------------------------------------------------------------------------------------
// Every folder a test makes is registered and removed when the process ends (success or failure), and a stand-in `claude` heads the
// PATH of this process and of every child: if a test ever reaches for the real reviewer by mistake it finds the stand-in, which only
// records the attempt, and the run fails at the end.
const made = [];
export const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  made.push(dir);
  return dir;
};
const sentinel = tempDir('aiverse-sentinel-');
const mark = path.join(sentinel, 'claude-was-called');
fs.writeFileSync(path.join(sentinel, 'claude'), `#!/bin/sh\necho called >> "${mark}"\nexit 97\n`, { mode: 0o755 });
fs.writeFileSync(path.join(sentinel, 'claude.cmd'), `@echo called>>"${mark}"\r\n@exit /b 97\r\n`);
process.env.PATH = `${sentinel}${path.delimiter}${process.env.PATH}`;
process.on('exit', () => {
  const touched = fs.existsSync(mark);
  for (const dir of made) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  if (touched) { process.stderr.write('A test tried to run the real claude reviewer.\n'); process.exitCode = 1; }
});

// The fake reviewer: logs what it was given (argv, a few environment names, the prompt), then answers from FAKE_REVIEW
// (or FAKE_REVIEW.<scope>); in `facts` mode it reports every "FACT<n>" sentence it is shown, six at a time.
const FAKE_CLAUDE = `
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|AIVERSE_LEARN_REVIEW)/.test(k)));
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), env, prompt: input }) + '\\n');
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'quota') { process.stderr.write('Claude usage limit reached'); process.exit(1); }
if (mode === 'failonce' && fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\\n').length === 1) { process.stderr.write('boom'); process.exit(1); }
if (mode === 'steal') { const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(process.env.FAKE_DB); d.exec("UPDATE claims SET owner = 'thief'"); d.close(); }
if (mode === 'fail') { process.stderr.write('boom SECRET-IN-STDERR'); process.exit(1); }
if (mode === 'slow') await new Promise((r) => setTimeout(r, 1500));
if (mode === 'switchoff') fs.writeFileSync(process.env.FAKE_CONFIG, JSON.stringify({ ...JSON.parse(fs.readFileSync(process.env.FAKE_CONFIG, 'utf8')), mode: 'off' }));
const scope = (input.match(/Conversation scope: (\\S+)/) || [])[1] || '';
let answer;
if (mode === 'facts' || mode === 'repeat' || mode === 'rejects') {
  const window = input.split('WHAT THE OPERATOR WROTE')[1] || '';
  const reported = JSON.parse((input.split('ALREADY REPORTED from this text (DATA, do not report these again):')[1] || '[]').split('\\n')[1] || '[]').map((x) => x.toLowerCase());
  const facts = [];
  for (const m of window.matchAll(/\\[(o[\\d+]+)\\] operator: ([^\\n]*)/g)) for (const f of m[2].matchAll(/I always want (FACT\\d+) notes\\./g)) facts.push({ id: m[1], text: f[0] });
  const calls = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\\n').length;
  const usable = mode === 'repeat' ? facts : facts.filter((f) => !reported.includes(f.text.toLowerCase()));
  const make = (f, confidence = 0.95) => ({ kind: 'preference', category: 'communication', statement: f.text, scope_hint: 'general', exception: false, tentative: false, confidence, replaces: null, evidence: { message_id: f.id, quote: f.text } });
  if (mode === 'rejects' && calls === 1) answer = { candidates: Array.from({ length: 6 }, (_, i) => make({ id: facts[0].id, text: 'I always want FACT' + facts[0].text.match(/FACT(\\d+)/)[1] + ' notes.' }, 0.1)).map((c, i) => ({ ...c, statement: 'I always want junk' + i + ' notes.', evidence: { ...c.evidence, quote: c.evidence.quote } })), more: true };
  else answer = { candidates: usable.slice(0, 6).map((f) => make(f)), more: mode === 'repeat' ? true : usable.length > 6 };
} else {
  const scoped = process.env.FAKE_REVIEW + '.' + scope.replace(':', '_');
  const parsed = JSON.parse(fs.readFileSync(fs.existsSync(scoped) ? scoped : process.env.FAKE_REVIEW, 'utf8'));
  answer = { more: false, ...parsed };
}
process.stdout.write(JSON.stringify({ is_error: false, total_cost_usd: 0.0021, structured_output: answer }));
`;

export function core(configOverrides = {}) {
  const root = tempDir('aiverse-learn-');
  fs.cpSync(path.join(REPO, 'scripts'), path.join(root, 'scripts'), { recursive: true, filter: (src) => !src.includes('__pycache__') });
  fs.cpSync(path.join(REPO, 'system', 'capabilities', 'learn'), path.join(root, 'system', 'capabilities', 'learn'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'AI-VERSE.yaml'), path.join(root, 'AI-VERSE.yaml'));
  fs.mkdirSync(path.join(root, 'operator', 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'));
  fs.mkdirSync(path.join(root, 'runtime'));
  const fake = path.join(root, 'fake-claude.mjs');
  fs.writeFileSync(fake, FAKE_CLAUDE);
  fs.mkdirSync(path.join(root, '.aiverse', 'learn'), { recursive: true });
  const config = { mode: 'propose', python: PYTHON, claude_command: [fake], idle_seconds: 1, ...configOverrides };
  fs.writeFileSync(path.join(root, '.aiverse', 'learn', 'config.json'), JSON.stringify(config));
  Object.assign(process.env, {
    FAKE_LOG: path.join(root, 'fake.log'), FAKE_REVIEW: path.join(root, 'review.json'), FAKE_CONFIG: path.join(root, '.aiverse', 'learn', 'config.json'),
    FAKE_MODE: 'ok', FAKE_DB: path.join(root, 'runtime', 'learn', 'learn.db'),
  });
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

// Records in the shape real transcripts use (see scripts/fixtures): a human prompt has origin.kind "human".
export const userLine = (id, text, cwd, extra = {}) => JSON.stringify({
  type: 'user', uuid: id, ...(cwd === null ? {} : { cwd }), timestamp: '2026-01-02T10:00:00.000Z', userType: 'external', origin: { kind: 'human' },
  message: { role: 'user', content: text }, ...extra,
});
export const assistantLine = (id, text, cwd) => JSON.stringify({ type: 'assistant', uuid: id, ...(cwd === null ? {} : { cwd }), message: { role: 'assistant', content: [{ type: 'text', text }] } });
export const writeTranscript = (file, lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
export const appendTranscript = (file, lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`);

export const review = (candidates, suffix = '', extra = {}) => fs.writeFileSync(process.env.FAKE_REVIEW + suffix, JSON.stringify({ candidates, ...extra }));
export const candidate = (kind, statement, quote, message = 'o1', extra = {}) => ({
  kind, statement, scope_hint: 'general', exception: false, tentative: false, confidence: 0.92, replaces: null,
  evidence: { message_id: message, quote }, ...(kind === 'preference' ? { category: 'communication' } : {}), ...extra,
});

export const calls = () => (fs.existsSync(process.env.FAKE_LOG) ? fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
export const shown = (c) => c.prompt.split('WHAT THE OPERATOR WROTE')[1] ?? '';
export const occurrences = (text) => calls().reduce((n, c) => n + shown(c).split(text).length - 1, 0);
export const preferences = (root) => (fs.existsSync(path.join(root, 'operator/profile/preferences.md')) ? fs.readFileSync(path.join(root, 'operator/profile/preferences.md'), 'utf8') : '');
export const inboxFiles = (root, dir = 'operator/inbox') => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((n) => !n.startsWith('README')) : []);
export const inboxText = (root, dir = 'operator/inbox') => inboxFiles(root, dir).map((n) => fs.readFileSync(path.join(root, dir, n), 'utf8')).join('\n---\n');

export function peek(root, sql, ...args) {
  const db = new DatabaseSync(path.join(root, 'runtime', 'learn', 'learn.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...args).map((r) => ({ ...r }));
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
// Time passes: the lease is over and every wait is up.
export const timePasses = (root) => { mutate(root, 'UPDATE claims SET lease_until = 0'); mutate(root, 'UPDATE sessions SET not_before = 0'); mutate(root, 'UPDATE items SET not_before = 0'); mutate(root, 'UPDATE occurrences SET not_before = 0'); };
export const items = (root) => peek(root, 'SELECT * FROM items ORDER BY id').map((r) => ({ ...r, body: JSON.parse(r.body), result: r.result ? JSON.parse(r.result) : null }));
export const dumpDb = (root) => JSON.stringify(['sessions', 'captures', 'occurrences', 'items', 'secrets', 'ledger', 'counters', 'failures', 'meta'].map((t) => peek(root, `SELECT * FROM ${t}`)));
export const pendingText = (root) => peek(root, "SELECT text FROM occurrences WHERE state = 'pending'").map((r) => r.text);

// Everything the pipeline could have written under the Core, searched byte for byte (database, its WAL, spool, inboxes, owner
// files). The chat's own transcript and the test's own log are the harness's, not the pipeline's, and are not searched.
// A file another connection holds open exclusively (Windows) cannot be read by anyone else either; it is skipped.
const readIfFree = (file) => { try { return fs.readFileSync(file, 'latin1'); } catch (error) { if (['EBUSY', 'EPERM'].includes(error.code)) return ''; throw error; } };

export function allText(root) {
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : readIfFree(path.join(dir, e.name)))).join('') : '');
  return ['runtime', 'operator', 'workspaces', '.aiverse'].map((d) => walk(path.join(root, d))).join('');
}

export const session = (root, id = 'session-1', file = path.join(root, `${id}.jsonl`)) => ({ session_id: id, transcript_path: file, cwd: root });

// The real hook code in its own process, without starting a worker (so tests control when the worker runs).
const HOOK_ONLY = "import('./scripts/learn-hook.mjs').then(async (m) => { let input = ''; for await (const c of process.stdin) input += c; const r = await m.handleEvent(process.cwd(), process.argv[1], JSON.parse(input), Date.now(), () => {}); process.exit(r.ok ? 0 : 1); });";
export const hookEvent = (root, event, payload) => spawnSync(process.execPath, ['-e', HOOK_ONLY, event], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
export const hookEventAsync = (root, event, payload) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['-e', HOOK_ONLY, event], { cwd: root, env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(JSON.stringify(payload));
  child.on('exit', (code) => resolve(code));
});

// Runs the real worker as its own process. `env` can inject a crash point.
export const workerProcess = (root, env = {}, args = ['--drain']) =>
  spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-launch.mjs'), '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
export const workerAsync = (root, env = {}, args = ['--drain']) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'learn-launch.mjs'), '--root', root, ...args], { env: { ...process.env, ...env }, stdio: 'ignore' });
  child.on('exit', (code, signal) => resolve({ code, signal }));
});

// Puts records straight into the journal (as a hook would), without a transcript.
export async function capture(root, sessionId, records, { reason = 'session_end', gaps = [], at = Date.now() } = {}) {
  const db = await openStore(root);
  try {
    return ingestBatch(db, {
      key: sessionKey(sessionId), session_id: sessionId, transcript_path: path.join(root, `${sessionId}.jsonl`), reason, at,
      config: { idle_seconds: 1, max_pending_turns: 6 }, gaps,
      records: records.map((r, i) => ({ seq: i, ts: null, scope: 'operator', src_session: null, cli: null, ...r })),
    });
  } finally {
    db.close();
  }
}
