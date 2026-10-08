#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composeProfiledPurposeContext } from './purpose-context-profile.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-semantic-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- Ship owner-backed Purpose Context', '',
    '## Current state', '', '- Phase 11 acceptance is active', '',
  ].join('\n'), 'utf8');
  return root;
}

// Slice 11.3 Scenario 1: operator with OS-owned strategic direction.
{
  const root = makeRoot();
  try {
    const envelope = composeProfiledPurposeContext(root, 'operator', {
      now: '2026-10-09T01:00:00.000Z',
    });
    assert.equal(envelope.scope, 'operator');
    assert.equal(envelope.scope_kind, 'operator');
    assert.deepEqual(envelope.identity, { kind: 'operator', id: 'operator' });
    assert.equal(envelope.priorities[0].statement, 'Ship owner-backed Purpose Context');
    assert.equal(envelope.current_state[0].statement, 'Phase 11 acceptance is active');
    assert.equal(envelope.provenance.projection_owner, 'ai-verse-os');
    assert.equal(envelope.provenance.profile.resolved, 'operator_default');
    const osRead = envelope.provenance.owner_reads.find((read) => read.owner === 'ai-verse-os');
    assert.ok(osRead);
    assert.equal(osRead.operation, 'current-context.read');
    assert.equal(envelope.provenance.owner_reads.some((read) => read.owner === 'ai-verse-brain'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('Purpose Context semantic acceptance through Scenario 11.3.1: PASS\n');
