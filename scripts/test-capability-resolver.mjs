import './test-capability-resolver-core.mjs';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCapabilities, selectCapability } from './capability-resolver.mjs';

function skill(dir, name = 'private') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${name} capability"\nversion: 1.0.0\n---\n\n# ${name}\n`, 'utf8');
}

function setupOs(base) {
  const root = path.join(base, 'os');
  fs.mkdirSync(path.join(root, 'system', 'capabilities', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AI-VERSE.yaml'), 'schema_version: "2.0"\narchitecture: unified-workspace\n', 'utf8');
  skill(path.join(root, 'system', 'capabilities', 'audit'), 'audit');
  return root;
}

function setupWorkspace(root, id) {
  const workspace = path.join(root, 'workspaces', id);
  fs.mkdirSync(path.join(workspace, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'WORKSPACE.yaml'), `schema_version: "1.0"\nid: ${id}\n`, 'utf8');
  return workspace;
}

function linkDirectory(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function withFixture(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aiverse-workspace-boundary-'));
  try { fn(base); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
}

function assertWorkspaceUnavailable(root, label) {
  const options = {
    osRoot: root,
    scope: 'workspace:alpha',
    skillsRoot: path.join(path.dirname(root), 'missing-distributed'),
    localSkillsRoot: path.join(path.dirname(root), 'missing-local'),
  };
  const discovered = discoverCapabilities({ ...options, query: 'private', limit: 200 });
  const workspaceProvider = discovered.providers.find((item) => item.provider === 'workspace:alpha');
  assert.equal(workspaceProvider?.state, 'degraded', `${label}: workspace provider must fail closed`);
  assert.equal(workspaceProvider?.candidate_count, 0, `${label}: degraded workspace must expose zero candidates`);
  assert(!discovered.candidates.some((item) => item.id === 'workspace:alpha:private'), `${label}: private capability leaked`);

  const selected = selectCapability({ ...options, qualifiedId: 'workspace:alpha:private' });
  assert.equal(selected.status, 'unavailable', `${label}: leaked capability remained selectable`);
  assert(!selected.selection, `${label}: selection must not contain the leaked package`);
}

withFixture((base) => {
  const root = setupOs(base);
  const alpha = setupWorkspace(root, 'alpha');
  const beta = setupWorkspace(root, 'beta');
  skill(path.join(beta, 'skills', 'private'));
  fs.rmSync(path.join(alpha, 'skills'), { recursive: true, force: true });
  linkDirectory(path.join(beta, 'skills'), path.join(alpha, 'skills'));
  assertWorkspaceUnavailable(root, 'alpha skills -> beta skills');
});

withFixture((base) => {
  const root = setupOs(base);
  const alpha = setupWorkspace(root, 'alpha');
  const outsideSkills = path.join(base, 'outside-skills');
  skill(path.join(outsideSkills, 'private'));
  fs.rmSync(path.join(alpha, 'skills'), { recursive: true, force: true });
  linkDirectory(outsideSkills, path.join(alpha, 'skills'));
  assertWorkspaceUnavailable(root, 'alpha skills -> outside directory');
});

withFixture((base) => {
  const root = setupOs(base);
  const beta = setupWorkspace(root, 'beta');
  skill(path.join(beta, 'skills', 'private'));
  linkDirectory(beta, path.join(root, 'workspaces', 'alpha'));
  assertWorkspaceUnavailable(root, 'alpha workspace -> beta workspace');
});

withFixture((base) => {
  const root = setupOs(base);
  const alpha = setupWorkspace(root, 'alpha');
  skill(path.join(alpha, 'skills', 'private'));
  fs.writeFileSync(path.join(alpha, 'WORKSPACE.yaml'), 'schema_version: "1.0"\nid: beta\n', 'utf8');
  assertWorkspaceUnavailable(root, 'workspace manifest id mismatch');
});

console.log('Workspace capability physical-boundary acceptance: PASS');
