#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { evaluateActionPermission } from './action-permission.mjs';

export const OS_DATA_HOST_PROTOCOL = 'ai-verse-os-data-host/1.0';
export const DATA_ENGINE_PROTOCOL = 'ai-verse-data-host/1.0';
export const DATA_EXTENSION_ID = 'ai-verse-data';
export const EXTENSION_REGISTRY = '.aiverse/extensions/registry.json';
export const MAX_HOST_REQUEST_BYTES = 256 * 1024;

const SCOPE = /^workspace:([a-z0-9][a-z0-9-]{0,127})$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const READ_OPERATIONS = new Set([
  'data.space.list',
  'data.space.get',
  'data.schema.list',
  'data.schema.get',
  'data.schema.migration.preview',
  'data.record.get',
  'data.record.list',
  'data.query',
  'data.aggregate',
  'data.bulk.preview',
  'data.events.list',
  'data.doctor',
  'data.status',
]);
const WRITE_OPERATIONS = new Set([
  'data.space.create',
  'data.schema.create',
  'data.schema.update',
  'data.schema.migration.execute',
  'data.record.create',
  'data.record.update',
  'data.bulk.execute',
  'data.transaction.execute',
]);
const DELETE_OPERATIONS = new Set(['data.record.delete']);

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function contained(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function validateRoot(rootInput) {
  const root = fs.realpathSync(path.resolve(rootInput));
  const manifest = path.join(root, 'AI-VERSE.yaml');
  if (!fs.existsSync(manifest) || fs.lstatSync(manifest).isSymbolicLink() || !fs.statSync(manifest).isFile()) {
    fail('AI-Verse OS root is missing a safe AI-VERSE.yaml', 4);
  }
  const text = fs.readFileSync(manifest, 'utf8');
  if (!/^schema_version:\s*["']?2\./m.test(text) || !/^architecture:\s*["']?unified-workspace["']?\s*$/m.test(text)) {
    fail('incompatible AI-Verse OS host', 4);
  }
  return root;
}

function safeRelativePath(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
  ) {
    fail(`${label} must be a safe repository-relative path`, 4);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    fail(`${label} contains unsafe path segments`, 4);
  }
  return parts;
}

function readRegistry(root) {
  const file = path.join(root, EXTENSION_REGISTRY);
  if (!fs.existsSync(file)) fail('AI-Verse Data is not installed', 4);
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) {
    fail('extension registry must be a regular non-symlink file', 4);
  }
  const real = fs.realpathSync(file);
  if (!contained(real, root)) fail('extension registry escapes the OS root', 4);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(real, 'utf8'));
  } catch (error) {
    fail(`extension registry is invalid JSON: ${error.message}`, 4);
  }
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || registry.schema_version !== '1.0') {
    fail('extension registry schema is unsupported', 4);
  }
  if (!registry.extensions || typeof registry.extensions !== 'object' || Array.isArray(registry.extensions)) {
    fail('extension registry extensions must be an object', 4);
  }
  return registry;
}

function dataEntry(root) {
  const registry = readRegistry(root);
  const entry = registry.extensions[DATA_EXTENSION_ID];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('AI-Verse Data is not registered', 4);
  }
  if (entry.supported !== true || entry.installed !== true) {
    fail('AI-Verse Data registration is not supported and installed', 4);
  }
  if (entry.enabled !== true) {
    fail('AI-Verse Data is disabled', 4);
  }
  const parts = safeRelativePath(entry.engine, 'AI-Verse Data engine path');
  const file = path.join(root, ...parts);
  if (!fs.existsSync(file)) fail('AI-Verse Data engine file is missing', 4);
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) {
    fail('AI-Verse Data engine must be a regular non-symlink file', 4);
  }
  const real = fs.realpathSync(file);
  if (!contained(real, root)) fail('AI-Verse Data engine escapes the OS root', 4);
  return { entry, enginePath: real };
}

async function loadDataEngine(root) {
  const { entry, enginePath } = dataEntry(root);
  const engine = await import(pathToFileURL(enginePath).href);
  if (typeof engine.describe !== 'function' || typeof engine.handleRequest !== 'function') {
    fail('AI-Verse Data engine does not expose the required host interface', 4);
  }
  const description = engine.describe();
  if (
    !description
    || description.protocol !== DATA_ENGINE_PROTOCOL
    || description.actorBinding !== 'human:local-operator'
    || description.authorizationBinding !== 'local-operator'
  ) {
    fail('AI-Verse Data engine host contract is incompatible', 4);
  }
  return { entry, engine, description };
}

function validateRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Data host request must be an object');
  const allowed = new Set(['protocol', 'request_id', 'operation', 'scope', 'data', 'reason']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) fail(`unknown Data host request field: ${key}`);
  if (raw.protocol !== OS_DATA_HOST_PROTOCOL) fail(`protocol must equal ${OS_DATA_HOST_PROTOCOL}`);
  if (typeof raw.request_id !== 'string' || !REQUEST_ID.test(raw.request_id)) fail('request_id is invalid');
  if (!['describe', 'discover', 'init', 'request'].includes(raw.operation)) fail('operation is unsupported');
  if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 4096 || raw.reason.includes('\0')) {
    fail('reason must be a non-empty bounded string');
  }
  if (raw.operation === 'describe') {
    if (raw.scope !== undefined || raw.data !== undefined) fail('describe does not accept scope or data');
    return { ...raw };
  }
  if (typeof raw.scope !== 'string') fail('workspace scope is required');
  const match = SCOPE.exec(raw.scope);
  if (!match) fail('scope must be workspace:<id>');
  if (raw.operation === 'request') {
    if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) fail('request requires a data object');
    const keys = Object.keys(raw.data);
    if (keys.length !== 2 || keys.some((key) => key !== 'operation' && key !== 'payload')) {
      fail('data must contain exactly operation and payload');
    }
    if (typeof raw.data.operation !== 'string') fail('data.operation must be a string');
    if (!raw.data.payload || typeof raw.data.payload !== 'object' || Array.isArray(raw.data.payload)) {
      fail('data.payload must be an object');
    }
  } else if (raw.data !== undefined) {
    fail('only request may include data');
  }
  return { ...raw, workspaceId: match[1] };
}

