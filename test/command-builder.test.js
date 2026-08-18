// test/command-builder.test.js
// @ai-rules:
// 1. [Pattern]: Tests written against plan spec — independent of implementation.
// 2. [Constraint]: node:test + node:assert only. No external test deps.
// 3. [Constraint]: ESM imports. Tests target exported shellQuote + buildCommand.
// 4. [Gotcha]: Implementation runs in parallel — interface may need reconciliation.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { shellQuote, buildCommand } from '../command-builder.js';

// === A. shellQuote function ===

describe('shellQuote', () => {
  it('quotes a normal string', () => {
    assert.equal(shellQuote('hello'), "'hello'");
  });

  it('escapes single quotes within a string', () => {
    const result = shellQuote("it's");
    assert.equal(result, "'it'\\''s'");
  });

  it('preserves spaces inside quotes', () => {
    assert.equal(shellQuote('hello world'), "'hello world'");
  });

  it('escapes special shell characters', () => {
    const result = shellQuote('$HOME && rm -rf /');
    assert.ok(result.startsWith("'"));
    assert.ok(result.endsWith("'"));
    assert.ok(!result.includes('$HOME') || result.includes("'$HOME"));
  });

  it('handles empty string', () => {
    assert.equal(shellQuote(''), "''");
  });

  it('returns empty quotes for undefined (type guard)', () => {
    assert.equal(shellQuote(undefined), "''");
  });

  it('returns empty quotes for null (type guard)', () => {
    assert.equal(shellQuote(null), "''");
  });

  it('returns empty quotes for number (type guard)', () => {
    assert.equal(shellQuote(123), "''");
  });

  it('escapes multiple single quotes correctly', () => {
    const result = shellQuote("a'b'c");
    assert.equal(result, "'a'\\''b'\\''c'");
  });
});

// === B. Mode resolution ===

