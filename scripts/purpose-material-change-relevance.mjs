const MATERIAL_CHANGE_SCHEMA_VERSION = 'purpose.material-changes.v1';
const RELEVANCE_SECTIONS = Object.freeze(['goals', 'strategies', 'initiatives']);

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

function selectedRelevanceChanges(projection) {
  const selected = new Map();
  for (const change of projection.changes) {
    if (!Array.isArray(change?.affects) || !change.affects.length || typeof change.relevance_effect !== 'string') continue;
    for (const ref of change.affects) {
      const key = canonicalRefKey(ref);
      if (!key) invalid('material-change affects must remain canonical');
      if (!selected.has(key)) selected.set(key, { change, ref });
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
  const selected = selectedRelevanceChanges(projection);
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
