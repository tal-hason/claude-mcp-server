// claude-mcp-server/test/darwin-audit.test.js
// @ai-rules: [Pattern]: Verification of Darwin Multi-Lens & Governance Findings (N-1, F-1r, F-11, N-10, F-17).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommand } from '../command-builder.js';
import { resolveFailoverConfig } from '../failover.js';
import { createEnvScrubber, TRACKED_ENV_VARS } from './helpers/env.js';

const scrubber = createEnvScrubber();
beforeEach(() => scrubber.scrub());
afterEach(() => scrubber.restore());

describe('Darwin Remediation - N-1: Provider Resolution Precedence', () => {
  it('explicit provider: vertex with RITS model does NOT resolve to EnMaaS (N-1)', () => {
    const config = resolveFailoverConfig({
      provider: 'vertex',
      model: 'rits/zai-org/glm-5-3',
      secondaryProject: 'proj-sec',
    }, { ENMAAS_KEY: 'mock-key' });

    assert.equal(config.type, 'vertex');
    assert.equal(config.secondaryProject, 'proj-sec');
  });

  it('explicit provider: enmaas with Claude model resolves to EnMaaS (N-1)', () => {
    const config = resolveFailoverConfig({
      provider: 'enmaas',
      model: 'claude-sonnet-5-5',
      secondaryProject: 'proj-sec',
    }, { ENMAAS_KEY: 'mock-key' });

    assert.equal(config.type, 'cross-provider');
    assert.equal(config.primaryProvider, 'enmaas');
  });
});

describe('Darwin Remediation - F-1r: Combined Prompt + SystemPrompt Guard', () => {
  it('rejects when prompt + systemPrompt byte length exceeds 100KB (F-1r)', () => {
    const prompt = 'a'.repeat(60 * 1024);
    const systemPrompt = 'b'.repeat(50 * 1024);
    const res = buildCommand({ prompt, systemPrompt });

    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes('100KB'));
  });

  it('accepts when prompt + systemPrompt combined byte length is <= 100KB (F-1r)', () => {
    const prompt = 'a'.repeat(40 * 1024);
    const systemPrompt = 'b'.repeat(40 * 1024);
    const res = buildCommand({ prompt, systemPrompt });

    assert.equal(res.isError, undefined);
    assert.ok(res.content[0].text);
  });
});

describe('Darwin Remediation - F-17: Project Collision Deduplication', () => {
  it('discards secondary project when identical to primary project (F-17)', () => {
    const config = resolveFailoverConfig({
      provider: 'vertex',
      primaryProject: 'my-proj',
      secondaryProject: 'my-proj',
    }, {});

    assert.equal(config.secondaryProject, undefined);
    assert.equal(config.enabled, false);
  });

  it('discards tertiary project when identical to primary or secondary (F-17)', () => {
    const config1 = resolveFailoverConfig({
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
      tertiaryProject: 'p1',
    }, {});
    assert.equal(config1.hasTertiary, false);

    const config2 = resolveFailoverConfig({
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
      tertiaryProject: 'p2',
    }, {});
    assert.equal(config2.hasTertiary, false);
  });

  it('promotes tertiary project when secondary is omitted or matches primary (F-17)', () => {
    const config = resolveFailoverConfig({
      provider: 'vertex',
      primaryProject: 'p1',
      tertiaryProject: 'p3',
    }, {});

    assert.equal(config.secondaryProject, 'p3');
    assert.equal(config.hasTertiary, false);
    assert.equal(config.enabled, true);
  });

  it('deduplicates tertiary for cross-provider EnMaaS when identical to secondary (F-17)', () => {
    const config = resolveFailoverConfig({
      provider: 'enmaas',
      secondaryProject: 'proj-sec',
      tertiaryProject: 'proj-sec',
    }, { ENMAAS_KEY: 'k' });

    assert.equal(config.hasTertiary, false);
  });
});

describe('Darwin Remediation - F-11 & N-10: Runtime Failover Simulation', () => {
  let tmpDir, mockClaudeBin, behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-audit-test-'));
    mockClaudeBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stub = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    EXIT_124)
      echo "Command timed out" >&2
      exit 124
      ;;
    QUOTA_429)
      echo "HTTP 429 RESOURCE_EXHAUSTED" >&2
      exit 1
      ;;
    T3_FAIL)
      echo "HTTP 500 Internal Error on T3" >&2
      exit 1
      ;;
    SUCCESS_*)
      echo "AUDIT_SUCCESS: $ACTION proj=$ANTHROPIC_VERTEX_PROJECT_ID"
      exit 0
      ;;
    *)
      echo "UNKNOWN: $ACTION" >&2
      exit 1
      ;;
  esac
