import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

// JSON.parse alone accepts duplicate keys. Reject them before interpreting owner metadata.
export function parseCapabilityJson(text) {
  const tokens = text.match(/"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]|\s+|./g) ?? [];
  let at = 0;
  const skip = () => { while (/^\s+$/.test(tokens[at] ?? '')) at++; };
  const take = expected => { skip(); if (tokens[at++] !== expected) throw new Error('invalid capability JSON'); };
  const value = depth => {
    if (depth > 32) throw new Error('capability JSON is nested too deeply');
    skip();
    if (tokens[at] === '{') {
      take('{'); skip(); const keys = new Set();
      if (tokens[at] !== '}') while (true) {
        skip(); const token = tokens[at++];
        if (!token?.startsWith('"')) throw new Error('invalid capability JSON key');
        const key = JSON.parse(token);
        if (keys.has(key)) throw new Error('duplicate capability JSON key');
        keys.add(key); take(':'); value(depth + 1); skip();
        if (tokens[at] !== ',') break;
        take(',');
      }
      take('}');
    } else if (tokens[at] === '[') {
      take('['); skip();
      if (tokens[at] !== ']') while (true) {
        value(depth + 1); skip(); if (tokens[at] !== ',') break; take(',');
      }
      take(']');
    } else {
      const token = tokens[at++];
      if (token == null || token === '' || '{}[],:'.includes(token)) throw new Error('invalid capability JSON value');
      const parsed = JSON.parse(token);
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('non-finite capability JSON number');
    }
  };
  value(0); skip();
  if (at !== tokens.length) throw new Error('invalid capability JSON tail');
  return JSON.parse(text);
}

export function existsEntry(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function readCapabilityJson(file, maxBytes) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('capability JSON must be a bounded regular file');
  const bytes = fs.readFileSync(file);
  if (bytes.length > maxBytes) throw new Error('capability JSON is oversized');
  return parseCapabilityJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function validateMemberPackage(directory) {
  let entries = 0, files = 0, bytes = 0;
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const item = path.join(dir, entry.name);
      const stat = fs.lstatSync(item);
      if (++entries > 1024 || entry.name === '.git' || stat.isSymbolicLink() || fs.realpathSync(item) !== item) throw new Error('member package has unsupported or redirected entries');
      if (stat.isDirectory()) visit(item);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (++files > 256 || stat.size > 1048576 || bytes > 8388608) throw new Error('member package exceeds resource limits');
      } else throw new Error('member package has special entries');
    }
  };
  visit(directory);
  if (!fs.statSync(path.join(directory, 'SKILL.md')).isFile()) throw new Error('member package requires SKILL.md');
}
