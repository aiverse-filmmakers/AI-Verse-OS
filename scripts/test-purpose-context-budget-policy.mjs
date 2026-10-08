#!/usr/bin/env node

import assert from 'node:assert/strict';

import {
  PURPOSE_BUDGET_POLICY_VERSION,
  PURPOSE_TRUNCATION_PRIORITY,
  purposeTruncationRank,
} from './purpose-context-budget-policy.mjs';

const expected = [
  'recent_material_changes',
  'team_resources',
  'risks',
  'kpis',
  'narratives',
  'current_state',
  'current_work',
  'constraints',
  'priorities',
  'challenges',
  'initiatives',
  'strategies',
  'problems',
  'goals',
  'purpose.desired_outcomes',
  'purpose.missions',
  'trajectory',
];

assert.equal(PURPOSE_BUDGET_POLICY_VERSION, 'os.purpose-budget-policy.v1');
assert.deepEqual([...PURPOSE_TRUNCATION_PRIORITY], expected);
assert.equal(new Set(PURPOSE_TRUNCATION_PRIORITY).size, PURPOSE_TRUNCATION_PRIORITY.length);
for (let index = 0; index < expected.length; index += 1) {
  assert.equal(purposeTruncationRank(expected[index]), index);
}
assert.equal(purposeTruncationRank('unknown'), -1);
assert.ok(
  purposeTruncationRank('recent_material_changes') < purposeTruncationRank('trajectory'),
  'optional material-change context must be discarded before trajectory',
);
assert.ok(
  purposeTruncationRank('team_resources') < purposeTruncationRank('purpose.missions'),
  'optional team/resource context must be discarded before mission',
);
assert.ok(
  purposeTruncationRank('narratives') < purposeTruncationRank('purpose.missions'),
  'optional narrative context must be discarded before mission',
);

process.stdout.write('Purpose Context truncation-priority policy: PASS\n');
