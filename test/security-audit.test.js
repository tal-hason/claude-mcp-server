// claude-mcp-server/test/darwin-audit.test.js
// @ai-rules: [Pattern]: Verification of Darwin Multi-Lens & Governance Findings (N-1, F-1r, F-11, N-10, F-17).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
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

  it('terminates process group and cleans temp files on wrapper SIGTERM (C8-1 / T-8)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-t8-'));
    try {
      const sentinelPid = path.join(tmpDir, 'child.pid');
      const mockBin = path.join(tmpDir, 'mock-sleep.sh');
      fs.writeFileSync(mockBin, `#!/bin/bash\necho $$ > "${sentinelPid}"\nexec sleep 30\n`, { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test sigterm process group',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);

      const runScript = path.join(tmpDir, 'run.sh');
      fs.writeFileSync(runScript, '#!/bin/bash\nset -m\n' + parsed.command + '\n', { mode: 0o755 });

      const child = spawn('/bin/bash', [runScript], {
        env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
        stdio: 'ignore',
      });

      const start = Date.now();
      while (!fs.existsSync(sentinelPid) && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(fs.existsSync(sentinelPid), 'Mock child PID sentinel must be created');
      const childPid = fs.readFileSync(sentinelPid, 'utf8').trim();
      assert.ok(childPid.length > 0, 'Child PID must be non-empty');
      assert.ok(fs.existsSync(`/proc/${childPid}`), 'Child process must be running before SIGTERM');

      child.kill('SIGTERM');

      const exitCode = await new Promise((resolve) => {
        child.on('exit', (code, signal) => resolve(code !== null ? code : (signal === 'SIGTERM' ? 143 : signal)));
      });

      assert.equal(exitCode, 143, `Expected exit code 143 on SIGTERM, got: ${exitCode}`);

      const killStart = Date.now();
      while (fs.existsSync(`/proc/${childPid}`) && Date.now() - killStart < 1000) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const childStillAlive = fs.existsSync(`/proc/${childPid}`);
      if (childStillAlive) {
        try { process.kill(parseInt(childPid, 10), 'SIGKILL'); } catch {}
      }
      assert.equal(childStillAlive, false, `Child process PID ${childPid} must not leak in /proc`);

      const uid = process.getuid ? process.getuid() : 0;
      const markerDir = path.join(tmpDir, `claude-cli-${uid}`);
      if (fs.existsSync(markerDir)) {
        const remaining = fs.readdirSync(markerDir).filter((f) => f.startsWith('p.') || f.startsWith('sp.') || f.startsWith('err.') || f.startsWith('out.'));
        assert.equal(remaining.length, 0, `Expected 0 temp files in ${markerDir}, found: ${remaining.join(', ')}`);
      }
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
    assert.ok(REDACT_SED.includes('/^[A-Za-z0-9+\\/=]{16,}/d'), 'REDACT_SED must use non-swallowing base64 deletion pattern');

    const input = 'Header info\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----\nImportant trailing log line\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(out.includes('[REDACTED_PEM]'), 'PEM block must be redacted');
    assert.ok(out.includes('Important trailing log line'), 'Trailing lines after PEM must be preserved');
    assert.ok(!out.includes('MIIEowIBAAKCAQEA0'), 'Private key body must not appear');
  });

  it('unterminated PEM block does not swallow subsequent stderr log lines to EOF (C8-5 / T-5)', () => {
    const input = 'Header info\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\nMore base64 key line\nCritical following error message: connection refused to 10.0.0.1\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(out.includes('[REDACTED_PEM]'), 'PEM marker must be redacted as [REDACTED_PEM]');
    assert.ok(out.includes('Critical following error message: connection refused to 10.0.0.1'), 'Subsequent error message must NOT be swallowed to EOF');
    assert.ok(!out.includes('MIIEowIBAAKCAQEA0'), 'Base64 key body must be removed');
    assert.ok(!out.includes('More base64 key line'), 'Base64 key body lines must be removed');
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

  it('redacts tokens with prefixes longer than 24 characters (C8-3 / T-2)', () => {
    const input = 'KUBERNETES_SERVICE_ACCOUNT_TOKEN=eyJhbGciOiJSUzI1NiIsImtpZCI6InByb2QtY2EtMSJ9.ey\n' +
      'OPENSHIFT_SERVICEACCOUNT_TOKEN=sha256~abcdef1234567890abcdef1234567890\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('eyJhbGciOiJSUzI1NiIsImtpZCI6InByb2QtY2EtMSJ9'), 'Kubernetes SA token must be redacted');
    assert.ok(!out.includes('sha256~abcdef1234567890abcdef1234567890'), 'OpenShift SA token must be redacted');
    assert.ok(out.includes('KUBERNETES_SERVICE_ACCOUNT_TOKEN=[REDACTED]'), 'K8s token prefix preserved with [REDACTED]');
    assert.ok(out.includes('OPENSHIFT_SERVICEACCOUNT_TOKEN=[REDACTED]'), 'OpenShift token prefix preserved with [REDACTED]');
  });

  it('redacts JSON quoted and escaped Authorization headers (C8-4 / T-3)', () => {
    const input = '{"Authorization": "Bearer secret-token-xyz"}\n{\\"Authorization\\": \\"Bearer secret-token-xyz\\"}\n{"Authorization": "secret-raw-token"}\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('secret-token-xyz'), 'Quoted Authorization bearer token must be redacted');
    assert.ok(!out.includes('secret-raw-token'), 'Quoted raw Authorization token must be redacted');
    assert.ok(out.includes('[REDACTED]'), 'Must replace with [REDACTED]');
  });

  it('redacts Digest authentication response hashes (C8-4 / T-4)', () => {
    const input = 'Digest username="user", response="abcdef1234567890", nonce="xyz"\n' +
      'Digest response=\'abcdef1234567890\'\n' +
      'response=abcdef1234567890\n';
    const out = execSync(`${REDACT_SED}`, { input, encoding: 'utf8' });
    assert.ok(!out.includes('abcdef1234567890'), 'Digest response hash must be redacted');
    assert.ok(out.includes('response=[REDACTED]'), 'Digest response key preserved with [REDACTED]');
  });
});

describe('Darwin Remediation - C8-2: Preserve Partial stdout on Terminal Failure & User Veto (T-7)', () => {
  it('emits partial stdout before exit code on terminal cascade failure (C8-2 / T-7)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-stdout-term-'));
    try {
      const mockBin = path.join(tmpDir, 'mock.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\necho "Partial response before crash"\necho "Fatal terminal error" >&2\nexit 1\n', { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test partial stdout terminal',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      let stdout = '';
      try {
        stdout = execSync('bash', {
          input: parsed.command,
          env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString();
      } catch (err) {
        stdout = err.stdout ? err.stdout.toString() : '';
      }

      assert.ok(
        stdout.includes('Partial response before crash'),
        `Expected partial stdout to be preserved on terminal failure, got stdout: "${stdout}"`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits partial stdout before exit on 401/403 user error veto (C8-2 / T-7)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-stdout-veto-'));
    try {
      const mockBin = path.join(tmpDir, 'mock.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\necho "Partial reasoning before auth failure"\necho "HTTP 401 Unauthorized" >&2\nexit 1\n', { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test partial stdout veto',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      let stdout = '';
      try {
        stdout = execSync('bash', {
          input: parsed.command,
          env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString();
      } catch (err) {
        stdout = err.stdout ? err.stdout.toString() : '';
      }

      assert.ok(
        stdout.includes('Partial reasoning before auth failure'),
        `Expected partial stdout to be preserved on user veto, got stdout: "${stdout}"`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Darwin Pass 8 Remediation: Mutation Killers (C8-7)', () => {
  it('enforces umask 077 in failover script prologue (C8-7)', () => {
    const res = buildCommand({
      prompt: 'test umask',
      mode: 'executor',
      provider: 'vertex',
      primaryProject: 'p1',
      secondaryProject: 'p2',
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes('umask 077'), 'Failover script must enforce umask 077');
  });

  it('rejects candidate dir if it is a symlink and falls back to safe mktemp directory (C8-7 / T-8 security)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-symlink-test-'));
    const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-foreign-target-'));
    try {
      const uid = process.getuid ? process.getuid() : 0;
      const candSymlink = path.join(baseDir, `claude-cli-${uid}`);
      fs.symlinkSync(foreignDir, candSymlink);

      const mockBin = path.join(baseDir, 'mock.sh');
      fs.writeFileSync(mockBin, '#!/bin/bash\necho "OK"\nexit 0\n', { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test symlink rejection',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      assert.ok(parsed.command.includes('[ ! -L "$_cand" ]'), 'Script must check that candidate dir is not a symlink');
      assert.ok(parsed.command.includes('[ -O "$_cand" ]'), 'Script must check that candidate dir is owned by current user');

      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, XDG_RUNTIME_DIR: baseDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const foreignFiles = fs.readdirSync(foreignDir);
      assert.equal(foreignFiles.length, 0, `Symlinked target dir must not be written to; found: ${foreignFiles.join(', ')}`);
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
      fs.rmSync(foreignDir, { recursive: true, force: true });
    }
  });

  it('vetoes failover on user error (401/403) even when stderr contains transient error keywords (C8-7)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-veto-precedence-'));
    try {
      const mockBin = path.join(tmpDir, 'mock.sh');
      const callCountFile = path.join(tmpDir, 'call_count');
      fs.writeFileSync(callCountFile, '0');
      fs.writeFileSync(mockBin, `#!/bin/bash
COUNT=$(cat "${callCountFile}")
COUNT=$((COUNT + 1))
echo "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo "HTTP 401 Unauthorized: token expired (service rate limit remaining: 100)" >&2
  exit 1
else
  echo "TIER_2_CALLED" >&2
  exit 0
fi
`, { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test veto precedence',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      let stderr = '';
      try {
        execSync('bash', {
          input: parsed.command,
          env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        stderr = err.stderr ? err.stderr.toString() : '';
      }

      const totalCalls = parseInt(fs.readFileSync(callCountFile, 'utf8').trim(), 10);
      assert.equal(totalCalls, 1, 'Tier 1 user error must veto failover immediately; Tier 2 must not be called');
      assert.ok(!stderr.includes('TIER_2_CALLED'), 'Tier 2 must not be executed when Tier 1 fails with user error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('redacts escaped JSON authorization, tokens, and digest responses in stderr (C8-4 / R5)', () => {
    const inputs = [
      '\\"Authorization\\": \\"Bearer secret_token_abc\\"',
      '\\"token\\": \\"secret_bearer_xyz\\"',
      'response=\\"secret_digest_val\\"',
      '\\"password\\": \\"super_secret_val\\"',
    ];
    for (const inp of inputs) {
      const out = execSync(REDACT_SED, { input: inp }).toString().trim();
      assert.ok(!out.includes('secret_'), `Secret must be redacted from: ${inp}, got: ${out}`);
      assert.ok(out.includes('[REDACTED]'), `Must contain [REDACTED], got: ${out}`);
    }
  });

  it('redacts partial stdout on terminal failure before flushing (C8-2 / C6)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-stdout-redact-'));
    try {
      const mockBin = path.join(tmpDir, 'mock.sh');
      fs.writeFileSync(mockBin, `#!/bin/bash
echo "Partial output with Authorization: Bearer secret_in_stdout"
echo "HTTP 401 Unauthorized" >&2
exit 1
`, { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test stdout redaction',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      let stdout = '';
      try {
        stdout = execSync('bash', {
          input: parsed.command,
          env: { ...process.env, XDG_RUNTIME_DIR: tmpDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        }).toString();
      } catch (err) {
        stdout = err.stdout ? err.stdout.toString() : '';
      }

      assert.ok(!stdout.includes('secret_in_stdout'), 'Secrets in partial stdout must be redacted');
      assert.ok(stdout.includes('Partial output with Authorization: Bearer [REDACTED]'), 'Partial output must be flushed and redacted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('resiliently falls back to cat in failover _redact under set -eo pipefail (R1 / R5)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darwin-redact-resilience-'));
    try {
      const mockBin = path.join(tmpDir, 'mock.sh');
      fs.writeFileSync(mockBin, `#!/bin/bash
echo "All good output"
exit 0
`, { mode: 0o755 });

      const res = buildCommand({
        prompt: 'test redact resilience',
        mode: 'executor',
        provider: 'vertex',
        primaryProject: 'p1',
        secondaryProject: 'p2',
      }, { CLAUDE_BIN: mockBin });

      const parsed = JSON.parse(res.content[0].text);
      const brokenSedDir = path.join(tmpDir, 'broken-bin');
      fs.mkdirSync(brokenSedDir);
      fs.writeFileSync(path.join(brokenSedDir, 'sed'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });

      const out = execSync('bash', {
        input: parsed.command,
        env: { ...process.env, PATH: `${brokenSedDir}:${process.env.PATH}`, XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();

      assert.ok(out.includes('All good output'), 'Script must succeed even if sed binary fails in _redact');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});


