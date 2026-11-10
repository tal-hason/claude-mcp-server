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
import { resolveGcpProjects } from '../providers.js';
import { REDACT_SED } from '../failover-scripts.js';
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

describe('Farley ATDD T-1: resolveGcpProjects Parameter Resolution (providers.js)', () => {
  it('resolves primaryProject and explicitPrimaryProject from params.project (T-1)', () => {
    const res = resolveGcpProjects({ project: 'proj-abc', credentials: 'creds-xyz' }, {});
    assert.strictEqual(res.primaryProject, 'proj-abc', 'primaryProject must inherit params.project');
    assert.strictEqual(res.explicitPrimaryProject, 'proj-abc', 'explicitPrimaryProject must inherit params.project');
    assert.strictEqual(res.primaryCredentials, 'creds-xyz', 'primaryCredentials must inherit params.credentials');
    assert.strictEqual(res.explicitPrimaryCredentials, 'creds-xyz', 'explicitPrimaryCredentials must inherit params.credentials');
  });

  it('prefers explicit primaryProject over legacy project parameter (T-1)', () => {
    const res = resolveGcpProjects({ primaryProject: 'explicit-p1', project: 'legacy-p1' }, {});
    assert.strictEqual(res.primaryProject, 'explicit-p1');
    assert.strictEqual(res.explicitPrimaryProject, 'explicit-p1');
  });
});

