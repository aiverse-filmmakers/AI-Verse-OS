#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { discoverCapabilities, selectCapability } from './capability-resolver.mjs';

function fail(message) {
  process.stderr.write(`capability-resolver-cli: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') {
      if (i + 1 >= argv.length) fail('--root requires a path');
      root = path.resolve(argv[++i]);
      continue;
    }
    fail(`unknown option: ${token}`);
  }
  return root;
}

async function readPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) fail('request JSON is required on stdin');
  let data;
  try { data = JSON.parse(raw); }
  catch (error) { fail(`invalid request JSON: ${error.message}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('request must be a JSON object');
  return data;
}

const root = parseArgs(process.argv.slice(2));
if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) fail(`AI-Verse OS root not found: ${root}`);

const request = await readPayload();
const allowed = new Set([
  'operation', 'scope', 'skills_root', 'local_skills_root', 'query', 'qualified_id', 'limit',
]);
for (const key of Object.keys(request)) {
  if (!allowed.has(key)) fail(`unknown request field: ${key}`);
}

const operation = request.operation;
const options = {
  osRoot: root,
  scope: request.scope ?? 'operator',
  skillsRoot: request.skills_root,
  localSkillsRoot: request.local_skills_root,
};
if (operation === 'discover') {
  const result = discoverCapabilities({
    ...options,
    query: request.query,
    limit: request.limit,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (operation === 'select') {
  const result = selectCapability({
    ...options,
    query: request.query,
    qualifiedId: request.qualified_id,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  fail(`unsupported operation: ${operation}`);
}
