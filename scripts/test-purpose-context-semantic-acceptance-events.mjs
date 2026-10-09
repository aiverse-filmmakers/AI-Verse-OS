#!/usr/bin/env node

import assert from 'node:assert/strict';

import { classifyPurposeMaterialChanges } from './purpose-material-change-classifier.mjs';
import { applyPurposeMaterialChangeRelevance } from './purpose-material-change-relevance.mjs';
import { applyPurposeDataCurrentState } from './purpose-data-current-state.mjs';
import { projectTransientDataCurrentValues } from './purpose-data-current-value-boundary.mjs';
import { projectPurposeMemoryHistory } from './purpose-memory-history-boundary.mjs';

const scope = 'workspace:film';
const goalRef = { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'goal-release', version: '4' };
const initiativeRef = { owner: 'ai-verse-brain', scope, kind: 'initiative', id: 'initiative-picture-lock', version: '7' };
const strategyRef = { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'strategy-release', version: '3' };

function canonicalEnvelope() {
  return {
    schema_version: '1.0',
    scope,
    scope_kind: 'workspace',
    identity: { kind: 'workspace', id: 'film' },
    goals: [{ id: 'goal-release', semantic_kind: 'goal', status: 'ACTIVE', canonical_ref: goalRef, payload: { statement: 'Release the film on schedule' } }],
    strategies: [{ id: 'strategy-release', semantic_kind: 'strategy', status: 'ACTIVE', canonical_ref: strategyRef, payload: { statement: 'Lock picture before final sound' } }],
    initiatives: [{ id: 'initiative-picture-lock', semantic_kind: 'initiative', status: 'ACTIVE', canonical_ref: initiativeRef, payload: { outcome: 'Picture locked' } }],
    current_state: [{ kind: 'current_state', statement: 'Editorial is active', source_refs: [{ owner: 'ai-verse-os', scope, kind: 'current-context', id: 'active' }] }],
    trajectory: [{ relation: 'advances', from_ref: initiativeRef, to_ref: goalRef, source_refs: [initiativeRef] }],
    provenance: { projection_owner: 'ai-verse-os', generated_at: '2026-10-09T02:00:00.000Z', owner_reads: [] },
  };
}

function dataProvenance(recordVersion = 1) {
  return {
    scope: { workspaceId: 'film' },
    actor: { kind: 'bot', id: 'purpose-reader' },
    authorization: { mode: 'host-bound', capabilityRefs: ['data:metrics:read'] },
    schemaVersion: 1,
    recordVersion,
  };
}

// Slice 11.3 Scenario 6: material event closes a blocker.
{
  const projection = classifyPurposeMaterialChanges(scope, [{
    scope, occurred_at: '2026-10-09T02:00:00.000Z', event: 'Client approval blocker cleared',
    effect: 'Picture-lock initiative can advance again.', materiality: ['blocker_state', 'initiative_status'],
    source_refs: [{ owner: 'ai-verse-os', scope, kind: 'event', id: 'client-approval-cleared' }],
    affects: [initiativeRef], relevance_effect: 'restored',
  }]);
  const rebuilt = applyPurposeMaterialChangeRelevance(canonicalEnvelope(), projection);
  const initiative = rebuilt.initiatives[0];
  assert.equal(projection.changes.length, 1);
  assert.equal(initiative.status, 'ACTIVE');
  assert.deepEqual(initiative.canonical_ref, initiativeRef);
  assert.deepEqual(initiative.payload, { outcome: 'Picture locked' });
  assert.equal(initiative.purpose_relevance.state, 'restored');
  assert.equal(initiative.purpose_relevance.projection_only, true);
  assert.equal(initiative.purpose_relevance.authoritative_for_owner_state, false);
  assert.equal(rebuilt.section_states.material_change_relevance.applied_count, 1);
}

