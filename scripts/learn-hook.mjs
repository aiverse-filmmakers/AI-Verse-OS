#!/usr/bin/env node
// Claude Code hook entry for automatic learning: stop | precompact | end | start.
// It writes one durable event file (and, before a compaction, a copy of the transcript), starts the detached worker, prints
// nothing, never blocks the chat and always exits 0. It never opens the database, so there is no lock to lose an event to.
// Mode off (or no config) does nothing at all.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEnabled, isMain, learnPaths, loadConfig, sessionKey, sha, spoolEvent } from './learn-common.mjs';
import { fingerprint, readLines } from './learn-window.mjs';

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
  // --disable-warning keeps node:sqlite's experimental notice out of the worker's (ignored) stderr on Node 22.
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(SCRIPTS, 'learn-worker.mjs'), '--root', root], {
    detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  child.on('error', () => {});
  child.unref();
}

// A copy of the whole transcript, taken before compaction can rewrite it. Bigger than the reader's limit: no copy, and the
// event says so with a code the worker records.
function snapshot(root, key, transcript, now) {
  try {
    const lines = readLines(transcript);
    const fp = fingerprint(lines);
    if (!fp) return {};
    const { snapshots } = learnPaths(root);
    fs.mkdirSync(snapshots, { recursive: true });
    const file = path.join(snapshots, `${key}-${now}-${sha(transcript + now, 8)}.jsonl`);
    fs.writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`);
    fs.renameSync(`${file}.tmp`, file);
    return { snapshot: { fp, path: file, lines: lines.length } };
  } catch {
    return { snapshot_code: 'snapshot_failed' };
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
    ...(event === 'precompact' ? snapshot(root, key, transcript, now) : {}),
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
