#!/usr/bin/env node
// test/fixtures/fake-claude-slow.js
// Emits an init line immediately, then hangs indefinitely — simulates a large file read
// that exceeds the caller's timeoutMs. Exits promptly on SIGTERM so the escalation-to-SIGKILL
// timer in cli-executor.js is never needed, keeping the timeout test fast.

process.on('SIGTERM', () => process.exit(1));

process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'init', session_id: 'slow-session', tools: [], model: 'claude-opus-4-6',
}) + '\n');

setInterval(() => {}, 1000);
