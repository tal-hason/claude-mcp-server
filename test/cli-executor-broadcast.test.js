// test/cli-executor-broadcast.test.js
// @ai-rules:
// 1. [Pattern]: Tests onBroadcast callback integration in cli-executor.js.
// 2. [Constraint]: Uses a fake-claude fixture via PATH override — no mock.module needed.
// 3. [Gotcha]: cli-executor uses module-level _activeChild state — tests MUST run serially (default).
// 4. [Gotcha]: onBroadcast must NOT be debounced (unlike onProgress which is 500ms debounced).
// 5. [Gotcha]: PATH trick works because spawn('claude', ...) resolves via PATH.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, 'fixtures');

before(() => {
  process.env.PATH = `${fixturesDir}:${process.env.PATH}`;
});

async function loadExecutor() {
  const mod = await import('../cli-executor.js');
  return mod.executeClaude;
}

describe('cli-executor onBroadcast', () => {
  it('onBroadcast receives every parsed stream line (not debounced)', async () => {
    const executeClaude = await loadExecutor();
    const broadcasts = [];

    await executeClaude({
      prompt: 'test',
      onBroadcast: (msg) => broadcasts.push(msg),
    });

    const textBroadcasts = broadcasts.filter(
      (m) => typeof m === 'string'
        ? m.length > 0
        : (m?.text || m?.content)
    );
    assert.ok(
      textBroadcasts.length >= 3,
      `Expected >=3 content broadcasts (2 text + 1 tool), got ${textBroadcasts.length}: ${JSON.stringify(textBroadcasts)}`
    );
  });

  it('onBroadcast receives a start/running status message', async () => {
    const executeClaude = await loadExecutor();
    const broadcasts = [];

    await executeClaude({
      prompt: 'test',
      onBroadcast: (msg) => broadcasts.push(msg),
    });

    const hasStart = broadcasts.some((m) => {
      if (typeof m === 'object' && m !== null) {
        return m.state === 'running' || m.status === 'start'
          || (m.type === 'status' && (m.state === 'running' || m.status === 'start'));
      }
      return typeof m === 'string' && /start|running/i.test(m);
    });
    assert.ok(hasStart, `Expected a start/running status broadcast. Got: ${JSON.stringify(broadcasts.slice(0, 3))}`);
  });

  it('onBroadcast receives a done status message', async () => {
    const executeClaude = await loadExecutor();
    const broadcasts = [];

    await executeClaude({
      prompt: 'test',
      onBroadcast: (msg) => broadcasts.push(msg),
    });

    const hasDone = broadcasts.some((m) => {
      if (typeof m === 'object' && m !== null) {
        return m.state === 'done' || (m.type === 'status' && m.state === 'done');
      }
      return typeof m === 'string' && /done|complete/i.test(m);
    });
    assert.ok(hasDone, `Expected a done status broadcast. Got last 3: ${JSON.stringify(broadcasts.slice(-3))}`);
  });

  it('onBroadcast receives a one-shot model event from the CLI-resolved model', async () => {
    const executeClaude = await loadExecutor();
    const broadcasts = [];

    await executeClaude({
      prompt: 'test',
      onBroadcast: (msg) => broadcasts.push(msg),
    });

    const modelEvents = broadcasts.filter((m) => m?.type === 'model');
    assert.equal(modelEvents.length, 1, `Expected exactly one model event, got: ${JSON.stringify(modelEvents)}`);
    assert.equal(modelEvents[0].model, 'claude-sonnet-5');
  });

  it('execution works without onBroadcast (backward compat)', async () => {
    const executeClaude = await loadExecutor();

    const result = await executeClaude({ prompt: 'test' });

    assert.ok(result.output.length > 0, 'Expected non-empty output');
    assert.equal(result.sessionId, 'test-session-42');
    assert.equal(result.exitCode, 0);
  });

  it('onBroadcast undefined does not throw', async () => {
    const executeClaude = await loadExecutor();

    await assert.doesNotReject(
      executeClaude({ prompt: 'test', onBroadcast: undefined })
    );
  });

  it('onBroadcast receives more messages than debounced onProgress', async () => {
    const executeClaude = await loadExecutor();
    const progressCalls = [];
    const broadcastCalls = [];

    await executeClaude({
      prompt: 'test',
      onProgress: (msg) => progressCalls.push(msg),
      onBroadcast: (msg) => broadcastCalls.push(msg),
    });

    assert.ok(
      broadcastCalls.length >= progressCalls.length,
      `onBroadcast (${broadcastCalls.length}) should have >= onProgress (${progressCalls.length}) calls`
    );
  });
});
