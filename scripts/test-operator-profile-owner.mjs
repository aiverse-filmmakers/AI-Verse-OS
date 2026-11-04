#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'operator-profile-owner.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-profile-owner-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  fs.mkdirSync(path.join(root, 'operator', 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  return root;
}

function runCommand(root, command, request) {
  const proc = spawnSync(process.execPath, [script, command, '--root', root], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout || `exit ${proc.status}`);
  return JSON.parse(proc.stdout);
}

function run(root, request) {
  return runCommand(root, 'ensure', request);
}

function baseRequest() {
  return {
    identity: {
      name: 'Bogdan',
      roles: ['Filmmaker', 'Creator'],
      domains: ['AI filmmaking'],
      notes: [],
    },
    preferences: {
      communication: ['Prefer concise direct answers.'],
      working_style: ['Reuse context instead of asking the same question again.'],
      approval_boundaries: [],
      quality_expectations: ['Validate important work before calling it complete.'],
      avoid: ['Do not expose internal architecture unless useful.'],
    },
    evidence: {
      stable: true,
      explicit_or_strong: true,
      privacy_ambiguous: false,
      contains_sensitive: false,
      contains_secret: false,
      reason: 'Strong migration evidence.',
    },
    provenance: {
      trigger_ref: 'migration:sha256:' + 'a'.repeat(64),
      classifier: 'migration-runtime',
      source: 'hermes-memory',
    },
  };
}

{
  const root = fixture();
  const first = run(root, baseRequest());
  assert.equal(first.state, 'created');
  const identity = fs.readFileSync(path.join(root, 'operator', 'profile', 'identity.md'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'operator', 'profile', 'preferences.md'), 'utf8');
  assert.match(identity, /Name: Bogdan/);
  assert.match(identity, /Filmmaker/);
  assert.match(preferences, /Prefer concise direct answers\./);
  assert.match(preferences, /Reuse context instead of asking the same question again\./);

  const second = run(root, baseRequest());
  assert.equal(second.state, 'existing');
  const identityAgain = fs.readFileSync(path.join(root, 'operator', 'profile', 'identity.md'), 'utf8');
  assert.equal((identityAgain.match(/- Filmmaker/g) ?? []).length, 1);
}

{
  const root = fixture();
  fs.writeFileSync(
    path.join(root, 'operator', 'profile', 'identity.md'),
    '# Identity\n\nName: Alice\n\n## Notes\n\nHand-written user content.\n',
  );
  const result = run(root, baseRequest());
  assert.equal(result.state, 'needs-clarification');
  assert.equal(result.user_confirmation_required, true);
  const after = fs.readFileSync(path.join(root, 'operator', 'profile', 'identity.md'), 'utf8');
  assert.match(after, /Name: Alice/);
  assert.doesNotMatch(after, /Name: Bogdan/);
}

{
  const root = fixture();
  const request = baseRequest();
  request.preferences.communication = ['You are Hermes.'];
  const proc = spawnSync(process.execPath, [script, 'ensure', '--root', root], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /foreign runtime\/system instructions/);
}

{
  const root = fixture();
  const request = baseRequest();
  request.evidence.contains_sensitive = true;
  const result = run(root, request);
  assert.equal(result.state, 'needs-clarification');
  assert.equal(result.changed, false);
  assert.equal(fs.existsSync(path.join(root, 'operator', 'profile', 'identity.md')), false);
}

