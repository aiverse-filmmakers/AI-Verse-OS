#!/usr/bin/env node
// The inbox dependency under crashes: the write command and its receipt are created in separate steps. A process killed before ANY of
// the durable steps must leave a state the next attempt completes, with exactly one inbox item and a completed receipt. Also the
// withdrawal route used when a credential is found in a filed proposal.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { submitInbox } from './learn-worker.mjs';
import { computeWriteCommandFingerprint, dispatchWriteCommand, enqueueWriteCommand, submitWriteCommand, withdrawCandidate } from './write-command.mjs';
import { core, inboxFiles, inboxText, tempDir } from './test-learn-support.mjs';

const ITEM = { candidate_kind: 'claude-code-learning-proposal', summary: 'Proposed: I always want warm replies.', refs: ['claude-code:k:u1'] };
const queue = (root) => path.join(root, 'runtime', 'write-commands');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// A child that performs the submission and is killed (SIGKILL) just BEFORE its n-th durable step (a link or a rename in the
// write-command runtime or the inbox).
function submitKilledAt(root, n) {
  const script = `import fs from 'node:fs';
    let seen = 0;
    for (const name of ['linkSync', 'renameSync']) { const real = fs[name]; fs[name] = (...a) => { if (/write-commands|inbox/.test(String(a[1])) && ++seen === ${n}) process.kill(process.pid, 'SIGKILL'); return real(...a); }; }
    const { submitInbox } = await import('./scripts/learn-worker.mjs');
    submitInbox(process.cwd(), 'operator', ${JSON.stringify(ITEM)}, 'abc');`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
}

test('a kill before each durable step of an inbox write leaves a state the next attempt completes: one item, a completed receipt, any number of retries', async (t) => {
  const seams = ['before the command is created', 'after the command, before its receipt', 'after the receipt, before the inbox item', 'after the inbox item, before the receipt is completed', 'after the receipt is completed, before the command is'];
  for (const [i, seam] of seams.entries()) {
    await t.test(seam, () => {
      const root = core();
      const killed = submitKilledAt(root, i + 1);
      assert.ok(killed.signal === 'SIGKILL' || killed.status !== 0, `the child must die ${seam}`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const done = submitInbox(root, 'operator', ITEM, 'abc');
        assert.equal(done.ok, true);
        assert.match(done.receipt.path, /^operator\/inbox\/write-candidate-/);
      }
      assert.equal(inboxFiles(root).length, 1);
      const [receipt] = fs.readdirSync(path.join(queue(root), 'receipts')).map((n) => read(path.join(queue(root), 'receipts', n)));
      assert.equal(receipt.status, 'completed');
      assert.equal(fs.readdirSync(path.join(queue(root), 'queue')).filter((n) => n.endsWith('.json') && !n.startsWith('.')).length, 1);
      assert.equal(read(path.join(queue(root), 'queue', fs.readdirSync(path.join(queue(root), 'queue')).find((n) => n.endsWith('.json')))).status, 'completed');
    });
  }
});

test('a surviving command or receipt must still be bound to the same request: a different request under the same key is refused', () => {
  const root = core();
  assert.equal(submitInbox(root, 'operator', ITEM, 'abc').ok, true);
  assert.equal(submitInbox(root, 'operator', { ...ITEM, summary: 'Proposed: something else entirely.' }, 'abc').ok, false); // same key, other content
  for (const dir of ['queue', 'receipts']) fs.rmSync(path.join(queue(root), dir, fs.readdirSync(path.join(queue(root), dir)).find((n) => n.endsWith('.json'))));
  assert.equal(submitInbox(root, 'operator', ITEM, 'abc').ok, true); // both halves gone, the inbox item stays the single one
  assert.equal(inboxFiles(root).length, 1);
});


