// test/command-builder.test.js
// @ai-rules:
// 1. [Pattern]: Tests written against plan spec — independent of implementation.
// 2. [Constraint]: node:test + node:assert only. No external test deps.
// 3. [Constraint]: ESM imports. Tests target exported shellQuote + buildCommand.
// 4. [Gotcha]: Implementation runs in parallel — interface may need reconciliation.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote, buildCommand, FORMATTER_PATH } from '../command-builder.js';
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

  it('T-6: non-failover command wraps REDACT_SED in fail-closed drain without || cat fallback (M-2)', () => {
    const result = buildCommand({ prompt: 'test pipe fallback' });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('{ sed -E -u ') &&
      parsed.command.includes("|| { cat >/dev/null; printf '[claude-mcp] redaction unavailable\\n'; }; } >&2"),
      'Non-failover command must route stderr through fail-closed drain'
    );
    assert.ok(!parsed.command.includes('|| cat; }'), 'Non-failover command must not fall back to raw cat on sed failure');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-t6-sed-'));
    try {
      const brokenSedDir = path.join(tmpDir, 'broken-sed');
      fs.mkdirSync(brokenSedDir, { recursive: true });
      fs.writeFileSync(path.join(brokenSedDir, 'sed'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      const errPayload = 'Authorization: Bearer leak-single-sed\n'.repeat(3000);
      const errFile = path.join(tmpDir, 'large.err');
      fs.writeFileSync(errFile, errPayload);

      const mockBin = path.join(tmpDir, 'mock-claude.sh');
      fs.writeFileSync(
        mockBin,
        `#!/bin/bash\ncat "${errFile}" >&2\nprintf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"SINGLE_TIER_OK\\n"}]}}'\nexit 0\n`,
        { mode: 0o755 }
      );

      const runCmd = JSON.parse(buildCommand({ prompt: 'test single-tier broken sed' }, { CLAUDE_BIN: mockBin }).content[0].text).command;
      const run = spawnSync('bash', {
        input: runCmd,
        env: { ...process.env, PATH: `${brokenSedDir}:${process.env.PATH}` },
        encoding: 'utf8',
        timeout: 5000,
      });

      assert.equal(run.status, 0, `Expected exit 0 (no SIGPIPE 141), got ${run.status}; stderr=${run.stderr.slice(0, 200)}`);
      assert.ok(run.stdout.includes('SINGLE_TIER_OK'), 'stdout must include SINGLE_TIER_OK');
      assert.ok(run.stderr.includes('redaction unavailable'), 'stderr must report redaction unavailable');
      assert.ok(!run.stderr.includes('leak-single-sed'), 'stderr must not leak raw Bearer secret when sed fails');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

describe('providers.js - resolveProvider, normalizeVertexModel & buildVertexSettings', () => {
  it('T-1: resolveProvider auto-detection: Claude models default to Vertex even when ENMAAS_KEY is set', async () => {
    const { resolveProvider } = await getProviders();
    assert.equal(resolveProvider('auto', 'claude-sonnet-4-6'), 'vertex');
    assert.equal(resolveProvider('auto', 'sonnet', { ENMAAS_KEY: 'test-key' }), 'vertex');
    assert.equal(resolveProvider('auto', 'opus', { ENMAAS_KEY: 'test-key' }), 'vertex');
    assert.equal(resolveProvider('auto', 'claude-opus-5-5', { ENMAAS_KEY: 'test-key' }), 'vertex');
    assert.equal(resolveProvider('auto', 'claude-sonnet-5-5', { ENMAAS_KEY: 'test-key' }), 'vertex');
  });

  it('T-2: resolveProvider auto-detection: RITS / EnMaaS models route to EnMaaS', async () => {
    const { resolveProvider } = await getProviders();
    assert.equal(resolveProvider('auto', 'rits/zai-org/glm-5-3'), 'enmaas');
    assert.equal(resolveProvider('auto', 'enmaas-custom-model'), 'enmaas');
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

  it('T-3b: normalizeVertexModel maps legacy 5-5, opus-5, and rits/* IDs to canonical Vertex aliases', async () => {
    const { normalizeVertexModel } = await getProviders();
    assert.equal(typeof normalizeVertexModel, 'function', 'normalizeVertexModel must be exported from providers.js');
    assert.equal(normalizeVertexModel('claude-opus-5-5'), 'opus');
    assert.equal(normalizeVertexModel('claude-opus-5'), 'opus');
    assert.equal(normalizeVertexModel('claude-sonnet-5-5'), 'sonnet');
    assert.equal(normalizeVertexModel('rits/zai-org/glm-5-3'), 'sonnet');
    assert.equal(normalizeVertexModel('sonnet'), 'sonnet');
    assert.equal(normalizeVertexModel('opus'), 'opus');
  });

  it('T-4a: buildVertexSettings builds --settings env override object for Vertex tiers', async () => {
    const { buildVertexSettings } = await getProviders();
    assert.equal(typeof buildVertexSettings, 'function', 'buildVertexSettings must be exported from providers.js');
    assert.equal(buildVertexSettings(null, null), null);
    assert.deepEqual(buildVertexSettings('vertex-project-1', '/creds/sa1.json'), {
      env: {
        CLAUDE_CODE_USE_VERTEX: '1',
        ANTHROPIC_VERTEX_PROJECT_ID: 'vertex-project-1',
        CLOUDSDK_CORE_PROJECT: 'vertex-project-1',
        GOOGLE_APPLICATION_CREDENTIALS: '/creds/sa1.json',
      },
    });
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
      parsed.command.includes("--settings '{\"env\":{\"CLAUDE_CODE_USE_VERTEX\":\"\"},\"disableAllHooks\":true}'"),
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

// === P. Streaming Progress, Headless Isolation & Fitness Gates (T-S2, T-S4, T-S5, T-S8) ===

describe('Streaming Progress, Headless Isolation & Fitness Gates (T-S2, T-S4, T-S5, T-S8)', () => {
  it('T-S2: non-failover command clears CLAUDE_PROGRESS_FD and stream-format.js formats/redacts when FD unset', () => {
    const res = buildCommand({ prompt: 'hi' });
    const { command } = JSON.parse(res.content[0].text);
    assert.ok(command.includes('CLAUDE_PROGRESS_FD= node'), 'Non-failover command must clear CLAUDE_PROGRESS_FD before node formatter');
    assert.ok(!command.includes('CLAUDE_PROGRESS_FD=3'), 'Non-failover command must not set CLAUDE_PROGRESS_FD=3');

    const events = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', session_id: 's-nf' }),
      JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3 }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Bash',
            input: { command: "curl -H 'Authorization: Bearer tok-12345' https://api.example.com" },
          }],
        },
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Turn1' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Turn2' }] } }),
    ].join('\n') + '\n';

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDE_PROGRESS_FD;
    const fmtRes = spawnSync('node', [FORMATTER_PATH], { input: events, env: cleanEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(fmtRes.status, 0, `stream-format.js exited ${fmtRes.status}: ${fmtRes.stderr}`);
    assert.ok(fmtRes.stdout.includes('⚡'), 'Must emit init ⚡ progress');
    assert.ok(fmtRes.stdout.includes('↻ retry 1/3'), 'Must emit api_retry indicator');
    assert.ok(fmtRes.stdout.includes('⏵'), 'Must emit tool_use ⏵ progress');
    assert.ok(fmtRes.stdout.includes('[REDACTED]'), 'Must redact Bearer token in progress output');
    assert.ok(!fmtRes.stdout.includes('tok-12345'), 'Must not leak Bearer token');
    assert.ok(fmtRes.stdout.includes('Turn1\nTurn2'), 'Must insert newline between adjacent assistant text turns');
  });

  it('T-S4: default headless isolation injects --strict-mcp-config and disableAllHooks across single, 2-tier, and 3-tier commands', () => {
    const single = JSON.parse(buildCommand({ prompt: 'test' }).content[0].text).command;
    assert.ok(single.includes('--strict-mcp-config'), 'Single-tier Vertex must include --strict-mcp-config');
    assert.ok(single.includes('--settings \'{"disableAllHooks":true}\''), 'Single-tier Vertex must emit --settings with disableAllHooks:true');

    const twoTier = JSON.parse(buildCommand({
      provider: 'enmaas',
      secondaryProject: 'vertex-p2',
      prompt: 'test',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;
    const p2Match = twoTier.match(/_run_primary\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_secondary/);
    const s2Match = twoTier.match(/_run_secondary\s*\(\)\s*\(([^\0]*?)\)\n\s*if \[ -f/);
    assert.ok(p2Match && s2Match, '2-tier command must contain _run_primary and _run_secondary');
    for (const [label, body] of [['2-tier primary', p2Match[1]], ['2-tier secondary', s2Match[1]]]) {
      assert.ok(body.includes('--strict-mcp-config'), `${label} must include --strict-mcp-config`);
      assert.ok(body.includes('"disableAllHooks":true'), `${label} must include "disableAllHooks":true`);
    }

    const threeTier = JSON.parse(buildCommand({
      provider: 'enmaas',
      secondaryProject: 'vertex-p2',
      tertiaryProject: 'vertex-p3',
      prompt: 'test',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;
    const t1Match = threeTier.match(/_run_tier1\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_tier2/);
    const t2Match = threeTier.match(/_run_tier2\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_tier3/);
    const t3Match = threeTier.match(/_run_tier3\s*\(\)\s*\(([^\0]*?)\)\n\s*if \[ -f/);
    assert.ok(t1Match && t2Match && t3Match, '3-tier command must contain _run_tier1, _run_tier2, and _run_tier3');
    for (const [label, body] of [['tier1', t1Match[1]], ['tier2', t2Match[1]], ['tier3', t3Match[1]]]) {
      assert.ok(body.includes('--strict-mcp-config'), `${label} must include --strict-mcp-config`);
      assert.ok(body.includes('"disableAllHooks":true'), `${label} must include "disableAllHooks":true`);
    }
  });

  it('T-S5: enableMcp/enableHooks boolean opt-outs, non-boolean strict guard, and server.js tools/list schema', () => {
    const optOutMcp = JSON.parse(buildCommand({ prompt: 'test', enableMcp: true }).content[0].text).command;
    assert.ok(!optOutMcp.includes('--strict-mcp-config'), 'enableMcp: true must omit --strict-mcp-config');

    const optOutHooksPlain = JSON.parse(buildCommand({ prompt: 'test', enableHooks: true }).content[0].text).command;
    assert.ok(!optOutHooksPlain.includes('disableAllHooks'), 'enableHooks: true must omit disableAllHooks');
    assert.ok(!optOutHooksPlain.includes('--settings'), 'enableHooks: true on plain Vertex must omit --settings completely');

    const optOutHooksEnmaas = JSON.parse(buildCommand({ provider: 'enmaas', prompt: 'test', enableHooks: true }).content[0].text).command;
    assert.ok(!optOutHooksEnmaas.includes('disableAllHooks'), 'enableHooks: true on EnMaaS must omit disableAllHooks');
    assert.ok(
      optOutHooksEnmaas.includes('--settings \'{"env":{"CLAUDE_CODE_USE_VERTEX":""}}\''),
      'enableHooks: true on EnMaaS must preserve env-only --settings'
    );

    const nonBool = JSON.parse(buildCommand({ prompt: 'test', enableMcp: 'true', enableHooks: 1 }).content[0].text).command;
    assert.ok(nonBool.includes('--strict-mcp-config'), 'Non-boolean enableMcp: "true" must enforce --strict-mcp-config');
    assert.ok(nonBool.includes('"disableAllHooks":true'), 'Non-boolean enableHooks: 1 must enforce "disableAllHooks":true');

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const serverJsPath = path.resolve(__dirname, '../server.js');
    const rpcInput = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'atdd', version: '1.0.0' } },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ].join('\n') + '\n';

    const srv = spawnSync('node', [serverJsPath], { input: rpcInput, encoding: 'utf8', timeout: 5000 });
    assert.equal(srv.status, 0, `server.js exited ${srv.status}: ${srv.stderr}`);
    const listResp = srv.stdout
      .trim()
      .split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((m) => m && m.id === 2);
    assert.ok(listResp?.result?.tools, 'tools/list response (id: 2) must be returned');
    const promptTool = listResp.result.tools.find((t) => t.name === 'claude_prompt');
    assert.ok(promptTool, 'claude_prompt tool must be registered');
    assert.equal(promptTool.inputSchema?.properties?.enableHooks?.type, 'boolean', 'enableHooks schema type must be boolean');
    assert.equal(promptTool.inputSchema?.properties?.enableMcp?.type, 'boolean', 'enableMcp schema type must be boolean');
    assert.match(promptTool.description || '', /stdout/i, 'claude_prompt description must mention stdout progress/session placement');
    assert.match(promptTool.description || '', /stderr/i, 'claude_prompt description must mention stderr progress/session placement');
    assert.match(promptTool.description || '', /session/i, 'claude_prompt description must mention session');
  });

  it('T-S8: line-budget fitness (<=100 lines), node --check, bash -n, and tracked-file path hygiene', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(__dirname, '..');
    const rootJsFiles = [
      'server.js',
      'command-builder.js',
      'failover.js',
      'failover-scripts.js',
      'models.js',
      'modes.js',
      'providers.js',
      'stream-format.js',
    ];

    for (const file of rootJsFiles) {
      const fullPath = path.join(rootDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const lineCount = content.replace(/\n$/, '').split('\n').length;
      assert.ok(lineCount <= 100, `${file} must be <= 100 lines (got ${lineCount})`);
      assert.doesNotThrow(() => {
        execSync(`node --check "${fullPath}"`, { stdio: 'pipe' });
      }, `${file} must pass node --check`);
    }

    for (const shFile of ['setup.sh', 'install.sh']) {
      const fullPath = path.join(rootDir, shFile);
      assert.doesNotThrow(() => {
        execSync(`bash -n "${fullPath}"`, { stdio: 'pipe' });
      }, `${shFile} must pass bash -n`);
    }

    const tierCmds = [
      JSON.parse(buildCommand({ prompt: 'test 1-tier' }).content[0].text).command,
      JSON.parse(buildCommand({ provider: 'enmaas', secondaryProject: 'p2', prompt: 'test 2-tier' }, { ENMAAS_KEY: 'k' }).content[0].text).command,
      JSON.parse(buildCommand({ provider: 'enmaas', secondaryProject: 'p2', tertiaryProject: 'p3', prompt: 'test 3-tier' }, { ENMAAS_KEY: 'k' }).content[0].text).command,
    ];
    for (const [idx, cmd] of tierCmds.entries()) {
      assert.doesNotThrow(() => {
        execSync('bash -n', { input: cmd, stdio: ['pipe', 'pipe', 'pipe'] });
      }, `${idx + 1}-tier generated command must pass bash -n`);
    }

    const testFiles = fs.readdirSync(path.join(rootDir, 'test'))
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => path.join('test', f));
    const trackedFiles = [
      ...rootJsFiles,
      'README.md',
      path.join('skills', 'claude-dispatch', 'SKILL.md'),
      'setup.sh',
      'install.sh',
      ...testFiles,
    ];
    const homePathRe = new RegExp('/' + 'home/[a-z0-9_-]+/', 'i');
    for (const rel of trackedFiles) {
      const content = fs.readFileSync(path.join(rootDir, rel), 'utf8');
      assert.ok(!homePathRe.test(content), `${rel} must not contain hardcoded developer home path`);
    }
  });
});

describe('Cross-Provider Failover (EnMaaS -> Vertex) (T-24 to T-36)', () => {
  it('T-24: resolveFailoverConfig detects cross-provider failover when provider: "enmaas" and secondary project is provided', async () => {
    const { resolveFailoverConfig } = await getFailover();
    const config = resolveFailoverConfig('enmaas', { secondaryProject: 'vertex-project-2' }, {});
    assert.equal(config.enabled, true, 'Failover must be enabled');
    assert.equal(config.type, 'cross-provider', 'Failover type must be cross-provider');
    assert.equal(config.secondaryProject, 'vertex-project-2');
  });

  it('T-24b: resolveFailoverConfig detects cross-provider failover when provider: "auto" resolves to EnMaaS and secondary Vertex project is provided', async () => {
    const { resolveFailoverConfig } = await getFailover();
    const config = resolveFailoverConfig('auto', { model: 'rits/zai-org/glm-5-3', secondaryProject: 'vertex-project-2' }, {});
    assert.equal(config.enabled, true, 'Failover must be enabled');
    assert.equal(config.type, 'cross-provider', 'Failover type must be cross-provider');
    assert.equal(config.secondaryProject, 'vertex-project-2');
  });

  it('T-25: resolveFailoverConfig resolves secondary project and credentials from primary fallback', async () => {
    const { resolveFailoverConfig } = await getFailover();
    const configFromParams = resolveFailoverConfig('enmaas', {
      primaryProject: 'vertex-project-2',
      primaryCredentials: '/path/to/primary-sa.json',
    }, {});
    assert.equal(configFromParams.enabled, true, 'Failover must be enabled via primary fallback');
    assert.equal(configFromParams.secondaryProject, 'vertex-project-2');
    assert.equal(configFromParams.secondaryCredentials, '/path/to/primary-sa.json');

    const configFromEnv = resolveFailoverConfig('enmaas', {}, {
      VERTEX_PRIMARY_PROJECT: 'env-insights',
      GOOGLE_APPLICATION_CREDENTIALS: '/env/sa.json',
    });
    assert.equal(configFromEnv.enabled, true, 'Failover must be enabled via env primary fallback');
    assert.equal(configFromEnv.secondaryProject, 'env-insights');
    assert.equal(configFromEnv.secondaryCredentials, '/env/sa.json');
  });

  it('T-26: resolveSecondaryModel maps rits/* or / models to canonical sonnet and normalizes legacy 5-5 models (T-3)', async () => {
    const { resolveSecondaryModel } = await getFailover();
    assert.equal(resolveSecondaryModel('rits/zai-org/glm-5-3'), 'sonnet');
    assert.equal(resolveSecondaryModel('some/model/path'), 'sonnet');
    assert.equal(resolveSecondaryModel('claude-opus-5-5'), 'opus');
    assert.equal(resolveSecondaryModel('claude-opus-5'), 'opus');
    assert.equal(resolveSecondaryModel('claude-sonnet-5-5'), 'sonnet');
    assert.equal(resolveSecondaryModel('rits/zai-org/glm-5-3', 'claude-opus-5-5'), 'opus');
    assert.equal(resolveSecondaryModel('rits/zai-org/glm-5-3', 'claude-3-5-sonnet'), 'claude-3-5-sonnet');
    assert.equal(resolveSecondaryModel('claude-3-5-sonnet-v20241022'), 'claude-3-5-sonnet-v20241022');
  });

  it('T-27: Cross-provider failover script contains isolated _run_primary() and _run_secondary()', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'vertex-project-2',
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
      secondaryProject: 'vertex-project-2',
      prompt: 'test secondary environment unset',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(
      parsed.command.includes('unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY') ||
      parsed.command.includes('unset ANTHROPIC_BASE_URL') && parsed.command.includes('unset ANTHROPIC_API_KEY'),
      'Secondary runner must unset gateway variables'
    );
  });

  it('T-29: _run_secondary() omits EnMaaS settings and injects Vertex tier --settings overriding ANTHROPIC_VERTEX_PROJECT_ID (T-4)', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'vertex-project-2',
      secondaryCredentials: '/creds/sec.json',
      prompt: 'test settings flag isolation',
    });
    const parsed = JSON.parse(result.content[0].text);
    const primaryMatch = parsed.command.match(/_run_primary\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_secondary/);
    const secondaryMatch = parsed.command.match(/_run_secondary\s*\(\)\s*\(([^\0]*?)\)\n\s*if \[ -f/);
    assert.ok(primaryMatch[1].includes('--settings \'{"env":{"CLAUDE_CODE_USE_VERTEX":""},"disableAllHooks":true}\''), '_run_primary must include EnMaaS --settings flag');
    assert.ok(!secondaryMatch[1].includes('"CLAUDE_CODE_USE_VERTEX":""'), '_run_secondary must not include EnMaaS empty CLAUDE_CODE_USE_VERTEX setting');
    assert.ok(
      secondaryMatch[1].includes('--settings \'{"env":{"CLAUDE_CODE_USE_VERTEX":"1","ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-2","CLOUDSDK_CORE_PROJECT":"vertex-project-2","GOOGLE_APPLICATION_CREDENTIALS":"/creds/sec.json"},"disableAllHooks":true}\''),
      '_run_secondary must include Vertex --settings JSON overriding project and credentials'
    );
  });

  it('T-29b: 2-tier Vertex failover injects per-tier --settings into _run_primary and _run_secondary (T-4)', () => {
    const result = buildCommand({
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      primaryCredentials: '/creds/p1.json',
      secondaryProject: 'vertex-project-2',
      secondaryCredentials: '/creds/p2.json',
      prompt: 'test 2-tier vertex settings',
    });
    const parsed = JSON.parse(result.content[0].text);
    const primaryMatch = parsed.command.match(/_run_primary\s*\(\)\s*\(([^\0]*?)\)\n\s*_run_secondary/);
    const secondaryMatch = parsed.command.match(/_run_secondary\s*\(\)\s*\(([^\0]*?)\)\n\s*if \[ -f/);
    assert.ok(primaryMatch, 'Must contain _run_primary');
    assert.ok(secondaryMatch, 'Must contain _run_secondary');
    assert.ok(
      primaryMatch[1].includes('"ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-1"') &&
      primaryMatch[1].includes('"GOOGLE_APPLICATION_CREDENTIALS":"/creds/p1.json"'),
      '_run_primary must include Tier 1 Vertex --settings'
    );
    assert.ok(
      secondaryMatch[1].includes('"ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-2"') &&
      secondaryMatch[1].includes('"GOOGLE_APPLICATION_CREDENTIALS":"/creds/p2.json"'),
      '_run_secondary must include Tier 2 Vertex --settings'
    );
  });

  it('T-30: Stderr pattern matcher includes POSIX character classes for 429|502|503|504|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'vertex-project-2',
      prompt: 'test',
    });
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.command.includes('429') && parsed.command.includes('502|503|504'), 'Must match 429/50x');
    assert.ok(parsed.command.includes('ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT'), 'Must match network errors');
  });

  it('T-31: Stderr pattern matcher excludes 400/401/403', () => {
    const result = buildCommand({
      provider: 'enmaas',
      secondaryProject: 'vertex-project-2',
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
      secondaryProject: 'vertex-project-2',
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
      secondaryProject: 'vertex-project-2',
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

  it('T-37: Non-failover command redirects stderr through REDACT_SED (C7-11 / T-P6-5)', () => {
    const res = buildCommand({ prompt: 'test non-failover redaction' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;
    assert.ok(cmd.includes('2>&1 1>&3'), 'Command must redirect stderr for redaction');
    assert.ok(cmd.includes('3>&1'), 'Command must restore stdout descriptor');
    assert.ok(cmd.includes('sed -E'), 'Command must pipe stderr through sed');
  });

  it('T-38: Non-failover command redacts bearer tokens emitted to stderr during runtime execution (C7-11 / T-P6-5)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-non-failover-'));
    try {
      const mockBin = path.join(tmpDir, 'mock-claude.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\necho "Authorization: Bearer super-secret-token" >&2\necho "NORMAL_OUTPUT"\nexit 0\n', { mode: 0o755 });
      const res = buildCommand({ prompt: 'test stderr leak' }, { CLAUDE_BIN: mockBin });
      const parsed = JSON.parse(res.content[0].text);
      const wrapperScript = `
        OUT=$(${parsed.command} 2>"${tmpDir}/err.log")
        cat "${tmpDir}/err.log"
      `;
      const capturedStderr = execSync(wrapperScript, { shell: '/bin/bash', stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      assert.ok(!capturedStderr.includes('super-secret-token'), 'Bearer token on stderr must be redacted');
      assert.ok(capturedStderr.includes('[REDACTED]'), 'Must contain [REDACTED]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
