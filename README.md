# claude-mcp-server

MCP server that builds Claude CLI commands with mode defaults resolved. Returns a shell command string for the calling agent to execute via Cursor's Shell tool.

## Install

One command — no clone needed:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/tal-hason/claude-mcp-server/main/install.sh)
```

**Prerequisites:** Node.js >= 20, jq, curl, [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli)

### Install from source

```bash
git clone https://github.com/tal-hason/claude-mcp-server.git
cd claude-mcp-server
./setup.sh
```

### Custom install location

```bash
CLAUDE_MCP_DIR=~/my-tools/claude-mcp bash <(curl -fsSL https://raw.githubusercontent.com/tal-hason/claude-mcp-server/main/install.sh)
```

### Uninstall

```bash
rm -rf ~/.local/share/claude-mcp-server
jq 'del(.mcpServers["claude-cli"])' ~/.cursor/mcp.json > /tmp/mcp.json && mv /tmp/mcp.json ~/.cursor/mcp.json
```

## How it works

```
┌──────────────────────────────────────────────────────────────┐
│  1. Agent calls claude_models to inspect available models   │
│  2. Agent calls claude_prompt via MCP                        │
│     → MCP server resolves mode defaults, builds command      │
│     → Returns JSON { command, cwd }                          │
│  3. Agent executes command via Shell tool                    │
│  4. Formatted stream output renders in terminal              │
└──────────────────────────────────────────────────────────────┘
```

1. Agent queries `claude_models` to verify available models for EnMaaS or Vertex AI projects.
2. Agent calls `claude_prompt` with prompt + chosen mode/model/effort.
3. MCP server resolves mode defaults (effort, appended system prompt, gateway routing).
4. Returns `{ command, cwd }` — a heredoc-based shell command with ANSI stream formatting.
5. Agent executes via Shell tool (`block_until_ms: 0` for long tasks).

No child process management, no WebSocket bridge, no timeouts — the MCP server is a pure function.

## Usage

Two tools:
- **`claude_models`**: Discovers available models for EnMaaS and Vertex AI projects before dispatching.
- **`claude_prompt`**: Builds the execution command with resolved mode defaults, routing, and failover.

### Model discovery

```
CallMcpTool: user-claude-cli / claude_models
{ "provider": "all", "project": "my-vertex-project" }
```

Parameters:
- `provider`: `"all"` (default), `"enmaas"`, or `"vertex"`
- `project`: Optional GCP project ID to query specific Vertex AI quotas/models

Returns real-time models for EnMaaS (e.g. `rits/zai-org/glm-5-3`, `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`) and supported Claude aliases (`sonnet`, `opus`, `haiku`) per Vertex AI project.

### Quick exploration

```
CallMcpTool: user-claude-cli / claude_prompt
{ "prompt": "What dependencies does server.js import?", "mode": "explorer", "cwd": "/path/to/repo" }
```

Parse the response JSON, then execute the `command` field via the Shell tool.

### Long-running review (backgrounded)

```
CallMcpTool: user-claude-cli / claude_prompt
{ "prompt": "<full review prompt>", "mode": "reviewer", "model": "claude-opus-4-8" }
```

Execute the returned command with `block_until_ms: 0` to background it. Read the terminal file when done.

### Modes

| Mode | Default effort | Role |
|---|---|---|
| `architect` | high | Architecture analysis — boundaries, coupling, gaps |
| `planner` | high | Plan creation — incremental steps, acceptance criteria |
| `reviewer` | max | Code review — multi-lens, severity-graded |
| `explorer` | low | Quick research — concise, evidence-cited |
| `executor` | high | Implementation — hexagonal, small batches |

Without `mode`, the tool builds a raw command (caller controls everything).

### Failover & Resilience

Built-in multi-tier failover ensures uninterrupted execution across cloud and gateway outages:

- **Failover Triggers**:
  - Quota exhaustion: HTTP 429, `RESOURCE_EXHAUSTED`, Rate limit, credit balance, budget exceeded.
  - Gateway & Infra errors: HTTP 500, 502, 503, 504, 529, `ECONNRESET`, `ETIMEDOUT`, socket hang up, `UNAVAILABLE`.
  - Process timeouts: Exit code 124 (controlled via `CLAUDE_TIMEOUT`, default 1800s).
- **User Error Veto**: HTTP 400, 401, 403, and `invalid_request_error` immediately exit with the failure code without triggering failover, preventing wasteful quota consumption on unrecoverable caller errors.
- **Shared-Quota Bypass (Cross-Provider)**: When Tier 1 (EnMaaS) exhausts shared enterprise quota (429), the cascade bypasses Tier 2 (shared GCP project) and routes directly to Tier 3 (isolated dedicated quota). If Tier 3 fails, it gracefully falls back to Tier 2.
- **Project Deduplication**: Identical project IDs across primary, secondary, and tertiary tiers are automatically deduplicated and promoted to prevent redundant invocations against the same project quota.
- **Prompt Size Guard**: The combined byte length of `prompt` and `systemPrompt` (and any mode-appended prompt) is capped at 100KB to prevent argument buffer overflow and enforce clean streaming via temporary files (`E2BIG` prevention).
- **Automated Stderr Redaction**: All error logs and terminal failure outputs are filtered through stream-level `sed -E` redaction to strip Bearer tokens, Basic auth, API keys, JWTs, and PEM certificate blocks prior to emitting to stderr. Redaction applies strictly to stderr error logs; successful model output on stdout is buffered and delivered unmodified.

### Parameters

| Param | Required | Description |
|---|---|---|
| `prompt` | Yes | The prompt to send (combined prompt + systemPrompt <= 100KB) |
| `mode` | No | Dispatch mode (see table above) |
| `model` | No | Exact model name (e.g. `claude-opus-5-5`, `claude-sonnet-5-5`, `rits/zai-org/glm-5-3`) |
| `secondaryModel` | No | Fallback model name for cross-provider failover (defaults to Sonnet) |
| `tertiaryModel` | No | Tertiary model name for 3-tier cascade fallback (defaults to Sonnet) |
| `effort` | No | `low` / `medium` / `high` / `xhigh` / `max` |
| `provider` | No | Inference provider: `auto` (default), `enmaas`, or `vertex` |
| `primaryProject` | No | Primary GCP project ID for Vertex AI execution |
| `secondaryProject` | No | Secondary GCP project ID for Vertex failover (Tier 2) |
| `tertiaryProject` | No | Tertiary GCP project ID for 3-tier cascade failover (Tier 3) |
| `primaryCredentials` | No | Path to primary GCP service account credentials JSON |
| `secondaryCredentials` | No | Path to secondary GCP service account credentials JSON |
| `tertiaryCredentials` | No | Path to tertiary GCP service account credentials JSON |
| `systemPrompt` | No | System prompt override |
| `sessionId` | No | Resume a previous session |
| `cwd` | No | Working directory for Claude CLI |

## Files

| File | Purpose |
|---|---|
| `server.js` | MCP entry point — thin wiring, delegates to command-builder |
| `command-builder.js` | Pure logic — shellQuote, buildCommand, mode resolution |
| `failover.js` | Failover logic — Vertex quota retry, cross-provider, & 3-tier cascade failover |
| `failover-scripts.js` | Shell script generation — heredoc templates, sticky markers, signal traps, and redaction |
| `providers.js` | Provider routing & environment variables configuration |
| `modes.js` | Dispatch mode definitions (effort + system prompt per role) |
| `models.js` | Dynamic model discovery and capability probing (`claude_models`) |
| `setup.sh` | From-source setup: deps + MCP registration & `--configure` CLI |
| `install.sh` | Curl-pipeable installer: download release + register |

## Environment & Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `CLAUDE_TIMEOUT` | `1800` | Per-tier execution timeout in seconds |
| `CLAUDE_MCP_DIR` | `~/.local/share/claude-mcp-server` | Install location (install.sh only) |
| `ENMAAS_BASE_URL` | `https://api.enmaas.example.com` | Base URL for Red Hat EnMaaS AI Gateway |
| `ENMAAS_KEY` | (empty) | API key / token for EnMaaS authentication (recommended via shell env) |
| `VERTEX_PRIMARY_PROJECT` | (empty) | Default primary GCP project ID |
| `VERTEX_SECONDARY_PROJECT` | (empty) | Secondary GCP project ID for failover |
| `VERTEX_TERTIARY_PROJECT` | (empty) | Tertiary GCP project ID for 3-tier cascade failover (alias: `VERTEX_FALLBACK_PROJECT`) |
| `VERTEX_PRIMARY_CREDENTIALS` | (empty) | Primary GCP service account JSON credentials file |
| `VERTEX_SECONDARY_CREDENTIALS` | (empty) | Secondary GCP service account JSON credentials file |
| `VERTEX_TERTIARY_CREDENTIALS` | (empty) | Tertiary GCP service account JSON credentials file (alias: `VERTEX_FALLBACK_CREDENTIALS`) |

### Configuration CLI (`setup.sh --configure`)

Configure or update MCP credentials and failover settings. To protect sensitive credentials from process listing exposure (`ps aux`), export `ENMAAS_KEY` in your environment rather than passing it as a CLI flag:

```bash
export ENMAAS_KEY="<your-secret-key>"

./setup.sh --configure \
  --primary-project "<PRIMARY_PROJECT_ID>" \
  --secondary-project "<SECONDARY_PROJECT_ID>" \
  --tertiary-project "<TERTIARY_PROJECT_ID>" \
  --primary-credentials "/path/to/primary-sa.json" \
  --secondary-credentials "/path/to/secondary-sa.json" \
  --tertiary-credentials "/path/to/tertiary-sa.json" \
  --gateway-url "https://api.enmaas.example.com"
```