// Slice 11.3 Scenario 7: material event invalidates feasibility of a strategy.
{
  const projection = classifyPurposeMaterialChanges(scope, [{
    scope, occurred_at: '2026-10-09T02:10:00.000Z', event: 'Required finishing vendor became unavailable',
    effect: 'The current release strategy is no longer feasible as written.', materiality: ['feasibility', 'strategy_validity'],
    source_refs: [{ owner: 'ai-verse-os', scope, kind: 'event', id: 'finishing-vendor-unavailable' }],
    affects: [strategyRef], relevance_effect: 'invalidated',
  }]);
  const rebuilt = applyPurposeMaterialChangeRelevance(canonicalEnvelope(), projection);
  const strategy = rebuilt.strategies[0];
  assert.equal(strategy.status, 'ACTIVE', 'projection must not rewrite Brain owner status');
  assert.deepEqual(strategy.canonical_ref, strategyRef);
  assert.deepEqual(strategy.payload, { statement: 'Lock picture before final sound' });
  assert.equal(strategy.purpose_relevance.state, 'invalidated');
  assert.equal(strategy.purpose_relevance.projection_only, true);
  assert.equal(strategy.purpose_relevance.authoritative_for_owner_state, false);
  assert.deepEqual(strategy.purpose_relevance.materiality, ['feasibility', 'strategy_validity']);
}

// Slice 11.3 Scenario 8: Data value becomes stale/unavailable.
{
  const dataRef = { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'release', recordId: 'today', field: 'confidence' };
  const staleCurrent = projectTransientDataCurrentValues([{
    ref: dataRef, state: 'stale', value: 0.42, sourceUpdatedAt: '2026-10-07T00:00:00.000Z', provenance: dataProvenance(4),
  }]).values[0];
  const stale = applyPurposeDataCurrentState(canonicalEnvelope(), {
    now: '2026-10-09T02:20:00.000Z',
    readPurposeDataCurrentState(request) {
      assert.equal(request.scope, scope);
      return { status: 'ok', scope, bindings: [{ purpose_ref: goalRef, current: staleCurrent }] };
    },
  });
  assert.equal(stale.current_state.some((item) => item.kind === 'data_current_state'), false);
  assert.equal(stale.section_states.data_current_state.state, 'partial');
  assert.equal(stale.section_states.data_current_state.diagnostics[0].state, 'stale');
  assert.equal(stale.provenance.owner_reads.find((item) => item.owner === 'ai-verse-data').freshness.state, 'mixed');

  const unavailable = applyPurposeDataCurrentState(stale, {
    now: '2026-10-09T02:25:00.000Z',
    readPurposeDataCurrentState() { return { status: 'unavailable', scope, reason: 'data_service_unreachable' }; },
  });
  assert.equal(unavailable.current_state.some((item) => item.kind === 'data_current_state'), false);
  assert.deepEqual(unavailable.section_states.data_current_state, { state: 'unavailable', reason: 'data_service_unreachable' });
  const dataRead = unavailable.provenance.owner_reads.find((item) => item.owner === 'ai-verse-data');
  assert.equal(dataRead.status, 'unavailable');
  assert.equal(dataRead.freshness.state, 'unavailable');
}

// Slice 11.3 Scenario 9: Memory old history conflicts with current Brain/Data truth.
{
  const current = canonicalEnvelope();
  const history = projectPurposeMemoryHistory(scope, {
    api_version: 'memory.purpose-history.v1',
    scope,
    purpose_refs: [goalRef],
    max_age_days: 30,
    limit: 8,
    budget_bytes: 4096,
    history: [{
      id: 'old-release-decision',
      type: 'lesson',
      scope,
      occurred_at: '2026-09-20T12:00:00.000Z',
      excerpt: 'Old decision: do not release the film this month.',
      source_refs: [{ owner: 'ai-verse-memory', scope, kind: 'memory', id: 'old-release-decision', version: 'sha256:version-1' }],
      provenance: {
        owner: 'ai-verse-memory',
        source_identity: 'sha256:identity-1',
        source_version: 'sha256:version-1',
        freshness: 'historical',
      },
      goals: [{ statement: 'Do not release the film this month' }],
      current_state: [{ statement: 'Release is cancelled' }],
      current_value: 0,
    }],
    truncated: false,
    returned: 1,
    candidate_count: 1,
  });

  assert.equal(current.goals[0].payload.statement, 'Release the film on schedule');
  assert.equal(history.evidence_role, 'historical');
  assert.equal(history.authoritative_for_current_state, false);
  assert.equal(history.history[0].kind, 'historical_evidence');
  assert.equal(history.history[0].statement, 'Old decision: do not release the film this month.');
  assert.equal('goals' in history.history[0], false);
  assert.equal('current_state' in history.history[0], false);
  assert.equal('current_value' in history.history[0], false);
  assert.deepEqual(current.goals[0].canonical_ref, goalRef);
}

process.stdout.write('Purpose Context semantic acceptance through Scenario 11.3.9: PASS\n');