fi
exit 0
`;
    fs.writeFileSync(mockClaudeBin, stub, { mode: 0o755 });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('exit code 124 (timeout) on primary triggers failover to secondary (F-11)', () => {
    fs.writeFileSync(behaviorFile, 'EXIT_124\nSUCCESS_SECONDARY\n');
    const res = buildCommand({
      prompt: 'test timeout',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('AUDIT_SUCCESS: SUCCESS_SECONDARY'));
    assert.ok(out.includes('proj=p2'));
  });

  it('shared-quota bypass falls back to Tier 2 when Tier 3 fails (N-10)', () => {
    fs.writeFileSync(behaviorFile, 'QUOTA_429\nT3_FAIL\nSUCCESS_FALLBACK_T2\n');
    const res = buildCommand({
      prompt: 'test quota bypass fallback',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('AUDIT_SUCCESS: SUCCESS_FALLBACK_T2'));
    assert.ok(out.includes('proj=proj-t2-shared'));
  });
});

describe('Darwin Remediation - N-6: Ambient Polluted Environment Immunity', () => {
  it('cleanly isolates execution regardless of ambient polluted variables (N-6)', () => {
    // Pollute all tracked environment variables
    const polluted = {};
    for (const k of TRACKED_ENV_VARS) {
      polluted[k] = `polluted-${k.toLowerCase()}`;
    }
    scrubber.scrub(polluted);

    // Call buildCommand without provider or project params
    const res = buildCommand({ prompt: 'test polluted', mode: 'architect' });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command);
  });
});

describe('Darwin Remediation - N-12: Deduplicated Tier Args with System Prompt and Resume', () => {
  it('ensures tertiaryArgs contains --system-prompt and --resume flags matching secondary (N-12)', () => {
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'reviewer',
      provider: 'enmaas',
      systemPrompt: 'custom system prompt',
      sessionId: 'sess-12345',
      secondaryProject: 'proj-sec',
      tertiaryProject: 'proj-tert',
    }, { ENMAAS_KEY: 'test-key' });

    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    const t3Match = cmd.match(/_run_tier3\s*\(\)\s*\(([\s\S]*?)\n\s*\)/);
    assert.ok(t3Match, '_run_tier3 must be defined');
    const t3Body = t3Match[1];
    assert.ok(t3Body.includes('--system-prompt'), 'tier 3 must include --system-prompt');
    assert.ok(t3Body.includes('--resume'), 'tier 3 must include --resume');
    assert.ok(t3Body.includes("'sess-12345'"), 'tier 3 must include sessionId');
  });
});

describe('Darwin Remediation - F-8: Stderr Secret Redaction', () => {
  it('redacts Authorization: Bearer, Proxy-Authorization, ENMAAS_KEY, private_key_id, and PEM bodies (F-8)', () => {
    const testCases = [
      'Authorization: Bearer my-secret-token-abc',
      'Proxy-Authorization: Basic dXNlcjpwYXNz',
      'ENMAAS_KEY=secret_key_123',
      'TOKEN: "top-secret-token"',
      'private_key_id: "pk-987654321"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----',
    ];

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-redact-'));
    const mockBin = path.join(tmpDir, 'mock-err.sh');
    const errText = testCases.join('\n');
    fs.writeFileSync(mockBin, `#!/bin/bash\ncat <<'EOF' >&2\n${errText}\nEOF\nexit 1\n`, { mode: 0o755 });

    try {
      const res = buildCommand({
        prompt: 'test redaction',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      let stderrOutput = '';
      try {
        execSync('bash', {
          input: parsed.command,
          env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        stderrOutput = err.stderr ? err.stderr.toString() : '';
      }

      assert.ok(!stderrOutput.includes('my-secret-token-abc'), 'bearer token must be redacted');
      assert.ok(!stderrOutput.includes('dXNlcjpwYXNz'), 'proxy auth credentials must be redacted');
      assert.ok(!stderrOutput.includes('secret_key_123'), 'ENMAAS_KEY must be redacted');
      assert.ok(!stderrOutput.includes('top-secret-token'), 'TOKEN must be redacted');
      assert.ok(!stderrOutput.includes('pk-987654321'), 'private_key_id must be redacted');
      assert.ok(!stderrOutput.includes('MIIEowIBAAKCAQEA0'), 'PEM body must be redacted');
      assert.ok(stderrOutput.includes('[REDACTED_PEM]'), 'PEM replacement marker must be present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Darwin Remediation - N-2: Linear Non-Looping Cascade Bounded Invocations', () => {
  it('makes at most 3 invocations when all tiers fail and terminates without looping (N-2)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-invoke-'));
    const countFile = path.join(tmpDir, 'count.txt');
    fs.writeFileSync(countFile, '0');
    const mockBin = path.join(tmpDir, 'mock-count.sh');
    fs.writeFileSync(mockBin, `#!/bin/bash
COUNT=$(cat "${countFile}")
echo $((COUNT + 1)) > "${countFile}"
echo "HTTP 500 Internal Error" >&2
exit 1
`, { mode: 0o755 });

    try {
      const res = buildCommand({
        prompt: 'test linear cascade',
        mode: 'executor',
        provider: 'enmaas',
        secondaryProject: 'proj-sec',
        tertiaryProject: 'proj-tert',
      }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      try {
        execSync('bash', {
          input: parsed.command,
          env: { ...process.env, XDG_RUNTIME_DIR: tmpDir, ENMAAS_KEY: 'test-key' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (_) {}

      const totalCalls = parseInt(fs.readFileSync(countFile, 'utf8').trim(), 10);
      assert.ok(totalCalls <= 3, `Expected <= 3 invocations, got ${totalCalls}`);
      assert.equal(totalCalls, 3, 'Must attempt exactly Tier 1, Tier 2, Tier 3 before final exit');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
