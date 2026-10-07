#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composePurposeContext } from './purpose-context-core.mjs';

const now = '2026-10-07T08:10:00.000Z';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-fail-closed-'));
try {
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '## Current priorities', '', '- STALE OS PRIORITY', '',
    '## Current state', '', '- operational fact that must not become strategic fallback', '',
  ].join('\n'));

  const marker = path.join(root, '.aiverse', 'direction', 'ownership.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    schema_version: 1,
    scopes: {
      operator: {
        owner: 'brain',
        state: 'active',
        handover_id: 'purpose-fail-closed',
        brain_refs: ['brain:intent:mission-1'],
      },
    },
  }));

  const unavailable = composePurposeContext(root, 'operator', { now });
  assert.equal(unavailable.section_states.strategic_direction.state, 'unavailable');
  assert.equal(unavailable.section_states.strategic_direction.reason, 'brain_public_reader_unavailable');
  assert.equal(unavailable.provenance.owner_reads.length, 2);
  assert.equal(unavailable.provenance.owner_reads[1].owner, 'ai-verse-brain');
  assert.equal(unavailable.provenance.owner_reads[1].status, 'unavailable');
  assert.equal(unavailable.provenance.owner_reads[1].freshness.state, 'unavailable');
  assert.deepEqual(unavailable.provenance.owner_reads[1].canonical_refs, []);
  assert.equal('priorities' in unavailable, false);
  assert.equal('goals' in unavailable, false);
  assert.equal('strategies' in unavailable, false);
  assert.doesNotMatch(JSON.stringify(unavailable), /STALE OS PRIORITY/);

  assert.throws(() => composePurposeContext(root, 'operator', {
    now,
    readBrainPurposeSnapshot() {
      return { schema_version: '1.0', scope: 'workspace:wrong', direction_owner: 'brain', status: 'ok' };
    },
  }), /violated declared owner\/scope contract/);

  const partial = composePurposeContext(root, 'operator', {
    now,
    readBrainPurposeSnapshot(scope) {
      return {
        schema_version: '1.0',
        scope,
        direction_owner: 'brain',
        status: 'partial',
        reason: 'trajectory_temporarily_unavailable',
        strategic_objects: {
          intents: [{
            id: 'mission-1', kind: 'intent', semantic_kind: 'mission', scope, status: 'ACTIVE', revision: 1,
            canonical_ref: { owner: 'ai-verse-brain', scope, kind: 'intent', id: 'mission-1', version: '1' },
            payload: { subtype: 'mission', statement: 'Owner-backed mission' },
          }],
          gaps: [], initiatives: [],
        },
        relationships: [], relationship_rejections: [],
      };
    },
  });
  assert.equal(partial.section_states.strategic_direction.state, 'partial');
  assert.equal(partial.purpose.missions[0].payload.statement, 'Owner-backed mission');
  assert.doesNotMatch(JSON.stringify(partial), /STALE OS PRIORITY/);

  process.stdout.write('Purpose Context v1 fail-closed owner behavior: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
