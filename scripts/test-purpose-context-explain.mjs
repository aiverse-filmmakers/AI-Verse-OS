#!/usr/bin/env node

import assert from 'node:assert/strict';

import { traverseExplicitTrajectory } from './purpose-context-explain.mjs';

const ref = (scope, kind, id, version = '1') => ({
  owner: 'ai-verse-brain', scope, kind, id, version,
});
const scope = 'workspace:client-a';
const currentWork = ref(scope, 'current-work', 'work-a');
const initiative = ref(scope, 'initiative', 'init-a');
const missingInitiative = ref(scope, 'initiative', 'init-missing');
const orphanInitiative = ref(scope, 'initiative', 'init-orphan');
const unrelatedInitiative = ref(scope, 'initiative', 'init-x');
const strategy = ref(scope, 'intent', 'strategy-a');
const goal = ref(scope, 'intent', 'goal-a');
const missingGoal = ref(scope, 'intent', 'goal-missing');
const mission = ref(scope, 'intent', 'mission-a');
const problem = ref(scope, 'intent', 'problem-a');
const externalGoal = ref('workspace:client-b', 'intent', 'external-goal');

const envelope = {
  schema_version: '1.0',
  scope,
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'client-a' },
  problems: [{ id: 'problem-a', semantic_kind: 'problem', canonical_ref: problem }],
  purpose: {
    missions: [{ id: 'mission-a', semantic_kind: 'mission', canonical_ref: mission }],
    desired_outcomes: [],
  },
  goals: [{ id: 'goal-a', semantic_kind: 'goal', canonical_ref: goal }],
  strategies: [{ id: 'strategy-a', semantic_kind: 'strategy', canonical_ref: strategy }],
  initiatives: [
    { id: 'init-a', semantic_kind: 'initiative', canonical_ref: initiative },
    { id: 'init-missing', semantic_kind: 'initiative', canonical_ref: missingInitiative },
    { id: 'init-orphan', semantic_kind: 'initiative', canonical_ref: orphanInitiative },
    { id: 'init-x', semantic_kind: 'initiative', canonical_ref: unrelatedInitiative },
  ],
  current_work: [{ id: 'work-a', semantic_kind: 'current_work', canonical_ref: currentWork }],
  trajectory: [
    { relation: 'executes', from_ref: currentWork, to_ref: initiative, source_refs: [currentWork] },
    { relation: 'executes', from_ref: initiative, to_ref: strategy, source_refs: [initiative] },
    { relation: 'serves', from_ref: initiative, to_ref: externalGoal, source_refs: [initiative] },
    { relation: 'advances', from_ref: strategy, to_ref: goal, source_refs: [strategy] },
    { relation: 'serves', from_ref: goal, to_ref: mission, source_refs: [goal] },
    { relation: 'addresses', from_ref: mission, to_ref: problem, source_refs: [mission] },
    { relation: 'serves', from_ref: missingInitiative, to_ref: missingGoal, source_refs: [missingInitiative] },
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

assert.deepEqual(result.traversal.edges.map((edge) => [edge.relation, edge.from_ref.id, edge.to_ref.id]), [
  ['executes', 'init-a', 'strategy-a'],
  ['serves', 'init-a', 'external-goal'],
  ['advances', 'strategy-a', 'goal-a'],
  ['serves', 'goal-a', 'mission-a'],
  ['addresses', 'mission-a', 'problem-a'],
]);
assert.deepEqual(result.traversal.cycle_rejections, []);

// Task 2: deterministic causal lineage reaches only owner-backed strategic roots.
const completePath = result.traversal.paths[0];
assert.equal(completePath.primary, true);
assert.equal(completePath.status, 'complete');
assert.equal(completePath.termination_reason, 'trajectory_root');
assert.deepEqual(completePath.selectors, [
  'initiative:init-a', 'strategy:strategy-a', 'goal:goal-a', 'mission:mission-a', 'problem:problem-a',
]);
assert.deepEqual(completePath.relations, ['executes', 'advances', 'serves', 'addresses']);
assert.equal(completePath.terminal_selector, 'problem:problem-a');

const boundaryPath = result.traversal.paths[1];
assert.equal(boundaryPath.primary, false);
assert.equal(boundaryPath.status, 'partial');
assert.equal(boundaryPath.termination_reason, 'scope_boundary');
assert.deepEqual(boundaryPath.terminal_ref, externalGoal);

const workResult = traverseExplicitTrajectory(envelope, 'current_work:work-a');
assert.deepEqual(workResult.traversal.paths[0].selectors, [
  'current_work:work-a',
  'initiative:init-a',
  'strategy:strategy-a',
  'goal:goal-a',
  'mission:mission-a',
  'problem:problem-a',
]);
assert.deepEqual(workResult.traversal.paths[0].relations, ['executes', 'executes', 'advances', 'serves', 'addresses']);

// Task 3: missing links and orphans remain visible and are never repaired by inference.
const missingResult = traverseExplicitTrajectory(envelope, 'initiative:init-missing');
assert.equal(missingResult.traversal.paths.length, 1);
assert.equal(missingResult.traversal.paths[0].status, 'partial');
assert.equal(missingResult.traversal.paths[0].termination_reason, 'missing_parent');
assert.equal(missingResult.traversal.paths[0].terminal_selector, 'initiative:init-missing');
assert.deepEqual(missingResult.traversal.paths[0].terminal_ref, missingGoal);
assert.deepEqual(missingResult.traversal.missing_links, [{
  reason: 'missing_parent_node',
  relation: 'serves',
  from_ref: missingInitiative,
  to_ref: missingGoal,
  source_refs: [missingInitiative],
}]);
assert.equal(JSON.stringify(missingResult).includes('goal:goal-missing'), false);

const orphanResult = traverseExplicitTrajectory(envelope, 'initiative:init-orphan');
assert.deepEqual(orphanResult.traversal.paths, [{
  primary: true,
  status: 'orphan',
  termination_reason: 'trajectory_orphan',
  linkage_state: 'orphan',
  linkage_reason: 'no_valid_parent_relation',
  selectors: ['initiative:init-orphan'],
  relations: [],
  hops: [],
  terminal_selector: 'initiative:init-orphan',
}]);
assert.deepEqual(orphanResult.traversal.missing_links, []);

// Task 4: every explain hop preserves exact owner refs and authoritative source refs.
assert.deepEqual(completePath.hops, [
  {
    relation: 'executes',
    from_ref: initiative,
    to_ref: strategy,
    source_refs: [initiative],
    from_selector: 'initiative:init-a',
    to_selector: 'strategy:strategy-a',
  },
  {
    relation: 'advances',
    from_ref: strategy,
    to_ref: goal,
    source_refs: [strategy],
    from_selector: 'strategy:strategy-a',
    to_selector: 'goal:goal-a',
  },
  {
    relation: 'serves',
    from_ref: goal,
    to_ref: mission,
    source_refs: [goal],
    from_selector: 'goal:goal-a',
    to_selector: 'mission:mission-a',
  },
  {
    relation: 'addresses',
    from_ref: mission,
    to_ref: problem,
    source_refs: [mission],
    from_selector: 'mission:mission-a',
    to_selector: 'problem:problem-a',
  },
]);
assert.deepEqual(boundaryPath.hops, [{
  relation: 'serves',
  from_ref: initiative,
  to_ref: externalGoal,
  source_refs: [initiative],
  from_selector: 'initiative:init-a',
}]);
assert.deepEqual(missingResult.traversal.paths[0].hops, [{
  relation: 'serves',
  from_ref: missingInitiative,
  to_ref: missingGoal,
  source_refs: [missingInitiative],
  from_selector: 'initiative:init-missing',
}]);
for (const path of [completePath, boundaryPath, missingResult.traversal.paths[0]]) {
  for (const hop of path.hops) {
    assert.equal(typeof hop.from_ref.owner, 'string');
    assert.equal(typeof hop.to_ref.owner, 'string');
    assert.ok(hop.source_refs.length > 0);
  }
}

// Task 5: structural SCC edges are rejected before authoritative traversal.
const cycleA = ref(scope, 'intent', 'cycle-a');
const cycleB = ref(scope, 'intent', 'cycle-b');
const cycleEnvelope = {
  schema_version: '1.0',
  scope,
  scope_kind: 'workspace',
  identity: { kind: 'workspace', id: 'client-a' },
  strategies: [
    { id: 'cycle-a', semantic_kind: 'strategy', canonical_ref: cycleA },
    { id: 'cycle-b', semantic_kind: 'strategy', canonical_ref: cycleB },
  ],
  trajectory: [
    { relation: 'advances', from_ref: cycleA, to_ref: cycleB, source_refs: [cycleA] },
    { relation: 'advances', from_ref: cycleB, to_ref: cycleA, source_refs: [cycleB] },
  ],
  provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-07T00:00:00Z', owner_reads: [] },
};
const cycleResult = traverseExplicitTrajectory(cycleEnvelope, 'strategy:cycle-a');
assert.deepEqual(cycleResult.traversal.edges, []);
assert.deepEqual(cycleResult.traversal.reached_refs, []);
assert.equal(cycleResult.traversal.cycle_rejections.length, 2);
assert.deepEqual(cycleResult.traversal.cycle_rejections.map((edge) => [edge.reason, edge.from_ref.id, edge.to_ref.id]), [
  ['structural_cycle', 'cycle-a', 'cycle-b'],
  ['structural_cycle', 'cycle-b', 'cycle-a'],
]);
assert.equal(cycleResult.traversal.paths.length, 1);
assert.equal(cycleResult.traversal.paths[0].status, 'partial');
assert.equal(cycleResult.traversal.paths[0].termination_reason, 'cycle_rejected');
assert.deepEqual(cycleResult.traversal.paths[0].terminal_ref, cycleB);
assert.deepEqual(cycleResult.traversal.paths[0].hops, [{
  relation: 'advances',
  from_ref: cycleA,
  to_ref: cycleB,
  source_refs: [cycleA],
  from_selector: 'strategy:cycle-a',
  to_selector: 'strategy:cycle-b',
}]);

// Valid same-kind supersession cycles are also removed from the structural graph,
// while supersedes remains contextual rather than a normal causal parent.
const oldGoal = ref(scope, 'intent', 'goal-old');
const newGoal = ref(scope, 'intent', 'goal-new');
const supersessionCycle = {
  schema_version: '1.0', scope, scope_kind: 'workspace', identity: { kind: 'workspace', id: 'client-a' },
  goals: [
    { id: 'goal-old', semantic_kind: 'goal', canonical_ref: oldGoal },
    { id: 'goal-new', semantic_kind: 'goal', canonical_ref: newGoal },
  ],
  trajectory: [
    { relation: 'supersedes', from_ref: oldGoal, to_ref: newGoal, source_refs: [oldGoal] },
    { relation: 'supersedes', from_ref: newGoal, to_ref: oldGoal, source_refs: [newGoal] },
  ],
  provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-07T00:00:00Z', owner_reads: [] },
};
const supersessionResult = traverseExplicitTrajectory(supersessionCycle, 'goal:goal-old');
assert.deepEqual(supersessionResult.traversal.edges, []);
assert.equal(supersessionResult.traversal.cycle_rejections.length, 2);
assert.equal(supersessionResult.traversal.paths[0].termination_reason, 'trajectory_root');

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
