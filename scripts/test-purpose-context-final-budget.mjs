#!/usr/bin/env node

import assert from 'node:assert/strict';

import { applyFinalPurposeBudget } from './purpose-context-final-budget.mjs';

const scope = 'workspace:alpha';
const ref = (kind, id) => ({ owner: 'ai-verse-brain', scope, kind, id, version: '1' });
const item = (kind, id, statement) => ({ kind, id, canonical_ref: ref(kind, id), payload: { statement } });
const rich = (kind, prefix) => Array.from({ length: 8 }, (_, index) => ({
  kind,
  statement: `${prefix}-${index} ${'x'.repeat(150)}`,
  source_refs: [{ owner: 'ai-verse-data', scope, kind: 'record', id: `${prefix}-${index}`, version: '1' }],
}));

const mission = item('intent', 'mission-1', 'Keep the strategic mission');
const goal = item('intent', 'goal-1', 'Keep the active goal');
const strategy = item('intent', 'strategy-1', 'Keep the active strategy');
const initiative = item('initiative', 'initiative-1', 'Keep the active initiative');
const trajectory = {
  relation: 'advances',
  from_ref: initiative.canonical_ref,
  to_ref: goal.canonical_ref,
  source_refs: [initiative.canonical_ref],
};

const envelope = {
  schema_version: '1.0',
  scope,
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'alpha' },
  purpose: { missions: [mission], desired_outcomes: [] },
  goals: [goal],
  strategies: [strategy],
  initiatives: [initiative],
  trajectory: [trajectory],
  recent_material_changes: rich('material_change', 'change'),
  risks: rich('risk', 'risk'),
  kpis: rich('kpi', 'kpi'),
  narratives: rich('narrative', 'narrative'),
  provenance: {
    projection_owner: 'ai-verse-os',
    generated_at: '2026-10-08T18:00:00.000Z',
    owner_reads: [{
      owner: 'ai-verse-brain',
      operation: 'purpose-snapshot.read',
      scope,
      status: 'ok',
      freshness: { state: 'current', as_of: '2026-10-08T18:00:00.000Z' },
      canonical_refs: [mission.canonical_ref, goal.canonical_ref, strategy.canonical_ref, initiative.canonical_ref],
    }],
  },
};

const original = structuredClone(envelope);
const bounded = applyFinalPurposeBudget(envelope, 4096);
const bytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8');

assert.ok(bytes <= 4096, `final Purpose projection was ${bytes} bytes`);
assert.deepEqual(envelope, original, 'final budget projection must not mutate its input');
assert.equal(bounded.provenance.budget.policy_version, 'os.purpose-budget-policy.v1');
assert.equal(bounded.provenance.budget.max_bytes, 4096);
assert.equal(bounded.provenance.budget.final_bytes, bytes);
assert.equal(bounded.provenance.budget.truncated, true);
assert.ok(
  bounded.provenance.budget.omissions.some((entry) =>
    ['recent_material_changes', 'risks', 'kpis', 'narratives'].includes(entry.section) &&
    entry.reason === 'final_byte_budget' &&
    entry.omitted_count > 0
  ),
  'optional rich context must absorb byte pressure first',
);

assert.equal(bounded.purpose.missions.length, 1, 'mission must survive optional-rich truncation');
assert.equal(bounded.goals.length, 1, 'goal must survive optional-rich truncation');
assert.equal(bounded.strategies.length, 1, 'strategy must survive optional-rich truncation');
assert.equal(bounded.initiatives.length, 1, 'initiative must survive optional-rich truncation');
assert.equal(bounded.trajectory.length, 1, 'trajectory edge must survive optional-rich truncation');
assert.deepEqual(
  bounded.provenance.owner_reads[0].canonical_refs,
  [mission.canonical_ref, goal.canonical_ref, strategy.canonical_ref, initiative.canonical_ref],
  'retained strategic refs must remain provenance-bearing',
);

const unchanged = applyFinalPurposeBudget({
  schema_version: '1.0',
  scope: 'operator',
  scope_kind: 'operator',
  identity: { kind: 'operator', id: 'operator' },
  provenance: { projection_owner: 'ai-verse-os', owner_reads: [] },
}, 4096);
assert.equal(Object.hasOwn(unchanged.provenance, 'budget'), false, 'in-budget envelopes need no synthetic budget record');

process.stdout.write('Purpose Context final budget trajectory preservation: PASS\n');
