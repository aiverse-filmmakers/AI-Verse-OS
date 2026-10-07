import fs from 'node:fs';
import path from 'node:path';

import { readCurrentContext } from './current-context.mjs';
import { validateDirectionScope } from './direction-owner-core.mjs';

const PURPOSE_SCHEMA_VERSION = '1.0';
const PURPOSE_DEFAULT_MAX_BYTES = 16384;
const PURPOSE_MIN_MAX_BYTES = 4096;
const PURPOSE_MAX_MAX_BYTES = 65536;
const PURPOSE_SECTION_CAP = 64;
const PURPOSE_PURPOSE_CAP = 32;
const PURPOSE_TRAJECTORY_CAP = 128;
const PURPOSE_PRUNE_ORDER = [
  'recent_material_changes',
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

function samePath(a, b) {
  return path.relative(a, b) === '' && path.relative(b, a) === '';
}

function requirePhysicalDirectory(target, expected, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} does not exist`);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (!samePath(real, expected)) throw new Error(`${label} is not its expected physical slot`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory`);
  return real;
}

function compareText(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRefTuple(ref) {
  if (!ref || typeof ref !== 'object') return ['', '', '', '', ''];
  return [
    ref.owner ?? '',
    ref.scope ?? '',
    ref.kind ?? '',
    ref.id ?? '',
    ref.version ?? '',
  ].map((value) => String(value));
}

function compareCanonicalRefs(a, b) {
  const left = canonicalRefTuple(a);
  const right = canonicalRefTuple(b);
  for (let index = 0; index < left.length; index += 1) {
    const result = compareText(left[index], right[index]);
    if (result !== 0) return result;
  }
  return 0;
}

function ownerOrderHint(item) {
  for (const source of [item, item?.payload]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['order', 'rank', 'priority']) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) return { type: 'number', value };
      if (typeof value === 'string' && value.trim()) return { type: 'string', value: value.trim() };
    }
  }
  return null;
}

function compareStrategicItems(a, b) {
  const aHint = ownerOrderHint(a);
  const bHint = ownerOrderHint(b);
  if (aHint || bHint) {
    if (!aHint) return 1;
    if (!bHint) return -1;
    if (aHint.type === 'number' && bHint.type === 'number' && aHint.value !== bHint.value) return aHint.value - bHint.value;
    const hintType = compareText(aHint.type, bHint.type);
    if (hintType !== 0) return hintType;
    const hintValue = compareText(aHint.value, bHint.value);
    if (hintValue !== 0) return hintValue;
  }

  const refOrder = compareCanonicalRefs(a?.canonical_ref, b?.canonical_ref);
  if (refOrder !== 0) return refOrder;
  return compareText(a?.id ?? a?.generated_id, b?.id ?? b?.generated_id);
}

function compareTrajectoryEdges(a, b) {
  const from = compareCanonicalRefs(a?.from_ref, b?.from_ref);
  if (from !== 0) return from;
  const relation = compareText(a?.relation, b?.relation);
  if (relation !== 0) return relation;
  const to = compareCanonicalRefs(a?.to_ref, b?.to_ref);
  if (to !== 0) return to;
  const aEvidence = [...(a?.source_refs ?? [])].sort(compareCanonicalRefs).map(canonicalRefTuple).flat().join('\u0000');
  const bEvidence = [...(b?.source_refs ?? [])].sort(compareCanonicalRefs).map(canonicalRefTuple).flat().join('\u0000');
  return compareText(aEvidence, bEvidence);
}

function parseSections(text) {
  const result = new Map();
  let heading = null;
  let lines = [];
  const flush = () => {
    if (heading !== null) result.set(heading.toLowerCase().replace(/\s+/g, ' ').trim(), lines.join('\n').trim());
  };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      heading = match[1].trim();
      lines = [];
    } else if (heading !== null) {
      lines.push(line);
    }
  }
  flush();
  return result;
}

function sectionItems(sections, names, kind, sourceRef) {
  const items = [];
  for (const name of names) {
    const value = sections.get(name);
    if (!value) continue;
    const bullets = value.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+\S/.test(line))
      .map((line) => line.replace(/^[-*]\s+/, '').trim());
    const statements = bullets.length ? bullets : [value];
    for (const statement of statements) {
      items.push({ kind, statement, source_refs: sourceRef ? [sourceRef] : [] });
    }
  }
  return items;
}

