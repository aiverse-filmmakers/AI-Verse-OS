#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composePurposeContext } from './purpose-context-core.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-envelope-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'film', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: film\n');
  return root;
}

function brainOwner(root, scope) {
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: { [scope]: { owner: 'brain', state: 'active', handover_id: 'purpose-envelope', brain_refs: ['brain:intent:mission-1'] } },
  }));
}

function brainSnapshot(scope, reverse = false) {
  const intents = [
    { id: 'problem-b', kind: 'intent', semantic_kind: 'problem', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'problem-b', version: '1' }, payload: { subtype: 'problem', statement: 'Second problem' } },
    { id: 'mission-1', kind: 'intent', semantic_kind: 'mission', scope, status: 'ACTIVE', revision: 3, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission-1', version: '3' }, payload: { subtype: 'mission', statement: 'Build personal AI OS' } },
    { id: 'strategy-1', kind: 'intent', semantic_kind: 'strategy', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'strategy-1', version: '1' }, payload: { subtype: 'strategy', statement: 'Use owner-backed projections' } },
    { id: 'problem-a', kind: 'intent', semantic_kind: 'problem', scope, status: 'ACTIVE', revision: 2, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'problem-a', version: '2' }, payload: { subtype: 'problem', statement: 'Context fragmentation' } },
  ];
  const gaps = [
    { id: 'gap-b', kind: 'gap', semantic_kind: 'challenge', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'gap', id: 'gap-b', version: '1' }, payload: { interpretation: 'Second gap' } },
    { id: 'gap-a', kind: 'gap', semantic_kind: 'challenge', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'gap', id: 'gap-a', version: '1' }, payload: { interpretation: 'Agent loses big picture' } },
  ];
  const initiatives = [
    { id: 'init-b', kind: 'initiative', semantic_kind: 'initiative', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'init-b', version: '1' }, payload: { outcome: 'Second initiative' } },
    { id: 'init-a', kind: 'initiative', semantic_kind: 'initiative', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'init-a', version: '1' }, payload: { outcome: 'Purpose Context' } },
  ];
  const relationships = [
    { relation: 'serves', from_ref: initiatives[0].canonical_ref, to_ref: intents[1].canonical_ref, source_refs: [initiatives[0].canonical_ref] },
    { relation: 'serves', from_ref: initiatives[1].canonical_ref, to_ref: intents[1].canonical_ref, source_refs: [initiatives[1].canonical_ref] },
  ];
  if (reverse) {
    intents.reverse();
    gaps.reverse();
    initiatives.reverse();
    relationships.reverse();
  }
  return {
    schema_version: '1.0', scope, direction_owner: 'brain', status: 'ok', read_states: {},
    strategic_objects: { intents, gaps, initiatives },
    relationships,
    relationship_rejections: [],
  };
}

