#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = flag => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const rootArg = value('--root');
const configArg = value('--config');
const outArg = value('--out') || 'apps/3d-brain';

if (!rootArg || !configArg) {
  console.error('Usage: node scaffold.mjs --root <AI-Verse-OS-root> --config <setup-json> [--out apps/3d-brain]');
  process.exit(1);
}

const root = path.resolve(rootArg);
const configPath = path.resolve(configArg);
const out = path.resolve(root, outArg);
const here = path.dirname(fileURLToPath(import.meta.url));
const template = path.resolve(here, '../assets/template');

if (!fs.existsSync(template)) {
  console.error(`Template missing: ${template}`);
  process.exit(1);
}
if (!fs.existsSync(configPath)) {
  console.error(`Config missing: ${configPath}`);
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`Destination already exists: ${out}`);
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!config.name || !Array.isArray(config.categories)) {
  console.error('Config requires name and categories.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.cpSync(template, out, { recursive: true });
fs.writeFileSync(path.join(out, 'brain.config.json'), JSON.stringify(config, null, 2) + '\n');

console.log(JSON.stringify({ created: out, name: config.name, categories: config.categories.length }, null, 2));
