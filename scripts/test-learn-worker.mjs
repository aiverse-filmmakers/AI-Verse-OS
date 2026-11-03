#!/usr/bin/env node
// Worker end to end with a fake `claude`, the real python applier, the real profile owner and the real inbox boundary.
// Risky paths run for real: separate worker processes, kill -9 at named points, replaced transcripts, secrets searched byte for byte.
// Brain and Memory are not installed in the temporary Core, so goals prove the "no owner means proposal" path.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { learnPaths, loadConfig, readStatus, sessionKey } from './learn-common.mjs';
import { openStore } from './learn-store.mjs';
import { bindItems, buildPrompt, reviewerArgs, reviewerEnv, run } from './learn-worker.mjs';
import {
  REPO, allText, appendTranscript, assistantLine, calls, candidate, capture, core, dumpDb, hookEvent, inboxFiles, inboxText, items, mutate, occurrences, peek, preferences,
  review, session, setMode, shown, timePasses, userLine, workerAsync, workerProcess, workspace, writeTranscript,
} from './test-learn-support.mjs';

const drain = (root) => run(root, { drain: true });
const u = (root, id, text, cwd = root) => userLine(id, text, cwd);
const states = (root) => items(root).map((i) => i.result?.reason ?? i.result?.state ?? i.state);
function chat(root, lines, { mode = 'propose', id = 'session-1', event = 'end' } = {}) {
  const s = session(root, id);
  writeTranscript(s.transcript_path, lines);
  setMode(root, mode);
  hookEvent(root, event, s);
  return s;
}
const warm = () => review([candidate('preference', 'I always want a warm tone in client emails.', 'I always want a warm tone in client emails.', 'o1')]);

