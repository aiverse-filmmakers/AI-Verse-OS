#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GENERATOR_ID = 'ai-verse-os-adapter-sync-v1';
const STATE_SCHEMA = 1;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_REL = 'system/capabilities';
const TARGET_RELS = ['.claude/skills', '.agents/skills'];
const STATE_REL = 'runtime/adapters/os-owned.json';

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function inside(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function assertLexicalInside(parent, candidate, label) {
  if (!inside(parent, candidate)) {
    throw new Error(`${label} escapes its authorized root: ${candidate}`);
  }
}

function assertNoSymlinkPath(root, candidate, label) {
  assertLexicalInside(root, candidate, label);
  const rel = path.relative(root, candidate);
  if (!rel) return;
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link and will not be modified: ${current}`);
    }
  }
}

function parseArgs(argv) {
  const selected = [];
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') {
      if (i + 1 >= argv.length) throw new Error('--root requires a path');
      root = path.resolve(argv[++i]);
    } else if (token.startsWith('-')) {
      throw new Error(`unknown option: ${token}`);
    } else {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(token)) {
        throw new Error(`invalid capability name: ${token}`);
      }
      selected.push(token);
    }
  }
  return { root, selected: [...new Set(selected)] };
}

function walkFiles(root, current = root, files = []) {
  assertNoSymlinkPath(root, current, 'canonical capability path');
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`canonical capabilities must not contain symbolic links: ${absolute}`);
    }
    if (entry.isDirectory()) {
      walkFiles(root, absolute, files);
    } else if (entry.isFile()) {
      files.push(absolute);
    } else {
      throw new Error(`unsupported canonical capability entry: ${absolute}`);
    }
  }
  return files;
}

function readState(root) {
  const statePath = path.join(root, STATE_REL);
  if (!fs.existsSync(statePath)) {
    return {
      schema_version: STATE_SCHEMA,
      generator: GENERATOR_ID,
      canonical_root: CANONICAL_REL,
      files: {},
    };
  }
  assertNoSymlinkPath(root, statePath, 'adapter ownership state');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new Error(`adapter ownership state is unreadable; refusing to guess ownership: ${error.message}`);
  }
  if (
    !data ||
    data.schema_version !== STATE_SCHEMA ||
    data.generator !== GENERATOR_ID ||
    data.canonical_root !== CANONICAL_REL ||
    !data.files ||
    typeof data.files !== 'object' ||
    Array.isArray(data.files)
  ) {
    throw new Error('adapter ownership state is incompatible or malformed; refusing to guess ownership');
  }
  return data;
}

function writeState(root, state) {
  const statePath = path.join(root, STATE_REL);
  assertLexicalInside(root, statePath, 'adapter ownership state');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, statePath);
}

function capabilityFromSource(sourceRel) {
  if (!sourceRel.startsWith(`${CANONICAL_REL}/`)) return null;
  return sourceRel.slice(CANONICAL_REL.length + 1).split('/')[0] || null;
}

function targetRootFor(root, targetRel) {
  for (const runtimeRel of TARGET_RELS) {
    if (targetRel === runtimeRel || targetRel.startsWith(`${runtimeRel}/`)) {
      return path.join(root, runtimeRel);
    }
  }
  return null;
}

function removeEmptyParents(start, stop) {
  let current = start;
  while (inside(stop, current) && current !== stop) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    if (fs.readdirSync(current).length !== 0) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function writeGeneratedFile(root, sourcePath, targetPath) {
  assertNoSymlinkPath(root, targetPath, 'runtime adapter target');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const bytes = fs.readFileSync(sourcePath);
  fs.writeFileSync(targetPath, bytes);
  const mode = fs.statSync(sourcePath).mode & 0o777;
  fs.chmodSync(targetPath, mode);
  return sha256(bytes);
}

function sync() {
  const { root, selected } = parseArgs(process.argv.slice(2));
  const canonicalRoot = path.join(root, CANONICAL_REL);
  if (!fs.existsSync(canonicalRoot) || !fs.statSync(canonicalRoot).isDirectory()) {
    throw new Error(`missing canonical capability directory: ${canonicalRoot}`);
  }
  assertNoSymlinkPath(root, canonicalRoot, 'canonical capability root');

  const available = fs.readdirSync(canonicalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  const capabilities = selected.length ? selected : available;
  for (const capability of capabilities) {
    const source = path.join(canonicalRoot, capability);
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      throw new Error(`unknown canonical capability: ${capability}`);
    }
    assertNoSymlinkPath(canonicalRoot, source, `canonical capability ${capability}`);
  }

  const selectedSet = new Set(capabilities);
  const fullSync = selected.length === 0;
  const state = readState(root);
  const conflicts = [];
  let generated = 0;
  let adopted = 0;
  let removed = 0;
  let unchanged = 0;

  const canonicalFiles = walkFiles(canonicalRoot)
    .map((absolute) => ({
      absolute,
      rel: toPosix(path.relative(canonicalRoot, absolute)),
    }))
    .filter(({ rel }) => selectedSet.has(rel.split('/')[0]));
  const activeSources = new Set();

  for (const { absolute: sourcePath, rel } of canonicalFiles) {
    const sourceRel = `${CANONICAL_REL}/${rel}`;
    const sourceBytes = fs.readFileSync(sourcePath);
    const sourceDigest = sha256(sourceBytes);
    activeSources.add(sourceRel);

    for (const runtimeRel of TARGET_RELS) {
      const runtimeRoot = path.join(root, runtimeRel);
      const targetPath = path.join(runtimeRoot, ...rel.split('/'));
      const targetRel = `${runtimeRel}/${rel}`;
      assertLexicalInside(runtimeRoot, targetPath, 'runtime adapter target');
      assertNoSymlinkPath(root, targetPath, 'runtime adapter target');

      const prior = state.files[targetRel];
      if (!fs.existsSync(targetPath)) {
        const digest = writeGeneratedFile(root, sourcePath, targetPath);
        state.files[targetRel] = { source: sourceRel, last_generated_sha256: digest };
        generated += 1;
        continue;
      }
      const targetStat = fs.lstatSync(targetPath);
      if (!targetStat.isFile()) {
        conflicts.push(`${targetRel}: existing target is not a regular file`);
        continue;
      }
      const targetDigest = sha256(fs.readFileSync(targetPath));

      if (!prior) {
        if (targetDigest === sourceDigest) {
          state.files[targetRel] = { source: sourceRel, last_generated_sha256: sourceDigest };
          adopted += 1;
        } else {
          conflicts.push(`${targetRel}: existing unowned file differs from canonical source`);
        }
        continue;
      }

      if (prior.source !== sourceRel || typeof prior.last_generated_sha256 !== 'string') {
        conflicts.push(`${targetRel}: ownership record does not match canonical source`);
        continue;
      }

      if (targetDigest === sourceDigest) {
        state.files[targetRel] = { source: sourceRel, last_generated_sha256: sourceDigest };
        unchanged += 1;
      } else if (targetDigest === prior.last_generated_sha256) {
        const digest = writeGeneratedFile(root, sourcePath, targetPath);
        state.files[targetRel] = { source: sourceRel, last_generated_sha256: digest };
        generated += 1;
      } else {
        conflicts.push(`${targetRel}: locally modified since the last OS generation; preserved`);
      }
    }
  }

  for (const [targetRel, prior] of Object.entries({ ...state.files })) {
    const capability = capabilityFromSource(prior?.source || '');
    if (!capability) {
      throw new Error(`invalid ownership record source for ${targetRel}`);
    }
    if (!fullSync && !selectedSet.has(capability)) continue;
    if (activeSources.has(prior.source)) continue;

    const runtimeRoot = targetRootFor(root, targetRel);
    if (!runtimeRoot) throw new Error(`invalid ownership target outside runtime adapter roots: ${targetRel}`);
    const targetPath = path.join(root, ...targetRel.split('/'));
    assertLexicalInside(runtimeRoot, targetPath, 'stale runtime adapter target');
    assertNoSymlinkPath(root, targetPath, 'stale runtime adapter target');

    if (!fs.existsSync(targetPath)) {
      delete state.files[targetRel];
      continue;
    }
    const stat = fs.lstatSync(targetPath);
    if (!stat.isFile()) {
      conflicts.push(`${targetRel}: stale owned target is no longer a regular file; preserved`);
      delete state.files[targetRel];
      continue;
    }
    const digest = sha256(fs.readFileSync(targetPath));
    if (digest === prior.last_generated_sha256) {
      fs.unlinkSync(targetPath);
      removeEmptyParents(path.dirname(targetPath), runtimeRoot);
      delete state.files[targetRel];
      removed += 1;
    } else {
      conflicts.push(`${targetRel}: canonical source was removed but local target changed; preserved and ownership released`);
      delete state.files[targetRel];
    }
  }

  writeState(root, state);

  process.stdout.write(
    `Adapter sync: ${generated} generated, ${adopted} adopted, ${unchanged} unchanged, ${removed} removed, ${conflicts.length} conflict(s).\n`,
  );
  if (conflicts.length) {
    for (const conflict of conflicts) process.stderr.write(`CONFLICT ${conflict}\n`);
    process.stderr.write('No conflicting or unowned adapter file was overwritten.\n');
    process.exitCode = 2;
  } else {
    process.stdout.write('Claude and Codex OS adapters are synchronized from system/capabilities/.\n');
  }
}

try {
  sync();
} catch (error) {
  process.stderr.write(`Adapter sync failed: ${error.message}\n`);
  process.exitCode = 1;
}