describe('buildCommand - mode resolution', () => {
  it('reviewer mode sets effort to max', () => {
    const result = buildCommand({ prompt: 'test', mode: 'reviewer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--effort max'));
  });

  it('reviewer mode includes principal code reviewer in system prompt', () => {
    const result = buildCommand({ prompt: 'test', mode: 'reviewer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('principal code reviewer'));
  });

  it('explorer mode sets effort to low', () => {
    const result = buildCommand({ prompt: 'test', mode: 'explorer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--effort low'));
  });

  it('explorer mode includes quick research in system prompt', () => {
    const result = buildCommand({ prompt: 'test', mode: 'explorer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('quick research'));
  });

  it('architect mode sets effort to high', () => {
    const result = buildCommand({ prompt: 'test', mode: 'architect' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--effort high'));
  });

  it('architect mode includes systems architect in system prompt', () => {
    const result = buildCommand({ prompt: 'test', mode: 'architect' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('systems architect'));
  });

  it('no mode means no effort flag and no append-system-prompt', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(!parsed.command.includes('--effort'));
    assert.ok(!parsed.command.includes('--append-system-prompt'));
  });

  it('explicit effort overrides mode default', () => {
    const result = buildCommand({ prompt: 'test', mode: 'reviewer', effort: 'low' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--effort low'));
    assert.ok(!parsed.command.includes('--effort max'));
  });
});

// === C. Command construction ===

describe('buildCommand - command construction', () => {
  it('bare prompt includes claude --print --output-format stream-json', () => {
    const result = buildCommand({ prompt: 'hello' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--print'));
    assert.ok(parsed.command.includes('--output-format stream-json'));
  });

  it('bare prompt includes heredoc with the prompt text', () => {
    const result = buildCommand({ prompt: 'hello world' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('hello world'));
  });

  it('with mode includes effort and append-system-prompt flags', () => {
    const result = buildCommand({ prompt: 'test', mode: 'architect' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--effort'));
    assert.ok(parsed.command.includes('--append-system-prompt'));
  });

  it('with model includes --model flag with shellQuoted value', () => {
    const result = buildCommand({ prompt: 'test', model: 'claude-opus-4-8' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes("--model"));
    assert.ok(parsed.command.includes('claude-opus-4-8'));
  });

  it('with systemPrompt includes --system-prompt flag', () => {
    const result = buildCommand({ prompt: 'test', systemPrompt: 'Be concise' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--system-prompt'));
    assert.ok(parsed.command.includes('Be concise'));
  });

  it('with both systemPrompt and mode appendSystemPrompt, both flags present', () => {
    const result = buildCommand({
      prompt: 'test',
      mode: 'reviewer',
      systemPrompt: 'Custom system prompt',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--system-prompt'));
    assert.ok(parsed.command.includes('--append-system-prompt'));
    assert.ok(parsed.command.includes('Custom system prompt'));
    assert.ok(parsed.command.includes('principal code reviewer'));
  });

  it('with sessionId includes --resume flag', () => {
    const result = buildCommand({ prompt: 'test', sessionId: 'abc-123' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--resume'));
    assert.ok(parsed.command.includes('abc-123'));
  });

  it('with cwd sets cwd field in returned JSON', () => {
    const result = buildCommand({ prompt: 'test', cwd: '/tmp/work' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.cwd, '/tmp/work');
  });

  it('without cwd sets cwd to null in returned JSON', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.cwd, null);
  });
});

// === D. Heredoc delimiter ===

describe('buildCommand - heredoc delimiter', () => {
  it('delimiter starts with __PROMPT_ and ends with __', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    const match = parsed.command.match(/__PROMPT_([a-f0-9]+)__/);
    assert.ok(match, 'Heredoc delimiter should match __PROMPT_<hex>__ pattern');
  });

  it('delimiter has 8 hex chars between prefix and suffix', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    const match = parsed.command.match(/__PROMPT_([a-f0-9]+)__/);
    assert.ok(match);
    assert.equal(match[1].length, 8);
  });

  it('two consecutive calls produce different delimiters', () => {
    const result1 = buildCommand({ prompt: 'test' });
    const result2 = buildCommand({ prompt: 'test' });
    const parsed1 = JSON.parse(result1.content[0].text);
    const parsed2 = JSON.parse(result2.content[0].text);
    const match1 = parsed1.command.match(/__PROMPT_([a-f0-9]+)__/);
    const match2 = parsed2.command.match(/__PROMPT_([a-f0-9]+)__/);
    assert.ok(match1 && match2);
    assert.notEqual(match1[1], match2[1]);
  });

  it('heredoc uses single-quoted delimiter to prevent variable expansion', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    const match = parsed.command.match(/<<'(__PROMPT_[a-f0-9]+__)'/);
    assert.ok(match, "Heredoc should use single-quoted delimiter: <<'DELIM'");
  });
});

// === E. CLAUDE_BIN override ===

describe('buildCommand - CLAUDE_BIN override', () => {
  let originalBin;

  beforeEach(() => {
    originalBin = process.env.CLAUDE_BIN;
  });

  afterEach(() => {
    if (originalBin === undefined) {
      delete process.env.CLAUDE_BIN;
    } else {
      process.env.CLAUDE_BIN = originalBin;
    }
  });

  it('default: command starts with claude', () => {
    delete process.env.CLAUDE_BIN;
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('claude --print') ||
      parsed.command.includes('claude\n') ||
      /\bclaude\b/.test(parsed.command),
      'Command should reference claude binary'
    );
  });

  it('with CLAUDE_BIN set, uses custom path', () => {
    process.env.CLAUDE_BIN = '/custom/path/claude';
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('/custom/path/claude'),
      'Command should use CLAUDE_BIN path'
    );
  });
});

// === F. Prompt size guard ===

describe('buildCommand - prompt size guard', () => {
  it('prompt under 100KB returns command normally', () => {
    const result = buildCommand({ prompt: 'short prompt' });
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command);
  });

  it('prompt over 100KB returns error with isError: true', () => {
    const largePrompt = 'x'.repeat(100_001);
    const result = buildCommand({ prompt: largePrompt });
    assert.equal(result.isError, true);
  });

  it('prompt at exactly 100KB boundary', () => {
    const boundaryPrompt = 'x'.repeat(100_000);
    const result = buildCommand({ prompt: boundaryPrompt });
    // Spec says "normal or error" at boundary — just verify it doesn't throw
    assert.ok(result.content);
    assert.ok(result.content[0].type === 'text');
  });
});

// === G. ANSI colors ===

describe('buildCommand - ANSI colors', () => {
  it('reviewer mode uses ANSI color code 31 (red)', () => {
    const result = buildCommand({ prompt: 'test', mode: 'reviewer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('\\033[31m') || parsed.command.includes('\\e[31m') ||
      parsed.command.includes('\x1b[31m') || parsed.command.includes('31m'),
      'reviewer should use ANSI red (31)'
    );
  });

  it('architect mode uses ANSI color code 35 (purple)', () => {
    const result = buildCommand({ prompt: 'test', mode: 'architect' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('\\033[35m') || parsed.command.includes('\\e[35m') ||
      parsed.command.includes('\x1b[35m') || parsed.command.includes('35m'),
      'architect should use ANSI purple (35)'
    );
  });

  it('explorer mode uses ANSI color code 32 (green)', () => {
    const result = buildCommand({ prompt: 'test', mode: 'explorer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('\\033[32m') || parsed.command.includes('\\e[32m') ||
      parsed.command.includes('\x1b[32m') || parsed.command.includes('32m'),
      'explorer should use ANSI green (32)'
    );
  });

  it('no mode uses ANSI color code 37 (white)', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('\\033[37m') || parsed.command.includes('\\e[37m') ||
      parsed.command.includes('\x1b[37m') || parsed.command.includes('37m'),
      'default should use ANSI white (37)'
    );
  });
});

// === H. Output format ===

describe('buildCommand - output format', () => {
  it('returns { content: [{ type: "text", text: "..." }] }', () => {
    const result = buildCommand({ prompt: 'test' });
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.equal(typeof result.content[0].text, 'string');
  });

  it('text field is valid JSON when parsed', () => {
    const result = buildCommand({ prompt: 'test' });
    assert.doesNotThrow(() => JSON.parse(result.content[0].text));
  });

  it('parsed JSON has command, cwd, description, and block_until_ms keys', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(typeof parsed.command, 'string');
    assert.ok(parsed.cwd === null || typeof parsed.cwd === 'string');
    assert.equal(typeof parsed.description, 'string');
    assert.equal(parsed.block_until_ms, 0);
  });
});

// === I. POSIX timing ===

describe('buildCommand - POSIX timing', () => {
  it('command starts with _start=$(date +%s)', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('_start=$(date +%s)'),
      'Command should set _start via date +%s'
    );
  });

  it('footer uses $_elapsed computed from date delta', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('_elapsed') ||
      parsed.command.includes('$(( $(date +%s) - _start ))'),
      'Command should compute elapsed time from date delta'
    );
  });

  it('does not reference $SECONDS anywhere', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      !parsed.command.includes('$SECONDS') && !parsed.command.includes('SECONDS='),
      'Command must not use bash $SECONDS (not POSIX)'
    );
  });
});