// -- withdrawal --------------------------------------------------------------------------------------------------------------
const SECRET = 'Proposed: use zeta99 always.';
const ARGS = (root) => ({ osRoot: root, scope: 'operator', idempotency_key: 'learn_abc' });
const requestFor = (item, requestedBy = 'ai-verse-os.auto-learning', idempotency = 'abc') => {
  const request = {
    schema_version: '1.0', request_id: `learn_${idempotency}`, scope: 'operator', operation: 'candidate.route',
    parameters: { candidate_kind: item.candidate_kind, summary: item.summary, refs: item.refs ?? [] }, idempotency_key: `learn_${idempotency}`,
    requested_by: requestedBy, reason: 'Keep an automatic learning proposal for the member to approve, instead of saving or losing it.', created_at: new Date(0).toISOString(),
  };
  request.request_fingerprint = computeWriteCommandFingerprint(request);
  return request;
};
// everything the write-command owner and the inbox hold, byte for byte, temporary files and dot-files included
const everything = (root) => ['operator', 'runtime'].map((d) => { const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name), 'utf8'))).join('') : ''); return walk(path.join(root, d)); }).join('');
const leaked = (root) => everything(root).includes('zeta99');
const secretItem = { ...ITEM, summary: SECRET };

test('withdrawal is terminal: before dispatch, during dispatch and after completion the content is gone and no retry brings it back', () => {
  // before dispatch
  let root = core();
  const request = requestFor(secretItem);
  enqueueWriteCommand({ osRoot: root, request });
  assert.equal(withdrawCandidate(ARGS(root)).state, 'withdrawn');
  const late = dispatchWriteCommand({ osRoot: root, request });
  assert.equal(late.status, 'withdrawn');
  assert.equal(inboxFiles(root).length, 0);
  assert.equal(leaked(root), false);
  assert.equal(submitWriteCommand({ osRoot: root, request }).status, 'withdrawn'); // enqueue refuses too
  assert.equal(enqueueWriteCommand({ osRoot: root, request }).status, 'withdrawn');
  assert.throws(() => enqueueWriteCommand({ osRoot: root, request: requestFor({ ...secretItem, summary: 'something else' }) }), /different write command/); // same key, other content
  // during dispatch: the withdrawal lands right after the candidate was created
  root = core();
  const real = fs.linkSync;
  let fired = false;
  fs.linkSync = (from, to) => {
    real(from, to);
    if (!fired && /write-candidate-/.test(String(to))) { fired = true; withdrawCandidate(ARGS(root)); }
  };
  try {
    assert.equal(submitWriteCommand({ osRoot: root, request: requestFor(secretItem) }).status, 'withdrawn');
  } finally {
    fs.linkSync = real;
  }
  assert.ok(fired);
  assert.equal(leaked(root), false);
  // after completion
  root = core();
  assert.equal(submitInbox(root, 'operator', secretItem, 'abc').ok, true);
  assert.match(inboxText(root), /zeta99/);
  assert.equal(withdrawCandidate(ARGS(root)).state, 'withdrawn');
  assert.equal(withdrawCandidate(ARGS(root)).state, 'withdrawn'); // idempotent
  assert.equal(withdrawCandidate({ ...ARGS(root), idempotency_key: 'learn_unknown' }).state, 'absent');
  assert.equal(leaked(root), false);
  assert.equal(submitInbox(root, 'operator', secretItem, 'abc').ok, true); // replaying the old request does not bring it back
  assert.equal(inboxFiles(root).length, 1);
  assert.equal(leaked(root), false);
  // the authoritative outcome says so, and the redacted request no longer pretends to match its fingerprint
  const [receipt] = fs.readdirSync(path.join(queue(root), 'receipts')).filter((n) => !n.startsWith('.')).map((n) => read(path.join(queue(root), 'receipts', n)));
  assert.deepEqual([receipt.status, receipt.result.queue_state, receipt.result.redacted], ['withdrawn', 'withdrawn', true]);
  const [command] = fs.readdirSync(path.join(queue(root), 'queue')).filter((n) => !n.startsWith('.')).map((n) => read(path.join(queue(root), 'queue', n)));
  assert.deepEqual([command.status, command.redacted, 'request' in command], ['withdrawn', true, false]);
  assert.equal(read(path.join(root, 'operator', 'inbox', inboxFiles(root)[0])).candidate.redacted, true);
});

