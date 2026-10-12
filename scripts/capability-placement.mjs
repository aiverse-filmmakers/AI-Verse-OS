const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

export const CAPABILITY_PLACEMENT_CONTRACT = 'aiverse-capability-placement-v1';

function cleanLabel(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('context label must be a string');
  const label = value.trim().replace(/\s+/g, ' ');
  if (!label) return null;
  if (label.length > 120) throw new Error('context label is too long');
  return label;
}

export function normalizePlacementIntent(value, contextLabel = null) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('placement intent is required');
  }
  const raw = value.trim().replace(/\s+/g, ' ');
  const key = raw.toLowerCase();
  const suppliedLabel = cleanLabel(contextLabel);

  if (key === 'this-project' || key === 'only-this-project' || key === 'only use this in this project') {
    return { kind: 'this-project', context_label: null };
  }
  if (key === 'all-my-work' || key === 'use this everywhere' || key === 'use everywhere') {
    return { kind: 'all-my-work', context_label: null };
  }
  if (key === 'related-work' || key === 'use this for related work') {
    return { kind: 'related-work', context_label: suppliedLabel };
  }

  const domainMatch = raw.match(/^use this for all (.+?) work$/i);
  if (domainMatch) {
    return { kind: 'related-work', context_label: cleanLabel(domainMatch[1]) };
  }

  throw new Error('unsupported placement intent; use practical intent such as this project, related work, or everywhere');
}

export function normalizeCapabilityId(value) {
  if (typeof value !== 'string') throw new Error('capability id must be a string');
  const id = value.trim().toLowerCase();
  if (!SEGMENT.test(id)) {
    throw new Error('capability id must use lowercase letters, digits, and hyphens');
  }
  return id;
}

export function targetForPlacement({ intent, workspaceId = null, capabilityId }) {
  const id = normalizeCapabilityId(capabilityId);
  if (!intent || typeof intent !== 'object') throw new Error('normalized placement intent is required');

  if (intent.kind === 'this-project') {
    if (typeof workspaceId !== 'string' || !SEGMENT.test(workspaceId)) {
      return {
        status: 'review',
        member_message: 'Open or choose the project that should own this capability, then try again.',
      };
    }
    const provider = `workspace:${workspaceId}`;
    return {
      status: 'planned',
      target_provider: provider,
      target_qualified_id: `${provider}:${id}`,
      ownership: 'workspace-owned',
      member_message: 'Keep this capability only with this project.',
    };
  }

  if (intent.kind === 'related-work') {
    const label = intent.context_label ? ` for your ${intent.context_label} work` : ' for related work';
    return {
      status: 'planned',
      target_provider: 'local',
      target_qualified_id: `local:${id}`,
      ownership: 'user-owned',
      member_message: `Make this a reusable capability${label}.`,
    };
  }

  if (intent.kind === 'all-my-work') {
    return {
      status: 'planned',
      target_provider: 'local',
      target_qualified_id: `local:${id}`,
      ownership: 'user-owned',
      member_message: 'Make this a reusable capability across your work.',
    };
  }

  throw new Error(`unsupported normalized placement kind: ${String(intent.kind)}`);
}

function sourceProvider(qualifiedId) {
  if (typeof qualifiedId !== 'string' || !qualifiedId.trim()) return null;
  const source = qualifiedId.trim();
  if (/^local:[a-z0-9][a-z0-9-]*$/.test(source)) return { source, provider: 'local', writable: true };
  const workspace = source.match(/^workspace:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)$/);
  if (workspace) return { source, provider: `workspace:${workspace[1]}`, writable: true };
  if (/^os:[a-z0-9][a-z0-9-]*$/.test(source)) return { source, provider: 'os', writable: false };
  if (/^aiverse-skills:[a-z0-9][a-z0-9-]*$/.test(source)) return { source, provider: 'aiverse-skills', writable: false };
  throw new Error('source qualified id is not a current capability identity');
}

export function promotionRequirement(sourceQualifiedId, targetQualifiedId) {
  const source = sourceProvider(sourceQualifiedId);
  if (!source) return { required: false };
  if (!source.writable) {
    return {
      required: false,
      blocked: true,
      apply_supported: false,
      source_qualified_id: source.source,
      reason: 'Canonical OS and managed distribution capabilities are not writable user-placement sources.',
    };
  }
  if (source.source === targetQualifiedId) {
    return { required: false, source_qualified_id: source.source, target_qualified_id: targetQualifiedId };
  }
  return {
    required: true,
    apply_supported: false,
    source_qualified_id: source.source,
    target_qualified_id: targetQualifiedId,
    qualified_identity_preserved: false,
    preserve_provenance: true,
    preserve_history: true,
    reference_repair_required: true,
    reason: 'Cross-provider promotion requires the separately admitted migration and reference-repair flow.',
  };
}
