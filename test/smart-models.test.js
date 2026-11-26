// claude-mcp-server/test/smart-models.test.js
// @ai-rules: [Pattern]: ATDD acceptance tests for dynamic work-weighting & model discovery. [Constraint]: Pure logic, node:test only.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchEnmaasModels, VERTEX_MODELS } from '../models.js';
import { MODES, getModeDefaultModel } from '../modes.js';
import { buildCommand } from '../command-builder.js';
import { createEnvScrubber } from './helpers/env.js';

const scrubber = createEnvScrubber();
beforeEach(() => scrubber.scrub());
afterEach(() => scrubber.restore());


describe('ATDD Layer 1: Model Discovery & Capabilities (models.js)', () => {
  it('T-1: rits/zai-org/glm-5-3 is tagged with cost: "free" and unauthorized claude-*-5-5 models are not injected', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'rits/zai-org/glm-5-3', owned_by: 'zai-org' },
          { id: 'gpt-5.4', owned_by: 'openai' },
        ],
      }),
    });
    const res = await fetchEnmaasModels({ apiKey: 'test-key', fetchFn: mockFetch });
    const glm = res.models.find((m) => m.id === 'rits/zai-org/glm-5-3');
    assert.ok(glm, 'GLM model should be discovered');
    assert.equal(glm.cost, 'free', 'GLM 5.3 must be tagged with cost: free');
    assert.equal(res.models.find((m) => m.id === 'claude-sonnet-5-5'), undefined, 'claude-sonnet-5-5 must not be injected');
    assert.equal(res.models.find((m) => m.id === 'claude-opus-5-5'), undefined, 'claude-opus-5-5 must not be injected');
    assert.equal(res.models.find((m) => m.id === 'claude-sonnet-5'), undefined, 'claude-sonnet-5 must not be injected when absent from EnMaaS');
    assert.equal(res.models.find((m) => m.id === 'claude-opus-5'), undefined, 'claude-opus-5 must not be injected when absent from EnMaaS');
  });

  it('T-1b: VERTEX_MODELS contains canonical Vertex aliases, 5-5 models, and verified versioned IDs without claude-opus-5', () => {
    const ids = VERTEX_MODELS.map((m) => m.id);
    assert.deepEqual(ids, [
      'sonnet',
      'opus',
      'haiku',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-haiku-4-5@20251001',
    ]);
    assert.ok(!ids.includes('claude-opus-5'), 'VERTEX_MODELS must not list nonexistent claude-opus-5');
  });
});

describe('ATDD Layer 1: Work-to-Model Mode Defaults (modes.js)', () => {
  it('T-2: explorer mode defaults to rits/zai-org/glm-5-3 and falls back to sonnet on Vertex or without ENMAAS_KEY', () => {
    assert.equal(MODES.explorer.defaultModel, 'rits/zai-org/glm-5-3');
    assert.equal(getModeDefaultModel('explorer', { ENMAAS_KEY: 'k' }, 'vertex'), 'sonnet');
    assert.equal(getModeDefaultModel('explorer', {}), 'sonnet');
  });

  it('T-2: reviewer mode defaults to canonical opus', () => {
    assert.equal(MODES.reviewer.defaultModel, 'opus');
  });

  it('T-2: architect, planner, and executor modes default to canonical sonnet', () => {
    assert.equal(MODES.architect.defaultModel, 'sonnet');
    assert.equal(MODES.planner.defaultModel, 'sonnet');
    assert.equal(MODES.executor.defaultModel, 'sonnet');
  });
});

describe('ATDD Layer 1 & 2: Command Builder Work-Weighting & Caller Override (command-builder.js)', () => {
  it('explorer mode uses GLM 5.3 default when EnMaaS available and suppresses --effort', () => {
    const res = buildCommand({ prompt: 'search files', mode: 'explorer' }, { ENMAAS_KEY: 'test-key' });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes("--model 'rits/zai-org/glm-5-3'"), 'Must route explorer to GLM 5.3');
    assert.ok(!parsed.command.includes('--effort'), 'Effort must be suppressed for GLM 5.3');
  });

  it('T-2: explorer mode falls back to Vertex canonical sonnet without ENMAAS_KEY', () => {
    const res = buildCommand({ prompt: 'search files', mode: 'explorer' }, {});
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes("--model 'sonnet'"), 'Must fall back to canonical Vertex sonnet model');
  });

  it('T-2: reviewer mode defaults to opus with max effort', () => {
    const res = buildCommand({ prompt: 'review PR', mode: 'reviewer' });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.command.includes("--model 'opus'"), 'Must route reviewer to canonical opus');
    assert.ok(parsed.command.includes("--effort 'max'"), 'Must retain max effort');
  });

  it('T-2: architect, planner, and executor default to sonnet with high effort', () => {
    for (const mode of ['architect', 'planner', 'executor']) {
      const res = buildCommand({ prompt: 'task', mode });
      const parsed = JSON.parse(res.content[0].text);
      assert.ok(parsed.command.includes("--model 'sonnet'"), `${mode} must default to canonical sonnet`);
      assert.ok(parsed.command.includes("--effort 'high'"), `${mode} must retain high effort`);
    }
  });

  it('T-3: preserves claude-opus-5-5 and claude-sonnet-5-5 on Vertex while normalizing claude-opus-5 to opus', () => {
    const resOpus55 = buildCommand({ prompt: 'review', model: 'claude-opus-5-5', provider: 'vertex' });
    const cmdOpus55 = JSON.parse(resOpus55.content[0].text).command;
    assert.ok(cmdOpus55.includes("--model 'claude-opus-5-5'"), 'claude-opus-5-5 must be preserved on Vertex');

    const resSonnet55 = buildCommand({ prompt: 'plan', model: 'claude-sonnet-5-5', provider: 'vertex' });
    const cmdSonnet55 = JSON.parse(resSonnet55.content[0].text).command;
    assert.ok(cmdSonnet55.includes("--model 'claude-sonnet-5-5'"), 'claude-sonnet-5-5 must be preserved on Vertex');

    const resOpus5 = buildCommand({ prompt: 'review', model: 'claude-opus-5', provider: 'vertex' });
    const cmdOpus5 = JSON.parse(resOpus5.content[0].text).command;
    assert.ok(!cmdOpus5.includes('claude-opus-5'), 'claude-opus-5 must not appear on Vertex');
    assert.ok(cmdOpus5.includes("--model 'opus'"), 'claude-opus-5 must normalize to opus on Vertex');
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