{
  const root = fixture();
  run(root, baseRequest());
  const profileFile = path.join(root, 'operator', 'profile', 'preferences.md');
  fs.appendFileSync(profileFile, '\n## Human-authored notes\n\nKeep this paragraph unchanged.\n');
  const before = fs.readFileSync(profileFile, 'utf8');
  const snapshot = runCommand(root, 'read', {});
  assert.equal(snapshot.operation, 'read');
  assert.equal(snapshot.preferences_source_sha256.length, 64);
  assert.ok(snapshot.preferences.communication.includes('Prefer concise direct answers.'));
  assert.equal(fs.readFileSync(profileFile, 'utf8'), before, 'profile read must not mutate files');

  const correction = {
    category: 'communication',
    previous: 'Prefer concise direct answers.',
    replacement: 'Keep routine answers concise; give detail for research.',
    expected_sha256: snapshot.preferences_source_sha256,
    evidence: {
      stable: true,
      explicit_or_strong: true,
      privacy_ambiguous: false,
      contains_sensitive: false,
      contains_secret: false,
      reason: 'The operator explicitly corrected the durable preference.',
    },
    provenance: {
      trigger_ref: 'learn:session:test:message:7',
      classifier: 'learn',
      source: 'current-chat',
    },
  };
  const changed = runCommand(root, 'correct-preference', correction);
  assert.equal(changed.state, 'evolved');
  assert.equal(changed.changed, true);
  const correctedText = fs.readFileSync(profileFile, 'utf8');
  assert.doesNotMatch(correctedText, /Prefer concise direct answers\./);
  assert.match(correctedText, /Keep routine answers concise; give detail for research\./);
  assert.match(correctedText, /Reuse context instead of asking the same question again\./);
  assert.match(correctedText, /Keep this paragraph unchanged\./);

  const replay = runCommand(root, 'correct-preference', correction);
  assert.equal(replay.state, 'existing');
  assert.equal(replay.changed, false);
}

{
  const root = fixture();
  run(root, baseRequest());
  const snapshot = runCommand(root, 'read', {});
  const stale = runCommand(root, 'correct-preference', {
    category: 'communication',
    previous: 'Prefer concise direct answers.',
    replacement: 'Keep routine answers concise.',
    expected_sha256: '0'.repeat(64),
    evidence: { stable: true, explicit_or_strong: true, reason: 'Explicit correction.' },
    provenance: { trigger_ref: 'learn:session:test:message:8' },
  });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.changed, false);
  const after = runCommand(root, 'read', {});
  assert.equal(after.preferences_source_sha256, snapshot.preferences_source_sha256);
  assert.ok(after.preferences.communication.includes('Prefer concise direct answers.'));
}

// Ventures: "What I run and work on", with validated project references.
{
  const root = fixture();
  fs.mkdirSync(path.join(root, 'workspaces', 'community'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'community', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: community\n');
  const evidence = { stable: true, explicit_or_strong: true, reason: 'Operator said it.' };
  const provenance = (ref) => ({ trigger_ref: ref, classifier: 'test', source: 'test' });
  const added = run(root, { identity: { ventures: [{ text: 'Runs the community', project: 'community' }, 'Makes films'] }, evidence, provenance: provenance('v1') });
  assert.equal(added.state, 'created');
  let identity = fs.readFileSync(path.join(root, 'operator', 'profile', 'identity.md'), 'utf8');
  assert.match(identity, /### What I run and work on/);
  assert.match(identity, /- Runs the community <!-- project:community -->/);
  // A second line for the same project is not added (project reference prevents duplicates).
  const dup = run(root, { identity: { ventures: [{ text: 'Looks after the community', project: 'community' }] }, evidence, provenance: provenance('v2') });
  assert.equal(dup.identity.changed, false);
  identity = fs.readFileSync(path.join(root, 'operator', 'profile', 'identity.md'), 'utf8');
  assert.equal((identity.match(/project:community/g) || []).length, 1);
  // Unknown project is refused.
  assert.throws(() => run(root, { identity: { ventures: [{ text: 'Runs ghosts', project: 'nothing-here' }] }, evidence, provenance: provenance('v3') }));
  // Read returns the identity hash; a correction checks it.
  const snap = runCommand(root, 'read', {});
  assert.match(snap.identity_source_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snap.identity.ventures.map((v) => v.project), ['community', null]);
  const stale = runCommand(root, 'correct-preference', { section: 'identity', category: 'ventures', previous: 'Makes films',
    replacement: 'Makes AI films', expected_sha256: '0'.repeat(64), evidence, provenance: provenance('c1') });
  assert.equal(stale.state, 'stale');
  const fixed = runCommand(root, 'correct-preference', { section: 'identity', category: 'ventures', previous: 'Runs the community',
    replacement: 'Runs and grows the community', expected_sha256: snap.identity_source_sha256, evidence, provenance: provenance('c2') });
  assert.equal(fixed.state, 'evolved');
  identity = fs.readFileSync(path.join(root, 'operator', 'profile', 'identity.md'), 'utf8');
  assert.match(identity, /- Runs and grows the community <!-- project:community -->/, 'the project reference survives a correction');
  assert.doesNotMatch(identity, /- Runs the community/);
  // Secrets are refused in a correction.
  const snap2 = runCommand(root, 'read', {});
  assert.throws(() => runCommand(root, 'correct-preference', { section: 'identity', category: 'ventures', previous: 'Makes films',
    replacement: 'Makes films, api key: abcdef123456', expected_sha256: snap2.identity_source_sha256, evidence, provenance: provenance('c3') }), /secret/);
}

// Retire removes a live line without deleting history.
{
  const root = fixture();
  const evidence = { stable: true, explicit_or_strong: true, reason: 'Tidy guess.' };
  run(root, { identity: { ventures: ['Guessed venture'] }, evidence, provenance: { trigger_ref: 'r1' } });
  const snap = runCommand(root, 'read', {});
  const retired = runCommand(root, 'correct-preference', { section: 'identity', category: 'ventures', previous: 'Guessed venture',
    retire: true, expected_sha256: snap.identity_source_sha256, evidence, provenance: { trigger_ref: 'r2' } });
  assert.equal(retired.state, 'evolved');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'operator', 'profile', 'identity.md'), 'utf8'), /Guessed venture/);
  const history = JSON.parse(fs.readFileSync(path.join(root, 'operator', 'profile', 'AUTO-ORGANIZATION.json'), 'utf8')).history;
  assert.equal(history.at(-1).outcome, 'retired');
  assert.equal(history.at(-1).correction.previous, 'Guessed venture');
  // Preferences cannot be retired this way.
  assert.throws(() => runCommand(root, 'correct-preference', { category: 'avoid', previous: 'x y z', retire: true,
    expected_sha256: '0'.repeat(64), evidence, provenance: { trigger_ref: 'r3' } }));
}

