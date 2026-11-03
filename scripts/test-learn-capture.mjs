#!/usr/bin/env node
// Capture: what counts as a human statement (against sanitized real record shapes), streaming, secrets across messages, scope
// binding, dormancy, and every durable-write boundary of the hook under injected faults. Needs Node 22.13+ (node:sqlite).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { learnPaths, listEnvelopes, removeEnvelope, sessionKey, sha, writeEnvelope } from './learn-common.mjs';
import { humanRecord, scanTranscript, secretValues, tokensOf } from './learn-capture.mjs';
import { handleEvent } from './learn-hook.mjs';
import { ingestEnvelopes, openStore } from './learn-store.mjs';
import { run } from './learn-worker.mjs';
import {
  REPO, allText, appendTranscript, assistantLine, calls, core, dumpDb, hookEvent, occurrences, peek, review, session, setMode, userLine, workspace, writeTranscript,
} from './test-learn-support.mjs';

const noStart = () => {};
const record = (root, id, text, cwd = root) => userLine(id, text, cwd);

test('the human-record contract holds against sanitized real record shapes: only original human messages are evidence', () => {
  const text = fs.readFileSync(path.join(REPO, 'scripts', 'fixtures', 'claude-transcript-sanitized.jsonl'), 'utf8');
  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiverse-fixture-')), 'f.jsonl');
  fs.writeFileSync(file, text.replaceAll('/CORE', '/tmp'));
  const { records, oversize } = scanTranscript(file);
  assert.deepEqual(records.map((r) => r.uuid), ['h-1', 'h-2', 'h-3', 'h-4']);
  assert.equal(oversize, 0);
  assert.equal(records[1].text, 'I prefer short answers with no emojis.'); // the image block is not text
  for (const generated of ['isCompactSummary', 'isMeta', 'isSidechain', 'isVisibleInTranscriptOnly', 'queueTranscriptOnly', 'toolUseResult']) {
    assert.equal(humanRecord({ type: 'user', uuid: 'x', [generated]: true, message: { content: 'I always want short answers.' } }), null, generated);
  }
  assert.equal(humanRecord({ type: 'user', uuid: 'x', origin: { kind: 'task-notification' }, message: { content: 'I always want short answers.' } }), null);
  assert.equal(humanRecord({ type: 'user', message: { content: 'no uuid at all' } }), null);
  assert.equal(humanRecord({ type: 'assistant', uuid: 'a', message: { content: 'I always want short answers.' } }), null);
});

test('a transcript far over 64 MiB is streamed: the final preference is captured, a partial last line waits, and the saved offset continues', () => {
  const root = core();
  const file = path.join(root, 'big.jsonl');
  const filler = assistantLine('f', 'x'.repeat(1000 * 1000), root);
  const fd = fs.openSync(file, 'w');
  for (let i = 0; i < 70; i += 1) fs.writeSync(fd, `${filler}\n`);
  fs.writeSync(fd, `${userLine('last', 'No emojis.', root)}\n${userLine('partial', 'This line is still being written', root).slice(0, 40)}`);
  fs.closeSync(fd);
  assert.ok(fs.statSync(file).size > 64 * 1024 * 1024);
  const first = scanTranscript(file);
  assert.deepEqual(first.records.map((r) => r.uuid), ['last']);
  fs.appendFileSync(file, `${userLine('partial', 'This line is still being written', root).slice(40)}\n`);
  const second = scanTranscript(file, { from: first.end, anchor: first.anchor });
  assert.deepEqual(second.records.map((r) => r.uuid), ['partial']); // the finished line is read whole, from its own start
  appendTranscript(file, [userLine('after', 'I always want warm replies.', root)]);
  const third = scanTranscript(file, { from: second.end, anchor: second.anchor });
  assert.deepEqual(third.records.map((r) => r.uuid), ['after']);
  fs.rmSync(file);
});

test('a changed file is read again from the start (records are unique by uuid), never from a wrong offset', () => {
  const root = core();
  const file = path.join(root, 't.jsonl');
  writeTranscript(file, [userLine('a', 'first record of the old file', root), userLine('b', 'second record of the old file', root)]);
  const old = scanTranscript(file);
  writeTranscript(file, [userLine('c', 'a replacement that is a different file', root), userLine('d', 'with its own second record here', root), userLine('e', 'and a third record for length', root)]);
  assert.deepEqual(scanTranscript(file, { from: old.end, anchor: old.anchor }).records.map((r) => r.uuid), ['c', 'd', 'e']);
});

