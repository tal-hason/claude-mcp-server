#!/usr/bin/env node
// test/fixtures/fake-claude.js
// Emits stream-json lines mimicking Claude CLI output.
// Used by cli-executor-broadcast tests to avoid spawning real claude.

const lines = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'test-session-42', tools: [], model: 'claude-sonnet-5' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'First chunk' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second chunk' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/x.ts' } }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'Final answer', duration_ms: 200 }),
];

for (const line of lines) {
  process.stdout.write(line + '\n');
}

process.exit(0);
