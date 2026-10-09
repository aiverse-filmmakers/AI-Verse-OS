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

function setBrainOwner(root, scope) {
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: {
      [scope]: {
        owner: 'brain',
        state: 'active',
        handover_id: 'semantic-acceptance',
        brain_refs: ['brain:intent:mission-1', 'brain:intent:goal-1', 'brain:intent:strategy-1'],
      },
    },
  }), 'utf8');
}

function brainSnapshot(scope) {
  const mission = {
    id: 'mission-1', kind: 'intent', semantic_kind: 'mission', scope, status: 'ACTIVE', revision: 2,
    canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission-1', version: '2' },
    payload: { subtype: 'mission', statement: 'Build an owner-backed AI operating system' },
  };
  const goal = {
    id: 'goal-1', kind: 'intent', semantic_kind: 'goal', scope, status: 'ACTIVE', revision: 5,
    canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'goal-1', version: '5' },
    payload: { subtype: 'goal', statement: 'Complete Purpose Context acceptance' },
  };
  const strategy = {
    id: 'strategy-1', kind: 'intent', semantic_kind: 'strategy', scope, status: 'ACTIVE', revision: 3,
    canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'strategy-1', version: '3' },
    payload: { subtype: 'strategy', statement: 'Keep every projection tied to canonical owners' },
  };
  return {
    schema_version: '1.0', scope, direction_owner: 'brain', status: 'ok', read_states: {},
    strategic_objects: { intents: [mission, goal, strategy], gaps: [], initiatives: [] },
    relationships: [{
      relation: 'advances',
      from_ref: strategy.canonical_ref,
      to_ref: goal.canonical_ref,
      source_refs: [strategy.canonical_ref],
    }],
    relationship_rejections: [],
  };
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

// Slice 11.3 Scenario 2: operator with Brain-owned strategic direction.
{
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
      '## Current priorities', '', '- STALE OS STRATEGIC DIRECTION', '',
      '## Current state', '', '- Operational runtime remains healthy', '',
    ].join('\n'), 'utf8');
    setBrainOwner(root, 'operator');

    const envelope = composeProfiledPurposeContext(root, 'operator', {
      now: '2026-10-09T01:05:00.000Z',
      readBrainPurposeSnapshot(scope) {
        return brainSnapshot(scope);
      },
    });

    assert.equal(envelope.purpose.missions[0].payload.statement, 'Build an owner-backed AI operating system');
    assert.equal(envelope.goals[0].payload.statement, 'Complete Purpose Context acceptance');
    assert.equal(envelope.strategies[0].payload.statement, 'Keep every projection tied to canonical owners');
    assert.equal(envelope.trajectory[0].relation, 'advances');
    assert.equal('priorities' in envelope, false);
    assert.doesNotMatch(JSON.stringify(envelope), /STALE OS STRATEGIC DIRECTION/);
    const brainRead = envelope.provenance.owner_reads.find((read) => read.owner === 'ai-verse-brain');
    const osRead = envelope.provenance.owner_reads.find((read) => read.owner === 'ai-verse-os');
    assert.ok(brainRead);
    assert.ok(osRead);
    assert.equal(brainRead.status, 'ok');
    assert.equal(envelope.provenance.profile.resolved, 'operator_default');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('Purpose Context semantic acceptance through Scenario 11.3.2: PASS\n');
