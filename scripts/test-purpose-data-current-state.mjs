#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composeProfiledPurposeContext } from './purpose-context-profile.mjs';
import { projectTransientDataCurrentValues } from './purpose-data-current-value-boundary.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-data-state-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'film', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), '## Current priorities\n\n- operator priority\n');
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: film\n');
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'context', 'CURRENT.md'), [
    '## Objective', '', '- Ship the film', '',
    '## Current state', '', '- edit in progress', '',
  ].join('\n'));
  return root;
}

function provenance(workspaceId) {
  return {
    scope: { workspaceId },
    actor: { kind: 'bot', id: 'purpose-reader' },
    authorization: { mode: 'host-bound', capabilityRefs: ['data:metrics:read'] },
    schemaVersion: 1,
    recordVersion: 7,
  };
}

function projected(ref, value, workspaceId = 'film', sourceUpdatedAt = '2026-10-07T16:00:00.000Z') {
  return projectTransientDataCurrentValues([{
    ref,
    state: 'value',
    value,
    sourceUpdatedAt,
    provenance: provenance(workspaceId),
  }]).values[0];
}

function staleProjected(ref, value, sourceUpdatedAt = '2026-10-06T16:00:00.000Z') {
  return projectTransientDataCurrentValues([{
    ref,
    state: 'stale',
    value,
    sourceUpdatedAt,
    provenance: provenance('film'),
  }]).values[0];
}

function missingProjected(ref, missing) {
  return projectTransientDataCurrentValues([{ ref, state: 'missing', missing }]).values[0];
}

