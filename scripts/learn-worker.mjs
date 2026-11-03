#!/usr/bin/env node
// Detached worker for automatic learning. ONE serial worker (a lease in the database). It ingests envelopes, then repeats:
//   1. carry out a stored item (an owner save or an inbox proposal), or
//   2. review the oldest unreviewed human messages of a chat: reserve the review allowance, run one tool-less reviewer
//      (`claude -p`, hooks disabled, subscription login only), screen the answer with the deterministic applier, store the
//      screened items and mark the messages reviewed in ONE transaction, and only then call any owner.
// Prints nothing. Stores only exact human quotes, fixed codes and counts.
//
// Usage: node scripts/learn-launch.mjs [--root <os-root>] [--drain]
//   --drain ignores the idle debounce so every waiting chat is handled once (backoff and daily caps still apply).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEnabled, isMain, learnPaths, listEnvelopes, loadConfig, setStatus, sha } from './learn-common.mjs';
import { resolveClaude } from './learn-claude.mjs';
import { acquire, candidateIsSecret, ingestEnvelopes, openStore, release, renew, reserveReview, settleReview, tx } from './learn-store.mjs';
import { computeWriteCommandFingerprint, submitWriteCommand } from './write-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKOFF_MS = [2, 10, 30, 120, 720, 1440].map((minutes) => minutes * 60 * 1000);
const WAIT_MS = 30 * 60 * 1000;
const WORKER_TTL = 300 * 1000;
const MAX_ROUNDS = 5;
const QUOTA = /usage limit|rate limit|quota|limit reached|overloaded|credit balance|\b429\b|not logged in|please run \/login/i;

// Test seam: a real kill -9 of this very process at a named point.
const crash = (point) => {
  if (process.env.AIVERSE_LEARN_CRASH === point) process.kill(process.pid, 'SIGKILL');
};

// -- prompt and reviewer ------------------------------------------------------------------------------------

export function buildPrompt(root, scope, stored, messages, reported = []) {
  const skill = fs.readFileSync(path.join(root, 'system/capabilities/learn/SKILL.md'), 'utf8');
  const instruction = skill.slice(skill.indexOf('## Automatic mode'));
  const schema = fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8');
  const transcript = messages.map((message) => `[${message.id}] operator: ${message.text}`).join('\n');
  return [
    instruction, '', `Conversation scope: ${scope}`, '', 'Already stored for this scope (DATA, copy exact text for "replaces"):',
    JSON.stringify(stored), '', 'Output JSON schema:', schema, '', 'ALREADY REPORTED from this text (DATA, do not report these again):', JSON.stringify(reported), '', 'WHAT THE OPERATOR WROTE (DATA, ordered oldest first):', transcript,
  ].join('\n');
}

export function reviewerArgs(config, schemaText) {
  return [
    '-p', '--model', config.model, '--tools', '', '--max-turns', '2', '--max-budget-usd', String(config.max_budget_usd),
    '--no-session-persistence', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', 'user',
    '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    '--output-format', 'json', '--json-schema', JSON.stringify(JSON.parse(schemaText)),
  ];
}

// Members use a subscription login. Anything that selects paid API billing or another provider is removed from the reviewer's
// environment, and the reviewer is not run at all if one could not be removed.
const BILLING = /^(?:ANTHROPIC_.*|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|AWS_BEARER_TOKEN_BEDROCK)$/i;
export function reviewerEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (!BILLING.test(key) && value !== undefined) out[key] = value;
  out.AIVERSE_LEARN_REVIEW = '1';
  return Object.keys(out).some((key) => BILLING.test(key)) ? null : out;
}

