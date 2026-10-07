const MEMORY_PURPOSE_HISTORY_VERSION = 'memory.purpose-history.v1';
const MEMORY_OWNER = 'ai-verse-memory';
const MAX_HISTORY_ITEMS = 20;

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

function validateMemoryRef(ref, item, scope, index) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error(`Memory history item ${index} source ref must be an object`);
  }
  const owner = requireString(ref.owner, `Memory history item ${index} source owner`);
  const refScope = requireString(ref.scope, `Memory history item ${index} source scope`);
  const kind = requireString(ref.kind, `Memory history item ${index} source kind`);
  const id = requireString(ref.id, `Memory history item ${index} source id`);
  const version = requireString(ref.version, `Memory history item ${index} source version`);
  if (owner !== MEMORY_OWNER) throw new Error(`Memory history item ${index} source owner must be ${MEMORY_OWNER}`);
  if (refScope !== scope) throw new Error(`Memory history item ${index} source scope does not match Purpose scope`);
  if (kind !== 'memory') throw new Error(`Memory history item ${index} source kind must be memory`);
  if (id !== item.id) throw new Error(`Memory history item ${index} source id does not match item id`);
  return { owner, scope: refScope, kind, id, version };
}

function validateHistoryItem(item, scope, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`Memory history item ${index} must be an object`);
  }
  const id = requireString(item.id, `Memory history item ${index} id`);
  const itemScope = requireString(item.scope, `Memory history item ${index} scope`);
  if (itemScope !== scope) throw new Error(`Memory history item ${index} scope does not match Purpose scope`);
  const occurredAt = requireString(item.occurred_at, `Memory history item ${index} occurred_at`);
  const excerpt = requireString(item.excerpt, `Memory history item ${index} excerpt`);
  if (!Array.isArray(item.source_refs) || item.source_refs.length !== 1) {
    throw new Error(`Memory history item ${index} must carry exactly one canonical Memory source ref`);
  }
  const sourceRef = validateMemoryRef(item.source_refs[0], { id }, scope, index);
  const provenance = item.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error(`Memory history item ${index} provenance must be an object`);
  }
  if (provenance.owner !== MEMORY_OWNER) throw new Error(`Memory history item ${index} provenance owner must be ${MEMORY_OWNER}`);
  if (provenance.freshness !== 'historical') {
    throw new Error(`Memory history item ${index} must be explicitly historical`);
  }
  requireString(provenance.source_identity, `Memory history item ${index} source_identity`);
  const sourceVersion = requireString(provenance.source_version, `Memory history item ${index} source_version`);
  if (sourceVersion !== sourceRef.version) {
    throw new Error(`Memory history item ${index} source version mismatch`);
  }

  return {
    kind: 'historical_evidence',
    evidence_role: 'historical',
    authoritative_for_current_state: false,
    occurred_at: occurredAt,
    statement: excerpt,
    source_refs: [sourceRef],
  };
}

export function projectPurposeMemoryHistory(scope, memoryHistory) {
  const expectedScope = requireString(scope, 'Purpose scope');
  if (!memoryHistory || typeof memoryHistory !== 'object' || Array.isArray(memoryHistory)) {
    throw new Error('Memory Purpose history response must be an object');
  }
  if (memoryHistory.api_version !== MEMORY_PURPOSE_HISTORY_VERSION) {
    throw new Error(`Memory Purpose history api_version must be ${MEMORY_PURPOSE_HISTORY_VERSION}`);
  }
  if (memoryHistory.scope !== expectedScope) {
    throw new Error('Memory Purpose history scope does not match Purpose scope');
  }
  if (!Array.isArray(memoryHistory.history)) throw new Error('Memory Purpose history must contain a history array');
  if (memoryHistory.history.length > MAX_HISTORY_ITEMS) {
    throw new Error(`Memory Purpose history exceeds hard item cap ${MAX_HISTORY_ITEMS}`);
  }

  const history = memoryHistory.history.map((item, index) => validateHistoryItem(item, expectedScope, index));
  history.sort((a, b) => {
    const time = compareText(b.occurred_at, a.occurred_at);
    if (time !== 0) return time;
    return compareRefs(a.source_refs[0], b.source_refs[0]);
  });

  const canonicalRefs = [];
  const seen = new Set();
  for (const item of history) {
    const ref = item.source_refs[0];
    const key = [ref.owner, ref.scope, ref.kind, ref.id, ref.version].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    canonicalRefs.push({ ...ref });
  }
  canonicalRefs.sort(compareRefs);

  return {
    owner: MEMORY_OWNER,
    operation: 'purpose-history.read',
    scope: expectedScope,
    status: 'ok',
    evidence_role: 'historical',
    authoritative_for_current_state: false,
    canonical_refs: canonicalRefs,
    history,
    truncated: memoryHistory.truncated === true,
  };
}

export { MEMORY_PURPOSE_HISTORY_VERSION };
