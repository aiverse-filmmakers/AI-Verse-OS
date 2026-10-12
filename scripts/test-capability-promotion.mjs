import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITY_PROMOTION_CONTRACT,
  applyCapabilityPromotion,
  discoverCapabilities,
  planCapabilityPromotion,
  selectCapability,
} from './capability-resolver.mjs';

function makeOs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-capability-promotion-'));
  fs.mkdirSync(path.join(root, 'system', 'capabilities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n', 'utf8');
  return root;
}

function addWorkspace(root, id) {
  const workspace = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'WORKSPACE.yaml'),
    `schema_version: "2.0"\nid: "${id}"\nname: "${id}"\ntype: "custom"\nstatus: "active"\npurpose: "test"\n`,
    'utf8',
  );
  return workspace;
}

function addCapability(root, workspaceId, id, body = 'method v1') {
  const pkg = path.join(root, 'workspaces', workspaceId, 'skills', id);
  fs.mkdirSync(path.join(pkg, 'references'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'SKILL.md'),
    `---\nname: ${id}\ndescription: test ${id}\n---\n\n${body}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(pkg, 'references', 'history.txt'), `history:${body}\n`, 'utf8');
  fs.writeFileSync(path.join(pkg, 'custom-user-file.txt'), `custom:${body}\n`, 'utf8');
  return pkg;
}

function assertMemberMessage(result) {
  assert.equal(typeof result.member_message, 'string');
  assert(!result.member_message.includes('workspace:'), result.member_message);
  assert(!result.member_message.includes('local:'), result.member_message);
  assert(!result.member_message.includes('/'), result.member_message);
}

const root = makeOs();
const localSkillsRoot = path.join(root, '.test-personal-skills');
try {
  addWorkspace(root, 'alpha');
  addWorkspace(root, 'beta');
  const sourcePath = addCapability(root, 'alpha', 'transcript-book');
  const sourceId = 'workspace:alpha:transcript-book';

  const before = selectCapability({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:beta',
    qualifiedId: sourceId,
  });
  assert.equal(before.status, 'unavailable', 'another Workspace cannot directly consume the source provider');

  const plan = planCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    sourceQualifiedId: sourceId,
  });
  assert.equal(plan.contract, CAPABILITY_PROMOTION_CONTRACT);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.operation, 'workspace-to-local');
  assert.equal(plan.target_qualified_id, 'local:transcript-book');
  assert.equal(plan.qualified_identity_preserved, false);
  assert.equal(plan.preserve_provenance, true);
  assert.equal(plan.preserve_history, true);
  assert.equal(plan.reference_repair, 'resolver-compatibility-record');
  assertMemberMessage(plan);

  const sourceBytes = fs.readFileSync(path.join(sourcePath, 'custom-user-file.txt'), 'utf8');
  const applied = applyCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    sourceQualifiedId: sourceId,
    expectedSourceGenerationId: plan.source_generation_id,
    expectedSourceDigest: plan.source_digest.value,
  });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.effect_occurred, true);
  assert.equal(applied.target_qualified_id, 'local:transcript-book');
  assert.equal(applied.qualified_identity_preserved, false);
  assert.equal(applied.compatibility_repair, 'active');
  assert.equal(applied.provenance_preserved, true);
  assert.equal(applied.history_preserved, true);
  assertMemberMessage(applied);

  const targetPath = path.join(localSkillsRoot, 'transcript-book');
  assert.equal(fs.existsSync(sourcePath), false, 'live Workspace source must retire after verified promotion');
  assert.equal(fs.readFileSync(path.join(targetPath, 'custom-user-file.txt'), 'utf8'), sourceBytes);

  const store = JSON.parse(fs.readFileSync(path.join(localSkillsRoot, '.aiverse', 'promotions-v1.json'), 'utf8'));
  const receipt = store.promotions[sourceId];
  assert.equal(receipt.state, 'active');
  assert.equal(receipt.target_qualified_id, 'local:transcript-book');
  assert.equal(receipt.qualified_identity_preserved, false);
  assert.equal(receipt.source_digest.value, plan.source_digest.value);
  assert.equal(receipt.target_digest.value, plan.source_digest.value);
  const archivePath = path.join(root, 'workspaces', 'alpha', 'skills', ...receipt.history_archive.split('/'));
  assert.equal(fs.readFileSync(path.join(archivePath, 'custom-user-file.txt'), 'utf8'), sourceBytes);

  const fromOtherContext = selectCapability({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:beta',
    qualifiedId: sourceId,
  });
  assert.equal(fromOtherContext.status, 'selected');
  assert.equal(fromOtherContext.selection.id, 'local:transcript-book');
  assert.equal(fromOtherContext.compatibility.requested_qualified_id, sourceId);
  assert.equal(fromOtherContext.compatibility.target_qualified_id, 'local:transcript-book');
  assert.equal(fromOtherContext.compatibility.qualified_identity_preserved, false);
  assert.equal(fromOtherContext.compatibility.relationship, 'promoted-to');

  const byBareName = selectCapability({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:beta',
    query: 'transcript-book',
  });
  assert.equal(byBareName.status, 'selected');
  assert.equal(byBareName.selection.id, 'local:transcript-book');

  const afterDiscovery = discoverCapabilities({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    query: 'transcript-book',
    limit: 20,
  });
  assert(afterDiscovery.candidates.some((item) => item.id === 'local:transcript-book'));
  assert(!afterDiscovery.candidates.some((item) => item.id === sourceId), 'retired source must not remain a canonical candidate');

  const replay = applyCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    sourceQualifiedId: sourceId,
    expectedSourceGenerationId: plan.source_generation_id,
    expectedSourceDigest: plan.source_digest.value,
  });
  assert.equal(replay.status, 'already-promoted');
  assert.equal(replay.effect_occurred, false);

  const stalePath = addCapability(root, 'alpha', 'stale-helper');
  const staleId = 'workspace:alpha:stale-helper';
  const stalePlan = planCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    sourceQualifiedId: staleId,
  });
  assert.equal(stalePlan.status, 'ready');
  fs.appendFileSync(path.join(stalePath, 'SKILL.md'), '\nchanged after preview\n', 'utf8');
  const staleApply = applyCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    sourceQualifiedId: staleId,
    expectedSourceGenerationId: stalePlan.source_generation_id,
    expectedSourceDigest: stalePlan.source_digest.value,
  });
  assert.equal(staleApply.status, 'review');
  assert.equal(staleApply.stale_plan, true);
  assert.equal(staleApply.effect_occurred, false);
  assert.equal(fs.existsSync(stalePath), true);
  assert.equal(fs.existsSync(path.join(localSkillsRoot, 'stale-helper')), false);

  const conflictSource = addCapability(root, 'alpha', 'conflict-helper', 'workspace version');
  const conflictTarget = path.join(localSkillsRoot, 'conflict-helper');
  fs.mkdirSync(conflictTarget, { recursive: true });
  fs.writeFileSync(path.join(conflictTarget, 'SKILL.md'), '---\nname: conflict-helper\n---\n\ndifferent local version\n', 'utf8');
  const conflictPlan = planCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    sourceQualifiedId: 'workspace:alpha:conflict-helper',
  });
  assert.equal(conflictPlan.status, 'review');
  assert.equal(fs.existsSync(conflictSource), true);

  const wrongContext = planCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:beta',
    sourceQualifiedId: staleId,
  });
  assert.equal(wrongContext.status, 'review');
  assertMemberMessage(wrongContext);

  const managed = planCapabilityPromotion({
    osRoot: root,
    localSkillsRoot,
    scope: 'workspace:alpha',
    sourceQualifiedId: 'aiverse-skills:whisper',
  });
  assert.equal(managed.status, 'review');
  assertMemberMessage(managed);

  if (process.platform !== 'win32') {
    const symlinkSource = addCapability(root, 'alpha', 'symlink-helper');
    fs.symlinkSync('references/history.txt', path.join(symlinkSource, 'history-link.txt'));
    const symlinkPlan = planCapabilityPromotion({
      osRoot: root,
      localSkillsRoot,
      scope: 'workspace:alpha',
      sourceQualifiedId: 'workspace:alpha:symlink-helper',
    });
    assert.equal(symlinkPlan.status, 'review');
    assert.equal(fs.existsSync(symlinkSource), true);
  }

  console.log('Capability promotion acceptance: PASS');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