function readOsProjection(resolved, current) {
  const sections = parseSections(current.current_context);
  const projection = {};
  const ref = current.canonical_ref ?? null;

  if (resolved.scope_kind === 'operator') {
    const priorities = sectionItems(sections, ['current priorities', 'priorities'], 'priority', ref);
    if (priorities.length) projection.priorities = priorities;
  } else {
    const goals = sectionItems(sections, ['objective'], 'workspace_objective', ref);
    if (goals.length) projection.goals = goals;
  }

  const constraints = sectionItems(sections, ['current constraints', 'constraints', 'constraints / approvals'], 'constraint', ref);
  if (constraints.length) projection.constraints = constraints;
  const currentState = sectionItems(sections, ['current state', 'current facts'], 'current_state', ref);
  if (currentState.length) projection.current_state = currentState;
  const currentWork = sectionItems(sections, ['next useful actions', 'active workspaces'], 'current_work', ref);
  if (currentWork.length) projection.current_work = currentWork;
  return projection;
}

function readBrainProjection(snapshot) {
  const projection = {};
  const intents = [...(snapshot?.strategic_objects?.intents ?? [])].sort(compareStrategicItems);
  const gaps = [...(snapshot?.strategic_objects?.gaps ?? [])].sort(compareStrategicItems);
  const initiatives = [...(snapshot?.strategic_objects?.initiatives ?? [])].sort(compareStrategicItems);
  const bucket = (key, item) => {
    if (!projection[key]) projection[key] = [];
    projection[key].push(item);
  };

  for (const item of intents) {
    if (item.semantic_kind === 'problem') bucket('problems', item);
    else if (item.semantic_kind === 'mission') {
      projection.purpose ??= { missions: [], desired_outcomes: [] };
      projection.purpose.missions.push(item);
    } else if (item.semantic_kind === 'desired_outcome') {
      projection.purpose ??= { missions: [], desired_outcomes: [] };
      projection.purpose.desired_outcomes.push(item);
    } else if (item.semantic_kind === 'goal') bucket('goals', item);
    else if (item.semantic_kind === 'strategy') bucket('strategies', item);
  }
  for (const item of gaps) bucket('challenges', item);
  for (const item of initiatives) bucket('initiatives', item);
  if ((snapshot?.relationships ?? []).length) projection.trajectory = [...snapshot.relationships].sort(compareTrajectoryEdges);
  return projection;
}

function canonicalRefKey(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const { owner, scope, kind, id } = ref;
  if (![owner, scope, kind, id].every((value) => typeof value === 'string' && value)) return null;
  return [owner, scope, kind, id, typeof ref.version === 'string' ? ref.version : ''].join('\u0000');
}

function collectBrainRefs(snapshot) {
  const refs = [];
  const seen = new Set();
  const add = (ref) => {
    const key = canonicalRefKey(ref);
    if (!key || seen.has(key)) return;
    seen.add(key);
    refs.push({ ...ref });
  };
  for (const group of Object.values(snapshot?.strategic_objects ?? {})) {
    for (const item of Array.isArray(group) ? group : []) add(item?.canonical_ref);
  }
  for (const edge of snapshot?.relationships ?? []) {
    add(edge?.from_ref);
    add(edge?.to_ref);
    for (const ref of edge?.source_refs ?? []) add(ref);
  }
  return refs.sort(compareCanonicalRefs);
}

function validateMaxBytes(value) {
  const maxBytes = value ?? PURPOSE_DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < PURPOSE_MIN_MAX_BYTES || maxBytes > PURPOSE_MAX_MAX_BYTES) {
    throw new Error(`Purpose Context maxBytes must be an integer between ${PURPOSE_MIN_MAX_BYTES} and ${PURPOSE_MAX_MAX_BYTES}`);
  }
  return maxBytes;
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function addOmission(omissions, section, reason, count = 1) {
  if (count <= 0) return;
  const existing = omissions.find((entry) => entry.section === section && entry.reason === reason);
  if (existing) existing.omitted_count += count;
  else omissions.push({ section, reason, omitted_count: count });
}

function capArray(container, key, limit, omissions, section) {
  const list = container?.[key];
  if (!Array.isArray(list) || list.length <= limit) return;
  const omitted = list.length - limit;
  list.splice(limit);
  addOmission(omissions, section, 'section_cap', omitted);
}

