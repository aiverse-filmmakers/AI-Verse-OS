const MAX_BINDINGS = 32;
const DEFAULT_MAX_BYTES = 16_384;

function invalid(message) {
  const error = new Error(message);
  error.code = 'PURPOSE_DATA_CURRENT_STATE_INVALID';
  throw error;
}

function canonicalRefKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const { owner, scope, kind, id } = ref;
  if (![owner, scope, kind, id].every((value) => typeof value === 'string' && value.length > 0)) return null;
  if (typeof ref.version !== 'undefined' && typeof ref.version !== 'string') return null;
  return [owner, scope, kind, id, ref.version ?? ''].join('\u0000');
}

function copyCanonicalRef(ref, label) {
  const key = canonicalRefKey(ref);
  if (!key) invalid(`${label} must be an exact canonical Purpose ref`);
  return typeof ref.version === 'string'
    ? { owner: ref.owner, scope: ref.scope, kind: ref.kind, id: ref.id, version: ref.version }
    : { owner: ref.owner, scope: ref.scope, kind: ref.kind, id: ref.id };
}

function collectPurposeRefs(envelope) {
  const refs = new Map();
  const add = (ref) => {
    const key = canonicalRefKey(ref);
    if (!key || ref.scope !== envelope.scope || ref.owner === 'ai-verse-data') return;
    if (!refs.has(key)) refs.set(key, copyCanonicalRef(ref, 'Purpose ref'));
  };
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    add(value);
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'provenance') visit(child);
    }
  };
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== 'provenance') visit(value);
  }
  for (const ownerRead of envelope.provenance?.owner_reads ?? []) {
    for (const ref of ownerRead?.canonical_refs ?? []) add(ref);
  }
  return refs;
}

function dataRefKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || ref.owner !== 'ai-verse-data') return null;
  const keys = ['spaceId', 'entity', 'recordId', 'field'];
  if (!keys.every((key) => typeof ref[key] === 'string' && ref[key].length > 0)) return null;
  return [ref.owner, ref.spaceId, ref.entity, ref.recordId, ref.field].join('\u0000');
}

function copyDataRef(ref, label) {
  if (!dataRefKey(ref)) invalid(`${label} must keep an exact ai-verse-data field ref`);
  return {
    owner: 'ai-verse-data',
    spaceId: ref.spaceId,
    entity: ref.entity,
    recordId: ref.recordId,
    field: ref.field,
  };
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function copySourceProvenance(provenance, workspaceId, label) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    invalid(`${label}.provenance is required`);
  }
  if (provenance.scope?.workspaceId !== workspaceId) {
    invalid(`${label}.provenance scope does not match workspace:${workspaceId}`);
  }
  if (typeof provenance.actor?.kind !== 'string' || typeof provenance.actor?.id !== 'string') {
    invalid(`${label}.provenance actor is invalid`);
  }
  if (typeof provenance.authorization?.mode !== 'string') {
    invalid(`${label}.provenance authorization is invalid`);
  }
  if (!Number.isSafeInteger(provenance.schemaVersion) || provenance.schemaVersion < 1) {
    invalid(`${label}.provenance schemaVersion is invalid`);
  }
  if (!Number.isSafeInteger(provenance.recordVersion) || provenance.recordVersion < 1) {
    invalid(`${label}.provenance recordVersion is invalid`);
  }
  return structuredClone(provenance);
}

