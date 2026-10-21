import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as core from './capability-resolver-core.mjs';
import { capabilityConfiguration } from './capability-configuration.mjs';
import { bindingDigest, saveBinding, validateInputs } from './capability-bindings.mjs';
import { readMemberLibrary } from './member-skill-library.mjs';

export const BINDING_PLAN_CONTRACT = 'aiverse-skill-binding-plan-v1';
const HEX = /^[a-f0-9]{64}$/;

export function planBinding(options) {
  const scope = options.scope ?? 'operator';
  const id = options.qualifiedId;
  if (typeof id !== 'string' || !id.includes(':')) throw new Error('choose an exact qualified skill before saving a binding');
  const binding = options.binding ?? {};
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).some(k => !['inputs', 'revision'].includes(k)) ||
      (binding.revision != null && (typeof binding.revision !== 'string' || !HEX.test(binding.revision)))) throw new Error('invalid skill binding');
  validateInputs(binding.inputs ?? {});
  let alias = options.alias ?? null;
  if (alias !== null) {
    if (typeof alias !== 'string' || !alias.trim() || alias.length > 100 || /[\x00-\x1f:]/.test(alias)) throw new Error('invalid preference name');
    alias = alias.trim().toLowerCase().replace(/\s+/g, ' ');
    if (['__proto__', 'prototype', 'constructor'].includes(alias)) throw new Error('unsafe preference name');
    const normalized = alias.replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    if (core.RESERVED_OS_ALIASES.has(normalized)) throw new Error('protected OS entrypoint names cannot be rebound; use an explicit skill identity');
  }
  const discovered = core.discoverCapabilities({ ...options, qualifiedId: id, query: id, limit: 200 });
  const active = discovered.candidates.find(candidate => candidate.id === id);
  if (!active) throw new Error('selected skill is unavailable, restricted or damaged');
  const configuration = capabilityConfiguration(options.osRoot ?? process.cwd(), options);
  let candidate = active;
  if (binding.revision && binding.revision !== active.digest.value) {
    if (active.library_contract !== 'aiverse-member-skill-library-v1') throw new Error('only retained member revisions can be pinned through this binding');
    const result = readMemberLibrary({ root: configuration.localSkillsRoot, scope, digestPackage: core.packageDigestV1, metadataFor: core.readSkillMetadata,
      revisionFor: { id, revision: binding.revision } });
    candidate = result.candidates.find(item => item.id === id);
    if (!candidate) throw new Error('pinned member revision is unavailable, restricted or damaged');
  }
  return { contract: BINDING_PLAN_CONTRACT, status: 'ready', os_root: fs.realpathSync(options.osRoot ?? process.cwd()), scope, id, alias,
    binding: JSON.parse(JSON.stringify({ ...binding, inputs: binding.inputs ?? {} })),
    expected_bindings: bindingDigest(options.osRoot ?? process.cwd(), scope), provider_configuration: configuration,
    active_generation: active.generation_id, active_digest: active.digest, selected_digest: candidate.digest,
    locator: candidate.locator, permission_granted: false };
}

export function applyBinding(options) {
  const preview = options.plan;
  if (!preview || preview.contract !== BINDING_PLAN_CONTRACT || preview.scope !== (options.scope ?? 'operator') ||
      preview.os_root !== fs.realpathSync(options.osRoot ?? process.cwd())) throw new Error('binding preview does not belong to this installation and scope');
  const current = planBinding({ ...options, qualifiedId: preview.id, alias: preview.alias, binding: preview.binding });
  if (!isDeepStrictEqual(current, preview)) throw new Error('skill, configuration or binding changed since preview; nothing was saved');
  return saveBinding({ osRoot: options.osRoot ?? process.cwd(), scope: preview.scope, id: preview.id,
    alias: preview.alias, binding: preview.binding, expectedDigest: preview.expected_bindings });
}
