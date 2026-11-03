#!/usr/bin/env node
// How the reviewer command is resolved and spawned without a shell. Runs on Ubuntu, macOS and Windows (CI runs it on all three);
// on Windows it also exercises a real npm-style claude.cmd shim and a real spawn through the resolved pair.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveClaude, shimTarget } from './learn-claude.mjs';

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

const dir = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiverse-claude-'));

test('the npm shim names its node script; other text names nothing', () => {
  assert.equal(shimTarget(NPM_SHIM), 'node_modules\\@anthropic-ai\\claude-code\\cli.js');
  assert.equal(shimTarget('@echo off\r\nstart whatever.exe %*'), null);
});

test('posix: the name goes to spawn unchanged; a script path runs under the current node', () => {
  assert.deepEqual(resolveClaude(['claude', '--flag'], { platform: 'linux' }), { command: 'claude', args: ['--flag'] });
  assert.deepEqual(resolveClaude(['/x/fake.mjs'], { platform: 'darwin', node: '/n' }), { command: '/n', args: ['/x/fake.mjs'] });
});

test('windows: an .exe wins over a .cmd; a shim resolves to node plus its script; an unreadable shim is refused, never shelled', () => {
  const bin = dir();
  const env = { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const opts = { platform: 'win32', env, node: 'NODE', pathMod: path, fsMod: fs };
  assert.deepEqual(resolveClaude(['claude'], opts), { error: 'claude_missing' });
  fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo off\nclaude-native %*\n');
  assert.deepEqual(resolveClaude(['claude'], opts), { error: 'claude_unresolved' });
  const script = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, '// cli');
  fs.writeFileSync(path.join(bin, 'claude.cmd'), NPM_SHIM);
  assert.deepEqual(resolveClaude(['claude', '--x'], opts), { command: 'NODE', args: [script, '--x'] });
  fs.writeFileSync(path.join(bin, 'claude.exe'), 'MZ');
  assert.deepEqual(resolveClaude(['claude'], opts), { command: path.join(bin, 'claude.exe'), args: [] });
  assert.deepEqual(resolveClaude(['claude.cmd'], { ...opts, platform: 'win32' }).args.at(-1), script); // explicit extension
});

test('a shim whose target script is missing is not run', () => {
  const bin = dir();
  const opts = { platform: 'win32', env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, node: 'NODE', pathMod: path, fsMod: fs };
  fs.writeFileSync(path.join(bin, 'claude.cmd'), NPM_SHIM);
  assert.deepEqual(resolveClaude(['claude'], opts), { error: 'claude_unresolved' });
});

test('windows only: a real claude.cmd shim is resolved from PATH and spawned without a shell', { skip: process.platform !== 'win32' }, () => {
  const bin = dir();
  const script = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),got:s})));");
  fs.writeFileSync(path.join(bin, 'claude.cmd'), NPM_SHIM);
  const resolved = resolveClaude(['claude'], { env: { ...process.env, PATH: bin } });
  assert.equal(resolved.command, process.execPath);
  const run = spawnSync(resolved.command, [...resolved.args, '-p', '--settings', '{"a":"b c"}'], { input: 'hello', encoding: 'utf8', shell: false });
  assert.deepEqual(JSON.parse(run.stdout), { args: ['-p', '--settings', '{"a":"b c"}'], got: 'hello' });
});
