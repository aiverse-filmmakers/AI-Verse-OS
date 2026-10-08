#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composeProfiledPurposeContext } from './purpose-context-profile.mjs';
import { projectTransientDataCurrentValues } from './purpose-data-current-value-boundary.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-data-descent-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces', 'film', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), '## Current priorities\n\n- operator priority\n');
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: film\n');
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'context', 'CURRENT.md'), '## Objective\n\n- Ship the film\n');
  return root;
}

function provenance(workspaceId = 'film', recordVersion = 9) {
  return {
    scope: { workspaceId },
    actor: { kind: 'bot', id: 'purpose-reader' },
    authorization: { mode: 'host-bound', capabilityRefs: ['data:metrics:read'] },
    schemaVersion: 1,
    recordVersion,
  };
}

function projection(ref, state, value, sourceUpdatedAt, missing) {
  const input = { ref, state };
  if (state !== 'missing') {
    input.value = value;
    input.sourceUpdatedAt = sourceUpdatedAt;
    input.provenance = provenance();
  } else {
    input.missing = missing;
  }
  return projectTransientDataCurrentValues([input]).values[0];
}

function refKey(ref) {
  return [ref.owner, ref.spaceId, ref.entity, ref.recordId, ref.field].join('\u0000');
}

const root = fixture();
try {
  const purposeRef = { owner: 'ai-verse-os', scope: 'workspace:film', kind: 'current-context', id: 'active' };
  const countRef = { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'count' };
  const blockedRef = { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'blocked' };
  const staleRef = { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'yesterday', field: 'count' };
  const missingRef = { owner: 'ai-verse-data', spaceId: 'metrics', entity: 'snapshots', recordId: 'today', field: 'budget' };

  const ownerEvidence = new Map([
    [refKey(countRef), { ref: countRef, value: 12, updatedAt: '2026-10-07T17:00:00.000Z', workspaceId: 'film', recordVersion: 9 }],
    [refKey(blockedRef), { ref: blockedRef, value: false, updatedAt: '2026-10-07T17:00:00.000Z', workspaceId: 'film', recordVersion: 9 }],
    [refKey(staleRef), { ref: staleRef, value: 8, updatedAt: '2026-10-05T17:00:00.000Z', workspaceId: 'film', recordVersion: 4 }],
  ]);

  const envelope = composeProfiledPurposeContext(root, 'workspace:film', {
    now: '2026-10-07T17:05:00.000Z',
    readPurposeDataCurrentState(request) {
      assert.equal(request.scope, 'workspace:film');
      return {
        status: 'ok',
        scope: request.scope,
        bindings: [
          { purpose_ref: purposeRef, current: projection(countRef, 'value', 12, '2026-10-07T17:00:00.000Z') },
          { purpose_ref: purposeRef, current: projection(blockedRef, 'value', false, '2026-10-07T17:00:00.000Z') },
          { purpose_ref: purposeRef, current: projection(staleRef, 'stale', 8, '2026-10-05T17:00:00.000Z') },
          { purpose_ref: purposeRef, current: projection(missingRef, 'missing', undefined, undefined, 'field') },
        ],
      };
    },
  });

  function readExactSource(ref, sourceProvenance) {
    assert.deepEqual(Object.keys(ref).sort(), ['entity', 'field', 'owner', 'recordId', 'spaceId']);
    assert.equal(ref.owner, 'ai-verse-data');
    if (sourceProvenance) {
      if (sourceProvenance.scope?.workspaceId !== 'film') throw new Error('owner permission scope denied');
      if (sourceProvenance.authorization?.mode !== 'host-bound') throw new Error('owner authorization mode denied');
      if (!sourceProvenance.authorization?.capabilityRefs?.includes('data:metrics:read')) {
        throw new Error('owner capability denied');
      }
    }
    return ownerEvidence.get(refKey(ref));
  }

  const current = envelope.current_state.filter((item) => item.kind === 'data_current_state');
  assert.equal(current.length, 2);
  for (const item of current) {
    const evidence = readExactSource(item.source_ref, item.source_provenance);
    assert.ok(evidence, 'exact Data source ref did not descend to owner evidence');
    assert.deepEqual(evidence.ref, item.source_ref);
    assert.equal(evidence.value, item.value);
    assert.equal(evidence.updatedAt, item.source_updated_at);
    assert.equal(evidence.workspaceId, item.source_provenance.scope.workspaceId);
    assert.equal(evidence.recordVersion, item.source_provenance.recordVersion);
  }

  const diagnostics = envelope.section_states.data_current_state.diagnostics;
  const stale = diagnostics.find((item) => item.state === 'stale');
  const missing = diagnostics.find((item) => item.state === 'missing');
  assert.ok(stale);
  assert.ok(missing);

  const staleEvidence = readExactSource(stale.source_ref, provenance('film', 4));
  assert.ok(staleEvidence);
  assert.deepEqual(staleEvidence.ref, staleRef);
  assert.equal(staleEvidence.updatedAt, stale.source_updated_at);

  assert.equal(readExactSource(missing.source_ref), undefined, 'missing field unexpectedly resolved to owner evidence');
  assert.deepEqual(missing.source_ref, missingRef);
  assert.equal(missing.missing, 'field');

  const fuzzy = { ...countRef, field: 'count-prefix' };
  assert.equal(readExactSource(fuzzy, current[0].source_provenance), undefined, 'fuzzy Data source ref resolved unexpectedly');
  const siblingRecord = { ...countRef, recordId: 'today-copy' };
  assert.equal(readExactSource(siblingRecord, current[0].source_provenance), undefined, 'sibling record resolved unexpectedly');

  assert.throws(
    () => readExactSource(countRef, { ...current[0].source_provenance, scope: { workspaceId: 'other' } }),
    /owner permission scope denied/,
  );
  assert.throws(
    () => readExactSource(countRef, { ...current[0].source_provenance, authorization: { mode: 'host-bound', capabilityRefs: [] } }),
    /owner capability denied/,
  );
  assert.throws(
    () => readExactSource(countRef, { ...current[0].source_provenance, authorization: { mode: 'unbound', capabilityRefs: ['data:metrics:read'] } }),
    /owner authorization mode denied/,
  );

  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes('ownerEvidence'), false);
  assert.equal(serialized.includes('today-copy'), false);
  assert.equal(serialized.includes('count-prefix'), false);

  process.stdout.write('Purpose Data exact-source descent with owner permissions: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
