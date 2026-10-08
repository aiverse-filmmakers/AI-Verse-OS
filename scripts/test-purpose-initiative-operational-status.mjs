#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composePurposeContext } from './purpose-context-core.mjs';
import { PURPOSE_OPTIONAL_OWNER_BACKED_DOMAIN_NAMES } from './purpose-context-rich-domains.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-initiative-status-'));
const scope = 'workspace:film';

function setBrainOwner() {
  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: {
      [scope]: {
        owner: 'brain',
        state: 'active',
        handover_id: 'purpose-initiative-status',
        brain_refs: ['brain:intent:initiative-status-anchor'],
      },
    },
  }));
}

try {
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'workspaces', 'film', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'WORKSPACE.yaml'), 'schema_version: "2.0"\nid: film\n');
  fs.writeFileSync(path.join(root, 'workspaces', 'film', 'context', 'CURRENT.md'), [
    '# Current Workspace Context', '',
    '## Current state', '', '- edit machine online', '',
  ].join('\n'));
  setBrainOwner();

  const statusById = new Map([
    ['edit', 'ACTIVE'],
    ['approval', 'WAITING'],
    ['delivery', 'BLOCKED'],
    ['archive', 'STALLED'],
    ['festival', 'PAUSED'],
    ['review', 'REVIEW'],
  ]);

  const projection = composePurposeContext(root, scope, {
    now: '2026-10-09T00:00:00Z',
    readBrainPurposeSnapshot(requestedScope) {
      assert.equal(requestedScope, scope);
      return {
        schema_version: '1.0',
        scope,
        direction_owner: 'brain',
        status: 'ok',
        read_states: { initiatives: { state: 'ok' } },
        strategic_objects: {
          intents: [],
          gaps: [],
          initiatives: [...statusById].map(([id, status], index) => ({
            id,
            kind: 'initiative',
            semantic_kind: 'initiative',
            scope,
            status,
            revision: index + 1,
            canonical_ref: {
              owner: 'ai-verse-brain',
              scope,
              kind: 'initiative',
              id,
              version: String(index + 1),
            },
            source_refs: [],
            evidence_refs: [],
            payload: { outcome: `${id} outcome` },
          })),
        },
        relationships: [],
        relationship_rejections: [],
      };
    },
  });

  assert.equal(projection.provenance.projection_owner, 'ai-verse-os');
  assert.deepEqual(
    Object.fromEntries(projection.initiatives.map((item) => [item.id, item.status])),
    Object.fromEntries([...statusById].sort(([left], [right]) => left.localeCompare(right))),
  );
  for (const initiative of projection.initiatives) {
    assert.equal(initiative.canonical_ref.owner, 'ai-verse-brain');
    assert.equal(initiative.canonical_ref.scope, scope);
    assert.equal(initiative.canonical_ref.kind, 'initiative');
  }

  // Brain's existing initiative status is the authoritative current initiative
  // state exposed by Purpose. Do not introduce a duplicate rich-domain/status store.
  assert.equal(PURPOSE_OPTIONAL_OWNER_BACKED_DOMAIN_NAMES.includes('initiative_operational_status'), false);
  assert.equal('initiative_operational_status' in projection, false);
  assert.equal('project_operational_status' in projection, false);

  process.stdout.write('Purpose initiative operational-status ownership: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
