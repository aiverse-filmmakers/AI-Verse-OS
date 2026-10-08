const MATERIAL_CHANGE_SCHEMA_VERSION = 'purpose.material-changes.v1';
const MAX_CANDIDATES = 64;
const MAX_CHANGES = 20;
const MAX_SOURCE_REFS = 8;

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
const CANONICAL_REF_OWNERS = new Set(['ai-verse-os', 'ai-verse-brain', 'ai-verse-memory']);

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

function canonicalRefKey(ref) {
  return ['canonical', ref.owner, ref.scope, ref.kind, ref.id, ref.version ?? ''].join('\u0000');
}

function dataRefKey(ref) {
  return ['data', ref.owner, ref.spaceId, ref.entity, ref.recordId, ref.field].join('\u0000');
}

function sourceRefKey(ref) {
  return ref.owner === 'ai-verse-data' ? dataRefKey(ref) : canonicalRefKey(ref);
}

function normalizeCanonicalOwnerRef(ref, scope, label) {
  const owner = requireString(ref.owner, `${label}.owner`);
  if (!CANONICAL_REF_OWNERS.has(owner)) invalid(`${label}.owner ${owner} is not an admitted Purpose material-change owner`);
  const refScope = requireString(ref.scope, `${label}.scope`);
  if (refScope !== scope) invalid(`${label}.scope does not match Purpose scope`);
  const kind = requireString(ref.kind, `${label}.kind`);
  const id = requireString(ref.id, `${label}.id`);
  let version;
  if (ref.version !== undefined) version = requireString(ref.version, `${label}.version`);
  if (owner === 'ai-verse-memory') {
    if (kind !== 'memory') invalid(`${label}.kind must be memory for ai-verse-memory`);
    if (!version) invalid(`${label}.version is required for ai-verse-memory provenance`);
  }
  return version ? { owner, scope: refScope, kind, id, version } : { owner, scope: refScope, kind, id };
}

function normalizeDataOwnerRef(ref, scope, label) {
  if (!scope.startsWith('workspace:')) invalid(`${label} cannot use ai-verse-data without a workspace Data scope contract`);
  const workspaceId = scope.slice('workspace:'.length);
  const spaceId = requireString(ref.spaceId, `${label}.spaceId`);
  if (spaceId !== workspaceId) invalid(`${label}.spaceId does not match Purpose workspace scope`);
  return {
    owner: 'ai-verse-data',
    spaceId,
    entity: requireString(ref.entity, `${label}.entity`),
    recordId: requireString(ref.recordId, `${label}.recordId`),
    field: requireString(ref.field, `${label}.field`),
  };
}

function normalizeSourceRef(ref, scope, label) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) invalid(`${label} must be an object`);
  const owner = requireString(ref.owner, `${label}.owner`);
  if (owner === 'ai-verse-data') return normalizeDataOwnerRef(ref, scope, label);
  return normalizeCanonicalOwnerRef(ref, scope, label);
}

function normalizeSourceRefs(value, scope, index) {
  if (!Array.isArray(value) || value.length < 1) {
    invalid(`candidates[${index}].source_refs must contain at least one exact owner-backed source ref`);
  }
  if (value.length > MAX_SOURCE_REFS) {
    invalid(`candidates[${index}].source_refs exceed hard cap ${MAX_SOURCE_REFS}`);
  }
  const refs = new Map();
  for (const [refIndex, raw] of value.entries()) {
    const ref = normalizeSourceRef(raw, scope, `candidates[${index}].source_refs[${refIndex}]`);
    const key = sourceRefKey(ref);
    if (!refs.has(key)) refs.set(key, ref);
  }
  return [...refs.values()].sort((a, b) => sourceRefKey(a).localeCompare(sourceRefKey(b)));
}

function compareChanges(a, b) {
  const time = Date.parse(b.occurred_at) - Date.parse(a.occurred_at);
  if (time !== 0) return time;
  const dimensions = a.materiality.join('\u0000').localeCompare(b.materiality.join('\u0000'));
  if (dimensions !== 0) return dimensions;
  const refs = a.source_refs.map(sourceRefKey).join('\u0001').localeCompare(b.source_refs.map(sourceRefKey).join('\u0001'));
  if (refs !== 0) return refs;
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
      source_refs: normalizeSourceRefs(candidate.source_refs, expectedScope, index),
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
  max_source_refs: MAX_SOURCE_REFS,
});

export { MATERIAL_CHANGE_SCHEMA_VERSION, MATERIALITY_DIMENSIONS };
