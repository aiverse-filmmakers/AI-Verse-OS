import { composePurposeContext as composeBasePurposeContext } from './purpose-context-core.mjs';

const DEFAULT_MAX_BYTES = 16384;
const PROFILE_REQUESTS = new Set(['auto', 'basic', 'rich']);
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
  const profile = resolvePurposeProfile(
    envelope.scope_kind,
    options.profile ?? 'auto',
    envelope,
    options.relevantDomains ?? [],
  );

  const output = structuredClone(envelope);
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
