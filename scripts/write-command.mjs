#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { evaluateActionPermission } from './action-permission.mjs';

export const WRITE_COMMAND_SCHEMA_VERSION = '1.0';
export const WRITE_COMMAND_PROVIDER = 'ai-verse-os/write-command-v1';
export const WRITE_COMMAND_RUNTIME_DIR = 'runtime/write-commands';
export const MAX_WRITE_COMMAND_BYTES = 128 * 1024;
export const MAX_PARAMETERS_DEPTH = 8;
export const MAX_PARAMETERS_KEYS = 256;
export const MAX_STRING_LENGTH = 16 * 1024;
export const MAX_ARRAY_ITEMS = 256;

const SCOPE = /^(operator|workspace:[a-z0-9][a-z0-9._-]{0,127})$/;
const OPERATION = /^[a-z][a-z0-9_.-]{0,127}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const ALLOWED_FIELDS = new Set([
  'schema_version',
  'request_id',
  'scope',
  'operation',
  'parameters',
  'idempotency_key',
  'requested_by',
  'reason',
  'created_at',
  'request_fingerprint',
  'provenance',
]);

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
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

function assertBoundedJson(value, label = 'parameters', depth = 0, state = { keys: 0 }) {
  if (depth > MAX_PARAMETERS_DEPTH) fail(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH || value.includes('\0')) fail(`${label} contains an invalid or oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) fail(`${label} exceeds ${MAX_ARRAY_ITEMS} array items`);
    value.forEach((item, index) => assertBoundedJson(item, `${label}[${index}]`, depth + 1, state));
    return;
  }
  if (!value || typeof value !== 'object') fail(`${label} contains an unsupported value`);
  const keys = Object.keys(value);
  state.keys += keys.length;
  if (state.keys > MAX_PARAMETERS_KEYS) fail(`${label} exceeds ${MAX_PARAMETERS_KEYS} total object keys`);
  for (const key of keys) {
    if (!key || key.length > 256 || key.includes('\0')) fail(`${label} contains an invalid object key`);
    assertBoundedJson(value[key], `${label}.${key}`, depth + 1, state);
  }
}

function validateProvenance(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('provenance must be an object when present');
  assertBoundedJson(value, 'provenance');
  return stableValue(value);
}

function fingerprintBase(request) {
  return {
    schema_version: request.schema_version,
    request_id: request.request_id,
    scope: request.scope,
    operation: request.operation,
    parameters: stableValue(request.parameters),
    idempotency_key: request.idempotency_key,
    requested_by: request.requested_by,
    reason: request.reason,
    created_at: request.created_at,
    provenance: stableValue(request.provenance ?? {}),
  };
}

export function computeWriteCommandFingerprint(request) {
  return sha256(canonicalJson(fingerprintBase(request)));
}

export function validateWriteCommandRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('write command request must be an object');
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) fail(`unknown write command field: ${key}`);
  }
  if (raw.schema_version !== WRITE_COMMAND_SCHEMA_VERSION) fail(`schema_version must equal ${WRITE_COMMAND_SCHEMA_VERSION}`);
  for (const key of ['request_id', 'scope', 'operation', 'idempotency_key', 'requested_by', 'reason', 'created_at', 'request_fingerprint']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) fail(`${key} must be a non-empty string`);
  }
  if (!BOUNDED_ID.test(raw.request_id)) fail('request_id is invalid');
  if (!SCOPE.test(raw.scope)) fail('scope is invalid');
  if (!OPERATION.test(raw.operation)) fail('operation is invalid');
  if (!BOUNDED_ID.test(raw.idempotency_key)) fail('idempotency_key is invalid');
  if (!BOUNDED_ID.test(raw.requested_by)) fail('requested_by is invalid');
  if (raw.reason.length > 4096 || raw.reason.includes('\0')) fail('reason is invalid or oversized');
  const createdAt = Date.parse(raw.created_at);
  if (!Number.isFinite(createdAt)) fail('created_at must be a valid timestamp');
  if (!HEX64.test(raw.request_fingerprint)) fail('request_fingerprint must be 64 lowercase hex characters');
  if (!own(raw, 'parameters') || !raw.parameters || typeof raw.parameters !== 'object' || Array.isArray(raw.parameters)) {
    fail('parameters must be an object');
  }
  assertBoundedJson(raw.parameters, 'parameters');
  const normalized = {
    schema_version: WRITE_COMMAND_SCHEMA_VERSION,
    request_id: raw.request_id,
    scope: raw.scope,
    operation: raw.operation,
    parameters: stableValue(raw.parameters),
    idempotency_key: raw.idempotency_key,
    requested_by: raw.requested_by,
    reason: raw.reason,
    created_at: new Date(createdAt).toISOString(),
    provenance: validateProvenance(raw.provenance),
  };
  const expected = computeWriteCommandFingerprint(normalized);
  if (raw.request_fingerprint !== expected) fail('request_fingerprint does not match the immutable write command');
  return { ...normalized, request_fingerprint: expected };
}

function assertSafeDirectory(target, parent, label, { create = false } = {}) {
  const parentReal = fs.realpathSync(parent);
  if (!fs.existsSync(target)) {
    if (!create) fail(`${label} does not exist`, 4);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  if (fs.lstatSync(target).isSymbolicLink()) fail(`${label} must not be a symlink`, 4);
  const real = fs.realpathSync(target);
  const relative = path.relative(parentReal, real);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} escapes its owner boundary`, 4);
  }
  if (!fs.statSync(real).isDirectory()) fail(`${label} must be a directory`, 4);
  return real;
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
  for (const required of ['operator', 'workspaces', 'runtime']) {
    const target = path.join(root, required);
    if (!fs.existsSync(target)) {
      if (required === 'runtime') fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      else fail(`incomplete AI-Verse OS host: missing ${required}/`, 4);
    }
    if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory()) {
      fail(`incomplete AI-Verse OS host: unsafe ${required}/`, 4);
    }
  }
  return root;
}

