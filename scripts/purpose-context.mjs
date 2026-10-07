#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
    } else {
      fail(`unknown option: ${token}`, 2);
    }
  }

  return { command, root: path.resolve(root), scope, maxBytes, profile, relevantDomains };
}

export function readPurposeContextCli(options) {
  return composeProfiledPurposeContext(options.root, options.scope, {
    maxBytes: options.maxBytes,
    profile: options.profile,
    relevantDomains: options.relevantDomains,
  });
}

function runCli() {
  const options = parse(process.argv.slice(2));
  if (options.command !== 'read') fail(`unknown command: ${options.command}`, 2);

  try {
    process.stdout.write(`${JSON.stringify(readPurposeContextCli(options), null, 2)}\n`);
  } catch (error) {
    fail(error.message, 4);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}
