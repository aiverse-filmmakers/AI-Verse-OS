#!/usr/bin/env node

import assert from 'node:assert/strict';

import { traverseExplicitTrajectory } from './purpose-context-explain.mjs';

const ref = (scope, kind, id, version = '1') => ({
  owner: 'ai-verse-brain', scope, kind, id, version,
});
const scope = 'workspace:client-a';
const initiative = ref(scope, 'initiative', 'init-a');
const unrelatedInitiative = ref(scope, 'initiative', 'init-x');
const strategy = ref(scope, 'intent', 'strategy-a');
const goal = ref(scope, 'intent', 'goal-a');
const mission = ref(scope, 'intent', 'mission-a');
const externalGoal = ref('workspace:client-b', 'intent', 'external-goal');

const envelope = {
  schema_version: '1.0',
  scope,
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'client-a' },
  purpose: {
    missions: [{ id: 'mission-a', semantic_kind: 'mission', canonical_ref: mission }],
    desired_outcomes: [],
  },
  goals: [{ id: 'goal-a', semantic_kind: 'goal', canonical_ref: goal }],
  strategies: [{ id: 'strategy-a', semantic_kind: 'strategy', canonical_ref: strategy }],
  initiatives: [
    { id: 'init-a', semantic_kind: 'initiative', canonical_ref: initiative },
    { id: 'init-x', semantic_kind: 'initiative', canonical_ref: unrelatedInitiative },
  ],
  trajectory: [
    { relation: 'executes', from_ref: initiative, to_ref: strategy, source_refs: [initiative] },
    { relation: 'serves', from_ref: initiative, to_ref: externalGoal, source_refs: [initiative] },
    { relation: 'advances', from_ref: strategy, to_ref: goal, source_refs: [strategy] },
    { relation: 'serves', from_ref: goal, to_ref: mission, source_refs: [goal] },
    { relation: 'advances', from_ref: unrelatedInitiative, to_ref: goal, source_refs: [unrelatedInitiative] },
    { relation: 'imagines', from_ref: initiative, to_ref: goal, source_refs: [initiative] },
    { relation: 'serves', from_ref: externalGoal, to_ref: goal, source_refs: [externalGoal] },
  ],
  provenance: {
    projection_owner: 'ai-verse-os',
    generated_at: '2026-10-07T00:00:00Z',
    owner_reads: [],
  },
};

const result = traverseExplicitTrajectory(envelope, 'initiative:init-a');
assert.equal(result.scope, scope);
assert.equal(result.selector, 'initiative:init-a');
assert.equal(result.start.semantic_kind, 'initiative');
assert.deepEqual(result.start.canonical_ref, initiative);

// Storage kind differs from semantic kind for Brain intent subtypes. Exact selector
// resolution uses semantic identity, then traversal uses the full canonical ref tuple.
assert.deepEqual(result.traversal.edges.map((edge) => [edge.relation, edge.from_ref.id, edge.to_ref.id]), [
  ['executes', 'init-a', 'strategy-a'],
  ['serves', 'init-a', 'external-goal'],
  ['advances', 'strategy-a', 'goal-a'],
  ['serves', 'goal-a', 'mission-a'],
]);

// Unrelated, unsupported, and incoming sibling-source edges are never traversed.
const serialized = JSON.stringify(result);
assert.equal(serialized.includes('init-x'), false);
assert.equal(serialized.includes('imagines'), false);
assert.deepEqual(result.traversal.terminal_refs, [externalGoal]);

// Explicit external refs remain terminal refs. Traversal never scans/resolves their scope.
assert.equal(result.traversal.reached_refs.some((item) => item.scope === 'workspace:client-b'), true);
assert.equal(result.traversal.edges.some((edge) => edge.from_ref.scope === 'workspace:client-b'), false);

// No fuzzy or partial selector resolution.
assert.throws(() => traverseExplicitTrajectory(envelope, 'initiative:init'), /node not found/);
assert.throws(() => traverseExplicitTrajectory(envelope, 'initiative:../init-a'), /invalid Purpose trajectory ref selector/);
assert.throws(() => traverseExplicitTrajectory(envelope, 'unknown:init-a'), /invalid Purpose trajectory ref selector/);

process.stdout.write('Purpose Context explicit explain traversal: PASS\n');
