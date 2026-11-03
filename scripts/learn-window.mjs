// Turns a Claude Code transcript (JSONL) into a bounded, ordered window of conversation messages for the reviewer.
// User messages keep their text, assistant messages are trimmed, tool traffic is dropped. Nothing is written here.

import fs from 'node:fs';

export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const USER_MAX = 4000;
const ASSISTANT_MAX = 800;
const MIN_ELIGIBLE = 12;
const HARNESS_TEXT = /^\s*<(?:command-|local-command|system-reminder|user-prompt-submit-hook|bash-|task-notification)|^\s*\[Request interrupted/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

function toMessage(entry, line) {
  if (!entry || entry.isSidechain || entry.isMeta || !['user', 'assistant'].includes(entry.type)) return null;
  const text = textOf(entry.message?.content).trim();
  if (!text || (entry.type === 'user' && HARNESS_TEXT.test(text))) return null;
  const max = entry.type === 'user' ? USER_MAX : ASSISTANT_MAX;
  return { id: entry.uuid || `L${line}`, role: entry.type, text: text.length > max ? `${text.slice(0, max)} [trimmed]` : text, line };
}

export const isEligible = (message) => message.role === 'user' && message.text.length >= MIN_ELIGIBLE && !message.text.startsWith('/');

// Reads from `fromLine` (lines already reviewed) and stops once `budget` characters are collected.
// `nextLine` is where the next window starts; `more` says the budget cut the range short.
export function readWindow(file, fromLine, budget) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) throw new Error('transcript is not a readable regular file within the size limit');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const complete = lines.length - 1; // the last element is empty or a partial line still being written
  const gap = fromLine > complete;
  let line = gap ? 0 : fromLine;
  const messages = [];
  let used = 0;
  for (; line < complete; line += 1) {
    let entry = null;
    try {
      entry = JSON.parse(lines[line]);
    } catch {}
    const message = toMessage(entry, line);
    if (!message) continue;
    if (messages.length && used + message.text.length > budget) break;
    messages.push(message);
    used += message.text.length;
  }
  return { messages, nextLine: line, more: line < complete, gap, hasEligible: messages.some(isEligible) };
}

// Lines [fromLine, end) as raw text, so a compaction cannot hide history from a later review.
export function copyTail(file, fromLine, limitBytes = 20 * 1024 * 1024) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const complete = lines.length - 1;
  const tail = lines.slice(Math.min(fromLine, complete), complete).join('\n');
  return Buffer.byteLength(tail) > limitBytes ? null : tail;
}
