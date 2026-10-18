// Optional public Brain reader; registration grants no strategic ownership.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function createBrainPurposeReader(root) {
  const base = fs.realpathSync(root);
  function localFile(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Unsafe Brain reader path');
    const file = path.join(base, relative);
    let probe = file;
    while (probe !== base) {
      if (fs.lstatSync(probe).isSymbolicLink()) throw new Error('Symlink in Brain reader path');
      probe = path.dirname(probe);
    }
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 262144) throw new Error('Brain reader file absent or oversized');
    return file;
  }
  let entry, config;
  try {
    const registry = JSON.parse(fs.readFileSync(localFile('.aiverse/extensions/registry.json'), 'utf8'));
    entry = registry.extensions?.['ai-verse-brain'];
    if (!entry || !['supported','installed','enabled'].every(key => entry[key] === true) || !entry.public_purpose_reader) return undefined;
    config = JSON.parse(fs.readFileSync(localFile('.aiverse/brain-purpose.json'), 'utf8'));
    if (typeof config.python !== 'string' || !path.isAbsolute(config.python)) return undefined;
    const engine = localFile(entry.public_purpose_reader);
    return scope => {
      try {
      const result = spawnSync(config.python, ['-B', engine, '--root', base, '--scope', scope], {encoding:'utf8', timeout:10000, maxBuffer:131072, shell:false, cwd:base});
      if (result.error || result.status !== 0) throw new Error('Brain public Purpose reader unavailable');
      const snapshot = JSON.parse(result.stdout);
      if (snapshot.scope !== scope || snapshot.direction_owner !== 'brain') throw new Error('Brain Purpose reader owner/scope mismatch');
      return snapshot;
      } catch { return {schema_version:'1.0', scope, direction_owner:'brain', status:'unavailable', reason:'brain_public_reader_unavailable', read_states:{}, strategic_objects:{intents:[],gaps:[],initiatives:[]}, relationships:[]}; }
    };
  } catch { return undefined; }
}
