import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsEntry, readCapabilityJson } from './capability-json.mjs';

export function capabilityConfiguration(osRoot, overrides = {}) {
  const root = fs.realpathSync(osRoot);
  const file = path.join(root, '.aiverse', 'capability-providers.json');
  let stored = {};
  if (existsEntry(file)) {
    if (fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file || !fs.statSync(file).isFile() || fs.statSync(file).size > 8192) {
      throw new Error('installation capability configuration is redirected or oversized');
    }
    stored = readCapabilityJson(file, 8192);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.schema_version !== 1 || Object.keys(stored).some(key => !['schema_version', 'skills_root', 'local_skills_root'].includes(key))) {
      throw new Error('unsupported installation capability configuration');
    }
    for (const key of ['skills_root', 'local_skills_root']) {
      if (typeof stored[key] !== 'string' || !path.isAbsolute(stored[key]) || stored[key].includes('\0')) {
        throw new Error(`invalid configured ${key}`);
      }
    }
  }
  const result = {};
  for (const [key, argument, fallback] of [
    ['skills_root', 'skillsRoot', path.join(os.homedir(), '.aiverse/skills')],
    ['local_skills_root', 'localSkillsRoot', path.join(os.homedir(), '.aiverse/local-skills')],
  ]) {
    const supplied = overrides[argument];
    if (supplied != null && (typeof supplied !== 'string' || !supplied.trim() || supplied.includes('\0'))) throw new Error('invalid explicit provider root');
    if (stored[key] && supplied != null && path.resolve(supplied) !== path.resolve(stored[key])) {
      throw new Error(`${key} differs from this installation's configured provider; update the binding explicitly`);
    }
    result[argument] = path.resolve(stored[key] ?? supplied ?? fallback);
  }
  const physical = value => fs.existsSync(value) ? fs.realpathSync(value) : value;
  const a = physical(result.skillsRoot), b = physical(result.localSkillsRoot);
  const overlap = (x, y) => { const rel = path.relative(x, y); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
  if (overlap(a, b) || overlap(b, a)) throw new Error('managed and member provider roots must be separate');
  return { schema_version: 1, configured: stored.schema_version === 1, ...result };
}