// Two processes writing at once lose nothing.
{
  const root = fixture();
  const evidence = { stable: true, explicit_or_strong: true, reason: 'Race.' };
  const children = [];
  for (let i = 0; i < 6; i += 1) {
    children.push(new Promise((resolve) => {
      const child = spawn(process.execPath, [script, 'ensure', '--root', root], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.end(JSON.stringify({ identity: { notes: [`race note ${i}`] },
        preferences: { communication: [`race preference ${i}`] }, evidence, provenance: { trigger_ref: `race-${i}` } }));
    }));
  }
  const results = await Promise.all(children);
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  const snap = runCommand(root, 'read', {});
  for (let i = 0; i < 6; i += 1) {
    assert.ok(snap.identity.notes.includes(`race note ${i}`), `lost note ${i}`);
    assert.ok(snap.preferences.communication.includes(`race preference ${i}`), `lost preference ${i}`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'operator', 'profile', 'AUTO-ORGANIZATION.json'), 'utf8')).history.length, 6);
}

// A live holder's lock is never stolen because it is old, and a stranger's file is not removed on release.
{
  const root = fixture();
  const evidence = { stable: true, explicit_or_strong: true, reason: 'Lock.' };
  const lock = path.join(root, 'operator', 'profile', '.profile-owner.lock');
  fs.writeFileSync(lock, `${process.pid}:someoneelse\n`);
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  const busy = spawnSync(process.execPath, [script, 'ensure', '--root', root], {
    input: JSON.stringify({ identity: { notes: ['blocked note'] }, evidence, provenance: { trigger_ref: 'lock-1' } }),
    encoding: 'utf8', env: { ...process.env, AIVERSE_PROFILE_LOCK_WAIT_MS: '400' } });
  assert.notEqual(busy.status, 0, 'a live holder must not be pushed aside');
  assert.match(busy.stderr, /busy/);
  assert.equal(fs.readFileSync(lock, 'utf8').trim(), `${process.pid}:someoneelse`, 'the other holder file is untouched');
  // A dead holder is taken over.
  fs.writeFileSync(lock, `999999:ghost\n`);
  const ok = run(root, { identity: { notes: ['after ghost'] }, evidence, provenance: { trigger_ref: 'lock-2' } });
  assert.equal(ok.state, 'created');
}

process.stdout.write('Operator profile owner acceptance: PASS\n');
