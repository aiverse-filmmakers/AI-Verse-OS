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
import { withdrawCandidate } from './write-command.mjs';
import { core, inboxFiles, inboxText } from './test-learn-support.mjs';

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

test('withdrawal redacts the routed candidate and the stored request, only for candidates this pipeline routed, and is idempotent', () => {
  const root = core();
  assert.equal(submitInbox(root, 'operator', { ...ITEM, summary: 'Proposed: use zeta99 always.' }, 'abc').ok, true);
  assert.match(inboxText(root), /zeta99/);
  const args = { osRoot: root, scope: 'operator', idempotency_key: 'learn_abc', requested_by: 'ai-verse-os.auto-learning' };
  assert.throws(() => withdrawCandidate({ ...args, requested_by: 'someone-else' }), /requesting owner/);
  assert.equal(inboxText(root).includes('zeta99'), true); // a foreign requester withdrew nothing
  assert.equal(withdrawCandidate(args).state, 'withdrawn');
  assert.equal(withdrawCandidate(args).state, 'withdrawn');
  assert.equal(withdrawCandidate({ ...args, idempotency_key: 'learn_unknown' }).state, 'absent');
  const everything = ['operator', 'runtime'].map((d) => { const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : fs.readFileSync(path.join(dir, e.name), 'utf8'))).join(''); return walk(path.join(root, d)); }).join('');
  assert.equal(everything.includes('zeta99'), false);
  assert.equal(submitInbox(root, 'operator', { ...ITEM, summary: 'Proposed: use zeta99 always.' }, 'abc').ok, true); // replaying the old request does not bring it back
  assert.equal(inboxText(root).includes('zeta99'), false);
});
