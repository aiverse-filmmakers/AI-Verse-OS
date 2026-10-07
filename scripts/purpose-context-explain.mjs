import { composeProfiledPurposeContext, filterExplicitScopeRelationships } from './purpose-context-profile.mjs';

const SEMANTIC_KINDS = new Set([
  'problem', 'mission', 'desired_outcome', 'goal', 'challenge', 'strategy',
  'initiative', 'kpi', 'risk', 'current_work', 'material_change',
]);
const MAX_TRAVERSAL_NODES = 128;

function refKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const { owner, scope, kind, id } = ref;
  if (![owner, scope, kind, id].every((value) => typeof value === 'string' && value.length > 0)) return null;
  if (typeof ref.version !== 'undefined' && typeof ref.version !== 'string') return null;
  return [owner, scope, kind, id, ref.version ?? ''].join('\u0000');
}

function selectorFor(node) {
  if (!node || typeof node !== 'object') return null;
  if (!SEMANTIC_KINDS.has(node.semantic_kind) || typeof node.id !== 'string' || !node.id) return null;
  if (!refKey(node.canonical_ref)) return null;
  return `${node.semantic_kind}:${node.id}`;
}

function semanticCatalog(envelope) {
  const bySelector = new Map();
  const byRef = new Map();
  const seen = new Set();

  function visit(value, key = '') {
    if (!value || typeof value !== 'object') return;
    if (key === 'trajectory' || key === 'provenance') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const selector = selectorFor(value);
    if (selector) {
      const keyValue = refKey(value.canonical_ref);
      const existing = bySelector.get(selector);
      if (existing && refKey(existing.canonical_ref) !== keyValue) {
        throw new Error(`ambiguous Purpose trajectory selector: ${selector}`);
      }
      bySelector.set(selector, value);
      byRef.set(keyValue, value);
    }
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  }

  visit(envelope);
  return { bySelector, byRef };
}

export function parseTrajectorySelector(selector) {
  if (typeof selector !== 'string') throw new Error('Purpose trajectory --ref is required');
  const separator = selector.indexOf(':');
  if (separator <= 0 || separator === selector.length - 1 || selector.indexOf(':', separator + 1) !== -1) {
    throw new Error(`invalid Purpose trajectory ref selector: ${selector}`);
  }
  const semanticKind = selector.slice(0, separator);
  const id = selector.slice(separator + 1);
  if (!SEMANTIC_KINDS.has(semanticKind) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(`invalid Purpose trajectory ref selector: ${selector}`);
  }
  return { semantic_kind: semanticKind, id, selector };
}

export function traverseExplicitTrajectory(envelope, selector) {
  const parsed = parseTrajectorySelector(selector);
  const filtered = filterExplicitScopeRelationships(envelope).envelope;
  const catalog = semanticCatalog(filtered);
  const start = catalog.bySelector.get(parsed.selector);
  if (!start) throw new Error(`Purpose trajectory node not found: ${parsed.selector}`);

  const outgoing = new Map();
  for (const edge of filtered.trajectory ?? []) {
    const key = refKey(edge.from_ref);
    if (!key) continue;
    const bucket = outgoing.get(key) ?? [];
    bucket.push(edge);
    outgoing.set(key, bucket);
  }

  const startKey = refKey(start.canonical_ref);
  const queue = [start.canonical_ref];
  const visited = new Set();
  const emittedEdges = new Set();
  const edges = [];
  const reachedRefs = [];
  const reachedKeys = new Set();
  const terminalRefs = [];
  const terminalKeys = new Set();

  while (queue.length) {
    const current = queue.shift();
    const currentKey = refKey(current);
    if (!currentKey || visited.has(currentKey)) continue;
    visited.add(currentKey);
    if (visited.size > MAX_TRAVERSAL_NODES) throw new Error('Purpose trajectory traversal exceeded safety bound');

    for (const edge of outgoing.get(currentKey) ?? []) {
      const targetKey = refKey(edge.to_ref);
      const evidence = (edge.source_refs ?? []).map(refKey).join('|');
      const edgeKey = `${currentKey}\u0001${edge.relation}\u0001${targetKey}\u0001${evidence}`;
      if (emittedEdges.has(edgeKey)) continue;
      emittedEdges.add(edgeKey);
      edges.push(structuredClone(edge));

      if (!reachedKeys.has(targetKey)) {
        reachedKeys.add(targetKey);
        reachedRefs.push(structuredClone(edge.to_ref));
      }

      const targetNode = catalog.byRef.get(targetKey);
      if (edge.to_ref.scope === filtered.scope && targetNode) {
        if (!visited.has(targetKey)) queue.push(edge.to_ref);
      } else if (!terminalKeys.has(targetKey)) {
        terminalKeys.add(targetKey);
        terminalRefs.push(structuredClone(edge.to_ref));
      }
    }
  }

  return {
    schema_version: '1.0',
    scope: filtered.scope,
    selector: parsed.selector,
    start: {
      semantic_kind: start.semantic_kind,
      id: start.id,
      canonical_ref: structuredClone(start.canonical_ref),
    },
    traversal: {
      start_ref: structuredClone(start.canonical_ref),
      edges,
      reached_refs: reachedRefs,
      terminal_refs: terminalRefs,
    },
  };
}

export function explainPurposeContext(root, scope, selector, options = {}) {
  const envelope = composeProfiledPurposeContext(root, scope, options);
  return traverseExplicitTrajectory(envelope, selector);
}
