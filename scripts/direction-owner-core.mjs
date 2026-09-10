import fs from 'node:fs';
import path from 'node:path';

export const DIRECTION_SCHEMA_VERSION = 1;
export const VALID_DIRECTION_OWNERS = new Set(['os', 'brain']);

export function validateDirectionScope(scope) {
  if (!/^(operator|workspace:[a-z0-9][a-z0-9._-]{0,127})$/.test(scope)) {
    throw new Error(`invalid scope: ${scope}`);
  }
  return scope;
}

export function directionMarkerPath(root) {
  return path.join(path.resolve(root), '.aiverse', 'direction', 'ownership.json');
}

export function readDirectionRegistry(root) {
  const base = path.resolve(root);
  const marker = directionMarkerPath(base);
  const aiverseDir = path.join(base, '.aiverse');
  const directionDir = path.dirname(marker);
  if (fs.existsSync(aiverseDir) && fs.lstatSync(aiverseDir).isSymbolicLink()) {
    throw new Error('.aiverse directory must not be a symlink');
  }
  if (fs.existsSync(directionDir) && fs.lstatSync(directionDir).isSymbolicLink()) {
    throw new Error('direction ownership directory must not be a symlink');
  }
  if (!fs.existsSync(marker)) return { schema_version: DIRECTION_SCHEMA_VERSION, scopes: {} };
  if (fs.lstatSync(marker).isSymbolicLink()) throw new Error('direction ownership file must not be a symlink');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch (error) {
    throw new Error(`invalid direction ownership registry: ${error.message}`);
  }
  if (!data || data.schema_version !== DIRECTION_SCHEMA_VERSION || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) {
    throw new Error('unsupported or malformed direction ownership registry');
  }
  for (const [scope, record] of Object.entries(data.scopes)) {
    validateDirectionScope(scope);
    if (!record || typeof record !== 'object' || Array.isArray(record) || !VALID_DIRECTION_OWNERS.has(record.owner)) {
      throw new Error(`invalid direction ownership record for ${scope}`);
    }
  }
  return data;
}

export function directionOwnerState(root, scope) {
  validateDirectionScope(scope);
  const registry = readDirectionRegistry(root);
  const record = registry.scopes[scope] || null;
  return { owner: record?.owner || 'os', record, registry };
}
