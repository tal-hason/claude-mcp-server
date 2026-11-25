#!/usr/bin/env node
// claude-mcp-server/stream-format.js
// @ai-rules:
// 1. [Pattern]: stdin filter — reads stream-json, outputs human-readable text with progress.
// 2. [Constraint]: Node built-ins only (node:readline, node:fs, node:net). Must work standalone without npm install.
// 3. [Pattern]: Skips tool_result events (massive file blobs) — shows only tool_use hints.
// 4. [Pattern]: Emits model/session progress to CLAUDE_PROGRESS_FD (non-blocking FIFO / bounded Socket in failover, stdout in non-failover).

import { createInterface } from 'node:readline';
import { openSync, writeSync, closeSync, fstatSync, constants } from 'node:fs';
import { Socket } from 'node:net';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m', mag: '\x1b[35m' };
const TOOL_COLOR = { Read: C.green, Grep: C.cyan, Glob: C.cyan, Shell: C.yellow, Bash: C.yellow, Write: C.red, StrReplace: C.red, Edit: C.red, Delete: C.red };
const rawFd = Number.parseInt(process.env.CLAUDE_PROGRESS_FD || '', 10);
const useProgFd = Number.isInteger(rawFd) && rawFd > 2;
let progFd = useProgFd ? rawFd : 0, ownFd = false, progSock = null;
if (progFd) {
  try {
    const st = fstatSync(progFd);
    if (st.isFIFO()) {
      try { progFd = openSync(`/proc/self/fd/${progFd}`, constants.O_WRONLY | constants.O_NONBLOCK); ownFd = true; }
      catch (e) { progFd = 0; if (e?.code === 'ENOENT') progSock = new Socket({ fd: rawFd, readable: false, writable: true }); }
    } else if (st.isSocket()) { progSock = new Socket({ fd: rawFd, readable: false, writable: true }); progFd = 0; }
  } catch { progFd = 0; }
  if (progSock) { progSock.on('error', () => { progSock = null; }); progSock.unref(); }
}

const asStr = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
const QV = "(?:\\\\?\"[^\"\\r\\n]*(?:\\\\?\"|(?=\\r|\\n|$))|'[^'\\r\\n]*(?:'|(?=\\r|\\n|$))|";
const RE_PEM1 = /[ \t]*-----BEGIN[^\r\n]*-----END[^\r\n]*/g;
const RE_PEM2 = /[ \t]*-----BEGIN[^\r\n]*(?:\r?\n(?:[ \t]*[A-Za-z0-9+/=]+[ \t]*(?=\r|\n|$)|[^\r\n]*[Bb]ase64[^\r\n]*))*(?:\r?\n[ \t]*-----END[^\r\n]*)?/g;
const RE_AUTH = new RegExp(`((?:\\\\?['"])?\\b(?:proxy-)?authorization(?:\\\\?['"])?[ \\t]*:[ \\t]*(?:[a-zA-Z0-9_-]+[ \\t]+)?|\\b(?:bearer|token)[ \\t]+)${QV}[^\\s"'&]+)`, 'gi');
const RE_KEY = new RegExp(`((?:\\\\?['"])?\\b[a-zA-Z0-9_-]{0,128}(?:key|token|secret|password|credentials|private_key_id)(?:\\\\?['"])?\\s*[=:]\\s*)${QV}[^\\s"'&]+)`, 'gi');
const RE_TOK = /(sk-ant-[a-zA-Z0-9_-]{4}|sk-proj-[a-zA-Z0-9_-]{4}|ya29\.[a-zA-Z0-9_-]{4}|gh[pousr]_[a-zA-Z0-9]{4}|github_pat_[a-zA-Z0-9_]{4}|glpat-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/g;
const RE_JWT = /ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_.-]{10,}/g;
const RE_URL = /(--api[_-]?key(?:\s+|=)|[?&](?:key|api[_-]?key|token)=)[^\s"'&]+/gi;
const RE_BAUTH = /(https?:\/\/[^\s/@:]+):[^\s/@]+@/g;
const RE_COOKIE = new RegExp(`((?:\\\\?['"])?cookie(?:\\\\?['"])?\\s*[:=]\\s*)${QV}[^\\s\\r\\n"'}]+)`, 'gi');
const RE_RESP = new RegExp(`(\\bresponse\\s*=\\s*)${QV}[^\\s"',&]+)`, 'gi');
const RE_CTRL = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[\r\n\x00-\x1f\x7f]+/g;

function redact(s) {
  return asStr(s).replace(RE_PEM1, '[REDACTED_PEM]').replace(RE_PEM2, '[REDACTED_PEM]')
    .replace(RE_AUTH, '$1[REDACTED]').replace(RE_KEY, '$1[REDACTED]').replace(RE_TOK, '$1[REDACTED]').replace(RE_JWT, '[REDACTED_JWT]')
    .replace(RE_URL, '$1[REDACTED]').replace(RE_BAUTH, '$1:[REDACTED]@').replace(RE_COOKIE, '$1[REDACTED]')
    .replace(/(cookie:[ \t]*)[^\r\n]+/gi, '$1[REDACTED]').replace(RE_RESP, '$1[REDACTED]').replace(RE_CTRL, ' ');
}

function writeProgFd(s) {
  if (progSock) { if (!progSock.destroyed && progSock.writableLength < 16384) progSock.write(s); return; }
  if (!progFd) return;
  const buf = Buffer.from(s);
  try { writeSync(progFd, buf, 0, buf.length); } catch (e) { if (e?.code !== 'EAGAIN') progFd = 0; }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let lastCharWasNewline = true, inPem = false;
const write = (s) => { if (!s) return; process.stdout.write(s); lastCharWasNewline = s.endsWith('\n'); };
const ensureNewline = () => { if (!lastCharWasNewline) write('\n'); };
const writeProgress = (s) => (useProgFd ? writeProgFd(s) : (ensureNewline(), write(s)));

for await (const line of rl) {
  if (!line.trim()) continue;
  let obj; try { obj = JSON.parse(line); } catch { obj = null; }
  if (!obj || typeof obj !== 'object') {
    if (/-----BEGIN[^\r\n]*-----END/.test(line)) { inPem = false; ensureNewline(); write(redact(line) + '\n'); continue; }
    if (/-----BEGIN/.test(line)) { if (!inPem) { ensureNewline(); write('[REDACTED_PEM]\n'); } inPem = true; continue; }
    if (inPem) {
      if (/-----END/.test(line)) { inPem = false; continue; }
      if (/^[ \t]*[A-Za-z0-9+/=]+[ \t]*$|[Bb]ase64/.test(line)) continue;
      inPem = false;
    }
    ensureNewline(); write(redact(line) + '\n');
    continue;
  }
  inPem = false;
  if (obj.type === 'system' && obj.subtype === 'init') {
    const m = redact(asStr(obj.model || 'unknown')).slice(0, 64), sid = redact(asStr(obj.session_id || 'n/a')).slice(0, 64);
    writeProgress(`${C.mag}⚡ model: ${m} | session: ${sid}${C.reset}\n`);
  } else if (obj.type === 'system' && obj.subtype === 'api_retry') {
    writeProgress(`${C.dim}${C.yellow}↻ retry ${redact(asStr(obj.attempt ?? '?')).slice(0, 16)}/${redact(asStr(obj.max_retries ?? '?')).slice(0, 16)}${C.reset}\n`);
  } else if (obj.type === 'assistant' && obj.message?.content) {
    let msgStart = true;
    for (const block of obj.message.content) {
      if (block.type === 'text' && block.text) { if (msgStart) { ensureNewline(); msgStart = false; } write(block.text); }
      else if (block.type === 'tool_use' && block.name) {
        const inp = block.input || {}, raw = inp.file_path || inp.command || inp.pattern || inp.query || '';
        const cap = !inp.file_path && !inp.command && !inp.pattern && inp.query ? 80 : 120;
        const tName = redact(asStr(block.name)).slice(0, 64), hint = raw ? redact(asStr(raw)).slice(0, cap) : '';
        const tc = (typeof block.name === 'string' && TOOL_COLOR[block.name]) || C.blue;
        writeProgress(`${C.dim}${tc}⏵ ${tName}${hint ? `: ${hint}` : ''}${C.reset}\n`);
      }
    }
  } else if (obj.type === 'result' && obj.is_error && obj.result) { ensureNewline(); write(`${redact(asStr(obj.result))}\n`); }
  else if (obj.type === 'error') { ensureNewline(); write(`API Error: ${redact(asStr(obj.error?.message || obj.message || obj))}\n`); }
}
ensureNewline();
if (progSock?.writableLength > 0) progSock.destroy();
if (ownFd && progFd) { try { closeSync(progFd); } catch {} }
