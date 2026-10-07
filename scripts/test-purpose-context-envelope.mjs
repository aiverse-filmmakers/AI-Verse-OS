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

  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), '## Current priorities\n\n- STALE OS PRIORITY\n\n## Current state\n\n- operational fact\n');
  brainOwner(root, 'operator');
  const brainEnvelope = composePurposeContext(root, 'operator', {
    now,
    readBrainPurposeSnapshot(scope) {
      return {
        schema_version: '1.0', scope, direction_owner: 'brain', status: 'ok', read_states: {},
        strategic_objects: {
          intents: [
            { id: 'problem-1', kind: 'intent', semantic_kind: 'problem', scope, status: 'ACTIVE', revision: 2, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'problem-1', version: '2' }, payload: { subtype: 'problem', statement: 'Context fragmentation' } },
            { id: 'mission-1', kind: 'intent', semantic_kind: 'mission', scope, status: 'ACTIVE', revision: 3, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission-1', version: '3' }, payload: { subtype: 'mission', statement: 'Build personal AI OS' } },
            { id: 'strategy-1', kind: 'intent', semantic_kind: 'strategy', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'strategy-1', version: '1' }, payload: { subtype: 'strategy', statement: 'Use owner-backed projections' } },
          ],
          gaps: [{ id: 'gap-1', kind: 'gap', semantic_kind: 'challenge', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'gap', id: 'gap-1', version: '1' }, payload: { interpretation: 'Agent loses big picture' } }],
          initiatives: [{ id: 'init-1', kind: 'initiative', semantic_kind: 'initiative', scope, status: 'ACTIVE', revision: 1, canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'init-1', version: '1' }, payload: { outcome: 'Purpose Context' } }],
        },
        relationships: [{ relation: 'serves', from_ref: { owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'init-1', version: '1' }, to_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission-1', version: '3' } }],
        relationship_rejections: [],
      };
    },
  });
  assert.equal(brainEnvelope.problems[0].payload.statement, 'Context fragmentation');
  assert.equal(brainEnvelope.purpose.missions[0].payload.statement, 'Build personal AI OS');
  assert.equal(brainEnvelope.strategies[0].payload.statement, 'Use owner-backed projections');
  assert.equal(brainEnvelope.challenges[0].id, 'gap-1');
  assert.equal(brainEnvelope.initiatives[0].id, 'init-1');
  assert.equal(brainEnvelope.trajectory[0].relation, 'serves');
  assert.equal(brainEnvelope.provenance.owner_reads.length, 2);
  assert.doesNotMatch(JSON.stringify(brainEnvelope), /STALE OS PRIORITY/);

  process.stdout.write('Purpose Context v1 envelope composition: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
