import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITY_PLACEMENT_CONTRACT,
  planCapabilityPlacement,
} from './capability-resolver.mjs';

function makeOs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-capability-placement-'));
  fs.mkdirSync(path.join(root, 'system', 'capabilities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n', 'utf8');
  return root;
}

function addWorkspace(root, id, manifestId = id) {
  const workspace = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'WORKSPACE.yaml'),
    `schema_version: "2.0"\nid: "${manifestId}"\nname: "${id}"\ntype: "custom"\nstatus: "active"\npurpose: "test"\n`,
    'utf8',
  );
}

function noInternalMemberJargon(result) {
  assert.equal(typeof result.member_message, 'string');
  assert(!result.member_message.includes('workspace:'), result.member_message);
  assert(!result.member_message.includes('aiverse-skills'), result.member_message);
  assert(!result.member_message.includes('/'), result.member_message);
}

{
  const root = makeOs();
  try {
    addWorkspace(root, 'alpha');

    const project = planCapabilityPlacement({
      osRoot: root,
      scope: 'workspace:alpha',
      placement: 'only use this in this project',
      capabilityId: 'transcript-book',
    });
    assert.equal(project.contract, CAPABILITY_PLACEMENT_CONTRACT);
    assert.equal(project.status, 'planned');
    assert.equal(project.target_provider, 'workspace:alpha');
    assert.equal(project.target_qualified_id, 'workspace:alpha:transcript-book');
    assert.equal(project.ownership, 'workspace-owned');
    assert.equal(project.promotion.required, false);
    assert.equal(project.managed_distribution_writable_target, false);
    noInternalMemberJargon(project);

    const youtube = planCapabilityPlacement({
      osRoot: root,
      scope: 'workspace:alpha',
      placement: 'use this for all YouTube work',
      capabilityId: 'transcript-book',
    });
    assert.equal(youtube.status, 'planned');
    assert.equal(youtube.member_intent.kind, 'related-work');
    assert.equal(youtube.member_intent.context_label, 'YouTube');
    assert.equal(youtube.target_provider, 'local');
    assert.equal(youtube.target_qualified_id, 'local:transcript-book');
    assert.equal(youtube.ownership, 'user-owned');
    noInternalMemberJargon(youtube);

    const everywhere = planCapabilityPlacement({
      osRoot: root,
      scope: 'workspace:alpha',
      placement: 'use this everywhere',
      capabilityId: 'transcript-book',
    });
    assert.equal(everywhere.target_provider, 'local');
    assert.equal(everywhere.target_qualified_id, 'local:transcript-book');
    noInternalMemberJargon(everywhere);

    const promotion = planCapabilityPlacement({
      osRoot: root,
      scope: 'workspace:alpha',
      placement: 'use this for all YouTube work',
      capabilityId: 'transcript-book',
      sourceQualifiedId: 'workspace:alpha:transcript-book',
    });
    assert.equal(promotion.status, 'planned');
    assert.equal(promotion.promotion.required, true);
    assert.equal(promotion.promotion.apply_supported, false);
    assert.equal(promotion.promotion.qualified_identity_preserved, false);
    assert.equal(promotion.promotion.preserve_provenance, true);
    assert.equal(promotion.promotion.preserve_history, true);
    assert.equal(promotion.promotion.reference_repair_required, true);

    const managedSource = planCapabilityPlacement({
      osRoot: root,
      scope: 'workspace:alpha',
      placement: 'use this everywhere',
      capabilityId: 'whisper',
      sourceQualifiedId: 'aiverse-skills:whisper',
    });
    assert.equal(managedSource.status, 'review');
    assert.equal(managedSource.promotion.blocked, true);
    assert.equal(managedSource.promotion.apply_supported, false);
    noInternalMemberJargon(managedSource);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = makeOs();
  try {
    const noProject = planCapabilityPlacement({
      osRoot: root,
      scope: 'operator',
      placement: 'this-project',
      capabilityId: 'project-helper',
    });
    assert.equal(noProject.status, 'review');
    noInternalMemberJargon(noProject);

    addWorkspace(root, 'alpha', 'different-id');
    const invalidProject = planCapabilityPlacement({
      osRoot: root,
      scope: 'workspace:alpha',
      placement: 'this-project',
      capabilityId: 'project-helper',
    });
    assert.equal(invalidProject.status, 'review');
    noInternalMemberJargon(invalidProject);

    assert.throws(
      () => planCapabilityPlacement({
        osRoot: root,
        scope: 'operator',
        placement: 'local',
        capabilityId: 'project-helper',
      }),
      /unsupported placement intent/,
      'member placement must not be expressed as an internal provider choice',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('Capability placement acceptance: PASS');
