#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { capabilityConfiguration } from './capability-configuration.mjs';
import { existsEntry, parseCapabilityJson, readCapabilityJson } from './capability-json.mjs';

try {
  if (process.argv.length !== 4 || process.argv[2] !== '--root') throw new Error('--root is required');
  const root = fs.realpathSync(process.argv[3]);
  if (!fs.statSync(path.join(root, 'AI-VERSE.yaml')).isFile()) throw new Error('not an OS root');
  const input = fs.readFileSync(0);
  if (input.length > 32768) throw new Error('configuration request too large');
  const request = parseCapabilityJson(new TextDecoder('utf-8', { fatal: true }).decode(input));
  if (!request || Array.isArray(request) || typeof request !== 'object' || Object.keys(request).some(key => !['operation', 'skills_root', 'local_skills_root', 'skills_entrypoint', 'expected'].includes(key))) throw new Error('invalid configuration request');
  const directory = path.join(root, '.aiverse'), file = path.join(directory, 'capability-providers.json');
  const digest = () => existsEntry(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : 'absent';
  const current = capabilityConfiguration(root);
  if (request.operation === 'read') {
    process.stdout.write(JSON.stringify(current) + '\n');
  } else if (['plan', 'apply'].includes(request.operation)) {
    const proposed = { schema_version: 1, skills_root: request.skills_root, local_skills_root: request.local_skills_root };
    for (const key of ['skills_root', 'local_skills_root']) if (typeof proposed[key] !== 'string' || !path.isAbsolute(proposed[key]) || proposed[key].includes('\0')) throw new Error('configuration needs exact absolute provider roots');
    // Existing roots must remain fixed. Entrypoint refresh follows exact owner source updates.
    if (current.configured && (path.resolve(proposed.skills_root) !== current.skillsRoot || path.resolve(proposed.local_skills_root) !== current.localSkillsRoot)) throw new Error('existing provider roots need explicit reconciliation; nothing moved');
    if (request.skills_entrypoint != null) {
      const entry = request.skills_entrypoint;
      if (typeof entry !== 'string' || !path.isAbsolute(entry) || fs.lstatSync(entry).isSymbolicLink() || !fs.statSync(entry).isFile()) throw new Error('Skills entrypoint must be an exact regular owner file');
      proposed.skills_entrypoint = fs.realpathSync(entry);
    }
    const a = path.resolve(proposed.skills_root), b = path.resolve(proposed.local_skills_root);
    const inside = (x, y) => { const rel = path.relative(x, y); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
    if (inside(a,b) || inside(b,a)) throw new Error('managed and personal roots must be independent');
    if (existsEntry(directory) && fs.realpathSync(directory) !== directory) throw new Error('configuration directory is redirected');
    const expected = digest();
    if (request.operation === 'plan') process.stdout.write(JSON.stringify({ state: 'planned', expected, configuration: proposed }) + '\n');
    else {
      if (request.expected !== expected) throw new Error('configuration changed since preview');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const lock = `${file}.lock`, fd = fs.openSync(lock, 'wx', 0o600), temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        if (digest() !== expected) throw new Error('configuration changed since preview');
        const same = existsEntry(file) && JSON.stringify(readCapabilityJson(file,8192)) === JSON.stringify(proposed);
        if (!same) {
          const out = fs.openSync(temporary, 'wx', 0o600);
          try { fs.writeFileSync(out, JSON.stringify(proposed, null, 2) + '\n'); fs.fsyncSync(out); } finally { fs.closeSync(out); }
          fs.renameSync(temporary, file);
        }
      } finally { fs.closeSync(fd); fs.unlinkSync(lock); if (existsEntry(temporary)) fs.unlinkSync(temporary); }
      process.stdout.write(JSON.stringify({ state: 'configured', configuration: capabilityConfiguration(root) }) + '\n');
    }
  } else throw new Error('unsupported configuration operation');
} catch (error) { process.stderr.write(`capability-configuration: ${error.message}\n`); process.exitCode = 2; }
