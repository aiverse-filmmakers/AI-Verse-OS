import assert from 'node:assert/strict';

import { classifyPurposeMaterialChanges } from './purpose-material-change-classifier.mjs';
import { applyPurposeMaterialChangeRelevance } from './purpose-material-change-relevance.mjs';

const scope = 'workspace:ai-verse';
const goalRef = { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'goal-growth', version: '7' };
const strategyRef = { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'strategy-paid-growth', version: '4' };
const memoryRef = { owner: 'ai-verse-memory', scope, kind: 'memory', id: 'memory-42', version: 'memory-v42' };
const dataRef = { owner: 'ai-verse-data', spaceId: 'ai-verse', entity: 'metric', recordId: 'conversion-rate', field: 'value' };

const historicalEvidence = [{
  kind: 'historical_evidence',
  evidence_role: 'historical',
  authoritative_for_current_state: false,
  occurred_at: '2026-09-30T09:00:00Z',
  statement: 'Paid growth was previously viable under the old conversion rate.',
  source_refs: [memoryRef],
}];

const envelope = {
  schema_version: '1.0',
  scope,
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'ai-verse' },
  goals: [{
    id: 'goal-growth',
    semantic_kind: 'goal',
    status: 'ACTIVE',
    canonical_ref: goalRef,
    payload: { statement: 'Grow qualified paid acquisition.' },
  }],
  strategies: [{
    id: 'strategy-paid-growth',
    semantic_kind: 'strategy',
    status: 'ACTIVE',
    canonical_ref: strategyRef,
    payload: { statement: 'Scale paid traffic while conversion remains healthy.' },
  }],
  historical_evidence: historicalEvidence,
  provenance: {
    projection_owner: 'ai-verse-os',
    generated_at: '2026-10-08T12:00:00Z',
    owner_reads: [],
  },
};

const originalEnvelope = structuredClone(envelope);
const originalHistory = structuredClone(historicalEvidence);

const changes = classifyPurposeMaterialChanges(scope, [
  {
    scope,
    occurred_at: '2026-10-08T09:00:00Z',
    event: 'Paid-growth strategy recovered',
    effect: 'The strategy became viable again for a period.',
    materiality: ['strategy_validity'],
    source_refs: [strategyRef, dataRef],
    affects: [strategyRef],
    relevance_effect: 'restored',
  },
  {
    scope,
    occurred_at: '2026-10-08T11:00:00Z',
    event: 'Conversion rate crossed the failure threshold',
    effect: 'Paid-growth strategy should no longer guide current execution.',
    materiality: ['kpi_threshold', 'strategy_validity'],
    source_refs: [strategyRef, dataRef, memoryRef],
    affects: [strategyRef],
    relevance_effect: 'invalidated',
  },
  {
    scope,
    occurred_at: '2026-10-08T10:00:00Z',
    event: 'Goal became blocked by acquisition economics',
    effect: 'The growth goal remains canonical but should be treated as blocked in current prioritization.',
    materiality: ['blocker_state', 'goal_status'],
    source_refs: [goalRef, dataRef],
    affects: [goalRef],
    relevance_effect: 'blocked',
  },
]);

assert.equal(changes.changes.length, 3);
assert.equal(changes.changes[0].event, 'Conversion rate crossed the failure threshold');
assert.equal(changes.changes[2].event, 'Paid-growth strategy recovered');

const projected = applyPurposeMaterialChangeRelevance(envelope, changes);

assert.deepEqual(envelope, originalEnvelope, 'projection must not mutate the input envelope');
assert.deepEqual(projected.historical_evidence, originalHistory, 'historical evidence must remain byte-equivalent in structure and content');
assert.equal(projected.goals[0].status, 'ACTIVE', 'canonical owner status must not be rewritten');
assert.equal(projected.strategies[0].status, 'ACTIVE', 'canonical owner status must not be rewritten');
assert.deepEqual(projected.goals[0].canonical_ref, goalRef);
assert.deepEqual(projected.strategies[0].canonical_ref, strategyRef);

assert.deepEqual(projected.goals[0].purpose_relevance, {
  projection_only: true,
  authoritative_for_owner_state: false,
  state: 'blocked',
  as_of: '2026-10-08T10:00:00Z',
  materiality: ['blocker_state', 'goal_status'],
  source_refs: [
    goalRef,
    dataRef,
  ],
});
assert.deepEqual(projected.strategies[0].purpose_relevance, {
  projection_only: true,
  authoritative_for_owner_state: false,
  state: 'invalidated',
  as_of: '2026-10-08T11:00:00Z',
  materiality: ['kpi_threshold', 'strategy_validity'],
  source_refs: [
    strategyRef,
    memoryRef,
    dataRef,
  ],
});

assert.equal(projected.recent_material_changes.length, 3, 'older material facts remain visible rather than being rewritten away');
assert.equal(projected.recent_material_changes[2].relevance_effect, 'restored');
assert.deepEqual(projected.section_states.material_change_relevance, {
  state: 'ok',
  applied_count: 2,
  unmatched_target_count: 0,
});

const unknownRef = { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'missing-goal', version: '1' };
const withMissingTarget = classifyPurposeMaterialChanges(scope, [{
  scope,
  occurred_at: '2026-10-08T12:00:00Z',
  event: 'Unknown target changed',
  effect: 'Projection must expose the missing exact target instead of guessing.',
  materiality: ['goal_status'],
  source_refs: [goalRef],
  affects: [unknownRef],
  relevance_effect: 'blocked',
}]);
const partial = applyPurposeMaterialChangeRelevance(envelope, withMissingTarget);
assert.equal(partial.section_states.material_change_relevance.state, 'partial');
assert.deepEqual(partial.section_states.material_change_relevance.unmatched_refs, [unknownRef]);
assert.equal(Object.hasOwn(partial.goals[0], 'purpose_relevance'), false);

assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    scope,
    occurred_at: '2026-10-08T12:30:00Z',
    event: 'Cross-scope target',
    effect: 'Must fail closed.',
    materiality: ['goal_status'],
    source_refs: [goalRef],
    affects: [{ ...goalRef, scope: 'workspace:other' }],
    relevance_effect: 'blocked',
  }]),
  /affects\[0\]\.scope does not match Purpose scope/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    scope,
    occurred_at: '2026-10-08T12:30:00Z',
    event: 'Memory cannot be current target',
    effect: 'Must fail closed.',
    materiality: ['strategy_validity'],
    source_refs: [memoryRef],
    affects: [memoryRef],
    relevance_effect: 'invalidated',
  }]),
  /cannot be a current strategic relevance target/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    scope,
    occurred_at: '2026-10-08T12:30:00Z',
    event: 'Missing relevance effect',
    effect: 'Must fail closed.',
    materiality: ['strategy_validity'],
    source_refs: [strategyRef],
    affects: [strategyRef],
  }]),
  /relevance_effect must be a non-empty string/,
);

process.stdout.write('Purpose material-change relevance overlay: PASS\n');
