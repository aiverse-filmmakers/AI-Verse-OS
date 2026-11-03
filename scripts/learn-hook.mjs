#!/usr/bin/env node
// Claude Code hook entry for automatic learning: stop | precompact | end | start.
// It only writes durable job files and starts the detached worker. It does no model work, prints nothing,
// never blocks the chat or compaction, and always exits 0. Absent .aiverse/learn/config.json means off.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  enqueue, isEnabled, learnPaths, listJobs, loadConfig, readCursor, recoverClaims, resolveScope, sessionKey, workerRunning,
} from './learn-queue.mjs';
import { copyTail } from './learn-window.mjs';

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
  if (workerRunning(root)) return;
  const child = spawn(process.execPath, [path.join(SCRIPTS, 'learn-worker.mjs'), '--root', root], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.on('error', () => {});
  child.unref();
}

export function handleEvent(root, event, payload, now = Date.now(), start = startWorker) {
  const config = loadConfig(root);
  if (!isEnabled(config) || process.env.AIVERSE_LEARN_REVIEW) return false;
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) return false;
  if (event === 'start') {
    recoverClaims(root, now);
    if (listJobs(root).length) start(root);
    return true;
  }
  const { session_id: sessionId, transcript_path: transcript, cwd } = payload;
  if (typeof sessionId !== 'string' || !sessionId || typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return false;
  if (event === 'stop' && payload.stop_hook_active) return false;
  const scope = resolveScope(root, typeof cwd === 'string' && cwd ? cwd : root);
  if (!scope) return false;
  const job = { session_id: sessionId, transcript_path: transcript, cwd: cwd || root, scope, now, reason: { stop: 'idle', precompact: 'before_compaction', end: 'session_end' }[event] };
  if (!job.reason) return false;
  if (event === 'precompact') {
    const key = sessionKey(sessionId);
    const from = readCursor(root, key);
    const tail = copyTail(transcript, from);
    if (tail !== null) {
      const file = path.join(learnPaths(root).spool, `${key}-${now}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, tail);
      job.spool = { path: file, from_line: from };
    }
  }
  enqueue(root, config, job);
  start(root);
  return true;
}

async function main() {
  const event = process.argv[2];
  const root = path.resolve(SCRIPTS, '..');
  const payload = (await readPayload()) ?? {};
  handleEvent(root, event, payload);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => {}).finally(() => process.exit(0));
}
