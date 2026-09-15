#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'operator-profile-owner.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-profile-owner-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  fs.mkdirSync(path.join(root, 'operator', 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  return root;
}

function run(root, request) {
  const proc = spawnSync(process.execPath, [script, 'ensure', '--root', root], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout || `exit ${proc.status}`);
  return JSON.parse(proc.stdout);
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

process.stdout.write('Operator profile owner acceptance: PASS\n');
