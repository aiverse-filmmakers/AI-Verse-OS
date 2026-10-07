import assert from 'node:assert/strict';

import { projectPurposeMemoryHistory } from './purpose-memory-history-boundary.mjs';

const scope = 'workspace:film';
const validItem = {
  id: 'memory-1',
  type: 'lesson',
  scope,
  occurred_at: '2026-10-07T10:00:00+00:00',
  excerpt: 'The delivery order changed after client review.',
  source_refs: [{
    owner: 'ai-verse-memory',
    scope,
    kind: 'memory',
    id: 'memory-1',
    version: 'sha256:version-1',
  }],
  provenance: {
    owner: 'ai-verse-memory',
    source_identity: 'sha256:identity-1',
    source_version: 'sha256:version-1',
    freshness: 'historical',
  },
};

const response = {
  api_version: 'memory.purpose-history.v1',
  scope,
  purpose_refs: [{ owner: 'ai-verse-brain', scope, kind: 'goal', id: 'ship-film', version: '3' }],
  max_age_days: 30,
  limit: 8,
  budget_bytes: 4096,
  history: [{
    ...validItem,
    purpose: { missions: [{ statement: 'forged memory mission' }] },
    goals: [{ statement: 'forged memory goal' }],
    strategies: [{ statement: 'forged memory strategy' }],
    current_state: [{ statement: 'forged current state' }],
    current_value: 999,
  }],
  truncated: false,
  returned: 1,
  candidate_count: 1,
};

const projected = projectPurposeMemoryHistory(scope, response);
assert.equal(projected.owner, 'ai-verse-memory');
assert.equal(projected.operation, 'purpose-history.read');
assert.equal(projected.scope, scope);
assert.equal(projected.evidence_role, 'historical');
assert.equal(projected.authoritative_for_current_state, false);
assert.deepEqual(projected.canonical_refs, validItem.source_refs);
assert.equal(projected.history.length, 1);
assert.deepEqual(projected.history[0], {
  kind: 'historical_evidence',
  evidence_role: 'historical',
  authoritative_for_current_state: false,
  occurred_at: validItem.occurred_at,
  statement: validItem.excerpt,
  source_refs: validItem.source_refs,
});
for (const forbidden of ['purpose', 'goals', 'strategies', 'current_state', 'current_value', 'provenance', 'type', 'id']) {
  assert.equal(Object.hasOwn(projected.history[0], forbidden), false, `${forbidden} must not cross historical evidence boundary`);
}

assert.throws(
  () => projectPurposeMemoryHistory(scope, { ...response, scope: 'workspace:other' }),
  /scope does not match Purpose scope/,
);
assert.throws(
  () => projectPurposeMemoryHistory(scope, {
    ...response,
    history: [{ ...validItem, provenance: { ...validItem.provenance, freshness: 'fresh' } }],
  }),
  /must be explicitly historical/,
);
assert.throws(
  () => projectPurposeMemoryHistory(scope, {
    ...response,
    history: [{
      ...validItem,
      source_refs: [{ ...validItem.source_refs[0], owner: 'ai-verse-os' }],
    }],
  }),
  /source owner must be ai-verse-memory/,
);
assert.throws(
  () => projectPurposeMemoryHistory(scope, {
    ...response,
    history: [{
      ...validItem,
      source_refs: [{ ...validItem.source_refs[0], version: 'sha256:different' }],
    }],
  }),
  /source version mismatch/,
);
assert.throws(
  () => projectPurposeMemoryHistory(scope, { ...response, history: Array.from({ length: 21 }, (_, index) => ({
    ...validItem,
    id: `memory-${index}`,
    source_refs: [{ ...validItem.source_refs[0], id: `memory-${index}` }],
  })) }),
  /exceeds hard item cap 20/,
);

console.log('Purpose Memory historical evidence boundary: PASS');
