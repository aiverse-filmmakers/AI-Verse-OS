#!/usr/bin/env node
// Claude Code hook entry for automatic learning: stop | precompact | end | start.
// It writes one durable event file (a pointer to the transcript, never a copy of it), starts the detached worker, prints
// nothing, never blocks the chat and always exits 0. It never opens the database, so there is no lock to lose an event to.
// Mode off (or no config) does nothing at all.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEnabled, isMain, learnPaths, loadConfig, sessionKey, sha, spoolEvent } from './learn-common.mjs';
import { fingerprint, handoffLines, readLines } from './learn-window.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const MAX_STDIN = 1024 * 1024;

async function readPayload() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN) return null;
    chunks.push(chunk);
  }
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

export function startWorker(root) {
  // The launcher runs on any Node, checks the version itself and leaves a diagnostic when it cannot start the worker.
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'learn-launch.mjs'), '--root', root], {
    detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  child.on('error', () => {});
  child.unref();
}

// Before a compaction can rewrite the transcript: the user messages only, screened for secrets, in a file the worker adopts if
// the transcript turns out to be replaced. Failing to write it is recorded in the event, never silent.
function handoff(root, key, transcript, now) {
  try {
    const lines = readLines(transcript);
    const fp = fingerprint(lines);
    if (!fp) return {};
    const dir = path.join(learnPaths(root).base, 'handoff');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${key}-${now}-${sha(transcript + now, 8)}.jsonl`);
    fs.writeFileSync(`${file}.tmp`, `${handoffLines(lines).join('\n')}\n`);
    fs.renameSync(`${file}.tmp`, file);
    return { handoff: { fp, path: file } };
  } catch {
    return { handoff_failed: true };
  }
}

export function handleEvent(root, event, payload, now = Date.now(), start = startWorker) {
  const config = loadConfig(root);
  if (!isEnabled(config) || process.env.AIVERSE_LEARN_REVIEW) return false;
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) return false;
  if (event === 'start') {
    start(root); // the worker finds expired claims and waiting events itself
    return true;
  }
  const reason = { stop: 'idle', precompact: 'before_compaction', end: 'session_end' }[event];
  const { session_id: sessionId, transcript_path: transcript, cwd } = payload;
  if (!reason || typeof sessionId !== 'string' || !sessionId || typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return false;
  if (event === 'stop' && payload.stop_hook_active) return false;
  const key = sessionKey(sessionId);
  spoolEvent(root, {
    v: 1, key, session_id: sessionId, transcript_path: transcript, cwd: typeof cwd === 'string' ? cwd : null, reason, at: now,
    config: { idle_seconds: config.idle_seconds, max_pending_turns: config.max_pending_turns },
    ...(event === 'precompact' ? handoff(root, key, transcript, now) : {}),
  });
  start(root);
  return true;
}

async function main() {
  const event = process.argv[2];
  const root = path.resolve(SCRIPTS, '..');
  const payload = (await readPayload()) ?? {};
  handleEvent(root, event, payload);
}

if (isMain(import.meta.url)) {
  main().catch(() => {}).finally(() => process.exit(0));
}
