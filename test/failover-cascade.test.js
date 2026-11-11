// claude-mcp-server/test/failover-cascade.test.js
// @ai-rules: [Pattern]: ATDD acceptance tests for 3-tier failover cascade with shared-quota bypass. [Constraint]: Pure logic, node:test + node:assert only.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveFailoverConfig } from '../failover.js';
import { buildCommand } from '../command-builder.js';
import { resolveGcpProjects } from '../providers.js';
import { createEnvScrubber } from './helpers/env.js';

const scrubber = createEnvScrubber();
beforeEach(() => scrubber.scrub());
afterEach(() => scrubber.restore());

describe('ATDD Layer 1: Failover Configuration Resolution (resolveFailoverConfig)', () => {
  it('resolves tertiaryProject and tertiaryCredentials from explicit params', () => {
    const config = resolveFailoverConfig('enmaas', {
      secondaryProject: 'proj-tier2-shared',
      secondaryCredentials: '/path/to/tier2.json',
      tertiaryProject: 'proj-tier3-isolated',
      tertiaryCredentials: '/path/to/tier3.json',
    });

    assert.equal(config.enabled, true);
    assert.equal(config.secondaryProject, 'proj-tier2-shared');
    assert.equal(config.secondaryCredentials, '/path/to/tier2.json');
    assert.equal(config.tertiaryProject, 'proj-tier3-isolated', 'Must resolve tertiaryProject from params');
    assert.equal(config.tertiaryCredentials, '/path/to/tier3.json', 'Must resolve tertiaryCredentials from params');
    assert.equal(config.hasTertiary, true, 'Must flag hasTertiary when tertiary project present');
  });

  it('resolves tertiaryProject and tertiaryCredentials from environment variables', () => {
    const env = {
      ENMAAS_KEY: 'test-key',
      VERTEX_SECONDARY_PROJECT: 'env-tier2-shared',
      VERTEX_SECONDARY_CREDENTIALS: '/env/tier2.json',
      VERTEX_TERTIARY_PROJECT: 'env-tier3-isolated',
      VERTEX_TERTIARY_CREDENTIALS: '/env/tier3.json',
    };

    const config = resolveFailoverConfig('enmaas', {}, env);
    assert.equal(config.enabled, true);
    assert.equal(config.secondaryProject, 'env-tier2-shared');
    assert.equal(config.tertiaryProject, 'env-tier3-isolated', 'Must resolve tertiaryProject from env');
    assert.equal(config.tertiaryCredentials, '/env/tier3.json', 'Must resolve tertiaryCredentials from env');
  });

  it('falls back to VERTEX_FALLBACK_PROJECT and VERTEX_FALLBACK_CREDENTIALS for tertiary tier', () => {
    const env = {
      ENMAAS_KEY: 'test-key',
      VERTEX_SECONDARY_PROJECT: 'env-tier2-shared',
      VERTEX_FALLBACK_PROJECT: 'env-tier3-fallback',
      VERTEX_FALLBACK_CREDENTIALS: '/env/fallback.json',
    };

    const config = resolveFailoverConfig('enmaas', {}, env);
    assert.equal(config.tertiaryProject, 'env-tier3-fallback', 'Must resolve tertiaryProject from fallback env');
    assert.equal(config.tertiaryCredentials, '/env/fallback.json', 'Must resolve tertiaryCredentials from fallback env');
  });
});

describe('ATDD Layer 1 & 2: 3-Tier Cascade Script Generation & Isolation (command-builder.js)', () => {
  const baseParams = {
    prompt: 'implement feature',
    mode: 'executor',
    provider: 'enmaas',
    secondaryProject: 'itpc-ca-3583f32e92',
    secondaryCredentials: '/creds/tier2.json',
    tertiaryProject: 'cnv-ai-insights',
    tertiaryCredentials: '/creds/tier3.json',
  };

  it('generates 3-tier cascade script with isolated tier runners and sticky markers', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('_run_tier1()'), 'Command must define _run_tier1');
    assert.ok(cmd.includes('_run_tier2()'), 'Command must define _run_tier2');
    assert.ok(cmd.includes('_run_tier3()'), 'Command must define _run_tier3');
    assert.ok(cmd.includes('_marker_t2='), 'Command must define Tier 2 sticky marker');
    assert.ok(cmd.includes('_marker_t3='), 'Command must define Tier 3 sticky marker');
  });

  it('enforces subshell project and credential isolation for Tier 2 and Tier 3', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="itpc-ca-3583f32e92"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='itpc-ca-3583f32e92'"),
      'Tier 2 subshell must export CLOUDSDK_CORE_PROJECT for Tier 2',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="itpc-ca-3583f32e92"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='itpc-ca-3583f32e92'"),
      'Tier 2 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 2',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier2.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier2.json'"),
      'Tier 2 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 2',
    );

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="cnv-ai-insights"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='cnv-ai-insights'"),
      'Tier 3 subshell must export CLOUDSDK_CORE_PROJECT for Tier 3',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="cnv-ai-insights"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='cnv-ai-insights'"),
      'Tier 3 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 3',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier3.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier3.json'"),
      'Tier 3 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 3',
    );
  });

  it('preserves backward compatibility when tertiary project is omitted (2-tier)', () => {
    const res = buildCommand({
      prompt: 'task',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'itpc-ca-3583f32e92',
    }, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('_run_primary()') || cmd.includes('_run_tier1()'), '2-tier mode must define primary runner');
    assert.ok(!cmd.includes('_run_tier3()'), '2-tier mode must not define Tier 3 runner');
  });
});

