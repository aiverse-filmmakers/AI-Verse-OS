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

  process.stdout.write('Purpose Data relevant current-state projection: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
