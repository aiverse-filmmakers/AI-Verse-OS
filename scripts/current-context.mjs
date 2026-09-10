#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  DIRECTION_SCHEMA_VERSION,
  directionOwnerState,
  validateDirectionScope,
} from './direction-owner-core.mjs';

const OUTPUT_SCHEMA_VERSION = 1;
const BRAIN_REF = /^brain:intent:[A-Za-z0-9._-]+$/;
const ALLOWED_OPERATIONAL_HEADINGS = {
  operator: new Set([
    'active workspaces', 'pending decisions', 'current constraints', 'constraints',
    'constraints / approvals', 'current state', 'current facts', 'next useful actions',
    'pointers', 'source pointers', 'connection state', 'execution state',
  ]),
  workspace: new Set([
    'current state', 'next useful actions', 'pending decisions', 'constraints / approvals',
    'current constraints', 'constraints', 'pointers', 'source pointers',
    'connection state', 'execution state',
  ]),
};

function fail(message, code = 4) {
  process.stderr.write(`current-context: ${message}\n`);
  process.exit(code);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function samePath(a, b) {
  return path.relative(a, b) === '' && path.relative(b, a) === '';
}

function realDirectory(target, expected, label) {
  if (!fs.existsSync(target)) throw new Error(`${label} does not exist`);
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (!samePath(real, expected)) throw new Error(`${label} is not its expected physical slot`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory`);
  return real;
}

function safeOptionalFile(target, boundary, label) {
  if (!fs.existsSync(target)) return null;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  const real = fs.realpathSync(target);
  if (!isInside(real, boundary) || !fs.statSync(real).isFile()) throw new Error(`${label} escapes its scope boundary`);
  return real;
}

function scopePaths(root, scope) {
  const base = fs.realpathSync(root);
  if (scope === 'operator') {
    const expected = path.join(base, 'operator');
    const ownerRoot = realDirectory(path.join(root, 'operator'), expected, 'operator root');
    return {
      kind: 'operator',
      current: path.join(root, 'operator', 'context', 'CURRENT.md'),
      boundary: ownerRoot,
    };
  }
  const id = scope.slice('workspace:'.length);
  const workspacesExpected = path.join(base, 'workspaces');
  const workspaces = realDirectory(path.join(root, 'workspaces'), workspacesExpected, 'workspaces root');
  const expected = path.join(workspaces, id);
  const workspace = realDirectory(path.join(root, 'workspaces', id), expected, `workspace ${id}`);
  return {
    kind: 'workspace',
    current: path.join(root, 'workspaces', id, 'context', 'CURRENT.md'),
    boundary: workspace,
  };
}

function normalizeHeading(value) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function parseH2(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  const metadata = [];
  let current = null;
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      if (current) sections.push(current);
      current = { heading: match[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else if (/^Last reviewed:\s*.+/i.test(line.trim())) metadata.push(line.trim());
  }
  if (current) sections.push(current);
  return { metadata, sections };
}

function operationalProjection(text, kind) {
  const parsed = parseH2(text);
  const allowed = ALLOWED_OPERATIONAL_HEADINGS[kind];
  const kept = [];
  const omitted = [];
  for (const section of parsed.sections) {
    if (allowed.has(normalizeHeading(section.heading))) kept.push(section);
    else omitted.push(section.heading);
  }
  const body = [];
  body.push(...parsed.metadata);
  for (const section of kept) {
    if (body.length) body.push('');
    body.push(`## ${section.heading}`);
    body.push(...section.lines);
  }
  return { text: `${body.join('\n').trim()}${body.length ? '\n' : ''}`, omitted };
}

function safeBrainRefs(record) {
  const refs = record?.brain_refs ?? [];
  if (!Array.isArray(refs) || !refs.every((ref) => typeof ref === 'string' && BRAIN_REF.test(ref))) {
    throw new Error('Brain-owned direction record contains invalid brain_refs');
  }
  return [...new Set(refs)];
}

function safeDirectionView(root, scope) {
  const directionRoot = path.join(root, '.aiverse', 'direction');
  if (!fs.existsSync(directionRoot)) return { path: null, status: 'missing' };
  if (fs.lstatSync(directionRoot).isSymbolicLink()) return { path: null, status: 'invalid', diagnostic: 'direction directory must not be a symlink' };
  const views = path.join(directionRoot, 'views');
  if (!fs.existsSync(views)) return { path: null, status: 'missing' };
  if (fs.lstatSync(views).isSymbolicLink()) return { path: null, status: 'invalid', diagnostic: 'direction views directory must not be a symlink' };
  const filename = scope.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const target = path.join(views, `${filename}.md`);
  if (!fs.existsSync(target)) return { path: null, status: 'missing' };
  if (fs.lstatSync(target).isSymbolicLink()) return { path: null, status: 'invalid', diagnostic: 'direction view must not be a symlink' };
  const realViews = fs.realpathSync(views);
  const real = fs.realpathSync(target);
  if (!isInside(real, realViews) || !fs.statSync(real).isFile()) {
    return { path: null, status: 'invalid', diagnostic: 'direction view escapes its generated-view boundary' };
  }
  return { path: path.relative(root, real).split(path.sep).join('/'), status: 'available' };
}

function renderBrainOwned(scope, operational, refs, view) {
  const lines = [
    `# Active Current Context — ${scope}`,
    '',
    'Direction owner: brain',
    'Strategic direction: Brain-owned. Frozen OS strategy is excluded from active current context.',
  ];
  if (refs.length) {
    lines.push('', '## Canonical Brain refs', '', ...refs.map((ref) => `- \`${ref}\``));
  } else {
    lines.push('', '## Canonical Brain refs', '', '- none recorded');
  }
  lines.push('', `Direction view: ${view.path ?? 'unavailable'}`);
  if (operational.text.trim()) lines.push('', '## OS operational context', '', operational.text.trimEnd());
  return `${lines.join('\n')}\n`;
}

function readCurrentContext(root, scope) {
  validateDirectionScope(scope);
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) throw new Error(`AI-Verse OS root not found: ${root}`);
  const paths = scopePaths(root, scope);
  const state = directionOwnerState(root, scope);
  const current = safeOptionalFile(paths.current, paths.boundary, `${scope} current context`);
  const raw = current ? fs.readFileSync(current, 'utf8') : '';
  const source = current ? path.relative(root, current).split(path.sep).join('/') : null;

  if (state.owner === 'os') {
    return {
      schema_version: OUTPUT_SCHEMA_VERSION,
      direction_schema_version: DIRECTION_SCHEMA_VERSION,
      scope,
      direction_owner: 'os',
      strategy_status: 'os-canonical',
      current_context: raw,
      source,
      direction_view: null,
      direction_view_status: 'not-applicable',
      direction_refs: [],
      omitted_sections: [],
    };
  }

  const refs = safeBrainRefs(state.record);
  const view = safeDirectionView(root, scope);
  const operational = operationalProjection(raw, paths.kind);
  return {
    schema_version: OUTPUT_SCHEMA_VERSION,
    direction_schema_version: DIRECTION_SCHEMA_VERSION,
    scope,
    direction_owner: 'brain',
    strategy_status: refs.length || view.status === 'available' ? 'brain-canonical' : 'unavailable',
    current_context: renderBrainOwned(scope, operational, refs, view),
    source,
    direction_view: view.path,
    direction_view_status: view.status,
    direction_refs: refs,
    omitted_sections: operational.omitted,
    diagnostics: view.diagnostic ? [view.diagnostic] : [],
  };
}

function parse(argv) {
  const args = [...argv];
  const command = args.shift() || 'read';
  let root = process.cwd();
  let scope = 'operator';
  while (args.length) {
    const token = args.shift();
    if (token === '--root' || token === '--dir') root = path.resolve(args.shift() || fail(`${token} requires a path`, 2));
    else if (token === '--scope') scope = args.shift() || fail('--scope requires a value', 2);
    else fail(`unknown option: ${token}`, 2);
  }
  return { command, root: path.resolve(root), scope };
}

const { command, root, scope } = parse(process.argv.slice(2));
if (command !== 'read') fail(`unknown command: ${command}`, 2);
try {
  process.stdout.write(`${JSON.stringify(readCurrentContext(root, scope), null, 2)}\n`);
} catch (error) {
  fail(error.message, 4);
}
