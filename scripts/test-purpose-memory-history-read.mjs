import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { composePurposeContext } from './purpose-context-core.mjs';
import { readPurposeHistoricalEvidence } from './purpose-memory-history-read.mjs';

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-purpose-memory-read-'));
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\n', 'utf8');
  fs.mkdirSync(path.join(root, 'operator', 'context'), { recursive: true });
  fs.writeFileSync(path.join(root, 'operator', 'context', 'CURRENT.md'), [
    '# Current Operator Context', '',
    '## Current priorities', '', '- Finish the active Purpose slice', '',
  ].join('\n'), 'utf8');
  return root;
}

const root = makeRoot();
try {
  let memoryCalls = 0;
  const envelope = composePurposeContext(root, 'operator', {
    now: '2026-10-07T21:30:00.000Z',
    readMemoryPurposeHistory() {
      memoryCalls += 1;
      throw new Error('ordinary Purpose composition must not read Memory history');
    },
  });
  assert.equal(envelope.scope, 'operator');
  assert.equal(memoryCalls, 0, 'ordinary Purpose composition must perform zero Memory history reads');
  assert.equal(
    envelope.provenance.owner_reads.some((read) => read.owner === 'ai-verse-memory'),
    false,
    'ordinary Purpose provenance must not pretend Memory was read',
  );

  const purposeRefs = [{
    owner: 'ai-verse-brain',
    scope: 'operator',
    kind: 'goal',
    id: 'finish-purpose',
    version: '4',
  }];
  let explicitCalls = 0;
  const historical = readPurposeHistoricalEvidence({
    scope: 'operator',
    purposeRefs,
    query: 'finish purpose blocker history',
    limit: 2,
    maxBytes: 4096,
    maxAgeDays: 30,
    readMemoryPurposeHistory(request) {
      explicitCalls += 1;
      assert.deepEqual(request, {
        scope: 'operator',
        purpose_refs: purposeRefs,
        query: 'finish purpose blocker history',
        limit: 2,
        max_bytes: 4096,
        max_age_days: 30,
      });
      return {
        api_version: 'memory.purpose-history.v1',
        scope: 'operator',
        purpose_refs: purposeRefs,
        query: request.query,
        max_age_days: request.max_age_days,
        limit: request.limit,
        budget_bytes: request.max_bytes,
        history: [{
          id: 'memory-1',
          type: 'lesson',
          scope: 'operator',
          occurred_at: '2026-10-07T20:00:00+00:00',
          excerpt: 'A previous owner outage blocked the next strategic read.',
          source_refs: [{
            owner: 'ai-verse-memory',
            scope: 'operator',
            kind: 'memory',
            id: 'memory-1',
            version: 'sha256:v1',
          }],
          provenance: {
            owner: 'ai-verse-memory',
            source_identity: 'sha256:i1',
            source_version: 'sha256:v1',
            freshness: 'historical',
          },
          raw_memory_record: { secret: 'must not cross' },
          goals: [{ statement: 'must not become authority' }],
        }],
        truncated: false,
        returned: 1,
        candidate_count: 1,
      };
    },
  });

  assert.equal(explicitCalls, 1, 'explicit historical read must invoke Memory exactly once');
  assert.equal(historical.owner, 'ai-verse-memory');
  assert.equal(historical.evidence_role, 'historical');
  assert.equal(historical.authoritative_for_current_state, false);
  assert.equal(historical.history.length, 1);
  assert.deepEqual(historical.history[0], {
    kind: 'historical_evidence',
    evidence_role: 'historical',
    authoritative_for_current_state: false,
    occurred_at: '2026-10-07T20:00:00+00:00',
    statement: 'A previous owner outage blocked the next strategic read.',
    source_refs: [{
      owner: 'ai-verse-memory',
      scope: 'operator',
      kind: 'memory',
      id: 'memory-1',
      version: 'sha256:v1',
    }],
  });
  assert.equal(Object.hasOwn(historical.history[0], 'raw_memory_record'), false);
  assert.equal(Object.hasOwn(historical.history[0], 'goals'), false);
  assert.equal(Object.hasOwn(historical.history[0], 'provenance'), false);

  assert.throws(
    () => readPurposeHistoricalEvidence({
      scope: 'operator', purposeRefs: [], query: 'x', readMemoryPurposeHistory() {},
    }),
    /purposeRefs must contain between 1 and 32 canonical refs/,
  );
  assert.throws(
    () => readPurposeHistoricalEvidence({
      scope: 'operator', purposeRefs, query: '', readMemoryPurposeHistory() {},
    }),
    /query must be a non-empty string/,
  );
  assert.throws(
    () => readPurposeHistoricalEvidence({
      scope: 'operator', purposeRefs: [{ ...purposeRefs[0], scope: 'workspace:other' }], query: 'x', readMemoryPurposeHistory() {},
    }),
    /scope does not match Purpose scope/,
  );
  assert.throws(
    () => readPurposeHistoricalEvidence({
      scope: 'operator', purposeRefs, query: 'x', limit: 9, readMemoryPurposeHistory() {},
    }),
    /limit must be an integer between 1 and 8/,
  );
  assert.throws(
    () => readPurposeHistoricalEvidence({
      scope: 'operator', purposeRefs, query: 'x', maxBytes: 8193, readMemoryPurposeHistory() {},
    }),
    /maxBytes must be an integer between 1 and 8192/,
  );
  assert.throws(
    () => readPurposeHistoricalEvidence({ scope: 'operator', purposeRefs, query: 'x' }),
    /requires an explicit Memory owner reader/,
  );

  assert.throws(
    () => readPurposeHistoricalEvidence({
      scope: 'operator',
      purposeRefs,
      query: 'x',
      limit: 1,
      readMemoryPurposeHistory() {
        const base = {
          type: 'lesson',
          scope: 'operator',
          occurred_at: '2026-10-07T20:00:00+00:00',
          excerpt: 'bounded',
          provenance: {
            owner: 'ai-verse-memory',
            source_identity: 'sha256:i',
            source_version: 'sha256:v',
            freshness: 'historical',
          },
        };
        return {
          api_version: 'memory.purpose-history.v1',
          scope: 'operator',
          history: [1, 2].map((n) => ({
            ...base,
            id: `memory-${n}`,
            source_refs: [{ owner: 'ai-verse-memory', scope: 'operator', kind: 'memory', id: `memory-${n}`, version: 'sha256:v' }],
          })),
          truncated: false,
        };
      },
    }),
    /exceeded the explicitly requested item limit/,
  );

  process.stdout.write('Purpose Memory explicit bounded read gate: PASS\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
