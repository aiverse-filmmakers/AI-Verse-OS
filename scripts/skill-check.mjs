#!/usr/bin/env node
// Plain report of what an outside skill or repo can do, for a human to judge.
// Read only: it never runs, imports or follows anything inside the folder. It is not a safety verdict.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TEXT = /\.(md|mdx|txt|py|sh|bash|zsh|mjs|cjs|js|ts|json|ya?ml|toml|html|ps1|rb)$/i;
const SCRIPT = /\.(py|sh|bash|zsh|mjs|cjs|js|ts|ps1|rb)$/i;
const COMPILED = /(\.(pyc|pyo|so|dylib|dll|exe|node|wasm|jar|bin|zip|tar|gz|tgz|7z|rar|pkg|dmg)|__pycache__)$/i;
const CONFIG = /(^|\/)(\.claude|\.codex|\.agents|\.cursor|\.gemini|\.vscode|\.mcp\.json|\.husky)(\/|$)/;
const MAX_FILE = 2_000_000;
const PATTERNS = [
  ['Runs a command while loading, before the AI can object', /(?:^|\s)!`[^`\n]+`|^```!/gm],
  ['Downloads code and runs it straight away', /(?:curl|wget)[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\b(?:irm|iwr)\b[^\n|]{0,200}\|\s*iex\b/gi],
  ['Decodes hidden text and runs it', /base64\s+(?:-d|-D|--decode)[^\n]{0,80}\|/g],
  ['Turns off permission checks', /dangerously-skip-permissions|bypassPermissions|--yolo\b/g],
  ['Mentions secrets or login files', /\.ssh\/|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.npmrc|hosts\.yml|auth\.json|keychain|\.env\b/gi],
  ['Installs unpinned packages', /\bnpx\s+(?:-y\s+|--yes\s+)?[^\s`]+@latest\b|\bpip3?\s+install\b|\bnpm\s+(?:i|install)\s+-g\b/gi],
  ['Long block of encoded text', /[A-Za-z0-9+/]{400,}={0,2}/g],
  ['Hidden tag characters (invisible instructions)', /[\u{E0000}-\u{E007F}]/gu],
  ['Text direction tricks', /[‪-‮⁦-⁩]/g],
  ['Invisible characters', /[​-‍⁠-⁤﻿]/g],
];

export function checkFolder(root) {
  const report = { root: path.resolve(root), source: null, files: 0, scripts: 0, bytes: 0, findings: [], hosts: [], notRead: [] };
  const found = new Map();
  const hosts = new Set();
  const add = (label, rel) => { if (!found.has(label)) found.set(label, new Set()); found.get(label).add(rel); };
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (CONFIG.test(rel) && (entry.isFile() || entry.isSymbolicLink())) add('Brings its own AI settings or helpers', rel);
      if (entry.isSymbolicLink()) { add('Contains links to other locations', rel); continue; }
      if (COMPILED.test(entry.name)) add('Compiled or packed files a person cannot read', rel);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.isFile()) { add('Contains unusual file types', rel); continue; }
      const size = fs.statSync(full).size;
      report.files += 1; report.bytes += size;
      if (SCRIPT.test(entry.name)) report.scripts += 1;
      if (!TEXT.test(entry.name)) continue;
      if (size > MAX_FILE) { report.notRead.push(rel); continue; }
      const text = fs.readFileSync(full, 'utf8');
      for (const [label, pattern] of PATTERNS) if (text.search(pattern) >= 0) add(label, rel);
      for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(match[1].toLowerCase());
    }
  };
  visit(root);
  try { report.source = /url\s*=\s*(\S+)/.exec(fs.readFileSync(path.join(root, '.git/config'), 'utf8'))?.[1] ?? null; } catch {}
  report.findings = [...found].map(([label, files]) => ({ label, files: [...files].sort() }));
  report.hosts = [...hosts].sort();
  return report;
}

function print(report) {
  const out = [`What this folder can do: ${report.root}`, `Came from: ${report.source ?? 'unknown'}`,
    `Contains ${report.files} files, ${report.scripts} of them runnable scripts, ${Math.ceil(report.bytes / 1024)} KB`, ''];
  if (report.findings.length) out.push('Worth reading before you say yes:');
  else out.push('The simple checks flagged nothing.');
  for (const { label, files } of report.findings) {
    out.push(`  ${label} (${files.length})`);
    for (const file of files.slice(0, 8)) out.push(`    ${file}`);
    if (files.length > 8) out.push(`    and ${files.length - 8} more`);
  }
  if (report.hosts.length) out.push('', `Web addresses it mentions (${report.hosts.length}): ${report.hosts.slice(0, 30).join(', ')}`);
  if (report.notRead.length) out.push('', `Too large to read, so unchecked: ${report.notRead.join(', ')}`);
  out.push('', 'This is not a safety verdict. These checks only see what is plainly visible.', 'Only add this if you trust where it came from.');
  console.log(out.join('\n'));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== '--json');
  if (args.length !== 1 || !fs.statSync(args[0], { throwIfNoEntry: false })?.isDirectory()) {
    console.error('Usage: node scripts/skill-check.mjs <folder> [--json]');
    process.exit(2);
  }
  const report = checkFolder(args[0]);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else print(report);
}