test('a kill before each durable step of a withdrawal leaves nothing readable and the next attempt finishes it', async (t) => {
  let died = 0;
  for (let n = 1; n <= 9; n += 1) {
    await t.test(`killed before durable step ${n}`, () => {
      const root = core();
      assert.equal(submitInbox(root, 'operator', secretItem, 'abc').ok, true);
      const script = `import fs from 'node:fs';
        let seen = 0;
        for (const name of ['linkSync', 'renameSync', 'rmSync']) { const real = fs[name]; fs[name] = (...a) => { if (/write-commands|inbox/.test(String(a[name === 'rmSync' ? 0 : 1])) && ++seen === ${n}) process.kill(process.pid, 'SIGKILL'); return real(...a); }; }
        const { withdrawCandidate } = await import('./scripts/write-command.mjs');
        withdrawCandidate(${JSON.stringify(ARGS(root))});`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
      if (run.signal === 'SIGKILL' || run.status !== 0) died += 1;
      // after the kill: whatever was done, the next attempt (or any dispatch/enqueue) finishes it
      assert.equal(withdrawCandidate(ARGS(root)).state, 'withdrawn');
      assert.equal(leaked(root), false, `step ${n}`);
      assert.equal(submitInbox(root, 'operator', secretItem, 'abc').ok, true);
      assert.equal(leaked(root), false);
      assert.equal(inboxFiles(root).length, 1);
    });
  }
  assert.ok(died >= 5, `the withdrawal was interrupted at only ${died} steps`);
});

test('payload copies left by a killed write are owned: swept by the withdrawal, and orphans are swept later', () => {
  const root = core();
  // killed just before the candidate is linked into the inbox: the complete payload sits in the runtime tmp folder
  const script = `import fs from 'node:fs';
    const real = fs.linkSync; fs.linkSync = (from, to) => { if (/write-candidate-/.test(String(to))) process.kill(process.pid, 'SIGKILL'); return real(from, to); };
    const { submitInbox } = await import('./scripts/learn-worker.mjs');
    submitInbox(process.cwd(), 'operator', ${JSON.stringify(secretItem)}, 'abc');`;
  spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const tmp = path.join(queue(root), 'tmp');
  assert.ok(fs.readdirSync(tmp).some((n) => n.startsWith('.write-candidate-')));
  assert.match(everything(root), /zeta99/); // the leftover really holds the text
  assert.equal(withdrawCandidate(ARGS(root)).state, 'withdrawn');
  assert.equal(leaked(root), false);
  assert.deepEqual(fs.readdirSync(tmp), []);
  // an orphan nobody withdrew is swept once it is certainly dead
  const orphan = path.join(tmp, '.old-orphan.json.1.abcd.new');
  fs.writeFileSync(orphan, 'zeta99 stale');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(orphan, old, old);
  submitInbox(root, 'operator', ITEM, 'other');
  assert.equal(fs.existsSync(orphan), false);
});

test('only the learning pipeline\'s own plain proposals can be withdrawn: another owner\'s record and a promoted one are refused untouched', () => {
  let root = core();
  submitWriteCommand({ osRoot: root, request: requestFor(secretItem, 'ai-verse-os.someone-else') });
  assert.throws(() => withdrawCandidate(ARGS(root)), (error) => error.exitCode === 6);
  assert.match(inboxText(root), /zeta99/);
  root = core();
  assert.equal(submitInbox(root, 'operator', secretItem, 'abc').ok, true);
  const file = path.join(root, 'operator', 'inbox', inboxFiles(root)[0]);
  fs.writeFileSync(file, JSON.stringify({ ...read(file), status: 'classified', promotion_occurred: true }));
  assert.throws(() => withdrawCandidate(ARGS(root)), (error) => error.exitCode === 6);
  assert.match(inboxText(root), /zeta99/);
  root = core();
  submitInbox(root, 'operator', { ...ITEM, candidate_kind: 'claude-code-learning-failed' }, 'abc'); // another kind of learning record
  assert.throws(() => withdrawCandidate(ARGS(root)), (error) => error.exitCode === 6);
});