// { ok, review, cost } or { ok: false, kind: 'wait' | 'error', code }. Wait means no attempt is spent. Codes are fixed words.
export function runReviewer(root, config, prompt) {
  const resolved = resolveClaude(config.claude_command);
  if (resolved.error) return { ok: false, kind: 'wait', code: resolved.error };
  const env = reviewerEnv(process.env);
  if (!env) return { ok: false, kind: 'wait', code: 'billing_env_present' };
  const schemaText = fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-learn-review-'));
  try {
    const run = spawnSync(resolved.command, [...resolved.args, ...reviewerArgs(config, schemaText)], {
      input: prompt, encoding: 'utf8', cwd, timeout: config.review_timeout_seconds * 1000, maxBuffer: 8 * 1024 * 1024,
      env, windowsHide: true, shell: false,
    });
    if (run.error?.code === 'ENOENT') return { ok: false, kind: 'wait', code: 'claude_missing' };
    if (run.error) return { ok: false, kind: 'error', code: run.error.code === 'ETIMEDOUT' ? 'reviewer_timeout' : 'reviewer_unfinished' };
    let parsed = null;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {}
    if (run.status !== 0 || !parsed || parsed.is_error) {
      // stderr and the model text are read only to tell a quota wait from an error; neither is kept.
      const quota = QUOTA.test(`${run.stderr || ''} ${parsed?.result || ''}`);
      return { ok: false, kind: quota ? 'wait' : 'error', code: quota ? 'quota_or_login' : 'reviewer_failed' };
    }
    const review = parsed.structured_output;
    if (!review || !Array.isArray(review.candidates)) return { ok: false, kind: 'error', code: 'reviewer_bad_output' };
    return { ok: true, review, cost: Number(parsed.total_cost_usd) || 0 };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// -- python applier -----------------------------------------------------------------------------------------

export function findPython(root, config) {
  if (config.python) return config.python;
  const tools = path.join(path.dirname(root), '.ai-verse-tools');
  try {
    for (const dir of fs.readdirSync(tools)) {
      const meta = JSON.parse(fs.readFileSync(path.join(tools, dir, 'project.json'), 'utf8'));
      const argv = meta?.checks?.doctor?.doctor?.components?.['ai-verse-brain']?.argv ?? meta?.checks?.doctor?.components?.['ai-verse-brain']?.argv;
      if (!argv?.[0] || path.resolve(meta.project || '') !== path.resolve(root)) continue;
      const python = path.join(path.dirname(argv[0]), process.platform === 'win32' ? 'python.exe' : 'python');
      if (fs.existsSync(python)) return python;
    }
  } catch {}
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function callApplier(root, config, command, payload) {
  const run = spawnSync(findPython(root, config), [path.join(root, 'scripts/ai_verse_learn_apply.py'), '--root', root, command], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, PYTHONIOENCODING: 'utf-8' },
  });
  if (run.error?.code === 'ENOENT') return { ok: false, kind: 'wait', code: 'python_missing' };
  if (run.status !== 0) return { ok: false, kind: 'error', code: 'applier_failed' }; // stderr is never kept
  try {
    return { ok: true, value: JSON.parse(run.stdout) };
  } catch {
    return { ok: false, kind: 'error', code: 'applier_bad_output' };
  }
}

// -- inbox --------------------------------------------------------------------------------------------------

// Existing OS write boundary: candidate.route lands in the inbox of the item's own scope. Unresolved scope is never submitted
// (it stays in the journal until a scope is bound). created_at is a fixed instant: a replay builds the identical request.
export function submitInbox(root, scope, item, idempotency) {
  const request = {
    schema_version: '1.0', request_id: `learn_${idempotency}`, scope, operation: 'candidate.route',
    parameters: { candidate_kind: item.candidate_kind, summary: item.summary, refs: item.refs ?? [] },
    idempotency_key: `learn_${idempotency}`, requested_by: 'ai-verse-os.auto-learning',
    reason: 'Keep an automatic learning proposal for the member to approve, instead of saving or losing it.',
    created_at: new Date(0).toISOString(),
  };
  request.request_fingerprint = computeWriteCommandFingerprint(request);
  try {
    submitWriteCommand({ osRoot: root, request });
    return { ok: true };
  } catch {
    return { ok: false, code: 'inbox_failed' };
  }
}

// -- windows over the journal -------------------------------------------------------------------------------

// Where to cut `text` so that at most `room` characters are taken, preferably at a line or sentence end.
export function chooseCut(text, room) {
  if (text.length <= room) return text.length;
  const head = text.slice(0, room);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '));
  let at = cut > room * 0.6 ? cut + 1 : room;
  const last = text.charCodeAt(at - 1);
  if (last >= 0xd800 && last <= 0xdbff) at -= 1; // never split a surrogate pair
  return Math.max(at, 1);
}

// The oldest unreviewed messages of one chat and one scope, as segments measured in absolute character offsets of each message.
// Progress is stored per message (done_to), so the window size can change at any time without skipping or repeating a character.
export function buildWindow(db, key, budget, now) {
  const rows = db.prepare("SELECT id, uuid, ts, scope, text, done_to FROM occurrences WHERE session = ? AND state = 'pending' AND not_before <= ? AND text IS NOT NULL ORDER BY id LIMIT 500").all(key, now);
  if (!rows.length) return null;
  const scope = rows[0].scope;
  const segs = [];
  let used = 0;
  for (const row of rows) {
    if (row.scope !== scope) break;
    const room = budget - used;
    if (segs.length && room < 200) break;
    const rest = row.text.slice(row.done_to);
    const take = chooseCut(rest, room);
    const id = row.done_to ? `o${row.id}+${row.done_to}` : `o${row.id}`;
    segs.push({ id, occurrence: row.id, uuid: row.uuid, ts: row.ts, text: rest.slice(0, take), full: row.text, start: row.done_to, end: row.done_to + take });
    used += take;
    if (row.done_to + take < row.text.length) break;
  }
  return { scope, segs, used };
}

// -- one step of the loop -----------------------------------------------------------------------------------

class Stop extends Error {}

function laterTexts(db, key, after) {
  return db.prepare("SELECT text FROM occurrences WHERE session = ? AND id > ? AND state = 'pending' AND text IS NOT NULL ORDER BY id LIMIT 20").all(key, after).map((r) => r.text.slice(0, 2000));
}

function failWindow(ctx, session, win, outcome) {
  const { db, root, now } = ctx;
  if (outcome.kind === 'wait') {
    db.prepare('UPDATE sessions SET not_before = ?, blocked = ? WHERE key = ?').run(now() + WAIT_MS, outcome.code, session.key);
    return { state: 'waiting', code: outcome.code };
  }
  // Park this range and let later ranges go on; it is retried later with a growing delay and is never discarded.
  let worst = 0;
  for (const seg of win.segs) {
    const row = db.prepare('SELECT attempts FROM occurrences WHERE id = ?').get(seg.occurrence);
    worst = Math.max(worst, row.attempts + 1);
    db.prepare('UPDATE occurrences SET attempts = ?, not_before = ? WHERE id = ?').run(row.attempts + 1, now() + BACKOFF_MS[Math.min(row.attempts, BACKOFF_MS.length - 1)], seg.occurrence);
  }
  db.prepare('INSERT INTO failures(session, at, code) VALUES(?, ?, ?)').run(session.key, now(), outcome.code);
  if (worst === 3 && !ctx.guard()) {
    const scope = win.scope === 'unresolved' ? 'operator' : win.scope;
    submitInbox(root, scope, {
      candidate_kind: 'claude-code-learning-failed',
      summary: `A range of a Claude Code conversation could not be reviewed automatically (${outcome.code}, chat ${session.key}). It will be tried again. Say "learn from this conversation" in that chat if it matters now.`,
      refs: [`claude-code:${session.key}`],
    }, sha(`${session.key}|failed|${win.segs[0].uuid}`));
  }
  return { state: 'parked', code: outcome.code };
}

// Asks the reviewer again, with what it already reported, until it has nothing more (or the round limit): a window that holds more
// than six durable statements is never cut off at six. Every round reserves its own allowance first.
function reviewRounds(ctx, session, win, messages, stored, reported) {
  const { root, db, now, config, guard } = ctx;
  const gathered = [];
  const known = new Set(reported.map((s) => s.toLowerCase()));
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (guard()) return { stop: 'disabled' };
    const reservation = reserveReview(db, session.key, config, now(), ctx.drain || round > 0, () => !guard());
    if (!reservation.ok) return reservation.off ? { stop: 'disabled' } : { stop: 'limit', not_before: reservation.not_before, gathered, more: round > 0 };
    crash('after_reserve');
    const reviewed = runReviewer(root, config, buildPrompt(root, win.scope, stored, messages, [...known]));
    if (guard()) return { stop: 'disabled' }; // switched off while the reviewer ran: nothing more is written (the reservation stays counted)
    if (!reviewed.ok) return { stop: 'failed', outcome: reviewed, gathered };
    settleReview(db, session.key, reservation, reviewed.cost);
    const fresh = reviewed.review.candidates.filter((c) => typeof c?.statement === 'string' && !known.has(c.statement.toLowerCase()));
    for (const c of fresh) known.add(c.statement.toLowerCase());
    gathered.push(...fresh);
    if (!fresh.length || !(reviewed.review.more === true || reviewed.review.candidates.length >= 6)) return { gathered, more: false };
  }
  return { gathered, more: true };
}

