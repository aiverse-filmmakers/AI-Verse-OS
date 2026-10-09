#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { applyPurposeProfile, composeProfiledPurposeContext } from './purpose-context-profile.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-semantic-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- Ship owner-backed Purpose Context', '',
    '## Current state', '', '- Phase 11 acceptance is active', '',
  ].join('\n'), 'utf8');
  return root;
}

function addWorkspace(root, id, lines, type = 'project') {
  const workspace = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(workspace, 'context'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'WORKSPACE.yaml'), [
    'schema_version: "2.0"',
    `id: "${id}"`,
    `name: "${id}"`,
    `type: "${type}"`,
    'status: "active"',
    `purpose: "Acceptance workspace ${id}"`,
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(workspace, 'context', 'CURRENT.md'), lines.join('\n'), 'utf8');
}

function setBrainOwner(root, scope) {
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: {
      [scope]: {
        owner: 'brain',
        state: 'active',
        handover_id: 'semantic-acceptance',
        brain_refs: ['brain:intent:mission-1', 'brain:intent:goal-1', 'brain:intent:strategy-1'],
      },
    },
  }), 'utf8');
}

function brainSnapshot(scope) {
  const mission = {
    id: 'mission-1', kind: 'intent', semantic_kind: 'mission', scope, status: 'ACTIVE', revision: 2,
    canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission-1', version: '2' },
    payload: { subtype: 'mission', statement: 'Build an owner-backed AI operating system' },
  };
  const goal = {
    id: 'goal-1', kind: 'intent', semantic_kind: 'goal', scope, status: 'ACTIVE', revision: 5,
    canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'goal-1', version: '5' },
    payload: { subtype: 'goal', statement: 'Complete Purpose Context acceptance' },
  };
  const strategy = {
    id: 'strategy-1', kind: 'intent', semantic_kind: 'strategy', scope, status: 'ACTIVE', revision: 3,
    canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'strategy-1', version: '3' },
    payload: { subtype: 'strategy', statement: 'Keep every projection tied to canonical owners' },
  };
  return {
    schema_version: '1.0', scope, direction_owner: 'brain', status: 'ok', read_states: {},
    strategic_objects: { intents: [mission, goal, strategy], gaps: [], initiatives: [] },
    relationships: [{ relation: 'advances', from_ref: strategy.canonical_ref, to_ref: goal.canonical_ref, source_refs: [strategy.canonical_ref] }],
    relationship_rejections: [],
  };
}