describe('ATDD Layer 1: Shared-Quota Bypass Control Flow Specification', () => {
  const baseParams = {
    prompt: 'task',
    mode: 'executor',
    provider: 'enmaas',
    secondaryProject: 'itpc-ca-shared',
    tertiaryProject: 'cnv-ai-insights',
  };

  it('contains shared quota error pattern routing directly to Tier 3', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    const quotaRegex = /RESOURCE_EXHAUSTED|Quota exceeded|429/i;
    assert.ok(quotaRegex.test(cmd), 'Command must match quota exhaustion pattern');
    assert.ok(cmd.includes('_run_tier3'), 'Quota bypass must invoke _run_tier3 directly');
  });

  it('contains gateway infra error pattern routing to Tier 2 with secondary quota fallback', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    const infraRegex = /502\|503\|504/;
    assert.ok(infraRegex.test(cmd), 'Command must match infra outage pattern');
    assert.ok(cmd.includes('_run_tier2'), 'Infra outage must invoke _run_tier2');
  });

  it('configures trap cleanup on EXIT, INT, TERM for ephemeral error log and prompt file', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('$_err_log') && cmd.includes('$_pfile'), 'Must trap to remove _err_log and _pfile');
    assert.ok(cmd.includes('trap') && cmd.includes('EXIT'), 'Must trap EXIT');
    assert.ok(cmd.includes('trap') && (cmd.includes('INT') || cmd.includes('TERM')), 'Must trap signals');
  });

  it('filters bearer tokens and api keys with sed -E on terminal failure', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('sed -E'), 'Must use sed -E for secret redaction');
    assert.ok(cmd.includes('[REDACTED]'), 'Must replace secrets with [REDACTED]');
  });

  it('passes bash -n syntax validation', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: parsed.command, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Generated 3-tier cascade script must pass bash -n');
  });
});

describe('ATDD Layer 3: Runtime Execution Simulation (Bash Closed-Loop Routing with Production Generator)', () => {
  let tmpDir;
  let mockClaudeBin;
  let behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-runtime-'));
    mockClaudeBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stubScript = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    QUOTA_429)
      echo "HTTP 429: Quota exceeded RESOURCE_EXHAUSTED" >&2
      exit 1
      ;;
    INFRA_503)
      echo "HTTP 503 Service Unavailable" >&2
      exit 1
      ;;
    USER_401)
      echo "HTTP 401 Unauthorized" >&2
      exit 1
      ;;
    FATAL_SECRET)
      echo "Fatal error: Bearer secret-token-12345 api_key=super-secret-key" >&2
      exit 1
      ;;
    SUCCESS_*)
      echo "TIER_SUCCESS: $ACTION proj=$ANTHROPIC_VERTEX_PROJECT_ID"
      exit 0
      ;;
    *)
      echo "UNKNOWN_MOCK_ACTION: $ACTION" >&2
      exit 1
      ;;
  esac
else
  echo "DEFAULT_SUCCESS proj=$ANTHROPIC_VERTEX_PROJECT_ID"
  exit 0
