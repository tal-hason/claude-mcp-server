#!/usr/bin/env node
// claude-mcp-server/stream-format.js
// @ai-rules:
// 1. [Pattern]: stdin filter — reads stream-json, outputs human-readable text with progress.
// 2. [Constraint]: Node built-ins only (node:readline, node:fs). Must work standalone without npm install.
// 3. [Pattern]: Skips tool_result events (massive file blobs) — shows only tool_use hints.
// 4. [Pattern]: Emits model/session progress to CLAUDE_PROGRESS_FD (stderr in failover, stdout in non-failover).

import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', blue: '\x1b[34m', mag: '\x1b[35m' };
const TOOL_COLOR = { Read: C.green, Grep: C.cyan, Glob: C.cyan, Shell: C.yellow, Bash: C.yellow, Write: C.red, StrReplace: C.red, Edit: C.red, Delete: C.red };
const rawFd = Number.parseInt(process.env.CLAUDE_PROGRESS_FD || '', 10);
const progFd = Number.isInteger(rawFd) && rawFd > 0 ? rawFd : 0;

function redact(s) {
  return String(s ?? '')
    .replace(/-----BEGIN[\s\S]*?-----END[^\r\n]*/g, '[REDACTED_PEM]')
    .replace(/((?:\\?['"])?\b(?:proxy-)?authorization(?:\\?['"])?[ \t]*:[ \t]*(?:[a-zA-Z0-9_-]+[ \t]+)?|\b(?:bearer|token)[ \t]+)(?:\\?"[^"\r\n]*(?:\\?"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s"'&]+)/gi, '$1[REDACTED]')
    .replace(/((?:\\?['"])?\b[a-zA-Z0-9_-]{0,128}(?:key|token|secret|password|credentials|private_key_id)(?:\\?['"])?\s*[=:]\s*)(?:\\?"[^"\r\n]*(?:\\?"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s"'&]+)/gi, '$1[REDACTED]')
    .replace(/(sk-ant-[a-zA-Z0-9_-]{4}|sk-proj-[a-zA-Z0-9_-]{4}|ya29\.[a-zA-Z0-9_-]{4}|gh[pousr]_[a-zA-Z0-9]{4}|github_pat_[a-zA-Z0-9_]{4}|glpat-[a-zA-Z0-9_-]{4})[a-zA-Z0-9_-]+/g, '$1[REDACTED]')
    .replace(/ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_.-]{10,}/g, '[REDACTED_JWT]')
    .replace(/(--api[_-]?key(?:\s+|=)|[?&](?:key|api[_-]?key|token)=)[^\s"'&]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/[^\s/@:]+):[^\s/@]+@/g, '$1:[REDACTED]@')
    .replace(/(["']?cookie["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s\r\n"'}]+)/gi, '$1[REDACTED]')
    .replace(/(cookie:[ \t]*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/(\bresponse\s*=\s*)(?:"[^"\r\n]*(?:"|(?=\r|\n|$))|'[^'\r\n]*(?:'|(?=\r|\n|$))|[^\s"',&]+)/gi, '$1[REDACTED]')
    .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ');
}

function writeAllFd(fd, s) {
  const buf = Buffer.from(s);
  for (let off = 0, tries = 0; off < buf.length;) {
    try { const n = writeSync(fd, buf, off, buf.length - off); if (n <= 0) return; off += n; tries = 0; }
    catch (e) { if (e?.code === 'EAGAIN' && ++tries <= 32) continue; return; }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let lastCharWasNewline = true;
function write(s) {
  if (!s) return;
  process.stdout.write(s);
  lastCharWasNewline = s.endsWith('\n');
}
function ensureNewline() {
  if (!lastCharWasNewline) write('\n');
}
const writeProgress = (s) => (progFd > 0 ? writeAllFd(progFd, s) : (ensureNewline(), write(s)));

for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'system' && obj.subtype === 'init') {
      writeProgress(`${C.mag}⚡ model: ${redact(obj.model || 'unknown').slice(0, 64)} | session: ${redact(obj.session_id || 'n/a').slice(0, 64)}${C.reset}\n`);
      continue;
    }
    if (obj.type === 'system' && obj.subtype === 'api_retry') {
      writeProgress(`${C.dim}${C.yellow}↻ retry ${obj.attempt ?? '?'}/${obj.max_retries ?? '?'}${C.reset}\n`);
      continue;
    }
    if (obj.type === 'assistant' && obj.message?.content) {
      let msgStart = true;
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) {
          if (msgStart) { ensureNewline(); msgStart = false; }
          write(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          const inp = block.input || {};
          const raw = inp.file_path || inp.command || inp.pattern || inp.query || '';
          const cap = !inp.file_path && !inp.command && !inp.pattern && inp.query ? 80 : 120;
          const hint = raw ? redact(raw).slice(0, cap) : '';
          writeProgress(`${C.dim}${TOOL_COLOR[block.name] || C.blue}⏵ ${block.name}${hint ? `: ${hint}` : ''}${C.reset}\n`);
        }
      }
      continue;
    }
    if (obj.type === 'result') {
      if (obj.is_error && obj.result) { ensureNewline(); write(`${redact(obj.result)}\n`); }
      continue;
    }
    if (obj.type === 'error') {
      ensureNewline(); write(`API Error: ${redact(obj.error?.message || obj.message || JSON.stringify(obj))}\n`);
      continue;
    }
  } catch {
    write(redact(line) + '\n');
  }
}
