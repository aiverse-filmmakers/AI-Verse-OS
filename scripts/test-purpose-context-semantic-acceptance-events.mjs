#!/usr/bin/env node

import assert from 'node:assert/strict';

import { classifyPurposeMaterialChanges } from './purpose-material-change-classifier.mjs';
import { applyPurposeMaterialChangeRelevance } from './purpose-material-change-relevance.mjs';

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
    goals: [{
      id: 'goal-release', semantic_kind: 'goal', status: 'ACTIVE', canonical_ref: goalRef,
      payload: { statement: 'Release the film on schedule' },
    }],
    strategies: [{
      id: 'strategy-release', semantic_kind: 'strategy', status: 'ACTIVE', canonical_ref: strategyRef,
      payload: { statement: 'Lock picture before final sound' },
    }],
    initiatives: [{
      id: 'initiative-picture-lock', semantic_kind: 'initiative', status: 'ACTIVE', canonical_ref: initiativeRef,
      payload: { outcome: 'Picture locked' },
    }],
    trajectory: [{ relation: 'advances', from_ref: initiativeRef, to_ref: goalRef, source_refs: [initiativeRef] }],
    provenance: { projection_owner: 'ai-verse-os', owner_reads: [] },
  };
}

// Slice 11.3 Scenario 6: material event closes a blocker.
{
  const projection = classifyPurposeMaterialChanges(scope, [{
    scope,
    occurred_at: '2026-10-09T02:00:00.000Z',
    event: 'Client approval blocker cleared',
    effect: 'Picture-lock initiative can advance again.',
    materiality: ['blocker_state', 'initiative_status'],
    source_refs: [{ owner: 'ai-verse-os', scope, kind: 'event', id: 'client-approval-cleared' }],
    affects: [initiativeRef],
    relevance_effect: 'restored',
  }]);
  const rebuilt = applyPurposeMaterialChangeRelevance(canonicalEnvelope(), projection);
  const initiative = rebuilt.initiatives[0];
  assert.equal(projection.changes.length, 1);
  assert.equal(initiative.status, 'ACTIVE');
  assert.deepEqual(initiative.canonical_ref, initiativeRef);
  assert.deepEqual(initiative.payload, { outcome: 'Picture locked' });
  assert.deepEqual(initiative.purpose_relevance, {
    projection_only: true,
    authoritative_for_owner_state: false,
    state: 'restored',
    as_of: '2026-10-09T02:00:00.000Z',
    materiality: ['blocker_state', 'initiative_status'],
    source_refs: [{ owner: 'ai-verse-os', scope, kind: 'event', id: 'client-approval-cleared' }],
  });
  assert.equal(rebuilt.section_states.material_change_relevance.state, 'ok');
  assert.equal(rebuilt.section_states.material_change_relevance.applied_count, 1);
  assert.equal(rebuilt.recent_material_changes[0].relevance_effect, 'restored');
}

// Slice 11.3 Scenario 7: material event invalidates feasibility of a strategy.
{
  const projection = classifyPurposeMaterialChanges(scope, [{
    scope,
    occurred_at: '2026-10-09T02:10:00.000Z',
    event: 'Required finishing vendor became unavailable',
    effect: 'The current release strategy is no longer feasible as written.',
    materiality: ['feasibility', 'strategy_validity'],
    source_refs: [{ owner: 'ai-verse-os', scope, kind: 'event', id: 'finishing-vendor-unavailable' }],
    affects: [strategyRef],
    relevance_effect: 'invalidated',
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
  assert.equal(rebuilt.recent_material_changes[0].relevance_effect, 'invalidated');
  assert.equal(rebuilt.section_states.material_change_relevance.applied_count, 1);
}

process.stdout.write('Purpose Context semantic acceptance through Scenario 11.3.7: PASS\n');
