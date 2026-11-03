#!/usr/bin/env node
// Capture: what counts as a human statement (against sanitized real record shapes), bounded reading, one credential contract across
// messages, scope binding, dormancy, and the fail-closed behaviour of the hook. Needs Node 22.13+ (node:sqlite).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { learnPaths, readStatus, resolveScope, sessionKey } from './learn-common.mjs';
import { BATCH_BYTES, CONTRACT_VERSION, humanRecord, scanTranscript, secretValues, tokensOf } from './learn-capture.mjs';
import { handleEvent } from './learn-hook.mjs';
import { isSecretText, openStore } from './learn-store.mjs';
import { run } from './learn-worker.mjs';
import {
  REPO, allText, appendTranscript, assistantLine, calls, capture, core, dumpDb, hookEvent, occurrences, peek, review, session, setMode, tempDir, userLine, workspace, writeTranscript,
} from './test-learn-support.mjs';

const noStart = () => {};
const record = (root, id, text, cwd = root) => userLine(id, text, cwd);

test('the human-record contract holds against sanitized real record shapes: only original human messages are evidence, with their lineage', () => {
  const text = fs.readFileSync(path.join(REPO, 'scripts', 'fixtures', 'claude-transcript-sanitized.jsonl'), 'utf8');
  const file = path.join(tempDir('aiverse-fixture-'), 'f.jsonl');
  fs.writeFileSync(file, text.replaceAll('/CORE', '/tmp'));
  const { records, gaps, done } = scanTranscript(file);
  assert.deepEqual(records.map((r) => r.uuid), ['h-1', 'h-2', 'h-3', 'h-4']);
  assert.deepEqual([gaps.length, done], [0, true]);
  assert.equal(records[1].text, 'I prefer short answers with no emojis.'); // the image block is not text
  assert.deepEqual(records.map((r) => r.src_session), ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  assert.equal(records[0].cli, '2.1.0');
  assert.equal(CONTRACT_VERSION, 1);
  for (const generated of ['isCompactSummary', 'isMeta', 'isSidechain', 'isVisibleInTranscriptOnly', 'queueTranscriptOnly', 'toolUseResult']) {
    assert.equal(humanRecord({ type: 'user', uuid: 'x', [generated]: true, message: { content: 'I always want short answers.' } }), null, generated);
  }
  const base = { type: 'user', uuid: 'x', message: { content: 'I always want short answers.' } };
  assert.equal(humanRecord({ ...base, origin: { kind: 'task-notification' } }), null);
  assert.equal(humanRecord({ ...base, turnOrigin: 'assistant', promptSource: 'system' }), null); // contradictory generated metadata
  assert.equal(humanRecord({ ...base, turnOrigin: 'peer' }), null);
  assert.equal(humanRecord({ ...base, promptSource: 'system' }), null);
  assert.notEqual(humanRecord({ ...base, turnOrigin: 'human', promptSource: 'sdk', origin: { kind: 'human' } }), null);
  assert.equal(humanRecord({ ...base, uuid: 'not a valid id!' }), null);
  assert.equal(humanRecord({ ...base, timestamp: 'yesterday' }).ts, null); // a malformed time is not kept
  assert.equal(humanRecord({ type: 'user', message: { content: 'no uuid at all' } }), null);
  assert.equal(humanRecord({ type: 'assistant', uuid: 'a', message: { content: 'I always want short answers.' } }), null);
});

test('a transcript far over 64 MiB is read in bounded batches: the final preference is captured and a partial last line waits', () => {
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
  assert.deepEqual(second.records.map((r) => r.uuid), ['partial']);
  appendTranscript(file, [userLine('after', 'I always want warm replies.', root)]);
  assert.deepEqual(scanTranscript(file, { from: second.end, anchor: second.anchor }).records.map((r) => r.uuid), ['after']);
  fs.rmSync(file);
});

test('more than 64 MiB of human text is ingested in bounded batches with committed read positions, and an oversized human record is a recorded gap, not a silent skip', async () => {
  const root = core();
  const file = path.join(root, 't.jsonl');
  const body = (n) => `Record ${n} é ${'😀 word '.repeat(600000)}`; // several MB of text each, with non-BMP characters
  const lines = Array.from({ length: 12 }, (_, i) => record(root, `big${i}`, body(i)));
  const giant = record(root, 'giant', `giant ${'word '.repeat(2000000)}`); // about 10 MB: over the 8 MB a record may be
  writeTranscript(file, [...lines.slice(0, 6), giant, ...lines.slice(6), record(root, 'tail', 'I always want warm replies.')]);
  assert.ok(fs.statSync(file).size > 64 * 1024 * 1024);
  const batches = [];
  const scan = (f, o) => { const r = scanTranscript(f, o); batches.push([r.records.length, r.records.reduce((n, x) => n + x.text.length, 0), r.end]); return r; };
  const out = await handleEvent(root, 'end', { session_id: 's', transcript_path: file, cwd: root }, Date.now(), noStart, { scan });
  assert.deepEqual([out.ok, out.via], [true, 'journal']);
  assert.ok(batches.length >= 6, `batches: ${batches.length}`);
  assert.ok(batches.every(([count, bytes]) => count <= 200 && bytes <= BATCH_BYTES + 5 * 1024 * 1024), JSON.stringify(batches)); // never everything at once
  assert.deepEqual(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE uuid LIKE 'big%'")[0], { n: 12 });
  assert.equal(peek(root, "SELECT state FROM occurrences WHERE uuid = 'tail'")[0].state, 'pending');
  assert.equal(peek(root, "SELECT COUNT(*) AS n FROM occurrences WHERE uuid = 'giant'")[0].n, 0);
  assert.deepEqual(peek(root, 'SELECT seq, bytes FROM gaps').map((g) => g.bytes > 8 * 1024 * 1024), [true]);
  assert.equal(peek(root, "SELECT n FROM counters WHERE code = 'oversize_human_record'")[0].n, 1);
  assert.ok(readStatus(root).includes('capture_incomplete'));
  assert.equal(peek(root, 'SELECT off FROM captures')[0].off, fs.statSync(file).size); // committed position: the next Stop reads only what is new
  fs.rmSync(file);
});

test('a tail anchor is only a shortcut: the Stop fast path can miss a replaced earlier record, every destructive boundary reads it again', async () => {
  const root = core();
  const file = path.join(root, 't.jsonl');
  const s = { session_id: 's', transcript_path: file, cwd: root };
  const tail = assistantLine('t', 'a tail that is long enough to be the whole anchor '.repeat(10), root);
  writeTranscript(file, [record(root, 'old-1', 'the original statement aaaaaaaa'), tail]);
  await handleEvent(root, 'stop', s, Date.now(), noStart);
  writeTranscript(file, [record(root, 'new-1', 'the replaced statement bbbbbbbb'), tail]); // same size, same last 256 bytes, different earlier record
  await handleEvent(root, 'stop', s, Date.now(), noStart);
  assert.deepEqual(peek(root, 'SELECT uuid FROM occurrences').map((r) => r.uuid), ['old-1']); // the documented limit of the fast path
  await handleEvent(root, 'precompact', s, Date.now(), noStart);
  assert.deepEqual(peek(root, 'SELECT uuid FROM occurrences ORDER BY id').map((r) => r.uuid), ['old-1', 'new-1']);
});

test('one credential contract: declared values, short PINs, punctuation, assignment and URL forms and Unicode forms are caught everywhere, and the value is stored nowhere', async () => {
  assert.ok(secretValues('My pin is 123.').has('123'));
  assert.ok(secretValues('password: p@ss!w0rd#').has('p@ss!w0rd#'));
  assert.ok(secretValues('The password is required for login.').has('required')); // a declaration is taken at its word, even an ordinary one (a known false positive: it only drops more)
  assert.equal(secretValues('password purple').size, 0); // undeclared and not credential-shaped: not a value
  assert.equal(secretValues('token limits are fine').size, 0);
  assert.ok(tokensOf('Use value=lilac7 to log in.').has('lilac7'));
  assert.ok(tokensOf('open https://example.com/login?user=a&pw=lilac7&x=1').has('lilac7'));
  assert.ok(tokensOf('Use (lilac7), then continue').has('lilac7'));
  assert.ok(tokensOf('Use lil​ac7 now').has('lilac7'));
  const root = core();
  review([]);
  const cases = [
    ['My pin is 123.', 'Use 123 to log in.'],
    ['My password is p@ss!w0rd#.', 'Log in with p@ss!w0rd# please.'],
    ['My password is lilac7.', 'Use value=lilac7 to log in.'],
    ['My password is lilac7.', 'Open https://example.com/login?user=a&pw=lilac7 now.'],
    ['My password is CaféNine.', 'Log in with CaféNine today.'],
    ['My password is ｌilac7.', 'Use lilac7, then continue.'], // full-width letter
    ['My password is zephyr9.', 'Use zep​hyr9 to log in.'],
    ['Use mango88 to log in.', 'My password is mango88.'], // usage first
  ];
  for (const [i, [label, use]] of cases.entries()) {
    await capture(root, `case-${i}`, [{ uuid: `a${i}`, text: label }, { uuid: `b${i}`, text: use }]);
  }
  await capture(root, 'quiet', [{ uuid: 'q1', text: 'I always want warm replies.' }]);
  assert.deepEqual(peek(root, "SELECT state, COUNT(*) AS n FROM occurrences GROUP BY state").map((r) => [r.state, r.n]), [['excluded', 16], ['pending', 1]]);
  for (const bad of ['lilac7', 'p@ss!w0rd#', 'mango88', 'zephyr9', 'CaféNine']) assert.equal(allText(root).includes(bad), false, bad);
  const db = await openStore(root);
  assert.equal(isSecretText(db, 'something about replaces: lilac7 only'), true);
  assert.equal(isSecretText(db, 'I always want warm replies.'), false);
  db.close();
});

test('a credential found in a later message, window, session or capture is dropped everywhere; the value is stored nowhere, not even in the log', async () => {
  const root = core({ window_chars: 1000 });
  review([]);
  const s = session(root);
  writeTranscript(s.transcript_path, [record(root, 'u0', 'Always use lilac7 to log in.'), record(root, 'u1', 'I prefer short answers.')]);
  hookEvent(root, 'stop', s);
  appendTranscript(s.transcript_path, [record(root, 'u2', 'My password is lilac7.'), record(root, 'u3', 'Please also use lilac7 for the vpn.')]);
  hookEvent(root, 'precompact', s);
  const other = session(root, 'session-2');
  writeTranscript(other.transcript_path, [record(root, 'v1', 'Remember lilac7 for the portal.'), record(root, 'v2', 'I always want warm replies.')]);
  hookEvent(root, 'end', other);
  assert.deepEqual(peek(root, 'SELECT uuid, state FROM occurrences ORDER BY uuid').map((r) => `${r.uuid}:${r.state}`), ['u0:excluded', 'u1:pending', 'u2:excluded', 'u3:excluded', 'v1:excluded', 'v2:pending']);
  await run(root, { drain: true });
  assert.equal(allText(root).includes('lilac7'), false);
  assert.equal(calls().some((c) => c.prompt.includes('lilac7')), false);
  assert.equal(dumpDb(root).includes('lilac7'), false);
  assert.ok(occurrences('I prefer short answers.') === 1 && occurrences('I always want warm replies.') === 1);
});

test('scope is bound at capture from the cwd and a validated manifest: operator, workspace, unresolved (no cwd, unmanifested, mismatched manifest, missing folder); outside the Core is not captured', () => {
  const root = core();
  workspace(root, 'alpha');
  fs.mkdirSync(path.join(root, 'workspaces', 'ghost'));
  fs.mkdirSync(path.join(root, 'workspaces', 'beta'));
  fs.writeFileSync(path.join(root, 'workspaces', 'beta', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: alpha\n'); // a manifest naming another workspace
  const s = session(root);
  writeTranscript(s.transcript_path, [
    record(root, 'o', 'operator level statement here', root),
    record(root, 'w', 'workspace level statement here', path.join(root, 'workspaces', 'alpha')),
    record(root, 'n', 'statement with no cwd at all here', null),
    record(root, 'g', 'statement in an unmanifested folder', path.join(root, 'workspaces', 'ghost')),
    record(root, 'b', 'statement under a mismatched manifest', path.join(root, 'workspaces', 'beta')),
    record(root, 'm', 'statement in a folder that is gone', path.join(root, 'workspaces', 'gone')),
    record(root, 'x', 'statement written outside of the Core', path.dirname(root)),
  ]);
  hookEvent(root, 'end', s);
  assert.deepEqual(peek(root, 'SELECT uuid, scope, contract FROM occurrences ORDER BY id').map((r) => `${r.uuid}=${r.scope}/${r.contract}`),
    ['o=operator/1', 'w=workspace:alpha/1', 'n=unresolved/1', 'g=unresolved/1', 'b=unresolved/1', 'm=unresolved/1']);
  try {
    fs.symlinkSync(path.join(root, 'workspaces', 'alpha'), path.join(root, 'workspaces', 'alias'));
    assert.equal(resolveScope(root, path.join(root, 'workspaces', 'alias')), 'workspace:alpha'); // an alias resolves to the real folder, never to a new id
  } catch (error) { if (error.code !== 'EPERM') throw error; }
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

test('capture fails closed: with the database unavailable or busy NO file is written, a raw credential reaches no disk, and nothing is lost for the next boundary', async () => {
  const root = core();
  const s = session(root);
  writeTranscript(s.transcript_path, [record(root, 'u1', 'My password is lilac7.'), record(root, 'u2', 'Always use lilac7 to log in.'), record(root, 'u3', 'I always want warm replies.')]);
  const everything = () => allText(root) + (fs.existsSync(path.join(root, 'runtime', 'learn', 'spool')) ? 'SPOOL' : '');
  // SQLite unavailable (old Node, bad install): the hook refuses and writes nothing but the visible status
  let r = await handleEvent(root, 'precompact', s, Date.now(), noStart, { open: async () => { throw new Error('no node:sqlite'); } });
  assert.deepEqual([r.ok, r.code], [false, 'capture_failed']);
  assert.equal(everything().includes('lilac7') || everything().includes('SPOOL'), false);
  assert.deepEqual(fs.readdirSync(learnPaths(root).base).sort(), ['status']);
  assert.deepEqual(readStatus(root).sort(), ['capture_failed', 'store_unavailable']);
  // the database is busy (a real write lock held elsewhere past the hook's patience)
  await openStore(root).then((d) => d.close());
  const holder = new DatabaseSync(learnPaths(root).db);
  holder.exec('BEGIN IMMEDIATE');
  r = await handleEvent(root, 'stop', s, Date.now(), noStart, { open: (rt) => openStore(rt, { busyMs: 100 }) });
  assert.equal(r.ok, false);
  assert.equal(everything().includes('lilac7') || everything().includes('SPOOL'), false);
  holder.exec('ROLLBACK');
  holder.close();
  // the next boundary reads the same transcript and loses nothing
  r = await handleEvent(root, 'stop', s, Date.now(), noStart);
  assert.deepEqual([r.ok, r.via], [true, 'journal']);
  assert.deepEqual(peek(root, 'SELECT uuid, state FROM occurrences ORDER BY uuid').map((x) => `${x.uuid}:${x.state}`), ['u1:excluded', 'u2:excluded', 'u3:pending']);
  assert.equal(allText(root).includes('lilac7'), false);
  assert.equal(readStatus(root).includes('capture_failed'), false); // and the health state clears
});

test('the hook program says so and exits 1 when nothing could be written, and exits 0 silently otherwise', () => {
  const root = core();
  const s = session(root);
  writeTranscript(s.transcript_path, [record(root, 'u1', 'I always want warm replies.')]);
  const run1 = () => spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-hook.mjs'), 'precompact'], { input: JSON.stringify(s), encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runtime', 'learn'), 'a file where the folder must be');
  const failed = run1();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /could not save this conversation/);
  fs.rmSync(path.join(root, 'runtime', 'learn'));
  const fine = run1();
  assert.deepEqual([fine.status, fine.stdout, fine.stderr], [0, '', '']);
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM occurrences')[0].n, 1);
});

test('an explicit declaration keeps its value however short or ordinary; metadata that is free text is refused; nothing leaks, now or after a late discovery', async () => {
  const root = core();
  review([]);
  // short and ordinary declared values: the later use is dropped
  await capture(root, 'pin', [{ uuid: 'p1', text: 'My pin is 12.' }, { uuid: 'p2', text: 'Use 12 to log in.' }]);
  await capture(root, 'word', [{ uuid: 'w1', text: 'My password is true.' }, { uuid: 'w2', text: 'Use true to log in.' }]);
  assert.deepEqual(peek(root, 'SELECT uuid, state FROM occurrences ORDER BY id').map((r) => `${r.uuid}:${r.state}`), ['p1:excluded', 'p2:excluded', 'w1:excluded', 'w2:excluded']);
  for (const text of ['Use 12 to log in', 'Use true to log in', 'My pin is 12', 'My password is true']) assert.equal(allText(root).includes(text), false, text);
  // a bare function word is not a credential, and an undeclared ordinary word is not either
  assert.equal(secretValues('The token is a nuisance').size > 0, false);
  assert.equal(secretValues('password required').size, 0);
  // discovered later: the earlier pending text goes too
  await capture(root, 'late', [{ uuid: 'l1', text: 'Remember maple55 for the portal.' }]);
  await capture(root, 'late2', [{ uuid: 'l2', text: 'My password is maple55.' }]);
  assert.equal(peek(root, "SELECT state FROM occurrences WHERE uuid = 'l1'")[0].state, 'excluded');
  assert.equal(allText(root).includes('maple55'), false);
  // metadata: a sentence is not a session id, a path is not a sentence
  const phrase = 'My password is zeta99.';
  assert.equal(humanRecord({ type: 'user', uuid: 'x', sessionId: phrase, version: phrase, timestamp: phrase, message: { content: 'I always want warm replies.' } }).src_session, null);
  await assert.rejects(capture(root, phrase, [{ uuid: 'z1', text: 'I always want warm replies.' }]), (error) => error.code === 'invalid_source');
  await capture(root, 'meta', [{ uuid: 'm1', text: 'I always want warm replies.', src_session: phrase, cli: phrase, ts: phrase }]);
  assert.deepEqual({ ...peek(root, "SELECT src_session, cli, ts FROM occurrences WHERE uuid = 'm1'")[0] }, { src_session: null, cli: null, ts: null });
  const s = { session_id: phrase, transcript_path: path.join(root, 'x.jsonl'), cwd: root };
  writeTranscript(s.transcript_path, [record(root, 'u1', 'I always want warm replies.')]);
  assert.equal((await handleEvent(root, 'end', s, Date.now(), noStart)).via, 'skipped'); // not a session id: nothing is captured, nothing is written
  assert.equal(allText(root).includes('zeta99'), false);
  assert.equal(dumpDb(root).includes('zeta99'), false);
});

test('a record too large to hold is an unresolved gap in ANY property order or shape; generated and assistant lines are not; the state stays outstanding', async () => {
  const root = core();
  const file = path.join(root, 'big.jsonl');
  const big = 'word '.repeat(2200000); // over the 8 MB a record may be
  writeTranscript(file, [
    JSON.stringify({ message: { role: 'user', content: big }, type: 'user', uuid: 'reordered' }), // the type comes AFTER the content
    JSON.stringify({ type: 'assistant', uuid: 'a', message: { content: big } }),
    JSON.stringify({ uuid: 'tool', message: { content: [{ type: 'tool_result', content: big }] }, type: 'user', toolUseResult: {} }),
    JSON.stringify({ mystery: big }), // a shape nobody can tell
    record(root, 'small', 'I always want warm replies.'),
  ]);
  const scanned = scanTranscript(file);
  assert.deepEqual(scanned.gaps.map((g) => g.seq === 0), [true, false]); // the reordered user record and the unreadable shape
  assert.deepEqual(scanned.records.map((r) => r.uuid), ['small']);
  const s = { session_id: 's', transcript_path: file, cwd: root };
  assert.equal((await handleEvent(root, 'stop', s, Date.now(), noStart)).ok, true);
  assert.ok(readStatus(root).includes('capture_incomplete'));
  // a later scan that sees no gap does not make the outstanding one disappear
  const clean = path.join(root, 'clean.jsonl');
  writeTranscript(clean, [record(root, 'c1', 'I prefer short answers.')]);
  await handleEvent(root, 'stop', { session_id: 's2', transcript_path: clean, cwd: root }, Date.now(), noStart);
  assert.ok(readStatus(root).includes('capture_incomplete'));
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM gaps WHERE resolved = 0')[0].n, 2);
  fs.rmSync(file);
});

test('the prompt boundary captures early, silently and fast: an interrupted turn (no Stop ever fires) is already in the journal, nothing is printed, no worker is started, and it stops after its time budget', async () => {
  const root = core();
  const file = path.join(root, 't.jsonl');
  const s = { session_id: 's', transcript_path: file, cwd: root };
  writeTranscript(file, [record(root, 'i1', 'I always want warm replies.')]); // the previous turn was interrupted: no Stop
  let started = 0;
  const out = await handleEvent(root, 'prompt', s, Date.now(), () => { started += 1; });
  assert.deepEqual([out.ok, out.via, started], [true, 'journal', 0]);
  assert.deepEqual(peek(root, 'SELECT uuid FROM occurrences').map((r) => r.uuid), ['i1']);
  assert.equal(peek(root, 'SELECT COUNT(*) AS n FROM sessions')[0].n, 0); // evidence, but no wake-up
  // as a program: no output at all
  const run1 = spawnSync(process.execPath, [path.join(root, 'scripts', 'learn-hook.mjs'), 'prompt'], { input: JSON.stringify({ ...s, prompt: 'a new request' }), encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  assert.deepEqual([run1.status, run1.stdout, run1.stderr], [0, '', '']);
  // bounded: after its budget no further batch is started (the read position of the finished ones is already committed)
  let batches = 0;
  const slow = (f, o) => { batches += 1; const until = Date.now() + 3200; while (Date.now() < until) {} return { records: [], gaps: [], end: o.from + 1, anchor: '', done: false }; };
  await handleEvent(root, 'prompt', { ...s, session_id: 'slow' }, Date.now(), noStart, { scan: slow });
  assert.equal(batches, 1);
});

test('switching learning off while a transcript is being read writes nothing at all', async () => {
  const root = core();
  const file = path.join(root, 't.jsonl');
  writeTranscript(file, [record(root, 'u1', 'I always want warm replies.')]);
  const scan = (f, o) => { const r = scanTranscript(f, o); setMode(root, 'off'); return r; }; // off right after the read, before the write
  const out = await handleEvent(root, 'end', { session_id: 's', transcript_path: file, cwd: root }, Date.now(), noStart, { scan });
  assert.deepEqual([out.ok, out.via], [true, 'skipped']);
  assert.deepEqual([peek(root, 'SELECT COUNT(*) AS n FROM occurrences')[0].n, peek(root, 'SELECT COUNT(*) AS n FROM captures')[0].n, peek(root, 'SELECT COUNT(*) AS n FROM sessions')[0].n], [0, 0, 0]);
});

test('provenance by the ORIGINAL source: a forked or replayed copy is the same record, and timestamps with offsets are compared as instants', async () => {
  const root = core();
  await capture(root, 'reader-one', [{ uuid: 'orig-1', src_session: 'original-chat', text: 'I always want warm replies.' }]);
  await capture(root, 'reader-two', [{ uuid: 'orig-1', src_session: 'original-chat', text: 'I always want warm replies.' }]); // a fork that copied the record
  await capture(root, 'reader-two', [{ uuid: 'own-1', text: 'I always want warm replies.' }]);
  assert.deepEqual(peek(root, 'SELECT uuid, origin FROM occurrences ORDER BY id').map((r) => `${r.uuid}:${r.origin}`), [`orig-1:${sessionKey('original-chat')}`, `own-1:${sessionKey('reader-two')}`]);
  await capture(root, 'order', [
    { uuid: 'later', ts: '2026-01-02T10:00:00+02:00', text: 'second in time, written first' }, // 08:00 UTC
    { uuid: 'earlier', ts: '2026-01-02T07:30:00Z', text: 'first in time' },
  ]);
  assert.deepEqual(peek(root, "SELECT uuid FROM occurrences WHERE session != 'x' AND uuid IN ('later', 'earlier') ORDER BY ts_ms").map((r) => r.uuid), ['earlier', 'later']);
});
