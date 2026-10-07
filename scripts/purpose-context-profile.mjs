import { composePurposeContext as composeBasePurposeContext } from './purpose-context-core.mjs';

const DEFAULT_MAX_BYTES = 16384;
const PROFILE_REQUESTS = new Set(['auto', 'basic', 'rich']);
const RELATION_TOKENS = new Set([
  'addresses', 'serves', 'advances', 'blocks', 'executes', 'measures', 'affects', 'supersedes',
]);
const RICH_DOMAIN_KEYS = new Map([
  ['narratives', 'relevant_narrative_domain_present'],
  ['kpis', 'relevant_kpi_binding_present'],
  ['risks', 'relevant_risk_domain_present'],
  ['current_state', 'relevant_rich_current_state_present'],
  ['recent_material_changes', 'relevant_material_change_context_present'],
]);

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function canonicalScope(scope) {
  if (scope === 'operator') return true;
  if (typeof scope !== 'string' || !scope.startsWith('workspace:')) return false;
  const id = scope.slice('workspace:'.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(id) && id.length <= 128;
}

function canonicalRefKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const { owner, scope, kind, id } = ref;
  if (![owner, scope, kind, id].every((value) => typeof value === 'string' && value.trim())) return null;
  if (!canonicalScope(scope)) return null;
  if (typeof ref.version !== 'undefined' && typeof ref.version !== 'string') return null;
  return [owner, scope, kind, id, ref.version ?? ''].join('\u0000');
}

function syncRetainedBrainRefs(envelope) {
  const retained = new Set();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    const own = canonicalRefKey(value);
    if (own) retained.add(own);
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'provenance') visit(child);
    }
  };
  for (const [key, value] of Object.entries(envelope)) {
    if (key !== 'provenance') visit(value);
  }
  for (const ownerRead of envelope.provenance?.owner_reads ?? []) {
    if (ownerRead?.owner !== 'ai-verse-brain' || !Array.isArray(ownerRead.canonical_refs)) continue;
    ownerRead.canonical_refs = ownerRead.canonical_refs.filter((ref) => retained.has(canonicalRefKey(ref)));
  }
}

export function filterExplicitScopeRelationships(envelope) {
  const output = structuredClone(envelope);
  const rejected = [];
  if (!Array.isArray(output.trajectory)) return { envelope: output, rejected };

  output.trajectory = output.trajectory.filter((edge, index) => {
    const reject = (reason) => {
      rejected.push({ index, reason });
      return false;
    };
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return reject('malformed_edge');
    if (!RELATION_TOKENS.has(edge.relation)) return reject('unsupported_relation');
    const fromKey = canonicalRefKey(edge.from_ref);
    const toKey = canonicalRefKey(edge.to_ref);
    if (!fromKey || !toKey) return reject('noncanonical_ref');
    if (fromKey === toKey) return reject('self_edge');
    if (edge.from_ref.scope !== output.scope) return reject('source_scope_mismatch');
    if (!Array.isArray(edge.source_refs) || edge.source_refs.length === 0) return reject('missing_source_refs');
    if (edge.source_refs.some((ref) => !canonicalRefKey(ref))) return reject('noncanonical_source_ref');
    return true;
  });

  syncRetainedBrainRefs(output);
  return { envelope: output, rejected };
}

function normalizeRelevantDomains(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('Purpose Context relevantDomains must be an array');
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function hasOwnerBackedDomain(envelope, domain) {
  const value = envelope?.[domain];
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

export function resolvePurposeProfile(scopeKind, requested = 'auto', envelope = {}, relevantDomains = []) {
  if (!PROFILE_REQUESTS.has(requested)) {
    throw new Error(`unsupported Purpose Context profile: ${requested}`);
  }

  if (scopeKind === 'operator') {
    if (requested !== 'auto') {
      throw new Error('Purpose Context basic/rich profiles apply only to workspace scopes');
    }
    return { requested, resolved: 'operator_default', reasons: ['operator_scope'] };
  }
  if (scopeKind !== 'workspace') throw new Error(`unsupported Purpose Context scope kind: ${scopeKind}`);

  if (requested === 'basic') {
    return { requested, resolved: 'workspace_basic', reasons: ['explicit_profile_request'] };
  }
  if (requested === 'rich') {
    return { requested, resolved: 'workspace_rich', reasons: ['explicit_profile_request'] };
  }

  const relevant = new Set(normalizeRelevantDomains(relevantDomains));
  const reasons = [];
  for (const [domain, reason] of RICH_DOMAIN_KEYS.entries()) {
    if (relevant.has(domain) && hasOwnerBackedDomain(envelope, domain)) reasons.push(reason);
  }
  if (reasons.length) return { requested, resolved: 'workspace_rich', reasons };
  return { requested, resolved: 'workspace_basic', reasons: ['workspace_default_basic'] };
}

export function applyPurposeProfile(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object') throw new Error('Purpose Context envelope is required');
  const filtered = filterExplicitScopeRelationships(envelope).envelope;
  const profile = resolvePurposeProfile(
    filtered.scope_kind,
    options.profile ?? 'auto',
    filtered,
    options.relevantDomains ?? [],
  );

  const output = structuredClone(filtered);
  if (profile.resolved === 'workspace_basic') {
    delete output.narratives;
    delete output.kpis;
    delete output.risks;
  }

  output.provenance ??= {};
  output.provenance.profile = profile;

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (serializedBytes(output) > maxBytes) {
    output.provenance.profile = { requested: profile.requested, resolved: profile.resolved, reasons: [] };
  }
  if (serializedBytes(output) > maxBytes) delete output.provenance.profile;
  return output;
}

export function composeProfiledPurposeContext(root, scope = 'operator', options = {}) {
  const envelope = composeBasePurposeContext(root, scope, {
    maxBytes: options.maxBytes,
    now: options.now,
    readBrainPurposeSnapshot: options.readBrainPurposeSnapshot,
  });
  return applyPurposeProfile(envelope, options);
}