test('the reviewer runs without tools, hooks, memory or paid-API environment, and with its allowance reserved first', async () => {
  const root = core();
  const args = reviewerArgs({ model: 'haiku', max_budget_usd: 0.15 }, fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(!args.includes('--bare'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true, autoMemoryEnabled: false });
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--json-schema']) assert.ok(args.includes(flag));
  assert.ok(JSON.parse(args[args.indexOf('--json-schema') + 1]).required.includes('more'));
  const clean = reviewerEnv({ ANTHROPIC_API_KEY: 'k', anthropic_base_url: 'u', CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 't', CLAUDE_CODE_OAUTH_TOKEN: 'keep', PATH: 'p' });
  assert.deepEqual(clean, { CLAUDE_CODE_OAUTH_TOKEN: 'keep', PATH: 'p', AIVERSE_LEARN_REVIEW: '1' });
  // the real child process: set in this process, absent in the reviewer
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-live-not-for-the-reviewer', ANTHROPIC_BASE_URL: 'https://example.invalid', CLAUDE_CODE_USE_VERTEX: '1' });
  try {
    chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
    warm();
    await drain(root);
  } finally {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX']) delete process.env[k];
  }
  const [call] = calls();
  assert.deepEqual(call.env, { AIVERSE_LEARN_REVIEW: '1' });
  assert.ok(call.argv.includes('--tools') && call.argv.includes('--max-budget-usd'));
  assert.equal(peek(root, 'SELECT n FROM ledger')[0].n, 1);
});

test('propose mode: nothing canonical is written; the proposal and the stored evidence carry the exact quote, the date, the scope and the source', async () => {
  const root = core();
  chat(root, [u(root, 'u1', 'Hello there. From now on never use exclamation marks. My goal is to launch my store by March.'), u(root, 'u2', 'Maybe I should start a podcast someday, not sure.')]);
  review([
    candidate('preference', 'Never use exclamation marks.', 'never use exclamation marks', 'o1', { category: 'avoid' }),
    candidate('goal', 'Launch my store by March.', 'launch my store by March', 'o1'),
    candidate('goal', 'Start a podcast.', 'start a podcast someday', 'o2'),
  ]);
  await drain(root);
  assert.equal(preferences(root).includes('exclamation'), false);
  assert.deepEqual(states(root), ['propose_mode', 'stored_unavailable', 'tentative']); // why each one is only a proposal
  const text = inboxText(root);
  assert.equal(inboxFiles(root).length, 3);
  assert.match(text, /You wrote on 2026-01-02: \\"never use exclamation marks\\"/);
  assert.match(text, /claude-code:/);
  const [first] = items(root);
  assert.deepEqual([first.body.quote, first.body.quote_abs, first.body.ts, first.body.scope, first.body.uuid, first.body.harness], ['never use exclamation marks', 'Hello there. From now on '.length, '2026-01-02T10:00:00.000Z', 'operator', 'u1', 'claude-code']);
  assert.equal(first.result.state, 'proposed');
  assert.deepEqual(peek(root, 'SELECT state, text, done_to, size FROM occurrences ORDER BY id').map((r) => [r.state, r.text]), [['done', null], ['done', null]]); // reviewed text is deleted
});

test('auto mode saves nothing yet: every automatic candidate waits as a proposal because the owners cannot refuse a stale write', async () => {
  const root = core();
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')], { mode: 'auto' });
  warm();
  await drain(root);
  assert.deepEqual(states(root), ['auto_blocked']);
  assert.equal(preferences(root).includes('warm tone'), false);
  assert.equal(inboxFiles(root).length, 1);
  for (const file of ['learn-common.mjs', 'learn-worker.mjs', 'ai_verse_learn_apply.py']) assert.equal(fs.readFileSync(path.join(REPO, 'scripts', file), 'utf8').includes('allow_unfenced_auto'), false);
});

test('the reviewers\' adversarial examples are only proposals or rejections; the credential never reaches the reviewer or any file', async () => {
  const root = core();
  chat(root, [
    u(root, 'u1', 'I always use British English rather than American English.'),
    u(root, 'u2', 'I no longer want short answers.'),
    u(root, 'u3', 'I want a short summary. Do not use bullet points.'),
    u(root, 'u4', 'My password is hunter2. Use hunter2 for signing in.'),
    u(root, 'u5', 'You always want detailed answers.'),
  ]);
  review([
    candidate('preference', 'I always use American English rather than British English.', 'I always use British English rather than American English.', 'o1'),
    candidate('preference', 'I want short answers.', 'I no longer want short answers.', 'o2'),
    candidate('preference', 'I want bullet points.', 'I want a short summary.', 'o3'),
    candidate('preference', 'You always want detailed answers.', 'You always want detailed answers.', 'o5'),
  ]);
  await drain(root);
  assert.deepEqual(states(root), ['not_verbatim', 'negation_mismatch', 'not_verbatim', 'competing']);
  assert.equal(calls().some((c) => c.prompt.includes('hunter2')), false);
  assert.equal(allText(root).includes('hunter2'), false);
  assert.equal(peek(root, "SELECT state FROM occurrences WHERE uuid = 'u4'")[0].state, 'excluded');
});

test('kill -9 at every point: the model, the owner and the inbox are each used exactly as often as the state allows, and nothing is lost', async (t) => {
  const plan = {
    after_reserve: { reviews: 1, why: 'killed before the reviewer was launched' },
    in_finish: { reviews: 2, why: 'the stored items and the reviewed marks are one transaction: both are rolled back' },
    after_finish: { reviews: 1, why: 'the stored items are resumed, never recomputed' },
    after_owner: { reviews: 1, why: 'the item is resumed' },
    after_item: { reviews: 1, why: 'complete' },
  };
  for (const [point, expected] of Object.entries(plan)) {
    await t.test(`${point}: ${expected.why}`, () => {
      const root = core();
      chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
      warm();
      const crashed = workerProcess(root, { AIVERSE_LEARN_CRASH: point });
      assert.ok(crashed.signal === 'SIGKILL' || crashed.status !== 0, `worker must die at ${point}`);
      timePasses(root);
      workerProcess(root);
      assert.equal(calls().length, expected.reviews);
      assert.equal(inboxFiles(root).length, 1);
      assert.deepEqual(items(root).map((i) => i.state), ['done']);
      assert.equal(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 0);
      workerProcess(root);
      assert.equal(calls().length, expected.reviews); // nothing is reviewed twice after completion
      assert.equal(inboxFiles(root).length, 1);
    });
  }
});

test('the review allowance is counted when reserved: a worker killed after reserving cannot be restarted into spending more than the cap', () => {
  const root = core({ max_reviews_per_session_per_day: 1 });
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  warm();
  const crashed = workerProcess(root, { AIVERSE_LEARN_CRASH: 'after_reserve' });
  assert.ok(crashed.signal === 'SIGKILL' || crashed.status !== 0);
  timePasses(root);
  workerProcess(root);
  workerProcess(root);
  assert.equal(calls().length, 0);
  assert.equal(peek(root, 'SELECT n FROM ledger')[0].n, 1);
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 1); // kept for tomorrow, not dropped
});

