#!/usr/bin/env node
// Worker end to end with a fake `claude`, the real python applier and the real profile owner and inbox boundary.
// Risky paths run for real: separate worker processes, kill -9 at named points, replaced transcripts, secrets inspected on disk.
// Brain and Memory are not installed in the temporary Core, so goals prove the "no owner means proposal" path.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { learnPaths, loadConfig } from './learn-common.mjs';
import { ingest, openStore } from './learn-store.mjs';
import { splitText } from './learn-window.mjs';
import { buildPrompt, reviewerArgs, run } from './learn-worker.mjs';
import { REPO } from './test-learn-support.mjs';
import {
  allText, appendTranscript, assistantLine, calls, candidate, core, dumpDb, hookEvent, inboxFiles, inboxText, mutate, peek, preferences, receipts,
  review, session, setMode, timePasses, userLine, workerAsync, workerProcess, workspace, writeTranscript,
} from './test-learn-support.mjs';

const drain = (root) => run(root, { drain: true });
const lines = (root, ...texts) => texts.map(([id, text, cwd]) => userLine(id, text, cwd === undefined ? root : cwd));
const CHAT = (root) => [
  userLine('u1', 'From now on never use exclamation marks. My goal is to launch my store by March.', root),
  assistantLine('a1', 'ok', root),
  userLine('u2', 'Maybe I should start a podcast someday, not sure.', root),
  userLine('u3', 'For this one email only, use bold headlines please.', root),
];
function chat(root, { mode = 'auto', id = 'session-1', event = 'end' } = {}) {
  const s = session(root, id);
  writeTranscript(s.transcript_path, CHAT(root));
  setMode(root, mode);
  hookEvent(root, event, s);
  return s;
}
const GOOD = () => review([
  candidate('preference', 'Never use exclamation marks.', 'never use exclamation marks'),
  candidate('goal', 'Launch my store by March.', 'launch my store by March'),
  candidate('goal', 'Start a podcast.', 'start a podcast someday', 'u2'),
  candidate('preference', 'Use bold headlines.', 'use bold headlines please', 'u3'),
]);

