---
name: claude-dispatch
description: Dispatch subagent tasks to Claude Code CLI via claude-cli MCP server, supporting Red Hat EnMaaS AI Gateway and GCP Vertex AI with budget failover.
---

# Claude Dispatch Skill

Enables agents to dispatch tasks to Claude Code CLI via the `claude-cli` MCP server, supporting Red Hat EnMaaS AI Gateway routing, GCP Vertex AI, and automated budget failover.

## 1. Core Tools

### `claude_models` (Discovery)
Call this tool **first** to discover active models and verify provider capabilities before dispatching:
- Parameters:
  - `provider` (string, optional): `"all"` (default), `"enmaas"`, or `"vertex"`.
  - `project` (string, optional): Filter by specific GCP project ID for Vertex AI.
- Returns real-time models for EnMaaS (e.g. `rits/zai-org/glm-5-3`, `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`) and supported Claude aliases/versions per Vertex AI project (`sonnet`, `opus`, `haiku`, etc.), including reasoning effort eligibility (`supportsEffort`).

### `claude_prompt` (Command Builder)
The `claude_prompt` tool acts as a pure command builder. It returns a JSON string with `{ command, cwd, description, block_until_ms }` to execute in the shell.

### Tool Parameters

- `prompt` (string, required): Task prompt to execute.
- `mode` (string, optional): `architect`, `planner`, `reviewer`, `explorer`, `executor`.
- `model` (string, optional): Target model name (e.g. `claude-opus-5-5`, `claude-sonnet-5-5`, `rits/zai-org/glm-5-3`).
- `provider` (string, optional): `auto` (default), `enmaas`, or `vertex`.
- `effort` (string, optional): `low`, `medium`, `high`, `xhigh`, `max`.
- `primaryProject` (string, optional): Primary GCP project ID for Vertex AI.
- `secondaryProject` (string, optional): Secondary GCP project ID for Vertex AI budget failover.
- `primaryCredentials` (string, optional): Path to primary GCP service account credentials JSON.
- `secondaryCredentials` (string, optional): Path to secondary GCP service account credentials JSON.
- `systemPrompt` (string, optional): System prompt override.
- `sessionId` (string, optional): Resume a previous session by ID.
- `cwd` (string, optional): Target working directory.

## 2. Providers & Environment Configuration

### Red Hat EnMaaS AI Gateway
- Gateway URL: Configured via `ENMAAS_BASE_URL` (defaults to `https://api.enmaas.example.com`).
- Authentication: `ENMAAS_KEY` environment variable (required when routing to EnMaaS).
- **Process Environment & Security Boundary (CR-01 & CR-03)**:
  - `ENMAAS_KEY` must be exported in the user's shell environment or profile (e.g. `~/.bashrc`, `~/.zshrc`) so that the agent Shell tool inherits the credential during command execution.
  - **Security Warning**: Avoid passing raw tokens via CLI arguments (`--enmaas-key <secret>`) in multi-user or shared environments, as arguments are visible in process tables (`ps aux`, `/proc/$pid/cmdline`). Always prefer setting `export ENMAAS_KEY="<token>"` in the shell environment.
- Auto-routed models: `claude-opus-5-5`, `claude-sonnet-5-5`, `rits/*`, or when `provider: "enmaas"` is explicitly set.
- Effort support: Reasoning effort is supported for Claude models (`opus`, `sonnet`); suppressed as `unsupported` for third-party models (e.g. `rits/zai-org/glm-5-3`).
- Cross-Provider Failover: When routing to EnMaaS with `secondaryProject` (or `VERTEX_SECONDARY_PROJECT`) configured, gateway transient outages (429, 502, 503, 504, connection timeouts) trigger automatic subshell failover to GCP Vertex AI with Sonnet fallback and clean environment sanitization.

### Google Cloud Vertex AI
- Default provider for standard Claude models (`claude-sonnet-4-6`, `claude-opus-4-8`).
- Uses Google Cloud ADC (`gcloud auth application-default login`) or `GOOGLE_APPLICATION_CREDENTIALS`.
- Automatic failover: When `secondaryProject` (or `VERTEX_SECONDARY_PROJECT`) is configured, primary project quota exhaustion (`RESOURCE_EXHAUSTED`, `429`, billing limits) triggers automated failover retry on the secondary project.

## 3. Dispatch Protocol

1. **Discover & Verify Models**:
   Call MCP tool `claude_models` first to discover available models for EnMaaS (`provider: "enmaas"`) or Vertex AI projects (`provider: "vertex"`). Select a verified model and check whether reasoning effort is supported.
2. **Build Command**:
   Call MCP tool `claude_prompt` with the verified `model` and appropriate mode/effort.
3. **Parse Result**:
   Parse JSON text from `content[0].text` to extract `command`, `cwd`, and `block_until_ms`.
4. **Execute via Shell**:
   Run `command` in `cwd` using the agent's shell execution tool with `block_until_ms: 0`.

## 4. Autonomous Agent Self-Configuration & Self-Healing Protocol ("Fix with Agent")

Agents can autonomously configure, verify, and heal `claude-cli` MCP server settings using `./setup.sh --configure`.

### Proactive Setup Workflow
1. **Parse Directives**: Extract GCP project IDs, credential file paths, and EnMaaS tokens from user prompt or environment.
2. **Probe Environment**:
   - Check existing configs: `~/.cursor/mcp.json` and `~/.gemini/config/mcp_config.json`.
   - Verify GCP credentials: `gcloud auth print-access-token`.
   - Verify EnMaaS token: `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $ENMAAS_KEY" "${ENMAAS_BASE_URL:-https://api.enmaas.example.com}/v1/models"`.
3. **Apply Configuration**:
   Execute deterministic CLI setup:
   ```bash
   ./setup.sh --configure \
     --primary-project "<PROJECT_P1>" \
     --secondary-project "<PROJECT_P2>" \
     --primary-credentials "<PATH_TO_SA1>" \
     --secondary-credentials "<PATH_TO_SA2>" \
     --gateway-url "<ENMAAS_GATEWAY_URL>" \
     --enmaas-key "<ENMAAS_TOKEN>"
   ```
4. **Verify Handshake**:
   Test MCP JSON-RPC transport:
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node server.js
   ```

### Reactive Self-Healing Workflow
- **Error: `ENMAAS_KEY is not set in environment`**:
  Fail-fast guard triggered. Agent locates EnMaaS token (Vault / user prompt), exports `export ENMAAS_KEY="<key>"` in the shell session/profile, and updates MCP config:
  `./setup.sh --configure --enmaas-key <key>`
- **Error: `401 Unauthorized` on EnMaaS**:
  Token expired or invalid. Agent prompts user for refreshed EnMaaS token, exports in shell, and updates via `./setup.sh --configure --enmaas-key <key>`.
- **Error: `RESOURCE_EXHAUSTED` / `429` on Vertex (single project)**:
  Agent catches budget limit. Explains project exhaustion to user and offers to configure failover via:
  `./setup.sh --configure --secondary-project <secondary_project_id>`
