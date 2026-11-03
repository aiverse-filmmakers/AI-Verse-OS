#!/usr/bin/env node
// Detached worker for automatic learning. One per Core (lock file). For each due job it builds a bounded window,
// runs one tool-less reviewer (`claude -p`, hooks disabled), hands the untrusted JSON to the deterministic applier,
// writes a receipt and only then advances the cursor. Failures retry, then land in the OS inbox. Prints nothing.
//
// Usage: node scripts/learn-worker.mjs [--root <os-root>] [--drain]
//   --drain ignores the idle debounce so every queued job is handled once (used at session end and in tests).

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  acquireLock, claimJob, dueAt, finishClaim, isEnabled, learnPaths, listJobs, loadConfig, readCursor, readJson, readLedger, recordReview,
  recoverClaims, releaseLock, resolveScope, reviewAllowance, touchLock, writeCursor, writeJsonAtomic,
} from './learn-queue.mjs';
import { readWindow } from './learn-window.mjs';
import { computeWriteCommandFingerprint, submitWriteCommand } from './write-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKOFF_MS = [2, 10, 30].map((minutes) => minutes * 60 * 1000);
const WAIT_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const QUOTA = /usage limit|rate limit|quota|limit reached|overloaded|credit balance|\b429\b|not logged in|please run \/login/i;

// -- prompt and reviewer ------------------------------------------------------------------------------------