test('secret values are caught in the label message, in later messages, in other windows, sessions and after a restart; the value is stored nowhere', async () => {
  assert.deepEqual([...secretValues('My password is lilac7.')], ['lilac7', 'lilac7.']);
  assert.ok(tokensOf('Always use lilac7 to log in.').has('lilac7'));
  const root = core({ window_chars: 1000 });
  review([]);
  const s = session(root);
  // the usage comes BEFORE the label in one capture, and AFTER the label in another, and in a different session
  writeTranscript(s.transcript_path, [record(root, 'u0', 'Always use lilac7 to log in.'), record(root, 'u1', 'I prefer short answers.')]);
  hookEvent(root, 'stop', s);
  appendTranscript(s.transcript_path, [record(root, 'u2', 'My password is lilac7.'), record(root, 'u3', 'Please also use lilac7 for the vpn.')]);
  hookEvent(root, 'precompact', s);
  const other = session(root, 'session-2');
  writeTranscript(other.transcript_path, [record(root, 'v1', 'Remember lilac7 for the portal.'), record(root, 'v2', 'I always want warm replies.')]);
  hookEvent(root, 'end', other);
  assert.deepEqual(peek(root, "SELECT uuid, state FROM occurrences ORDER BY uuid").map((r) => `${r.uuid}:${r.state}`), ['u0:excluded', 'u1:pending', 'u2:excluded', 'u3:excluded', 'v1:excluded', 'v2:pending']);
  await run(root, { drain: true });
  assert.equal(allText(root).includes('lilac7'), false); // database, WAL, inboxes, spool: nowhere
  assert.equal(calls().some((c) => c.prompt.includes('lilac7')), false);
  assert.equal(dumpDb(root).includes('lilac7'), false);
  assert.ok(occurrences('I prefer short answers.') === 1 && occurrences('I always want warm replies.') === 1);
});

test('a credential that turns out to be one withdraws unfinished candidates that repeat it, and a reviewer answer repeating a known value is rejected', async () => {
  const root = core();
  const s = session(root);
  const sentence = 'I always want warm replies with the code zeta99 on top.';
  writeTranscript(s.transcript_path, [record(root, 'u1', sentence, null)]); // no cwd: the candidate waits for a scope, unfiled
  hookEvent(root, 'stop', s);
  review([{ kind: 'preference', category: 'communication', statement: sentence, scope_hint: 'general', exception: false, tentative: false, confidence: 0.9, replaces: null, evidence: { message_id: 'o1', quote: sentence } }]);
  await run(root, { drain: true });
  assert.deepEqual(peek(root, 'SELECT state FROM items').map((r) => r.state), ['needs_scope']);
  appendTranscript(s.transcript_path, [record(root, 'u2', 'My password is zeta99 by the way.'), record(root, 'u3', 'I also always want short notes.')]);
  hookEvent(root, 'end', s);
  assert.deepEqual(peek(root, 'SELECT state, body FROM items').map((r) => [r.state, r.body]), [['excluded', '{}']]);
  review([{ kind: 'preference', category: 'communication', statement: 'I also always want short notes, zeta99.', scope_hint: 'general', exception: false, tentative: false, confidence: 0.9, replaces: null, evidence: { message_id: 'o3', quote: 'I also always want short notes.' } }]);
  await run(root, { drain: true });
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM items WHERE state != 'excluded'")[0].n, 0);
  assert.equal(peek(root, "SELECT n FROM counters WHERE code = 'rejected_secret_in_source'")[0].n, 1);
  assert.equal(allText(root).includes('zeta99'), false);
});

test('scope is bound at capture from the cwd: operator, manifest workspace, unresolved (no cwd, unmanifested folder, missing folder); outside the Core is not captured', () => {
  const root = core();
  workspace(root, 'alpha');
  fs.mkdirSync(path.join(root, 'workspaces', 'ghost'));
  const s = session(root);
  writeTranscript(s.transcript_path, [
    record(root, 'o', 'operator level statement here', root),
    record(root, 'w', 'workspace level statement here', path.join(root, 'workspaces', 'alpha')),
    record(root, 'n', 'statement with no cwd at all here', null),
    record(root, 'g', 'statement in an unmanifested folder', path.join(root, 'workspaces', 'ghost')),
    record(root, 'm', 'statement in a folder that is gone', path.join(root, 'workspaces', 'gone')),
    record(root, 'x', 'statement written outside of the Core', path.dirname(root)),
  ]);
  hookEvent(root, 'end', s);
  assert.deepEqual(peek(root, 'SELECT uuid, scope FROM occurrences ORDER BY id').map((r) => `${r.uuid}=${r.scope}`),
    ['o=operator', 'w=workspace:alpha', 'n=unresolved', 'g=unresolved', 'm=unresolved']);
});

