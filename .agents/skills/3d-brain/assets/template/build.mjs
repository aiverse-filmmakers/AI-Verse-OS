#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const appDir = process.cwd();
const configPath = path.join(appDir, 'brain.config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing brain.config.json');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const allowedExt = new Set(['.md', '.markdown', '.txt']);
const warnings = [];
const files = [];

function walk(target, category) {
  if (!fs.existsSync(target)) {
    warnings.push(`Missing path for ${category.label}: ${target}`);
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (allowedExt.has(path.extname(target).toLowerCase())) files.push({ file: target, category });
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) walk(full, category);
    else if (entry.isFile() && allowedExt.has(path.extname(entry.name).toLowerCase())) files.push({ file: full, category });
  }
}

for (const category of config.categories || []) {
  for (const sourcePath of category.paths || []) {
    walk(path.resolve(appDir, sourcePath), category);
  }
}

const unique = new Map();
for (const item of files) unique.set(path.resolve(item.file), item);

function titleFrom(text, file) {
  const match = text.match(/^#\s+(.+)$/m);
  return (match ? match[1] : path.basename(file, path.extname(file))).trim();
}

function idFor(categoryId, file) {
  return crypto.createHash('sha1').update(`${categoryId}:${path.resolve(file)}`).digest('hex').slice(0, 16);
}

const nodes = [];
const rawById = new Map();
for (const { file, category } of unique.values()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    warnings.push(`Could not read ${file}: ${err.message}`);
    continue;
  }
  const id = idFor(category.id, file);
  const relativeToApp = path.relative(appDir, file).split(path.sep).join('/');
  const node = {
    id,
    title: titleFrom(text, file),
    categoryId: category.id,
    categoryLabel: category.label,
    path: relativeToApp,
    size: Buffer.byteLength(text, 'utf8')
  };
  nodes.push(node);
  rawById.set(id, { text, file, node });
}

const byAbsPath = new Map(nodes.map(n => [path.resolve(appDir, n.path), n.id]));
const byTitle = new Map();
for (const n of nodes) {
  const key = n.title.toLowerCase();
  if (!byTitle.has(key)) byTitle.set(key, []);
  byTitle.get(key).push(n.id);
}

const edgeKeys = new Set();
const edges = [];
function addEdge(source, target, kind) {
  if (!target || source === target) return;
  const key = `${source}>${target}:${kind}`;
  if (edgeKeys.has(key)) return;
  edgeKeys.add(key);
  edges.push({ source, target, kind });
}

for (const [sourceId, { text, file }] of rawById.entries()) {
  const wiki = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  for (const match of text.matchAll(wiki)) {
    const key = match[1].trim().toLowerCase();
    const ids = byTitle.get(key);
    if (ids?.length === 1) addEdge(sourceId, ids[0], 'wikilink');
  }

  const md = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(md)) {
    let href = match[1].trim().split('#')[0];
    if (!href || /^(https?:|mailto:|#)/i.test(href)) continue;
    try { href = decodeURIComponent(href); } catch {}
    const targetAbs = path.resolve(path.dirname(file), href);
    const targetId = byAbsPath.get(targetAbs);
    if (targetId) addEdge(sourceId, targetId, 'markdown-link');
  }
}

const graph = {
  generatedAt: new Date().toISOString(),
  name: config.name || 'AI-Verse Brain',
  categories: config.categories || [],
  counts: {
    nodes: nodes.length,
    edges: edges.length,
    categories: (config.categories || []).length
  },
  warnings,
  nodes,
  edges
};

fs.writeFileSync(path.join(appDir, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
console.log(JSON.stringify({ name: graph.name, ...graph.counts, warnings }, null, 2));
