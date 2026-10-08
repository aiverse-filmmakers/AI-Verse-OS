export const PURPOSE_BUDGET_POLICY_VERSION = 'os.purpose-budget-policy.v1';

// Lowest-retention sections appear first. When the projection exceeds its byte
// budget, OS removes one item at a time following this exact order. This is a
// projection-only policy and never mutates canonical owner state.
export const PURPOSE_TRUNCATION_PRIORITY = Object.freeze([
  'recent_material_changes',
  'team_resources',
  'customers',
  'infrastructure',
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
]);

export function purposeTruncationRank(section) {
  return PURPOSE_TRUNCATION_PRIORITY.indexOf(section);
}
