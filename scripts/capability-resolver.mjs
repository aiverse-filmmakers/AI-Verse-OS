import fs from 'node:fs';
import path from 'node:path';
import * as core from './capability-resolver-core.mjs';
import {
  CAPABILITY_PLACEMENT_CONTRACT,
  normalizePlacementIntent,
  promotionRequirement,
  targetForPlacement,
} from './capability-placement.mjs';
import {
  CAPABILITY_PROMOTION_CONTRACT,
  applyWorkspaceToLocalPromotion,
  buildWorkspaceToLocalPromotionPlan,
  getPromotionCompatibility,
  parseWorkspaceQualifiedId,
} from './capability-promotion.mjs';

export * from './capability-resolver-core.mjs';
export { CAPABILITY_PLACEMENT_CONTRACT } from './capability-placement.mjs';
export { CAPABILITY_PROMOTION_CONTRACT } from './capability-promotion.mjs';

const WORKSPACE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function isStrictlyInside(child, parent) {
  return child !== parent && isInside(child, parent);
}

function samePath(a, b) {
  return path.relative(a, b) === '' && path.relative(b, a) === '';
}

function safeRealpath(target, label) {
  try { return fs.realpathSync(target); }
  catch (error) { throw new Error(`${label} cannot be resolved: ${error.message}`); }
}

function lstatOrNull(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function requestedWorkspaceId(scope) {
  if (typeof scope !== 'string' || !scope.startsWith('workspace:')) return null;
  const id = scope.slice('workspace:'.length);
  return WORKSPACE_SEGMENT.test(id) ? id : null;
}

function parseWorkspaceManifestId(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`workspace manifest cannot be read: ${error.message}`); }
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s/.test(line)) continue;
    const match = line.match(/^id\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    let raw = match[1].trim();
    if (!raw) throw new Error('workspace manifest id is empty');
    if (raw.startsWith('"')) {
      try { raw = JSON.parse(raw); }
      catch (error) { throw new Error(`workspace manifest id is invalid: ${error.message}`); }
    } else if (raw.startsWith("'") && raw.endsWith("'")) {
      raw = raw.slice(1, -1).replace(/''/g, "'");
    } else {
      raw = raw.replace(/\s+#.*$/, '').trim();
    }
    if (typeof raw !== 'string' || !WORKSPACE_SEGMENT.test(raw)) {
      throw new Error(`workspace manifest id is invalid: ${JSON.stringify(raw)}`);
    }
    ids.push(raw);
  }
  if (ids.length !== 1) throw new Error(`workspace manifest must contain exactly one top-level id; found ${ids.length}`);
  return ids[0];
}

function validateWorkspaceBoundary({ osRoot = process.cwd(), scope = 'operator' } = {}) {
  const workspaceId = requestedWorkspaceId(scope);
  if (!workspaceId) return { state: 'not-applicable', workspaceId: null };
  const root = path.resolve(osRoot);
  const workspacePath = path.join(root, 'workspaces', workspaceId);
  if (!lstatOrNull(workspacePath)) return { state: 'absent', workspaceId };
  try {
    const realOsRoot = safeRealpath(root, 'OS root');
    const realWorkspaces = safeRealpath(path.join(root, 'workspaces'), 'OS workspaces root');
    if (!isStrictlyInside(realWorkspaces, realOsRoot)) throw new Error('OS workspaces root escapes the physical OS root');
    const realWorkspace = safeRealpath(workspacePath, `workspace ${workspaceId}`);
    const expectedWorkspace = path.join(realWorkspaces, workspaceId);
    if (!samePath(realWorkspace, expectedWorkspace)) {
      throw new Error(`workspace ${workspaceId} is a filesystem alias instead of its requested physical slot`);
    }
    if (!isStrictlyInside(realWorkspace, realWorkspaces) || !fs.statSync(realWorkspace).isDirectory()) {
      throw new Error(`workspace ${workspaceId} escapes the OS workspaces boundary`);
    }
    const manifestPath = path.join(workspacePath, 'WORKSPACE.yaml');
    if (!lstatOrNull(manifestPath)) throw new Error('workspace is missing WORKSPACE.yaml');
    const realManifest = safeRealpath(manifestPath, `workspace ${workspaceId} manifest`);
    if (!isStrictlyInside(realManifest, realWorkspace) || !fs.statSync(realManifest).isFile()) {
      throw new Error(`workspace ${workspaceId} manifest escapes its physical workspace boundary`);
    }
    const manifestId = parseWorkspaceManifestId(realManifest);
    if (manifestId !== workspaceId) {
      throw new Error(`workspace manifest id ${JSON.stringify(manifestId)} does not match requested workspace ${JSON.stringify(workspaceId)}`);
    }
    const skillsPath = path.join(workspacePath, 'skills');
    if (!lstatOrNull(skillsPath)) return { state: 'valid', workspaceId };
    const realSkills = safeRealpath(skillsPath, `workspace ${workspaceId} skills root`);
    if (!isStrictlyInside(realSkills, realWorkspace)) {
      throw new Error(`workspace ${workspaceId} skills root escapes its physical workspace boundary`);
    }
    if (!fs.statSync(realSkills).isDirectory()) throw new Error(`workspace ${workspaceId} skills root is not a directory`);
    return { state: 'valid', workspaceId };
  } catch (error) {
    return { state: 'invalid', workspaceId, diagnostic: error.message };
  }
}

