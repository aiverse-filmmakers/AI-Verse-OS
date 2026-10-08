import assert from 'node:assert/strict';

import {
  MATERIALITY_DIMENSIONS,
  PURPOSE_MATERIAL_CHANGE_LIMITS,
  classifyPurposeMaterialChanges,
} from './purpose-material-change-classifier.mjs';

const scope = 'workspace:ai-verse';
const osRef = (id) => ({ owner: 'ai-verse-os', scope, kind: 'event', id });
const classified = classifyPurposeMaterialChanges(scope, [
  {
    scope,
    activity: 'opened_dashboard',
    payload: { raw: 'ordinary activity must not become Purpose history' },
  },
  {
    scope,
    occurred_at: 'not-a-date',
    event: '',
    effect: '',
    materiality: [],
    raw_event: { noisy: true },
  },
  {
    scope,
    occurred_at: '2026-10-08T09:00:00Z',
    event: 'Goal moved from active to blocked',
    effect: 'Current execution can no longer advance Goal G until the dependency clears.',
    materiality: ['goal_status', 'blocker_state', 'blocker_state'],
    source_refs: [osRef('goal-blocked-1')],
    raw_event: { must_not_cross: true },
  },
  {
    scope,
    occurred_at: '2026-10-08T11:00:00Z',
    event: 'Priority order changed',
    effect: 'Initiative B now precedes Initiative A.',
    materiality: ['priority'],
    source_refs: [osRef('priority-change-1')],
  },
  {
    scope,
    occurred_at: '2026-10-08T10:00:00Z',
    event: 'KPI crossed failure threshold',
    effect: 'The current strategy requires review before further scaling.',
    materiality: ['kpi_threshold', 'strategy_validity'],
    source_refs: [osRef('kpi-threshold-1')],
  },
]);

assert.equal(classified.schema_version, 'purpose.material-changes.v1');
assert.equal(classified.scope, scope);
assert.equal(classified.candidate_count, 5);
assert.equal(classified.excluded_non_material_count, 2);
assert.equal(classified.truncated, false);
assert.equal(classified.changes.length, 3);
assert.deepEqual(classified.changes.map((item) => item.event), [
  'Priority order changed',
  'KPI crossed failure threshold',
  'Goal moved from active to blocked',
]);
assert.deepEqual(classified.changes[2].materiality, ['blocker_state', 'goal_status']);
assert.deepEqual(classified.changes[2].source_refs, [osRef('goal-blocked-1')]);
assert.equal(Object.hasOwn(classified.changes[2], 'raw_event'), false);
assert.equal(Object.hasOwn(classified.changes[0], 'payload'), false);

assert.deepEqual(MATERIALITY_DIMENSIONS, [
  'goal_status',
  'priority',
  'feasibility',
  'blocker_state',
  'strategy_validity',
  'risk',
  'kpi_trend',
  'kpi_threshold',
  'initiative_status',
  'scope',
  'direction_ownership',
]);
assert.deepEqual(PURPOSE_MATERIAL_CHANGE_LIMITS, {
  max_candidates: 64,
  max_changes: 20,
  max_source_refs: 8,
  max_affects_refs: 8,
});

assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    scope,
    occurred_at: '2026-10-08T12:00:00Z',
    event: 'Unknown material event',
    effect: 'Must fail closed rather than invent a category.',
    materiality: ['engagement_noise'],
  }]),
  /unsupported materiality dimension engagement_noise/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    scope: 'workspace:other',
    materiality: [],
  }]),
  /scope does not match Purpose scope/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, Array.from({ length: 65 }, () => ({ scope, materiality: [] }))),
  /exceed hard cap 64/,
);

const many = classifyPurposeMaterialChanges('operator', Array.from({ length: 21 }, (_, index) => ({
  scope: 'operator',
  occurred_at: new Date(Date.UTC(2026, 9, 8, 0, index)).toISOString(),
  event: `Material event ${index}`,
  effect: `Material effect ${index}`,
  materiality: ['risk'],
  source_refs: [{ owner: 'ai-verse-os', scope: 'operator', kind: 'event', id: `risk-${index}` }],
})));
assert.equal(many.changes.length, 20);
assert.equal(many.truncated, true);
assert.equal(many.changes[0].event, 'Material event 20');
assert.equal(many.changes.at(-1).event, 'Material event 1');

process.stdout.write('Purpose material-change classifier: PASS\n');
