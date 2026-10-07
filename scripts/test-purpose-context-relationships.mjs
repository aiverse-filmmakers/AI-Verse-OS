#!/usr/bin/env node

import assert from 'node:assert/strict';
import { filterExplicitScopeRelationships } from './purpose-context-profile.mjs';

const ref = (scope, kind, id) => ({ owner: 'ai-verse-brain', scope, kind, id, version: '1' });
const source = ref('workspace:client-a', 'initiative', 'initiative-a');
const goal = ref('workspace:client-a', 'intent', 'goal-a');
const parentGoal = ref('operator', 'intent', 'parent-goal');
const siblingGoal = ref('workspace:client-b', 'intent', 'sibling-goal');

const envelope = {
  schema_version: '1.0',
  scope: 'workspace:client-a',
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'client-a' },
  initiatives: [{ id: 'initiative-a', semantic_kind: 'initiative', canonical_ref: source }],
  goals: [{ id: 'goal-a', semantic_kind: 'goal', canonical_ref: goal }],
  trajectory: [
    { relation: 'serves', from_ref: source, to_ref: goal, source_refs: [source] },
    { relation: 'advances', from_ref: source, to_ref: parentGoal, source_refs: [source] },
    { relation: 'serves', from_ref: source, to_ref: siblingGoal, source_refs: [source] },
    { relation: 'imagines', from_ref: source, to_ref: goal, source_refs: [source] },
    { relation: 'serves', from_ref: siblingGoal, to_ref: goal, source_refs: [siblingGoal] },
    { relation: 'serves', from_ref: source, to_ref: source, source_refs: [source] },
    { relation: 'serves', from_ref: source, to_ref: { owner: 'ai-verse-brain', scope: 'workspace:../escape', kind: 'intent', id: 'x' }, source_refs: [source] },
    { relation: 'serves', from_ref: source, to_ref: goal, source_refs: [] },
  ],
  provenance: {
    projection_owner: 'ai-verse-os',
    generated_at: '2026-10-07T00:00:00Z',
    owner_reads: [{
      owner: 'ai-verse-brain',
      canonical_refs: [source, goal, parentGoal, siblingGoal],
    }],
  },
};

const { envelope: filtered, rejected } = filterExplicitScopeRelationships(envelope);
assert.equal(filtered.trajectory.length, 3);
assert.deepEqual(filtered.trajectory.map((edge) => edge.to_ref.scope), [
  'workspace:client-a',
  'operator',
  'workspace:client-b',
]);
assert.ok(rejected.some((item) => item.reason === 'unsupported_relation'));
assert.ok(rejected.some((item) => item.reason === 'source_scope_mismatch'));
assert.ok(rejected.some((item) => item.reason === 'self_edge'));
assert.ok(rejected.some((item) => item.reason === 'noncanonical_ref'));
assert.ok(rejected.some((item) => item.reason === 'missing_source_refs'));

// Explicit cross-scope refs are retained as refs only. The filter does not resolve,
// inherit from, enumerate, or ingest the referenced operator/sibling scope.
assert.equal(JSON.stringify(filtered).includes('implicit_parent'), false);
assert.equal(filtered.trajectory[1].to_ref.id, 'parent-goal');
assert.equal(filtered.trajectory[2].to_ref.id, 'sibling-goal');

process.stdout.write('Purpose Context explicit scope relationships: PASS\n');
