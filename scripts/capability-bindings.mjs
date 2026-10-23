import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsEntry, readCapabilityJson } from './capability-json.mjs';

export const BINDING_CONTRACT = 'aiverse-skill-bindings-v1';
const ID = /^(?:os|local|aiverse-skills):[a-z0-9][a-z0-9-]*$|^(?:workspace|external):[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const HEX = /^[a-f0-9]{64}$/;
const EMPTY = () => ({ contract: BINDING_CONTRACT, preferences: {}, skills: {} });

export function bindingPath(osRoot, scope) {
  const root = fs.realpathSync(osRoot);
  let base;
  if (scope === 'operator') base = path.join(root, 'operator');
  else {
    const id = typeof scope === 'string' && scope.startsWith('workspace:') ? scope.slice(10) : '';
    if (!SEGMENT.test(id)) throw new Error('invalid binding scope');
    base = path.join(root, 'workspaces', id);
    if (!fs.existsSync(path.join(base, 'WORKSPACE.yaml')) || fs.realpathSync(base) !== base) throw new Error('untrusted binding workspace');
  }
  if (existsEntry(base) && fs.realpathSync(base) !== base) throw new Error('binding scope is redirected');
  const context = path.join(base, 'context');
  if (existsEntry(context) && fs.realpathSync(context) !== context) throw new Error('binding context is redirected');
  return path.join(context, 'skill-bindings.json');
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }

export function validateInputs(inputs) {
  if (!record(inputs) || Buffer.byteLength(JSON.stringify(inputs)) > 8192) throw new Error('skill inputs must be a bounded object');
  const walk = (value, depth = 0) => {
    if (depth > 6) throw new Error('skill inputs are nested too deeply');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite skill input');
    if (typeof value === 'string') {
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9_]{30,}|\bxox[baprs]-[A-Za-z0-9-]{20,}|\bAKIA[0-9A-Z]{16}\b/.test(value)) throw new Error('raw secret material is forbidden in skill inputs');
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (/^(password|secret|token|api[_-]?key|credential|private[_-]?key)$/i.test(key)) throw new Error('store a Connection reference instead of raw credentials');
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('unsafe skill input key');
        walk(item, depth + 1);
      }
    } else if (!['number', 'boolean'].includes(typeof value) && value !== null) throw new Error('unsupported skill input value');
  };
  walk(inputs);
  return inputs;
}

export function readBindings(osRoot, scope) {
  const file = bindingPath(osRoot, scope);
  if (!existsEntry(file)) return EMPTY();
  if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file || !fs.statSync(file).isFile() || fs.statSync(file).size > 131072) {
    throw new Error('skill bindings must be a contained bounded regular file');
  }
  const data = readCapabilityJson(file, 131072);
  if (!record(data) || data.contract !== BINDING_CONTRACT || !record(data.preferences) || !record(data.skills) ||
      Object.keys(data).some(key => !['contract', 'preferences', 'skills'].includes(key))) throw new Error('invalid skill bindings');
  for (const [name, id] of Object.entries(data.preferences)) {
    if (!name || name.length > 100 || !ID.test(id) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new Error('invalid skill preference');
  }
  for (const [id, binding] of Object.entries(data.skills)) {
    if (!ID.test(id) || !record(binding) || Object.keys(binding).some(key => !['revision', 'inputs'].includes(key)) ||
        (binding.revision != null && !HEX.test(binding.revision))) throw new Error('invalid skill binding');
    validateInputs(binding.inputs ?? {});
  }
  return data;
}

export function bindingDigest(osRoot, scope) {
  const file = bindingPath(osRoot, scope);
  readBindings(osRoot, scope);
  return existsEntry(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent';
}

export function saveBinding({ osRoot, scope, id, alias = null, binding = {}, expectedDigest }) {
  if (!ID.test(id)) throw new Error('invalid selected skill identity');
  if (alias != null && (typeof alias !== 'string' || !alias.trim() || alias.length > 100 || ['__proto__', 'prototype', 'constructor'].includes(alias.trim().toLowerCase()))) throw new Error('invalid preference alias');
  if (!record(binding) || Object.keys(binding).some(key => !['revision', 'inputs'].includes(key)) ||
      (binding.revision != null && !HEX.test(binding.revision))) throw new Error('invalid skill binding');
  validateInputs(binding.inputs ?? {});
  const file = bindingPath(osRoot, scope);
  readBindings(osRoot, scope);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error('skill binding is locked; inspect interrupted operation before retry'); }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    if (bindingDigest(osRoot, scope) !== expectedDigest) throw new Error('skill bindings changed; preview again');
    const current = readBindings(osRoot, scope);
    if (alias) current.preferences[alias.trim().toLowerCase()] = id;
    current.skills[id] = { ...binding, inputs: binding.inputs ?? {} };
    if (Buffer.byteLength(JSON.stringify(current)) > 131072) throw new Error('skill binding capacity reached');
    const output = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(output, JSON.stringify(current, null, 2) + '\n'); fs.fsyncSync(output); }
    finally { fs.closeSync(output); }
    fs.renameSync(temporary, file);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { state: 'saved', id, scope, digest: bindingDigest(osRoot, scope), permission_granted: false };
}