const now = '2026-10-07T16:05:00.000Z';
const root = fixture();
try {
  const purposeRef = { owner: 'ai-verse-os', scope: 'workspace:film', kind: 'current-context', id: 'active' };
  const refs = [
    { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'blocked' },
    { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'count' },
    { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'note' },
  ];
  let requestedRefs = null;
  const envelope = composeProfiledPurposeContext(root, 'workspace:film', {
    now,
    readPurposeDataCurrentState(request) {
      requestedRefs = request.purpose_refs;
      return {
        status: 'ok',
        scope: request.scope,
        bindings: [
          { purpose_ref: purposeRef, current: projected(refs[1], 0) },
          { purpose_ref: purposeRef, current: projected(refs[0], false) },
          { purpose_ref: purposeRef, current: projected(refs[2], null) },
          {
            purpose_ref: { owner: 'ai-verse-os', scope: 'workspace:film', kind: 'current-context', id: 'not-retained' },
            current: projected({ owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'irrelevant' }, 999),
          },
        ],
      };
    },
  });

  assert.ok(requestedRefs.some((ref) => JSON.stringify(ref) === JSON.stringify(purposeRef)), 'reader did not receive the retained Purpose ref');
  const dataState = envelope.current_state.filter((item) => item.kind === 'data_current_state');
  assert.equal(dataState.length, 3);
  assert.deepEqual(dataState.map((item) => item.source_ref.field), ['blocked', 'count', 'note']);
  assert.deepEqual(dataState.map((item) => item.value), [false, 0, null]);
  assert.ok(dataState.every((item) => item.state === 'value' && item.source_owner === 'ai-verse-data'));
  assert.ok(dataState.every((item) => JSON.stringify(item.purpose_ref) === JSON.stringify(purposeRef)));
  assert.ok(dataState.every((item) => item.source_provenance.scope.workspaceId === 'film'));
  assert.equal(envelope.current_state.some((item) => item.source_ref?.field === 'irrelevant'), false);
  assert.equal(envelope.current_state.some((item) => item.statement === 'edit in progress'), true);
  const dataRead = envelope.provenance.owner_reads.find((item) => item.owner === 'ai-verse-data');
  assert.equal(dataRead.operation, 'purpose-current-state.read');
  assert.equal(dataRead.status, 'ok');
  assert.deepEqual(dataRead.freshness, { state: 'owner_timestamped' });
  assert.deepEqual(dataRead.canonical_refs, []);
  assert.equal(envelope.section_states?.data_current_state, undefined);

  const staleRef = { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'yesterday', field: 'count' };
  const missingRef = { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'budget' };
  const partial = composeProfiledPurposeContext(root, 'workspace:film', {
    now,
    readPurposeDataCurrentState(request) {
      return {
        status: 'ok',
        scope: request.scope,
        bindings: [
          { purpose_ref: purposeRef, current: projected(refs[1], 12) },
          { purpose_ref: purposeRef, current: staleProjected(staleRef, 8) },
          { purpose_ref: purposeRef, current: missingProjected(missingRef, 'field') },
        ],
      };
    },
  });
  const partialDataState = partial.current_state.filter((item) => item.kind === 'data_current_state');
  assert.equal(partialDataState.length, 1);
  assert.equal(partialDataState[0].value, 12);
  assert.equal(partial.current_state.some((item) => item.source_ref?.recordId === 'yesterday'), false, 'stale value leaked into trusted current_state');
  assert.equal(partial.section_states.data_current_state.state, 'partial');
  assert.deepEqual(partial.section_states.data_current_state.diagnostics.map((item) => item.state), ['missing', 'stale']);
  const missingDiagnostic = partial.section_states.data_current_state.diagnostics.find((item) => item.state === 'missing');
  assert.equal(missingDiagnostic.missing, 'field');
  assert.deepEqual(missingDiagnostic.source_ref, missingRef);
  const staleDiagnostic = partial.section_states.data_current_state.diagnostics.find((item) => item.state === 'stale');
  assert.equal(staleDiagnostic.source_updated_at, '2026-10-06T16:00:00.000Z');
  assert.deepEqual(staleDiagnostic.source_ref, staleRef);
  const partialRead = partial.provenance.owner_reads.find((item) => item.owner === 'ai-verse-data');
  assert.equal(partialRead.status, 'partial');
  assert.deepEqual(partialRead.freshness, { state: 'mixed' });

  const unavailable = composeProfiledPurposeContext(root, 'workspace:film', {
    now,
    readPurposeDataCurrentState(request) {
      return { status: 'unavailable', scope: request.scope, reason: 'data_service_unreachable' };
    },
  });
  assert.deepEqual(unavailable.section_states.data_current_state, {
    state: 'unavailable',
    reason: 'data_service_unreachable',
  });
  const unavailableRead = unavailable.provenance.owner_reads.find((item) => item.owner === 'ai-verse-data');
  assert.equal(unavailableRead.status, 'unavailable');
  assert.deepEqual(unavailableRead.freshness, { state: 'unavailable' });
  assert.equal(unavailable.current_state.some((item) => item.kind === 'data_current_state'), false);

  const noReader = composeProfiledPurposeContext(root, 'workspace:film', { now });
  assert.deepEqual(noReader.section_states.data_current_state, {
    state: 'unavailable',
    reason: 'data_public_reader_unavailable',
  });
  assert.equal(noReader.provenance.owner_reads.find((item) => item.owner === 'ai-verse-data').status, 'unavailable');

  assert.throws(() => composeProfiledPurposeContext(root, 'workspace:film', {
    now,
    readPurposeDataCurrentState(request) {
      return {
        status: 'ok',
        scope: request.scope,
        bindings: [{ purpose_ref: purposeRef, current: projected(refs[0], true, 'other') }],
      };
    },
  }), /scope does not match workspace:film/);

  assert.throws(() => composeProfiledPurposeContext(root, 'operator', {
    now,
    readPurposeDataCurrentState(request) {
      return {
        status: 'ok',
        scope: request.scope,
        bindings: [{
          purpose_ref: { owner: 'ai-verse-os', scope: 'operator', kind: 'current-context', id: 'active' },
          current: projected(refs[0], true),
        }],
      };
    },
  }), /operator Data current-state projection requires an operator Data scope contract/);

  const operatorWithoutData = composeProfiledPurposeContext(root, 'operator', { now });
  assert.equal(operatorWithoutData.section_states?.data_current_state, undefined);
  assert.equal(operatorWithoutData.provenance.owner_reads.some((item) => item.owner === 'ai-verse-data'), false);

  process.stdout.write('Purpose Data relevant current-state projection and diagnostics: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
