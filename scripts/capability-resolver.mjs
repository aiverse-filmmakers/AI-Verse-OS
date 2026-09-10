import fs from 'node:fs';
import path from 'node:path';
import * as core from './capability-resolver-core.mjs';

export * from './capability-resolver-core.mjs';

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

export function selectCapability(options = {}) {
  const scope = options.scope ?? 'operator';
  const boundary = validateWorkspaceBoundary({ osRoot: options.osRoot, scope });
  if (boundary.state !== 'invalid') return core.selectCapability(options);
  const result = core.selectCapability({ ...options, scope: 'operator' });
  return { ...result, providers: [...(result.providers ?? []), degradedWorkspaceProvider(boundary)] };
}