test('reviewer command has no tools, no hooks, no memory, no bare mode, a budget and a JSON schema', () => {
  const root = core();
  const args = reviewerArgs({ model: 'haiku', max_budget_usd: 0.15 }, fs.readFileSync(path.join(root, 'system/capabilities/learn/REVIEW-SCHEMA.json'), 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(!args.includes('--bare'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true, autoMemoryEnabled: false });
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.15');
  for (const flag of ['--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--json-schema']) assert.ok(args.includes(flag));
  assert.ok(buildPrompt(root, 'operator', {}, [{ id: 'u1', role: 'user', text: 'hi there friend' }]).includes('[u1] user: hi there friend'));
});

test('propose mode: nothing canonical is written; every candidate waits in the inbox with its exact quote and provenance', async () => {
  const root = core();
  chat(root, { mode: 'propose' });
  GOOD();
  const result = await drain(root);
  assert.equal(result.outcomes[0].state, 'reviewed');
  assert.equal(preferences(root).includes('exclamation'), false);
  const [receipt] = receipts(root);
  assert.deepEqual(receipt.results.map((r) => r.state), ['proposed', 'proposed', 'proposed', 'rejected']); // the one-off exception is dropped
  assert.equal(receipt.mode, 'propose');
  const text = inboxText(root);
  assert.equal(inboxFiles(root).length, 3);
  assert.match(text, /You wrote: \\"never use exclamation marks\\"/); // the inbox file is JSON
  assert.match(text, /claude-code:/);
  assert.ok(!JSON.stringify(receipt).includes('Launch my store')); // receipts hold no statements
});

test('auto mode: a new explicit preference is saved through the owner; a goal, a tentative idea and an exception are not', async () => {
  const root = core();
  chat(root);
  GOOD();
  await drain(root);
  assert.equal(preferences(root).match(/Never use exclamation marks\./g).length, 1);
  const [receipt] = receipts(root);
  assert.deepEqual(receipt.results.map((r) => [r.state, r.reason ?? null]), [['created', null], ['proposed', 'stored_unavailable'], ['proposed', 'tentative'], ['rejected', 'one_off_exception']]);
  assert.equal(inboxFiles(root).length, 2);
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM reviews')[0].n, 0);
  assert.equal(peek(root, 'SELECT due_at FROM sessions')[0].due_at, null);
  assert.equal(calls().length, 1);
  await drain(root); // nothing new: no second review
  assert.equal(calls().length, 1);
});

test('the reviewers\' own adversarial examples are held as proposals end to end; the hunter2 context is rejected and appears nowhere on disk', async () => {
  const root = core();
  const s = session(root);
  writeTranscript(s.transcript_path, [
    userLine('brit', 'Use British English rather than American English.', root),
    userLine('nolonger', 'I no longer want short answers.', root),
    userLine('bullets', 'I want a short summary. Do not use bullet points.', root),
    userLine('hunter', 'My password is hunter2. Use hunter2 for signing in.', root),
    userLine('ok', 'Please keep every paragraph concise, thanks.', root),
  ]);
  setMode(root, 'auto');
  hookEvent(root, 'end', s);
  review([
    candidate('preference', 'Use American English rather than British English.', 'Use British English rather than American English', 'brit', { category: 'communication' }),
    candidate('preference', 'I want short answers.', 'I no longer want short answers', 'nolonger', { category: 'communication' }),
    candidate('preference', 'I want bullet points.', 'I want a short summary', 'bullets', { category: 'communication' }),
    candidate('preference', 'Use hunter2 for signing in.', 'Use hunter2 for signing in', 'hunter'),
    candidate('preference', 'Keep every paragraph concise.', 'keep every paragraph concise', 'ok', { category: 'communication' }),
  ]);
  await drain(root);
  assert.deepEqual(receipts(root)[0].results.map((r) => [r.state, r.reason ?? null]),
    [['proposed', 'not_verbatim'], ['proposed', 'negation_mismatch'], ['proposed', 'not_verbatim'], ['rejected', 'secret_in_source'], ['created', null]]);
  assert.equal(preferences(root).includes('American English'), false);
  assert.equal(preferences(root).includes('hunter2'), false);
  assert.match(preferences(root), /Keep every paragraph concise\./); // the filter is not blind
  assert.equal(inboxFiles(root).length, 3);
  for (const where of [allText(path.join(root, 'operator')), allText(learnPaths(root).base), dumpDb(root)]) assert.equal(where.includes('hunter2'), false);
});

test('kill -9 at every point between owner write, item record, receipt/cursor and claim completion: replay is exactly once', async (t) => {
  for (const point of ['after_owner', 'after_item', 'in_finish', 'after_finish']) {
    await t.test(point, async () => {
      const root = core();
      chat(root);
      review([candidate('preference', 'Never use exclamation marks.', 'never use exclamation marks'), candidate('goal', 'Launch my store by March.', 'launch my store by March')]);
      const crashed = workerProcess(root, { AIVERSE_LEARN_CRASH: point });
      assert.ok(crashed.signal === 'SIGKILL' || crashed.status !== 0, `worker must die at ${point}`);
      timePasses(root); // the dead worker's leases run out
      workerProcess(root);
      assert.equal(preferences(root).match(/Never use exclamation marks\./g).length, 1);
      assert.equal(receipts(root).length, 1);
      assert.equal(receipts(root)[0].results.length, 2);
      assert.equal(inboxFiles(root).length, 1);
      assert.equal(peek(root, 'SELECT line FROM sources')[0].line, 4);
      assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM reviews')[0].n, 0);
      assert.equal(calls().length, 1, 'the model is asked once; the stored plan is resumed');
      workerProcess(root);
      assert.equal(receipts(root).length, 1);
      assert.equal(calls().length, 1);
    });
  }
});

const markersOnce = (markers) => {
  const prompts = calls().map((c) => c.prompt);
  for (const marker of markers) assert.equal(prompts.filter((p) => p.includes(marker)).length, 1, marker);
};

test('PreCompact keeps no copy of the transcript: a password in it appears nowhere on disk, and the unreviewed range is reviewed before compaction', async () => {
  const root = core();
  review([]);
  setMode(root, 'propose');
  const s = session(root);
  writeTranscript(s.transcript_path, [userLine('a1', 'My password is hunter2 and tool output says hunter2 too', root), assistantLine('a2', 'secret reply hunter2', root), userLine('a3', 'plain message number three here', root)]);
  hookEvent(root, 'precompact', s);
  assert.equal(allText(learnPaths(root).base).includes('hunter2'), false); // the event is a pointer, not a copy
  assert.equal(fs.existsSync(path.join(learnPaths(root).base, 'snapshots')), false);
  await drain(root); // the worker reviews the range right away (reason before_compaction), as the hook starts it
  assert.equal(calls().length, 1);
  for (const where of [allText(learnPaths(root).base), dumpDb(root), allText(path.join(root, 'operator'))]) assert.equal(where.includes('hunter2'), false);
});

test('compaction replaces the transcript BEFORE any drain: unread history is still reviewed once from a screened handoff, and a secret never reaches disk', async () => {
  const root = core();
  review([]);
  setMode(root, 'propose');
  const s = session(root);
  writeTranscript(s.transcript_path, [
    userLine('a1', 'old unread message number one', root),
    userLine('a2', 'My password is hunter2 so remember it', root),
    assistantLine('a3', 'assistant text that must not be kept hunter2', root),
    userLine('a4', 'old unread message number four', root),
  ]);
  hookEvent(root, 'precompact', s);
  writeTranscript(s.transcript_path, [userLine('b0', 'summary of the compacted conversation', root), userLine('b1', 'new message after compaction one', root)]);
  hookEvent(root, 'end', s);
  const handoffs = fs.readdirSync(path.join(learnPaths(root).base, 'handoff'));
  assert.equal(handoffs.length, 1);
  const kept = fs.readFileSync(path.join(learnPaths(root).base, 'handoff', handoffs[0]), 'utf8');
  assert.equal(kept.includes('hunter2') || kept.includes('assistant text'), false);
  assert.equal(allText(learnPaths(root).base).includes('hunter2'), false);
  await drain(root);
  markersOnce(['old unread message number one', 'old unread message number four', 'summary of the compacted', 'new message after compaction one']);
  assert.equal(calls().some((c) => c.prompt.includes('hunter2')), false);
  assert.equal(allText(learnPaths(root).base).includes('hunter2'), false);
  assert.ok(peek(root, 'SELECT code FROM failures').some((r) => r.code === 'handoff_used'));
  assert.equal(fs.readdirSync(path.join(learnPaths(root).base, 'handoff')).length, 0); // consumed
});

const handoffDir = (root) => path.join(learnPaths(root).base, 'handoff');

test('the handoff keeps only messages of a known scope: no cwd, an unmanifested folder and a cwd outside the Core are never written', () => {
  const root = core();
  workspace(root, 'alpha');
  fs.mkdirSync(path.join(root, 'workspaces', 'ghost'));
  setMode(root, 'propose');
  const s = session(root);
  writeTranscript(s.transcript_path, [
    userLine('o1', 'operator message that may be kept', root),
    userLine('w1', 'workspace alpha message that may be kept', path.join(root, 'workspaces', 'alpha')),
    userLine('n1', 'NOCWD message that must not be kept', null),
    userLine('g1', 'GHOST folder message that must not be kept', path.join(root, 'workspaces', 'ghost')),
    userLine('x1', 'OUTSIDE message that must not be kept', path.dirname(root)),
  ]);
  hookEvent(root, 'precompact', s);
  const text = fs.readFileSync(path.join(handoffDir(root), fs.readdirSync(handoffDir(root))[0]), 'utf8');
  assert.ok(text.includes('operator message') && text.includes('workspace alpha message'));
  for (const bad of ['NOCWD', 'GHOST', 'OUTSIDE']) assert.equal(text.includes(bad), false, bad);
});

test('adopting a handoff keeps the part offset: a partly reviewed long message is not replayed from its start', async () => {
  const root = core({ window_chars: 1000 });
  review([]);
  setMode(root, 'propose');
  const s = session(root);
  const big = ['LINEONE', 'LINETWO', 'LINETHREE', 'LINEFOUR'].map((w) => `${w} ${'word '.repeat(170)}`.trim()).join('\n');
  writeTranscript(s.transcript_path, [userLine('big', big, root), userLine('small', 'a small message after the big one', root)]);
  hookEvent(root, 'precompact', s);
  const db = await openStore(root);
  ingest(db, root); // registers the source and the handoff
  const { fp } = db.prepare('SELECT fp FROM sources').get();
  db.prepare('UPDATE sources SET line = 0, part = 2 WHERE fp = ?').run(fp); // parts 1 and 2 were already reviewed
  db.close();
  writeTranscript(s.transcript_path, [userLine('n0', 'a completely different transcript now', root)]);
  hookEvent(root, 'end', s);
  await drain(root);
  const prompts = calls().map((c) => c.prompt).join('\n');
  assert.ok(prompts.includes('LINETHREE') && prompts.includes('LINEFOUR') && prompts.includes('a small message after'));
  assert.equal(prompts.includes('LINEONE') || prompts.includes('LINETWO'), false);
});

test('a replacement that keeps the first line and is detected only by its first records still adopts the handoff at cursor 0', async () => {
  const root = core();
  review([]);
  setMode(root, 'propose');
  const s = session(root);
  const header = assistantLine('h', 'the same opening record in every version', root);
  writeTranscript(s.transcript_path, [header, userLine('x1', 'original message number one', root), userLine('x2', 'original message number two', root), userLine('x3', 'original message number three', root)]);
  hookEvent(root, 'precompact', s);
  writeTranscript(s.transcript_path, [header, userLine('y1', 'rewritten message number one', root), userLine('y2', 'rewritten message number two', root), userLine('y3', 'rewritten message number three', root)]);
  hookEvent(root, 'end', s);
  await drain(root);
  markersOnce(['original message number one', 'original message number two', 'original message number three', 'rewritten message number one', 'rewritten message number three']);
  assert.ok(peek(root, 'SELECT code FROM failures').some((r) => r.code === 'handoff_used'));
});

test('handoff housekeeping: caps by count (oldest first), drops stale temp files, runs even when learning is off, and frees a closed source', async () => {
  const root = core({ mode: 'off' });
  const dir = handoffDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 60; i += 1) {
    const f = path.join(dir, `k-${i}.jsonl`);
    fs.writeFileSync(f, '{}\n');
    const t = new Date(now - (100 - i) * 1000); // k-59 is the newest
    fs.utimesSync(f, t, t);
  }
  const tmp = path.join(dir, 'old.jsonl.tmp');
  fs.writeFileSync(tmp, 'x');
  const old = new Date(now - 3 * 3600 * 1000);
  fs.utimesSync(tmp, old, old);
  hookEvent(root, 'stop', session(root)); // mode off: still housekeeping
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 50);
  assert.ok(left.includes('k-59.jsonl') && !left.includes('k-0.jsonl') && !left.includes('old.jsonl.tmp'));
  // a handoff whose source is closed is deleted on the next ingest
  setMode(root, 'propose');
  const s = session(root);
  writeTranscript(s.transcript_path, [userLine('a1', 'message to hand over before compaction', root)]);
  hookEvent(root, 'precompact', s);
  const db = await openStore(root);
  ingest(db, root);
  const row = db.prepare('SELECT session, fp, path FROM handoffs').get();
  assert.ok(fs.existsSync(row.path));
  db.prepare('UPDATE sources SET closed = 1 WHERE session = ? AND fp = ?').run(row.session, row.fp);
  ingest(db, root);
  assert.equal(fs.existsSync(row.path), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM handoffs').get().n, 0);
  db.close();
});

test('a handoff that was not needed (transcript not replaced) does not cause a second review', async () => {
  const root = core();
  review([]);
  setMode(root, 'propose');
  const s = session(root);
  writeTranscript(s.transcript_path, [userLine('a1', 'message that stays in place one', root), userLine('a2', 'message that stays in place two', root)]);
  hookEvent(root, 'precompact', s);
  await drain(root);
  markersOnce(['stays in place one', 'stays in place two']);
  assert.equal(fs.readdirSync(path.join(learnPaths(root).base, 'handoff')).length, 0);
});

test('compaction: a replaced transcript is a new source; history reviewed before it is not repeated; later messages are reviewed once', async () => {
  const root = core();
  review([]);
  setMode(root, 'propose');
  const s = session(root);
  writeTranscript(s.transcript_path, [userLine('a1', 'old history message number one', root), userLine('a2', 'old history message number two', root)]);
  hookEvent(root, 'precompact', s);
  await drain(root);
  appendTranscript(s.transcript_path, [userLine('a3', 'old history message number three', root)]);
  hookEvent(root, 'precompact', s);
  await drain(root);
  writeTranscript(s.transcript_path, [userLine('b0', 'summary of the compacted conversation', root), ...['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => userLine(id, `new history message ${id} here`, root))]);
  hookEvent(root, 'stop', s);
  await drain(root);
  appendTranscript(s.transcript_path, [userLine('b6', 'new history message b6 after everything', root)]);
  hookEvent(root, 'end', s);
  await drain(root);
  markersOnce(['number one', 'number two', 'number three', 'summary of the compacted', 'message b1 here', 'message b5 here', 'message b6 after']);
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM sources WHERE closed = 1")[0].n, 1);
});

test('a replacement that keeps the first line is not stranded: the source restarts on what is there and says history was replaced', async () => {
  const root = core();
  review([]);
  setMode(root, 'propose');
  const s = session(root);
  const header = userLine('h', 'the same first line in every version', root);
  writeTranscript(s.transcript_path, [header, userLine('x1', 'original message number one', root), userLine('x2', 'original message number two', root)]);
  hookEvent(root, 'stop', s);
  await drain(root);
  writeTranscript(s.transcript_path, [header, userLine('y1', 'rewritten message number one', root), userLine('y2', 'rewritten message number two', root), userLine('y3', 'rewritten message number three', root)]);
  hookEvent(root, 'stop', s);
  await drain(root);
  markersOnce(['original message number one', 'rewritten message number one', 'rewritten message number two', 'rewritten message number three']);
  assert.deepEqual(peek(root, 'SELECT code FROM failures').map((r) => r.code), ['history_replaced']);
  assert.equal(peek(root, 'SELECT line, closed FROM sources')[0].line, 4);
  assert.equal(peek(root, 'SELECT closed FROM sources')[0].closed, 0);
});

test('assistant text from another scope never joins an operator window (and the other way round)', async () => {
  const root = core();
  workspace(root, 'alpha');
  const alpha = path.join(root, 'workspaces', 'alpha');
  const s = session(root);
  writeTranscript(s.transcript_path, [
    userLine('o1', 'From now on never use exclamation marks please.', root),
    assistantLine('a1', 'ALPHA-CONFIDENTIAL plan details from the workspace', alpha),
    userLine('w1', 'Client Alpha likes blue headlines in every deck.', alpha),
    assistantLine('a2', 'OPERATOR-ONLY answer text', root),
    assistantLine('a3', 'NOCWD answer text', null),
  ]);
  setMode(root, 'propose');
  hookEvent(root, 'end', s);
  review([]);
  await drain(root);
  const [operatorPrompt, alphaPrompt] = calls().map((c) => c.prompt.split('CONVERSATION WINDOW')[1]);
  assert.equal(operatorPrompt.includes('ALPHA-CONFIDENTIAL'), false);
  assert.equal(alphaPrompt.includes('ALPHA-CONFIDENTIAL') || alphaPrompt.includes('OPERATOR-ONLY') || alphaPrompt.includes('NOCWD'), false);
  assert.ok(operatorPrompt.includes('never use exclamation') && alphaPrompt.includes('blue headlines'));
});

test('a session moving between the operator, a workspace, an unmanifested folder and no cwd keeps each scope apart; nothing is promoted', async () => {
  const root = core();
  workspace(root, 'alpha');
  fs.mkdirSync(path.join(root, 'workspaces', 'ghost'));
  const s = session(root);
  writeTranscript(s.transcript_path, [
    userLine('w1', 'Client Alpha likes blue headlines in every deck.', path.join(root, 'workspaces', 'alpha')),
    userLine('n1', 'Remember that Bob prefers phone calls on Fridays.', null),
    userLine('g1', 'Ghost folder keeps its own notes in red ink.', path.join(root, 'workspaces', 'ghost')),
    userLine('o1', 'From now on never use exclamation marks please.', root),
    userLine('n2', 'Another message with no cwd that mentions Bob again.', null),
  ]);
  setMode(root, 'auto');
  hookEvent(root, 'end', s);
  review([candidate('preference', 'Client Alpha likes blue headlines.', 'likes blue headlines in every deck', 'w1', { scope_hint: 'workspace' })], '.workspace_alpha');
  review([candidate('preference', 'Bob prefers phone calls on Fridays.', 'Bob prefers phone calls on Fridays', 'n1', { scope_hint: 'workspace' })], '.unscoped');
  review([candidate('preference', 'Never use exclamation marks.', 'never use exclamation marks please', 'o1')], '.operator');
  await drain(root);
  const scopes = receipts(root).map((r) => r.scope);
  assert.deepEqual(scopes, ['workspace:alpha', 'unscoped', 'operator', 'unscoped']);
  assert.equal(preferences(root).includes('blue'), false);
  assert.equal(preferences(root).includes('Bob'), false);
  assert.match(preferences(root), /exclamation/);
  assert.equal(inboxFiles(root, 'workspaces/alpha/inbox').length, 1);
  assert.match(inboxText(root), /Bob prefers phone calls on Fridays/); // unscoped: proposal in the operator inbox, never saved
  assert.match(inboxText(root), /not clear which workspace/);
  assert.equal(calls().some((c) => c.prompt.includes('Conversation scope: operator') && /Bob|blue/.test(c.prompt.split('CONVERSATION WINDOW')[1])), false);
});

test('a long message is continued in following windows, never cut; a candidate from its last part is proposed', async () => {
  const root = core({ window_chars: 5000 });
  const sentences = Array.from({ length: 300 }, (_, i) => `Sentence number ${i} is here.`);
  sentences.push('My goal is to finish the long migration by June.');
  const long = sentences.join(' ');
  const parts = splitText(long, 5000);
  const s = session(root);
  writeTranscript(s.transcript_path, [userLine('big', long, root), userLine('after', 'A normal message that follows the long one.', root)]);
  setMode(root, 'auto');
  hookEvent(root, 'end', s);
  review([candidate('goal', 'Finish the long migration by June.', 'My goal is to finish the long migration by June', `big#${parts.length}`)]);
  await drain(root);
  const prompts = calls().map((c) => c.prompt).join('\n');
  assert.ok(calls().length >= parts.length);
  assert.ok(prompts.includes('Sentence number 0 is'));
  assert.ok(prompts.includes('Sentence number 299 is'));
  assert.ok(prompts.includes('A normal message that follows'));
  assert.match(inboxText(root), /finish the long migration by June/);
  assert.equal(peek(root, 'SELECT line, part FROM sources')[0].line, 2);
});

test('a changed model answer on retry changes nothing: the screened plan is stored first and re-presented', async () => {
  const root = core();
  chat(root, { mode: 'propose' });
  review([candidate('goal', 'Launch my store by March.', 'launch my store by March')]);
  fs.rmSync(path.join(root, 'operator', 'inbox'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'operator', 'inbox'), 'a file where the inbox folder should be');
  const first = await drain(root);
  assert.equal(first.outcomes[0].state, 'waiting');
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM reviews')[0].n, 1);
  assert.equal(peek(root, 'SELECT line FROM sources')[0].line, 0); // cursor did not move
  fs.rmSync(path.join(root, 'operator', 'inbox'));
  review([]); // a different answer now
  timePasses(root);
  await drain(root);
  assert.match(inboxText(root), /Launch my store by March/);
  assert.equal(calls().length, 1);
  assert.equal(receipts(root).length, 1);
});

test('a terminal failure on one range files a content-free note, moves past it, and the rest of the chat is still reviewed', async () => {
  const root = core({ window_chars: 3000 });
  const filler = (word) => `${word} `.repeat(400).trim();
  const s = session(root);
  writeTranscript(s.transcript_path, ['one', 'two', 'three'].map((w) => userLine(`m-${w}`, `${filler(w)}.`, root)));
  setMode(root, 'propose');
  hookEvent(root, 'end', s);
  review([]);
  process.env.FAKE_MODE = 'fail';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await drain(root);
    timePasses(root);
  }
  assert.equal(calls().length, 4); // three tries on the first range, then the second range starts on its own
  assert.ok(calls().slice(0, 3).every((c) => c.prompt.includes('one one one')));
  assert.ok(calls()[3].prompt.includes('two two two'));
  assert.match(inboxText(root), /could not be reviewed automatically \(reviewer_failed/);
  assert.deepEqual(peek(root, 'SELECT code FROM failures').map((r) => r.code), ['reviewer_failed']);
  process.env.FAKE_MODE = 'ok';
  await drain(root);
  timePasses(root);
  await drain(root);
  const later = calls().slice(4).map((c) => c.prompt);
  assert.equal(later.length, 2);
  assert.ok(later[0].includes('two two two') && later[1].includes('three three three'));
  assert.equal(later.some((p) => p.includes('one one one')), false);
  for (const where of [dumpDb(root), allText(path.join(root, 'operator')), allText(learnPaths(root).base)]) assert.equal(where.includes('SECRET-IN-STDERR'), false);
});

test('turning the mode off stops the work before the first write and before any inbox item; turning it back on resumes the stored plan', async () => {
  const root = core();
  chat(root);
  GOOD();
  process.env.FAKE_MODE = 'switchoff';
  const result = await drain(root);
  assert.equal(result.outcomes[0]?.state ?? 'disabled', 'disabled');
  assert.equal(preferences(root).includes('exclamation'), false);
  assert.equal(inboxFiles(root).length, 0);
  assert.equal(receipts(root).length, 0);
  process.env.FAKE_MODE = 'ok';
  setMode(root, 'propose'); // back on, but only proposing
  await drain(root);
  assert.equal(preferences(root).includes('exclamation'), false); // the stored plan now runs under the CURRENT mode
  assert.equal(inboxFiles(root).length, 3);
  assert.equal(calls().length, 1);
});

test('a worker that lost its claim to a takeover cannot apply anything', async () => {
  const root = core();
  chat(root);
  GOOD();
  process.env.FAKE_MODE = 'steal';
  const result = await drain(root);
  assert.equal(result.outcomes[0].state, 'lost');
  assert.equal(preferences(root).includes('exclamation'), false);
  assert.equal(receipts(root).length, 0);
  process.env.FAKE_MODE = 'ok';
  mutate(root, 'DELETE FROM claims');
  await drain(root);
  assert.equal(preferences(root).match(/Never use exclamation marks\./g).length, 1);
});

test('two real worker processes started together review a chat once', async () => {
  const root = core();
  chat(root);
  GOOD();
  process.env.FAKE_MODE = 'slow';
  const exits = await Promise.all([workerAsync(root), workerAsync(root)]);
  assert.ok(exits.every((e) => e.code === 0));
  assert.equal(calls().length, 1);
  assert.equal(receipts(root).length, 1);
  assert.equal(preferences(root).match(/Never use exclamation marks\./g).length, 1);
});

test('quota and a missing claude wait without spending attempts and without keeping any error text', async () => {
  const root = core();
  chat(root);
  review([]);
  process.env.FAKE_MODE = 'quota';
  assert.equal((await drain(root)).outcomes[0].code, 'quota_or_login');
  assert.deepEqual({ ...peek(root, 'SELECT attempts, blocked FROM sessions')[0] }, { attempts: 0, blocked: 'quota_or_login' });
  process.env.FAKE_MODE = 'ok';
  setMode(root, 'auto', { claude_command: [path.join(root, 'no-such-claude')] });
  timePasses(root);
  assert.equal((await drain(root)).outcomes[0].code, 'claude_missing');
  assert.equal(peek(root, 'SELECT attempts FROM sessions')[0].attempts, 0);
});

test('a deferred chat: the worker waits for it up to its horizon, and leaves it for the next hook beyond that', async () => {
  const root = core();
  chat(root);
  review([]);
  process.env.FAKE_MODE = 'quota';
  await drain(root);
  process.env.FAKE_MODE = 'ok';
  const beyond = await run(root, { maxWaitMs: 10 * 60 * 1000, sleep: () => { throw new Error('must not sleep'); } });
  assert.deepEqual(beyond.outcomes, []);
  let slept = 0;
  await run(root, { sleep: async () => { slept += 1; setMode(root, 'off'); } }); // default horizon covers the 30 minute wait
  assert.equal(slept, 1);
  assert.equal(calls().length, 1);
});

test('shipped Claude settings: the hooks are wired and built-in memory is not switched off while learning is dormant', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
  assert.equal('autoMemoryEnabled' in settings, false);
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['PreCompact', 'SessionEnd', 'SessionStart', 'Stop']);
  for (const groups of Object.values(settings.hooks)) assert.match(groups[0].hooks[0].command, /scripts\/learn-hook\.mjs/);
});

test('numeric settings are bounded and old event files are pruned', async () => {
  const root = core({ window_chars: 0, idle_seconds: -5, max_budget_usd: 99, review_timeout_seconds: 'x' });
  const config = loadConfig(root);
  assert.deepEqual([config.window_chars, config.idle_seconds, config.max_budget_usd, config.review_timeout_seconds], [1000, 0, 2, 120]);
  const { spool } = learnPaths(root);
  fs.mkdirSync(path.join(spool, 'bad'), { recursive: true });
  const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  for (const name of ['a.tmp', 'b.json', 'bad/c.json']) { fs.writeFileSync(path.join(spool, name), '{}'); fs.utimesSync(path.join(spool, name), old, old); }
  fs.writeFileSync(path.join(spool, 'fresh.tmp'), 'x');
  chat(root);
  review([]);
  await drain(root);
  assert.deepEqual(fs.readdirSync(spool).filter((n) => n !== 'bad').sort(), ['fresh.tmp']);
  assert.deepEqual(fs.readdirSync(path.join(spool, 'bad')), []);
});

test('the real hook starts a real detached worker that finishes the review on its own', async () => {
  const root = core();
  review([candidate('preference', 'Never use exclamation marks.', 'never use exclamation marks')]);
  const s = session(root);
  writeTranscript(s.transcript_path, CHAT(root));
  const hook = spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-hook.mjs'), 'end'], { input: JSON.stringify(s), encoding: 'utf8', env: process.env });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout + hook.stderr, '');
  const done = () => { try { return fs.existsSync(learnPaths(root).db) && peek(root, 'SELECT * FROM receipts').length > 0; } catch { return false; } }; // the worker may hold the database
  for (let i = 0; i < 150 && !done(); i += 1) await new Promise((r) => setTimeout(r, 200));
  assert.match(preferences(root), /Never use exclamation marks\./);
});
