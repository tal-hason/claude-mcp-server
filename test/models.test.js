// claude-mcp-server/test/models.test.js
// @ai-rules: [Pattern]: Unit tests for models.js model discovery logic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchEnmaasModels, listVertexProjectModels, getAvailableModels, VERTEX_MODELS } from '../models.js';

test('fetchEnmaasModels - missing API key', async () => {
  const res = await fetchEnmaasModels({ env: {} });
  assert.equal(res.provider, 'enmaas');
  assert.equal(res.status, 'unconfigured');
  assert.deepEqual(res.models, []);
});

test('fetchEnmaasModels - successful model discovery', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'rits/zai-org/glm-5-3', owned_by: 'curvebender' },
        { id: 'claude-3-5-sonnet', owned_by: 'anthropic' },
        { id: 'gpt-5.4', owned_by: 'openai' },
      ],
    }),
  });

  const res = await fetchEnmaasModels({
    apiKey: 'mock-key',
    baseUrl: 'https://api.example.com',
    fetchFn: mockFetch,
  });

  assert.equal(res.provider, 'enmaas');
  assert.equal(res.status, 'available');
  assert.ok(res.total >= 3);
  const glm = res.models.find((m) => m.id === 'rits/zai-org/glm-5-3');
  assert.ok(glm);
  assert.equal(glm.supportsEffort, false);
  assert.equal(glm.claudeCompatible, true);
  const gpt = res.models.find((m) => m.id === 'gpt-5.4');
  assert.ok(gpt);
  assert.equal(gpt.claudeCompatible, false);
  const sonnet55 = res.models.find((m) => m.id === 'claude-sonnet-5-5');
  assert.ok(sonnet55);
  assert.equal(sonnet55.claudeCompatible, true);
});

test('fetchEnmaasModels - HTTP error handling', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 503,
    statusText: 'Service Unavailable',
  });

  const res = await fetchEnmaasModels({
    apiKey: 'mock-key',
    baseUrl: 'https://api.example.com',
    fetchFn: mockFetch,
  });

  assert.equal(res.status, 'error');
  assert.match(res.error, /HTTP 503/);
  assert.deepEqual(res.models, []);
});

test('fetchEnmaasModels - network exception handling', async () => {
  const mockFetch = async () => {
    throw new Error('Connection refused');
  };

  const res = await fetchEnmaasModels({
    apiKey: 'mock-key',
    baseUrl: 'https://api.example.com',
    fetchFn: mockFetch,
  });

  assert.equal(res.status, 'unreachable');
  assert.match(res.error, /Connection refused/);
});

test('listVertexProjectModels - credentials resolution', () => {
  const resWithCreds = listVertexProjectModels('project-a', '/dev/null');
  assert.equal(resWithCreds.project, 'project-a');
  assert.equal(resWithCreds.status, 'available');
  assert.equal(resWithCreds.credentialsConfigured, true);
  assert.ok(resWithCreds.models.length >= 3);
  assert.ok(resWithCreds.models.some((m) => m.id === 'sonnet' && m.supportsEffort === true));

  const resMissingCreds = listVertexProjectModels('project-b', '/nonexistent/path.json');
  assert.equal(resMissingCreds.project, 'project-b');
  assert.equal(resMissingCreds.status, 'unverified-credentials');
  assert.equal(resMissingCreds.credentialsConfigured, false);
});

test('getAvailableModels - provider filtering', async () => {
  const mockEnv = {
    ENMAAS_KEY: 'test-key',
    ENMAAS_BASE_URL: 'https://api.example.com',
    VERTEX_PRIMARY_PROJECT: 'proj-primary',
    VERTEX_SECONDARY_PROJECT: 'proj-secondary',
  };

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: 'mock-model', owned_by: 'test' }] }),
  });

  // Only enmaas
  const enmaasOnly = await getAvailableModels({ provider: 'enmaas', fetchFn: mockFetch }, mockEnv);
  assert.ok(enmaasOnly.enmaas);
  assert.equal(enmaasOnly.vertex, undefined);

  // Only vertex
  const vertexOnly = await getAvailableModels({ provider: 'vertex' }, mockEnv);
  assert.equal(vertexOnly.enmaas, undefined);
  assert.equal(vertexOnly.vertex.projects.length, 2);
  assert.equal(vertexOnly.vertex.projects[0].project, 'proj-primary');
  assert.equal(vertexOnly.vertex.projects[1].project, 'proj-secondary');

  // All providers
  const all = await getAvailableModels({ provider: 'all', fetchFn: mockFetch }, mockEnv);
  assert.ok(all.enmaas);
  assert.ok(all.vertex);
  assert.equal(all.vertex.projects.length, 2);
});
