#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
if (rootIndex < 0 || !args[rootIndex + 1]) {
  console.error('Usage: node discover.mjs --root <AI-Verse-OS-root>');
  process.exit(1);
}

const root = path.resolve(args[rootIndex + 1]);
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Root does not exist: ${root}`);
  process.exit(1);
}

const candidates = [
  ['Context', 'context'],
  ['References', 'references'],
  ['Projects', 'projects'],
  ['Skills', '.claude/skills'],
  ['Decisions', 'decisions'],
  ['Templates', 'templates'],
  ['Filmmaking', 'references/filmmaking'],
  ['Models', 'references/models']
];

const found = [];
for (const [label, rel] of candidates) {
  const full = path.join(root, rel);
  if (fs.existsSync(full)) {
    found.push({ label, path: rel, type: fs.statSync(full).isDirectory() ? 'directory' : 'file' });
  }
}

console.log(JSON.stringify({ root, candidates: found }, null, 2));