function applySectionCaps(envelope, omissions) {
  for (const key of ['problems', 'narratives', 'goals', 'priorities', 'challenges', 'strategies', 'initiatives', 'constraints', 'kpis', 'risks', 'current_state', 'current_work', 'recent_material_changes']) {
    capArray(envelope, key, PURPOSE_SECTION_CAP, omissions, key);
  }
  if (envelope.purpose && typeof envelope.purpose === 'object') {
    capArray(envelope.purpose, 'missions', PURPOSE_PURPOSE_CAP, omissions, 'purpose.missions');
    capArray(envelope.purpose, 'desired_outcomes', PURPOSE_PURPOSE_CAP, omissions, 'purpose.desired_outcomes');
  }
  capArray(envelope, 'trajectory', PURPOSE_TRAJECTORY_CAP, omissions, 'trajectory');
}

function listAtPath(envelope, pathName) {
  if (pathName.startsWith('purpose.')) {
    const key = pathName.slice('purpose.'.length);
    return Array.isArray(envelope.purpose?.[key]) ? envelope.purpose[key] : null;
  }
  return Array.isArray(envelope[pathName]) ? envelope[pathName] : null;
}

function collectRetainedCanonicalRefKeys(envelope) {
  const keys = new Set();
  const visit = (value, insideProvenance = false) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, insideProvenance);
      return;
    }
    if (typeof value !== 'object') return;
    if (!insideProvenance) {
      const ownKey = canonicalRefKey(value);
      if (ownKey) keys.add(ownKey);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'provenance') continue;
      visit(child, insideProvenance || key === 'provenance');
    }
  };
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== 'provenance') visit(value, false);
  }
  return keys;
}

function syncRetainedOwnerRefs(envelope) {
  const retained = collectRetainedCanonicalRefKeys(envelope);
  for (const ownerRead of envelope.provenance?.owner_reads ?? []) {
    if (ownerRead.owner !== 'ai-verse-brain') continue;
    ownerRead.canonical_refs = (ownerRead.canonical_refs ?? []).filter((ref) => retained.has(canonicalRefKey(ref)));
  }
}

function stabilizeBudgetBytes(envelope) {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = serializedBytes(envelope);
    if (envelope.provenance?.budget) envelope.provenance.budget.final_bytes = size;
    const next = serializedBytes(envelope);
    if (next === size || next === previous) return next;
    previous = size;
  }
  return serializedBytes(envelope);
}

function enforceBudget(envelope, maxBytes) {
  const omissions = [];
  applySectionCaps(envelope, omissions);
  syncRetainedOwnerRefs(envelope);

  let size = serializedBytes(envelope);
  if (omissions.length || size > maxBytes) {
    envelope.provenance.budget = {
      max_bytes: maxBytes,
      final_bytes: 0,
      truncated: true,
      omissions,
    };
    size = stabilizeBudgetBytes(envelope);
  }

  while (size > maxBytes) {
    let pruned = false;
    for (const section of PURPOSE_PRUNE_ORDER) {
      const list = listAtPath(envelope, section);
      if (!list?.length) continue;
      list.pop();
      addOmission(omissions, section, 'byte_budget', 1);
      syncRetainedOwnerRefs(envelope);
      size = stabilizeBudgetBytes(envelope);
      pruned = true;
      break;
    }
    if (!pruned) {
      throw new Error(`Purpose Context minimum exceeds byte budget ${maxBytes}`);
    }
  }

  if (envelope.provenance.budget) {
    envelope.provenance.budget.truncated = omissions.length > 0;
    size = stabilizeBudgetBytes(envelope);
    if (size > maxBytes) throw new Error(`Purpose Context minimum exceeds byte budget ${maxBytes}`);
  }
  return envelope;
}

export function resolvePurposeScope(root, scope = 'operator') {
  const base = path.resolve(root);
  validateDirectionScope(scope);

  const manifest = path.join(base, 'AI-VERSE.yaml');
  if (!fs.existsSync(manifest) || !fs.statSync(manifest).isFile()) {
    throw new Error(`AI-Verse OS root not found: ${base}`);
  }

  if (scope === 'operator') {
    const operator = requirePhysicalDirectory(
      path.join(base, 'operator'),
      path.join(fs.realpathSync(base), 'operator'),
      'operator root',
    );
    return {
      scope: 'operator',
      scope_kind: 'operator',
      identity: { kind: 'operator', id: 'operator' },
      boundary: operator,
    };
  }

  const id = scope.slice('workspace:'.length);
  const realBase = fs.realpathSync(base);
  const workspaces = requirePhysicalDirectory(
    path.join(base, 'workspaces'),
    path.join(realBase, 'workspaces'),
    'workspaces root',
  );
  const workspace = requirePhysicalDirectory(
    path.join(base, 'workspaces', id),
    path.join(workspaces, id),
    `workspace ${id}`,
  );
  const workspaceManifest = path.join(workspace, 'WORKSPACE.yaml');
  if (!fs.existsSync(workspaceManifest) || fs.lstatSync(workspaceManifest).isSymbolicLink() || !fs.statSync(workspaceManifest).isFile()) {
    throw new Error(`workspace ${id} is missing canonical WORKSPACE.yaml`);
  }

  return {
    scope,
    scope_kind: 'workspace',
    identity: { kind: 'workspace', id },
    boundary: workspace,
  };
}

