// claude-mcp-server/test/failover-cascade.test.js
// @ai-rules: [Pattern]: ATDD acceptance tests for 3-tier failover cascade with shared-quota bypass. [Constraint]: Pure logic, node:test + node:assert only.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveFailoverConfig } from '../failover.js';
import { buildCommand, FORMATTER_PATH } from '../command-builder.js';
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
    secondaryProject: 'vertex-project-1',
    secondaryCredentials: '/creds/tier2.json',
    tertiaryProject: 'vertex-project-2',
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

  it('T-4: enforces subshell project/credential isolation and per-tier --settings overrides for Tier 2 and Tier 3', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="vertex-project-1"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='vertex-project-1'"),
      'Tier 2 subshell must export CLOUDSDK_CORE_PROJECT for Tier 2',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="vertex-project-1"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='vertex-project-1'"),
      'Tier 2 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 2',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier2.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier2.json'"),
      'Tier 2 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 2',
    );
    assert.ok(
      cmd.includes('--settings \'{"env":{"CLAUDE_CODE_USE_VERTEX":"1","ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-1","CLOUDSDK_CORE_PROJECT":"vertex-project-1","GOOGLE_APPLICATION_CREDENTIALS":"/creds/tier2.json"}}\''),
      'Tier 2 command must pass --settings JSON overriding project and credentials',
    );

    assert.ok(
      cmd.includes('export CLOUDSDK_CORE_PROJECT="vertex-project-2"') ||
      cmd.includes("export CLOUDSDK_CORE_PROJECT='vertex-project-2'"),
      'Tier 3 subshell must export CLOUDSDK_CORE_PROJECT for Tier 3',
    );
    assert.ok(
      cmd.includes('export ANTHROPIC_VERTEX_PROJECT_ID="vertex-project-2"') ||
      cmd.includes("export ANTHROPIC_VERTEX_PROJECT_ID='vertex-project-2'"),
      'Tier 3 subshell must export ANTHROPIC_VERTEX_PROJECT_ID for Tier 3',
    );
    assert.ok(
      cmd.includes('export GOOGLE_APPLICATION_CREDENTIALS="/creds/tier3.json"') ||
      cmd.includes("export GOOGLE_APPLICATION_CREDENTIALS='/creds/tier3.json'"),
      'Tier 3 subshell must export GOOGLE_APPLICATION_CREDENTIALS for Tier 3',
    );
    assert.ok(
      cmd.includes('--settings \'{"env":{"CLAUDE_CODE_USE_VERTEX":"1","ANTHROPIC_VERTEX_PROJECT_ID":"vertex-project-2","CLOUDSDK_CORE_PROJECT":"vertex-project-2","GOOGLE_APPLICATION_CREDENTIALS":"/creds/tier3.json"}}\''),
      'Tier 3 command must pass --settings JSON overriding project and credentials',
    );
  });

  it('passes resolvedModel into resolveFailoverConfig and normalizes legacy models across all tiers (Defect D / T-3)', () => {
    const res = buildCommand({
      prompt: 'review repo',
      model: 'claude-opus-5-5',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
      tertiaryProject: 'vertex-project-3',
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(!parsed.command.includes('claude-opus-5-5'), 'Legacy claude-opus-5-5 must not appear in any Vertex tier');
    assert.ok(parsed.command.includes("--model 'opus'"), 'All Vertex tiers must normalize claude-opus-5-5 to canonical opus');
  });

  it('preserves backward compatibility when tertiary project is omitted (2-tier)', () => {
    const res = buildCommand({
      prompt: 'task',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
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
    secondaryProject: 'vertex-project-1',
    tertiaryProject: 'vertex-project-2',
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

  it('T-5/T-6: inspects both stderr and stdout via _grep, resets _last_o at _run_to entry, and cascades on org-policy/model/auth errors', () => {
    const res = buildCommand(baseParams, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    const cmd = parsed.command;

    assert.ok(cmd.includes('_grep()'), 'Script must define _grep() helper for stdout+stderr error inspection');
    assert.ok(cmd.includes('allowedModels'), 'Script must include allowedModels org-policy pattern');
    assert.ok(cmd.includes('not[[:space:]]+authorized'), 'Script must include EnMaaS model authorization pattern');
    assert.ok(cmd.includes('ENMAAS_KEY.*not[[:space:]]+set'), 'Script must include unset ENMAAS_KEY pattern');
    assert.ok(
      /_run_to\(\)\s*\{\s*\[ -n "\$_last_o" \] && rm -f "\$_last_o"; _last_o=;/.test(cmd),
      '_run_to must reset _last_o before mktemp'
    );
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
    STDOUT_ORG_POLICY_400)
      echo 'API Error: 400 {"error":{"code":400,"message":"Precondition check failed. Organization Policy constraint constraints/vertexai.allowedModels violated","status":"FAILED_PRECONDITION"}}'
      exit 1
      ;;
    STDOUT_ENMAAS_403_UNAUTH)
      echo 'API Error: 403 {"error":{"message":"model is not authorized for this user","type":"permission_error","code":"403"}}'
      exit 1
      ;;
    STDOUT_MODEL_UNAVAIL)
      echo "The model claude-opus-4-8 is not available on your vertex deployment"
      exit 1
      ;;
    STDOUT_USER_400_INVALID)
      echo 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is required"}}'
      echo "HTTP 503 transient noise on stderr" >&2
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

  it('T-5: Tier 1 Vertex org-policy 400 error on stdout is captured via _grep, not vetoed, and cascades to Tier 2', () => {
    fs.writeFileSync(behaviorFile, 'STDOUT_ORG_POLICY_400\nSUCCESS_TIER2\n');
    const res = buildCommand({
      prompt: 'test org policy stdout failover',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER2'), 'Tier 2 must succeed after Tier 1 stdout org-policy 400');
    assert.ok(out.includes('proj=vertex-project-2'), 'Tier 2 must execute with vertex-project-2');
    assert.ok(!out.includes('allowedModels'), 'Tier 1 error stdout must not leak into successful Tier 2 stdout');
  });

  it('T-6: 3-tier cascade routes Tier 1 EnMaaS 403 model auth on stdout -> Tier 2 Vertex org-policy 400 on stdout -> Tier 3 success', () => {
    fs.writeFileSync(behaviorFile, 'STDOUT_ENMAAS_403_UNAUTH\nSTDOUT_ORG_POLICY_400\nSUCCESS_TIER3\n');
    const res = buildCommand({
      prompt: 'test 3-tier stdout cascade',
      mode: 'reviewer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER3'), 'Tier 3 must succeed after Tier 1 403 and Tier 2 400');
    assert.ok(out.includes('proj=vertex-project-2'), 'Tier 3 must execute with vertex-project-2');
    assert.ok(!out.includes('not authorized'), 'Tier 1 stdout error must not leak into final output');
    assert.ok(!out.includes('allowedModels'), 'Tier 2 stdout error must not leak into final output');

    const uid = process.getuid ? process.getuid() : 0;
    const markerDir = path.join(tmpDir, `claude-cli-${uid}`);
    const markers = fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : [];
    assert.ok(markers.some((f) => f.endsWith('_t3')), 'Sticky marker _t3 must be created upon Tier 3 success');
  });

  it('T-6b: unset ENMAAS_KEY in subshell cascades from Tier 1 to Tier 2 Vertex fallback', () => {
    fs.writeFileSync(behaviorFile, 'SUCCESS_TIER2_NO_KEY\n');
    const res = buildCommand({
      prompt: 'test missing enmaas key cascade',
      mode: 'explorer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const envWithoutKey = { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir };
    delete envWithoutKey.ENMAAS_KEY;

    const out = execSync('bash', {
      input: parsed.command,
      env: envWithoutKey,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER2_NO_KEY'), 'Missing ENMAAS_KEY on Tier 1 must cascade to Tier 2');
    assert.ok(out.includes('proj=vertex-project-1'), 'Tier 2 must run with vertex-project-1');
  });

  it('T-7: genuine 400 invalid_request_error on stdout is vetoed immediately without invoking Tier 2 or Tier 3', () => {
    fs.writeFileSync(behaviorFile, 'STDOUT_USER_400_INVALID\nSUCCESS_SHOULD_NOT_RUN\n');
    const res = buildCommand({
      prompt: 'test stdout user 400 veto',
      mode: 'executor',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    let failed = false;
    try {
      execSync('bash', {
        input: parsed.command,
        env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (_) {
      failed = true;
    }

    assert.ok(failed, 'Genuine 400 invalid_request_error on stdout must abort with non-zero exit code');
    const remaining = fs.readFileSync(behaviorFile, 'utf8');
    assert.ok(remaining.includes('SUCCESS_SHOULD_NOT_RUN'), 'Tier 2/3 must not be invoked on genuine 400 invalid_request_error');
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
      tertiaryProject: 'vertex-project-2',
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

describe('Code Review Remediation: Stream Error Formatting, Tail Grep, Model-Scoped Markers & Active Tier 3 Recovery', () => {
  let tmpDir;
  let mockClaudeBin;
  let behaviorFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-cr-'));
    mockClaudeBin = path.join(tmpDir, 'mock-claude.sh');
    behaviorFile = path.join(tmpDir, 'behavior.txt');

    const stubScript = `#!/bin/bash
if [ -n "$MOCK_BEHAVIOR_FILE" ] && [ -f "$MOCK_BEHAVIOR_FILE" ]; then
  ACTION=$(head -n 1 "$MOCK_BEHAVIOR_FILE")
  tail -n +2 "$MOCK_BEHAVIOR_FILE" > "$MOCK_BEHAVIOR_FILE.tmp" 2>/dev/null && mv "$MOCK_BEHAVIOR_FILE.tmp" "$MOCK_BEHAVIOR_FILE"
  case "$ACTION" in
    STREAM_JSON_RESULT_ERR_400)
      echo '{"type":"result","is_error":true,"result":"API Error: 400 constraints/vertexai.allowedModels violated"}'
      exit 1
      ;;
    STREAM_JSON_ERROR_EVENT_403)
      echo '{"type":"error","error":{"message":"model is not authorized for this user"}}'
      exit 1
      ;;
    PROSE_SPOOF_VETO_THEN_429)
      echo "Line 1: Discussion of HTTP 401 Unauthorized and invalid_request_error in Turn 1"
      echo "Line 2: Normal assistant prose explaining authentication patterns"
      echo "Line 3: Normal assistant prose"
      echo "Line 4: Normal assistant prose"
      echo "Line 5: Normal assistant prose"
      echo "Line 6: Normal assistant prose"
      echo "Line 7: Normal assistant prose"
      echo "Line 8: Normal assistant prose"
      echo "Line 9: Normal assistant prose"
      echo "Line 10: Normal assistant prose"
      echo "Line 11: Normal tail line 1"
      echo "Line 12: Normal tail line 2"
      echo "Line 13: Normal tail line 3"
      echo "Line 14: Normal tail line 4"
      echo "Line 15: Normal tail line 5"
      echo "API Error: 429 Too Many Requests"
      exit 1
      ;;
    FAIL_TIER3)
      echo "HTTP 503 Service Unavailable" >&2
      exit 1
      ;;
    CHECK_CREDS_UNSET_TIER2)
      echo "TIER_SUCCESS: CHECK_CREDS_UNSET_TIER2 proj=$ANTHROPIC_VERTEX_PROJECT_ID creds=\${GOOGLE_APPLICATION_CREDENTIALS:-UNSET}"
      exit 0
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

  it('CR-1 (C6-4): stream-format.js surfaces result (is_error: true) and error JSON events so Tier 1 cascades to Tier 2', () => {
    const streamInput = [
      '{"type":"result","is_error":true,"result":"API Error: 400 constraints/vertexai.allowedModels violated"}',
      '{"type":"error","error":{"message":"model is not authorized for this user"}}',
    ].join('\n') + '\n';

    const fmtOut = execSync(`node "${FORMATTER_PATH}"`, {
      input: streamInput,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(
      fmtOut.includes('API Error: 400 constraints/vertexai.allowedModels violated'),
      'stream-format.js must surface result event when is_error is true'
    );
    assert.ok(
      fmtOut.includes('model is not authorized for this user'),
      'stream-format.js must surface error event message'
    );

    fs.writeFileSync(behaviorFile, 'STREAM_JSON_RESULT_ERR_400\nSUCCESS_TIER2\n');
    const res = buildCommand({
      prompt: 'test stream-json result error cascade',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('TIER_SUCCESS: SUCCESS_TIER2'), 'Tier 1 stream-json result is_error:true must cascade to Tier 2');
    assert.ok(out.includes('proj=vertex-project-2'), 'Tier 2 must execute with vertex-project-2');
  });

  it('CR-2 (R5-2/C6-2/R2/C4): _grep inspects only tail -n 5 of $_last_o so earlier assistant prose does not false-positive _veto', () => {
    fs.writeFileSync(behaviorFile, 'PROSE_SPOOF_VETO_THEN_429\nSUCCESS_TIER2\n');
    const res = buildCommand({
      prompt: 'test tail grep anti-spoofing',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });

    const parsed = JSON.parse(res.content[0].text);
    assert.ok(
      parsed.command.includes('tail -n 5 "$_last_o"'),
      '_grep must inspect only tail -n 5 of $_last_o'
    );

    const out = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(
      out.includes('TIER_SUCCESS: SUCCESS_TIER2'),
      'Earlier assistant prose containing 401/invalid_request_error must not trigger _veto when tail has 429'
    );
  });

  it('CR-3a (C6-1): active _marker_t3 failure removes _marker_t3, falls back to _run_tier2, and touches _marker_t2', () => {
    const uid = process.getuid ? process.getuid() : 0;
    const markerDir = path.join(tmpDir, `claude-cli-${uid}`);

    // Call 1: populate _marker_t3 via Tier 1 429 shared-quota bypass -> Tier 3 success
    fs.writeFileSync(behaviorFile, 'PROSE_SPOOF_VETO_THEN_429\nSUCCESS_TIER3_INIT\n');
    const res = buildCommand({
      prompt: 'call 1',
      mode: 'reviewer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });
    const parsed = JSON.parse(res.content[0].text);

    // Ensure _marker_t3 is active before Call 2
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    const t3Match = parsed.command.match(/_marker_t3="\$_marker_dir\/([^"]+)"/);
    assert.ok(t3Match, 'Cascade script must define _marker_t3');
    const t3MarkerPath = path.join(markerDir, t3Match[1]);
    const t2MarkerPath = t3MarkerPath.replace(/_t3$/, '_t2');
    fs.writeFileSync(t3MarkerPath, '');

    // Call 2: _marker_t3 is active (-mmin -30), _run_tier3 fails with FAIL_TIER3 (503), must fall back to _run_tier2 (SUCCESS_TIER2)
    fs.writeFileSync(behaviorFile, 'FAIL_TIER3\nSUCCESS_TIER2\n');
    const out2 = execSync('bash', {
      input: parsed.command,
      env: { ...process.env, MOCK_BEHAVIOR_FILE: behaviorFile, ENMAAS_KEY: 'test-key', XDG_RUNTIME_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out2.includes('TIER_SUCCESS: SUCCESS_TIER2'), 'Active _marker_t3 failure must fall back to _run_tier2');
    assert.ok(out2.includes('proj=vertex-project-1'), 'Fallback Tier 2 must run with vertex-project-1');
    assert.ok(!fs.existsSync(t3MarkerPath), '_marker_t3 must be deleted when Tier 3 fails');
    assert.ok(fs.existsSync(t2MarkerPath), '_marker_t2 must be touched when fallback to Tier 2 succeeds');
  });

  it('CR-3b (C4): sticky markers are scoped by resolved model so opus cascade does not force sonnet or glm onto Tier 3', () => {
    const reviewerCmd = JSON.parse(buildCommand({
      prompt: 'reviewer task',
      mode: 'reviewer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;

    const architectCmd = JSON.parse(buildCommand({
      prompt: 'architect task',
      mode: 'architect',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;

    const explorerCmd = JSON.parse(buildCommand({
      prompt: 'explorer task',
      mode: 'explorer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-1',
      tertiaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key' }).content[0].text).command;

    const revMarker = reviewerCmd.match(/_marker_t3="\$_marker_dir\/([^"]+)"/)?.[1];
    const archMarker = architectCmd.match(/_marker_t3="\$_marker_dir\/([^"]+)"/)?.[1];
    const expMarker = explorerCmd.match(/_marker_t3="\$_marker_dir\/([^"]+)"/)?.[1];

    assert.ok(revMarker && archMarker && expMarker, 'All cascade commands must define _marker_t3');
    assert.notEqual(revMarker, archMarker, 'reviewer (opus) and architect (sonnet) must have distinct sticky markers');
    assert.notEqual(revMarker, expMarker, 'reviewer (opus) and explorer (glm-5-3) must have distinct sticky markers');
    assert.notEqual(archMarker, expMarker, 'architect (sonnet) and explorer (glm-5-3) must have distinct sticky markers');
  });

  it('CR-4 (R5-1): 2-tier failover explicitly unsets GOOGLE_APPLICATION_CREDENTIALS when secondaryCredentials is omitted', () => {
    const vertexRes = buildCommand({
      prompt: 'test vertex 2-tier cred unset',
      mode: 'reviewer',
      provider: 'vertex',
      primaryProject: 'vertex-project-1',
      primaryCredentials: '/creds/tier1-sa.json',
      secondaryProject: 'vertex-project-2',
    }, { CLAUDE_BIN: mockClaudeBin });
    const vertexCmd = JSON.parse(vertexRes.content[0].text).command;

    const crossRes = buildCommand({
      prompt: 'test cross-provider 2-tier cred unset',
      mode: 'explorer',
      provider: 'enmaas',
      secondaryProject: 'vertex-project-2',
    }, { ENMAAS_KEY: 'test-key', CLAUDE_BIN: mockClaudeBin });
    const crossCmd = JSON.parse(crossRes.content[0].text).command;

    assert.ok(
      vertexCmd.includes('unset GOOGLE_APPLICATION_CREDENTIALS'),
      'buildVertexFailoverScript (_run_claude) must unset GOOGLE_APPLICATION_CREDENTIALS when credentials argument is empty'
    );
    assert.ok(
      crossCmd.includes('unset GOOGLE_APPLICATION_CREDENTIALS') ||
      /unset [^\n]*GOOGLE_APPLICATION_CREDENTIALS/.test(crossCmd),
      'buildCrossProviderFailoverScript must unset GOOGLE_APPLICATION_CREDENTIALS when secondaryCredentials is omitted'
    );

    // Closed-loop runtime proof: ambient GOOGLE_APPLICATION_CREDENTIALS from parent/Tier 1 must not leak into Tier 2
    fs.writeFileSync(behaviorFile, 'FAIL_TIER3\nCHECK_CREDS_UNSET_TIER2\n');
    const out = execSync('bash', {
      input: crossCmd,
      env: {
        ...process.env,
        MOCK_BEHAVIOR_FILE: behaviorFile,
        ENMAAS_KEY: 'test-key',
        GOOGLE_APPLICATION_CREDENTIALS: '/leaked/ambient-tier1-sa.json',
        XDG_RUNTIME_DIR: tmpDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    assert.ok(out.includes('creds=UNSET'), 'Tier 2 subshell must have GOOGLE_APPLICATION_CREDENTIALS unset, not inherited from ambient env');
  });
});
