#!/usr/bin/env node
// Claude Code hook entry for automatic learning: prompt | stop | precompact | end | start.
//
// At each of these boundaries it reads what was said since the last time (the human records of the transcript, in bounded batches),
// screens it, and records each batch in the journal (learn-store) in one transaction together with the read position, then starts
// the detached worker. There is no file fallback: if the database cannot be reached or written, NOTHING is written (a raw record
// must never reach disk before the credential screen can be consulted), the hook says so on stderr, exits 1, and sets the visible
// `capture_failed` health state. The transcript itself is untouched, so the next boundary reads the same text again.
//
// The compaction policy, stated once. Nothing here ever blocks a compaction (exit 2 would, but a chat stopped at its context limit is a
// worse outcome than a missed statement). Instead text is captured EARLY: at every prompt submission (which also covers a turn the
// user interrupted, when no Stop ever fires) and at every Stop, so PreCompact only has the last turn to recover. If capture fails, the
// hook exits 1 (a non-blocking notice in Claude Code: it protects nothing) and raises the visible `capture_failed` health state, which
// stays until a later capture succeeds; text compacted away while it was failing may be lost to learning, and that is the stated risk.
// A record too large to hold is an unresolved gap (`capture_incomplete`) that stays visible until it is resolved. The hook does
// nothing at all while learning is off.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEnabled, isMain, loadConfig, resolveScope, sessionKey, setStatus } from './learn-common.mjs';
import { IDENTIFIER, SAFE_PATH, scanTranscript } from './learn-capture.mjs';

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

async function openQuietly(root, config) {
  process.removeAllListeners('warning'); // node:sqlite's experimental notice must never reach the chat
  const { openStore } = await import('./learn-store.mjs');
  return openStore(root, { busyMs: 3000, config });
}

const REASONS = { prompt: 'capture', stop: 'idle', precompact: 'before_compaction', end: 'session_end', start: 'session_start' };
// The prompt hook runs in front of every request and must be quick and silent: it stops after a few seconds' worth of batches (the read
// position is committed per batch, so the next boundary continues) and never starts the worker.
const PROMPT_BUDGET_MS = 3000;
// At these boundaries the saved read position is not trusted at all: everything is read again (records are unique by uuid).
const DESTRUCTIVE = new Set(['precompact', 'end', 'start']);

// Returns { ok, via: 'journal' | 'skipped' | 'none', code? }. `open` is a test seam.
export async function handleEvent(root, event, payload, now = Date.now(), start = startWorker, { open = openQuietly, scan = scanTranscript } = {}) {
  const config = loadConfig(root);
  if (!isEnabled(config) || process.env.AIVERSE_LEARN_REVIEW) return { ok: true, via: 'skipped' };
  if (!fs.existsSync(path.join(root, 'AI-VERSE.yaml'))) return { ok: true, via: 'skipped' };
  const reason = REASONS[event];
  const { session_id: sessionId, transcript_path: transcript } = payload;
  if (!reason || (event === 'stop' && payload.stop_hook_active)) return { ok: true, via: 'skipped' };
  if (typeof sessionId !== 'string' || !IDENTIFIER.test(sessionId) || !SAFE_PATH(transcript) || !transcript.endsWith('.jsonl')) {
    if (event === 'start') start(root);
    return { ok: true, via: 'skipped' };
  }
  const key = sessionKey(sessionId);
  let db = null;
  try {
    try {
      db = await open(root, config);
    } catch (error) {
      setStatus(root, ['store_incompatible', 'storage_unsafe'].includes(error?.code) ? error.code : 'store_unavailable');
      throw error;
    }
    const saved = db.prepare('SELECT path, off, anchor FROM captures WHERE session = ?').get(key);
    let cursor = !DESTRUCTIVE.has(event) && saved && saved.path === transcript ? { from: saved.off, anchor: saved.anchor } : { from: 0, anchor: '' };
    const { ingestBatch } = await import('./learn-store.mjs');
    let incomplete = false;
    const began = Date.now();
    for (let batches = 0; batches < 100000; batches += 1) {
      let scanned;
      try {
        scanned = scan(transcript, cursor);
      } catch {
        if (event === 'start') { start(root); return { ok: true, via: 'none' }; } // nothing to read yet at the start of a new chat
        throw new Error('transcript_unreadable');
      }
      const records = scanned.records.map((r) => ({ ...r, scope: resolveScope(root, r.cwd) })).filter((r) => r.scope !== null);
      const stored = ingestBatch(db, {
        key, session_id: sessionId, transcript_path: transcript, reason, at: now,
        config: { idle_seconds: config.idle_seconds, max_pending_turns: config.max_pending_turns }, records, gaps: scanned.gaps,
        offset: { path: transcript, end: scanned.end, anchor: scanned.anchor },
      }, now, () => isEnabled(loadConfig(root)));
      if (scanned.gaps.length) incomplete = true;
      if (!stored.purged) setStatus(root, 'wal_purge_pending'); // an old copy of a late-found credential may still be in the log; the worker retries
      if (scanned.done || (event === 'prompt' && Date.now() - began > PROMPT_BUDGET_MS)) break;
      cursor = { from: scanned.end, anchor: scanned.anchor };
    }
    setStatus(root, 'capture_failed', false);
    // coverage failures stay outstanding until resolved: the state follows the journal, not this scan
    setStatus(root, 'capture_incomplete', incomplete || db.prepare('SELECT COUNT(*) AS n FROM gaps WHERE resolved = 0').get().n > 0);
    if (event !== 'prompt') start(root);
    return { ok: true, via: 'journal' };
  } catch (error) {
    if (error?.code === 'disabled') return { ok: true, via: 'skipped' }; // switched off in the middle: nothing was written
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
    process.stderr.write('AI-Verse learning could not save this conversation (see runtime/learn/status.json); text compacted away now may not be learned.\n');
    return 1;
  }
  return 0;
}

if (isMain(import.meta.url)) main().catch(() => 1).then((code) => process.exit(code));
