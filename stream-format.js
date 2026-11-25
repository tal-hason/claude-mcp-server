#!/usr/bin/env node
// claude-mcp-server/stream-format.js
// @ai-rules:
// 1. [Pattern]: stdin filter — reads stream-json, outputs human-readable text with progress.
// 2. [Constraint]: Node built-ins only (node:readline, node:fs). Must work standalone without npm install.
// 3. [Pattern]: Skips tool_result events (massive file blobs) — shows only tool_use hints.
// 4. [Pattern]: Emits model/session progress to CLAUDE_PROGRESS_FD (non-blocking O_NONBLOCK FIFO in failover, stdout in non-failover).

import { createInterface } from 'node:readline';
import { openSync, writeSync, closeSync, fstatSync, constants } from 'node:fs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m', mag: '\x1b[35m' };
const TOOL_COLOR = { Read: C.green, Grep: C.cyan, Glob: C.cyan, Shell: C.yellow, Bash: C.yellow, Write: C.red, StrReplace: C.red, Edit: C.red, Delete: C.red };
const rawFd = Number.parseInt(process.env.CLAUDE_PROGRESS_FD || '', 10);
const useProgFd = Number.isInteger(rawFd) && rawFd > 2;
let progFd = useProgFd ? rawFd : 0, ownFd = false;
if (progFd) {
  try { if (fstatSync(progFd).isFIFO()) { progFd = openSync(`/proc/self/fd/${progFd}`, constants.O_WRONLY | constants.O_NONBLOCK); ownFd = true; } }
  catch (e) { if (e?.code !== 'ENOENT') progFd = 0; }
}

function redact(s) {
  return String(s ?? '')
    .replace(/-----BEGIN[^\r\n]*-----END[^\r\n]*/g, '[REDACTED_PEM]')
    .replace(/-----BEGIN[^\r\n]*(?:\r?\n(?:[A-Za-z0-9+/=]{16,}[ \t]*|[^\r\n]*[Bb]ase64[^\r\n]*))*(?:\r?\n-----END[^\r\n]*)?/g, '[REDACTED_PEM]')
    .replace(/((?:\\?['"])?\b(?:proxy-)?authorization(?:\\?['"])?[ \t]*:[ \t]*(?:[a-zA-Z0-9_-]+[ \t]+)?|\b(?:bearer|token)[ \t]+)(?:\\?"[^"\r\n]*(?:\\?"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s"'&]+)/gi, '$1[REDACTED]')
    .replace(/((?:\\?['"])?\b[a-zA-Z0-9_-]{0,128}(?:key|token|secret|password|credentials|private_key_id)(?:\\?['"])?\s*[=:]\s*)(?:\\?"[^"\r\n]*(?:\\?"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s"'&]+)/gi, '$1[REDACTED]')
    .replace(/(sk-ant-[a-zA-Z0-9_-]{4}|sk-proj-[a-zA-Z0-9_-]{4}|ya29\.[a-zA-Z0-9_-]{4}|gh[pousr]_[a-zA-Z0-9]{4}|github_pat_[a-zA-Z0-9_]{4}|glpat-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/g, '$1[REDACTED]')
    .replace(/ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_.-]{10,}/g, '[REDACTED_JWT]')
    .replace(/(--api[_-]?key(?:\s+|=)|[?&](?:key|api[_-]?key|token)=)[^\s"'&]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/[^\s/@:]+):[^\s/@]+@/g, '$1:[REDACTED]@')
    .replace(/((?:\\?['"])?cookie(?:\\?['"])?\s*[:=]\s*)(?:\\?"[^"\r\n]*(?:\\?"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s\r\n"'}]+)/gi, '$1[REDACTED]')
    .replace(/(cookie:[ \t]*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(\bresponse\s*=\s*)(?:\\?"[^"\r\n]*(?:\\?"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s"',&]+)/gi, '$1[REDACTED]')
    .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ');
}

function writeProgFd(s) {
  if (!progFd) return;
  const buf = Buffer.from(s);
  for (let off = 0; off < buf.length;) {
    try { const n = writeSync(progFd, buf, off, buf.length - off); if (n <= 0) return; off += n; }
    catch (e) { if (e?.code !== 'EAGAIN') progFd = 0; return; }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let lastCharWasNewline = true, inPem = false;
function write(s) {
  if (!s) return;
  process.stdout.write(s);
  lastCharWasNewline = s.endsWith('\n');
}
function ensureNewline() {
  if (!lastCharWasNewline) write('\n');
}
const writeProgress = (s) => (useProgFd ? writeProgFd(s) : (ensureNewline(), write(s)));

for await (const line of rl) {
  if (!line.trim()) continue;
  let obj; try { obj = JSON.parse(line); } catch { obj = null; }
  if (!obj || typeof obj !== 'object') {
    if (/-----BEGIN[^\r\n]*-----END/.test(line)) { inPem = false; ensureNewline(); write(redact(line) + '\n'); continue; }
    if (/-----BEGIN/.test(line)) { if (!inPem) { ensureNewline(); write('[REDACTED_PEM]\n'); } inPem = true; continue; }
    if (inPem) {
      if (/-----END/.test(line)) { inPem = false; continue; }
      if (/^[A-Za-z0-9+/=]{16,}$|[Bb]ase64/.test(line.trim())) continue;
      inPem = false;
    }
    ensureNewline(); write(redact(line) + '\n');
    continue;
  }
  inPem = false;
  if (obj.type === 'system' && obj.subtype === 'init') {
    writeProgress(`${C.mag}⚡ model: ${redact(obj.model || 'unknown').slice(0, 64)} | session: ${redact(obj.session_id || 'n/a').slice(0, 64)}${C.reset}\n`);
  } else if (obj.type === 'system' && obj.subtype === 'api_retry') {
    writeProgress(`${C.dim}${C.yellow}↻ retry ${redact(obj.attempt ?? '?').slice(0, 16)}/${redact(obj.max_retries ?? '?').slice(0, 16)}${C.reset}\n`);
  } else if (obj.type === 'assistant' && obj.message?.content) {
    let msgStart = true;
    for (const block of obj.message.content) {
      if (block.type === 'text' && block.text) { if (msgStart) { ensureNewline(); msgStart = false; } write(block.text); }
      else if (block.type === 'tool_use' && block.name) {
        const inp = block.input || {}, raw = inp.file_path || inp.command || inp.pattern || inp.query || '';
        const cap = !inp.file_path && !inp.command && !inp.pattern && inp.query ? 80 : 120;
        const hint = raw ? redact(raw).slice(0, cap) : '';
        writeProgress(`${C.dim}${TOOL_COLOR[block.name] || C.blue}⏵ ${block.name}${hint ? `: ${hint}` : ''}${C.reset}\n`);
      }
    }
  } else if (obj.type === 'result' && obj.is_error && obj.result) {
    const res = typeof obj.result === 'string' ? obj.result : JSON.stringify(obj.result);
    ensureNewline(); write(`${redact(res)}\n`);
  } else if (obj.type === 'error') {
    ensureNewline(); write(`API Error: ${redact(obj.error?.message || obj.message || JSON.stringify(obj))}\n`);
  }
}
ensureNewline();
if (ownFd && progFd) { try { closeSync(progFd); } catch {} }
