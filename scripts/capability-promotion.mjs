import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageDigestV1 } from './capability-resolver-core.mjs';

export const CAPABILITY_PROMOTION_CONTRACT = 'aiverse-capability-promotion-v1';
export const CAPABILITY_PROMOTION_STORE = 'aiverse-capability-promotions/v1';

const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const HEX64 = /^[a-f0-9]{64}$/;
const DIGEST_ALGORITHM = 'aiverse-package-sha256-v1';
const DEFAULT_LOCAL_SKILLS_ROOT = path.join(os.homedir(), '.aiverse', 'local-skills');
const STORE_RELATIVE = path.join('.aiverse', 'promotions-v1.json');
const LOCK_RELATIVE = path.join('.aiverse', 'promotion.lock');
const STAGE_PREFIX = path.join('.aiverse', 'promotion-stage-');

function localRoot(value) {
  return path.resolve(value ?? DEFAULT_LOCAL_SKILLS_ROOT);
}

export function parseWorkspaceQualifiedId(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^workspace:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)$/);
  return match ? { qualified_id: value, workspace_id: match[1], bare_id: match[2] } : null;
}

function targetQualifiedId(bareId) {
  return `local:${bareId}`;
}

function validateDigest(value, label) {
  if (!value || typeof value !== 'object' || value.algorithm !== DIGEST_ALGORITHM || !HEX64.test(value.value ?? '')) {
    throw new Error(`${label} must use ${DIGEST_ALGORITHM}`);
  }
  return { algorithm: DIGEST_ALGORITHM, value: value.value };
}

function validateSourceSelection(sourceQualifiedId, selection) {
  const parsed = parseWorkspaceQualifiedId(sourceQualifiedId);
  if (!parsed) throw new Error('only Workspace-owned capability sources are admitted for personal promotion');
  if (!selection || selection.id !== sourceQualifiedId || selection.provider !== `workspace:${parsed.workspace_id}`) {
    throw new Error('source selection does not match the requested Workspace capability');
  }
  if (selection.bare_id !== parsed.bare_id || selection.generation_id !== `content-sha256:${selection.digest?.value ?? ''}`) {
    throw new Error('source selection identity/generation evidence is inconsistent');
  }
  const digest = validateDigest(selection.digest, 'source digest');
  const locator = selection.locator;
  if (!locator || locator.kind !== 'directory' || typeof locator.provider_root !== 'string' || typeof locator.package_path !== 'string') {
    throw new Error('source selection is missing directory locator evidence');
  }
  const providerRoot = fs.realpathSync(locator.provider_root);
  const packagePath = fs.realpathSync(locator.package_path);
  const expectedPackage = path.join(providerRoot, parsed.bare_id);
  if (path.relative(packagePath, expectedPackage) !== '' || path.relative(expectedPackage, packagePath) !== '') {
    throw new Error('source package is not in its canonical provider slot');
  }
  return { parsed, digest, providerRoot, packagePath };
}

