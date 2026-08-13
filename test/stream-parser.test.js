// test/stream-parser.test.js
// @ai-rules:
// 1. [Pattern]: Regression tests for pure parseStreamLine function. No mocks needed.
// 2. [Constraint]: Uses node:test + node:assert only. No external test deps.
// 3. [Gotcha]: parseStreamLine returns null for unrecognized JSON types — test that too.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStreamLine } from '../stream-parser.js';

describe('parseStreamLine', () => {
  describe('system.init', () => {
    it('extracts session_id and signals not done', () => {
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-abc-123',
        tools: [],
        model: 'claude-sonnet-5',
      });

      const result = parseStreamLine(line);

      assert.deepEqual(result, {
        text: null,
        sessionId: 'sess-abc-123',
        done: false,
      });
    });

    it('returns null sessionId when session_id is missing', () => {
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        tools: [],
      });

      const result = parseStreamLine(line);

      assert.equal(result.sessionId, null);
      assert.equal(result.done, false);
    });
  });

  describe('assistant text', () => {
    it('extracts text content', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello world' }],
        },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, 'Hello world');
      assert.equal(result.done, false);
      assert.equal(result.sessionId, null);
    });

    it('joins multiple text blocks with newline', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Line one' },
            { type: 'text', text: 'Line two' },
          ],
        },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, 'Line one\nLine two');
    });

    it('returns null text when content has no text blocks', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'unknown_block' }] },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, null);
    });
  });

  describe('assistant tool_use', () => {
    it('formats tool_use with name and file_path hint', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Read',
            id: 'tool-1',
            input: { file_path: '/src/index.ts' },
          }],
        },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, '[tool] Read: /src/index.ts');
      assert.equal(result.done, false);
    });

    it('formats tool_use with command hint', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Shell',
            id: 'tool-2',
            input: { command: 'npm test' },
          }],
        },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, '[tool] Shell: npm test');
    });

    it('formats tool_use without input hint', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'ListFiles',
            id: 'tool-3',
            input: {},
          }],
        },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, '[tool] ListFiles');
    });

    it('truncates long hints to 200 chars', () => {
      const longPath = '/a'.repeat(250);
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Read',
            id: 'tool-4',
            input: { file_path: longPath },
          }],
        },
      });

      const result = parseStreamLine(line);

      const hintPart = result.text.replace('[tool] Read: ', '');
      assert.ok(hintPart.length <= 200);
    });

    it('mixes text and tool_use in same message', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Reading file...' },
            { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/x.ts' } },
          ],
        },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, 'Reading file...\n[tool] Read: /x.ts');
    });
  });

  describe('result (done=true)', () => {
    it('returns done=true with string result', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Final answer here',
        duration_ms: 1234,
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, 'Final answer here');
      assert.equal(result.done, true);
      assert.equal(result.sessionId, null);
    });

    it('JSON-stringifies non-string result', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: { key: 'value' },
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, '{"key":"value"}');
      assert.equal(result.done, true);
    });

    it('returns null text when result is empty', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '',
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, null);
      assert.equal(result.done, true);
    });
  });

  describe('error', () => {
    it('formats error with message', () => {
      const line = JSON.stringify({
        type: 'error',
        message: 'Rate limit exceeded',
      });

      const result = parseStreamLine(line);

      assert.equal(result.text, '[error] Rate limit exceeded');
      assert.equal(result.done, false);
    });

    it('JSON-stringifies error without message field', () => {
      const line = JSON.stringify({
        type: 'error',
        code: 'AUTH_FAILED',
      });

      const result = parseStreamLine(line);

      assert.ok(result.text.startsWith('[error]'));
      assert.ok(result.text.includes('AUTH_FAILED'));
    });
  });

  describe('non-JSON input', () => {
    it('returns raw line as text for plain text', () => {
      const result = parseStreamLine('Some plain text output');

      assert.equal(result.text, 'Some plain text output');
      assert.equal(result.sessionId, null);
      assert.equal(result.done, false);
    });

    it('returns raw line for malformed JSON', () => {
      const result = parseStreamLine('{broken json');

      assert.equal(result.text, '{broken json');
      assert.equal(result.done, false);
    });
  });

  describe('unrecognized JSON types', () => {
    it('returns null for unknown type', () => {
      const line = JSON.stringify({ type: 'heartbeat', ts: 123 });

      const result = parseStreamLine(line);

      assert.equal(result, null);
    });
  });
});