function degradedWorkspaceProvider(boundary) {
  return {
    provider: `workspace:${boundary.workspaceId}`,
    state: 'degraded',
    generation_id: null,
    diagnostics: [boundary.diagnostic],
    candidate_count: 0,
  };
}

export function discoverCapabilities(options = {}) {
  const scope = options.scope ?? 'operator';
  const boundary = validateWorkspaceBoundary({ osRoot: options.osRoot, scope });
  if (boundary.state !== 'invalid') return core.discoverCapabilities(options);
  const result = core.discoverCapabilities({ ...options, scope: 'operator' });
  return {
    ...result,
    scope,
    providers: [...result.providers, degradedWorkspaceProvider(boundary)],
    candidates: result.candidates.filter((item) => item.provider !== `workspace:${boundary.workspaceId}`),
  };
}

function exactRequestedCapability(options) {
  if (typeof options.qualifiedId === 'string' && options.qualifiedId.includes(':')) return options.qualifiedId;
  if (typeof options.query === 'string' && options.query.includes(':')) return options.query;
  return null;
}

function compatibilitySelection(options, direct, requested, boundary) {
  if (!requested || direct.status === 'selected') return direct;
  let compatibility;
  try {
    compatibility = getPromotionCompatibility({
      localSkillsRoot: options.localSkillsRoot,
      requestedQualifiedId: requested,
    });
  } catch (error) {
    return {
      ...direct,
      reason: `promotion compatibility evidence is invalid: ${error.message}`,
    };
  }
  if (!compatibility) return direct;

  const effectiveScope = boundary.state === 'invalid' ? 'operator' : (options.scope ?? 'operator');
  const redirected = core.selectCapability({
    ...options,
    scope: effectiveScope,
    query: compatibility.target_qualified_id,
    qualifiedId: compatibility.target_qualified_id,
  });
  if (redirected.status !== 'selected') {
    return {
      ...direct,
      reason: 'the recorded promoted capability target is unavailable or unhealthy',
      compatibility,
    };
  }
  return {
    ...redirected,
    requested,
    compatibility,
    providers: boundary.state === 'invalid'
      ? [...(redirected.providers ?? []), degradedWorkspaceProvider(boundary)]
      : redirected.providers,
  };
}

export function selectCapability(options = {}) {
  const scope = options.scope ?? 'operator';
  const boundary = validateWorkspaceBoundary({ osRoot: options.osRoot, scope });
  let result;
  if (boundary.state !== 'invalid') {
    result = core.selectCapability(options);
  } else {
    result = core.selectCapability({ ...options, scope: 'operator' });
    result = { ...result, providers: [...(result.providers ?? []), degradedWorkspaceProvider(boundary)] };
  }
  return compatibilitySelection(options, result, exactRequestedCapability(options), boundary);
}

function sourceScopeForPromotion(sourceQualifiedId) {
  const source = parseWorkspaceQualifiedId(sourceQualifiedId);
  return source ? `workspace:${source.workspace_id}` : null;
}

function promotionSource(options, sourceQualifiedId) {
  const sourceScope = sourceScopeForPromotion(sourceQualifiedId);
  if (!sourceScope) {
    return { status: 'review', member_message: 'Only a capability owned by the current project can be promoted through this flow.' };
  }
  if ((options.scope ?? 'operator') !== sourceScope) {
    return { status: 'review', member_message: 'Open the project that owns this capability before promoting it.' };
  }
  const boundary = validateWorkspaceBoundary({ osRoot: options.osRoot, scope: sourceScope });
  if (boundary.state !== 'valid') {
    return { status: 'review', member_message: 'The project that owns this capability needs review before promotion.' };
  }
  const selected = core.selectCapability({
    ...options,
    scope: sourceScope,
    query: sourceQualifiedId,
    qualifiedId: sourceQualifiedId,
  });
  if (selected.status !== 'selected' || !selected.selection) {
    return { status: 'review', member_message: 'The project capability could not be verified for promotion.' };
  }
  return { status: 'selected', selection: selected.selection };
}

