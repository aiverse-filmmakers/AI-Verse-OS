const MATERIAL_CHANGE_SCHEMA_VERSION = 'purpose.material-changes.v1';
const RELEVANCE_SECTIONS = Object.freeze(['goals', 'strategies', 'initiatives']);
const RELEVANCE_TARGET_OWNERS = new Set(['ai-verse-os', 'ai-verse-brain']);
const RELEVANCE_EFFECTS = new Set(['elevated', 'deprioritized', 'blocked', 'reconsider', 'invalidated', 'restored']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'PURPOSE_MATERIAL_RELEVANCE_INVALID';
  throw error;
}

function canonicalRefKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const { owner, scope, kind, id } = ref;
  if (![owner, scope, kind, id].every((value) => typeof value === 'string' && value.length > 0)) return null;
  if (ref.version !== undefined && (typeof ref.version !== 'string' || !ref.version.length)) return null;
  return [owner, scope, kind, id, ref.version ?? ''].join('\u0000');
}

function copyRef(ref) {
  const key = canonicalRefKey(ref);
  if (!key) invalid('material relevance requires canonical strategic refs');
  return ref.version
    ? { owner: ref.owner, scope: ref.scope, kind: ref.kind, id: ref.id, version: ref.version }
    : { owner: ref.owner, scope: ref.scope, kind: ref.kind, id: ref.id };
}

function validateProjection(scope, projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) invalid('material-change projection is required');
  if (projection.schema_version !== MATERIAL_CHANGE_SCHEMA_VERSION) invalid(`material-change schema_version must be ${MATERIAL_CHANGE_SCHEMA_VERSION}`);
  if (projection.scope !== scope) invalid('material-change scope does not match Purpose Context scope');
  if (!Array.isArray(projection.changes)) invalid('material-change projection must contain changes');
}

function buildTargetIndex(envelope) {
  const index = new Map();
  for (const section of RELEVANCE_SECTIONS) {
    const items = Array.isArray(envelope[section]) ? envelope[section] : [];
    for (const item of items) {
      const key = canonicalRefKey(item?.canonical_ref);
      if (!key) continue;
      index.set(key, { section, item });
    }
  }
  return index;
}

function validateAffectedRef(ref, scope, label) {
  const key = canonicalRefKey(ref);
  if (!key) invalid(`${label} must be a canonical strategic ref`);
  if (!RELEVANCE_TARGET_OWNERS.has(ref.owner)) invalid(`${label} owner cannot be a current strategic relevance target`);
  if (ref.scope !== scope) invalid(`${label} scope does not match Purpose Context scope`);
  return key;
}

function selectedRelevanceChanges(scope, projection) {
  const selected = new Map();
  for (const [index, change] of projection.changes.entries()) {
    if (!Array.isArray(change?.affects) || !change.affects.length) continue;
    if (!RELEVANCE_EFFECTS.has(change.relevance_effect)) invalid(`material change ${index} has unsupported relevance_effect`);
    if (!Array.isArray(change.materiality) || !change.materiality.length) invalid(`material change ${index} materiality is required`);
    if (!Array.isArray(change.source_refs) || !change.source_refs.length) invalid(`material change ${index} source_refs are required`);
    const occurredAt = Date.parse(change.occurred_at);
    if (!Number.isFinite(occurredAt)) invalid(`material change ${index} occurred_at must be an owner timestamp`);

    for (const [refIndex, ref] of change.affects.entries()) {
      const key = validateAffectedRef(ref, scope, `material change ${index} affects[${refIndex}]`);
      const current = selected.get(key);
      if (!current || occurredAt > current.occurredAt) {
        selected.set(key, { change, ref, occurredAt });
      }
    }
  }
  return selected;
}

export function applyPurposeMaterialChangeRelevance(envelope, projection) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) invalid('Purpose Context envelope is required');
  if (typeof envelope.scope !== 'string' || !envelope.scope.length) invalid('Purpose Context scope is required');
  validateProjection(envelope.scope, projection);

  const output = structuredClone(envelope);
  const targetIndex = buildTargetIndex(output);
  const selected = selectedRelevanceChanges(envelope.scope, projection);
  const unmatched = [];
  let applied = 0;

  for (const [key, selection] of selected) {
    const target = targetIndex.get(key);
    if (!target) {
      unmatched.push(copyRef(selection.ref));
      continue;
    }
    const { change } = selection;
    target.item.purpose_relevance = {
      projection_only: true,
      authoritative_for_owner_state: false,
      state: change.relevance_effect,
      as_of: change.occurred_at,
      materiality: [...change.materiality],
      source_refs: structuredClone(change.source_refs),
    };
    applied += 1;
  }

  unmatched.sort((a, b) => canonicalRefKey(a).localeCompare(canonicalRefKey(b)));
  output.recent_material_changes = structuredClone(projection.changes);
  output.section_states ??= {};
  output.section_states.material_change_relevance = {
    state: unmatched.length ? 'partial' : 'ok',
    applied_count: applied,
    unmatched_target_count: unmatched.length,
  };
  if (unmatched.length) output.section_states.material_change_relevance.unmatched_refs = unmatched;

  return output;
}

export { RELEVANCE_SECTIONS };