// Slice 11.3 Scenario 1: operator with OS-owned strategic direction.
{
  const root = makeRoot();
  try {
    const envelope = composeProfiledPurposeContext(root, 'operator', { now: '2026-10-09T01:00:00.000Z' });
    assert.equal(envelope.scope, 'operator');
    assert.equal(envelope.scope_kind, 'operator');
    assert.deepEqual(envelope.identity, { kind: 'operator', id: 'operator' });
    assert.equal(envelope.priorities[0].statement, 'Ship owner-backed Purpose Context');
    assert.equal(envelope.current_state[0].statement, 'Phase 11 acceptance is active');
    assert.equal(envelope.provenance.projection_owner, 'ai-verse-os');
    assert.equal(envelope.provenance.profile.resolved, 'operator_default');
    const osRead = envelope.provenance.owner_reads.find((read) => read.owner === 'ai-verse-os');
    assert.ok(osRead);
    assert.equal(osRead.operation, 'current-context.read');
    assert.equal(envelope.provenance.owner_reads.some((read) => read.owner === 'ai-verse-brain'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Slice 11.3 Scenario 2: operator with Brain-owned strategic direction.
{
  const root = makeRoot();
  try {
    fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
      '## Current priorities', '', '- STALE OS STRATEGIC DIRECTION', '',
      '## Current state', '', '- Operational runtime remains healthy', '',
    ].join('\n'), 'utf8');
    setBrainOwner(root, 'operator');
    const envelope = composeProfiledPurposeContext(root, 'operator', {
      now: '2026-10-09T01:05:00.000Z',
      readBrainPurposeSnapshot(scope) { return brainSnapshot(scope); },
    });
    assert.equal(envelope.purpose.missions[0].payload.statement, 'Build an owner-backed AI operating system');
    assert.equal(envelope.goals[0].payload.statement, 'Complete Purpose Context acceptance');
    assert.equal(envelope.strategies[0].payload.statement, 'Keep every projection tied to canonical owners');
    assert.equal(envelope.trajectory[0].relation, 'advances');
    assert.equal('priorities' in envelope, false);
    assert.doesNotMatch(JSON.stringify(envelope), /STALE OS STRATEGIC DIRECTION/);
    const brainRead = envelope.provenance.owner_reads.find((read) => read.owner === 'ai-verse-brain');
    const osRead = envelope.provenance.owner_reads.find((read) => read.owner === 'ai-verse-os');
    assert.ok(brainRead);
    assert.ok(osRead);
    assert.equal(brainRead.status, 'ok');
    assert.equal(envelope.provenance.profile.resolved, 'operator_default');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Slice 11.3 Scenario 3: simple workspace using only basic trajectory fields.
{
  const root = makeRoot();
  try {
    addWorkspace(root, 'simple-film', [
      '## Objective', '', '- Launch the short film', '',
      '## Current state', '', '- Rough cut complete', '',
      '## Next useful actions', '', '- Lock picture', '',
      '## Constraints / approvals', '', '- Director approval required', '',
    ]);
    const envelope = composeProfiledPurposeContext(root, 'workspace:simple-film', {
      profile: 'basic',
      now: '2026-10-09T01:10:00.000Z',
    });
    assert.equal(envelope.scope, 'workspace:simple-film');
    assert.equal(envelope.provenance.profile.resolved, 'workspace_basic');
    assert.equal(envelope.goals[0].statement, 'Launch the short film');
    assert.equal(envelope.current_state[0].statement, 'Rough cut complete');
    assert.equal(envelope.current_work[0].statement, 'Lock picture');
    assert.equal(envelope.constraints[0].statement, 'Director approval required');
    for (const key of ['narratives', 'kpis', 'risks', 'team_resources', 'customers', 'infrastructure', 'budget_cost']) {
      assert.equal(key in envelope, false, `basic workspace unexpectedly surfaced ${key}`);
    }
    const expectedRef = { owner: 'ai-verse-os', scope: 'workspace:simple-film', kind: 'current-context', id: 'active' };
    assert.deepEqual(envelope.goals[0].source_refs, [expectedRef]);
    assert.deepEqual(envelope.current_state[0].source_refs, [expectedRef]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Slice 11.3 Scenario 4: rich product/business workspace with KPI, risk, and current-state context.
{
  const root = makeRoot();
  try {
    const scope = 'workspace:product-growth';
    addWorkspace(root, 'product-growth', [
      '## Objective', '', '- Reach repeatable paid conversion', '',
      '## Current state', '', '- Checkout experiment is live', '',
      '## Next useful actions', '', '- Review conversion cohort', '',
    ], 'product');

    const base = composeProfiledPurposeContext(root, scope, {
      profile: 'basic',
      now: '2026-10-09T01:15:00.000Z',
    });
    const enriched = structuredClone(base);
    enriched.kpis = [{
      id: 'conversion-rate',
      statement: 'Paid conversion rate',
      current_value: 0.31,
      canonical_ref: { owner: 'ai-verse-data', scope, kind: 'kpi', id: 'conversion-rate', version: '12' },
    }];
    enriched.risks = [{
      id: 'checkout-dropoff',
      statement: 'Checkout drop-off can invalidate growth assumptions',
      canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'risk', id: 'checkout-dropoff', version: '4' },
    }];

    const rich = applyPurposeProfile(enriched, {
      profile: 'rich',
      relevantDomains: ['kpis', 'risks', 'current_state'],
    });
    assert.equal(rich.scope, scope);
    assert.equal(rich.provenance.profile.resolved, 'workspace_rich');
    assert.equal(rich.goals[0].statement, 'Reach repeatable paid conversion');
    assert.equal(rich.current_state[0].statement, 'Checkout experiment is live');
    assert.equal(rich.kpis[0].current_value, 0.31);
    assert.equal(rich.risks[0].statement, 'Checkout drop-off can invalidate growth assumptions');
    assert.equal(rich.kpis[0].canonical_ref.scope, scope);
    assert.equal(rich.risks[0].canonical_ref.scope, scope);

    const crossScope = structuredClone(enriched);
    crossScope.risks[0].canonical_ref.scope = 'workspace:other-business';
    const filtered = applyPurposeProfile(crossScope, { profile: 'rich', relevantDomains: ['risks'] });
    assert.equal('risks' in filtered, false, 'rich workspace retained a cross-scope risk');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Slice 11.3 Scenario 5: two isolated workspaces can hold conflicting goals without reconciliation or leakage.
{
  const root = makeRoot();
  try {
    addWorkspace(root, 'launch-now', [
      '## Objective', '', '- Ship the campaign on Friday', '',
      '## Current state', '', '- Launch assets are approved', '',
    ], 'business');
    addWorkspace(root, 'hold-launch', [
      '## Objective', '', '- Do not ship the campaign on Friday', '',
      '## Current state', '', '- Legal review is still open', '',
    ], 'business');

    const launch = composeProfiledPurposeContext(root, 'workspace:launch-now', {
      profile: 'basic', now: '2026-10-09T01:20:00.000Z',
    });
    const hold = composeProfiledPurposeContext(root, 'workspace:hold-launch', {
      profile: 'basic', now: '2026-10-09T01:20:00.000Z',
    });
    const launchJson = JSON.stringify(launch);
    const holdJson = JSON.stringify(hold);

    assert.equal(launch.goals[0].statement, 'Ship the campaign on Friday');
    assert.equal(hold.goals[0].statement, 'Do not ship the campaign on Friday');
    assert.equal(launch.current_state[0].statement, 'Launch assets are approved');
    assert.equal(hold.current_state[0].statement, 'Legal review is still open');
    assert.doesNotMatch(launchJson, /Do not ship the campaign on Friday|Legal review is still open|workspace:hold-launch/);
    assert.doesNotMatch(holdJson, /Ship the campaign on Friday|Launch assets are approved|workspace:launch-now/);

    const launchRef = { owner: 'ai-verse-os', scope: 'workspace:launch-now', kind: 'current-context', id: 'active' };
    const holdRef = { owner: 'ai-verse-os', scope: 'workspace:hold-launch', kind: 'current-context', id: 'active' };
    assert.deepEqual(launch.goals[0].source_refs, [launchRef]);
    assert.deepEqual(hold.goals[0].source_refs, [holdRef]);
    assert.notDeepEqual(launch.goals, hold.goals);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

process.stdout.write('Purpose Context semantic acceptance through Scenario 11.3.5: PASS\n');
