#!/usr/bin/env node
// claude-mcp-server/stream-format.js
// @ai-rules:
// 1. [Pattern]: stdin filter — reads stream-json, outputs human-readable text with progress.
// 2. [Constraint]: Zero deps — only node:readline. Must work standalone without npm install.
// 3. [Pattern]: Skips tool_result events (massive file blobs) — shows only tool_use hints.
// 4. [Pattern]: Emits session ID + model on first line for agent extraction.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let resultPrinted = false;

for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const obj = JSON.parse(line);

    if (obj.type === 'system' && obj.subtype === 'init') {
      const model = obj.model || 'unknown';
      const sid = obj.session_id || 'n/a';
      process.stdout.write(`\x1b[2m⚡ model: ${model} | session: ${sid}\x1b[0m\n`);
      continue;
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'text' && block.text) {
          process.stdout.write(block.text);
        } else if (block.type === 'tool_use' && block.name) {
          const hint = block.input?.file_path
            || block.input?.command?.slice(0, 120)
            || block.input?.pattern
            || block.input?.query?.slice(0, 80)
            || '';
          process.stdout.write(`\x1b[2m⏵ ${block.name}${hint ? `: ${hint}` : ''}\x1b[0m\n`);
        }
      }
      continue;
    }

    if (obj.type === 'result' && obj.result && !resultPrinted) {
      resultPrinted = true;
      continue;
    }
  } catch {
    process.stdout.write(line + '\n');
  }
}