function compareBindings(a, b) {
  const left = `${canonicalRefKey(a.purpose_ref)}\u0000${dataRefKey(a.current?.source_ref) ?? ''}`;
  const right = `${canonicalRefKey(b.purpose_ref)}\u0000${dataRefKey(b.current?.source_ref) ?? ''}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function addBudgetOmission(envelope, maxBytes, count) {
  if (count < 1) return;
  envelope.provenance ??= {};
  envelope.provenance.budget ??= {
    max_bytes: maxBytes,
    final_bytes: 0,
    truncated: true,
    omissions: [],
  };
  envelope.provenance.budget.max_bytes = maxBytes;
  envelope.provenance.budget.truncated = true;
  const omissions = envelope.provenance.budget.omissions ??= [];
  let entry = omissions.find((item) => item.section === 'current_state' && item.reason === 'byte_budget');
  if (!entry) {
    entry = { section: 'current_state', reason: 'byte_budget', omitted_count: 0 };
    omissions.push(entry);
  }
  entry.omitted_count += count;
}

function stabilizeBudget(envelope) {
  if (!envelope.provenance?.budget) return serializedBytes(envelope);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = serializedBytes(envelope);
    envelope.provenance.budget.final_bytes = size;
    const next = serializedBytes(envelope);
    if (next === size) return next;
  }
  return serializedBytes(envelope);
}

function enforceAddedDataBudget(envelope, dataItems, maxBytes) {
  let omitted = 0;
  let size = serializedBytes(envelope);
  while (size > maxBytes && dataItems.length) {
    const item = dataItems.pop();
    const index = envelope.current_state?.lastIndexOf(item) ?? -1;
    if (index >= 0) envelope.current_state.splice(index, 1);
    omitted += 1;
    size = serializedBytes(envelope);
  }
  if (omitted) {
    addBudgetOmission(envelope, maxBytes, omitted);
    size = stabilizeBudget(envelope);
  }
  if (size > maxBytes) invalid(`Purpose Data current-state projection exceeds byte budget ${maxBytes}`);
  return envelope;
}

export function applyPurposeDataCurrentState(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    invalid('Purpose Context envelope is required');
  }
  const output = structuredClone(envelope);
  const reader = options.readPurposeDataCurrentState;
  if (typeof reader !== 'function') return output;

  const relevantRefs = collectPurposeRefs(output);
  const purposeRefs = [...relevantRefs.values()].sort((a, b) => canonicalRefKey(a).localeCompare(canonicalRefKey(b)));
  const result = reader(Object.freeze({
    scope: output.scope,
    purpose_refs: Object.freeze(purposeRefs.map((ref) => Object.freeze({ ...ref }))),
  }));
  if (!result || typeof result !== 'object' || Array.isArray(result)) invalid('Data Purpose reader returned an invalid result');
  if (result.scope !== output.scope) invalid(`Data Purpose reader returned the wrong scope for ${output.scope}`);
  if (result.status !== 'ok') return output;
  if (!Array.isArray(result.bindings)) invalid('Data Purpose reader bindings must be an array');
  if (result.bindings.length > MAX_BINDINGS) invalid(`Data Purpose reader supports at most ${MAX_BINDINGS} bindings`);
  if (output.scope_kind === 'operator' && result.bindings.length > 0) {
    invalid('operator Data current-state projection requires an operator Data scope contract');
  }

  const workspaceId = output.scope_kind === 'workspace' ? output.identity?.id : null;
  const dataItems = [];
  const seen = new Set();
  for (const [index, binding] of [...result.bindings].sort(compareBindings).entries()) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) invalid(`bindings[${index}] must be an object`);
    const purposeKey = canonicalRefKey(binding.purpose_ref);
    if (!purposeKey || !relevantRefs.has(purposeKey)) continue;
    const current = binding.current;
    if (!current || typeof current !== 'object' || Array.isArray(current)) invalid(`bindings[${index}].current must be a transient Data projection`);
    if (current.projection !== 'transient' || current.source_owner !== 'ai-verse-data') {
      invalid(`bindings[${index}].current must remain a transient ai-verse-data projection`);
    }
    if (current.state !== 'value') continue;
    if (!Object.prototype.hasOwnProperty.call(current, 'value') || !isPrimitive(current.value)) {
      invalid(`bindings[${index}].current value must be a JSON primitive`);
    }
    if (typeof current.source_updated_at !== 'string' || !Number.isFinite(Date.parse(current.source_updated_at))) {
      invalid(`bindings[${index}].current source_updated_at must be an owner timestamp`);
    }
    const sourceRef = copyDataRef(current.source_ref, `bindings[${index}].current.source_ref`);
    const sourceProvenance = copySourceProvenance(current.provenance, workspaceId, `bindings[${index}].current`);
    const dedupeKey = `${purposeKey}\u0000${dataRefKey(sourceRef)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    dataItems.push({
      kind: 'data_current_state',
      state: 'value',
      value: current.value,
      purpose_ref: copyCanonicalRef(binding.purpose_ref, `bindings[${index}].purpose_ref`),
      source_owner: 'ai-verse-data',
      source_ref: sourceRef,
      source_updated_at: current.source_updated_at,
      source_provenance: sourceProvenance,
    });
  }

  if (dataItems.length) {
    output.current_state ??= [];
    output.current_state.push(...dataItems);
  }
  output.provenance ??= { projection_owner: 'ai-verse-os', generated_at: options.now ?? new Date().toISOString(), owner_reads: [] };
  output.provenance.owner_reads ??= [];
  output.provenance.owner_reads.push({
    owner: 'ai-verse-data',
    operation: 'purpose-current-state.read',
    scope: output.scope,
    status: 'ok',
    observed_at: options.now ?? output.provenance.generated_at ?? new Date().toISOString(),
    freshness: { state: 'owner_timestamped' },
    canonical_refs: [],
  });

  return enforceAddedDataBudget(output, dataItems, options.maxBytes ?? DEFAULT_MAX_BYTES);
}