function reviewWindow(ctx, session) {
  const { root, db, now, config, guard } = ctx;
  const win = buildWindow(db, session.key, config.window_chars, now());
  if (!win) {
    db.prepare('UPDATE sessions SET due_at = NULL WHERE key = ? AND due_at = ?').run(session.key, session.due_at); // unless a newer event moved it
    return { state: 'idle' };
  }
  const messages = win.segs.map((seg) => ({ id: seg.id, role: 'user', text: seg.text, full: seg.full, ts: seg.ts, start: seg.start }));
  const stored = callApplier(root, config, 'context', { scope: win.scope });
  if (!stored.ok) return failWindow(ctx, session, win, stored);
  const uuids = win.segs.map((seg) => seg.uuid);
  const reported = db.prepare('SELECT body FROM items WHERE session = ?').all(session.key).map((r) => JSON.parse(r.body)).filter((b) => uuids.includes(b.uuid)).map((b) => b.statement);
  const rounds = reviewRounds(ctx, session, win, messages, stored.value, reported);
  if (rounds.stop === 'disabled') return { state: 'disabled' };
  if (rounds.stop === 'failed') return failWindow(ctx, session, win, rounds.outcome);
  if (rounds.stop === 'limit' && !rounds.gathered.length) {
    db.prepare('UPDATE sessions SET not_before = ?, blocked = ? WHERE key = ?').run(rounds.not_before, 'rate_limited', session.key);
    return { state: 'rate_limited' };
  }
  const planned = callApplier(root, config, 'plan', {
    scope: win.scope, session_key: session.key, messages, candidates: rounds.gathered, stored: stored.value, later: laterTexts(db, session.key, win.segs.at(-1).occurrence),
  });
  if (!planned.ok) return failWindow(ctx, session, win, planned);
  const incomplete = rounds.more === true; // still more to report: keep the text, come back with a longer "already reported" list
  try {
    tx(db, () => {
      if (guard()) throw new Stop();
      const insert = db.prepare('INSERT OR IGNORE INTO items(session, scope, key, state, body, at) VALUES(?, ?, ?, ?, ?, ?)');
      for (const item of planned.value.items) {
        if (item.disposition === 'rejected' || candidateIsSecret(db, `${item.statement ?? ''} ${item.quote ?? ''}`)) {
          const code = item.disposition === 'rejected' ? item.reason : 'secret_in_source';
          db.prepare('INSERT INTO counters(session, code, n) VALUES(?, ?, 1) ON CONFLICT(session, code) DO UPDATE SET n = n + 1').run(session.key, `rejected_${code}`);
          continue;
        }
        const seg = win.segs.find((s) => s.id === item.message_id);
        const body = { ...item, message_id: seg.uuid, uuid: seg.uuid, ts: seg.ts, scope: win.scope, harness: 'claude-code', quote_abs: seg.start + item.quote_at, revision: planned.value.revision };
        const needsScope = win.scope === 'unresolved' || item.reason === 'scope_unresolved';
        insert.run(session.key, win.scope, sha(`${session.key}|${seg.uuid}|${item.kind}|${item.statement.toLowerCase()}`, 32), needsScope ? 'needs_scope' : 'pending', JSON.stringify(body), now());
      }
      crash('in_finish');
      if (!incomplete) {
        for (const seg of win.segs) {
          if (seg.end >= seg.full.length) db.prepare("UPDATE occurrences SET state = 'done', text = NULL, done_to = ?, attempts = 0 WHERE id = ?").run(seg.end, seg.occurrence);
          else db.prepare('UPDATE occurrences SET done_to = ?, attempts = 0 WHERE id = ?').run(seg.end, seg.occurrence);
        }
      }
      const more = db.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE session = ? AND state = 'pending'").get(session.key).n > 0;
      const row = db.prepare('SELECT due_at FROM sessions WHERE key = ?').get(session.key);
      // An event that arrived while this range was being handled moved due_at; keep it.
      db.prepare('UPDATE sessions SET blocked = NULL, not_before = ?, due_at = ? WHERE key = ?')
        .run(rounds.stop === 'limit' ? rounds.not_before : 0, more ? now() : row.due_at === session.due_at ? null : row.due_at, session.key);
    });
  } catch (error) {
    if (error instanceof Stop) return { state: 'disabled' };
    throw error;
  }
  crash('after_finish');
  return { state: 'reviewed', items: planned.value.items.length };
}

