#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const VALID_OWNERS = new Set(['os', 'brain']);

function fail(message, code = 2) {
  process.stderr.write(`direction-owner: ${message}\n`);
  process.exit(code);
}

function isRoot(root) {
  return fs.existsSync(path.join(root, 'AI-VERSE.yaml'));
}

function markerPath(root) {
  return path.join(root, '.aiverse', 'direction', 'ownership.json');
}

function validateScope(scope) {
  if (!/^(operator|workspace:[a-z0-9][a-z0-9._-]{0,127})$/.test(scope)) {
    throw new Error(`invalid scope: ${scope}`);
  }
}

function readRegistry(root) {
  const marker = markerPath(root);
  const directionDir = path.dirname(marker);
  if (fs.existsSync(directionDir) && fs.lstatSync(directionDir).isSymbolicLink()) {
    throw new Error('direction ownership directory must not be a symlink');
  }
  if (!fs.existsSync(marker)) return { schema_version: SCHEMA_VERSION, scopes: {} };
  if (fs.lstatSync(marker).isSymbolicLink()) throw new Error('direction ownership file must not be a symlink');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch (error) {
    throw new Error(`invalid direction ownership registry: ${error.message}`);
  }
  if (!data || data.schema_version !== SCHEMA_VERSION || typeof data.scopes !== 'object' || Array.isArray(data.scopes)) {
    throw new Error('unsupported or malformed direction ownership registry');
  }
  for (const [scope, record] of Object.entries(data.scopes)) {
    validateScope(scope);
    if (!record || !VALID_OWNERS.has(record.owner)) throw new Error(`invalid direction ownership record for ${scope}`);
  }
  return data;
}

function ownerFor(root, scope) {
  validateScope(scope);
  const registry = readRegistry(root);
  return registry.scopes[scope]?.owner || 'os';
}

function parse(argv) {
  const args = [...argv];
  const command = args.shift() || 'status';
  let root = process.cwd();
  let scope = 'operator';
  while (args.length) {
    const token = args.shift();
    if (token === '--root' || token === '--dir') root = path.resolve(args.shift() || fail(`${token} requires a path`));
    else if (token === '--scope') scope = args.shift() || fail('--scope requires a value');
    else fail(`unknown option: ${token}`);
  }
  return { command, root: path.resolve(root), scope };
}

const { command, root, scope } = parse(process.argv.slice(2));
if (!isRoot(root)) fail(`AI-Verse OS root not found: ${root}`);

try {
  const owner = ownerFor(root, scope);
  if (command === 'status') {
    const registry = readRegistry(root);
    const record = registry.scopes[scope] || null;
    process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, scope, owner, record }, null, 2)}\n`);
  } else if (command === 'assert-strategic-write') {
    if (owner !== 'os') {
      fail(`strategic direction for ${scope} is owned by Brain; OS strategic writes are blocked even if Brain is unavailable`, 3);
    }
    process.stdout.write(`strategic-write-allowed:${scope}:os\n`);
  } else {
    fail(`unknown command: ${command}`);
  }
} catch (error) {
  // Malformed ownership state fails closed. Never silently fall back to OS ownership.
  fail(error.message, 4);
}