function ensureLocalRoot(root) {
  if (fs.existsSync(root)) {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('personal capability root must be a real directory');
  } else {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  const meta = path.join(root, '.aiverse');
  if (fs.existsSync(meta)) {
    const stat = fs.lstatSync(meta);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('personal capability metadata root must be a real directory');
  } else {
    fs.mkdirSync(meta, { mode: 0o700 });
  }
  return root;
}

function emptyStore() {
  return { schema_version: CAPABILITY_PROMOTION_STORE, promotions: {} };
}

function validateReceipt(key, raw) {
  if (!parseWorkspaceQualifiedId(key) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid promotion receipt for ${key}`);
  }
  const source = parseWorkspaceQualifiedId(raw.source_qualified_id);
  if (!source || raw.source_qualified_id !== key) throw new Error(`promotion receipt source mismatch for ${key}`);
  if (raw.target_qualified_id !== targetQualifiedId(source.bare_id)) throw new Error(`promotion receipt target mismatch for ${key}`);
  if (raw.qualified_identity_preserved !== false) throw new Error(`promotion receipt must not claim identity continuity for ${key}`);
  if (!['pending', 'active'].includes(raw.state)) throw new Error(`promotion receipt state is invalid for ${key}`);
  if (typeof raw.source_generation_id !== 'string' || raw.source_generation_id !== `content-sha256:${raw.source_digest?.value ?? ''}`) {
    throw new Error(`promotion receipt source generation is invalid for ${key}`);
  }
  validateDigest(raw.source_digest, `promotion receipt source digest for ${key}`);
  validateDigest(raw.target_digest, `promotion receipt target digest for ${key}`);
  if (raw.source_digest.value !== raw.target_digest.value) throw new Error(`promotion receipt bytes diverge for ${key}`);
  if (raw.target_generation_id !== `content-sha256:${raw.target_digest.value}`) throw new Error(`promotion receipt target generation is invalid for ${key}`);
  if (typeof raw.history_archive !== 'string' || raw.history_archive.startsWith('/') || raw.history_archive.includes('\\') || raw.history_archive.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`promotion receipt archive path is invalid for ${key}`);
  }
  return raw;
}

export function readPromotionStore(localSkillsRoot = null) {
  const root = localRoot(localSkillsRoot);
  const file = path.join(root, STORE_RELATIVE);
  if (!fs.existsSync(file)) return emptyStore();
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('promotion store must be a regular non-symlink file');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`promotion store is invalid JSON: ${error.message}`); }
  if (!parsed || parsed.schema_version !== CAPABILITY_PROMOTION_STORE || !parsed.promotions || typeof parsed.promotions !== 'object' || Array.isArray(parsed.promotions)) {
    throw new Error('promotion store schema is invalid');
  }
  for (const [key, value] of Object.entries(parsed.promotions)) validateReceipt(key, value);
  return parsed;
}

function writePromotionStore(root, store) {
  ensureLocalRoot(root);
  for (const [key, value] of Object.entries(store.promotions ?? {})) validateReceipt(key, value);
  const file = path.join(root, STORE_RELATIVE);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function withPromotionLock(root, fn) {
  ensureLocalRoot(root);
  const lock = path.join(root, LOCK_RELATIVE);
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('another capability promotion is already in progress');
    throw error;
  }
  try { return fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

function rejectSymlinks(root) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`automatic promotion requires a plain package; symlink found at ${path.relative(root, item).split(path.sep).join('/')}`);
      if (entry.isDirectory()) visit(item);
      else if (!entry.isFile()) throw new Error(`automatic promotion cannot copy special filesystem entry ${entry.name}`);
    }
  };
  visit(root);
}

function targetState(root, bareId, sourceDigest) {
  const target = path.join(root, bareId);
  if (!fs.existsSync(target)) return { state: 'absent', target };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !fs.existsSync(path.join(target, 'SKILL.md'))) {
    return { state: 'conflict', target, diagnostic: 'the reusable target slot already exists but is not a valid plain capability package' };
  }
  let digest;
  try { digest = packageDigestV1(target); }
  catch (error) { return { state: 'conflict', target, diagnostic: `the reusable target cannot be verified: ${error.message}` }; }
  return digest === sourceDigest
    ? { state: 'identical', target, digest }
    : { state: 'conflict', target, digest, diagnostic: 'a different reusable capability already owns this target identity' };
}

function archiveRelativePath(parsed, digest) {
  return ['.aiverse-promoted', parsed.bare_id, digest].join('/');
}

export function getPromotionCompatibility({ localSkillsRoot = null, requestedQualifiedId } = {}) {
  const source = parseWorkspaceQualifiedId(requestedQualifiedId);
  if (!source) return null;
  const store = readPromotionStore(localSkillsRoot);
  const receipt = store.promotions[requestedQualifiedId];
  if (!receipt || receipt.state !== 'active') return null;
  validateReceipt(requestedQualifiedId, receipt);
  return {
    contract: CAPABILITY_PROMOTION_CONTRACT,
    relationship: 'promoted-to',
    requested_qualified_id: requestedQualifiedId,
    target_qualified_id: receipt.target_qualified_id,
    qualified_identity_preserved: false,
    source_generation_id: receipt.source_generation_id,
    source_digest: { ...receipt.source_digest },
  };
}

export function buildWorkspaceToLocalPromotionPlan({ sourceQualifiedId, sourceSelection, localSkillsRoot = null } = {}) {
  const { parsed, digest } = validateSourceSelection(sourceQualifiedId, sourceSelection);
  const root = localRoot(localSkillsRoot);
  let store;
  try { store = readPromotionStore(root); }
  catch (error) {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', member_message: 'This capability promotion needs review before anything changes.', diagnostic: error.message };
  }
  const existing = store.promotions[sourceQualifiedId];
  if (existing?.state === 'active') {
    const target = targetState(root, parsed.bare_id, existing.target_digest.value);
    if (target.state !== 'conflict') {
      return {
        contract: CAPABILITY_PROMOTION_CONTRACT,
        status: 'already-promoted',
        source_qualified_id: sourceQualifiedId,
        target_qualified_id: existing.target_qualified_id,
        qualified_identity_preserved: false,
        member_message: 'This capability is already reusable across your work.',
      };
    }
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', member_message: 'The promoted capability no longer matches its recorded target and needs review.', diagnostic: target.diagnostic };
  }
  if (existing?.state === 'pending') {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', recovery_required: true, member_message: 'A previous promotion did not finish cleanly and needs recovery review before retrying.' };
  }
  const target = targetState(root, parsed.bare_id, digest.value);
  if (target.state === 'conflict') {
    return {
      contract: CAPABILITY_PROMOTION_CONTRACT,
      status: 'review',
      source_qualified_id: sourceQualifiedId,
      target_qualified_id: targetQualifiedId(parsed.bare_id),
      qualified_identity_preserved: false,
      member_message: 'A different reusable capability already uses this name, so nothing was changed.',
      diagnostic: target.diagnostic,
    };
  }
  try { rejectSymlinks(sourceSelection.locator.package_path); }
  catch (error) {
    return {
      contract: CAPABILITY_PROMOTION_CONTRACT,
      status: 'review',
      source_qualified_id: sourceQualifiedId,
      target_qualified_id: targetQualifiedId(parsed.bare_id),
      qualified_identity_preserved: false,
      member_message: 'This capability uses filesystem structure that needs review before promotion.',
      diagnostic: error.message,
    };
  }
  return {
    contract: CAPABILITY_PROMOTION_CONTRACT,
    status: 'ready',
    operation: 'workspace-to-local',
    source_qualified_id: sourceQualifiedId,
    source_generation_id: sourceSelection.generation_id,
    source_digest: { ...digest },
    target_qualified_id: targetQualifiedId(parsed.bare_id),
    target_preexisting: target.state === 'identical',
    qualified_identity_preserved: false,
    preserve_provenance: true,
    preserve_history: true,
    reference_repair: 'resolver-compatibility-record',
    member_message: 'This capability can be made reusable across your work while preserving its original history.',
  };
}

export function applyWorkspaceToLocalPromotion({
  sourceQualifiedId,
  sourceSelection,
  localSkillsRoot = null,
  expectedSourceGenerationId,
  expectedSourceDigest,
} = {}) {
  const { parsed, digest, providerRoot, packagePath } = validateSourceSelection(sourceQualifiedId, sourceSelection);
  if (typeof expectedSourceGenerationId !== 'string' || typeof expectedSourceDigest !== 'string') {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', member_message: 'Preview this promotion again before applying it.' };
  }
  if (expectedSourceGenerationId !== sourceSelection.generation_id || expectedSourceDigest !== digest.value) {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', stale_plan: true, member_message: 'This capability changed since the preview, so nothing was moved.' };
  }
  const currentDigest = packageDigestV1(packagePath);
  if (currentDigest !== expectedSourceDigest) {
    return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', stale_plan: true, member_message: 'This capability changed since the preview, so nothing was moved.' };
  }

  const root = localRoot(localSkillsRoot);
  let effectOccurred = false;
  try {
    return withPromotionLock(root, () => {
      const store = readPromotionStore(root);
      const existing = store.promotions[sourceQualifiedId];
      if (existing?.state === 'active') {
        const target = targetState(root, parsed.bare_id, existing.target_digest.value);
        if (target.state !== 'conflict') {
          return {
            contract: CAPABILITY_PROMOTION_CONTRACT,
            status: 'already-promoted',
            effect_occurred: false,
            source_qualified_id: sourceQualifiedId,
            target_qualified_id: existing.target_qualified_id,
            qualified_identity_preserved: false,
            member_message: 'This capability is already reusable across your work.',
          };
        }
        return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', effect_occurred: false, member_message: 'The promoted capability needs review before anything else changes.', diagnostic: target.diagnostic };
      }
      if (existing?.state === 'pending') {
        return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', recovery_required: true, effect_occurred: false, member_message: 'A previous promotion did not finish cleanly and needs recovery review before retrying.' };
      }

      rejectSymlinks(packagePath);
      let target = targetState(root, parsed.bare_id, expectedSourceDigest);
      if (target.state === 'conflict') {
        return { contract: CAPABILITY_PROMOTION_CONTRACT, status: 'review', effect_occurred: false, member_message: 'A different reusable capability already uses this name, so nothing was changed.', diagnostic: target.diagnostic };
      }

      let publishedTarget = false;
      if (target.state === 'absent') {
        ensureLocalRoot(root);
        const stageRoot = fs.mkdtempSync(path.join(root, STAGE_PREFIX));
        const staged = path.join(stageRoot, 'package');
        try {
          fs.cpSync(packagePath, staged, { recursive: true, force: false, errorOnExist: true, dereference: false });
          rejectSymlinks(staged);
          const stagedDigest = packageDigestV1(staged);
          if (stagedDigest !== expectedSourceDigest) throw new Error('staged capability bytes do not match the previewed source');
          if (fs.existsSync(target.target)) throw new Error('the reusable target changed while promotion was in progress');
          fs.renameSync(staged, target.target);
          publishedTarget = true;
          effectOccurred = true;
        } finally {
          fs.rmSync(stageRoot, { recursive: true, force: true });
        }
        target = targetState(root, parsed.bare_id, expectedSourceDigest);
        if (target.state !== 'identical') throw new Error('the published reusable target could not be verified');
      }

      const archiveRelative = archiveRelativePath(parsed, expectedSourceDigest);
      const receipt = {
        state: 'pending',
        source_qualified_id: sourceQualifiedId,
        target_qualified_id: targetQualifiedId(parsed.bare_id),
        qualified_identity_preserved: false,
        source_generation_id: expectedSourceGenerationId,
        source_digest: { algorithm: DIGEST_ALGORITHM, value: expectedSourceDigest },
        target_generation_id: `content-sha256:${expectedSourceDigest}`,
        target_digest: { algorithm: DIGEST_ALGORITHM, value: expectedSourceDigest },
        history_archive: archiveRelative,
      };
      store.promotions[sourceQualifiedId] = receipt;
      writePromotionStore(root, store);
      effectOccurred = true;

      const finalSourceDigest = packageDigestV1(packagePath);
      if (finalSourceDigest !== expectedSourceDigest) {
        return {
          contract: CAPABILITY_PROMOTION_CONTRACT,
          status: 'recovery-required',
          effect_occurred: publishedTarget,
          stale_plan: true,
          member_message: 'The source changed while promotion was being applied. The original remains live and nothing was discarded.',
        };
      }

      const archive = path.join(providerRoot, ...archiveRelative.split('/'));
      if (fs.existsSync(archive)) {
        return {
          contract: CAPABILITY_PROMOTION_CONTRACT,
          status: 'recovery-required',
          effect_occurred: publishedTarget,
          member_message: 'Promotion history already exists in an unexpected state. The live source was preserved for review.',
        };
      }
      fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
      fs.renameSync(packagePath, archive);
      if (packageDigestV1(archive) !== expectedSourceDigest) {
        return {
          contract: CAPABILITY_PROMOTION_CONTRACT,
          status: 'recovery-required',
          effect_occurred: true,
          member_message: 'Promotion history could not be verified after retirement, so review is required.',
        };
      }

      receipt.state = 'active';
      store.promotions[sourceQualifiedId] = receipt;
      writePromotionStore(root, store);
      return {
        contract: CAPABILITY_PROMOTION_CONTRACT,
        status: 'applied',
        effect_occurred: true,
        source_qualified_id: sourceQualifiedId,
        target_qualified_id: receipt.target_qualified_id,
        qualified_identity_preserved: false,
        source_generation_id: receipt.source_generation_id,
        target_generation_id: receipt.target_generation_id,
        compatibility_repair: 'active',
        provenance_preserved: true,
        history_preserved: true,
        member_message: 'This capability is now reusable across your work, and its original history was preserved.',
      };
    });
  } catch (error) {
    return {
      contract: CAPABILITY_PROMOTION_CONTRACT,
      status: 'review',
      effect_occurred: effectOccurred,
      member_message: 'This capability promotion needs review before anything else changes.',
      diagnostic: error.message,
    };
  }
}
