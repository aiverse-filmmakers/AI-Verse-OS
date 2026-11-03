#!/usr/bin/env node
// Detached worker for automatic learning. One at a time (a lease in the database). It ingests the hook's event files, and for
// each due chat builds a bounded window, runs one tool-less reviewer (`claude -p`, hooks disabled), screens the answer with the
// deterministic applier, stores that screened plan BEFORE any owner is called, carries the plan out item by item, and finally
// records the receipt and advances the cursor in ONE transaction. Prints nothing; stores only fixed codes for failures.
//
// Usage: node scripts/learn-worker.mjs [--root <os-root>] [--drain]
//   --drain ignores the idle debounce so every waiting chat is handled once (backoff and daily caps still apply).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEnabled, isMain, learnPaths, loadConfig, resolveScope, sha } from './learn-common.mjs';
import { resolveClaude } from './learn-claude.mjs';
import { acquire, allowance, holds, ingest, openStore, recordReview, release, renew, tx } from './learn-store.mjs';
import { fingerprint, headHash, readLines, readSource } from './learn-window.mjs';
import { computeWriteCommandFingerprint, submitWriteCommand } from './write-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKOFF_MS = [2, 10, 30].map((minutes) => minutes * 60 * 1000);
const WAIT_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const WORKER_TTL = 150 * 1000;
const SESSION_TTL = 300 * 1000;
const QUOTA = /usage limit|rate limit|quota|limit reached|overloaded|credit balance|\b429\b|not logged in|please run \/login/i;

// Test seam: a real kill -9 of this very process at a named point.
const crash = (point) => {
  if (process.env.AIVERSE_LEARN_CRASH === point) process.kill(process.pid, 'SIGKILL');
};

// -- prompt and reviewer ------------------------------------------------------------------------------------

