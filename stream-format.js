#!/usr/bin/env node
// claude-mcp-server/stream-format.js
// @ai-rules:
// 1. [Pattern]: stdin filter — reads stream-json, outputs human-readable text with progress (or --flush-err for bounded stderr flush).
// 2. [Constraint]: Node built-ins + ./redact.js only. Must work standalone without npm install, <= 100 lines.
// 3. [Pattern]: Skips tool_result events (massive file blobs) — shows only tool_use hints.
// 4. [Pattern]: Emits model/session progress to CLAUDE_PROGRESS_FD (non-blocking FIFO / bounded Socket in failover, stdout in non-failover).

import { createInterface } from 'node:readline';
import { openSync, writeSync, closeSync, fstatSync, constants } from 'node:fs';
import { Socket } from 'node:net';
import { asStr, redact, isPemBodyLine, readNbFlag, flushStderr } from './redact.js';

if (process.argv[2] === '--flush-err') {
  flushStderr();
} else {
  const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m', mag: '\x1b[35m' };
  const TOOL_COLOR = new Map([
    ['Read', C.green], ['Grep', C.cyan], ['Glob', C.cyan], ['Shell', C.yellow], ['Bash', C.yellow], ['Write', C.red], ['StrReplace', C.red], ['Edit', C.red], ['Delete', C.red],
  ]);
  const rawFd = Number.parseInt(process.env.CLAUDE_PROGRESS_FD || '', 10);
  const useProgFd = Number.isInteger(rawFd) && rawFd > 2;
  let progFd = useProgFd ? rawFd : 0, ownFd = false, progSock = null, wasSockNb = false;
  const restoreSock = () => { if (progSock && !wasSockNb) progSock?._handle?.setBlocking?.(true); };
  const openSock = () => {
    wasSockNb = readNbFlag(rawFd);
    progSock = new Socket({ fd: rawFd, readable: false, writable: true });
    progSock.unref(); process.on('exit', restoreSock);
    progSock.on('error', () => { restoreSock(); progSock = null; });
  };
  if (progFd) {
    try {
      const st = fstatSync(progFd);
      if (st.isFIFO()) {
        try { progFd = openSync(`/proc/self/fd/${progFd}`, constants.O_WRONLY | constants.O_NONBLOCK); ownFd = true; }
        catch (e) { progFd = 0; if (e?.code === 'ENOENT') openSock(); }
      } else if (st.isSocket()) { openSock(); progFd = 0; }
    } catch { progFd = 0; }
  }

  function writeProgFd(s) {
    if (progSock) { if (!progSock.destroyed && progSock.writableLength < 16384) progSock.write(s); return; }
    if (!progFd) return;
    const buf = Buffer.from(s);
    try { writeSync(progFd, buf, 0, buf.length); }
    catch (e) { if (e?.code !== 'EAGAIN') { if (ownFd) { try { closeSync(progFd); } catch {} ownFd = false; } progFd = 0; } }
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
      if (inPem) { if (/-----END/.test(line)) { inPem = false; continue; } if (isPemBodyLine(line)) continue; inPem = false; }
      ensureNewline(); write(redact(line) + '\n'); continue;
    }
    inPem = false;
    if (obj.type === 'system' && obj.subtype === 'init') {
      const m = redact(asStr(obj.model || 'unknown').slice(0, 256)).slice(0, 64), sid = redact(asStr(obj.session_id || 'n/a').slice(0, 256)).slice(0, 64);
      writeProgress(`${C.mag}⚡ model: ${m} | session: ${sid}${C.reset}\n`);
    } else if (obj.type === 'system' && obj.subtype === 'api_retry') {
      const a = redact(asStr(obj.attempt ?? '?').slice(0, 64)).slice(0, 16), mr = redact(asStr(obj.max_retries ?? '?').slice(0, 64)).slice(0, 16);
      writeProgress(`${C.dim}${C.yellow}↻ retry ${a}/${mr}${C.reset}\n`);
    } else if (obj.type === 'assistant' && obj.message?.content) {
      let msgStart = true;
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) { if (msgStart) { ensureNewline(); msgStart = false; } write(block.text); }
        else if (block.type === 'tool_use' && block.name) {
          const inp = block.input || {}, raw = inp.file_path || inp.command || inp.pattern || inp.query || '';
          const cap = !inp.file_path && !inp.command && !inp.pattern && inp.query ? 80 : 120;
          const tName = redact(asStr(block.name).slice(0, 256)).slice(0, 64), hint = raw ? redact(asStr(raw).slice(0, cap + 512)).slice(0, cap) : '';
          const tc = (typeof block.name === 'string' && TOOL_COLOR.get(block.name)) || C.blue;
          writeProgress(`${C.dim}${tc}⏵ ${tName}${hint ? `: ${hint}` : ''}${C.reset}\n`);
        }
      }
    } else if (obj.type === 'result' && obj.is_error && obj.result) { ensureNewline(); write(`${redact(asStr(obj.result))}\n`); }
    else if (obj.type === 'error') { ensureNewline(); write(`API Error: ${redact(asStr(obj.error?.message || obj.message || obj))}\n`); }
  }
  ensureNewline();
  if (progSock && !progSock.destroyed && progSock.writableLength > 0) {
    await Promise.race([new Promise((r) => progSock.once('drain', r)), new Promise((r) => { const t = setTimeout(r, 50); t.unref?.(); })]);
  }
  restoreSock(); if (ownFd && progFd) { try { closeSync(progFd); } catch {} }
  if (progSock && progSock.writableLength > 0) {
    if (process.stdout.writableLength > 0) await new Promise((r) => process.stdout.write('', r));
    restoreSock(); process.exit(0);
  }
}