function runtimePaths(root) {
  const runtime = assertSafeDirectory(path.join(root, 'runtime'), root, 'runtime');
  const base = assertSafeDirectory(path.join(runtime, 'write-commands'), runtime, 'write-command runtime', { create: true });
  const queue = assertSafeDirectory(path.join(base, 'queue'), base, 'write-command queue', { create: true });
  const receipts = assertSafeDirectory(path.join(base, 'receipts'), base, 'write-command receipts', { create: true });
  return { runtime, base, queue, receipts };
}

function safeReadJson(file, boundary, label) {
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) fail(`${label} must not be a symlink`, 4);
  const real = fs.realpathSync(file);
  const rel = path.relative(boundary, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail(`${label} escapes its runtime boundary`, 4);
  if (!fs.statSync(real).isFile()) fail(`${label} must be a regular file`, 4);
  try {
    return JSON.parse(fs.readFileSync(real, 'utf8'));
  } catch (error) {
    fail(`${label} is malformed: ${error.message}`, 4);
  }
}

function writeExclusiveJson(file, payload) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function commandKey(request) {
  return sha256(`${request.scope}\n${request.idempotency_key}`);
}

function permissionRequest(request) {
  return {
    request_id: request.request_id,
    action_class: 'write_local_reversible',
    scope: request.scope,
    operation: 'write-command.enqueue',
    parameters: {
      operation: request.operation,
      command_fingerprint: request.request_fingerprint,
    },
    idempotency_key: request.idempotency_key,
    in_scope: true,
    within_budget: true,
    reversible: true,
    reason: request.reason,
    created_at: request.created_at,
    request_fingerprint: request.request_fingerprint,
  };
}

function receiptFor(request, key, permission, queuedAt) {
  return {
    schema_version: WRITE_COMMAND_SCHEMA_VERSION,
    provider: WRITE_COMMAND_PROVIDER,
    status: 'queued',
    command_id: `os_write_${key.slice(0, 32)}`,
    request_id: request.request_id,
    request_fingerprint: request.request_fingerprint,
    idempotency_key: request.idempotency_key,
    scope: request.scope,
    operation: request.operation,
    requested_by: request.requested_by,
    queued_at: queuedAt,
    host_permission: {
      decision: permission.decision,
      source: permission.source,
      reason: permission.reason,
      request_fingerprint: permission.request_fingerprint,
      scope: permission.scope,
      action_class: permission.action_class,
    },
    effect_occurred: false,
    canonical_effect_occurred: false,
    result: {
      queue_state: 'pending_handler',
      canonical_handler_dispatched: false,
    },
  };
}