export function readPurposeCurrentContext(root, scope = 'operator') {
  const resolved = resolvePurposeScope(root, scope);
  const current = readCurrentContext(path.resolve(root), resolved.scope);
  if (!current || current.scope !== resolved.scope) {
    throw new Error(`ownership-aware current context returned the wrong scope for ${resolved.scope}`);
  }
  if (!['os', 'brain'].includes(current.direction_owner)) {
    throw new Error(`ownership-aware current context returned an invalid direction owner for ${resolved.scope}`);
  }
  return { resolved, current };
}

export function readPurposeStrategicDirection(root, scope = 'operator', options = {}) {
  const { resolved, current } = readPurposeCurrentContext(root, scope);

  if (current.direction_owner === 'os') {
    return {
      resolved,
      current,
      strategic: {
        owner: 'ai-verse-os',
        status: 'ok',
        owner_path: 'current-context',
        scope: resolved.scope,
        current_context: current.current_context,
        canonical_refs: current.canonical_ref ? [current.canonical_ref] : [],
      },
    };
  }

  const readBrainPurposeSnapshot = options.readBrainPurposeSnapshot;
  if (typeof readBrainPurposeSnapshot !== 'function') {
    return {
      resolved,
      current,
      strategic: {
        owner: 'ai-verse-brain',
        status: 'unavailable',
        reason: 'brain_public_reader_unavailable',
        owner_path: 'brain-purpose-snapshot',
        scope: resolved.scope,
        snapshot: null,
      },
    };
  }

  const snapshot = readBrainPurposeSnapshot(resolved.scope);
  if (!snapshot || snapshot.scope !== resolved.scope || snapshot.direction_owner !== 'brain') {
    throw new Error(`Brain Purpose snapshot violated declared owner/scope contract for ${resolved.scope}`);
  }
  return {
    resolved,
    current,
    strategic: {
      owner: 'ai-verse-brain',
      status: snapshot.status ?? 'unavailable',
      reason: snapshot.reason ?? null,
      owner_path: 'brain-purpose-snapshot',
      scope: resolved.scope,
      snapshot,
    },
  };
}

export function composePurposeContext(root, scope = 'operator', options = {}) {
  const maxBytes = validateMaxBytes(options.maxBytes);
  const observedAt = options.now ?? new Date().toISOString();
  const read = readPurposeStrategicDirection(root, scope, options);
  const { resolved, current, strategic } = read;
  const semantic = strategic.owner === 'ai-verse-brain' && strategic.snapshot
    ? readBrainProjection(strategic.snapshot)
    : readOsProjection(resolved, current);

  const ownerReads = [{
    owner: 'ai-verse-os',
    operation: 'current-context.read',
    scope: resolved.scope,
    status: 'ok',
    observed_at: observedAt,
    freshness: { state: 'unknown', as_of: observedAt },
    canonical_refs: current.canonical_ref ? [{ ...current.canonical_ref }] : [],
  }];
  if (strategic.owner === 'ai-verse-brain') {
    ownerReads.push({
      owner: 'ai-verse-brain',
      operation: 'purpose-snapshot.read',
      scope: resolved.scope,
      status: strategic.status,
      observed_at: observedAt,
      freshness: { state: strategic.status === 'unavailable' ? 'unavailable' : 'unknown', as_of: observedAt },
      canonical_refs: strategic.snapshot ? collectBrainRefs(strategic.snapshot) : [],
    });
  }

  const envelope = {
    schema_version: PURPOSE_SCHEMA_VERSION,
    scope: resolved.scope,
    scope_kind: resolved.scope_kind,
    identity: resolved.identity,
    ...semantic,
    provenance: {
      projection_owner: 'ai-verse-os',
      generated_at: observedAt,
      owner_reads: ownerReads,
    },
  };
  if (strategic.status !== 'ok') {
    envelope.section_states = {
      strategic_direction: {
        state: strategic.status,
        reason: strategic.reason ?? 'owner_read_not_ok',
      },
    };
  }
  return enforceBudget(envelope, maxBytes);
}