// Carries out ONE stored item. A retry or a restart resumes here with the same item, never with a new model answer.
function runItem(ctx, row) {
  const { root, db, now, config, guard } = ctx;
  const item = JSON.parse(row.body);
  const delay = (code) => { db.prepare('UPDATE items SET not_before = ? WHERE id = ?').run(now() + WAIT_MS, row.id); return { state: 'waiting', code }; };
  if (guard()) return { state: 'disabled' };
  const committed = callApplier(root, config, 'commit', {
    mode: loadConfig(root).mode, scope: row.scope, session_key: row.session, item, parent_pid: process.pid, deadline: Date.now() + 20000,
  });
  if (!committed.ok) return delay(committed.code);
  crash('after_owner');
  const result = committed.value;
  if (result.inbox) {
    if (guard()) return { state: 'disabled' };
    const filed = submitInbox(root, row.scope, result.inbox, sha(`${row.session}|${result.inbox.refs?.join()}|${result.inbox.summary}`));
    if (!filed.ok) return delay(filed.code);
  }
  db.prepare("UPDATE items SET state = 'done', result = ?, done_at = ? WHERE id = ? AND state = 'pending'")
    .run(JSON.stringify({ state: result.state, reason: result.reason, owner: result.owner, ref: result.ref }), now(), row.id);
  crash('after_item');
  return { state: 'item', result: result.state };
}