function alreadyPromoted(options, sourceQualifiedId) {
  let compatibility;
  try {
    compatibility = getPromotionCompatibility({
      localSkillsRoot: options.localSkillsRoot,
      requestedQualifiedId: sourceQualifiedId,
    });
  } catch (error) {
    return { status: 'review', diagnostic: error.message, member_message: 'Promotion history needs review before anything changes.' };
  }
  if (!compatibility) return null;
  const selected = core.selectCapability({
    ...options,
    scope: options.scope ?? 'operator',
    query: compatibility.target_qualified_id,
    qualifiedId: compatibility.target_qualified_id,
  });
  if (selected.status !== 'selected') {
    return { status: 'review', compatibility, member_message: 'The recorded reusable capability is unavailable and needs review.' };
  }
  return {
    contract: CAPABILITY_PROMOTION_CONTRACT,
    status: 'already-promoted',
    source_qualified_id: sourceQualifiedId,
    target_qualified_id: compatibility.target_qualified_id,
    qualified_identity_preserved: false,
    compatibility,
    member_message: 'This capability is already reusable across your work.',
  };
}

export function planCapabilityPromotion(options = {}) {
  const sourceQualifiedId = options.sourceQualifiedId;
  if (typeof sourceQualifiedId !== 'string' || !sourceQualifiedId) {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', member_message: 'Choose the project capability you want to reuse more broadly.' };
  }
  const sourceScope = sourceScopeForPromotion(sourceQualifiedId);
  if (!sourceScope) {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', member_message: 'Only a capability owned by the current project can be promoted through this flow.' };
  }
  if ((options.scope ?? 'operator') !== sourceScope) {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', member_message: 'Open the project that owns this capability before promoting it.' };
  }

  const existing = alreadyPromoted(options, sourceQualifiedId);
  if (existing) return existing;
  const source = promotionSource(options, sourceQualifiedId);
  if (source.status !== 'selected') return { contract: CAPABILITY_PROMOTION_CONTRACT, ...source };
  return buildWorkspaceToLocalPromotionPlan({
    sourceQualifiedId,
    sourceSelection: source.selection,
    localSkillsRoot: options.localSkillsRoot,
  });
}

export function applyCapabilityPromotion(options = {}) {
  const sourceQualifiedId = options.sourceQualifiedId;
  const preview = planCapabilityPromotion(options);
  if (preview.status === 'already-promoted') {
    return { ...preview, effect_occurred: false };
  }
  if (preview.status !== 'ready') return { ...preview, effect_occurred: false };
  if (
    options.expectedSourceGenerationId !== preview.source_generation_id ||
    options.expectedSourceDigest !== preview.source_digest?.value
  ) {
    return {
      contract: CAPABILITY_PROMOTION_CONTRACT,
      status: 'review',
      effect_occurred: false,
      stale_plan: true,
      member_message: 'This capability changed since the preview, so nothing was moved.',
    };
  }
  const source = promotionSource(options, sourceQualifiedId);
  if (source.status !== 'selected') return { contract: CAPABILITY_PROMOTION_CONTRACT, ...source, effect_occurred: false };
  return applyWorkspaceToLocalPromotion({
    sourceQualifiedId,
    sourceSelection: source.selection,
    localSkillsRoot: options.localSkillsRoot,
    expectedSourceGenerationId: options.expectedSourceGenerationId,
    expectedSourceDigest: options.expectedSourceDigest,
  });
}

export function planCapabilityPlacement(options = {}) {
  const scope = options.scope ?? 'operator';
  const intent = normalizePlacementIntent(options.placement, options.contextLabel);
  let workspaceId = null;

  if (intent.kind === 'this-project') {
    const boundary = validateWorkspaceBoundary({ osRoot: options.osRoot, scope });
    if (boundary.state !== 'valid') {
      return {
        contract: CAPABILITY_PLACEMENT_CONTRACT,
        status: 'review',
        member_intent: intent,
        member_message: 'Open or choose the project that should own this capability, then try again.',
        promotion: { required: false },
      };
    }
    workspaceId = boundary.workspaceId;
  }

  const target = targetForPlacement({
    intent,
    workspaceId,
    capabilityId: options.capabilityId,
  });
  if (target.status !== 'planned') {
    return {
      contract: CAPABILITY_PLACEMENT_CONTRACT,
      ...target,
      member_intent: intent,
      promotion: { required: false },
    };
  }

  const promotion = promotionRequirement(options.sourceQualifiedId, target.target_qualified_id);
  if (promotion.blocked) {
    return {
      contract: CAPABILITY_PLACEMENT_CONTRACT,
      status: 'review',
      member_intent: intent,
      target_provider: target.target_provider,
      target_qualified_id: target.target_qualified_id,
      member_message: 'This capability is managed by AI-Verse and cannot be moved through personal placement.',
      promotion,
    };
  }

  return {
    contract: CAPABILITY_PLACEMENT_CONTRACT,
    ...target,
    member_intent: intent,
    promotion,
    managed_distribution_writable_target: false,
  };
}
