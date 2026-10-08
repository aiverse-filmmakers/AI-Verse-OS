import {
  PURPOSE_BUDGET_POLICY_VERSION,
  PURPOSE_TRUNCATION_PRIORITY,
} from './purpose-context-budget-policy.mjs';

const DEFAULT_MAX_BYTES = 16384;
const MIN_MAX_BYTES = 4096;
const MAX_MAX_BYTES = 65536;

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function canonicalRefKey(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const { owner, scope, kind, id } = ref;
  if (![owner, scope, kind, id].every((value) => typeof value === 'string' && value)) return null;
  return [owner, scope, kind, id, typeof ref.version === 'string' ? ref.version : ''].join('\u0000');
}

function collectRetainedCanonicalRefKeys(envelope) {
  const retained = new Set();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object') return;
    const key = canonicalRefKey(value);
    if (key) retained.add(key);
    for (const [field, child] of Object.entries(value)) {
      if (field !== 'provenance') visit(child);
    }
  };
  for (const [field, value] of Object.entries(envelope ?? {})) {
    if (field !== 'provenance') visit(value);
  }
  return retained;
}

function syncRetainedOwnerRefs(envelope) {
  const retained = collectRetainedCanonicalRefKeys(envelope);
  for (const read of envelope?.provenance?.owner_reads ?? []) {
    if (read?.owner !== 'ai-verse-brain' || !Array.isArray(read.canonical_refs)) continue;
    read.canonical_refs = read.canonical_refs.filter((ref) => retained.has(canonicalRefKey(ref)));
  }
}

function listAtPath(envelope, pathName) {
  if (pathName.startsWith('purpose.')) {
    const key = pathName.slice('purpose.'.length);
    return Array.isArray(envelope?.purpose?.[key]) ? envelope.purpose[key] : null;
  }
  return Array.isArray(envelope?.[pathName]) ? envelope[pathName] : null;
}

function addOmission(omissions, section, reason) {
  const existing = omissions.find((entry) => entry?.section === section && entry?.reason === reason);
  if (existing) existing.omitted_count = Number(existing.omitted_count ?? 0) + 1;
  else omissions.push({ section, reason, omitted_count: 1 });
}

function stabilizeFinalBytes(envelope) {
  let previous = -1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = serializedBytes(envelope);
    if (envelope?.provenance?.budget) envelope.provenance.budget.final_bytes = size;
    const next = serializedBytes(envelope);
    if (next === size || next === previous) return next;
    previous = size;
  }
  return serializedBytes(envelope);
}

export function applyFinalPurposeBudget(envelope, maxBytes = DEFAULT_MAX_BYTES) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Purpose Context final budget requires an envelope object');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < MIN_MAX_BYTES || maxBytes > MAX_MAX_BYTES) {
    throw new Error(`Purpose Context final maxBytes must be an integer between ${MIN_MAX_BYTES} and ${MAX_MAX_BYTES}`);
  }

  const output = structuredClone(envelope);
  if (serializedBytes(output) <= maxBytes) return output;

  output.provenance ??= {};
  const priorBudget = output.provenance.budget && typeof output.provenance.budget === 'object'
    ? output.provenance.budget
    : {};
  const omissions = Array.isArray(priorBudget.omissions)
    ? priorBudget.omissions.map((entry) => ({ ...entry }))
    : [];
  output.provenance.budget = {
    ...priorBudget,
    policy_version: PURPOSE_BUDGET_POLICY_VERSION,
    max_bytes: maxBytes,
    final_bytes: 0,
    truncated: true,
    omissions,
  };

  let size = stabilizeFinalBytes(output);
  while (size > maxBytes) {
    let pruned = false;
    for (const section of PURPOSE_TRUNCATION_PRIORITY) {
      const list = listAtPath(output, section);
      if (!list?.length) continue;
      list.pop();
      addOmission(omissions, section, 'final_byte_budget');
      syncRetainedOwnerRefs(output);
      size = stabilizeFinalBytes(output);
      pruned = true;
      break;
    }
    if (!pruned) throw new Error(`Purpose Context final minimum exceeds byte budget ${maxBytes}`);
  }

  output.provenance.budget.truncated = omissions.length > 0;
  size = stabilizeFinalBytes(output);
  if (size > maxBytes) throw new Error(`Purpose Context final minimum exceeds byte budget ${maxBytes}`);
  return output;
}
