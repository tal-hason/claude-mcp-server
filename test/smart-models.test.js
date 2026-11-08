// claude-mcp-server/test/smart-models.test.js
// @ai-rules: [Pattern]: ATDD acceptance tests for dynamic work-weighting & model discovery. [Constraint]: Pure logic, node:test only.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEnmaasModels, VERTEX_MODELS } from '../models.js';
import { MODES } from '../modes.js';
import { buildCommand } from '../command-builder.js';

describe('ATDD Layer 1: Model Discovery & Capabilities (models.js)', () => {
  it('rits/zai-org/glm-5-3 is tagged with cost: "free"', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'rits/zai-org/glm-5-3', owned_by: 'curvebender' }],
      }),
    });
    const res = await fetchEnmaasModels({ apiKey: 'test-key', fetchFn: mockFetch });
    const glm = res.models.find((m) => m.id === 'rits/zai-org/glm-5-3');
    assert.ok(glm, 'GLM model should be discovered');
    assert.equal(glm.cost, 'free', 'GLM 5.3 must be tagged with cost: free');
  });

  it('claude-sonnet-5-5 and claude-opus-5-5 are tagged as active frontier models', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    });
    const res = await fetchEnmaasModels({ apiKey: 'test-key', fetchFn: mockFetch });
    const sonnet55 = res.models.find((m) => m.id === 'claude-sonnet-5-5');
    const opus55 = res.models.find((m) => m.id === 'claude-opus-5-5');
    assert.ok(sonnet55, 'claude-sonnet-5-5 must be present');
    assert.ok(opus55, 'claude-opus-5-5 must be present');
    assert.equal(sonnet55.tier, 'frontier', 'sonnet-5-5 must be tagged with tier: frontier');
    assert.equal(opus55.tier, 'frontier', 'opus-5-5 must be tagged with tier: frontier');

    const vSonnet = VERTEX_MODELS.find((m) => m.id === 'claude-sonnet-5-5');
    const vOpus = VERTEX_MODELS.find((m) => m.id === 'claude-opus-5-5');
    assert.ok(vSonnet && !vSonnet.role.includes('pending GCP serving'), 'Vertex Sonnet 5.5 must not be pending serving');
    assert.ok(vOpus && !vOpus.role.includes('pending GCP serving'), 'Vertex Opus 5.5 must not be pending serving');
  });
});

describe('ATDD Layer 1: Work-to-Model Mode Defaults (modes.js)', () => {
  it('explorer mode defaults to rits/zai-org/glm-5-3', () => {
    assert.equal(MODES.explorer.defaultModel, 'rits/zai-org/glm-5-3');
  });

  it('reviewer mode defaults to claude-opus-5-5', () => {
    assert.equal(MODES.reviewer.defaultModel, 'claude-opus-5-5');
  });

  it('architect, planner, and executor modes default to claude-sonnet-5-5', () => {
    assert.equal(MODES.architect.defaultModel, 'claude-sonnet-5-5');
    assert.equal(MODES.planner.defaultModel, 'claude-sonnet-5-5');
    assert.equal(MODES.executor.defaultModel, 'claude-sonnet-5-5');
  });
});

describe('ATDD Layer 1 & 2: Command Builder Work-Weighting & Caller Override (command-builder.js)', () => {
  it('explorer mode uses GLM 5.3 default and suppresses --effort', () => {
    const res = buildCommand({ prompt: 'search files', mode: 'explorer' });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes("--model 'rits/zai-org/glm-5-3'"), 'Must route explorer to GLM 5.3');
    assert.ok(!parsed.command.includes('--effort'), 'Effort must be suppressed for GLM 5.3');
  });

  it('reviewer mode defaults to claude-opus-5-5 with max effort', () => {
    const res = buildCommand({ prompt: 'review PR', mode: 'reviewer' });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes("--model 'claude-opus-5-5'"), 'Must route reviewer to Opus 5.5');
    assert.ok(parsed.command.includes("--effort 'max'"), 'Must retain max effort');
  });

  it('architect, planner, and executor default to claude-sonnet-5-5 with high effort', () => {
    for (const mode of ['architect', 'planner', 'executor']) {
      const res = buildCommand({ prompt: 'task', mode });
      const parsed = JSON.parse(res.content[0].text);
      assert.ok(parsed.command.includes("--model 'claude-sonnet-5-5'"), `${mode} must default to Sonnet 5.5`);
      assert.ok(parsed.command.includes("--effort 'high'"), `${mode} must retain high effort`);
    }
  });

  it('caller explicit params.model override takes precedence over mode default', () => {
    const res = buildCommand({ prompt: 'search files', mode: 'explorer', model: 'claude-sonnet-5' });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes("--model 'claude-sonnet-5'"), 'Caller model override must prevail');
    assert.ok(parsed.command.includes("--effort 'low'"), 'Effort enabled when override model supports effort');
  });

  it('caller explicit override with non-effort model suppresses effort regardless of mode', () => {
    const res = buildCommand({ prompt: 'review PR', mode: 'reviewer', model: 'rits/zai-org/glm-5-3' });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes("--model 'rits/zai-org/glm-5-3'"), 'Caller model override must prevail');
    assert.ok(!parsed.command.includes('--effort'), 'Effort must be suppressed when override model does not support effort');
  });
});