// A scope became known for a conversation whose scope was unresolved: its parked items continue, in that scope's own inbox.
export function bindScope(db, key, scope) {
  for (const row of db.prepare("SELECT id, body FROM items WHERE session = ? AND state = 'needs_scope'").all(key)) {
    const body = { ...JSON.parse(row.body), scope, disposition: 'proposal', reason: 'scope_bound' };
    db.prepare("UPDATE items SET scope = ?, state = 'pending', body = ? WHERE id = ?").run(scope, JSON.stringify(body), row.id);
  }
}

// -- worker loop --------------------------------------------------------------------------------------------

const DAY = 24 * 3600 * 1000;

// Only completed metadata is ever pruned. Unreviewed messages and unfinished items are never removed, however old.
function housekeeping(ctx) {
  const { db, root, config, now } = ctx;
  const t = now();
  db.prepare("DELETE FROM occurrences WHERE state IN ('done', 'excluded') AND at < ?").run(t - 365 * DAY);
  db.prepare("DELETE FROM items WHERE state IN ('done', 'excluded') AND at < ?").run(t - 365 * DAY);
  db.prepare('DELETE FROM failures WHERE at < ?').run(t - 90 * DAY);
  db.prepare('DELETE FROM ledger WHERE day < ?').run(new Date(t - 60 * DAY).toISOString().slice(0, 10));
  const bytes = db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM occurrences WHERE state = 'pending'").get().n;
  const { status } = learnPaths(root);
  let current = null;
  try { current = JSON.parse(fs.readFileSync(status, 'utf8')).code; } catch {}
  const wanted = bytes > config.max_pending_mb * 1024 * 1024 ? 'storage_pressure' : 'ok';
  if (current ? current !== wanted : wanted !== 'ok') setStatus(root, wanted);
}

