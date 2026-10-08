import assert from 'node:assert/strict';

import { classifyPurposeMaterialChanges } from './purpose-material-change-classifier.mjs';

const scope = 'workspace:ai-verse';
const base = {
  scope,
  occurred_at: '2026-10-08T12:00:00Z',
  event: 'Material owner-backed change',
  effect: 'Purpose relevance changed because an owner-backed fact changed.',
  materiality: ['feasibility'],
};

const projected = classifyPurposeMaterialChanges(scope, [{
  ...base,
  source_refs: [
    {
      owner: 'ai-verse-os',
      scope,
      kind: 'direction_ownership',
      id: 'workspace-ai-verse-owner-change',
      internal_path: '/must/not/leak',
    },
    {
      owner: 'ai-verse-memory',
      scope,
      kind: 'memory',
      id: 'memory-history-7',
      version: 'memory-source-v7',
      excerpt: 'must not leak through the ref',
    },
    {
      owner: 'ai-verse-data',
      spaceId: 'ai-verse',
      entity: 'metric',
      recordId: 'conversion-rate',
      field: 'value',
      raw_record: { must_not_leak: true },
    },
    {
      owner: 'ai-verse-brain',
      scope,
      kind: 'goal',
      id: 'goal-growth',
      version: 'goal-v3',
      private_state: true,
    },
    {
      owner: 'ai-verse-brain',
      scope,
      kind: 'goal',
      id: 'goal-growth',
      version: 'goal-v3',
    },
  ],
}]);

assert.equal(projected.changes.length, 1);
assert.deepEqual(projected.changes[0].source_refs, [
  { owner: 'ai-verse-brain', scope, kind: 'goal', id: 'goal-growth', version: 'goal-v3' },
  { owner: 'ai-verse-memory', scope, kind: 'memory', id: 'memory-history-7', version: 'memory-source-v7' },
  { owner: 'ai-verse-os', scope, kind: 'direction_ownership', id: 'workspace-ai-verse-owner-change' },
  { owner: 'ai-verse-data', spaceId: 'ai-verse', entity: 'metric', recordId: 'conversion-rate', field: 'value' },
]);
assert.equal(JSON.stringify(projected).includes('must/not/leak'), false);
assert.equal(JSON.stringify(projected).includes('must not leak through the ref'), false);
assert.equal(JSON.stringify(projected).includes('must_not_leak'), false);
assert.equal(JSON.stringify(projected).includes('private_state'), false);

assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{ ...base }]),
  /source_refs must contain at least one exact owner-backed source ref/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    ...base,
    source_refs: [{ owner: 'unknown-owner', scope, kind: 'event', id: 'event-1' }],
  }]),
  /is not an admitted Purpose material-change owner/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    ...base,
    source_refs: [{ owner: 'ai-verse-brain', scope: 'workspace:other', kind: 'goal', id: 'goal-1' }],
  }]),
  /scope does not match Purpose scope/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    ...base,
    source_refs: [{ owner: 'ai-verse-memory', scope, kind: 'memory', id: 'memory-1' }],
  }]),
  /version is required for ai-verse-memory provenance/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    ...base,
    source_refs: [{ owner: 'ai-verse-memory', scope, kind: 'goal', id: 'memory-1', version: 'v1' }],
  }]),
  /kind must be memory for ai-verse-memory/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    ...base,
    source_refs: [{ owner: 'ai-verse-data', spaceId: 'other', entity: 'metric', recordId: 'x', field: 'value' }],
  }]),
  /spaceId does not match Purpose workspace scope/,
);
assert.throws(
  () => classifyPurposeMaterialChanges('operator', [{
    ...base,
    scope: 'operator',
    source_refs: [{ owner: 'ai-verse-data', spaceId: 'operator', entity: 'metric', recordId: 'x', field: 'value' }],
  }]),
  /cannot use ai-verse-data without a workspace Data scope contract/,
);
assert.throws(
  () => classifyPurposeMaterialChanges(scope, [{
    ...base,
    source_refs: Array.from({ length: 9 }, (_, index) => ({
      owner: 'ai-verse-os', scope, kind: 'event', id: `event-${index}`,
    })),
  }]),
  /source_refs exceed hard cap 8/,
);

process.stdout.write('Purpose material-change provenance: PASS\n');
