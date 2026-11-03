#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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
    created_at: raw.created_at,
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
  const tmp = assertSafeDirectory(path.join(base, 'tmp'), base, 'write-command tmp', { create: true });
  const withdrawn = assertSafeDirectory(path.join(base, 'withdrawn'), base, 'write-command withdrawals', { create: true });
  return { runtime, base, queue, receipts, tmp, withdrawn };
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

// Create-if-absent with the whole content or nothing: the file is written and fsynced under a private name and then linked into
// place, so a process killed at any point leaves either no file or a complete one (never a half-written record), and an
// existing file is never replaced (EEXIST). The private name lives in the runtime's own tmp folder (same filesystem), so a kill
// never leaves a stray file in a queue, a receipt folder or an owner's inbox.
function writeExclusiveJson(file, payload, tmpDir) {
  const tmp = path.join(tmpDir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.new`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, file);
    fsyncDir(path.dirname(file));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Directory entries are made durable where the platform supports it (a rename or link is not safe until its directory is).
function fsyncDir(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function replaceJson(file, payload) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd); // the content is on disk before it replaces anything
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(dir);
}

function commandKey(request) {
  return sha256(`${request.scope}\n${request.idempotency_key}`);
}

function permissionRequest(request, operation = 'write-command.enqueue', actionClass = 'write_local_reversible') {
  return {
    request_id: request.request_id,
    action_class: actionClass,
    scope: request.scope,
    operation,
    parameters: {
      operation: request.operation,
      command_fingerprint: request.request_fingerprint,
    },
    idempotency_key: request.idempotency_key,
    in_scope: true,
    within_budget: true,
    reversible: actionClass !== 'delete_data',
    reason: request.reason,
    created_at: request.created_at,
    request_fingerprint: request.request_fingerprint,
  };
}

function evaluatePermission(root, request, operation, actionClass = 'write_local_reversible') {
  const permission = evaluateActionPermission({
    osRoot: root,
    request: permissionRequest(request, operation, actionClass),
  });
  if (!permission || permission.request_fingerprint !== request.request_fingerprint || permission.scope !== request.scope) {
    fail('OS permission response is not bound to the exact write command', 4);
  }
  if (permission.decision !== 'allow') {
    fail(`OS permission blocked ${operation}: ${permission.reason}`, 6);
  }
  return permission;
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

// -- withdrawal: a terminal tombstone bound to the original operation ---------------------------------------------------
//
// A proposal this pipeline routed can be withdrawn when its text turns out to hold a credential. The tombstone is written FIRST and
// atomically; from then on enqueue, dispatch and every recovery path refuse to recreate the content, and each of them finishes the
// redaction if a process died part-way. Redaction is explicit: the stored request is removed (never left with content that no longer
// matches its fingerprint), the inbox candidate keeps only its kind and a `redacted` marker, the receipt says `withdrawn`, and every
// temporary copy of the payload is removed.

export const LEARNING_REQUESTER = 'ai-verse-os.auto-learning';
const LEARNING_KIND = 'claude-code-learning-proposal';

function readTombstone(paths, key) {
  return safeReadJson(path.join(paths.withdrawn, `${key}.json`), paths.withdrawn, 'write command withdrawal');
}

function withdrawnResult(tomb) {
  return {
    schema_version: WRITE_COMMAND_SCHEMA_VERSION,
    provider: WRITE_COMMAND_PROVIDER,
    status: 'withdrawn',
    command_id: tomb.command_id,
    request_fingerprint: tomb.request_fingerprint,
    idempotency_key: tomb.idempotency_key,
    scope: tomb.scope,
    effect_occurred: false,
    canonical_effect_occurred: false,
    withdrawn_at: tomb.withdrawn_at,
    replayed: true,
  };
}

// Every temporary file that could still hold a copy of this operation's payload: the private creation names and the replacement names.
function sweepTemps(root, paths, key, scope) {
  const prefixes = [`.${key}.json.`, `.write-candidate-${key.slice(0, 32)}.json.`];
  const dirs = [paths.tmp, paths.queue, paths.receipts];
  try { dirs.push(ownerInbox(root, scope)); } catch {}
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) if (prefixes.some((p) => name.startsWith(p)) && /\.(?:new|tmp)$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

// Idempotent and resumable: any step can be repeated after a kill, in any order, and the result is the same.
function finishRedaction(root, paths, tomb) {
  const key = commandKey(tomb);
  const stamp = tomb.withdrawn_at;
  let inbox = null;
  try { inbox = ownerInbox(root, tomb.scope); } catch {}
  const candidatePath = inbox && path.join(inbox, `write-candidate-${key.slice(0, 32)}.json`);
  const candidate = candidatePath && safeReadJson(candidatePath, inbox, 'routed candidate');
  if (candidate && candidate.status !== 'withdrawn') {
    replaceJson(candidatePath, {
      schema_version: candidate.schema_version, provider: candidate.provider, canonical_owner: candidate.canonical_owner, canonical_layer: candidate.canonical_layer,
      status: 'withdrawn', request_fingerprint: tomb.request_fingerprint, idempotency_key: tomb.idempotency_key, scope: tomb.scope, operation: candidate.operation,
      candidate: { candidate_kind: candidate.candidate?.candidate_kind ?? LEARNING_KIND, redacted: true }, requested_by: candidate.requested_by,
      promotion_occurred: false, redacted: true, withdrawn_at: stamp,
    });
  }
  const commandPath = path.join(paths.queue, `${key}.json`);
  const command = safeReadJson(commandPath, paths.queue, 'queued write command');
  if (command && command.status !== 'withdrawn') {
    replaceJson(commandPath, {
      schema_version: command.schema_version, provider: command.provider, status: 'withdrawn', command_id: command.command_id,
      request_fingerprint: tomb.request_fingerprint, scope: tomb.scope, idempotency_key: tomb.idempotency_key, redacted: true, withdrawn_at: stamp,
    });
  }
  const receiptPath = path.join(paths.receipts, `${key}.json`);
  const receipt = safeReadJson(receiptPath, paths.receipts, 'write command receipt');
  if (receipt && receipt.status !== 'withdrawn') {
    replaceJson(receiptPath, { ...receipt, status: 'withdrawn', result: { queue_state: 'withdrawn', canonical_handler_dispatched: Boolean(candidate), redacted: true }, withdrawn_at: stamp });
  }
  sweepTemps(root, paths, key, tomb.scope);
}

// Payloads of operations that died between a private name and its final one, long after any live writer could be using them.
function sweepOrphanTemps(paths) {
  let names = [];
  try { names = fs.readdirSync(paths.tmp); } catch { return; }
  for (const name of names) {
    try {
      const file = path.join(paths.tmp, name);
      if (name.startsWith('.') && name.endsWith('.new') && Date.now() - fs.statSync(file).mtimeMs > 10 * 60 * 1000) fs.rmSync(file, { force: true });
    } catch {}
  }
}

function existingResult(paths, key, request) {
  const commandPath = path.join(paths.queue, `${key}.json`);
  const receiptPath = path.join(paths.receipts, `${key}.json`);
  const existingCommand = safeReadJson(commandPath, paths.queue, 'existing write command');
  const existingReceipt = safeReadJson(receiptPath, paths.receipts, 'existing write command receipt');
  if (!existingCommand && !existingReceipt) return null;
  if (!existingCommand || !existingReceipt) {
    // A process died between the two creations. The surviving half must still be bound to exactly this request; then the
    // missing half is recreated from the same request (see enqueueWriteCommand) instead of leaving the key unusable forever.
    const bound = existingCommand ? existingCommand.request?.request_fingerprint : existingReceipt.request_fingerprint;
    if (bound !== request.request_fingerprint) fail('idempotency key is already bound to a different write command', 5);
    return null;
  }
  const storedRequest = existingCommand.request && typeof existingCommand.request === 'object'
    ? existingCommand.request
    : null;
  if (
    !storedRequest
    || storedRequest.request_fingerprint !== request.request_fingerprint
    || storedRequest.scope !== request.scope
    || storedRequest.idempotency_key !== request.idempotency_key
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
  const permission = evaluatePermission(root, normalized, 'write-command.enqueue', 'write_local_reversible');

  const paths = runtimePaths(root);
  const key = commandKey(normalized);
  sweepOrphanTemps(paths);
  const tomb = readTombstone(paths, key);
  if (tomb) {
    if (tomb.request_fingerprint !== normalized.request_fingerprint) fail('idempotency key is already bound to a different write command', 5);
    finishRedaction(root, paths, tomb);
    return withdrawnResult(tomb);
  }
  const replay = existingResult(paths, key, normalized);
  if (replay) return replay;

  const priorCommand = safeReadJson(path.join(paths.queue, `${key}.json`), paths.queue, 'existing write command');
  const priorReceipt = safeReadJson(path.join(paths.receipts, `${key}.json`), paths.receipts, 'existing write command receipt');
  const queuedAt = priorCommand?.queued_at ?? priorReceipt?.queued_at ?? new Date().toISOString();
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

  if (!priorCommand) {
    try {
      writeExclusiveJson(commandPath, commandRecord, paths.tmp);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const raced = existingResult(paths, key, normalized);
        if (raced) return raced;
      } else throw error;
    }
  }

  if (!priorReceipt) {
    try {
      writeExclusiveJson(receiptPath, receipt, paths.tmp);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const raced = existingResult(paths, key, normalized);
        if (raced) return raced;
      } else throw error; // the command stays: the next attempt completes it from the same request
    }
  }

  return { ...receipt, replayed: Boolean(priorCommand || priorReceipt) };
}


function candidatePayload(request) {
  if (request.operation !== 'candidate.route') {
    fail(`no canonical OS-owned handler is registered for operation: ${request.operation}`, 7);
  }
  const parameters = request.parameters;
  const allowed = new Set(['candidate_kind', 'summary', 'refs']);
  for (const key of Object.keys(parameters)) {
    if (!allowed.has(key)) fail(`candidate.route parameter is not supported: ${key}`, 7);
  }
  if (typeof parameters.candidate_kind !== 'string' || !parameters.candidate_kind.trim() ||
      parameters.candidate_kind.length > 128 || parameters.candidate_kind.includes('\0')) {
    fail('candidate.route candidate_kind must be a bounded non-empty string', 7);
  }
  if (typeof parameters.summary !== 'string' || !parameters.summary.trim() ||
      parameters.summary.length > 16 * 1024 || parameters.summary.includes('\0')) {
    fail('candidate.route summary must be a bounded non-empty string', 7);
  }
  let refs = [];
  if (parameters.refs !== undefined) {
    if (!Array.isArray(parameters.refs) || parameters.refs.length > 256 ||
        parameters.refs.some(item => typeof item !== 'string' || !item || item.length > 2048 || item.includes('\0'))) {
      fail('candidate.route refs must be a bounded string array', 7);
    }
    refs = [...parameters.refs];
  }
  return {
    candidate_kind: parameters.candidate_kind,
    summary: parameters.summary,
    refs,
  };
}

function ownerInbox(root, scope) {
  if (scope === 'operator') {
    const dir = path.join(root, 'operator', 'inbox');
    return assertSafeDirectory(dir, path.join(root, 'operator'), 'operator inbox', { create: true });
  }
  const workspaceId = scope.slice('workspace:'.length);
  const workspace = path.join(root, 'workspaces', workspaceId);
  if (!fs.existsSync(workspace) || fs.lstatSync(workspace).isSymbolicLink() || !fs.statSync(workspace).isDirectory()) {
    fail('workspace owner root is unavailable', 4);
  }
  return assertSafeDirectory(path.join(workspace, 'inbox'), workspace, 'workspace inbox', { create: true });
}

function completedResult(paths, key, request) {
  const receiptPath = path.join(paths.receipts, `${key}.json`);
  const receipt = safeReadJson(receiptPath, paths.receipts, 'write command receipt');
  if (!receipt) return null;
  if (receipt.request_fingerprint !== request.request_fingerprint) fail('write command receipt fingerprint mismatch', 4);
  return receipt.status === 'completed' ? { ...receipt, replayed: true } : null;
}

export function dispatchWriteCommand({ osRoot = process.cwd(), request }) {
  const root = validateRoot(osRoot);
  const normalized = validateWriteCommandRequest(request);
  const paths = runtimePaths(root);
  const key = commandKey(normalized);
  const tomb = readTombstone(paths, key);
  if (tomb) {
    if (tomb.request_fingerprint !== normalized.request_fingerprint) fail('idempotency key is already bound to a different write command', 5);
    finishRedaction(root, paths, tomb);
    return withdrawnResult(tomb);
  }
  const replay = completedResult(paths, key, normalized);
  const commandPath = path.join(paths.queue, `${key}.json`);
  const receiptPath = path.join(paths.receipts, `${key}.json`);
  if (replay) {
    // The receipt is the commit point. A process killed after it and before the command record was updated leaves that record
    // 'queued'; finish it here so both agree.
    const stale = safeReadJson(commandPath, paths.queue, 'queued write command');
    if (stale && stale.status !== 'completed') replaceJson(commandPath, { ...stale, status: 'completed', completed_at: replay.completed_at, canonical_effect_occurred: true });
    return replay;
  }
  const commandRecord = safeReadJson(commandPath, paths.queue, 'queued write command');
  const receipt = safeReadJson(receiptPath, paths.receipts, 'queued write command receipt');
  if (!commandRecord || !receipt) fail('write command must be enqueued before dispatch', 7);
  if (commandRecord.request?.request_fingerprint !== normalized.request_fingerprint ||
      receipt.request_fingerprint !== normalized.request_fingerprint) {
    fail('queued write command does not match the dispatch request', 4);
  }

  const candidate = candidatePayload(normalized);

  // Final-edge authorization is deliberately stronger than enqueue authorization.
  // The inbox write is canonical OS-owned state, so current policy is re-evaluated now.
  const effectPermission = evaluatePermission(
    root,
    normalized,
    'write-command.dispatch',
    'modify_canonical_state',
  );

  const inbox = ownerInbox(root, normalized.scope);
  const candidatePath = path.join(inbox, `write-candidate-${key.slice(0, 32)}.json`);
  const existing = safeReadJson(candidatePath, inbox, 'existing routed candidate');
  const receivedAt = existing?.received_at || new Date().toISOString();
  if (existing && existing.request_fingerprint !== normalized.request_fingerprint) {
    fail('canonical inbox idempotency record is bound to a different request', 5);
  }

  const routed = {
    schema_version: WRITE_COMMAND_SCHEMA_VERSION,
    provider: WRITE_COMMAND_PROVIDER,
    canonical_owner: 'ai-verse-os',
    canonical_layer: 'inbox',
    status: 'unclassified',
    request_id: normalized.request_id,
    request_fingerprint: normalized.request_fingerprint,
    idempotency_key: normalized.idempotency_key,
    scope: normalized.scope,
    operation: normalized.operation,
    candidate,
    requested_by: normalized.requested_by,
    reason: normalized.reason,
    provenance: normalized.provenance,
    received_at: receivedAt,
    promotion_occurred: false,
  };

  if (!existing) writeExclusiveJson(candidatePath, routed, paths.tmp);
  // A withdrawal that landed while the candidate was being created: the candidate is redacted and nothing is completed.
  const late = readTombstone(paths, key);
  if (late) {
    finishRedaction(root, paths, late);
    return withdrawnResult(late);
  }

  const completedAt = new Date().toISOString();
  const completed = {
    ...receipt,
    status: 'completed',
    effect_occurred: true,
    canonical_effect_occurred: true,
    completed_at: completedAt,
    effect_permission: {
      decision: effectPermission.decision,
      source: effectPermission.source,
      reason: effectPermission.reason,
      request_fingerprint: effectPermission.request_fingerprint,
      scope: effectPermission.scope,
      action_class: effectPermission.action_class,
    },
    result: {
      queue_state: 'completed',
      canonical_handler_dispatched: true,
      canonical_owner: 'ai-verse-os',
      canonical_layer: 'inbox',
      path: path.relative(root, candidatePath).split(path.sep).join('/'),
      classification_state: 'unclassified',
      promotion_occurred: false,
    },
  };
  replaceJson(receiptPath, completed);
  replaceJson(commandPath, {
    ...commandRecord,
    status: 'completed',
    completed_at: completedAt,
    canonical_effect_occurred: true,
  });
  return { ...completed, replayed: false };
}

// Withdraws a proposal this pipeline routed. Restricted to the learning pipeline's own proposals that are still plain, unclassified,
// unpromoted inbox candidates; a record of any other owner or kind, or one that has been classified or promoted, is refused untouched.
// Idempotent: running it again (after a kill, say) finishes the redaction. Returns { state: 'withdrawn' | 'absent' }; `absent` means
// no command was ever created under that key (only stray temporary copies, if any, are removed).
export function withdrawCandidate({ osRoot = process.cwd(), scope, idempotency_key: idempotencyKey }) {
  const root = validateRoot(osRoot);
  if (!SCOPE.test(scope) || typeof idempotencyKey !== 'string' || !idempotencyKey) fail('withdraw needs a scope and an idempotency key', 7);
  const paths = runtimePaths(root);
  const key = commandKey({ scope, idempotency_key: idempotencyKey });
  const already = readTombstone(paths, key);
  if (already) {
    finishRedaction(root, paths, already);
    return { state: 'withdrawn' };
  }
  const commandPath = path.join(paths.queue, `${key}.json`);
  const command = safeReadJson(commandPath, paths.queue, 'queued write command');
  const receipt = safeReadJson(path.join(paths.receipts, `${key}.json`), paths.receipts, 'write command receipt');
  if (!command && !receipt) {
    sweepTemps(root, paths, key, scope);
    return { state: 'absent' };
  }
  const request = command?.request;
  if (!request || request.requested_by !== LEARNING_REQUESTER || request.operation !== 'candidate.route' || request.parameters?.candidate_kind !== LEARNING_KIND || request.scope !== scope) {
    fail('only a learning proposal can be withdrawn by the learning pipeline', 6);
  }
  const inbox = ownerInbox(root, scope);
  const candidate = safeReadJson(path.join(inbox, `write-candidate-${key.slice(0, 32)}.json`), inbox, 'routed candidate');
  if (candidate && (candidate.request_fingerprint !== request.request_fingerprint || candidate.status !== 'unclassified' || candidate.promotion_occurred !== false || candidate.requested_by !== LEARNING_REQUESTER)) {
    fail('the routed candidate is not an eligible learning proposal', 6);
  }
  evaluatePermission(root, request, 'write-command.withdraw', 'modify_canonical_state');
  const tomb = {
    schema_version: WRITE_COMMAND_SCHEMA_VERSION, provider: WRITE_COMMAND_PROVIDER, command_id: command.command_id, request_fingerprint: request.request_fingerprint,
    scope, idempotency_key: idempotencyKey, requested_by: LEARNING_REQUESTER, withdrawn_at: new Date().toISOString(),
  };
  try {
    writeExclusiveJson(path.join(paths.withdrawn, `${key}.json`), tomb, paths.tmp);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  finishRedaction(root, paths, readTombstone(paths, key));
  return { state: 'withdrawn' };
}

export function submitWriteCommand({ osRoot = process.cwd(), request }) {
  const queued = enqueueWriteCommand({ osRoot, request });
  if (queued.status === 'withdrawn') return queued;
  return dispatchWriteCommand({ osRoot, request });
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
      process.stdout.write('Usage: node scripts/write-command.mjs <enqueue|dispatch|submit> [--root <ai-verse-os-root>] < request.json\n');
      process.exit(0);
    }
    fail(`unknown option: ${token}`);
  }
  if (!['enqueue', 'dispatch', 'submit'].includes(command)) fail(`unknown command: ${command}`);
  return { root, command };
}

async function main() {
  const { root, command } = parse(process.argv.slice(2));
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
  const result = command === 'enqueue'
    ? enqueueWriteCommand({ osRoot: root, request })
    : command === 'dispatch'
      ? dispatchWriteCommand({ osRoot: root, request })
      : submitWriteCommand({ osRoot: root, request });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`write-command: ${error.message}\n`);
    process.exitCode = Number(error?.exitCode ?? 2);
  });
}
