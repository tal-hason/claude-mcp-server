// claude-mcp-server/models.js
// @ai-rules: [Pattern]: Model discovery for EnMaaS AI Gateway and GCP Vertex AI projects. [Constraint]: Pure logic & standard Node APIs.

import fs from 'node:fs';
import { supportsEffort } from './providers.js';

export const VERTEX_MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet (canonical alias / Sonnet 5)', effort: true, role: 'architect, reviewer, general' },
  { id: 'opus', name: 'Claude Opus (canonical alias / Opus 5)', effort: true, role: 'deep complex reasoning' },
  { id: 'haiku', name: 'Claude Haiku (canonical alias / Haiku 4.5)', effort: false, role: 'fast explorer, triage' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', effort: true, role: 'architect, reviewer' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', effort: true, role: 'deep reasoning' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5 (Model Garden preview)', effort: true, role: 'pending GCP serving' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5 (Model Garden preview)', effort: true, role: 'pending GCP serving' },
];

export async function fetchEnmaasModels(options = {}) {
  const env = options.env || process.env;
  const baseUrl = options.baseUrl || env.ENMAAS_BASE_URL || 'https://api.enmaas.example.com';
  const apiKey = options.apiKey || env.ENMAAS_KEY;
  if (!apiKey) return { provider: 'enmaas', status: 'unconfigured', error: 'ENMAAS_KEY not set in environment', models: [] };
  try {
    const res = await (options.fetchFn || fetch)(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs || 4000),
    });
    if (!res.ok) return { provider: 'enmaas', status: 'error', error: `HTTP ${res.status}: ${res.statusText}`, models: [] };
    const data = await res.json();
    const staticGateways = [
      { id: 'claude-sonnet-5-5', owner: 'anthropic', supportsEffort: true, claudeCompatible: true, provider: 'enmaas' },
      { id: 'claude-opus-5-5', owner: 'anthropic', supportsEffort: true, claudeCompatible: true, provider: 'enmaas' },
      { id: 'claude-sonnet-5', owner: 'anthropic', supportsEffort: true, claudeCompatible: true, provider: 'enmaas' },
      { id: 'claude-opus-5', owner: 'anthropic', supportsEffort: true, claudeCompatible: true, provider: 'enmaas' },
    ];
    const fetched = (data.data || []).map((m) => {
      const isCompat = m.id.startsWith('rits/') || m.id.startsWith('claude-');
      return { id: m.id, owner: m.owned_by, supportsEffort: supportsEffort(m.id), claudeCompatible: isCompat, provider: 'enmaas' };
    });
    const seen = new Set(fetched.map((m) => m.id));
    const models = [...staticGateways.filter((g) => !seen.has(g.id)), ...fetched];
    return { provider: 'enmaas', status: 'available', baseUrl, total: models.length, models };
  } catch (err) {
    return { provider: 'enmaas', status: 'unreachable', error: err.message, models: [] };
  }
}

export function listVertexProjectModels(project, credentialsPath) {
  const credsExist = credentialsPath ? fs.existsSync(credentialsPath) : false;
  return {
    project,
    provider: 'vertex',
    status: credsExist ? 'available' : (project ? 'unverified-credentials' : 'unconfigured'),
    credentialsPath: credentialsPath || null,
    credentialsConfigured: credsExist,
    models: VERTEX_MODELS.map((m) => ({ ...m, provider: 'vertex', supportsEffort: m.effort })),
  };
}

export async function getAvailableModels(params = {}, env = process.env) {
  const provider = params.provider || 'all';
  const result = {};
  if (provider === 'all' || provider === 'enmaas') {
    result.enmaas = await fetchEnmaasModels({
      baseUrl: params.baseUrl || env.ENMAAS_BASE_URL,
      apiKey: params.apiKey || env.ENMAAS_KEY,
      timeoutMs: params.timeoutMs,
      fetchFn: params.fetchFn,
      env,
    });
  }
  if (provider === 'all' || provider === 'vertex') {
    const projects = [];
    const p1 = params.project || params.primaryProject || env.VERTEX_PRIMARY_PROJECT || env.ANTHROPIC_VERTEX_PROJECT_ID;
    const c1 = params.credentials || params.primaryCredentials || env.VERTEX_PRIMARY_CREDENTIALS || env.GOOGLE_APPLICATION_CREDENTIALS;
    if (p1) projects.push(listVertexProjectModels(p1, c1));
    const p2 = params.secondaryProject || env.VERTEX_SECONDARY_PROJECT;
    const c2 = params.secondaryCredentials || env.VERTEX_SECONDARY_CREDENTIALS;
    if (p2 && p2 !== p1) projects.push(listVertexProjectModels(p2, c2));
    if (projects.length === 0) projects.push(listVertexProjectModels(null, null));
    result.vertex = { provider: 'vertex', projects };
  }
  return result;
}