function actionFor(request) {
  if (request.operation === 'describe' || request.operation === 'discover') {
    return { actionClass: 'read_local', reversible: true, operation: `data-host.${request.operation}`, parameters: {} };
  }
  if (request.operation === 'init') {
    return { actionClass: 'modify_canonical_state', reversible: true, operation: 'data.workspace.init', parameters: { workspace_id: request.workspaceId } };
  }
  const operation = request.data.operation;
  if (READ_OPERATIONS.has(operation)) {
    return { actionClass: 'read_local', reversible: true, operation, parameters: request.data.payload };
  }
  if (WRITE_OPERATIONS.has(operation)) {
    return { actionClass: 'modify_canonical_state', reversible: false, operation, parameters: request.data.payload };
  }
  if (DELETE_OPERATIONS.has(operation)) {
    return { actionClass: 'delete_data', reversible: false, operation, parameters: request.data.payload };
  }
  fail(`Data operation is unsupported by the OS host: ${operation}`);
}

function permissionFor(root, request, action) {
  const basis = {
    action_class: action.actionClass,
    scope: request.scope ?? 'operator',
    operation: action.operation,
    parameters: stableValue(action.parameters),
    idempotency_key: request.data?.payload?.idempotencyKey ?? request.request_id,
    in_scope: true,
    within_budget: true,
    reversible: action.reversible,
    reason: request.reason,
  };
  const requestFingerprint = sha256(canonicalJson(basis));
  const permissionRequest = {
    request_id: request.request_id,
    ...basis,
    created_at: new Date().toISOString(),
    request_fingerprint: requestFingerprint,
  };
  const permission = evaluateActionPermission({ osRoot: root, request: permissionRequest });
  if (
    !permission
    || permission.request_fingerprint !== requestFingerprint
    || permission.scope !== permissionRequest.scope
    || permission.action_class !== action.actionClass
  ) {
    fail('OS action-permission result is not bound to the exact Data request', 4);
  }
  return permission;
}

export async function invokeDataHost({ osRoot = process.cwd(), request }) {
  const root = validateRoot(osRoot);
  const normalized = validateRequest(request);
  const action = actionFor(normalized);
  const permission = permissionFor(root, normalized, action);

  if (permission.decision === 'deny') {
    fail(`OS permission denied Data operation: ${permission.reason}`, 6);
  }
  if (permission.decision === 'approval_required') {
    return {
      status: 'approval_required',
      effect_occurred: false,
      permission,
      operation: action.operation,
    };
  }

  const { engine, description } = await loadDataEngine(root);
  let engineRequest;
  if (normalized.operation === 'describe') {
    return {
      status: 'succeeded',
      effect_occurred: false,
      permission,
      extension: description,
    };
  }
  if (normalized.operation === 'discover') {
    engineRequest = {
      protocol: DATA_ENGINE_PROTOCOL,
      operation: 'workspace.discover',
      rootPath: root,
      workspaceId: normalized.workspaceId,
    };
  } else if (normalized.operation === 'init') {
    engineRequest = {
      protocol: DATA_ENGINE_PROTOCOL,
      operation: 'workspace.init',
      rootPath: root,
      workspaceId: normalized.workspaceId,
    };
  } else {
    engineRequest = {
      protocol: DATA_ENGINE_PROTOCOL,
      operation: 'data.request',
      rootPath: root,
      workspaceId: normalized.workspaceId,
      data: normalized.data,
    };
  }

  const result = await engine.handleRequest(engineRequest);
  return {
    status: 'succeeded',
    effect_occurred: normalized.operation === 'init' || action.actionClass !== 'read_local',
    permission,
    result,
  };
}

function parseArgs(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--root') {
      if (index + 1 >= argv.length) fail('--root requires a path');
      root = argv[++index];
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write('Usage: node scripts/data-host.mjs [--root <ai-verse-os-root>] < request.json\n');
      process.exit(0);
    }
    fail(`unknown argument: ${token}`);
  }
  return { root };
}

async function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) fail('Data host request JSON is required on stdin');
  if (Buffer.byteLength(raw, 'utf8') > MAX_HOST_REQUEST_BYTES) fail(`Data host request exceeds ${MAX_HOST_REQUEST_BYTES} bytes`);
  let request;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    fail(`Data host request JSON is malformed: ${error.message}`);
  }
  const result = await invokeDataHost({ osRoot: root, request });
  process.stdout.write(`${JSON.stringify({ protocol: OS_DATA_HOST_PROTOCOL, request_id: request.request_id, ok: true, result })}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`data-host: ${error.message}\n`);
    process.exitCode = Number(error?.exitCode ?? 2);
  });
}
