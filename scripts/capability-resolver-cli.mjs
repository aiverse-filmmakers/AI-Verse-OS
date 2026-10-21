#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { parseCapabilityJson } from './capability-json.mjs';
import {
  applyCapabilityPromotion,
  planCapabilityBinding,
  applyCapabilityBinding,
  discoverCapabilities,
  planCapabilityPlacement,
  planCapabilityPromotion,
  selectCapability,
} from './capability-resolver.mjs';

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
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length; if (size > 262144) fail('request is too large');
    chunks.push(chunk);
  }
  let raw;
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim(); }
  catch { fail('request must be UTF-8 JSON'); }
  if (!raw) fail('request JSON is required on stdin');
  let data;
  try { data = parseCapabilityJson(raw); }
  catch (error) { fail(`invalid request JSON: ${error.message}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('request must be a JSON object');
  return data;
}

const root = parseArgs(process.argv.slice(2));
if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) fail(`AI-Verse OS root not found: ${root}`);

const request = await readPayload();
const allowed = new Set([
  'operation', 'scope', 'skills_root', 'local_skills_root', 'query', 'qualified_id', 'limit',
  'placement', 'context_label', 'capability_id', 'source_qualified_id',
  'expected_source_generation_id', 'expected_source_digest', 'alias', 'binding', 'plan',
]);
for (const key of Object.keys(request)) {
  if (!allowed.has(key)) fail(`unknown request field: ${key}`);
}

try {
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
} else if (operation === 'plan-binding') {
  process.stdout.write(`${JSON.stringify(planCapabilityBinding({ ...options, qualifiedId: request.qualified_id, alias: request.alias, binding: request.binding }))}\n`);
} else if (operation === 'apply-binding') {
  process.stdout.write(`${JSON.stringify(applyCapabilityBinding({ ...options, plan: request.plan }))}\n`);
} else if (operation === 'plan-placement') {
  const result = planCapabilityPlacement({
    ...options,
    placement: request.placement,
    contextLabel: request.context_label,
    capabilityId: request.capability_id,
    sourceQualifiedId: request.source_qualified_id,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (operation === 'plan-promotion') {
  const result = planCapabilityPromotion({
    ...options,
    sourceQualifiedId: request.source_qualified_id,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (operation === 'apply-promotion') {
  const result = applyCapabilityPromotion({
    ...options,
    sourceQualifiedId: request.source_qualified_id,
    expectedSourceGenerationId: request.expected_source_generation_id,
    expectedSourceDigest: request.expected_source_digest,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  fail(`unsupported operation: ${operation}`);
}

} catch (error) { fail(error.message); }
