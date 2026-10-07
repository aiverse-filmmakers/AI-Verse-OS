import { projectPurposeMemoryHistory } from './purpose-memory-history-boundary.mjs';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 8;
const DEFAULT_MAX_BYTES = 8192;
const MAX_MAX_BYTES = 8192;
const DEFAULT_MAX_AGE_DAYS = 90;
const MAX_MAX_AGE_DAYS = 365;
const MAX_PURPOSE_REFS = 32;
const MAX_QUERY_CHARS = 4096;

function compareText(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRefs(a, b) {
  for (const key of ['owner', 'scope', 'kind', 'id', 'version']) {
    const result = compareText(a?.[key], b?.[key]);
    if (result !== 0) return result;
  }
  return 0;
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function validateScope(scope) {
  const value = requireString(scope, 'Purpose scope');
  if (value !== 'operator' && !/^workspace:[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value)) {
    throw new Error('Purpose scope must be operator or canonical workspace:<id>');
  }
  return value;
}

function validatePurposeRefs(scope, purposeRefs) {
  if (!Array.isArray(purposeRefs) || purposeRefs.length < 1 || purposeRefs.length > MAX_PURPOSE_REFS) {
    throw new Error(`purposeRefs must contain between 1 and ${MAX_PURPOSE_REFS} canonical refs`);
  }
  const refs = purposeRefs.map((ref, index) => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new Error(`purposeRefs[${index}] must be an object`);
    }
    const owner = requireString(ref.owner, `purposeRefs[${index}].owner`);
    const refScope = requireString(ref.scope, `purposeRefs[${index}].scope`);
    const kind = requireString(ref.kind, `purposeRefs[${index}].kind`);
    const id = requireString(ref.id, `purposeRefs[${index}].id`);
    if (refScope !== scope) throw new Error(`purposeRefs[${index}] scope does not match Purpose scope`);
    const result = { owner, scope: refScope, kind, id };
    if (ref.version !== undefined) result.version = requireString(ref.version, `purposeRefs[${index}].version`);
    return result;
  });
  refs.sort(compareRefs);
  return refs;
}

function validateBoundedInteger(value, fallback, max, label) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 1 || actual > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return actual;
}

export function readPurposeHistoricalEvidence({
  scope,
  purposeRefs,
  query,
  readMemoryPurposeHistory,
  limit = DEFAULT_LIMIT,
  maxBytes = DEFAULT_MAX_BYTES,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
} = {}) {
  const resolvedScope = validateScope(scope);
  const refs = validatePurposeRefs(resolvedScope, purposeRefs);
  const queryValue = requireString(query, 'Purpose history query');
  if (queryValue.length > MAX_QUERY_CHARS) {
    throw new Error(`Purpose history query must be at most ${MAX_QUERY_CHARS} characters`);
  }
  const boundedLimit = validateBoundedInteger(limit, DEFAULT_LIMIT, MAX_LIMIT, 'Purpose history limit');
  const boundedBytes = validateBoundedInteger(maxBytes, DEFAULT_MAX_BYTES, MAX_MAX_BYTES, 'Purpose history maxBytes');
  const boundedAge = validateBoundedInteger(maxAgeDays, DEFAULT_MAX_AGE_DAYS, MAX_MAX_AGE_DAYS, 'Purpose history maxAgeDays');
  if (typeof readMemoryPurposeHistory !== 'function') {
    throw new Error('Purpose historical evidence requires an explicit Memory owner reader');
  }

  const response = readMemoryPurposeHistory({
    scope: resolvedScope,
    purpose_refs: refs,
    query: queryValue,
    limit: boundedLimit,
    max_bytes: boundedBytes,
    max_age_days: boundedAge,
  });
  const projection = projectPurposeMemoryHistory(resolvedScope, response);
  if (projection.history.length > boundedLimit) {
    throw new Error('Memory Purpose history exceeded the explicitly requested item limit');
  }
  return projection;
}

export const PURPOSE_MEMORY_HISTORY_READ_LIMITS = Object.freeze({
  default_limit: DEFAULT_LIMIT,
  max_limit: MAX_LIMIT,
  default_max_bytes: DEFAULT_MAX_BYTES,
  max_max_bytes: MAX_MAX_BYTES,
  default_max_age_days: DEFAULT_MAX_AGE_DAYS,
  max_max_age_days: MAX_MAX_AGE_DAYS,
});
