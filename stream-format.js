#!/usr/bin/env node
// claude-mcp-server/stream-format.js
// @ai-rules:
// 1. [Pattern]: stdin filter — reads stream-json, outputs human-readable text with progress.
// 2. [Constraint]: Zero deps — only node:readline. Must work standalone without npm install.
// 3. [Pattern]: Skips tool_result events (massive file blobs) — shows only tool_use hints.
// 4. [Pattern]: Emits session ID + model on first line for agent extraction.

import { createInterface } from 'node:readline';

const C = {
  reset: '\x1b[0m',
  dim:   '\x1b[2m',
  cyan:  '\x1b[36m',
  green: '\x1b[32m',
  yellow:'\x1b[33m',
  red:   '\x1b[31m',
  blue:  '\x1b[34m',
  mag:   '\x1b[35m',
};

const TOOL_COLOR = {
  Read:       C.green,
  Grep:       C.cyan,
  Glob:       C.cyan,
  Shell:      C.yellow,
  Write:      C.red,
  StrReplace: C.red,
  Delete:     C.red,
};

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

for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const obj = JSON.parse(line);

    if (obj.type === 'system' && obj.subtype === 'init') {
      const model = obj.model || 'unknown';
      const sid = obj.session_id || 'n/a';
      write(`${C.mag}⚡ model: ${model} | session: ${sid}${C.reset}\n`);
      continue;
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) {
          write(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          ensureNewline();
          const hint = block.input?.file_path
            || block.input?.command?.slice(0, 120)
            || block.input?.pattern
            || block.input?.query?.slice(0, 80)
            || '';
          const tc = TOOL_COLOR[block.name] || C.blue;
          write(`${C.dim}${tc}⏵ ${block.name}${hint ? `: ${hint}` : ''}${C.reset}\n`);
        }
      }
      continue;
    }

    if (obj.type === 'result') {
      continue;
    }
  } catch {
    write(line + '\n');
  }
}