test('different records with the same words are both kept; the same uuid is kept once however often it is captured', () => {
  const root = core();
  const s = session(root);
  writeTranscript(s.transcript_path, [record(root, 'p1', 'identical words in the message here'), record(root, 'p2', 'identical words in the message here')]);
  hookEvent(root, 'stop', s);
  hookEvent(root, 'stop', s);
  writeTranscript(s.transcript_path, [assistantLine('h', 'a different opening record', root), record(root, 'p1', 'identical words in the message here'), record(root, 'p3', 'identical words in the message here')]);
  hookEvent(root, 'precompact', s);
  assert.deepEqual(peek(root, 'SELECT uuid FROM occurrences ORDER BY id').map((r) => r.uuid), ['p1', 'p2', 'p3']);
});

test('off, missing and unreadable configuration: the hook and the launcher do nothing to disk at all', () => {
  for (const config of ['off', 'missing', 'broken']) {
    const root = core({ mode: 'off' });
    const file = path.join(root, '.aiverse', 'learn', 'config.json');
    if (config === 'missing') fs.rmSync(file);
    if (config === 'broken') fs.writeFileSync(file, '{');
    const s = session(root);
    writeTranscript(s.transcript_path, [record(root, 'u1', 'I always want warm replies.')]);
    hookEvent(root, 'precompact', s);
    spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-launch.mjs'), '--root', root, '--drain'], { encoding: 'utf8' });
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'learn')), false, config);
  }
});

