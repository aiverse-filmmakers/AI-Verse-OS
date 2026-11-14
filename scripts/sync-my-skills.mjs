#!/usr/bin/env node
// Lists the member's own skills ("My skills") in this OS folder's Claude and Codex skill folders, so chats
// pick them by themselves. Copies only. Replaces only copies this script made before, removes copies of
// skills that were deleted, and never touches OS built ins, library skills or any other folder.
// Usage: node scripts/sync-my-skills.mjs [--json]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilityConfiguration } from './capability-configuration.mjs';

export const STATE_REL = '.aiverse/my-skills-listing.json';
const TARGETS = ['.claude/skills', '.agents/skills'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_FILES = 200;
const MAX_BYTES = 10 * 1024 * 1024;

function treeDigest(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(current, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else if (entry.isFile()) { hash.update(r); hash.update('\0'); hash.update(fs.readFileSync(abs)); hash.update('\0'); }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return hash.digest('hex');
}

function copyTree(source, target) {
  let files = 0, bytes = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const a = path.join(from, entry.name), b = path.join(to, entry.name);
      if (entry.isDirectory()) walk(a, b);
      else if (entry.isFile()) {
        files += 1; bytes += fs.statSync(a).size;
        if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error('skill is too large to list for chats');
        fs.copyFileSync(a, b);
      }
    }
  };
  walk(source, target);
}

function mySkills(localRoot) {
  if (!fs.existsSync(localRoot)) return [];
  return fs.readdirSync(localRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && NAME.test(entry.name))
    .filter((entry) => fs.existsSync(path.join(localRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

export function syncMySkills({ osRoot, localSkillsRoot } = {}) {
  const root = fs.realpathSync(osRoot);
  const local = localSkillsRoot ?? capabilityConfiguration(root).localSkillsRoot;
  const statePath = path.join(root, STATE_REL);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { schema_version: 1, listed: {} };
  if (state.schema_version !== 1 || typeof state.listed !== 'object') throw new Error('my skills listing record is unreadable; refusing to guess');
  const wanted = mySkills(local);
  const report = { listed: [], updated: [], removed: [], skipped: [] };
  const next = { schema_version: 1, listed: {} };
  for (const rel of TARGETS) {
    const folder = path.join(root, rel);
    if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) throw new Error(`${rel} is redirected; refusing to write`);
    fs.mkdirSync(folder, { recursive: true });
    const before = state.listed[rel] ?? {};
    const after = {};
    for (const name of wanted) {
      const target = path.join(folder, name);
      const source = path.join(local, name);
      const digest = treeDigest(source);
      const mine = Object.hasOwn(before, name);
      if (fs.existsSync(target) && !mine) { report.skipped.push(`${rel}/${name}: a different skill with this name is already there`); continue; }
      if (mine && fs.existsSync(target) && treeDigest(target) !== before[name]) { report.skipped.push(`${rel}/${name}: changed by hand, left alone`); after[name] = before[name]; continue; }
      if (mine && before[name] === digest && fs.existsSync(target)) { after[name] = digest; continue; }
      fs.rmSync(target, { recursive: true, force: true });
      copyTree(source, target);
      after[name] = digest;
      (mine ? report.updated : report.listed).push(`${rel}/${name}`);
    }
    for (const name of Object.keys(before)) {
      if (wanted.includes(name)) continue;
      const target = path.join(folder, name);
      if (fs.existsSync(target) && treeDigest(target) === before[name]) {
        fs.rmSync(target, { recursive: true, force: true });
        report.removed.push(`${rel}/${name}`);
      } else if (fs.existsSync(target)) {
        report.skipped.push(`${rel}/${name}: changed by hand, left alone`);
      }
    }
    next.listed[rel] = after;
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(`${statePath}.tmp`, statePath);
  return { my_skills: wanted.length, ...report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const osRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = syncMySkills({ osRoot });
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Listed ${result.my_skills} of my skills for Claude and Codex.\n`);
    for (const line of result.skipped) process.stdout.write(`  Not listed: ${line}\n`);
  }
}