fi
`;
    fs.writeFileSync(mockClaudeBin, stubScript, { mode: 0o755 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  it('Tier 1 quota error bypasses Tier 2 and jumps directly to Tier 3 (F-2)', () => {
    fs.writeFileSync(behaviorFile, 'QUOTA_429\nSUCCESS_TIER3\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER3'), 'Tier 3 must succeed');
    assert.ok(out.includes('proj=proj-t3-isolated'), 'Tier 3 must run with tertiary project');
  });

  it('Tier 1 infra error routes to Tier 2, and Tier 2 failure cascades to Tier 3 (F-2, F-9)', () => {
    fs.writeFileSync(behaviorFile, 'INFRA_503\nINFRA_503\nSUCCESS_TIER3_AFTER_T2\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER3_AFTER_T2'), 'Tier 3 must succeed after Tier 2 failure');
    assert.ok(out.includes('proj=proj-t3-isolated'), 'Tier 3 must run with tertiary project');
  });

  it('Tier 1 infra error routes to Tier 2, and Tier 2 user error is vetoed without calling Tier 3 (F-4)', () => {
    fs.writeFileSync(behaviorFile, 'INFRA_503\nUSER_401\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      failed = true;
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(failed, 'Command must exit with non-zero on Tier 2 user error veto');
    assert.ok(stderr.includes('401 Unauthorized'), 'Stderr must contain user error');
    assert.ok(!stderr.includes('Routing to Tier 3'), 'Tier 3 must not be routed to');
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Tier 3 must never be executed after Tier 2 user error veto');
  });

  it('Tier 1 shared-quota routes to Tier 3, and Tier 3 user error is vetoed without falling back to Tier 2 (F-4)', () => {
    fs.writeFileSync(behaviorFile, 'QUOTA_429\nUSER_401\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      failed = true;
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(failed, 'Command must exit with non-zero on Tier 3 user error veto');
    assert.ok(stderr.includes('401 Unauthorized'), 'Stderr must contain user error');
    assert.ok(!stderr.includes('Falling back to Tier 2'), 'Tier 2 fallback must not be routed to');
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Tier 2 fallback must never be executed after Tier 3 user error veto');
  });

  it('Tier 1 user error is vetoed and does not failover (F-4, F-5)', () => {
    fs.writeFileSync(behaviorFile, 'USER_401\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      failed = true;
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(failed, 'Command must exit with non-zero on user error');
    assert.ok(stderr.includes('401 Unauthorized'), 'Stderr must contain user error');
    // Behavior file must still have SUCCESS_SHOULD_NOT_RUN because Tier 2/3 were not called
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Secondary tiers must not be executed');
  });

  it('terminal failure redacts bearer tokens and api keys from stderr (F-8)', () => {
    fs.writeFileSync(behaviorFile, 'FATAL_SECRET\nFATAL_SECRET\nFATAL_SECRET\n');
    const res = buildCommand({
      prompt: 'test prompt',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let stderr = '';
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      stderr = err.stderr ? err.stderr.toString() : '';
    }

    assert.ok(stderr.includes('Bearer [REDACTED]'), 'Bearer token must be redacted');
    assert.ok(stderr.includes('api_key=[REDACTED]'), 'API key must be redacted');
    assert.ok(!stderr.includes('secret-token-12345'), 'Raw secret token must not leak in stderr');
    assert.ok(!stderr.includes('super-secret-key'), 'Raw API key must not leak in stderr');
  });

  it('large prompt (45KB) in 3-tier cascade executes without E2BIG (F-1)', () => {
    const largePrompt = 'a'.repeat(45 * 1024);
    fs.writeFileSync(behaviorFile, 'SUCCESS_TIER1\n');
    const res = buildCommand({
      prompt: largePrompt,
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'proj-t2-shared',
      tertiaryProject: 'proj-t3-isolated',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    assert.ok(!res.isError, '45KB prompt must be accepted by command builder');

    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe']
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER1'), '45KB prompt in 3-tier cascade must execute successfully');
  });
});

describe('Code Review Remediation: Quoting, Redaction & Project Resolution Deduplication', () => {
  it('applies POSIX single-quote escaping to prevent subshell command injection', () => {
    const res = buildCommand({
      prompt: 'task',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: "proj'; rm -rf /; echo 'hack",
      secondaryCredentials: "/creds/tier'2.json",
      tertiaryProject: 'cnv-ai-insights',
    }, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes("export CLOUDSDK_CORE_PROJECT='proj'\\''"), 'Project ID with quotes must be POSIX single-quoted');
    assert.doesNotThrow(() => {
      execSync('bash -n', { input: cmd, stdio: ['pipe', 'pipe', 'pipe'] });
    }, 'Injected project string must not break bash syntax');
  });

  it('deduplicates project resolution across failover and models via providers.resolveGcpProjects', () => {
    const env = {
      VERTEX_PRIMARY_PROJECT: 'proj-p1',
      VERTEX_SECONDARY_PROJECT: 'proj-p2',
      VERTEX_TERTIARY_PROJECT: 'proj-p3',
    };
    const res = resolveGcpProjects({}, env);
    assert.equal(res.primaryProject, 'proj-p1');
    assert.equal(res.secondaryProject, 'proj-p2');
    assert.equal(res.tertiaryProject, 'proj-p3');
    assert.equal(res.hasTertiary, true);
  });
});
