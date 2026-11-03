#!/usr/bin/env node
// Claude Code hook entry for automatic learning: stop | precompact | end | start.
// It writes one durable event file (a pointer to the transcript, never a copy of it), starts the detached worker, prints
// nothing, never blocks the chat and always exits 0. It never opens the database, so there is no lock to lose an event to.
// Mode off (or no config) does nothing at all.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHandoff, isEnabled, isMain, learnPaths, loadConfig, pruneRuntime, resolveScope, sessionKey, spoolEvent } from './learn-common.mjs';
import { fingerprint, handoffLines, HEAD_RECORDS, headHash, readLines } from './learn-window.mjs';

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
    // Exclusive creation under a random name: two handoffs in the same millisecond can never overwrite each other. The event that
    // names the file is written only after this returns, so a half-written file is never referenced (and is removed on failure).
    const body = handoffLines(lines, (cwd) => resolveScope(root, cwd));
    let file = null;
    for (let attempt = 0; attempt < 5 && !file; attempt += 1) {
      const candidate = path.join(dir, `${key}-${now}-${crypto.randomBytes(4).toString('hex')}.jsonl`);
      if (createHandoff(candidate, body)) file = candidate; // a taken name is never touched; another is tried
    }
    if (!file) throw new Error('handoff_name_taken');
    const hn = Math.min(HEAD_RECORDS, lines.length);
    return { handoff: { fp, path: file, head: headHash(lines, hn), hn } };
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
  if (event === 'precompact') try { pruneRuntime(root, now); } catch {} // the new file may have crossed the cap
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
