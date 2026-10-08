const MATERIAL_CHANGE_SCHEMA_VERSION = 'purpose.material-changes.v1';
const MAX_CANDIDATES = 64;
const MAX_CHANGES = 20;

const MATERIALITY_DIMENSIONS = Object.freeze([
  'goal_status',
  'priority',
  'feasibility',
  'blocker_state',
  'strategy_validity',
  'risk',
  'kpi_trend',
  'kpi_threshold',
  'initiative_status',
  'scope',
  'direction_ownership',
]);
const MATERIALITY_SET = new Set(MATERIALITY_DIMENSIONS);

function invalid(message) {
  const error = new Error(message);
  error.code = 'PURPOSE_MATERIAL_CHANGE_INVALID';
  throw error;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a non-empty string`);
  return value.trim();
}

function validateScope(scope) {
  const value = requireString(scope, 'Purpose scope');
  if (value !== 'operator' && !/^workspace:[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value)) {
    invalid('Purpose scope must be operator or canonical workspace:<id>');
  }
  return value;
}

function validateTimestamp(value, label) {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) invalid(`${label} must be an owner timestamp`);
  return timestamp;
}

function normalizeMateriality(value, index) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(`candidates[${index}].materiality must be an array`);
  const normalized = [];
  const seen = new Set();
  for (const [materialityIndex, raw] of value.entries()) {
    const item = requireString(raw, `candidates[${index}].materiality[${materialityIndex}]`);
    if (!MATERIALITY_SET.has(item)) {
      invalid(`candidates[${index}] has unsupported materiality dimension ${item}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }
  normalized.sort();
  return normalized;
}

function compareChanges(a, b) {
  const time = Date.parse(b.occurred_at) - Date.parse(a.occurred_at);
  if (time !== 0) return time;
  const dimensions = a.materiality.join('\u0000').localeCompare(b.materiality.join('\u0000'));
  if (dimensions !== 0) return dimensions;
  const event = a.event.localeCompare(b.event);
  if (event !== 0) return event;
  return a.effect.localeCompare(b.effect);
}

export function classifyPurposeMaterialChanges(scope, candidates = []) {
  const expectedScope = validateScope(scope);
  if (!Array.isArray(candidates)) invalid('Purpose material-change candidates must be an array');
  if (candidates.length > MAX_CANDIDATES) {
    invalid(`Purpose material-change candidates exceed hard cap ${MAX_CANDIDATES}`);
  }

  const changes = [];
  let excludedNonMaterial = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      invalid(`candidates[${index}] must be an object`);
    }
    if (candidate.scope !== expectedScope) {
      invalid(`candidates[${index}] scope does not match Purpose scope`);
    }

    const materiality = normalizeMateriality(candidate.materiality, index);
    if (materiality.length === 0) {
      excludedNonMaterial += 1;
      continue;
    }

    changes.push({
      kind: 'material_change',
      occurred_at: validateTimestamp(candidate.occurred_at, `candidates[${index}].occurred_at`),
      event: requireString(candidate.event, `candidates[${index}].event`),
      effect: requireString(candidate.effect, `candidates[${index}].effect`),
      materiality,
    });
  }

  changes.sort(compareChanges);
  const admitted = changes.slice(0, MAX_CHANGES);
  return {
    schema_version: MATERIAL_CHANGE_SCHEMA_VERSION,
    scope: expectedScope,
    changes: admitted,
    candidate_count: candidates.length,
    excluded_non_material_count: excludedNonMaterial,
    truncated: changes.length > admitted.length,
  };
}

export const PURPOSE_MATERIAL_CHANGE_LIMITS = Object.freeze({
  max_candidates: MAX_CANDIDATES,
  max_changes: MAX_CHANGES,
});

export { MATERIAL_CHANGE_SCHEMA_VERSION, MATERIALITY_DIMENSIONS };