describe('Farley ATDD T-2 & T-3: System Prompt File vs Inlined Argument Assembly (command-builder.js)', () => {
  it('passes system prompt via file $(cat _spfile) when failover is enabled (T-2)', () => {
    const res = buildCommand({
      prompt: 'test prompt',
      systemPrompt: 'System instruction test',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(
      parsed.command.includes('--system-prompt "$(< "$_spfile")"'),
      'Failover cascade must pass file-based system prompt --system-prompt "$(< "$_spfile")" to prevent E2BIG'
    );
  });

  it('uses inlined system prompt when failover is disabled (T-3)', () => {
    const res = buildCommand({
      prompt: 'test prompt',
      systemPrompt: 'System instruction test',
    });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(
      parsed.command.includes("--system-prompt 'System instruction test'"),
      'Non-failover command must use inlined system prompt'
    );
    assert.ok(
      !parsed.command.includes('--system-prompt "$(< "$_spfile")"'),
      'Non-failover command must not reference _spfile in args'
    );
  });
});

describe('Farley ATDD T-5: Timeout Process Group Termination Without Foreground (failover-scripts.js)', () => {
  it('invokes GNU timeout without --foreground to ensure process group creation (T-5)', () => {
    const res = buildCommand({
      prompt: 'test timeout foreground',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(!cmd.includes('timeout --foreground'), 'timeout must not include --foreground');
    assert.ok(cmd.includes('timeout --kill-after=10s'), 'timeout must include --kill-after=10s');
  });

  it('terminates background child processes cleanly on timeout (T-5)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-t5-'));
    try {
      const childPidFile = path.join(tmpDir, 'child.pid');
      const mockBin = path.join(tmpDir, 'mock-spawn-sleep.sh');
      fs.writeFileSync(mockBin, `#!/bin/bash
sleep 20 &
echo $! > "${childPidFile}"
sleep 10
exit 0
`, { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test timeout orphan',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);

      let exitCode = 0;
      try {
        execSync('bash', {
          input: parsed.command,
          env: { ...process.env, CLAUDE_TIMEOUT: '1', XDG_RUNTIME_DIR: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        exitCode = err.status;
      }

      assert.strictEqual(exitCode, 124, 'Command must exit with code 124 on timeout');
      assert.ok(fs.existsSync(childPidFile), 'childPidFile must exist');
      const childPid = fs.readFileSync(childPidFile, 'utf8').trim();
      assert.ok(childPid, 'childPid must be non-empty');
      const pidNum = parseInt(childPid, 10);
      let isAlive = false;
      try {
        process.kill(pidNum, 0);
        isAlive = true;
        if (process.platform === 'linux') {
          try {
            const status = fs.readFileSync(`/proc/${pidNum}/status`, 'utf8');
            const stateMatch = status.match(/^State:\s+([A-Z])/m);
            if (stateMatch && (stateMatch[1] === 'Z' || stateMatch[1] === 'X')) {
              isAlive = false;
            }
          } catch (_) {
            isAlive = false;
          }
        }
      } catch (_) {
        isAlive = false;
      }
      assert.strictEqual(isAlive, false, 'Background child process must be terminated by process group kill');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Farley ATDD T-6: Concurrent Session Isolation and Buffer Scoping (failover-scripts.js)', () => {
  it('Session 1 trap removes out.$$.* without touching Session 2 buffer file in shared marker dir (T-6)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-t6-'));
    try {
      const markerDir = path.join(tmpDir, `claude-cli-${process.getuid ? process.getuid() : 0}`);
      fs.mkdirSync(markerDir, { recursive: true });
      const session2Buffer = path.join(markerDir, 'out.99999.sess2');
      fs.writeFileSync(session2Buffer, 'session-2-active-data');

      const mockBin = path.join(tmpDir, 'mock-claude.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\necho "SESSION_1_SUCCESS"\nexit 0\n', { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test concurrent isolation',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);

      assert.ok(parsed.command.includes('out.$$.*'), 'Buffer files must be PID-scoped (out.$$.*) to isolate concurrent sessions');
      assert.ok(!parsed.command.includes('rm -f "$_marker_dir"/out.$$*'), 'Cleanup trap must have dot after $$ (out.$$.*)');
      assert.ok(!parsed.command.includes('rm -f "$_marker_dir"/out.*'), 'Cleanup trap must not wildcard delete out.*');

      const testCollisionFile = path.join(tmpDir, 'test-collision.sh');
      fs.writeFileSync(testCollisionFile, `#!/bin/bash
PID=$$
COLLIDE="${markerDir}/out.\${PID}99.test"
echo "colliding" > "$COLLIDE"
${parsed.command}
if [ -f "$COLLIDE" ]; then
  echo "COLLIDE_PRESERVED"
else
  echo "COLLIDE_DELETED"
fi
`, { mode: 0o755 });

      const runOut = execSync(testCollisionFile, {
        env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();

      assert.ok(runOut.includes('COLLIDE_PRESERVED'), 'out.$$.* cleanup must not delete colliding PID prefix file');
      assert.ok(fs.existsSync(session2Buffer), 'Session 2 buffer file must not be deleted by Session 1 trap cleanup');
      assert.strictEqual(fs.readFileSync(session2Buffer, 'utf8'), 'session-2-active-data');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Farley ATDD T-7: Sticky Marker Creation, Absence on Failure, and Deletion Lifecycle (failover-scripts.js)', () => {
  let tmpDir, mockBin, behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-t7-'));
    mockBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stub = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    FAIL_INFRA)
      echo "HTTP 500 Internal Server Error" >&2
      exit 1
      ;;
    SUCCESS_*)
      echo "SUCCESS: $ACTION"
      exit 0
      ;;
    *)
      exit 1
      ;;
  esac
fi
exit 0
`;
    fs.writeFileSync(mockBin, stub, { mode: 0o755 });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('touches sticky marker on secondary success in dual-subshell (T-7)', () => {
    fs.writeFileSync(behaviorFile, 'FAIL_INFRA\nSUCCESS_SECONDARY\n');
    const res = buildCommand({
      prompt: 'test dual marker',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockBin });

    const parsed = JSON.parse(res.content[0].text);
    execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const markerDir = path.join(tmpDir, `claude-cli-${process.getuid ? process.getuid() : 0}`);
    const markers = (fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : []).filter(f => f.startsWith('failover_'));
    assert.strictEqual(markers.length, 1, 'Sticky marker must be created on secondary success');
  });

  it('does NOT touch sticky marker when secondary fails in dual-subshell (T-7)', () => {
    fs.writeFileSync(behaviorFile, 'FAIL_INFRA\nFAIL_INFRA\n');
    const res = buildCommand({
      prompt: 'test dual marker fail',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockBin });

    const parsed = JSON.parse(res.content[0].text);
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (_) {}

    const markerDir = path.join(tmpDir, `claude-cli-${process.getuid ? process.getuid() : 0}`);
    const markers = (fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : []).filter(f => f.startsWith('failover_'));
    assert.strictEqual(markers.length, 0, 'Sticky marker must NOT be created when secondary fails');
  });

  it('deletes stale sticky marker when Tier 1 succeeds directly (T-7)', () => {
    const res = buildCommand({
      prompt: 'test tier 1 clean',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'p2',
      tertiaryProject: 'p3',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockBin });

    const parsed = JSON.parse(res.content[0].text);
    const mMatch = parsed.command.match(/_marker_t2="\$[^"]+\/([^"]+)"/);
    assert.ok(mMatch, 'Must find _marker_t2 in cascade script');
    const markerDir = path.join(tmpDir, `claude-cli-${process.getuid ? process.getuid() : 0}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const markerFile = path.join(markerDir, mMatch[1]);
    fs.writeFileSync(markerFile, 'stale');
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60 * 1000);
    fs.utimesSync(markerFile, fortyMinutesAgo, fortyMinutesAgo);

    fs.writeFileSync(behaviorFile, 'SUCCESS_PRIMARY\n');
    execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir, ENMAAS_KEY: 'test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    assert.ok(!fs.existsSync(markerFile), 'Sticky marker must be deleted when Tier 1 succeeds');
  });
});

describe('Farley ATDD T-8: Signal Trap Disarm and Process Group Protection (failover-scripts.js)', () => {
  it('disarms traps and does not invoke kill -- -$$ on signal exit (T-8)', () => {
    const res = buildCommand({
      prompt: 'test trap disarm',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('trap - INT TERM EXIT'), 'Cleanup trap must disarm INT TERM EXIT signals');
    assert.ok(!cmd.includes('kill -- -$$'), 'Cleanup trap must not signal parent process group with kill -- -$$');
    assert.ok(cmd.includes("trap '_cleanup 143' TERM"), 'TERM trap must exit with code 143');
    assert.ok(cmd.includes("trap '_cleanup 130' INT"), 'INT trap must exit with code 130');
  });

  it('exits with code 143 when receiving SIGTERM without terminating parent runner (T-8)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-t8-'));
    try {
      const mockBin = path.join(tmpDir, 'mock-sleep.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\nsleep 30\n', { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test sigterm',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);

      const runScript = path.join(tmpDir, 'run.sh');
      fs.writeFileSync(runScript, '#!/bin/bash\n' + parsed.command + '\n', { mode: 0o755 });

      const script = `
        "${runScript}" >/dev/null 2>&1 &
        PID=$!
        sleep 0.2
        kill -TERM $PID 2>/dev/null || true
        wait $PID
        echo "EXIT_CODE=$?"
      `;
      const out = execSync(script, {
        shell: '/bin/bash',
        env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();

      assert.ok(out.includes('EXIT_CODE=143'), `Expected exit code 143 on SIGTERM, got: ${out.trim()}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Farley ATDD T-9: Node and Formatter Preflight Validation (command-builder.js)', () => {
  it('generates preflight check for node binary and format-stream.js (T-9)', () => {
    const res = buildCommand({ prompt: 'test preflight', mode: 'architect' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(
      cmd.includes('command -v node >/dev/null 2>&1 && [ -f'),
      'Command must check that node binary and format-stream.js exist'
    );
    assert.ok(
      cmd.includes('[claude-mcp] Error: node or formatter missing'),
      'Command must output exact preflight error message on failure'
    );
  });

  it('fails fast with code 1 and error message when node binary is missing from PATH (T-9)', () => {
    const res = buildCommand({ prompt: 'test preflight fail', mode: 'architect' });
    const parsed = JSON.parse(res.content[0].text);

    const mockBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-mock-bin-'));
    let failed = false;
    let stderr = '';
    let exitCode = 0;
    try {
      const bashBin = execSync('which bash').toString().trim();
      const dateBin = execSync('which date').toString().trim();
      fs.symlinkSync(bashBin, path.join(mockBinDir, 'bash'));
      fs.symlinkSync(dateBin, path.join(mockBinDir, 'date'));

      try {
        execSync('bash', {
          input: parsed.command,
          env: { ...process.env, PATH: mockBinDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        failed = true;
        exitCode = err.status;
        stderr = err.stderr ? err.stderr.toString() : '';
      }
    } finally {
      fs.rmSync(mockBinDir, { recursive: true, force: true });
    }

    assert.ok(failed, 'Command must exit with non-zero when node is missing');
    assert.strictEqual(exitCode, 1, 'Command must exit with code 1 when preflight check fails');
    assert.ok(
      stderr.includes('[claude-mcp] Error: node or formatter missing'),
      `Stderr must contain preflight error, got: ${stderr}`
    );
  });
});

describe('Farley ATDD T-10: Sticky Marker Expiration and Bypass Lifecycle (failover-scripts.js)', () => {
  let tmpDir, mockBin, behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-t10-'));
    mockBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stub = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    SUCCESS_*)
      echo "AUDIT_SUCCESS: $ACTION proj=$ANTHROPIC_VERTEX_PROJECT_ID"
      exit 0
      ;;
    *)
      exit 1
      ;;
  esac
fi
exit 0
`;
    fs.writeFileSync(mockBin, stub, { mode: 0o755 });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('fresh sticky marker (mtime < 30m) routes directly to Tier 2 (T-10)', () => {
    const res = buildCommand({
      prompt: 'test fresh marker',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockBin });

    const parsed = JSON.parse(res.content[0].text);
    const mMatch = parsed.command.match(/_marker="\$[^"]+\/([^"]+)"/);
    assert.ok(mMatch, 'Must find marker name in script');
    const markerDir = path.join(tmpDir, `claude-cli-${process.getuid ? process.getuid() : 0}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const markerFile = path.join(markerDir, mMatch[1]);
    fs.writeFileSync(markerFile, 'active');

    fs.writeFileSync(behaviorFile, 'SUCCESS_SECONDARY\n');
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('AUDIT_SUCCESS: SUCCESS_SECONDARY'));
    assert.ok(out.includes('proj=p2'), 'Must run with secondary project p2');
  });

  it('expired sticky marker (mtime > 30m) bypasses failover and runs Tier 1 (T-10)', () => {
    const res = buildCommand({
      prompt: 'test expired marker',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    }, { CLAUDE_BIN: mockBin });

    const parsed = JSON.parse(res.content[0].text);
    const mMatch = parsed.command.match(/_marker="\$[^"]+\/([^"]+)"/);
    assert.ok(mMatch, 'Must find marker name in script');
    const markerDir = path.join(tmpDir, `claude-cli-${process.getuid ? process.getuid() : 0}`);
    fs.mkdirSync(markerDir, { recursive: true });
    const markerFile = path.join(markerDir, mMatch[1]);

    fs.writeFileSync(markerFile, 'stale');
    const fortyMinutesAgo = new Date(Date.now() - 40 * 60 * 1000);
    fs.utimesSync(markerFile, fortyMinutesAgo, fortyMinutesAgo);

    fs.writeFileSync(behaviorFile, 'SUCCESS_PRIMARY\n');
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('AUDIT_SUCCESS: SUCCESS_PRIMARY'));
    assert.ok(out.includes('proj=p1'), 'Must run with primary project p1');
  });
});

describe('Darwin Pass 6 Remediation: Process Safety & Sweep Hardening (C7-2, C7-4, C7-6, C7-12)', () => {
  it('_cleanup traps and _run_to properly handle timeout process group signaling (C7-2 / T-P6-2)', () => {
    const res = buildCommand({
      prompt: 'test pgid signal',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;
    assert.ok(cmd.includes('kill -TERM -$_tp "$_tp"'), '_cleanup must signal timeout process group leader with kill -TERM -$_tp "$_tp"');
    assert.ok(cmd.includes('[ "$_tp" -gt 1 ]'), '_cleanup must guard $_tp > 1');
    assert.ok(cmd.includes('& _tp=$!; wait "$_tp" || _r=$?; _tp=;'), '_run_to must background timeout and wait for $_tp');
    assert.ok(!cmd.includes('kill -- -$$'), 'must not kill parent shell group -$$');
  });

  it('failover scripts handle exit code 137 alongside 124 for timeout cascades (C7-4 / T-P6-4)', () => {
    const res = buildCommand({
      prompt: 'test exit 137',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;
    assert.ok(cmd.includes('[ "$_code" -eq 124 ] || [ "$_code" -eq 137 ]'), 'Must check exit code 137 alongside 124');

    const resCascade = buildCommand({
      prompt: 'test cascade 137',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'p2',
      tertiaryProject: 'p3',
    }, { ENMAAS_KEY: 'test-key' });
    const parsedCascade = JSON.parse(resCascade.content[0].text);
    assert.ok(parsedCascade.command.includes('[ "$_code" -eq 124 ] || [ "$_code" -eq 137 ]'), 'Cascade script must check exit code 137 alongside 124');
  });

  it('Tier 1 exit code 137 (SIGKILL timeout) triggers secondary failover (C7-4 / T-P6-4)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-t137-'));
    try {
      const mockBin = path.join(tmpDir, 'mock-claude.sh');
      const behaviorFile = path.join(tmpDir, 'behavior.txt');
      fs.writeFileSync(behaviorFile, 'FAIL_137\nSUCCESS_SECONDARY\n');

      const stub = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    FAIL_137)
      echo "Simulating timeout SIGKILL" >&2
      exit 137
      ;;
    SUCCESS_*)
      echo "AUDIT_SUCCESS: $ACTION proj=$ANTHROPIC_VERTEX_PROJECT_ID"
      exit 0
      ;;
    *)
      exit 1
      ;;
  esac
fi
exit 0
`;
      fs.writeFileSync(mockBin, stub, { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test exit 137 runtime',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      const out = execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();

      assert.ok(out.includes('AUDIT_SUCCESS: SUCCESS_SECONDARY'), 'Must route to secondary on exit code 137');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('failover script uses umask 077 for temp files and restores ambient umask before tier execution (C7-12 / T-P6-6)', () => {
    const res = buildCommand({
      prompt: 'test umask restore',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;
    assert.ok(cmd.includes('_ou=$(umask)'), 'Must save ambient umask');
    assert.ok(cmd.includes('umask "$_ou"'), 'Must restore ambient umask');
  });

  it('restores ambient umask so child process executes with ambient umask (C7-12 / T-P6-6)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-umask-'));
    try {
      const mockBin = path.join(tmpDir, 'mock-umask.sh');
      const umaskCapture = path.join(tmpDir, 'captured_umask.txt');
      fs.writeFileSync(mockBin, `#!/bin/bash
umask > "${umaskCapture}"
echo "SUCCESS"
exit 0
`, { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test umask runtime',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);

      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      assert.ok(fs.existsSync(umaskCapture), 'Captured umask file must exist');
      const captured = fs.readFileSync(umaskCapture, 'utf8').trim();
      assert.notStrictEqual(captured, '0077', 'Child process umask must NOT remain restricted 0077');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('marker cleanup sweep uses -type f and -mmin +180, preserving directories (C7-6 / T-P6-8)', () => {
    const res = buildCommand({
      prompt: 'test find sweep',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;
    assert.ok(cmd.includes('-type f'), 'Find sweep must include -type f');
    assert.ok(cmd.includes('-mmin +180'), 'Find sweep threshold must be 180m');
    assert.ok(!cmd.includes('-mmin +60'), 'Old 60m threshold must be removed');
  });

  it('preserves directories and files younger than 180m inside marker dir (C7-6 / T-P6-8)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-sweep-'));
    try {
      const markerDir = path.join(tmpDir, `claude-cli-${process.getuid ? process.getuid() : 0}`);
      fs.mkdirSync(markerDir, { recursive: true });
      const oldDir = path.join(markerDir, 'err.olddir');
      fs.mkdirSync(oldDir);
      const fourHoursAgo = new Date(Date.now() - 240 * 60 * 1000);
      fs.utimesSync(oldDir, fourHoursAgo, fourHoursAgo);

      const midFile = path.join(markerDir, 'out.midfile');
      fs.writeFileSync(midFile, 'active-cascade-data');
      const twoHoursAgo = new Date(Date.now() - 120 * 60 * 1000);
      fs.utimesSync(midFile, twoHoursAgo, twoHoursAgo);

      const oldFile = path.join(markerDir, 'out.oldfile');
      fs.writeFileSync(oldFile, 'stale-data');
      fs.utimesSync(oldFile, fourHoursAgo, fourHoursAgo);

      const mockBin = path.join(tmpDir, 'mock-claude.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\necho "SUCCESS"\nexit 0\n', { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test sweep runtime',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);

      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      assert.ok(fs.existsSync(oldDir), 'Directories inside marker dir must NOT be deleted by sweep');
      assert.ok(fs.existsSync(midFile), 'Files between 60m and 180m old must NOT be deleted by sweep');
      assert.ok(!fs.existsSync(oldFile), 'Files older than 180m must be swept');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Darwin Pass 6 Remediation: Stderr Redaction Hardening (C7-7..C7-10 / T-P6-7, T-P6-9)', () => {
  it('redacts multi-line PEM blocks without swallowing subsequent lines (C7-7)', () => {
    assert.ok(!REDACT_SED.includes('/c\\\\'), 'REDACT_SED must not use non-portable c\\ sed command');
    assert.ok(REDACT_SED.includes('/-----BEGIN/!d'), 'REDACT_SED must use portable /-----BEGIN/!d sed pattern');

    const input = 'Header info\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----\nImportant trailing log line\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(out.includes('[REDACTED_PEM]'), 'PEM block must be redacted');
    assert.ok(out.includes('Important trailing log line'), 'Trailing lines after PEM must be preserved');
    assert.ok(!out.includes('MIIEowIBAAKCAQEA0'), 'Private key body must not appear');
  });

  it('redacts Authorization: token and custom scheme headers (C7-8)', () => {
    const input = 'Authorization: token secret-ghp-token-12345\nproxy-authorization: basic user:pass\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('secret-ghp-token-12345'), 'Token scheme value must be redacted');
    assert.ok(out.includes('[REDACTED]'), 'Must replace with [REDACTED]');
  });

  it('redacts quoted keys with space-bearing values (C7-9)', () => {
    const input = '{"api_key": "secret value with spaces"}\nsecret=\'another secret with spaces\'\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('secret value with spaces'), 'Secret with spaces must be redacted');
    assert.ok(!out.includes('another secret with spaces'), 'Quoted secret with spaces must be redacted');
    assert.ok(!out.includes('with spaces'), 'Space-bearing part of secret must not leak');
  });

  it('redacts GitLab tokens and diverse GitHub token formats (C7-9)', () => {
    const input = 'glpat-xxxxxxxxxxxxxxxxxxxx\ngho_1234567890abcdef\nghs_1234567890abcdef\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('glpat-xxxxxxxxxxxxxxxxxxxx'), 'GitLab PAT must be redacted');
    assert.ok(!out.includes('gho_1234567890abcdef'), 'GitHub OAuth token must be redacted');
    assert.ok(!out.includes('ghs_1234567890abcdef'), 'GitHub server token must be redacted');
  });

  it('redacts JSON cookies and header cookies without eating trailing fields (C7-10)', () => {
    const input = '{"cookie": "session_id=abcdef123456; domain=.example.com", "other": "ok"}\nCookie: auth=xyz789\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('session_id=abcdef123456'), 'JSON cookie value must be redacted');
    assert.ok(!out.includes('auth=xyz789'), 'Cookie header value must be redacted');
    assert.ok(out.includes('"other": "ok"'), 'Other JSON fields must not be swallowed');
  });

  it('single-line PEM redaction preserves subsequent stderr lines without runaway deletion (HIGH-2)', () => {
    const input = 'First line\n-----BEGIN RSA PRIVATE KEY----- single line body -----END RSA PRIVATE KEY-----\nSubsequent line preserved\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(out.includes('[REDACTED_PEM]'), 'Single-line PEM block must be redacted');
    assert.ok(out.includes('First line'), 'Preceding log line must be preserved');
    assert.ok(out.includes('Subsequent line preserved'), 'Subsequent stderr line must not be swallowed');
    assert.ok(!out.includes('single line body'), 'PEM body must not appear');
  });

  it('redacts quoted Authorization: Bearer headers (HIGH-3)', () => {
    const input = 'Authorization: Bearer "secret-token-double-quoted"\nAuthorization: Bearer \'secret-token-single-quoted\'\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('secret-token-double-quoted'), 'Double quoted bearer token must be redacted');
    assert.ok(!out.includes('secret-token-single-quoted'), 'Single quoted bearer token must be redacted');
    assert.ok(out.includes('Authorization: Bearer [REDACTED]'), 'Authorization header prefix must be preserved');
  });

  it('redacts github_pat_ fine-grained personal access tokens (MEDIUM-2)', () => {
    const input = 'github_pat_11AAAAAAA0123456789_abcdefghijklmnopqrstuvwxyz01234567890123456789\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz'), 'Fine-grained PAT body must be redacted');
    assert.ok(out.includes('github_pat_11AA[REDACTED]'), 'Fine-grained PAT must be redacted with prefix preserved');
  });

  it('XDG_RUNTIME_DIR expansion creates /claude-cli-$_uid subdirectory (MEDIUM-1)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-xdg-test-'));
    try {
      const mockBin = path.join(baseDir, 'mock.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\necho "OK"\nexit 0\n', { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test xdg subdirectory',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, XDG_RUNTIME_DIR: baseDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const uid = process.getuid ? process.getuid() : 0;
      const expectedSubdir = path.join(baseDir, `claude-cli-${uid}`);
      assert.ok(fs.existsSync(expectedSubdir), `Subdirectory ${expectedSubdir} must be created`);
      assert.ok(fs.statSync(expectedSubdir).isDirectory(), 'Created path must be a directory');
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});