test('replacement and compaction: unread records are reviewed once whatever happens to the transcript afterwards', async (t) => {
  await t.test('the first records are kept and the unread fourth is replaced', async () => {
    const root = core();
    review([]);
    const s = chat(root, [assistantLine('h', 'opening record', root), u(root, 'a1', 'original message number one'), u(root, 'a2', 'original message number two'), u(root, 'a3', 'original unread message number three')], { event: 'precompact' });
    writeTranscript(s.transcript_path, [assistantLine('h', 'opening record', root), u(root, 'a1', 'original message number one'), u(root, 'a2', 'original message number two'), u(root, 'b3', 'replacement message number three')]);
    hookEvent(root, 'end', s);
    await drain(root);
    for (const m of ['original message number one', 'original message number two', 'original unread message number three', 'replacement message number three']) assert.equal(occurrences(m), 1, m);
  });
  await t.test('a replacement that keeps the same first line is not confused with the original', async () => {
    const root = core();
    review([]);
    const header = assistantLine('h', 'the same opening record in every version', root);
    const s = chat(root, [header, u(root, 'x1', 'original message number one'), u(root, 'x2', 'original message number two')], { event: 'precompact' });
    writeTranscript(s.transcript_path, [header, u(root, 'y1', 'rewritten message number one'), u(root, 'y2', 'rewritten message number two')]);
    hookEvent(root, 'end', s);
    await drain(root);
    for (const m of ['original message number one', 'original message number two', 'rewritten message number one', 'rewritten message number two']) assert.equal(occurrences(m), 1, m);
  });
  await t.test('a compaction summary written as a user record is not evidence; real messages around it are', async () => {
    const root = core();
    review([]);
    chat(root, [u(root, 'h1', 'real message before the summary'), JSON.stringify({ ...JSON.parse(u(root, 'c0', 'SUMMARY I always want pirate talk written by the harness')), isCompactSummary: true, isVisibleInTranscriptOnly: true, origin: undefined }), u(root, 'h2', 'real message after the summary')]);
    await drain(root);
    assert.equal(occurrences('SUMMARY'), 0);
    assert.equal(occurrences('real message before the summary') + occurrences('real message after the summary'), 2);
  });
  await t.test('older preference, then correction, then the compacted successor keep their order across a restart', async () => {
    const root = core({ window_chars: 1000 });
    review([]);
    const body = (w) => `${w} ${'word '.repeat(120)}`.trim();
    const s = chat(root, [assistantLine('h', 'opening record', root), u(root, 'o1', body('OLDPREFERENCE')), u(root, 'o2', body('CORRECTIONMESSAGE'))], { event: 'precompact' });
    writeTranscript(s.transcript_path, [u(root, 'c0', body('COMPACTEDSUCCESSOR'))]);
    hookEvent(root, 'end', s);
    const crashed = workerProcess(root, { AIVERSE_LEARN_CRASH: 'after_finish' });
    assert.ok(crashed.signal === 'SIGKILL' || crashed.status !== 0);
    timePasses(root);
    workerProcess(root);
    const order = ['OLDPREFERENCE', 'CORRECTIONMESSAGE', 'COMPACTEDSUCCESSOR'].map((w) => calls().findIndex((c) => (c.prompt.split('WHAT THE OPERATOR WROTE')[1] ?? '').includes(w)));
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
});

test('unknown scope is never copied anywhere global, whatever the kind of candidate; a member binds ONE item at a time, to a real workspace, against the revision it was shown at', async () => {
  const root = core();
  workspace(root, 'alpha');
  workspace(root, 'beta');
  fs.mkdirSync(path.join(root, 'workspaces', 'ghost'));
  const note = (n, w) => `${w} private budget note number ${n}: I always want a warm tone in client emails.`;
  const s = chat(root, [
    u(root, 'n1', note(1, 'Alpha'), null),
    u(root, 'g1', note(2, 'Beta'), path.join(root, 'workspaces', 'ghost')),
    u(root, 'r1', note(3, 'Alpha'), root),
    u(root, 'r2', 'In Project Beta we decided the launch is in June, which I will remember.', root),
    u(root, 'r3', 'Actually for Project Alpha I always want formal tone in client emails.', root),
  ]);
  review([candidate('preference', note(1, 'Alpha'), note(1, 'Alpha'), 'o1'), candidate('preference', note(2, 'Beta'), note(2, 'Beta'), 'o2')], '.unresolved');
  review([
    candidate('preference', note(3, 'Alpha'), note(3, 'Alpha'), 'o3', { scope_hint: 'project' }),
    candidate('memory', 'The launch of Project Beta is in June.', 'we decided the launch is in June', 'o4', { scope_hint: 'project', memory_type: 'event' }),
    candidate('preference', 'I always want formal tone in client emails.', 'for Project Alpha I always want formal tone in client emails.', 'o5', { scope_hint: 'project', replaces: 'I always want a warm tone in client emails.' }),
  ], '.operator');
  await drain(root);
  // preference, memory and correction alike are parked: none of them reached any inbox
  assert.deepEqual(items(root).map((i) => i.state), ['needs_scope', 'needs_scope', 'needs_scope', 'needs_scope', 'needs_scope']);
  assert.equal(inboxFiles(root).length + inboxFiles(root, 'workspaces/alpha/inbox').length + inboxFiles(root, 'workspaces/beta/inbox').length, 0);
  assert.equal(allText(path.join(root, 'operator')).includes('private budget'), false);
  // the member says which project: only the chosen items move, each against the revision it was shown at, with their words kept as evidence
  const db = await openStore(root);
  const all = items(root);
  const alpha = [all[0], all[2]].map((i) => ({ id: i.id, rev: i.rev }));
  assert.throws(() => bindItems(db, root, alpha, 'workspace:nowhere', 'it is Alpha'), /scope_binding_refused/);
  fs.mkdirSync(path.join(root, 'workspaces', 'gamma'));
  fs.writeFileSync(path.join(root, 'workspaces', 'gamma', 'WORKSPACE.yaml'), 'id: somebody-else\n');
  assert.throws(() => bindItems(db, root, alpha, 'workspace:gamma', 'it is Alpha'), /scope_binding_refused/); // a manifest must name itself
  assert.throws(() => bindItems(db, root, alpha, 'workspace:alpha', ''), /scope_binding_refused/); // and the member's words are required
  assert.deepEqual(bindItems(db, root, [{ id: all[0].id, rev: all[0].rev + 7 }], 'workspace:alpha', 'it is Alpha'), [{ id: all[0].id, bound: false }]); // a stale revision binds nothing
  assert.deepEqual(bindItems(db, root, alpha, 'workspace:alpha', 'these two were about Alpha').map((r) => r.bound), [true, true]);
  assert.deepEqual(bindItems(db, root, alpha, 'workspace:beta', 'oops').map((r) => r.bound), [false, false]); // already bound: no rebinding by mistake
  db.close();
  assert.deepEqual(items(root).map((i) => i.state), ['pending', 'needs_scope', 'pending', 'needs_scope', 'needs_scope']);
  await drain(root);
  assert.equal(inboxFiles(root, 'workspaces/alpha/inbox').length, 2);
  assert.equal(inboxFiles(root).length + inboxFiles(root, 'workspaces/beta/inbox').length, 0); // Beta's notes were never moved to Alpha, nor anywhere
  assert.equal(items(root)[0].body.binding.evidence, 'these two were about Alpha');
  assert.equal(calls().some((c) => c.prompt.includes('Conversation scope: workspace:beta')), false);
});

test('a message bound to a workspace by its cwd goes to that workspace inbox, never to the operator', async () => {
  const root = core();
  workspace(root, 'alpha');
  chat(root, [u(root, 'w1', 'Client Alpha: I always want blue headlines in every deck.', path.join(root, 'workspaces', 'alpha'))]);
  review([candidate('preference', 'I always want blue headlines in every deck.', 'I always want blue headlines in every deck.', 'o1', { scope_hint: 'project' })], '.workspace_alpha');
  await drain(root);
  assert.equal(inboxFiles(root, 'workspaces/alpha/inbox').length, 1);
  assert.equal(inboxFiles(root).length, 0);
  assert.equal(items(root)[0].result.reason, 'workspace');
});

test('a short instruction is evidence, and more than six statements in one window are all handled, none cut off', async () => {
  const root = core();
  const facts = Array.from({ length: 7 }, (_, i) => `I always want FACT${i + 1} notes.`).join(' ');
  chat(root, [u(root, 'u1', 'No emojis.'), u(root, 'u2', facts)]);
  process.env.FAKE_MODE = 'facts';
  review([candidate('preference', 'No emojis.', 'No emojis.', 'o1')]);
  await drain(root);
  process.env.FAKE_MODE = 'ok';
  const proposals = items(root).map((i) => i.body.statement);
  for (let i = 1; i <= 7; i += 1) assert.ok(proposals.includes(`I always want FACT${i} notes.`), `FACT${i}`);
  assert.equal(proposals.length, 7); // "No emojis." came from the fixed answer only when the fake was in facts mode: it asked nothing of it
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 0);
  assert.ok(calls().length >= 2); // a second round asked for what the first could not list
  const short = core();
  chat(short, [u(short, 'u1', 'No emojis.')]);
  review([candidate('preference', 'No emojis.', 'No emojis.', 'o1')]);
  await drain(short);
  assert.equal(items(short)[0].body.quote, 'No emojis.');
  assert.equal(items(short)[0].result.reason, 'not_durable');
});

test('a failed range is parked and retried; later ranges go on; pending evidence is never pruned; storage pressure is visible', async () => {
  const root = core({ window_chars: 1000 });
  const filler = (w) => `${w} ${'word '.repeat(170)}`.trim();
  chat(root, [u(root, 'a', filler('RANGEA')), u(root, 'b', filler('RANGEB'))]);
  review([]);
  process.env.FAKE_MODE = 'failonce';
  await drain(root);
  assert.deepEqual(peek(root, 'SELECT uuid, state, attempts FROM occurrences ORDER BY id').map((r) => `${r.uuid}:${r.state}:${r.attempts}`), ['a:pending:1', 'b:done:0']);
  mutate(root, 'UPDATE occurrences SET at = 1'); // ancient: pending evidence must still survive every cleanup
  await drain(root);
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 1);
  process.env.FAKE_MODE = 'ok';
  timePasses(root);
  await drain(root);
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 0);
  assert.equal(occurrences('RANGEA'), 2); // once failed, once reviewed
  // a reviewer that keeps failing never causes the evidence to be discarded: three failures file one note and it goes on
  const stuck = core({ window_chars: 1000 });
  chat(stuck, [u(stuck, 'a', filler('STUCK'))]);
  process.env.FAKE_MODE = 'fail';
  for (let i = 0; i < 4; i += 1) { await drain(stuck); timePasses(stuck); }
  process.env.FAKE_MODE = 'ok';
  assert.equal(peek(stuck, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 1);
  assert.equal(inboxFiles(stuck).length, 1);
  assert.match(inboxText(stuck), /could not be reviewed automatically \(reviewer_failed/);
  assert.equal(dumpDb(stuck).includes('SECRET-IN-STDERR') || allText(stuck).includes('SECRET-IN-STDERR'), false);
  review([]);
  await drain(stuck);
  assert.equal(peek(stuck, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 0);
  // storage pressure: more pending text than the configured room is reported, and nothing is evicted
  const full = core({ max_pending_mb: 1 });
  chat(full, [u(full, 'big', 'word '.repeat(210000))]);
  process.env.FAKE_MODE = 'quota';
  await drain(full);
  process.env.FAKE_MODE = 'ok';
  assert.equal(JSON.parse(fs.readFileSync(learnPaths(full).status, 'utf8')).code, 'storage_pressure');
  assert.equal(peek(full, "SELECT COUNT(*) AS n FROM occurrences WHERE state = 'pending'")[0].n, 1);
});

test('turning learning off quiesces it: nothing is written after the switch, nothing is lost, and re-enabling resumes', async () => {
  const root = core();
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  warm();
  process.env.FAKE_MODE = 'switchoff';
  const result = await drain(root);
  process.env.FAKE_MODE = 'ok';
  assert.equal(result.outcomes.at(-1).state, 'disabled');
  assert.equal(items(root).length, 0);
  assert.deepEqual(peek(root, 'SELECT state, done_to FROM occurrences').map((r) => [r.state, r.done_to]), [['pending', 0]]);
  assert.deepEqual(peek(root, 'SELECT n, cost FROM ledger').map((r) => r.n), [1]); // only the reservation made before the switch
  const frozen = dumpDb(root);
  assert.equal((await drain(root)).ran, false); // off: the whole worker is a no-op
  assert.equal(dumpDb(root), frozen);
  setMode(root, 'propose');
  await drain(root);
  assert.deepEqual(items(root).map((i) => i.state), ['done']);
  assert.equal(inboxFiles(root).length, 1);
});

test('a worker that lost its lease cannot apply anything', async () => {
  const root = core();
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  warm();
  process.env.FAKE_MODE = 'steal';
  const result = await drain(root);
  process.env.FAKE_MODE = 'ok';
  assert.equal(result.outcomes.at(-1).state, 'disabled');
  assert.equal(items(root).length, 0);
  assert.equal(inboxFiles(root).length, 0);
  mutate(root, 'DELETE FROM claims');
  await drain(root);
  assert.equal(inboxFiles(root).length, 1);
});

test('two real worker processes started together review a chat once', async () => {
  const root = core();
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  warm();
  process.env.FAKE_MODE = 'slow';
  const exits = await Promise.all([workerAsync(root), workerAsync(root)]);
  process.env.FAKE_MODE = 'ok';
  assert.ok(exits.every((e) => e.code === 0));
  assert.equal(calls().length, 1);
  assert.equal(inboxFiles(root).length, 1);
});

test('quota and a missing claude wait without spending attempts and without keeping any error text; a deferred chat waits within its horizon', async () => {
  const root = core();
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  review([]);
  process.env.FAKE_MODE = 'quota';
  assert.equal((await drain(root)).outcomes[0].code, 'quota_or_login');
  assert.deepEqual({ ...peek(root, 'SELECT blocked FROM sessions')[0] }, { blocked: 'quota_or_login' });
  assert.equal(peek(root, 'SELECT attempts FROM occurrences')[0].attempts, 0);
  process.env.FAKE_MODE = 'ok';
  const beyond = await run(root, { maxWaitMs: 10 * 60 * 1000, sleep: () => { throw new Error('must not sleep'); } });
  assert.deepEqual(beyond.outcomes, []);
  let slept = 0;
  await run(root, { sleep: async () => { slept += 1; setMode(root, 'off'); } }); // the default horizon covers the 30 minute wait
  assert.equal(slept, 1);
  setMode(root, 'propose', { claude_command: [path.join(root, 'no-such-claude')] });
  timePasses(root);
  assert.equal((await drain(root)).outcomes[0].code, 'claude_missing');
});

test('the real hook starts a real detached worker that finishes the review on its own, silently', async () => {
  const root = core();
  warm();
  const s = session(root);
  writeTranscript(s.transcript_path, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  const hook = spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-hook.mjs'), 'end'], { input: JSON.stringify(s), encoding: 'utf8', env: process.env });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout + hook.stderr, '');
  const done = () => { try { return fs.existsSync(learnPaths(root).db) && peek(root, "SELECT * FROM items WHERE state = 'done'").length > 0; } catch { return false; } };
  for (let i = 0; i < 150 && !done(); i += 1) await new Promise((r) => setTimeout(r, 200));
  assert.equal(inboxFiles(root).length, 1);
});

test('shipped Claude settings only wire the hooks; learning is dormant until configured', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  assert.equal('autoMemoryEnabled' in settings, false);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart', 'Stop']);
  for (const groups of Object.values(settings.hooks)) assert.match(groups[0].hooks[0].command, /scripts\/learn-hook\.mjs/);
  assert.ok(buildPrompt(REPO, 'operator', {}, [{ id: 'o1', text: 'hi' }]).includes('[o1] operator: hi'));
});

const goodItem = (extra = {}) => candidate('preference', 'I always want warm replies with the code zeta99 on top.', 'I always want warm replies with the code zeta99 on top.', 'o1', extra);

test('a credential found later withdraws proposals already filed: the inbox candidate and the stored request are redacted, nothing is recalled, and the gap is only the past', async () => {
  const root = core();
  const sentence = 'I always want warm replies with the code zeta99 on top.';
  chat(root, [u(root, 'u1', sentence)]);
  review([goodItem()]);
  await drain(root);
  assert.equal(inboxFiles(root).length, 1);
  assert.match(inboxText(root), /zeta99/);
  const [filed] = items(root);
  assert.equal(filed.state, 'done');
  assert.equal(filed.result.effect.scope, 'operator');
  assert.match(filed.result.receipt.path, /^operator\/inbox\/write-candidate-/); // the actual receipt of the inbox write is kept
  assert.ok(filed.result.receipt.command_id.startsWith('os_write_'));
  // another chat reveals that zeta99 is a password
  await capture(root, 'other-chat', [{ uuid: 'x1', text: 'My password is zeta99 by the way.' }]);
  assert.deepEqual(peek(root, 'SELECT state, body FROM items').map((r) => [r.state, r.body]), [['withdraw_pending', '{}']]); // out of reach at once
  await drain(root);
  assert.deepEqual(items(root).map((i) => i.state), ['withdrawn']);
  assert.equal(inboxText(root).includes('zeta99'), false);
  assert.match(inboxText(root), /Withdrawn: this proposal was removed/);
  assert.equal(allText(root).includes('zeta99'), false); // inbox, write-command queue, database, log
  await drain(root);
  assert.equal(inboxFiles(root).length, 1); // and nothing is filed again
});

// A capture in another process, finished before the call returns (the worker is synchronous, so a test seam cannot await).
const revealSync = (root) => {
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `import { openStore, ingestBatch } from './scripts/learn-store.mjs'; const db = await openStore(process.cwd()); ingestBatch(db, { key: 'kk', session_id: 'other', transcript_path: '/x', reason: 'session_end', at: Date.now(), config: { idle_seconds: 1, max_pending_turns: 6 }, records: [{ uuid: 'x1', seq: 0, ts: null, scope: 'operator', text: 'My password is zeta99 by the way.' }] }); db.close();`], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.equal(out.status, 0, out.stderr);
};

test('an item or a source excluded while the reviewer or the applier is running yields zero stale proposals', async () => {
  const sentence = 'I always want warm replies with the code zeta99 on top.';
  // (a) the source is excluded after the reviewer answered and before the answer is stored
  let root = core();
  chat(root, [u(root, 'u1', sentence)]);
  review([goodItem()]);
  await run(root, { drain: true, hooks: { afterReview: () => revealSync(root) } });
  assert.equal(items(root).length, 0);
  assert.equal(inboxFiles(root).length, 0);
  assert.equal(peek(root, "SELECT state FROM occurrences WHERE uuid = 'u1'")[0].state, 'excluded');
  // (b) the item is excluded while the applier is working on it, after its body was loaded
  root = core();
  chat(root, [u(root, 'u1', sentence)]);
  review([goodItem()]);
  await run(root, { drain: true, hooks: { beforeEffect: () => revealSync(root) } });
  assert.equal(inboxFiles(root).length, 0);
  assert.deepEqual(items(root).map((i) => i.state), ['excluded']);
  // (c) the credential is found after the proposal was filed: it is withdrawn (see the test above); here, while it is being filed
  root = core();
  chat(root, [u(root, 'u1', sentence)]);
  review([goodItem()]);
  await run(root, { drain: true });
  assert.equal(inboxFiles(root).length, 1);
  revealSync(root);
  await drain(root);
  assert.equal(inboxText(root).includes('zeta99'), false);
  assert.deepEqual(items(root).map((i) => i.state), ['withdrawn']);
});

test('a worker killed after claiming the effect and before filing it resumes and files exactly once', () => {
  const root = core();
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  warm();
  const crashed = workerProcess(root, { AIVERSE_LEARN_CRASH: 'after_claim' });
  assert.ok(crashed.signal === 'SIGKILL' || crashed.status !== 0);
  assert.deepEqual(items(root).map((i) => i.state), ['filing']);
  timePasses(root);
  workerProcess(root);
  assert.equal(inboxFiles(root).length, 1);
  assert.deepEqual(items(root).map((i) => i.state), ['done']);
  assert.equal(calls().length, 1);
});

test('a candidate repeating a known credential in ANY field is rejected, including a replacement that names it without its label', async () => {
  const root = core();
  await capture(root, 'earlier', [{ uuid: 'e1', text: 'My password is zeta99 by the way.' }]);
  chat(root, [u(root, 'u1', 'I always want a warm tone in client emails.')]);
  review([candidate('preference', 'I always want a warm tone in client emails.', 'I always want a warm tone in client emails.', 'o2', { replaces: 'I always want zeta99 in subjects.' })]);
  await drain(root);
  assert.equal(items(root).length, 0);
  assert.equal(peek(root, "SELECT n FROM counters WHERE code = 'rejected_secret_in_source'")[0].n, 1);
  assert.equal(allText(root).includes('zeta99'), false);
});

test('a continuation can never complete by repeating itself; rejected candidates are remembered and do not hold a page hostage', async () => {
  const facts = Array.from({ length: 7 }, (_, i) => `I always want FACT${i + 1} notes.`).join(' ');
  // page two repeats page one with more:true: nothing new, so the window is parked as a stalled continuation, its text kept
  let root = core();
  chat(root, [u(root, 'u1', facts)]);
  process.env.FAKE_MODE = 'repeat';
  await drain(root);
  process.env.FAKE_MODE = 'ok';
  assert.equal(peek(root, "SELECT state FROM occurrences")[0].state, 'pending');
  assert.equal(peek(root, 'SELECT code FROM failures')[0].code, 'reviewer_stalled');
  assert.equal(items(root).length, 6); // what was reported is kept
  // a first page of rejected candidates, then the real fact on the next page
  root = core();
  chat(root, [u(root, 'u1', 'I always want FACT1 notes.')]);
  process.env.FAKE_MODE = 'rejects';
  await drain(root);
  process.env.FAKE_MODE = 'ok';
  assert.deepEqual(items(root).map((i) => i.body.statement), ['I always want FACT1 notes.']);
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM seen_candidates")[0].n, 7); // the six rejected ones and the accepted one
  assert.equal(peek(root, "SELECT state FROM occurrences")[0].state, 'done');
  // seven facts, killed between the pages: the first page's items are already stored and the second page continues
  root = core();
  chat(root, [u(root, 'u1', facts)]);
  process.env.FAKE_MODE = 'facts';
  const crashed = workerProcess(root, { AIVERSE_LEARN_CRASH: 'in_finish' }); // dies while storing the FIRST page
  assert.ok(crashed.signal === 'SIGKILL' || crashed.status !== 0);
  timePasses(root);
  workerProcess(root);
  process.env.FAKE_MODE = 'ok';
  assert.equal(items(root).length, 7);
  assert.equal(peek(root, "SELECT state FROM occurrences")[0].state, 'done');
});

test('positions are UTF-16 code units end to end, the quote stays the operator\'s exact characters, and the real inbox receipt is kept', async () => {
  const root = core();
  const decomposed = 'Café \u{1F600} și țara: I always want warm replies.'; // decomposed e + accent, an emoji, Romanian letters
  chat(root, [u(root, 'u1', decomposed)]);
  const quote = 'I always want warm replies.';
  review([candidate('preference', quote, quote, 'o1')]);
  await drain(root);
  const [item] = items(root);
  assert.equal(item.body.quote_abs, decomposed.indexOf(quote)); // JS index: the emoji counts as two units
  assert.equal(item.body.quote_at, item.body.quote_abs);
  assert.equal(decomposed.slice(item.body.quote_abs, item.body.quote_abs + quote.length), quote);
  assert.ok(item.result.receipt.command_id);
  // a composed quote does not match decomposed text: it is not the operator's characters
  const other = core();
  chat(other, [u(other, 'u1', 'Café order: I always want warm replies.')]);
  review([candidate('preference', 'I always want a café order.', 'Café order: I always want warm replies.', 'o1')]);
  await drain(other);
  assert.equal(items(other).length, 0);
  assert.equal(peek(other, "SELECT n FROM counters WHERE code = 'rejected_quote_not_found'")[0].n, 1);
});

test('review follows source time, not arrival: records captured late are still reviewed in the order they were written', async () => {
  const root = core({ window_chars: 1000 });
  review([]);
  const body = (w) => `${w} ${'word '.repeat(170)}`.trim();
  await capture(root, 'chat', [{ uuid: 'new', ts: '2026-01-02T12:00:00.000Z', text: body('NEWERSTATEMENT') }]);
  await capture(root, 'chat', [{ uuid: 'old', ts: '2026-01-02T09:00:00.000Z', text: body('OLDERSTATEMENT') }]);
  await drain(root);
  const order = ['OLDERSTATEMENT', 'NEWERSTATEMENT'].map((w) => calls().findIndex((c) => shown(c).includes(w)));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(order[0] >= 0 && order[1] > order[0]);
});

test('the worker lease outlives the longest synchronous review, and the storage and runtime conditions are reported separately', async () => {
  const { leaseMs } = await import('./learn-worker.mjs');
  const root = core({ review_timeout_seconds: 600 });
  assert.ok(leaseMs(loadConfig(root)) > 600 * 1000);
  const { looksSynced, setStatus, sqliteTooOld } = await import('./learn-common.mjs');
  assert.deepEqual([looksSynced('/Users/a/Dropbox/Core'), looksSynced('/Users/a/Library/CloudStorage/OneDrive-X/Core'), looksSynced('/Users/a/Documents/Core')], [true, true, false]);
  assert.deepEqual([sqliteTooOld('3.50.4'), sqliteTooOld('3.51.2'), sqliteTooOld('3.51.3'), sqliteTooOld('3.53.0')], [true, true, false, false]);
  setStatus(root, 'storage_pressure');
  setStatus(root, 'capture_failed');
  setStatus(root, 'storage_pressure', false); // clearing one never clears the other
  assert.deepEqual(readStatus(root), ['capture_failed']);
  assert.equal(fs.readdirSync(learnPaths(root).base).some((n) => n.endsWith('.tmp')), false);
});

test('the test suite cannot reach the real reviewer: the stand-in heads the PATH and was never called', () => {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  assert.match(found.stdout.split('\n')[0], /aiverse-sentinel-/);
});