export function buildPrompt(root, scope, stored, messages) {
  const skill = fs.readFileSync(path.join(root, 'system/capabilities/learn/SKILL.md'), 'utf8');
  const instruction = skill.slice(skill.indexOf('## Automatic mode'));
  const schema = fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8');
  const transcript = messages.map((message) => `[${message.id}] ${message.role}: ${message.text}${message.unreviewed_chars ? ` [${message.unreviewed_chars} more characters of this message were not shown]` : ''}`).join('\n');
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

// Returns { ok, review, cost } or { ok: false, kind: 'wait' | 'error', reason }. Wait means no attempt is spent.
export function runReviewer(root, config, prompt) {
  const [command, ...prefix] = config.claude_command;
  const schemaText = fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-learn-review-'));
  try {
    const run = spawnSync(command, [...prefix, ...reviewerArgs(config, schemaText)], {
      input: prompt, encoding: 'utf8', cwd, timeout: config.review_timeout_seconds * 1000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AIVERSE_LEARN_REVIEW: '1' }, windowsHide: true,
    });
    if (run.error?.code === 'ENOENT') return { ok: false, kind: 'wait', reason: 'claude is not installed or not on PATH' };
    if (run.error) return { ok: false, kind: 'error', reason: `reviewer did not finish: ${run.error.code || run.error.message}` };
    let parsed = null;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {}
    const detail = `${run.stderr || ''} ${parsed?.result || ''}`;
    if (run.status !== 0 || !parsed || parsed.is_error) {
      return { ok: false, kind: QUOTA.test(detail) ? 'wait' : 'error', reason: `reviewer failed (exit ${run.status})` };
    }
    const review = parsed.structured_output;
    if (!review || !Array.isArray(review.candidates)) return { ok: false, kind: 'error', reason: 'reviewer returned no candidate list' };
    return { ok: true, review, cost: Number(parsed.total_cost_usd) || 0 };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

// -- python applier -----------------------------------------------------------------------------------------

// Explicit config, then the Brain interpreter Distribution recorded beside the project, then a system python.
export function findPython(root, config) {
  if (config.python) return config.python;
  const tools = path.join(path.dirname(root), '.ai-verse-tools');
  try {
    for (const dir of fs.readdirSync(tools)) {
      const meta = readJson(path.join(tools, dir, 'project.json'));
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
  if (run.error?.code === 'ENOENT') return { ok: false, kind: 'wait', reason: 'python is not available' };
  if (run.status !== 0) return { ok: false, kind: 'error', reason: `applier failed: ${(run.stderr || '').trim().split('\n').pop()?.slice(0, 200)}` };
  try {
    return { ok: true, value: JSON.parse(run.stdout) };
  } catch {
    return { ok: false, kind: 'error', reason: 'applier returned invalid JSON' };
  }
}

// -- inbox --------------------------------------------------------------------------------------------------

// Existing OS write boundary: candidate.route lands in the inbox of the item's own scope. A refusal is reported, never
// retried under another scope (private workspace text must not cross into operator state).
// created_at is a fixed instant on purpose: a replay after a crash builds the identical request and is recognised as the same command.
export function submitInbox(root, scope, item, idempotency) {
  const request = {
    schema_version: '1.0', request_id: `learn_${idempotency}`, scope, operation: 'candidate.route',
    parameters: { candidate_kind: item.candidate_kind, summary: item.summary, refs: item.refs ?? [] },
    idempotency_key: `learn_${idempotency}`, requested_by: 'ai-verse-os.auto-learning',
    reason: 'Keep an automatic learning item the owners could not accept, instead of losing it.',
    created_at: new Date(0).toISOString(),
  };
  request.request_fingerprint = computeWriteCommandFingerprint(request);
  try {
    const result = submitWriteCommand({ osRoot: root, request });
    return { ok: true, scope, status: result.status };
  } catch (error) {
    return { ok: false, reason: String(error.message).slice(0, 200) };
  }
}

// -- job processing -----------------------------------------------------------------------------------------

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);

// The transcript is primary. When it is unreadable or its history was replaced (a gap), a compaction snapshot that
// covers the cursor is read instead, from the cursor's own position inside the snapshot.
function readSource(root, job, cursor, budget) {
  const options = { scopeOf: (cwd) => resolveScope(root, cwd), defaultScope: job.scope };
  let failure = null;
  try {
    const window = readWindow(job.transcript_path, cursor, budget, options);
    if (!window.gap) return { ...window, offset: 0 };
    failure = new Error('transcript history was replaced');
  } catch (error) {
    failure = error;
  }
  const spool = (job.spools ?? []).find((s) => fs.existsSync(s.path) && s.from_line <= cursor && cursor < s.from_line + s.lines);
  if (!spool) throw failure;
  return { ...readWindow(spool.path, cursor - spool.from_line, budget, options), offset: spool.from_line, from_spool: true };
}

function failJob(root, job, claim, window, outcome, now) {
  if (outcome.kind === 'wait') {
    finishClaim(root, job.key, { ...claim, not_before: now + WAIT_MS, blocked: outcome.reason });
    return { state: 'waiting', reason: outcome.reason };
  }
  const attempts = (claim.attempts ?? 0) + 1;
  if (attempts < MAX_ATTEMPTS) {
    finishClaim(root, job.key, { ...claim, attempts, not_before: now + BACKOFF_MS[attempts - 1], blocked: outcome.reason });
    return { state: 'retry', reason: outcome.reason };
  }
  // Final failure: keep the whole job and any unfiled candidates on disk, note it in the inbox of its own scope,
  // and only move the cursor on when that note was filed.
  const { dead } = learnPaths(root);
  writeJsonAtomic(path.join(dead, `${job.key}-${now}.json`), { ...claim, attempts, reason: outcome.reason, window, pending: outcome.pending ?? [] });
  const filed = submitInbox(root, window?.scope ?? job.scope, {
    candidate_kind: 'claude-code-learning-failed',
    summary: `Could not review a conversation range automatically (session ${job.key}, lines ${window?.from ?? '?'} to ${window?.to ?? '?'}): ${outcome.reason}. Say "learn from this conversation" in that chat if it still matters.`,
    refs: [`claude-code:${job.key}`],
  }, sha(`${job.key}|dead|${window?.from}|${window?.to}`));
  if (filed.ok && window?.next !== undefined) writeCursor(root, job.key, window.next);
  if (filed.ok) finishClaim(root, job.key, null);
  else finishClaim(root, job.key, { ...claim, attempts, not_before: now + WAIT_MS, blocked: 'inbox unavailable' });
  return { state: filed.ok ? 'dead' : 'retry', reason: outcome.reason };
}

export function processJob(root, config, job, { now = Date.now(), drain = false } = {}) {
  const claim = claimJob(root, job.key);
  if (!claim) return { state: 'skipped' };
  const cursor = readCursor(root, job.key);
  let window;
  try {
    window = readSource(root, claim, cursor, config.window_chars);
  } catch (error) {
    return failJob(root, claim, claim, null, { kind: 'error', reason: `transcript unreadable: ${error.message}` }, now);
  }
  const span = { from: cursor, to: window.offset + window.nextLine, next: window.offset + window.nextLine, scope: window.scope };
  const advance = (receipt) => {
    if (receipt) writeJsonAtomic(path.join(learnPaths(root).receipts, `${job.key}-${now}.json`), receipt);
    writeCursor(root, job.key, span.next);
    // The window was cut by the size budget, a change of scope, or the end of one compaction snapshot while another
    // still lies ahead: keep reviewing the rest, oldest first. Fully consumed snapshots are removed.
    const ahead = (claim.spools ?? []).filter((spool) => spool.from_line + spool.lines > span.next);
    for (const spool of claim.spools ?? []) if (!ahead.includes(spool)) fs.rmSync(spool.path, { force: true });
    if (window.more || ahead.length) finishClaim(root, job.key, { ...claim, spools: ahead, attempts: 0, not_before: 0, due_at: now, blocked: null });
    else finishClaim(root, job.key, null);
  };
  if (!window.hasEligible) {
    advance(null);
    return { state: 'skipped_no_user_message' };
  }
  const allowance = reviewAllowance(readLedger(root, now), job.key, config, now, { ignoreGap: drain });
  if (!allowance.ok) {
    finishClaim(root, job.key, { ...claim, not_before: allowance.not_before });
    return { state: 'rate_limited' };
  }
  const stored = callApplier(root, config, 'context', { scope: window.scope });
  if (!stored.ok) return failJob(root, claim, claim, span, stored, now);
  const reviewed = runReviewer(root, config, buildPrompt(root, window.scope, stored.value, window.messages));
  if (reviewed.ok || reviewed.kind !== 'wait') recordReview(root, job.key, reviewed.cost, now);
  if (!reviewed.ok) return failJob(root, claim, claim, span, reviewed, now);
  // The kill switch is honoured up to the moment of writing: a review finished after "off" is discarded unapplied.
  if (!isEnabled(loadConfig(root))) {
    finishClaim(root, job.key, { ...claim, attempts: claim.attempts ?? 0, not_before: 0 });
    return { state: 'disabled' };
  }
  const applied = callApplier(root, config, 'apply', {
    session_key: job.key, scope: window.scope, messages: window.messages, candidates: reviewed.review.candidates,
  });
  if (!applied.ok) return failJob(root, claim, claim, span, applied, now);
  const results = [];
  const unfiled = [];
  for (const result of applied.value.results) {
    if (!result.inbox) {
      results.push(result);
      continue;
    }
    const { inbox, ...rest } = result;
    const filed = submitInbox(root, window.scope, inbox, sha(`${job.key}|${inbox.refs?.join()}|${inbox.summary}`));
    if (!filed.ok) unfiled.push(inbox);
    results.push({ ...rest, state: filed.ok ? 'pending_inbox' : 'inbox_failed' });
  }
  // Nothing is reported done, and the cursor stays put, while any candidate could not be filed: the next try
  // replays safely (owners are idempotent) and the complete candidates are kept in the dead record if it never works.
  if (unfiled.length) return failJob(root, claim, claim, span, { kind: 'error', reason: 'inbox unavailable', pending: unfiled }, now);
  advance({
    version: 2, job: job.key, scope: window.scope, reason: claim.reason, at: new Date(now).toISOString(),
    lines: { from: span.from, to: span.to }, messages: window.messages.length, gap: window.gap || undefined,
    from_spool: window.from_spool || undefined,
    unreviewed: window.messages.filter((m) => m.unreviewed_chars).map((m) => ({ id: m.id, chars: m.unreviewed_chars })),
    review: { model: config.model, cost_usd: reviewed.cost }, results,
  });
  return { state: 'reviewed', results };
}

// -- worker loop --------------------------------------------------------------------------------------------

export async function run(root, { drain = false, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 10 * 60 * 1000 } = {}) {
  const outcomes = [];
  const seen = new Set();
  // A hook that fired while this worker was exiting may have found the lock held, so look once more after releasing it.
  for (let round = 0; round < 3; round += 1) {
    if (!acquireLock(root)) return { ran: outcomes.length > 0 || round > 0, outcomes };
    try {
      recoverClaims(root, Date.now(), { force: true }); // holding the lock means no other worker owns a claim
      for (;;) {
        const config = loadConfig(root);
        if (!isEnabled(config)) return { ran: true, outcomes };
        touchLock(root);
        const jobs = listJobs(root).filter((job) => !(drain && seen.has(job.key)));
        if (!jobs.length) break;
        const job = jobs.sort((a, b) => dueAt(a) - dueAt(b))[0];
        const wait = drain ? 0 : dueAt(job) - Date.now();
        if (wait > maxWaitMs) return { ran: true, outcomes };
        if (wait > 0) {
          await sleep(Math.min(wait, 5000));
          continue;
        }
        seen.add(job.key);
        outcomes.push({ key: job.key, ...processJob(root, config, job, { drain }) });
      }
    } finally {
      releaseLock(root);
    }
    if (!listJobs(root).some((job) => !seen.has(job.key) || !drain)) break;
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

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const { root, drain } = parseArgs(process.argv.slice(2));
  run(root, { drain }).catch(() => {}).finally(() => process.exit(0));
}
