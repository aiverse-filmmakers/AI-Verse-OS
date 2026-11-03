// Reads a Claude Code transcript (JSONL) into a bounded, ordered window of messages for the reviewer. Nothing is written here.
//
// A transcript is identified by a fingerprint (its first line), not by a number: a replaced transcript is a different source
// with its own cursor. A cursor is (line, part). Messages are never cut: a message longer than the window is delivered in
// numbered parts across following windows. The anchor (hash of the last line already reviewed) proves that the lines before
// the cursor are still the lines that were reviewed.

import fs from 'node:fs';
import { sha } from './learn-common.mjs';

export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const ASSISTANT_MAX = 800;
const MIN_ELIGIBLE = 12;
const HARNESS_TEXT = /^\s*<(?:command-|local-command|system-reminder|user-prompt-submit-hook|bash-|task-notification)|^\s*\[Request interrupted/i;

export const lineHash = (line) => sha(line, 16);

export function readLines(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript_unreadable');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.pop(); // empty, or a partial line still being written
  return lines;
}

export const fingerprint = (lines) => (lines.length ? sha(lines[0]) : null);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function toMessage(entry, line) {
  if (!entry || entry.isSidechain || entry.isMeta || !['user', 'assistant'].includes(entry.type)) return null;
  let text = textOf(entry.message?.content).trim();
  if (!text || (entry.type === 'user' && HARNESS_TEXT.test(text))) return null;
  if (entry.type === 'assistant' && text.length > ASSISTANT_MAX) text = `${text.slice(0, ASSISTANT_MAX)} [trimmed]`;
  return { id: entry.uuid || `L${line}`, role: entry.type, text, line, cwd: entry.cwd };
}

export const isEligible = (message) => message.role === 'user' && message.text.length >= MIN_ELIGIBLE && !message.text.startsWith('/');

// Pieces of at most `max` characters, cut at a line or sentence end when one is near.
export function splitText(text, max) {
  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. '));
    const at = cut > max * 0.6 ? cut + 1 : max;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces;
}

// Stops at `budget` characters, or when a user message belongs to another scope. A window only ever holds one scope.
export function readWindow(lines, cursor, budget, scopeOf) {
  const messages = [];
  let used = 0;
  let scope = null;
  let skipped = 0;
  let line = cursor.line;
  let part = cursor.part;
  scan: for (; line < lines.length; line += 1, part = 0) {
    let entry = null;
    try {
      entry = JSON.parse(lines[line]);
    } catch {}
    const message = toMessage(entry, line);
    if (!message) continue;
    const own = scopeOf(message.cwd);
    if (message.role === 'user') {
      if (own === null) { skipped += 1; continue; }
      if (scope && own !== scope) break;
      scope = own;
    } else if (own === null || own !== scope) {
      continue; // assistant text from another scope (or before any scope is known) never joins this window
    }
    const pieces = message.role === 'user' ? splitText(message.text, budget) : [message.text];
    for (let k = part; k < pieces.length; k += 1) {
      if (messages.length && used + pieces[k].length > budget) { part = k; break scan; }
      messages.push({ id: pieces.length > 1 ? `${message.id}#${k + 1}` : message.id, role: message.role, text: pieces[k], full: pieces.length > 1 ? message.text : undefined, line });
      used += pieces[k].length;
    }
  }
  const anchorLine = part > 0 ? line : line - 1;
  return {
    messages, scope: scope ?? 'unscoped', next: { line, part }, atEnd: line >= lines.length, skipped,
    anchor_line: anchorLine >= 0 && anchorLine < lines.length ? anchorLine : -1,
    anchor: anchorLine >= 0 && anchorLine < lines.length ? lineHash(lines[anchorLine]) : '',
    hasEligible: messages.some(isEligible),
  };
}

// The window of one source from the live transcript. Returns null when it cannot be read or is a different transcript, and
// { replaced: true } when the lines before the cursor are no longer the lines that were reviewed (the caller starts over
// at line 0 of what is there now and records that history was replaced).
export function readSource(source, livePath, budget, scopeOf) {
  let lines;
  try {
    lines = readLines(livePath);
  } catch {
    return null;
  }
  if (fingerprint(lines) !== source.fp) return null;
  if (source.line > lines.length || (source.anchor_line >= 0 && (source.anchor_line >= lines.length || lineHash(lines[source.anchor_line]) !== source.anchor))) return { replaced: true };
  return readWindow(lines, { line: source.line, part: source.part }, budget, scopeOf);
}
