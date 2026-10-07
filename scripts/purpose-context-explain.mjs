import { composeProfiledPurposeContext, filterExplicitScopeRelationships } from './purpose-context-profile.mjs';

const SEMANTIC_KINDS = new Set([
  'problem', 'mission', 'desired_outcome', 'goal', 'challenge', 'strategy',
  'initiative', 'kpi', 'risk', 'current_work', 'material_change',
]);
const CAUSAL_RELATION_PRIORITY = new Map([
  ['executes', 0],
  ['serves', 1],
  ['advances', 2],
  ['addresses', 3],
  ['measures', 4],
]);
const STRUCTURAL_RELATIONS = new Set(['serves', 'advances', 'executes', 'supersedes']);
const ORPHANABLE_KINDS = new Set(['initiative', 'current_work']);
const MAX_TRAVERSAL_NODES = 128;

function refKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const { owner, scope, kind, id } = ref;
  if (![owner, scope, kind, id].every((value) => typeof value === 'string' && value.length > 0)) return null;
  if (typeof ref.version !== 'undefined' && typeof ref.version !== 'string') return null;
  return [owner, scope, kind, id, ref.version ?? ''].join('\u0000');
}

function compareText(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRefs(a, b) {
  return compareText(refKey(a), refKey(b));
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

function edgeSort(a, b) {
  const relation = compareText(a.relation, b.relation);
  if (relation !== 0) return relation;
  const from = compareRefs(a.from_ref, b.from_ref);
  if (from !== 0) return from;
  const to = compareRefs(a.to_ref, b.to_ref);
  if (to !== 0) return to;
  const aEvidence = (a.source_refs ?? []).map(refKey).sort().join('\u0001');
  const bEvidence = (b.source_refs ?? []).map(refKey).sort().join('\u0001');
  return compareText(aEvidence, bEvidence);
}

function rejectStructuralCycles(edges, catalog, scope) {
  const structural = edges.filter((edge) => {
    if (!STRUCTURAL_RELATIONS.has(edge.relation)) return false;
    if (edge.from_ref?.scope !== scope || edge.to_ref?.scope !== scope) return false;
    return catalog.byRef.has(refKey(edge.from_ref)) && catalog.byRef.has(refKey(edge.to_ref));
  });

  const adjacency = new Map();
  const nodes = new Set();
  for (const edge of structural) {
    const from = refKey(edge.from_ref);
    const to = refKey(edge.to_ref);
    nodes.add(from);
    nodes.add(to);
    const targets = adjacency.get(from) ?? new Set();
    targets.add(to);
    adjacency.set(from, targets);
  }

  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  function strongConnect(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    const targets = [...(adjacency.get(node) ?? [])].sort(compareText);
    for (const target of targets) {
      if (!indices.has(target)) {
        strongConnect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      while (stack.length) {
        const member = stack.pop();
        onStack.delete(member);
        component.push(member);
        if (member === node) break;
      }
      component.sort(compareText);
      components.push(component);
    }
  }

  for (const node of [...nodes].sort(compareText)) {
    if (!indices.has(node)) strongConnect(node);
  }

  const cyclicComponentByNode = new Map();
  for (const component of components) {
    if (component.length <= 1) continue;
    const componentId = component.join('\u0002');
    for (const node of component) cyclicComponentByNode.set(node, componentId);
  }

  const rejectedKeys = new Set();
  const rejections = [];
  for (const edge of structural) {
    const from = refKey(edge.from_ref);
    const to = refKey(edge.to_ref);
    const componentId = cyclicComponentByNode.get(from);
    if (!componentId || componentId !== cyclicComponentByNode.get(to)) continue;
    const key = `${from}\u0001${edge.relation}\u0001${to}\u0001${(edge.source_refs ?? []).map(refKey).sort().join('|')}`;
    rejectedKeys.add(key);
    rejections.push({
      reason: 'structural_cycle',
      relation: edge.relation,
      from_ref: structuredClone(edge.from_ref),
      to_ref: structuredClone(edge.to_ref),
      source_refs: [...(edge.source_refs ?? [])].sort(compareRefs).map((ref) => structuredClone(ref)),
    });
  }
  rejections.sort(edgeSort);

  const retained = edges.filter((edge) => {
    const key = `${refKey(edge.from_ref)}\u0001${edge.relation}\u0001${refKey(edge.to_ref)}\u0001${(edge.source_refs ?? []).map(refKey).sort().join('|')}`;
    return !rejectedKeys.has(key);
  });
  return { retained, rejections };
}

function explainParentEdges(outgoing, node) {
  const nodeKey = refKey(node.canonical_ref);
  const edges = (outgoing.get(nodeKey) ?? []).filter((edge) => {
    if (!CAUSAL_RELATION_PRIORITY.has(edge.relation)) return false;
    if (edge.relation === 'measures' && node.semantic_kind !== 'kpi') return false;
    return true;
  });
  return edges.sort((a, b) => {
    const relation = CAUSAL_RELATION_PRIORITY.get(a.relation) - CAUSAL_RELATION_PRIORITY.get(b.relation);
    if (relation !== 0) return relation;
    const target = compareRefs(a.to_ref, b.to_ref);
    if (target !== 0) return target;
    const aEvidence = (a.source_refs ?? []).map(refKey).sort().join('\u0001');
    const bEvidence = (b.source_refs ?? []).map(refKey).sort().join('\u0001');
    return compareText(aEvidence, bEvidence);
  });
}

function explainCycleEdges(cycleOutgoing, node) {
  return (cycleOutgoing.get(refKey(node.canonical_ref)) ?? [])
    .filter((edge) => CAUSAL_RELATION_PRIORITY.has(edge.relation))
    .sort((a, b) => {
      const relation = CAUSAL_RELATION_PRIORITY.get(a.relation) - CAUSAL_RELATION_PRIORITY.get(b.relation);
      if (relation !== 0) return relation;
      return edgeSort(a, b);
    });
}

function hopForEdge(edge, catalog) {
  const fromNode = catalog.byRef.get(refKey(edge.from_ref));
  const toNode = catalog.byRef.get(refKey(edge.to_ref));
  const hop = {
    relation: edge.relation,
    from_ref: structuredClone(edge.from_ref),
    to_ref: structuredClone(edge.to_ref),
    source_refs: [...(edge.source_refs ?? [])].sort(compareRefs).map((ref) => structuredClone(ref)),
  };
  const fromSelector = selectorFor(fromNode);
  const toSelector = selectorFor(toNode);
  if (fromSelector) hop.from_selector = fromSelector;
  if (toSelector) hop.to_selector = toSelector;
  return hop;
}

function buildExplainPaths(start, outgoing, cycleOutgoing, catalog, scope) {
  const paths = [];
  const missingLinks = [];
  const missingKeys = new Set();

  function recordMissing(edge) {
    const key = `${refKey(edge.from_ref)}\u0001${edge.relation}\u0001${refKey(edge.to_ref)}`;
    if (missingKeys.has(key)) return;
    missingKeys.add(key);
    missingLinks.push({
      reason: 'missing_parent_node',
      relation: edge.relation,
      from_ref: structuredClone(edge.from_ref),
      to_ref: structuredClone(edge.to_ref),
      source_refs: [...(edge.source_refs ?? [])].sort(compareRefs).map((ref) => structuredClone(ref)),
    });
  }

  function terminalPath(node, selectors, relations, hops) {
    if (ORPHANABLE_KINDS.has(node.semantic_kind) && relations.length === 0) {
      paths.push({
        status: 'orphan',
        termination_reason: 'trajectory_orphan',
        linkage_state: 'orphan',
        linkage_reason: 'no_valid_parent_relation',
        selectors: [...selectors],
        relations: [...relations],
        hops: structuredClone(hops),
        terminal_selector: selectors[selectors.length - 1],
      });
      return;
    }
    paths.push({
      status: 'complete',
      termination_reason: 'trajectory_root',
      selectors: [...selectors],
      relations: [...relations],
      hops: structuredClone(hops),
      terminal_selector: selectors[selectors.length - 1],
    });
  }

  function walk(node, selectors, relations, hops, seenKeys, depth) {
    if (depth > MAX_TRAVERSAL_NODES) throw new Error('Purpose trajectory path exceeded safety bound');
    const parents = explainParentEdges(outgoing, node);
    const cycleParents = explainCycleEdges(cycleOutgoing, node);
    if (!parents.length && !cycleParents.length) {
      terminalPath(node, selectors, relations, hops);
      return;
    }

    let advanced = false;
    for (const edge of parents) {
      const targetKey = refKey(edge.to_ref);
      const hop = hopForEdge(edge, catalog);
      if (edge.to_ref.scope !== scope) {
        paths.push({
          status: 'partial',
          termination_reason: 'scope_boundary',
          selectors: [...selectors],
          relations: [...relations, edge.relation],
          hops: [...hops, hop],
          terminal_selector: selectors[selectors.length - 1],
          terminal_ref: structuredClone(edge.to_ref),
        });
        advanced = true;
        continue;
      }

      const targetNode = catalog.byRef.get(targetKey);
      if (!targetNode) {
        recordMissing(edge);
        paths.push({
          status: 'partial',
          termination_reason: 'missing_parent',
          selectors: [...selectors],
          relations: [...relations, edge.relation],
          hops: [...hops, hop],
          terminal_selector: selectors[selectors.length - 1],
          terminal_ref: structuredClone(edge.to_ref),
        });
        advanced = true;
        continue;
      }

      if (seenKeys.has(targetKey)) {
        paths.push({
          status: 'partial',
          termination_reason: 'cycle_rejected',
          selectors: [...selectors],
          relations: [...relations, edge.relation],
          hops: [...hops, hop],
          terminal_selector: selectors[selectors.length - 1],
          terminal_ref: structuredClone(edge.to_ref),
        });
        advanced = true;
        continue;
      }
      const targetSelector = selectorFor(targetNode);
      if (!targetSelector) continue;
      advanced = true;
      const nextSeen = new Set(seenKeys);
      nextSeen.add(targetKey);
      walk(targetNode, [...selectors, targetSelector], [...relations, edge.relation], [...hops, hop], nextSeen, depth + 1);
    }

    for (const edge of cycleParents) {
      const hop = hopForEdge(edge, catalog);
      paths.push({
        status: 'partial',
        termination_reason: 'cycle_rejected',
        selectors: [...selectors],
        relations: [...relations, edge.relation],
        hops: [...hops, hop],
        terminal_selector: selectors[selectors.length - 1],
        terminal_ref: structuredClone(edge.to_ref),
      });
      advanced = true;
    }

    if (!advanced) terminalPath(node, selectors, relations, hops);
  }

  const startKey = refKey(start.canonical_ref);
  walk(start, [selectorFor(start)], [], [], new Set([startKey]), 0);
  return {
    paths: paths.map((path, index) => ({ primary: index === 0, ...path })),
    missing_links: missingLinks,
  };
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

  const cycleResult = rejectStructuralCycles(filtered.trajectory ?? [], catalog, filtered.scope);
  const outgoing = new Map();
  for (const edge of cycleResult.retained) {
    const key = refKey(edge.from_ref);
    if (!key) continue;
    const bucket = outgoing.get(key) ?? [];
    bucket.push(edge);
    outgoing.set(key, bucket);
  }
  const cycleOutgoing = new Map();
  for (const edge of cycleResult.rejections) {
    const key = refKey(edge.from_ref);
    const bucket = cycleOutgoing.get(key) ?? [];
    bucket.push(edge);
    cycleOutgoing.set(key, bucket);
  }

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

  const explanation = buildExplainPaths(start, outgoing, cycleOutgoing, catalog, filtered.scope);
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
      paths: explanation.paths,
      missing_links: explanation.missing_links,
      cycle_rejections: structuredClone(cycleResult.rejections),
    },
  };
}

export function explainPurposeContext(root, scope, selector, options = {}) {
  const envelope = composeProfiledPurposeContext(root, scope, options);
  return traverseExplicitTrajectory(envelope, selector);
}