function existingResult(paths, key, request) {
  const commandPath = path.join(paths.queue, `${key}.json`);
  const receiptPath = path.join(paths.receipts, `${key}.json`);
  const existingCommand = safeReadJson(commandPath, paths.queue, 'existing write command');
  const existingReceipt = safeReadJson(receiptPath, paths.receipts, 'existing write command receipt');
  if (!existingCommand && !existingReceipt) return null;
  if (!existingCommand || !existingReceipt) fail('write-command runtime contains an incomplete idempotency record', 4);
  if (
    existingCommand.request_fingerprint !== request.request_fingerprint
    || existingCommand.scope !== request.scope
    || existingCommand.idempotency_key !== request.idempotency_key
  ) {
    fail('idempotency key is already bound to a different write command', 5);
  }
  if (
    existingReceipt.request_fingerprint !== request.request_fingerprint
    || existingReceipt.command_id !== `os_write_${key.slice(0, 32)}`
  ) {
    fail('write-command runtime receipt does not match its request', 4);
  }
  return { ...existingReceipt, replayed: true };
}

export function enqueueWriteCommand({ osRoot = process.cwd(), request }) {
  const root = validateRoot(osRoot);
  const normalized = validateWriteCommandRequest(request);
  const permission = evaluateActionPermission({ osRoot: root, request: permissionRequest(normalized) });
  if (!permission || permission.request_fingerprint !== normalized.request_fingerprint || permission.scope !== normalized.scope) {
    fail('OS permission response is not bound to the exact write command', 4);
  }
  if (permission.decision !== 'allow') {
    fail(`OS permission blocked write-command enqueue: ${permission.reason}`, 6);
  }

  const paths = runtimePaths(root);
  const key = commandKey(normalized);
  const replay = existingResult(paths, key, normalized);
  if (replay) return replay;

  const queuedAt = new Date().toISOString();
  const commandRecord = {
    schema_version: WRITE_COMMAND_SCHEMA_VERSION,
    provider: WRITE_COMMAND_PROVIDER,
    status: 'queued',
    command_id: `os_write_${key.slice(0, 32)}`,
    request: normalized,
    queued_at: queuedAt,
    canonical_effect_occurred: false,
  };
  const receipt = receiptFor(normalized, key, permission, queuedAt);
  const commandPath = path.join(paths.queue, `${key}.json`);
  const receiptPath = path.join(paths.receipts, `${key}.json`);

  try {
    writeExclusiveJson(commandPath, commandRecord);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = existingResult(paths, key, normalized);
      if (raced) return raced;
    }
    throw error;
  }

  try {
    writeExclusiveJson(receiptPath, receipt);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = existingResult(paths, key, normalized);
      if (raced) return raced;
    }
    try { fs.rmSync(commandPath, { force: true }); } catch {}
    throw error;
  }

  return { ...receipt, replayed: false };
}

function parse(argv) {
  const args = [...argv];
  const command = args.shift() || 'enqueue';
  let root = process.cwd();
  while (args.length) {
    const token = args.shift();
    if (token === '--root') {
      const value = args.shift();
      if (!value) fail('--root requires a path');
      root = path.resolve(value);
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write('Usage: node scripts/write-command.mjs enqueue [--root <ai-verse-os-root>] < request.json\n');
      process.exit(0);
    }
    fail(`unknown option: ${token}`);
  }
  if (command !== 'enqueue') fail(`unknown command: ${command}`);
  return { root };
}

async function main() {
  const { root } = parse(process.argv.slice(2));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) fail('write command JSON is required on stdin');
  if (Buffer.byteLength(raw, 'utf8') > MAX_WRITE_COMMAND_BYTES) fail(`write command exceeds ${MAX_WRITE_COMMAND_BYTES} bytes`);
  let request;
  try {
    request = JSON.parse(raw);
  } catch (error) {
    fail(`write command JSON is malformed: ${error.message}`);
  }
  const result = enqueueWriteCommand({ osRoot: root, request });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`write-command: ${error.message}\n`);
    process.exitCode = Number(error?.exitCode ?? 2);
  });
}
