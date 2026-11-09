// claude-mcp-server/test/helpers/env.js
// Scrubber helper for tracked environment variables across tests.

export const TRACKED_ENV_VARS = [
  'ENMAAS_KEY',
  'ENMAAS_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUDSDK_CORE_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'VERTEX_PRIMARY_PROJECT',
  'VERTEX_PRIMARY_CREDENTIALS',
  'VERTEX_SECONDARY_PROJECT',
  'VERTEX_SECONDARY_CREDENTIALS',
  'VERTEX_TERTIARY_PROJECT',
  'VERTEX_TERTIARY_CREDENTIALS',
  'VERTEX_FALLBACK_PROJECT',
  'VERTEX_FALLBACK_CREDENTIALS',
  'VERTEX_CREDENTIALS',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'CLAUDE_BIN',
  'CLAUDE_TIMEOUT',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_ENVIRONMENT_KIND',
  'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
];

export function createEnvScrubber(initialOverrides = {}) {
  const saved = {};
  for (const k of TRACKED_ENV_VARS) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) {
      saved[k] = process.env[k];
    }
  }

  function scrub(overrides = {}) {
    for (const k of TRACKED_ENV_VARS) {
      delete process.env[k];
    }
    Object.assign(process.env, initialOverrides, overrides);
  }

  function restore() {
    for (const k of TRACKED_ENV_VARS) {
      delete process.env[k];
    }
    Object.assign(process.env, saved);
  }

  return { scrub, restore, saved };
}
