// test/command-builder.test.js
// @ai-rules:
// 1. [Pattern]: Tests written against plan spec — independent of implementation.
// 2. [Constraint]: node:test + node:assert only. No external test deps.
// 3. [Constraint]: ESM imports. Tests target exported shellQuote + buildCommand.
// 4. [Gotcha]: Implementation runs in parallel — interface may need reconciliation.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote, buildCommand } from '../command-builder.js';
import { createEnvScrubber } from './helpers/env.js';

const scrubber = createEnvScrubber();
beforeEach(() => scrubber.scrub());
afterEach(() => scrubber.restore());

// Dynamic loader for providers.js to allow running tests in Red-First ATDD
async function getProviders() {
  return await import('../providers.js');
}

async function getFailover() {
  return await import('../failover.js');
}

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
    assert.ok(parsed.command.includes("--effort 'max'"));
  });

  it('reviewer mode includes principal code reviewer in system prompt', () => {
    const result = buildCommand({ prompt: 'test', mode: 'reviewer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('principal code reviewer'));
  });

  it('explorer mode sets effort to low', () => {
    const result = buildCommand({ prompt: 'test', mode: 'explorer', model: 'claude-3-5-sonnet' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes("--effort 'low'"));
  });

  it('explorer mode includes quick research in system prompt', () => {
    const result = buildCommand({ prompt: 'test', mode: 'explorer' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('quick research'));
  });

  it('architect mode sets effort to high', () => {
    const result = buildCommand({ prompt: 'test', mode: 'architect' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes("--effort 'high'"));
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
    assert.ok(parsed.command.includes("--effort 'low'"));
    assert.ok(!parsed.command.includes("--effort 'max'"));
  });
});

// === C. Command construction ===

describe('buildCommand - command construction', () => {
  it('bare prompt includes claude --print --output-format stream-json --verbose piped to formatter', () => {
    const result = buildCommand({ prompt: 'hello' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('--print'));
    assert.ok(parsed.command.includes('--output-format stream-json'));
    assert.ok(parsed.command.includes('--verbose'));
    assert.ok(parsed.command.includes('stream-format.js'), 'should pipe through stream-format.js');
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

  it('with cwd sets cwd field and embeds cd in command', () => {
    const result = buildCommand({ prompt: 'test', cwd: '/tmp/work' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.cwd, '/tmp/work');
    assert.ok(parsed.command.includes("cd '/tmp/work' || exit 1"));
  });

  it('without cwd omits cd from command', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.cwd, null);
    assert.ok(!parsed.command.match(/^cd /m));
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

  it('delimiter has 32 hex chars between prefix and suffix', () => {
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    const match = parsed.command.match(/__PROMPT_([a-f0-9]+)__/);
    assert.ok(match);
    assert.equal(match[1].length, 32);
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

// === J. providers.js - resolveProvider (T-1, T-2, T-3, T-10, T-11) ===

describe('providers.js - resolveProvider', () => {
  it('T-1: resolveProvider auto-detection: Claude models default to Vertex', async () => {
    const { resolveProvider } = await getProviders();
    assert.equal(resolveProvider('auto', 'claude-sonnet-4-6'), 'vertex');
  });

  it('T-2: resolveProvider auto-detection: RITS / EnMaaS models route to EnMaaS', async () => {
    const { resolveProvider } = await getProviders();
    assert.equal(resolveProvider('auto', 'rits/zai-org/glm-5-3'), 'enmaas');
  });

  it('T-3: resolveProvider explicit override: EnMaaS provider forced', async () => {
    const { resolveProvider } = await getProviders();
    assert.equal(resolveProvider('enmaas', 'claude-sonnet-4-6'), 'enmaas');
  });

  it('T-10: resolveProvider explicit override precedence over model string', async () => {
    const { resolveProvider } = await getProviders();
    assert.equal(resolveProvider('vertex', 'rits/zai-org/glm-5-3'), 'vertex');
  });

  it('T-11: resolveProvider auto-detection handles undefined inputs safely', async () => {
    const { resolveProvider } = await getProviders();
    assert.equal(resolveProvider(undefined, undefined), 'vertex');
  });
});

// === K. providers.js - buildProviderEnv (T-4, T-5, T-17, T-18) ===

describe('providers.js - buildProviderEnv', () => {
  it('T-4: buildProviderEnv("enmaas") returns envVars and settings override', async () => {
    const { buildProviderEnv } = await getProviders();
    const envConfig = buildProviderEnv('enmaas');
    assert.ok(
      envConfig.envVars.some((v) => v.includes('ANTHROPIC_BASE_URL="${ENMAAS_BASE_URL:-https://api.enmaas.example.com}"')),
      'envVars must contain ANTHROPIC_BASE_URL'
    );
    assert.ok(
      envConfig.envVars.some((v) => v.includes('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1')),
      'envVars must contain CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1'
    );
    assert.ok(
      envConfig.envVars.some((v) => v.includes('CLAUDE_CODE_ENVIRONMENT_KIND=byoc')),
      'envVars must contain CLAUDE_CODE_ENVIRONMENT_KIND=byoc'
    );
    assert.ok(
      envConfig.envVars.some((v) => v.includes('${ENMAAS_KEY:?')),
      'envVars must contain ${ENMAAS_KEY:? guard'
    );
    assert.deepEqual(envConfig.settings, { env: { CLAUDE_CODE_USE_VERTEX: '' } });
  });

  it('T-5: buildProviderEnv("vertex") returns envVars with clean gateway unset and null settings', async () => {
    const { buildProviderEnv } = await getProviders();
    const envConfig = buildProviderEnv('vertex');
    assert.ok(
      envConfig.envVars.some((v) => v.includes('CLAUDE_CODE_USE_VERTEX=1')),
      'envVars must contain CLAUDE_CODE_USE_VERTEX=1'
    );
    assert.ok(
      envConfig.envVars.every((v) => !v.includes('ANTHROPIC_BASE_URL')),
      'envVars must clear ANTHROPIC_BASE_URL'
    );
    assert.ok(
      envConfig.envVars.some((v) => v.includes('ANTHROPIC_API_KEY=""')),
      'envVars must clear ANTHROPIC_API_KEY'
    );
    assert.equal(envConfig.settings, null);
  });

  it('T-17: buildProviderEnv("invalid_provider") returns safe fallback Vertex configuration without crash', async () => {
    const { buildProviderEnv } = await getProviders();
    const envConfig = buildProviderEnv('invalid_provider');
    assert.ok(envConfig && Array.isArray(envConfig.envVars), 'Fallback config must return valid object');
    assert.ok(
      envConfig.envVars.some((v) => v.includes('CLAUDE_CODE_USE_VERTEX=1')),
      'Fallback config must use Vertex configuration'
    );
    assert.equal(envConfig.settings, null);
  });

  it('T-18: buildProviderEnv("vertex") unsets ambient BYOC token and environment kind', async () => {
    const { buildProviderEnv } = await getProviders();
    const envConfig = buildProviderEnv('vertex');
    assert.ok(
      envConfig.envVars.some((v) => v.includes('CLAUDE_CODE_ENVIRONMENT_KIND=""')),
      'Vertex env must clear CLAUDE_CODE_ENVIRONMENT_KIND'
    );
    assert.ok(
      envConfig.envVars.some((v) => v.includes('ANTHROPIC_API_KEY=""')),
      'Vertex env must clear ANTHROPIC_API_KEY'
    );
  });
});

// === L. providers.js - supportsEffort (T-6, T-9, T-16) ===

describe('providers.js - supportsEffort', () => {
  it('T-6: supportsEffort returns false for third-party GLM models', async () => {
    const { supportsEffort } = await getProviders();
    assert.equal(supportsEffort('rits/zai-org/glm-5-3'), false);
  });

  it('T-9: supportsEffort handles undefined and null safely without TypeError', async () => {
    const { supportsEffort } = await getProviders();
    assert.equal(supportsEffort(undefined), true);
    assert.equal(supportsEffort(null), true);
  });

  it('T-16: supportsEffort returns true for namespaced Claude models', async () => {
    const { supportsEffort } = await getProviders();
    assert.equal(supportsEffort('rits/anthropic/claude-opus-5-5'), true);
  });
});

// === M. command-builder.js - EnMaaS gateway routing & settings (T-7, T-8, T-12, T-13) ===

describe('buildCommand - EnMaaS gateway routing and effort suppression', () => {
  it('T-7: buildCommand suppresses --effort flag for GLM 5.3 in reviewer mode', () => {
    const result = buildCommand({ mode: 'reviewer', model: 'rits/zai-org/glm-5-3', prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(!parsed.command.includes('--effort'), 'Command should suppress --effort for third-party models');
  });

  it('T-8: buildCommand embeds EnMaaS gateway environment, settings, and set -eo pipefail', () => {
    const result = buildCommand({ provider: 'enmaas', prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('https://api.enmaas.example.com'), 'Command should include https://api.enmaas.example.com');
    assert.ok(parsed.command.includes('--settings'), 'Command should include --settings');
    assert.ok(parsed.command.includes('set -eo pipefail; '), 'Command should prepend set -eo pipefail; ');
  });

  it('T-12: buildCommand serializes settings JSON CLI token for EnMaaS', () => {
    const result = buildCommand({ provider: 'enmaas', prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes("--settings '{\"env\":{\"CLAUDE_CODE_USE_VERTEX\":\"\"}}'"),
      'Command should serialize settings JSON CLI token correctly'
    );
  });

  it('T-13: buildCommand description label ends with (effort: unsupported) for third-party models', () => {
    const result = buildCommand({ mode: 'reviewer', model: 'rits/zai-org/glm-5-3', prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.description.endsWith('(effort: unsupported)'),
      `Description label should end with (effort: unsupported), got: "${parsed.description}"`
    );
  });
});

// === N. Vertex multi-project failover (T-19, T-20, T-21) ===

describe('buildCommand & providers.js - Vertex multi-project budget failover', () => {
  it('T-19: resolveVertexFailoverConfig returns enabled: false by default when secondary project omitted', async () => {
    const { resolveVertexFailoverConfig } = await getFailover();
    const config = resolveVertexFailoverConfig({ prompt: 'test' });
    assert.equal(config.enabled, false);
    const result = buildCommand({ prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(!parsed.command.includes('_run_claude'), 'Single-pass command should not include _run_claude');
  });

  it('T-20: buildCommand with primary and secondary projects generates POSIX retry wrapper', () => {
    const result = buildCommand({ primaryProject: 'p1', secondaryProject: 'p2', prompt: 'test' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('_run_claude'), 'Command should define _run_claude function');
    assert.ok(parsed.command.includes('ANTHROPIC_VERTEX_PROJECT_ID'), 'Command should export ANTHROPIC_VERTEX_PROJECT_ID');
    assert.ok(
      parsed.command.includes('RESOURCE_EXHAUSTED') && parsed.command.includes('429'),
      'Command should check for quota/budget exhaustion error patterns'
    );
  });

  it('T-21: buildCommand exports secondary credentials when configured in failover mode', () => {
    const result = buildCommand({
      primaryProject: 'p1',
      secondaryProject: 'p2',
      secondaryCredentials: '/path/to/sa2.json',
      prompt: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('GOOGLE_APPLICATION_CREDENTIALS'), 'Command should reference GOOGLE_APPLICATION_CREDENTIALS');
    assert.ok(parsed.command.includes("'/path/to/sa2.json'"), 'Command should export /path/to/sa2.json for secondary');
  });
});

// === O. Bash syntax validation & CLI integration (T-14, T-22, T-23) ===

describe('Bash syntax validation and setup.sh --configure CLI verification', () => {
  it('T-14: execSync("bash -n") validates generated commands for EnMaaS & Vertex', () => {
    const enmaasResult = buildCommand({ provider: 'enmaas', prompt: 'test syntax' });
    const enmaasParsed = JSON.parse(enmaasResult.content[0].text);
    assert.ok(enmaasParsed.command.includes('https://api.enmaas.example.com'), 'EnMaaS command should configure EnMaaS gateway');
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: enmaasParsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'EnMaaS command string must pass bash -n validation');

    const vertexResult = buildCommand({ provider: 'vertex', prompt: 'test syntax' });
    const vertexParsed = JSON.parse(vertexResult.content[0].text);
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: vertexParsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Vertex command string must pass bash -n validation');
  });

  it('T-22: execSync("bash -n") validates Vertex failover command script syntax', () => {
    const failoverResult = buildCommand({ primaryProject: 'p1', secondaryProject: 'p2', prompt: 'test failover syntax' });
    const failoverParsed = JSON.parse(failoverResult.content[0].text);
    assert.ok(failoverParsed.command.includes('_run_claude'), 'Failover wrapper must be generated');
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: failoverParsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Vertex failover command script must pass bash -n validation');
  });

  it('T-23: setup.sh syntax validation and verification of --configure logic', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const setupShPath = path.resolve(__dirname, '../setup.sh');

    // 1. Syntax check
    assert.doesNotThrow(() => {
      execSync(`bash -n "${setupShPath}"`, { stdio: 'pipe' });
    }, 'setup.sh should pass bash -n syntax check');

    // 2. Integration check with isolated temp directory
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-setup-test-'));
    try {
      const cursorConfigDir = path.join(tempDir, '.cursor');
      const geminiConfigDir = path.join(tempDir, '.gemini', 'config');
      fs.mkdirSync(cursorConfigDir, { recursive: true });
      fs.mkdirSync(geminiConfigDir, { recursive: true });

      const initialCursorConfig = {
        mcpServers: {
          'sibling-server': { command: 'echo', args: ['hello'] },
          'claude-cli': { command: 'node', args: ['/path/to/server.js'] }
        }
      };
      const initialGeminiConfig = {
        mcpServers: {
          'other-server': { command: 'cat' },
          'claude-cli': { command: 'node', args: ['/path/to/server.js'] }
        }
      };

      fs.writeFileSync(path.join(cursorConfigDir, 'mcp.json'), JSON.stringify(initialCursorConfig, null, 2));
      fs.writeFileSync(path.join(geminiConfigDir, 'mcp_config.json'), JSON.stringify(initialGeminiConfig, null, 2));

      // Execute setup.sh with --configure flags
      execSync(
        `bash "${setupShPath}" --configure --primary-project p1 --secondary-project p2 --enmaas-key secret_token`,
        {
          env: { ...process.env, HOME: tempDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      // Verify ~/.cursor/mcp.json preservation & update
      const updatedCursor = JSON.parse(fs.readFileSync(path.join(cursorConfigDir, 'mcp.json'), 'utf8'));
      assert.ok(updatedCursor.mcpServers['sibling-server'], 'Sibling MCP server in cursor config must be preserved');
      assert.ok(updatedCursor.mcpServers['claude-cli']?.env, 'claude-cli.env must be defined in cursor config');
      const cursorPrimary = updatedCursor.mcpServers['claude-cli'].env.VERTEX_PRIMARY_PROJECT || updatedCursor.mcpServers['claude-cli'].env.ANTHROPIC_VERTEX_PROJECT_ID;
      assert.equal(cursorPrimary, 'p1');
      assert.equal(updatedCursor.mcpServers['claude-cli'].env.VERTEX_SECONDARY_PROJECT, 'p2');
      assert.equal(updatedCursor.mcpServers['claude-cli'].env.ENMAAS_KEY, 'secret_token');

      // Verify ~/.gemini/config/mcp_config.json preservation & update
      const updatedGemini = JSON.parse(fs.readFileSync(path.join(geminiConfigDir, 'mcp_config.json'), 'utf8'));
      assert.ok(updatedGemini.mcpServers['other-server'], 'Sibling MCP server in gemini config must be preserved');
      assert.ok(updatedGemini.mcpServers['claude-cli']?.env, 'claude-cli.env must be defined in gemini config');
      const geminiPrimary = updatedGemini.mcpServers['claude-cli'].env.VERTEX_PRIMARY_PROJECT || updatedGemini.mcpServers['claude-cli'].env.ANTHROPIC_VERTEX_PROJECT_ID;
      assert.equal(geminiPrimary, 'p1');
      assert.equal(updatedGemini.mcpServers['claude-cli'].env.VERTEX_SECONDARY_PROJECT, 'p2');
      assert.equal(updatedGemini.mcpServers['claude-cli'].env.ENMAAS_KEY, 'secret_token');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('Cross-Provider Failover (EnMaaS -> Vertex) (T-24 to T-36)', () => {
  it('T-24: resolveFailoverConfig detects cross-provider failover when provider: "enmaas" and secondary project is provided', async () => {
    const { resolveFailoverConfig } = await getFailover();
    const config = resolveFailoverConfig('enmaas', { secondaryProject: 'cnv-ai-insights' }, {});
    assert.equal(config.enabled, true, 'Failover must be enabled');
    assert.equal(config.type, 'cross-provider', 'Failover type must be cross-provider');
    assert.equal(config.secondaryProject, 'cnv-ai-insights');
  });

  it('T-24b: resolveFailoverConfig detects cross-provider failover when provider: "auto" resolves to EnMaaS and secondary Vertex project is provided', async () => {
    const { resolveFailoverConfig } = await getFailover();
    const config = resolveFailoverConfig('auto', { model: 'rits/zai-org/glm-5-3', secondaryProject: 'cnv-ai-insights' }, {});
    assert.equal(config.enabled, true, 'Failover must be enabled');
    assert.equal(config.type, 'cross-provider', 'Failover type must be cross-provider');
    assert.equal(config.secondaryProject, 'cnv-ai-insights');
  });

  it('T-25: resolveFailoverConfig resolves secondary project and credentials from primary fallback', async () => {
    const { resolveFailoverConfig } = await getFailover();
    const configFromParams = resolveFailoverConfig('enmaas', {
      primaryProject: 'cnv-ai-insights',
      primaryCredentials: '/path/to/primary-sa.json',
    }, {});
    assert.equal(configFromParams.enabled, true, 'Failover must be enabled via primary fallback');
    assert.equal(configFromParams.secondaryProject, 'cnv-ai-insights');
    assert.equal(configFromParams.secondaryCredentials, '/path/to/primary-sa.json');

    const configFromEnv = resolveFailoverConfig('enmaas', {}, {
      VERTEX_PRIMARY_PROJECT: 'env-insights',
      GOOGLE_APPLICATION_CREDENTIALS: '/env/sa.json',
    });
    assert.equal(configFromEnv.enabled, true, 'Failover must be enabled via env primary fallback');
    assert.equal(configFromEnv.secondaryProject, 'env-insights');
    assert.equal(configFromEnv.secondaryCredentials, '/env/sa.json');
  });

  it('T-26: resolveSecondaryModel maps rits/* or / models to undefined or explicit secondaryModel', async () => {
    const { resolveSecondaryModel } = await getFailover();
    assert.equal(resolveSecondaryModel('rits/zai-org/glm-5-3'), undefined);
    assert.equal(resolveSecondaryModel('some/model/path'), undefined);
    assert.equal(resolveSecondaryModel('rits/zai-org/glm-5-3', 'claude-3-5-sonnet'), 'claude-3-5-sonnet');
    assert.equal(resolveSecondaryModel('claude-3-5-sonnet-v20241022'), 'claude-3-5-sonnet-v20241022');
  });

  it('T-27: Cross-provider failover script contains isolated _run_primary() and _run_secondary()', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'cnv-ai-insights',
      prompt: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    const primaryMatch = parsed.command.match(/_run_primary\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_secondary/);
    const secondaryMatch = parsed.command.match(/_run_secondary\s*\(\)\s*\(([^\0]*?)\)\n\s*if \[ -f/);
    assert.ok(primaryMatch, 'Command must contain _run_primary function body');
    assert.ok(secondaryMatch, 'Command must contain _run_secondary function body');
  });

  it('T-28: _run_secondary() subshell strictly unsets ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'cnv-ai-insights',
      prompt: 'test secondary environment unset',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY') ||
      parsed.command.includes('unset ANTHROPIC_BASE_URL') && parsed.command.includes('unset ANTHROPIC_API_KEY'),
      'Secondary runner must unset gateway variables'
    );
  });

  it('T-29: _run_secondary() invocation omits --settings flag', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'cnv-ai-insights',
      prompt: 'test settings flag isolation',
    });
    const parsed = JSON.parse(result.content[0].text);
    const primaryMatch = parsed.command.match(/_run_primary\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_secondary/);
    const secondaryMatch = parsed.command.match(/_run_secondary\s*\(\)\s*\(([^\0]*?)\)\n\s*if \[ -f/);
    assert.ok(primaryMatch[1].includes('--settings'), '_run_primary must include --settings flag');
    assert.ok(!secondaryMatch[1].includes('--settings'), '_run_secondary must strictly omit --settings flag');
  });

  it('T-30: Stderr pattern matcher includes POSIX character classes for 429|502|503|504|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'cnv-ai-insights',
      prompt: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('429') && parsed.command.includes('502|503|504'), 'Must match 429/50x');
    assert.ok(parsed.command.includes('ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT'), 'Must match network errors');
  });

  it('T-31: Stderr pattern matcher excludes 400/401/403', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'cnv-ai-insights',
      prompt: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('400|401|403'), 'Must have negative match for user errors');
  });

  it('T-32: Generated cross-provider and intra-vertex commands pass bash -n syntax validation', () => {
    const crossResult = buildCommand({ provider: 'enmaas', secondaryProject: 'p2', prompt: 'test cross' });
    const crossParsed = JSON.parse(crossResult.content[0].text);
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: crossParsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Cross-provider command must pass bash -n validation');

    const vertexResult = buildCommand({ provider: 'vertex', secondaryProject: 'p2', primaryProject: 'p1', prompt: 'test vertex' });
    const vertexParsed = JSON.parse(vertexResult.content[0].text);
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: vertexParsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Vertex command must pass bash -n validation');
  });

  it('T-33: ANTHROPIC_BASE_URL adheres to ENMAAS_BASE_URL variable expansion without hardcoded proprietary URL', () => {
    const crossResult = buildCommand({ provider: 'enmaas', secondaryProject: 'p2', prompt: 'test cross' });
    const crossParsed = JSON.parse(crossResult.content[0].text);
    assert.ok(crossParsed.command.includes('${ENMAAS_BASE_URL:-https://api.enmaas.example.com}'), 'Must use configurable ENMAAS_BASE_URL expansion');
    assert.ok(!crossParsed.command.includes('internal'), 'Must not leak internal domain');
  });

  it('T-34: secondaryArgs receives --effort when primaryModel suppressed effort and secondaryModel is Sonnet', () => {
    const result = buildCommand({
      provider: 'enmaas',
      model: 'rits/zai-org/glm-5-3',
      secondaryProject: 'cnv-ai-insights',
      mode: 'reviewer',
      prompt: 'test effort restoration on failover',
    });
    const parsed = JSON.parse(result.content[0].text);
    const primaryMatch = parsed.command.match(/_run_primary\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_secondary/);
    const secondaryMatch = parsed.command.match(/_run_secondary\s*\(\)\s*\(([^\0]*?)\)\n\s*if \[ -f/);
    assert.ok(!primaryMatch[1].includes('--effort'), 'Primary invocation with GLM must suppress --effort');
    assert.ok(secondaryMatch[1].includes("--effort 'max'"), 'Secondary invocation failing over to Sonnet must restore --effort max');
  });

  it('T-35: buildProviderEnv("vertex") strictly omits ANTHROPIC_BASE_URL', async () => {
    const { buildProviderEnv } = await getProviders();
    const envConfig = buildProviderEnv('vertex');
    assert.ok(
      envConfig.envVars.every((v) => !v.includes('ANTHROPIC_BASE_URL')),
      'Vertex envVars must not define ANTHROPIC_BASE_URL'
    );
  });

  it('T-36: Execution test - errexit set -e failover triggers secondary on primary exit 1', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'cnv-ai-insights',
      prompt: 'test error set e',
    });
    const parsed = JSON.parse(result.content[0].text);
    let commandStr = parsed.command;

    commandStr = commandStr.replace(
      /_run_primary\s*\(\)\s*\([^\0]*?\)\n\s*_run_secondary/,
      '_run_primary() ( echo "Error 429 Too Many Requests" >&2; exit 1 )\n   _run_secondary'
    );
    commandStr = commandStr.replace(
      /_run_secondary\s*\(\)\s*\([^\0]*?\)\n\s*if \[ -f/,
      '_run_secondary() ( echo "SECONDARY_SUCCESS" )\n   if [ -f'
    );

    const execResult = execSync('bash', { input: commandStr, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    assert.ok(execResult.includes('SECONDARY_SUCCESS'), 'Secondary should execute successfully when primary fails');
  });
});
