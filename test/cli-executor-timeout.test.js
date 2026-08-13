// test/cli-executor-timeout.test.js
// @ai-rules:
// 1. [Pattern]: Verifies the manual timeout timer in cli-executor.js attributes kills correctly.
// 2. [Constraint]: Uses CLAUDE_BIN env var (not PATH) to point at a fixture that hangs indefinitely.
// 3. [Gotcha]: CLAUDE_BIN is read at module load time — must be set in `before()` before any import.
//    Node's test runner isolates each test file into its own process, so this doesn't leak into
//    the PATH-based fixture used by cli-executor-broadcast.test.js.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const slowFixture = join(__dirname, 'fixtures', 'fake-claude-slow.js');

before(() => {
  process.env.CLAUDE_BIN = slowFixture;
});

async function loadExecutor() {
  const mod = await import('../cli-executor.js');
  return mod.executeClaude;
}

describe('cli-executor timeout attribution', () => {
  it('kills the process after timeoutMs and marks the result as timed out', async () => {
    const executeClaude = await loadExecutor();
    const broadcasts = [];

    const result = await executeClaude({
      prompt: 'test',
      timeoutMs: 300,
      onBroadcast: (msg) => broadcasts.push(msg),
    });

    assert.equal(result.timedOut, true);
    assert.match(result.output, /\[TIMEOUT: killed after 300ms/);

    const doneEvent = broadcasts.find((m) => m?.type === 'status' && m.state === 'done');
    assert.ok(doneEvent, 'Expected a done status broadcast');
    assert.equal(doneEvent.timedOut, true);
  });
});