function step(ctx) {
  const { db, now, drain } = ctx;
  const t = now();
  const item = db.prepare("SELECT * FROM items WHERE state = 'pending' AND not_before <= ? ORDER BY id LIMIT 1").get(t);
  if (item) return runItem(ctx, item);
  const sessions = db.prepare(`SELECT * FROM sessions s WHERE due_at IS NOT NULL ORDER BY due_at`).all();
  const open = db.prepare("SELECT 1 FROM occurrences WHERE session = ? AND state = 'pending' AND not_before <= ? LIMIT 1");
  const ready = sessions.find((s) => s.not_before <= t && (drain || s.due_at <= t) && open.get(s.key, t));
  if (ready) return reviewWindow(ctx, ready);
  const times = [
    ...sessions.map((s) => (drain ? s.not_before : Math.max(s.due_at, s.not_before))),
    ...db.prepare("SELECT not_before AS t FROM items WHERE state = 'pending' AND not_before > ?").all(t).map((r) => r.t),
    ...db.prepare("SELECT not_before AS t FROM occurrences WHERE state = 'pending' AND not_before > ?").all(t).map((r) => r.t),
  ].filter((x) => x > t);
  return { state: 'wait', at: times.length ? Math.min(...times) : null };
}

export async function run(root, { drain = false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 35 * 60 * 1000, owner = crypto.randomUUID(), now = Date.now } = {}) {
  const outcomes = [];
  if (!isEnabled(loadConfig(root))) return { ran: false, outcomes };
  let db;
  try {
    db = await openStore(root);
  } catch {
    setStatus(root, 'store_unavailable'); // Node without node:sqlite, or an unusable folder: captures wait as envelopes
    return { ran: false, outcomes, code: 'store_unavailable' };
  }
  try {
    if (!acquire(db, 'worker', owner, WORKER_TTL, now())) return { ran: false, outcomes };
    const ctx = {
      root, db, drain, now, config: loadConfig(root), owner,
      // The boundary checked immediately before every mutation and every inbox submission: learning still on, lease still ours.
      guard: () => {
        const config = loadConfig(root);
        if (!isEnabled(config)) return 'disabled';
        ctx.config = config;
        return renew(db, 'worker', owner, WORKER_TTL, now()) ? null : 'lost';
      },
    };
    try {
      housekeeping(ctx);
      for (let i = 0; i < 2000; i += 1) {
        if (ctx.guard()) break;
        ingestEnvelopes(db, root, listEnvelopes(root, now()), now());
        const outcome = step(ctx);
        if (outcome.state === 'wait') {
          if (drain || outcome.at === null || outcome.at - now() > maxWaitMs) break;
          await sleep(Math.min(Math.max(outcome.at - now(), 0), 5000));
          continue;
        }
        outcomes.push(outcome);
        if (outcome.state === 'disabled') break;
      }
    } finally {
      release(db, 'worker', owner);
    }
  } finally {
    db.close();
  }
  return { ran: true, outcomes };
}

function parseArgs(argv) {
  const args = { root: path.resolve(HERE, '..'), drain: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = path.resolve(argv[++i]);
    else if (argv[i] === '--drain') args.drain = true;
  }
  return args;
}

export function main(argv) {
  const { root, drain } = parseArgs(argv);
  return run(root, { drain }).catch(() => {}).finally(() => process.exit(0));
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
