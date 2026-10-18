#!/usr/bin/env node

import path from 'node:path';
import { createBrainPurposeReader } from './brain-purpose-reader.mjs';
import { createDataPurposeReader } from './data-purpose-reader.mjs';
import { pathToFileURL } from 'node:url';

import { explainPurposeContext } from './purpose-context-explain.mjs';
import { composeProfiledPurposeContext } from './purpose-context-profile.mjs';

function fail(message, code = 4) {
  process.stderr.write(`purpose-context: ${message}\n`);
  process.exit(code);
}

function parse(argv) {
  const args = [...argv];
  const command = args.shift() || 'read';
  let root = process.cwd();
  let scope = 'operator';
  let maxBytes;
  let profile = 'auto';
  let ref;
  let readDataBindings = false;
  const relevantDomains = [];

  while (args.length) {
    const token = args.shift();
    if (token === '--root' || token === '--dir') {
      const value = args.shift();
      if (!value) fail(`${token} requires a path`, 2);
      root = path.resolve(value);
    } else if (token === '--scope') {
      scope = args.shift() || fail('--scope requires a value', 2);
    } else if (token === '--max-bytes') {
      const raw = args.shift();
      if (!raw || !/^\d+$/.test(raw)) fail('--max-bytes requires an integer', 2);
      maxBytes = Number(raw);
    } else if (token === '--profile') {
      profile = args.shift() || fail('--profile requires auto, basic, or rich', 2);
    } else if (token === '--relevant-domain') {
      const value = args.shift();
      if (!value) fail('--relevant-domain requires a value', 2);
      relevantDomains.push(value);
    } else if (token === '--ref') {
      ref = args.shift() || fail('--ref requires an exact semantic ref such as initiative:<id>', 2);
    } else if (token === '--data-bindings') {
      if (readDataBindings) fail('--data-bindings may appear only once', 2);
      readDataBindings = true;
    } else {
      fail(`unknown option: ${token}`, 2);
    }
  }

  return { command, root: path.resolve(root), scope, maxBytes, profile, relevantDomains, ref, readDataBindings };
}

function projectionOptions(options) {
  return {
    readBrainPurposeSnapshot: options.readBrainPurposeSnapshot ?? createBrainPurposeReader(options.root),
    readPurposeDataCurrentState: options.readPurposeDataCurrentState ?? createDataPurposeReader(options.root, { scope: options.scope, bindings: options.dataBindings, now: options.now }),
    now: options.now,
    maxBytes: options.maxBytes,
    profile: options.profile,
    relevantDomains: options.relevantDomains,
  };
}

export function readPurposeContextCli(options) {
  return composeProfiledPurposeContext(options.root, options.scope, projectionOptions(options));
}

export function explainPurposeContextCli(options) {
  if (!options.ref) throw new Error('explain requires --ref');
  return explainPurposeContext(options.root, options.scope, options.ref, projectionOptions(options));
}

async function runCli() {
  const options = parse(process.argv.slice(2));
  if (!['read', 'explain'].includes(options.command)) fail(`unknown command: ${options.command}`, 2);

  try {
    if (options.readDataBindings) {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length;
        if (bytes > 65_536) throw new Error('Purpose Data bindings exceed byte limit');
        chunks.push(chunk);
      }
      options.dataBindings = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    const result = options.command === 'read'
      ? readPurposeContextCli(options)
      : explainPurposeContextCli(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    fail(error.message, 4);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}