const now = '2026-10-07T07:20:00.000Z';
const root = fixture();
try {
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'context', 'CURRENT.md'), [
    '# Current Workspace Context', '',
    '## Objective', '', 'Ship the film', '',
    '## Current state', '', '- edit in progress', '',
    '## Next useful actions', '', '- finish picture lock', '',
    '## Constraints / approvals', '', '- client approval required', '',
  ].join('\n'));
  const osEnvelope = composePurposeContext(root, 'workspace:film', { now });
  assert.equal(osEnvelope.schema_version, '1.0');
  assert.equal(osEnvelope.scope, 'workspace:film');
  assert.equal(osEnvelope.scope_kind, 'workspace');
  assert.deepEqual(osEnvelope.identity, { kind: 'workspace', id: 'film' });
  assert.equal(osEnvelope.goals[0].statement, 'Ship the film');
  assert.equal(osEnvelope.current_state[0].statement, 'edit in progress');
  assert.equal(osEnvelope.current_work[0].statement, 'finish picture lock');
  assert.equal(osEnvelope.constraints[0].statement, 'client approval required');
  assert.equal(osEnvelope.provenance.projection_owner, 'ai-verse-os');
  assert.equal(osEnvelope.provenance.generated_at, now);
  assert.equal(osEnvelope.provenance.owner_reads[0].operation, 'current-context.read');
  const osRef = { owner: 'ai-verse-os', scope: 'workspace:film', kind: 'current-context', id: 'active' };
  assert.deepEqual(osEnvelope.provenance.owner_reads[0].canonical_refs, [osRef]);
  assert.deepEqual(osEnvelope.goals[0].source_refs, [osRef]);
  assert.deepEqual(osEnvelope.current_state[0].source_refs, [osRef]);
  assert.doesNotMatch(JSON.stringify(osEnvelope.provenance), /CURRENT\.md|workspaces\/film/);

  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), '## Current priorities\n\n- STALE OS PRIORITY\n\n## Current state\n\n- operational fact\n');
  brainOwner(root, 'operator');
  const brainEnvelope = composePurposeContext(root, 'operator', {
    now,
    readBrainPurposeSnapshot(scope) {
      return brainSnapshot(scope, false);
    },
  });
  assert.deepEqual(brainEnvelope.problems.map((item) => item.id), ['problem-a', 'problem-b']);
  assert.equal(brainEnvelope.purpose.missions[0].payload.statement, 'Build personal AI OS');
  assert.equal(brainEnvelope.strategies[0].payload.statement, 'Use owner-backed projections');
  assert.deepEqual(brainEnvelope.challenges.map((item) => item.id), ['gap-a', 'gap-b']);
  assert.deepEqual(brainEnvelope.initiatives.map((item) => item.id), ['init-a', 'init-b']);
  assert.deepEqual(brainEnvelope.trajectory.map((edge) => edge.from_ref.id), ['init-a', 'init-b']);
  assert.equal(brainEnvelope.provenance.owner_reads.length, 2);
  assert.deepEqual(brainEnvelope.purpose.missions[0].canonical_ref, { owner: 'ai-verse-brain', scope: 'operator', kind: 'intent', id: 'mission-1', version: '3' });
  assert.doesNotMatch(JSON.stringify(brainEnvelope), /STALE OS PRIORITY/);

  const reversedEnvelope = composePurposeContext(root, 'operator', {
    now,
    readBrainPurposeSnapshot(scope) {
      return brainSnapshot(scope, true);
    },
  });
  assert.deepEqual(reversedEnvelope.problems, brainEnvelope.problems);
  assert.deepEqual(reversedEnvelope.challenges, brainEnvelope.challenges);
  assert.deepEqual(reversedEnvelope.initiatives, brainEnvelope.initiatives);
  assert.deepEqual(reversedEnvelope.trajectory, brainEnvelope.trajectory);
  assert.deepEqual(reversedEnvelope.provenance.owner_reads[1].canonical_refs, brainEnvelope.provenance.owner_reads[1].canonical_refs);

  const manyStateLines = Array.from({ length: 120 }, (_, index) => `- state ${String(index).padStart(3, '0')} ${'x'.repeat(80)}`);
  fs.rmSync(path.join(root, '.aiverse'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- keep purpose bounded', '',
    '## Current state', '', ...manyStateLines,
  ].join('\n'));
  const bounded = composePurposeContext(root, 'operator', { now, maxBytes: 4096 });
  const boundedBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');
  assert.ok(boundedBytes <= 4096, `bounded projection was ${boundedBytes} bytes`);
  assert.equal(bounded.provenance.budget.max_bytes, 4096);
  assert.equal(bounded.provenance.budget.final_bytes, boundedBytes);
  assert.equal(bounded.provenance.budget.truncated, true);
  assert.ok(bounded.provenance.budget.omissions.some((entry) => entry.section === 'current_state' && entry.omitted_count > 0));
  assert.throws(() => composePurposeContext(root, 'operator', { now, maxBytes: 4095 }), /between 4096 and 65536/);
  assert.throws(() => composePurposeContext(root, 'operator', { now, maxBytes: 65537 }), /between 4096 and 65536/);

  process.stdout.write('Purpose Context v1 envelope/ref/order/budget: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
