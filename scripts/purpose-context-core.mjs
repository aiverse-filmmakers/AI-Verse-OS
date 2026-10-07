import fs from 'node:fs';
import path from 'node:path';

import { readCurrentContext } from './current-context.mjs';
import { validateDirectionScope } from './direction-owner-core.mjs';

function samePath(a, b) {
  return path.relative(a, b) === '' && path.relative(b, a) === '';
}

function requirePhysicalDirectory(target, expected, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} does not exist`);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (!samePath(real, expected)) throw new Error(`${label} is not its expected physical slot`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory`);
  return real;
}

export function resolvePurposeScope(root, scope = 'operator') {
  const base = path.resolve(root);
  validateDirectionScope(scope);

  const manifest = path.join(base, 'AI-VERSE.yaml');
  if (!fs.existsSync(manifest) || !fs.statSync(manifest).isFile()) {
    throw new Error(`AI-Verse OS root not found: ${base}`);
  }

  if (scope === 'operator') {
    const operator = requirePhysicalDirectory(
      path.join(base, 'operator'),
      path.join(fs.realpathSync(base), 'operator'),
      'operator root',
    );
    return {
      scope: 'operator',
      scope_kind: 'operator',
      identity: { kind: 'operator', id: 'operator' },
      boundary: operator,
    };
  }

  const id = scope.slice('workspace:'.length);
  const realBase = fs.realpathSync(base);
  const workspaces = requirePhysicalDirectory(
    path.join(base, 'workspaces'),
    path.join(realBase, 'workspaces'),
    'workspaces root',
  );
  const workspace = requirePhysicalDirectory(
    path.join(base, 'workspaces', id),
    path.join(workspaces, id),
    `workspace ${id}`,
  );
  const workspaceManifest = path.join(workspace, 'WORKSPACE.yaml');
  if (!fs.existsSync(workspaceManifest) || fs.lstatSync(workspaceManifest).isSymbolicLink() || !fs.statSync(workspaceManifest).isFile()) {
    throw new Error(`workspace ${id} is missing canonical WORKSPACE.yaml`);
  }

  return {
    scope,
    scope_kind: 'workspace',
    identity: { kind: 'workspace', id },
    boundary: workspace,
  };
}

export function readPurposeCurrentContext(root, scope = 'operator') {
  const resolved = resolvePurposeScope(root, scope);
  const current = readCurrentContext(path.resolve(root), resolved.scope);
  if (!current || current.scope !== resolved.scope) {
    throw new Error(`ownership-aware current context returned the wrong scope for ${resolved.scope}`);
  }
  if (!['os', 'brain'].includes(current.direction_owner)) {
    throw new Error(`ownership-aware current context returned an invalid direction owner for ${resolved.scope}`);
  }
  return {
    resolved,
    current,
  };
}
