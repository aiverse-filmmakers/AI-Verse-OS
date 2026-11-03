#!/usr/bin/env node
// Detached worker for automatic learning. ONE serial worker (a lease in the database). It ingests envelopes, then repeats:
//   1. carry out a stored item (an owner save or an inbox proposal), or
//   2. review the oldest unreviewed human messages of a chat, page by page: reserve the review allowance, run one tool-less
//      reviewer (`claude -p`, hooks disabled, subscription login only), screen the answer with the deterministic applier, and store
//      the screened items (and, on the last page, mark the messages reviewed) in ONE transaction, before any owner is called.
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
import { isEnabled, isMain, learnPaths, loadConfig, looksSynced, setStatus, sha, sqliteTooOld, validWorkspace } from './learn-common.mjs';
import { resolveClaude } from './learn-claude.mjs';
import { acquire, isSecretText, openStore, purgeWal, release, renew, reserveReview, settleReview, tx } from './learn-store.mjs';
import { computeWriteCommandFingerprint, submitWriteCommand, withdrawCandidate } from './write-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKOFF_MS = [2, 10, 30, 120, 720, 1440].map((minutes) => minutes * 60 * 1000);
const WAIT_MS = 30 * 60 * 1000;
const MAX_ROUNDS = 5;
const QUOTA = /usage limit|rate limit|quota|limit reached|overloaded|credit balance|\b429\b|not logged in|please run \/login/i;