test('the hook never fails silently: every durable-write boundary is fault-injected and either leaves recoverable evidence or says it failed', async () => {
  const root = core();
  const s = session(root);
  writeTranscript(s.transcript_path, [record(root, 'u1', 'I always want warm replies.'), record(root, 'u2', 'My goal is to finish the report by Friday.')]);
  const down = async () => { throw new Error('database unavailable'); };
  const spool = learnPaths(root).spool;
  const files = () => (fs.existsSync(spool) ? fs.readdirSync(spool) : []);
  const failing = (name, fail) => ({ ...Object.fromEntries(['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'rmSync', 'mkdirSync'].map((k) => [k, (...a) => fs[k](...a)])), [name]: fail });
  // the database is unavailable: an envelope is the durable evidence
  let r = await handleEvent(root, 'precompact', s, Date.now(), noStart, { open: down });
  assert.deepEqual([r.ok, r.via, files().length], [true, 'envelope', 1]);
  // database BUSY (a real write lock held elsewhere): same
  const { DatabaseSync } = await import('node:sqlite');
  await openStore(root).then((d) => d.close());
  const holder = new DatabaseSync(learnPaths(root).db);
  holder.exec('BEGIN IMMEDIATE');
  r = await handleEvent(root, 'stop', s, Date.now(), noStart, { open: (rt) => openStore(rt, { busyMs: 100 }) });
  assert.deepEqual([r.ok, r.via, files().length], [true, 'envelope', 2]);
  holder.exec('ROLLBACK');
  holder.close();
  // no space left (ENOSPC on the write), a partial write, a failed fsync, a failed rename: no success is reported, no half file stays
  const before = files();
  const enospc = Object.assign(new Error('no space'), { code: 'ENOSPC' });
  for (const [name, fail] of [
    ['writeSync', () => { throw enospc; }],
    ['writeSync', (fd, body) => { fs.writeSync(fd, body.slice(0, 20)); throw enospc; }],
    ['fsyncSync', () => { throw Object.assign(new Error('io'), { code: 'EIO' }); }],
    ['renameSync', () => { throw Object.assign(new Error('perm'), { code: 'EPERM' }); }],
    ['openSync', () => { throw enospc; }],
  ]) {
    r = await handleEvent(root, 'precompact', s, Date.now(), noStart, { open: down, io: failing(name, fail) });
    assert.deepEqual([r.ok, r.code], [false, 'capture_failed'], name);
    assert.deepEqual(files(), before, `${name} left a file behind`);
  }
  assert.equal(JSON.parse(fs.readFileSync(learnPaths(root).status, 'utf8')).code, 'capture_failed');
  // death between the fsync and the rename: a whole, digest-named temp file remains and the worker recovers it once it is old enough
  const killed = spawnSync(process.execPath, ['-e', `import('./scripts/learn-hook.mjs').then((m) => m.handleEvent(process.cwd(), 'stop', ${JSON.stringify(s)}, Date.now(), () => {}, { open: async () => { throw new Error('down'); }, crash: (p) => { if (p === 'envelope_before_rename') process.kill(process.pid, 'SIGKILL'); } }))`], { cwd: root, encoding: 'utf8' });
  assert.ok(killed.signal === 'SIGKILL' || killed.status !== 0);
  assert.equal(files().filter((n) => n.endsWith('.tmp')).length, 1);
  const tmp = path.join(spool, files().find((n) => n.endsWith('.tmp')));
  assert.equal(listEnvelopes(root).filter((e) => e.file === tmp).length, 0); // too fresh: its writer might still be filling it
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(tmp, old, old);
  assert.equal(listEnvelopes(root).filter((e) => e.file === tmp).length, 1);
  // the worker ingests every envelope, whatever it died of, exactly once
  review([]);
  await run(root, { drain: true });
  assert.deepEqual(peek(root, 'SELECT uuid FROM occurrences ORDER BY id').map((x) => x.uuid), ['u1', 'u2']);
  assert.equal(files().filter((n) => n.startsWith('env-')).length, 0);
});

test('envelopes: only whole, owned, valid ones are used or deleted; foreign, altered, malformed, symlinked and escaping files are left exactly as they are', async () => {
  const root = core();
  const spool = learnPaths(root).spool;
  const s = session(root);
  const batch = (uuid) => ({ key: sessionKey('s'), session_id: 's', transcript_path: s.transcript_path, reason: 'session_end', at: Date.now(), config: { idle_seconds: 1, max_pending_turns: 6 }, records: [{ uuid, ts: null, seq: 0, scope: 'operator', text: `statement number ${uuid}` }] });
  const bad = batch('valid-after-bad');
  bad.records[0].scope = 'everywhere'; // a well-formed file whose content is not a valid envelope
  const mine = [writeEnvelope(root, bad), writeEnvelope(root, batch('good-1')), writeEnvelope(root, batch('good-2'))].map((n) => path.join(spool, n));
  const foreign = path.join(spool, `env-${'1'.padStart(15, '0')}-aaaaaaaa-${'b'.repeat(16)}.json`);
  fs.writeFileSync(foreign, JSON.stringify({ v: 1, ...batch('foreign') })); // a matching name, not ours
  const altered = path.join(spool, path.basename(mine[2]).replace(/-([0-9a-f]{8})-/, '-deadbeef-'));
  fs.copyFileSync(mine[2], altered);
  fs.appendFileSync(altered, ' ');
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, fs.readFileSync(mine[1]));
  let linked = false;
  try { fs.symlinkSync(outside, path.join(spool, `env-${'2'.padStart(15, '0')}-bbbbbbbb-${sha(fs.readFileSync(outside, 'utf8'), 16)}.json`)); linked = true; } catch {}
  const db = await openStore(root);
  const found = listEnvelopes(root);
  assert.deepEqual(found.map((e) => e.value.records[0].uuid).sort(), ['good-1', 'good-2']); // the malformed one does not block them
  assert.equal(ingestEnvelopes(db, root, found), 2);
  db.close();
  assert.deepEqual(peek(root, 'SELECT uuid FROM occurrences ORDER BY id').map((x) => x.uuid), ['good-1', 'good-2']);
  assert.equal(fs.existsSync(mine[0]) && fs.existsSync(foreign) && fs.existsSync(altered) && fs.existsSync(outside), true);
  assert.equal(fs.existsSync(mine[1]) || fs.existsSync(mine[2]), false);
  if (linked) assert.equal(fs.readdirSync(spool).filter((n) => fs.lstatSync(path.join(spool, n)).isSymbolicLink()).length, 1);
  assert.equal(removeEnvelope(root, foreign), false);
  assert.equal(removeEnvelope(root, outside), false); // not in the spool
  assert.equal(fs.existsSync(foreign), true);
});

test('the hook program says so and exits 1 when nothing durable could be written, and exits 0 silently otherwise', () => {
  const root = core();
  const s = session(root);
  writeTranscript(s.transcript_path, [record(root, 'u1', 'I always want warm replies.')]);
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-hook.mjs'), 'precompact'], { input: JSON.stringify(s), encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', 'learn'), 'a file where the folder must be'); // neither the database nor an envelope can be written
  const failed = run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /could not save this conversation/);
  fs.rmSync(path.join(root, 'runtime', 'learn'));
  const fine = run();
  assert.deepEqual([fine.status, fine.stdout, fine.stderr], [0, '', '']);
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM occurrences')[0].n, 1);
});
