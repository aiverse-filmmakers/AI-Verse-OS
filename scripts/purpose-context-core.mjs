import fs from 'node:fs';
import path from 'node:path';

import { readCurrentContext } from './current-context.mjs';
import { validateDirectionScope } from './direction-owner-core.mjs';

const PURPOSE_SCHEMA_VERSION = '1.0';

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
  const intents = snapshot?.strategic_objects?.intents ?? [];
  const gaps = snapshot?.strategic_objects?.gaps ?? [];
  const initiatives = snapshot?.strategic_objects?.initiatives ?? [];
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
  if ((snapshot?.relationships ?? []).length) projection.trajectory = [...snapshot.relationships];
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
  return refs;
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
  return envelope;
}