// Test seam: a real kill -9 of this very process at a named point ("name" or "name:n" for the n-th time that point is reached).
const reached = {};
const crash = (point) => {
  const [name, nth = '1'] = (process.env.AIVERSE_LEARN_CRASH ?? '').split(':');
  if (name !== point) return;
  reached[point] = (reached[point] ?? 0) + 1;
  if (reached[point] === Number(nth)) process.kill(process.pid, 'SIGKILL');
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

// Existing OS write boundary: candidate.route lands in the inbox of the item's own scope. Unresolved scope is never submitted (it
// stays in the journal until a scope is bound). created_at is a fixed instant: a replay builds the identical request. The actual
// receipt of the write command (its id and where the candidate was filed) is returned, to be kept with the item.
export function submitInbox(root, scope, item, idempotency) {
  const request = {
    schema_version: '1.0', request_id: `learn_${idempotency}`, scope, operation: 'candidate.route',
    parameters: { candidate_kind: item.candidate_kind, summary: item.summary, refs: item.refs ?? [] },
    idempotency_key: `learn_${idempotency}`, requested_by: REQUESTER,
    reason: 'Keep an automatic learning proposal for the member to approve, instead of saving or losing it.',
    created_at: new Date(0).toISOString(),
  };
  request.request_fingerprint = computeWriteCommandFingerprint(request);
  try {
    const done = submitWriteCommand({ osRoot: root, request });
    if (done.status === 'withdrawn') return { ok: true, withdrawn: true }; // withdrawn before it could be filed: it stays withdrawn
    return { ok: true, receipt: { command_id: done.command_id, status: done.status, path: done.result?.path ?? null, completed_at: done.completed_at ?? null, request_fingerprint: done.request_fingerprint } };
  } catch {
    return { ok: false, code: 'inbox_failed' };
  }
}
const REQUESTER = 'ai-verse-os.auto-learning';

// -- windows over the journal -------------------------------------------------------------------------------

// Where to cut `text` so that at most `room` characters (UTF-16 code units, the unit of every stored offset) are taken, preferably at a
// line or sentence end.
export function chooseCut(text, room) {
  if (text.length <= room) return text.length;
  const head = text.slice(0, room);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '));
  let at = cut > room * 0.6 ? cut + 1 : room;
  const last = text.charCodeAt(at - 1);
  if (last >= 0xd800 && last <= 0xdbff) at -= 1; // never split a surrogate pair
  return Math.max(at, 1);
}

// The oldest unreviewed messages of one chat and one scope, in SOURCE order (their own timestamps, then arrival; the position inside a file means nothing across files), as segments measured
// in absolute offsets of each message. Progress is stored per message (done_to), so the window size can change at any time without
// skipping or repeating a character.
export function buildWindow(db, key, budget, now) {
  const rows = db.prepare(`SELECT id, uuid, ts, scope, text, done_to FROM occurrences WHERE session = ? AND state = 'pending' AND not_before <= ? AND text IS NOT NULL
    ORDER BY CASE WHEN ts IS NULL THEN 1 ELSE 0 END, ts, id LIMIT 500`).all(key, now);
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

function laterTexts(db, key, win) {
  const ids = new Set(win.segs.map((s) => s.occurrence));
  return db.prepare("SELECT id, text FROM occurrences WHERE session = ? AND state = 'pending' AND text IS NOT NULL ORDER BY CASE WHEN ts IS NULL THEN 1 ELSE 0 END, ts, id LIMIT 200").all(key)
    .filter((r) => !ids.has(r.id)).slice(0, 20).map((r) => r.text.slice(0, 2000));
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

const candidateHash = (statement) => sha(statement.toLowerCase(), 24);

// A window is reviewed page by page. Each page is planned and STORED (with the identity of every candidate it contained, accepted or
// rejected) before the next is asked for, so a restart continues where it stopped. The text is only marked reviewed on the last page,
// and a reviewer that says there is more but offers nothing new is a stalled continuation to retry later, never a finished one.
function reviewWindow(ctx, session) {
  const { root, db, now, config, guard, hooks } = ctx;
  const win = buildWindow(db, session.key, config.window_chars, now());
  if (!win) {
    db.prepare('UPDATE sessions SET due_at = NULL WHERE key = ? AND due_at = ?').run(session.key, session.due_at); // unless a newer event moved it
    return { state: 'idle' };
  }
  const messages = win.segs.map((seg) => ({ id: seg.id, role: 'user', text: seg.text, full: seg.full, ts: seg.ts, start: seg.start }));
  const stored = callApplier(root, config, 'context', { scope: win.scope });
  if (!stored.ok) return failWindow(ctx, session, win, stored);
  hooks.afterContext?.(win);
  const uuids = win.segs.map((seg) => seg.uuid);
  const seen = new Set(db.prepare('SELECT h FROM seen_candidates WHERE session = ?').all(session.key).map((r) => r.h));
  const reported = db.prepare('SELECT body FROM items WHERE session = ?').all(session.key).map((r) => JSON.parse(r.body)).filter((b) => uuids.includes(b.uuid)).map((b) => b.statement);
  let total = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (guard()) return { state: 'disabled' };
    // The text cached above may have been excluded (a credential found, say) while the context was loading or the last page ran:
    // it is looked at again right before anything is sent, and a changed window is simply rebuilt on the next step.
    const now_ = buildWindow(db, session.key, config.window_chars, now());
    if (!now_ || now_.segs.map((x) => `${x.occurrence}:${x.start}:${x.end}`).join() !== win.segs.map((x) => `${x.occurrence}:${x.start}:${x.end}`).join() || now_.segs.some((x, i) => x.full !== win.segs[i].full)) {
      db.prepare('UPDATE sessions SET not_before = 0, due_at = ? WHERE key = ?').run(now(), session.key);
      return { state: 'continuing', items: total };
    }
    const reservation = reserveReview(db, session.key, config, now(), ctx.drain || round > 0, () => !guard());
    if (!reservation.ok) {
      if (reservation.off) return { state: 'disabled' };
      db.prepare('UPDATE sessions SET not_before = ?, blocked = ? WHERE key = ?').run(reservation.not_before, 'rate_limited', session.key);
      return { state: 'rate_limited' };
    }
    crash('after_reserve');
    const reviewed = runReviewer(root, config, buildPrompt(root, win.scope, stored.value, messages, reported));
    if (guard()) return { state: 'disabled' }; // switched off while the reviewer ran: nothing more is written (the reservation stays counted)
    if (!reviewed.ok) return failWindow(ctx, session, win, reviewed);
    settleReview(db, session.key, reservation, reviewed.cost);
    hooks.afterReview?.(win);
    const page = reviewed.review.candidates;
    const fresh = page.filter((c) => typeof c?.statement === 'string' && !seen.has(candidateHash(c.statement)));
    const more = reviewed.review.more === true || page.length >= 6;
    if (more && !fresh.length) return failWindow(ctx, session, win, { kind: 'error', code: 'reviewer_stalled' });
    const planned = fresh.length ? callApplier(root, config, 'plan', {
      scope: win.scope, session_key: session.key, messages, candidates: fresh, stored: stored.value, later: laterTexts(db, session.key, win),
    }) : { ok: true, value: { items: [], revision: null } };
    if (!planned.ok) return failWindow(ctx, session, win, planned);
    try {
      storePage(ctx, session, win, fresh, planned.value, more);
    } catch (error) {
      if (error instanceof Stop) return { state: 'disabled' };
      throw error;
    }
    for (const c of fresh) { seen.add(candidateHash(c.statement)); if (!isSecretText(db, c.statement)) reported.push(c.statement); }
    total += fresh.length;
    if (!more) {
      crash('after_finish');
      return { state: 'reviewed', items: total };
    }
  }
  db.prepare('UPDATE sessions SET not_before = 0, due_at = ? WHERE key = ?').run(now(), session.key); // more to report: continue on the next step
  return { state: 'continuing', items: total };
}

// One transaction: the page's screened items, the identity of its candidates and, on the last page, the reviewed marks. A source that
// was excluded in the meantime (a credential found, for instance) yields no item, and nothing is advanced for it.
function storePage(ctx, session, win, fresh, planned, more) {
  const { db, now, guard, hooks } = ctx;
  hooks.beforeStore?.(win);
  tx(db, () => {
    if (guard()) throw new Stop();
    const live = new Set(db.prepare(`SELECT id FROM occurrences WHERE id IN (${win.segs.map(() => '?').join(',')}) AND state = 'pending' AND text IS NOT NULL`).all(...win.segs.map((s) => s.occurrence)).map((r) => r.id));
    const insert = db.prepare('INSERT OR IGNORE INTO items(session, scope, key, state, body, at) VALUES(?, ?, ?, ?, ?, ?)');
    const count = db.prepare('INSERT INTO counters(session, code, n) VALUES(?, ?, 1) ON CONFLICT(session, code) DO UPDATE SET n = n + 1');
    for (const c of fresh) db.prepare('INSERT OR IGNORE INTO seen_candidates(session, h) VALUES(?, ?)').run(session.key, candidateHash(c.statement));
    for (const item of planned.items) {
      const seg = win.segs.find((s) => s.id === item.message_id);
      // every persisted content field is screened with the one credential contract; an excluded source yields nothing
      if (item.disposition === 'rejected' || !seg || !live.has(seg.occurrence) || isSecretText(db, `${item.statement ?? ''}\n${item.quote ?? ''}\n${item.replaces ?? ''}`)) {
        count.run(session.key, `rejected_${item.disposition === 'rejected' ? item.reason : seg && live.has(seg.occurrence) ? 'secret_in_source' : 'source_excluded'}`);
        continue;
      }
      const body = { ...item, message_id: seg.uuid, uuid: seg.uuid, ts: seg.ts, scope: win.scope, harness: 'claude-code', quote_abs: seg.start + item.quote_at, revision: planned.revision };
      const needsScope = win.scope === 'unresolved' || item.reason === 'scope_unresolved';
      insert.run(session.key, win.scope, sha(`${session.key}|${seg.uuid}|${item.kind}|${item.statement.toLowerCase()}`, 32), needsScope ? 'needs_scope' : 'pending', JSON.stringify(body), now());
    }
    crash('in_finish');
    if (!more) {
      for (const seg of win.segs) {
        if (!live.has(seg.occurrence)) continue;
        if (seg.end >= seg.full.length) db.prepare("UPDATE occurrences SET state = 'done', text = NULL, done_to = ?, attempts = 0 WHERE id = ?").run(seg.end, seg.occurrence);
        else db.prepare('UPDATE occurrences SET done_to = ?, attempts = 0 WHERE id = ?').run(seg.end, seg.occurrence);
      }
      const left = db.prepare("SELECT COUNT(*) AS n FROM occurrences WHERE session = ? AND state = 'pending'").get(session.key).n > 0;
      const row = db.prepare('SELECT due_at FROM sessions WHERE key = ?').get(session.key);
      // An event that arrived while this range was being handled moved due_at; keep it.
      db.prepare('UPDATE sessions SET blocked = NULL, not_before = 0, due_at = ? WHERE key = ?').run(left ? now() : row.due_at === session.due_at ? null : row.due_at, session.key);
    }
  });
}

// Removes from the inbox a proposal whose text turned out to hold a credential, whatever state its filing is in (not started, ambiguous,
// done): the write-command owner records a terminal tombstone first, so nothing can recreate it. A proposal the owner will not
// withdraw (another owner's, promoted) is left alone and reported as blocked.
function withdrawItem(ctx, row) {
  const { root, db, now, guard } = ctx;
  if (guard()) return { state: 'disabled' };
  const effect = JSON.parse(row.result).effect;
  try {
    withdrawCandidate({ osRoot: root, scope: effect.scope, idempotency_key: effect.idempotency_key });
  } catch (error) {
    if (error?.exitCode === 6) {
      db.prepare("UPDATE items SET state = 'withdraw_blocked', done_at = ? WHERE id = ?").run(now(), row.id);
      setStatus(root, 'withdraw_blocked');
      return { state: 'withdraw_blocked' };
    }
    db.prepare('UPDATE items SET not_before = ? WHERE id = ?').run(now() + WAIT_MS, row.id);
    return { state: 'waiting', code: 'withdraw_failed' };
  }
  db.prepare("UPDATE items SET state = 'withdrawn', done_at = ? WHERE id = ?").run(now(), row.id);
  return { state: 'withdrawn' };
}

// Carries out ONE stored item. A retry or a restart resumes here with the same item, never with a new model answer. The inbox effect is
// claimed with a conditional update on the item's revision immediately before it happens: an item excluded, withdrawn or rebound in the
// meantime no longer matches, and then nothing is filed. A credential found while the effect is under way turns the finished item
// into a withdrawal.
function runItem(ctx, row) {
  const { root, db, now, config, guard, hooks } = ctx;
  const item = JSON.parse(row.body);
  const delay = (code) => { db.prepare('UPDATE items SET not_before = ? WHERE id = ?').run(now() + WAIT_MS, row.id); return { state: 'waiting', code }; };
  if (guard()) return { state: 'disabled' };
  const committed = callApplier(root, config, 'commit', {
    mode: loadConfig(root).mode, scope: row.scope, session_key: row.session, item, parent_pid: process.pid, deadline: Date.now() + 20000,
  });
  if (!committed.ok) return delay(committed.code);
  crash('after_owner');
  hooks.beforeEffect?.(row);
  const result = committed.value;
  const outcome = { state: result.state, reason: result.reason, owner: result.owner, ref: result.ref };
  if (!result.inbox) {
    db.prepare("UPDATE items SET state = 'done', result = ?, done_at = ? WHERE id = ? AND state = 'pending' AND rev = ?").run(JSON.stringify(outcome), now(), row.id, row.rev);
    return { state: 'item', result: result.state };
  }
  if (isSecretText(db, result.inbox.summary)) { // the rendered proposal is screened too
    db.prepare("UPDATE items SET state = 'excluded', body = '{}', rev = rev + 1 WHERE id = ? AND state = 'pending'").run(row.id);
    return { state: 'excluded' };
  }
  if (guard()) return { state: 'disabled' };
  const idempotency = sha(`${row.session}|${result.inbox.refs?.join()}|${result.inbox.summary}`);
  const effect = { scope: row.scope, idempotency_key: `learn_${idempotency}` };
  const claimed = db.prepare("UPDATE items SET state = 'filing', result = ? WHERE id = ? AND state = 'pending' AND rev = ?").run(JSON.stringify({ effect }), row.id, row.rev);
  if (claimed.changes !== 1) return { state: 'revoked' }; // no longer what was planned: no effect
  crash('after_claim');
  hooks.afterClaim?.(row);
  const filed = (hooks.submit ?? submitInbox)(root, row.scope, result.inbox, idempotency);
  if (!filed.ok) {
    // Ambiguous: the command or the inbox item may exist. The reference to it is KEPT, so it stays withdrawable and the retry (same key) reconciles it.
    db.prepare("UPDATE items SET state = 'pending', not_before = ? WHERE id = ? AND state = 'filing'").run(now() + WAIT_MS, row.id);
    return { state: 'waiting', code: filed.code };
  }
  hooks.afterSubmit?.(row);
  if (filed.withdrawn) { // the owner says it was withdrawn: the item is withdrawn too
    db.prepare("UPDATE items SET state = 'withdrawn', done_at = ? WHERE id = ? AND state IN ('filing', 'withdraw_pending')").run(now(), row.id);
    return { state: 'withdrawn' };
  }
  const done = db.prepare("UPDATE items SET state = 'done', result = ?, done_at = ? WHERE id = ? AND state = 'filing'").run(JSON.stringify({ ...outcome, effect, receipt: filed.receipt }), now(), row.id);
  if (done.changes !== 1) return withdrawItem(ctx, { ...row, result: JSON.stringify({ effect }) }); // a credential was found while it was being filed
  crash('after_item');
  return { state: 'item', result: result.state };
}

// The member said which project a parked item belongs to: ONLY the listed items move, each against the revision it was shown at, with
// the evidence of that statement kept beside it. A workspace must really exist in this Core, with a manifest naming itself.
export function bindItems(db, root, bindings, scope, evidence) {
  if (typeof evidence === 'string' && isSecretText(db, evidence)) throw new Error('scope_binding_refused'); // the member's words are screened like any other persisted text
  const known = scope === 'operator' || (scope.startsWith('workspace:') && validWorkspace(root, scope.slice('workspace:'.length)));
  if (!known || typeof evidence !== 'string' || !evidence.trim()) throw new Error('scope_binding_refused');
  return tx(db, () => bindings.map(({ id, rev }) => {
    const row = db.prepare("SELECT body, rev, state FROM items WHERE id = ?").get(id);
    if (!row || row.state !== 'needs_scope' || row.rev !== rev) return { id, bound: false };
    const body = { ...JSON.parse(row.body), scope, disposition: 'proposal', reason: 'scope_bound', binding: { scope, evidence: evidence.slice(0, 500) } };
    db.prepare("UPDATE items SET scope = ?, state = 'pending', body = ?, rev = rev + 1 WHERE id = ?").run(scope, JSON.stringify(body), id);
    return { id, bound: true };
  }));
}

// -- worker loop --------------------------------------------------------------------------------------------

const DAY = 24 * 3600 * 1000;

// Only counters, failures and accounting older than their use are pruned. Occurrences and items are NEVER deleted (their text and bodies
// are emptied when finished): the unique identities are what stop an old transcript or a forgotten statement from coming back.
function housekeeping(ctx) {
  const { db, root, config, now } = ctx;
  const t = now();
  db.prepare('DELETE FROM failures WHERE at < ?').run(t - 90 * DAY);
  db.prepare('DELETE FROM ledger WHERE day < ?').run(new Date(t - 60 * DAY).toISOString().slice(0, 10));
  db.prepare("UPDATE items SET state = 'pending' WHERE state = 'filing'").run(); // a worker that died mid-effect: replayed with the same key
  refreshHealth(ctx);
  if (db.prepare("SELECT v FROM meta WHERE k = 'purge_pending'").get() && purgeWal(db)) db.prepare("DELETE FROM meta WHERE k = 'purge_pending'").run();
  setStatus(root, 'wal_purge_pending', Boolean(db.prepare("SELECT v FROM meta WHERE k = 'purge_pending'").get()));
  setStatus(root, 'synced_folder', looksSynced(fs.realpathSync(root)));
  setStatus(root, 'sqlite_wal_reset_risk', sqliteTooOld(db.prepare('SELECT sqlite_version() AS v').get().v));

}

// What is waiting (unreviewed text, unfinished items) plus the size of the write-ahead log, against the room the member allowed.
function refreshHealth(ctx) {
  const { db, root, config } = ctx;
  const backlog = db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM occurrences WHERE state = 'pending'").get().n
    + db.prepare("SELECT COALESCE(SUM(LENGTH(body)), 0) AS n FROM items WHERE state IN ('pending', 'needs_scope', 'filing')").get().n;
  let wal = 0;
  try { wal = fs.statSync(`${learnPaths(root).db}-wal`).size; } catch {}
  setStatus(root, 'storage_pressure', backlog + wal > config.max_pending_mb * 1024 * 1024);
}

function step(ctx) {
  const { db, now, drain } = ctx;
  const t = now();
  const withdrawing = db.prepare("SELECT * FROM items WHERE state = 'withdraw_pending' AND not_before <= ? ORDER BY id LIMIT 1").get(t);
  if (withdrawing) return withdrawItem(ctx, withdrawing);
  const item = db.prepare("SELECT * FROM items WHERE state = 'pending' AND not_before <= ? ORDER BY id LIMIT 1").get(t);
  if (item) return runItem(ctx, item);
  const sessions = db.prepare('SELECT * FROM sessions s WHERE due_at IS NOT NULL ORDER BY due_at').all();
  const open = db.prepare("SELECT 1 FROM occurrences WHERE session = ? AND state = 'pending' AND not_before <= ? LIMIT 1");
  const ready = sessions.find((s) => s.not_before <= t && (drain || s.due_at <= t) && open.get(s.key, t));
  if (ready) {
    const outcome = reviewWindow(ctx, ready);
    refreshHealth(ctx);
    return outcome;
  }
  const times = [
    ...sessions.map((s) => (drain ? s.not_before : Math.max(s.due_at, s.not_before))),
    ...db.prepare("SELECT not_before AS t FROM items WHERE state IN ('pending', 'withdraw_pending') AND not_before > ?").all(t).map((r) => r.t),
    ...db.prepare("SELECT not_before AS t FROM occurrences WHERE state = 'pending' AND not_before > ?").all(t).map((r) => r.t),
  ].filter((x) => x > t);
  return { state: 'wait', at: times.length ? Math.min(...times) : null };
}

// The lease must outlive the longest synchronous work between two renewals: one reviewer call (its own timeout) plus the applier calls.
export const leaseMs = (config) => (config.review_timeout_seconds + 240) * 1000;

export async function run(root, { drain = false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 35 * 60 * 1000, owner = crypto.randomUUID(), now = Date.now, hooks = {} } = {}) {
  const outcomes = [];
  if (!isEnabled(loadConfig(root))) return { ran: false, outcomes };
  let db;
  try {
    db = await openStore(root);
  } catch (error) {
    setStatus(root, error?.code === 'store_incompatible' ? 'store_incompatible' : 'store_unavailable'); // an unusable or foreign database is never touched
    return { ran: false, outcomes, code: error?.code === 'store_incompatible' ? 'store_incompatible' : 'store_unavailable' };
  }
  try {
    const config0 = loadConfig(root);
    if (!acquire(db, 'worker', owner, leaseMs(config0), now())) return { ran: false, outcomes };
    const ctx = {
      root, db, drain, now, config: config0, owner, hooks,
      // The boundary checked immediately before every mutation and every inbox submission: learning still on, lease still ours.
      guard: () => {
        const config = loadConfig(root);
        if (!isEnabled(config)) return 'disabled';
        ctx.config = config;
        return renew(db, 'worker', owner, leaseMs(config), now()) ? null : 'lost';
      },
    };
    try {
      housekeeping(ctx);
      for (let i = 0; i < 2000; i += 1) {
        if (ctx.guard()) break;
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
  return run(root, { drain }).catch(() => setStatus(root, 'worker_failed')).finally(() => process.exit(0));
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
