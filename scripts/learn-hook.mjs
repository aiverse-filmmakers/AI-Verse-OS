#!/usr/bin/env node
// Claude Code hook entry for automatic learning: stop | precompact | end | start.
//
// At each of these boundaries it reads what was said since the last time (the human records of the transcript, streamed),
// screens it, and records it in the journal (learn-store) in one transaction, then starts the detached worker. If the database
// is busy or missing it leaves an envelope instead (a whole, digest-named file, fsynced) that the worker ingests. It reports
// success only once the evidence is durable; otherwise it says so on stderr and exits 1, so a failed capture is never mistaken
// for a protected one. It prints nothing otherwise, never blocks the chat, and does nothing at all while learning is off.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEnabled, isMain, loadConfig, resolveScope, sessionKey, setStatus, writeEnvelope } from './learn-common.mjs';
import { scanTranscript } from './learn-capture.mjs';

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

async function openQuietly(root) {
  process.removeAllListeners('warning'); // node:sqlite's experimental notice must never reach the chat
  const { openStore } = await import('./learn-store.mjs');
  return openStore(root, { busyMs: 3000 });
}

const REASONS = { stop: 'idle', precompact: 'before_compaction', end: 'session_end', start: 'session_start' };

// Returns { ok, via: 'journal' | 'envelope' | 'none' | 'skipped', code? }. `io`/`crash` are test seams for fault injection.
export async function handleEvent(root, event, payload, now = Date.now(), start = startWorker, { io = fs, crash = () => {}, open = openQuietly } = {}) {
  const config = loadConfig(root);
  if (!isEnabled(config) || process.env.AIVERSE_LEARN_REVIEW) return { ok: true, via: 'skipped' };
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) return { ok: true, via: 'skipped' };
  const reason = REASONS[event];
  const { session_id: sessionId, transcript_path: transcript } = payload;
  if (!reason || (event === 'stop' && payload.stop_hook_active)) return { ok: true, via: 'skipped' };
  if (typeof sessionId !== 'string' || !sessionId || typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) {
    if (event === 'start') start(root);
    return { ok: true, via: 'skipped' };
  }
  const key = sessionKey(sessionId);
  let db = null;
  try { db = await open(root); } catch { db = null; }
  try {
    let from = { from: 0, anchor: '' };
    if (db) {
      const saved = db.prepare('SELECT path, off, anchor FROM captures WHERE session = ?').get(key);
      if (saved && saved.path === transcript) from = { from: saved.off, anchor: saved.anchor };
    }
    let scan;
    try {
      scan = scanTranscript(transcript, from);
    } catch {
      if (event === 'start') { start(root); return { ok: true, via: 'none' }; } // nothing to read yet at the start of a new chat
      throw new Error('transcript_unreadable');
    }
    const records = scan.records.map((r) => ({ uuid: r.uuid, ts: r.ts, seq: r.seq, text: r.text, scope: resolveScope(root, r.cwd) })).filter((r) => r.scope !== null);
    const batch = {
      key, session_id: sessionId, transcript_path: transcript, reason, at: now,
      config: { idle_seconds: config.idle_seconds, max_pending_turns: config.max_pending_turns }, records,
    };
    let via = null;
    if (db) {
      try {
        const { ingestBatch } = await import('./learn-store.mjs');
        ingestBatch(db, { ...batch, offset: { path: transcript, end: scan.end, anchor: scan.anchor } }, now);
        via = 'journal';
      } catch { via = null; }
    }
    if (!via) {
      writeEnvelope(root, batch, { io, crash });
      via = 'envelope';
    }
    start(root);
    return { ok: true, via };
  } catch {
    setStatus(root, 'capture_failed');
    return { ok: false, code: 'capture_failed' };
  } finally {
    try { db?.close(); } catch {}
  }
}

async function main() {
  const event = process.argv[2];
  const root = path.resolve(SCRIPTS, '..');
  const payload = (await readPayload()) ?? {};
  const result = await handleEvent(root, event, payload);
  if (!result.ok) {
    process.stderr.write('AI-Verse learning could not save this conversation (disk or permission problem); text compacted away now may not be learned. See runtime/learn/status.json.\n');
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) main().catch(() => 1).then((code) => process.exit(code));
