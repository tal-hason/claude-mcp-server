// test/ws-bridge.test.js
// @ai-rules:
// 1. [Pattern]: Tests the WS bridge public interface: startWSBridge, broadcast, stopWSBridge.
// 2. [Constraint]: Uses node:test + node:assert. Needs `ws` package for client connections.
// 3. [Gotcha]: Uses WS_BRIDGE_PORT env var per test (unique ports to avoid conflicts).
// 4. [Gotcha]: WS server starts async — wait for 'listening' or small delay before connecting.
// 5. [Gotcha]: Module-level _wss state means tests must stopWSBridge between runs.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const clients = [];
let bridgeMod;

async function loadBridge() {
  if (!bridgeMod) {
    bridgeMod = await import('../ws-bridge.js');
  }
  return bridgeMod;
}

function setPort(port) {
  process.env.WS_BRIDGE_PORT = String(port);
}

function connectClient(port, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Connection to port ${port} timed out`));
    }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMessage(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('ws-bridge', () => {
  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    clients.length = 0;

    const { stopWSBridge } = await loadBridge();
    stopWSBridge();
    await sleep(50);
  });

  it('startWSBridge() starts a WS server accepting connections', async () => {
    const { startWSBridge } = await loadBridge();
    const port = 18200;
    setPort(port);

    startWSBridge();
    await sleep(100);

    const ws = await connectClient(port);
    clients.push(ws);

    assert.equal(ws.readyState, WebSocket.OPEN);
  });

  it('broadcast(data) sends JSON to a connected client', async () => {
    const { startWSBridge, broadcast } = await loadBridge();
    const port = 18201;
    setPort(port);

    startWSBridge();
    await sleep(100);

    const ws = await connectClient(port);
    clients.push(ws);

    const msgPromise = waitForMessage(ws);
    broadcast({ type: 'content', text: 'hello' });
    const received = await msgPromise;

    assert.deepEqual(received, { type: 'content', text: 'hello' });
  });

  it('broadcast(data) sends to multiple connected clients', async () => {
    const { startWSBridge, broadcast } = await loadBridge();
    const port = 18202;
    setPort(port);

    startWSBridge();
    await sleep(100);

    const ws1 = await connectClient(port);
    const ws2 = await connectClient(port);
    const ws3 = await connectClient(port);
    clients.push(ws1, ws2, ws3);

    const promises = [waitForMessage(ws1), waitForMessage(ws2), waitForMessage(ws3)];
    broadcast({ event: 'test', n: 42 });
    const results = await Promise.all(promises);

    for (const msg of results) {
      assert.deepEqual(msg, { event: 'test', n: 42 });
    }
  });

  it('broadcast() with no clients does not throw', async () => {
    const { startWSBridge, broadcast } = await loadBridge();
    const port = 18203;
    setPort(port);

    startWSBridge();
    await sleep(100);

    assert.doesNotThrow(() => {
      broadcast({ msg: 'no one is listening' });
    });
  });

  it('stopWSBridge() closes the server — new connections refused', async () => {
    const { startWSBridge, stopWSBridge } = await loadBridge();
    const port = 18204;
    setPort(port);

    startWSBridge();
    await sleep(100);
    stopWSBridge();
    await sleep(100);

    await assert.rejects(
      () => connectClient(port, 500),
      (err) => {
        const msg = err.message || err.code || '';
        return msg.includes('ECONNREFUSED') || msg.includes('timed out');
      }
    );
  });

  it('port-in-use: broadcast becomes noop without crashing', async () => {
    const net = await import('node:net');
    const { startWSBridge, broadcast } = await loadBridge();
    const port = 18205;

    const blockingServer = net.createServer();
    await new Promise((resolve) => blockingServer.listen(port, '127.0.0.1', resolve));

    try {
      setPort(port);
      startWSBridge();
      await sleep(100);

      assert.doesNotThrow(() => {
        broadcast({ msg: 'should noop gracefully' });
      });
    } finally {
      await new Promise((resolve) => blockingServer.close(resolve));
    }
  });

  it('defaults to port 3456 when WS_BRIDGE_PORT is unset', async () => {
    const { startWSBridge } = await loadBridge();

    delete process.env.WS_BRIDGE_PORT;
    startWSBridge();
    await sleep(100);

    const ws = await connectClient(3456);
    clients.push(ws);
    assert.equal(ws.readyState, WebSocket.OPEN);
  });
});
