#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  DIRECTION_SCHEMA_VERSION,
  directionOwnerState,
  readDirectionRegistry,
} from './direction-owner-core.mjs';

function fail(message, code = 2) {
  process.stderr.write(`direction-owner: ${message}\n`);
  process.exit(code);
}

function isRoot(root) {
  return fs.existsSync(path.join(root, 'AI-VERSE.yaml'));
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
  const { owner } = directionOwnerState(root, scope);
  if (command === 'status') {
    const registry = readDirectionRegistry(root);
    const record = registry.scopes[scope] || null;
    process.stdout.write(`${JSON.stringify({ schema_version: DIRECTION_SCHEMA_VERSION, scope, owner, record }, null, 2)}\n`);
  } else if (command === 'assert-strategic-write') {
    if (owner !== 'os') {
      fail(`strategic direction for ${scope} is owned by Brain; OS strategic writes are blocked even if Brain is unavailable`, 3);
    }
    process.stdout.write(`strategic-write-allowed:${scope}:os\n`);
  } else {
    fail(`unknown command: ${command}`);
  }
} catch (error) {
  fail(error.message, 4);
}