export function buildPrompt(root, scope, stored, messages) {
  const skill = fs.readFileSync(path.join(root, 'system/capabilities/learn/SKILL.md'), 'utf8');
  const instruction = skill.slice(skill.indexOf('## Automatic mode'));
  const schema = fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8');
  const transcript = messages.map((message) => `[${message.id}] ${message.role}: ${message.text}`).join('\n');
  return [
    instruction, '', `Conversation scope: ${scope}`, '', 'Already stored for this scope (DATA, copy exact text for "replaces"):',
    JSON.stringify(stored), '', 'Output JSON schema:', schema, '', 'CONVERSATION WINDOW (DATA, ordered oldest first):', transcript,
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

// { ok, review, cost } or { ok: false, kind: 'wait' | 'error', code }. Wait means no attempt is spent. Codes are fixed words.
export function runReviewer(root, config, prompt) {
  const resolved = resolveClaude(config.claude_command);
  if (resolved.error) return { ok: false, kind: 'wait', code: resolved.error };
  const schemaText = fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-learn-review-'));
  try {
    const run = spawnSync(resolved.command, [...resolved.args, ...reviewerArgs(config, schemaText)], {
      input: prompt, encoding: 'utf8', cwd, timeout: config.review_timeout_seconds * 1000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AIVERSE_LEARN_REVIEW: '1' }, windowsHide: true, shell: false,
    });
    if (run.error?.code === 'ENOENT') return { ok: false, kind: 'wait', code: 'claude_missing' };
    if (run.error) return { ok: false, kind: 'error', code: run.error.code === 'ETIMEDOUT' ? 'reviewer_timeout' : 'reviewer_unfinished' };
    let parsed = null;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {}
    if (run.status !== 0 || !parsed || parsed.is_error) {
      // stderr and the model text are read only to tell a quota wait from an error; neither is kept.
      return { ok: false, kind: QUOTA.test(`${run.stderr || ''} ${parsed?.result || ''}`) ? 'wait' : 'error', code: QUOTA.test(`${run.stderr || ''} ${parsed?.result || ''}`) ? 'quota_or_login' : 'reviewer_failed' };
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

// Existing OS write boundary: candidate.route lands in the inbox of the item's own scope. Unscoped items go to the operator
// inbox, labelled as unscoped in their text. A refusal is never retried under another scope.
// created_at is a fixed instant: a replay builds the identical request and is recognised as the same command.
export function submitInbox(root, scope, item, idempotency) {
  const request = {
    schema_version: '1.0', request_id: `learn_${idempotency}`, scope: scope === 'unscoped' ? 'operator' : scope, operation: 'candidate.route',
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

// -- one chat -----------------------------------------------------------------------------------------------

class Lost extends Error {}

function setSession(db, key, fields) {
  const names = Object.keys(fields);
  db.prepare(`UPDATE sessions SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE key = ?`).run(...names.map((n) => fields[n]), key);
}

function liveFingerprint(session) {
  try {
    return fingerprint(readLines(session.transcript));
  } catch {
    return null;
  }
}

const noteFailure = (db, key, code) => db.prepare('INSERT INTO failures(session, at, code) VALUES(?, ?, ?)').run(key, Date.now(), code);

// A transcript generation that is gone: stop pointing at it. Unreviewed lines of it (cursor beyond 0) cannot be read any more.
function closeSource(db, key, source) {
  db.prepare('UPDATE sources SET closed = 1 WHERE session = ? AND fp = ?').run(key, source.fp);
  noteFailure(db, key, 'history_replaced'); // also at cursor 0: nothing is closed without a trace
}

// The live transcript no longer is this generation, but PreCompact left its screened user messages: continue from those, at
// the first message not yet reviewed (they remember their original line numbers).
function adoptHandoff(db, key, source) {
  let adopted = 0;
  // every handoff of this generation, oldest first; messages they share are reviewed once (see seen_records)
  for (const handoff of db.prepare('SELECT rowid AS id, path FROM handoffs WHERE session = ? AND fp = ? ORDER BY id').all(key, source.fp)) {
    if (!fs.existsSync(handoff.path)) continue;
    let start = 0;
    let part = 0;
    try {
      const origs = readLines(handoff.path).map((raw) => { try { return JSON.parse(raw).orig; } catch { return -1; } });
      start = origs.filter((o) => o < source.line).length;
      if (source.part > 0 && origs[start] === source.line) part = source.part; // a long message already partly reviewed continues at its part
    } catch { continue; }
    // ord = the adopted generation's own place: its retained history is reviewed before any successor transcript
    db.prepare('INSERT OR IGNORE INTO sources(session, fp, line, part, path, ord) VALUES(?, ?, ?, ?, ?, ?)').run(key, `h:${source.fp}:${handoff.id}`, start, part, handoff.path, source.ord ?? source.id);
    adopted += 1;
  }
  if (!adopted) return false;
  db.prepare('UPDATE sources SET closed = 1 WHERE session = ? AND fp = ?').run(key, source.fp);
  db.prepare('DELETE FROM handoffs WHERE session = ? AND fp = ?').run(key, source.fp);
  noteFailure(db, key, 'handoff_used');
  return true;
}

// Same first line but different history before the cursor: start over on what is there now, never strand the source.
function restartSource(db, key, source) {
  db.prepare("UPDATE sources SET line = 0, part = 0, anchor_line = -1, anchor = '', closed = 0 WHERE session = ? AND fp = ?").run(key, source.fp);
  noteFailure(db, key, 'history_replaced');
  return { ...source, line: 0, part: 0, anchor_line: -1, anchor: '' };
}

function headChanged(db, session, source) {
  const rows = db.prepare('SELECT head, hn FROM handoffs WHERE session = ? AND fp = ? AND head IS NOT NULL').all(session.key, source.fp);
  if (!rows.length) return false;
  try {
    const lines = readLines(session.transcript);
    return rows.some((h) => lines.length < h.hn || headHash(lines, h.hn) !== h.head);
  } catch { return false; }
}

// The first open source that has a pending plan or something left to read.
function nextWork(ctx, session) {
  const { root, db } = ctx;
  const live = liveFingerprint(session);
  if (live) {
    db.prepare('INSERT OR IGNORE INTO sources(session, fp) VALUES(?, ?)').run(session.key, live);
    db.prepare('UPDATE sources SET closed = 0 WHERE session = ? AND fp = ? AND closed = 1').run(session.key, live);
  }
  for (let source of db.prepare('SELECT rowid AS id, * FROM sources WHERE session = ? AND closed = 0 ORDER BY COALESCE(ord, rowid), rowid').all(session.key)) {
    const pending = db.prepare('SELECT body FROM reviews WHERE session = ? AND fp = ? AND line = ? AND part = ?').get(session.key, source.fp, source.line, source.part);
    if (pending) return { source, live, review: JSON.parse(pending.body) };
    // Same first line but different first records: the handoff's head no longer matches the live transcript, so it was replaced
    // even if the cursor is still 0 and no anchor can show it.
    if (!source.path && headChanged(db, session, source)) { if (adoptHandoff(db, session.key, source)) return nextWork(ctx, session); }
    const skip = new Set(db.prepare('SELECT uuid FROM seen_records WHERE session = ? AND fp != ?').all(session.key, source.fp).map((r) => r.uuid));
    let window = readSource(source, source.path || session.transcript, ctx.config.window_chars, (cwd) => resolveScope(root, cwd), skip);
    if (!source.path && (!window || window.replaced) && adoptHandoff(db, session.key, source)) return nextWork(ctx, session);
    if (window?.replaced) {
      source = restartSource(db, session.key, source);
      window = readSource(source, session.transcript, ctx.config.window_chars, (cwd) => resolveScope(root, cwd), skip);
    }
    if (window && (window.messages.length || window.next.line > source.line || window.next.part > source.part)) return { source, live, window };
    if (window && source.fp === live) continue; // nothing new yet in the live transcript
    if (source.path) { db.prepare('UPDATE sources SET closed = 1 WHERE session = ? AND fp = ?').run(session.key, source.fp); fs.rmSync(source.path, { force: true }); continue; }
    if (live) closeSource(db, session.key, source); // a different transcript is live now
  }
  return null;
}

export function processSession(ctx, session) {
  const { db, owner } = ctx;
  const name = `session:${session.key}`;
  if (!acquire(db, name, owner, SESSION_TTL)) return { state: 'busy' };
  // Checked immediately before every canonical write and every inbox submission: the mode is still on and this worker still
  // holds both its leases. A holder that lost its claim to a takeover can therefore never apply anything.
  const guard = () => {
    if (!isEnabled(loadConfig(ctx.root))) return 'disabled';
    return renew(db, 'worker', owner, WORKER_TTL) && renew(db, name, owner, SESSION_TTL) ? null : 'lost';
  };
  try {
    ctx.config = loadConfig(ctx.root);
    const work = nextWork(ctx, session);
    if (!work) {
      db.prepare('UPDATE sessions SET due_at = NULL WHERE key = ? AND due_at = ?').run(session.key, session.due_at); // unless a newer event moved it
      return { state: 'idle' };
    }
    return work.review ? execute(ctx, session, work, work.review, guard) : review(ctx, session, work, guard);
  } catch (error) {
    if (error instanceof Lost) return { state: 'lost' };
    throw error;
  } finally {
    release(db, name, owner);
  }
}

function wait(ctx, session, code, ms = WAIT_MS) {
  setSession(ctx.db, session.key, { not_before: ctx.now() + ms, blocked: code });
  return { state: 'waiting', code };
}

function review(ctx, session, { source, live, window }, guard) {
  const { root, db, now, drain } = ctx;
  if (!window.hasEligible) return finish(ctx, session, source, live, window, null);
  const limit = allowance(db, session.key, ctx.config, now(), drain);
  if (!limit.ok) {
    setSession(db, session.key, { not_before: limit.not_before, blocked: 'rate_limited' });
    return { state: 'rate_limited' };
  }
  const stored = callApplier(root, ctx.config, 'context', { scope: window.scope });
  if (!stored.ok) return fail(ctx, session, source, live, window, stored, guard);
  const reviewed = runReviewer(root, ctx.config, buildPrompt(root, window.scope, stored.value, window.messages));
  if (reviewed.ok || reviewed.kind !== 'wait') recordReview(db, session.key, reviewed.cost ?? 0, now());
  if (!reviewed.ok) return fail(ctx, session, source, live, window, reviewed, guard);
  const planned = callApplier(root, ctx.config, 'plan', { scope: window.scope, session_key: session.key, messages: window.messages, candidates: reviewed.review.candidates, stored: stored.value });
  if (!planned.ok) return fail(ctx, session, source, live, window, planned, guard);
  const body = {
    scope: window.scope, cost: reviewed.cost, model: ctx.config.model, messages: window.messages.length, skipped: window.skipped,
    next: window.next, anchor_line: window.anchor_line, anchor: window.anchor, at_end: window.atEnd, completed: window.completed,
    items: planned.value.items.map((item) => ({ ...item, done: false })),
  };
  tx(db, () => {
    if (!holds(db, `session:${session.key}`, ctx.owner, now())) throw new Lost();
    db.prepare('INSERT OR REPLACE INTO reviews(session, fp, line, part, body) VALUES(?, ?, ?, ?, ?)').run(session.key, source.fp, source.line, source.part, JSON.stringify(body));
  });
  return execute(ctx, session, { source, live }, body, guard);
}

// Carries out the stored plan one item at a time. A retry or a restart resumes here with the same items, never with a new
// model answer. Each item is recorded as done only after its owner or inbox call returned.
function execute(ctx, session, { source, live }, body, guard) {
  const { root, db } = ctx;
  const save = () => db.prepare('UPDATE reviews SET body = ? WHERE session = ? AND fp = ? AND line = ? AND part = ?').run(JSON.stringify(body), session.key, source.fp, source.line, source.part);
  for (const item of body.items) {
    if (item.done) continue;
    if (item.disposition === 'rejected') {
      item.done = true;
      item.state = 'rejected';
      save();
      continue;
    }
    const blocked = guard();
    if (blocked) return blocked === 'lost' ? { state: 'lost' } : { state: 'disabled' };
    const mode = loadConfig(root).mode;
    const committed = callApplier(root, ctx.config, 'commit', { mode, scope: body.scope, session_key: session.key, item, parent_pid: process.pid, deadline: Date.now() + 20000 });
    if (!committed.ok) return wait(ctx, session, committed.code);
    crash('after_owner');
    const result = committed.value;
    if (result.inbox) {
      const again = guard();
      if (again) return again === 'lost' ? { state: 'lost' } : { state: 'disabled' };
      const filed = submitInbox(root, body.scope, result.inbox, sha(`${session.key}|${result.inbox.refs?.join()}|${result.inbox.summary}`));
      if (!filed.ok) return wait(ctx, session, filed.code);
    }
    Object.assign(item, { done: true, state: result.state, reason: result.reason, owner: result.owner, ref: result.ref });
    save();
    crash('after_item');
  }
  const receipt = {
    version: 3, session: session.key, scope: body.scope, reason: session.reason, mode: loadConfig(root).mode, model: body.model, cost_usd: body.cost,
    messages: body.messages, skipped_outside_core: body.skipped || undefined,
    results: body.items.map(({ kind, state, reason, owner, ref }) => ({ kind, state, reason, owner, ref })),
  };
  const window = { next: body.next, anchor_line: body.anchor_line, anchor: body.anchor, atEnd: body.at_end, completed: body.completed };
  return finish(ctx, session, source, live, window, receipt);
}

// Receipt, cursor, review row and wake time change together or not at all, and only for the current owner of the claim.
function finish(ctx, session, source, live, window, receipt) {
  const { db, owner } = ctx;
  const name = `session:${session.key}`;
  const more = !window.atEnd;
  tx(db, () => {
    if (!holds(db, name, owner, ctx.now())) throw new Lost();
    if (receipt) db.prepare('INSERT INTO receipts(session, at, body) VALUES(?, ?, ?)').run(session.key, ctx.now(), JSON.stringify(receipt));
    crash('in_finish');
    for (const uuid of window.completed ?? []) db.prepare('INSERT OR IGNORE INTO seen_records(session, uuid, fp) VALUES(?, ?, ?)').run(session.key, uuid, source.fp);
    db.prepare('UPDATE sources SET line = ?, part = ?, anchor_line = ?, anchor = ? WHERE session = ? AND fp = ?')
      .run(window.next.line, window.next.part, window.anchor_line, window.anchor, session.key, source.fp);
    db.prepare('DELETE FROM reviews WHERE session = ? AND fp = ? AND line = ? AND part = ?').run(session.key, source.fp, source.line, source.part);
    if (source.path && window.atEnd) db.prepare('UPDATE sources SET closed = 1 WHERE session = ? AND fp = ?').run(session.key, source.fp);
    const others = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE session = ? AND closed = 0 AND fp != ?').get(session.key, source.fp).n > 0;
    const row = db.prepare('SELECT due_at FROM sessions WHERE key = ?').get(session.key);
    // An event that arrived while this range was being handled moved due_at; keep it.
    const due = more || others ? ctx.now() : row.due_at === session.due_at ? null : row.due_at;
    db.prepare('UPDATE sessions SET attempts = 0, blocked = NULL, not_before = 0, due_at = ? WHERE key = ?').run(due, session.key);
  });
  crash('after_finish');
  if (source.path && window.atEnd) fs.rmSync(source.path, { force: true });
  if (!source.path && window.atEnd) { // the live transcript is fully reviewed, so a handoff of it is redundant
    for (const spare of db.prepare('SELECT path FROM handoffs WHERE session = ? AND fp = ?').all(session.key, source.fp)) fs.rmSync(spare.path, { force: true });
    db.prepare('DELETE FROM handoffs WHERE session = ? AND fp = ?').run(session.key, source.fp);
  }
  return { state: receipt ? 'reviewed' : 'skipped_no_user_message', results: receipt?.results };
}

function fail(ctx, session, source, live, window, outcome, guard) {
  const { db } = ctx;
  if (outcome.kind === 'wait') return wait(ctx, session, outcome.code);
  const attempts = (db.prepare('SELECT attempts FROM sessions WHERE key = ?').get(session.key).attempts ?? 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    setSession(db, session.key, { attempts, not_before: ctx.now() + BACKOFF_MS[attempts - 1], blocked: outcome.code });
    return { state: 'retry', code: outcome.code };
  }
  // Terminal for this range only (no screened candidate exists yet, so nothing is lost): note it without content, move past
  // it, and the rest of the chat continues as the next range.
  const blocked = guard();
  if (blocked) return { state: blocked === 'lost' ? 'lost' : 'disabled' };
  const filed = submitInbox(ctx.root, window.scope, {
    candidate_kind: 'claude-code-learning-failed',
    summary: `A range of a Claude Code conversation could not be reviewed automatically (${outcome.code}, chat ${session.key}). Say "learn from this conversation" in that chat if it still matters.`,
    refs: [`claude-code:${session.key}`],
  }, sha(`${session.key}|dead|${source.fp}|${source.line}|${source.part}`));
  if (!filed.ok) return wait(ctx, session, filed.code);
  db.prepare('INSERT INTO failures(session, at, code) VALUES(?, ?, ?)').run(session.key, ctx.now(), outcome.code);
  return finish(ctx, session, source, live, window, { version: 3, session: session.key, scope: window.scope, failed: outcome.code, messages: window.messages.length, results: [] });
}

// -- worker loop --------------------------------------------------------------------------------------------

function writeStatus(root, code) {
  try {
    const { base } = learnPaths(root);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'status.json'), JSON.stringify({ code, at: new Date().toISOString() }));
  } catch {}
}

export async function run(root, { drain = false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 35 * 60 * 1000, owner = crypto.randomUUID(), now = Date.now } = {}) {
  const outcomes = [];
  if (!isEnabled(loadConfig(root))) return { ran: false, outcomes };
  let db;
  try {
    db = await openStore(root);
  } catch {
    writeStatus(root, 'store_unavailable'); // Node without node:sqlite, or an unusable folder: events wait in the spool
    return { ran: false, outcomes, code: 'store_unavailable' };
  }
  const ctx = { root, db, owner, drain, now, config: null };
  try {
    for (let round = 0; round < 2; round += 1) {
      if (!acquire(db, 'worker', owner, WORKER_TTL, now())) break;
      try {
        db.prepare('DELETE FROM receipts WHERE at < ?').run(now() - 30 * 24 * 3600 * 1000);
        for (let i = 0; i < 500; i += 1) {
          if (!isEnabled(loadConfig(root))) return { ran: true, outcomes };
          if (!renew(db, 'worker', owner, WORKER_TTL, now())) break;
          ingest(db, root, now());
          const rows = db.prepare('SELECT * FROM sessions WHERE due_at IS NOT NULL ORDER BY due_at').all();
          const ready = rows.find((r) => r.not_before <= now() && (drain || r.due_at <= now()));
          if (ready) {
            const outcome = processSession(ctx, ready);
            outcomes.push({ key: ready.key, ...outcome });
            if (outcome.state === 'busy' || outcome.state === 'lost') break; // another worker owns it now
            continue;
          }
          const next = Math.min(...rows.map((r) => Math.max(r.due_at, r.not_before)));
          if (drain || !rows.length || next - now() > maxWaitMs) break;
          await sleep(Math.min(Math.max(next - now(), 0), 5000));
        }
      } finally {
        release(db, 'worker', owner);
      }
      // A hook that fired while this worker was exiting found the lease held and started nothing: look once more.
      const spooled = (() => { try { return fs.readdirSync(learnPaths(root).spool).some((n) => n.endsWith('.json')); } catch { return false; } })();
      if (!spooled) break;
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
