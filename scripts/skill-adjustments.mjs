import fs from 'node:fs';
import path from 'node:path';
import { existsEntry } from './capability-json.mjs';
import { assertNoRawSecrets } from './capability-bindings.mjs';

// Per project notes for a skill. One plain text file per skill (or shared topic, for example "marketing")
// inside the project's own context folder. The skill itself is never changed.
export const ADJUSTMENT_CONTRACT = 'aiverse-skill-adjustments-v1';
export const ADJUSTMENT_RULE = "Where these project adjustments disagree with the skill's instructions, follow the project adjustments.";
export const SAVED_MESSAGE = 'Saved for this project only. Want this in the skill itself too?';
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const MAX_BYTES = 16384;

function projectDirectory(osRoot, scope) {
  const id = typeof scope === 'string' && scope.startsWith('workspace:') ? scope.slice(10) : '';
  if (!SEGMENT.test(id)) throw new Error('project adjustments belong to one project; choose a workspace scope');
  const root = fs.realpathSync(osRoot);
  const base = path.join(root, 'workspaces', id);
  if (!fs.existsSync(path.join(base, 'WORKSPACE.yaml')) || fs.realpathSync(base) !== base) throw new Error('untrusted project workspace');
  const context = path.join(base, 'context');
  if (existsEntry(context) && fs.realpathSync(context) !== context) throw new Error('project context is redirected');
  const directory = path.join(context, 'skill-adjustments');
  if (existsEntry(directory) && (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory)) throw new Error('adjustments folder is redirected');
  return directory;
}

// "aiverse-skills:copywriting" becomes "aiverse-skills--copywriting". A shared topic is a plain name such as "marketing".
export function adjustmentName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('name the skill or topic these adjustments belong to');
  const name = value.trim().toLowerCase().replace(/:/g, '--');
  if (name.length > 120 || !SEGMENT.test(name)) throw new Error('invalid skill or topic name');
  return name;
}

function fileFor(osRoot, scope, value) {
  const directory = projectDirectory(osRoot, scope);
  return { directory, name: adjustmentName(value), file: path.join(directory, `${adjustmentName(value)}.md`) };
}

function readText(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || fs.realpathSync(file) !== file || stat.size > MAX_BYTES) throw new Error('adjustments must be a contained bounded regular file');
  return fs.readFileSync(file, 'utf8');
}

export function readAdjustment(osRoot, scope, value) {
  const { name, file } = fileFor(osRoot, scope, value);
  return { contract: ADJUSTMENT_CONTRACT, scope, name, text: existsEntry(file) ? readText(file) : null, rule: ADJUSTMENT_RULE, permission_granted: false };
}

export function listAdjustments(osRoot, scope) {
  const directory = projectDirectory(osRoot, scope);
  const names = existsEntry(directory)
    ? fs.readdirSync(directory).filter(entry => entry.endsWith('.md') && SEGMENT.test(entry.slice(0, -3))).map(entry => entry.slice(0, -3)).sort()
    : [];
  return { contract: ADJUSTMENT_CONTRACT, scope, adjustments: names };
}

export function saveAdjustment({ osRoot, scope, name, text }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('adjustments need some text');
  if (text.includes('\u0000')) throw new Error('adjustments must be plain text');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('adjustments are too long; keep them under 16 KB');
  assertNoRawSecrets(text);
  if (/\b(password|passcode|api[_ -]?key|secret|token)\b\s*[:=]\s*\S+/i.test(text)) throw new Error('never store passwords, keys or tokens in adjustments; use a Connection reference');
  const target = fileFor(osRoot, scope, name);
  fs.mkdirSync(target.directory, { recursive: true, mode: 0o700 });
  const lock = `${target.file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error('these adjustments are being saved elsewhere; try again'); }
  const temporary = `${target.file}.${process.pid}.tmp`;
  try {
    const output = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(output, `${text.trim()}\n`); fs.fsyncSync(output); }
    finally { fs.closeSync(output); }
    fs.renameSync(temporary, target.file);
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return { contract: ADJUSTMENT_CONTRACT, state: 'saved', scope, name: target.name, applies_to: 'this project only', message: SAVED_MESSAGE, permission_granted: false };
}

export function removeAdjustment({ osRoot, scope, name }) {
  const target = fileFor(osRoot, scope, name);
  const existed = existsEntry(target.file);
  if (existed) fs.unlinkSync(target.file);
  return { contract: ADJUSTMENT_CONTRACT, state: existed ? 'removed' : 'absent', scope, name: target.name, permission_granted: false };
}

// Used by the resolver: nothing for the operator scope, never throws into skill selection.
export function projectAdjustmentsFor(osRoot, scope, qualifiedId) {
  if (typeof scope !== 'string' || !scope.startsWith('workspace:')) return {};
  try {
    const found = readAdjustment(osRoot, scope, qualifiedId);
    return found.text === null ? {} : { project_adjustments: { scope, name: found.name, text: found.text, rule: ADJUSTMENT_RULE, permission_granted: false } };
  } catch (error) {
    return { project_adjustments: { scope, status: 'unreadable', reason: error.message, permission_granted: false } };
  }
}
