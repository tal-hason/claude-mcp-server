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
│  Agent calls claude_prompt via MCP                           │
│  → MCP server resolves mode defaults, builds shell command   │
│  → Returns JSON { command, cwd }                             │
│  → Agent executes command via Cursor Shell tool              │
│  → Agent reads stream-json output from terminal file         │
└──────────────────────────────────────────────────────────────┘
```

1. Agent calls `claude_prompt` with prompt + optional mode/model/effort
2. MCP server resolves mode defaults (effort, appended system prompt)
3. Returns `{ command, cwd }` — a heredoc-based shell command
4. Agent executes via Shell tool (`block_until_ms: 0` for long tasks)
5. Agent reads the stream-json output from the terminal file

No child process management, no WebSocket bridge, no timeouts — the MCP server is a pure function.

## Usage

Single tool: `claude_prompt`.

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

### Parameters

| Param | Required | Description |
|---|---|---|
| `prompt` | Yes | The prompt to send |
| `mode` | No | Dispatch mode (see table above) |
| `model` | No | Exact model name (e.g. `claude-opus-4-8`, `rits/zai-org/glm-5-3`) |
| `secondaryModel` | No | Fallback model name for cross-provider failover (defaults to Sonnet) |
| `effort` | No | `low` / `medium` / `high` / `xhigh` / `max` |
| `provider` | No | Inference provider: `auto` (default), `enmaas`, or `vertex` |
| `primaryProject` | No | Primary GCP project ID for Vertex AI execution |
| `secondaryProject` | No | Secondary GCP project ID for Vertex failover |
| `primaryCredentials` | No | Path to primary GCP service account credentials JSON |
| `secondaryCredentials` | No | Path to secondary GCP service account credentials JSON |
| `systemPrompt` | No | System prompt override |
| `sessionId` | No | Resume a previous session |
| `cwd` | No | Working directory for Claude CLI |

## Files

| File | Purpose |
|---|---|
| `server.js` | MCP entry point — thin wiring, delegates to command-builder |
| `command-builder.js` | Pure logic — shellQuote, buildCommand, mode resolution |
| `failover.js` | Failover logic — Vertex quota retry & EnMaaS-to-Vertex subshell failover |
| `providers.js` | Provider routing & environment variables configuration |
| `modes.js` | Dispatch mode definitions (effort + system prompt per role) |
| `setup.sh` | From-source setup: deps + MCP registration & `--configure` CLI |
| `install.sh` | Curl-pipeable installer: download release + register |

## Environment & Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_BIN` | `claude` | Path to Claude CLI binary |
| `CLAUDE_MCP_DIR` | `~/.local/share/claude-mcp-server` | Install location (install.sh only) |
| `ENMAAS_BASE_URL` | `https://api.enmaas.example.com` | Base URL for Red Hat EnMaaS AI Gateway |
| `ENMAAS_KEY` | (empty) | API key / token for EnMaaS authentication |
| `VERTEX_PRIMARY_PROJECT` | (empty) | Default primary GCP project ID |
| `VERTEX_SECONDARY_PROJECT` | (empty) | Secondary GCP project ID for failover |
| `VERTEX_PRIMARY_CREDENTIALS` | (empty) | Primary GCP service account JSON credentials file |
| `VERTEX_SECONDARY_CREDENTIALS` | (empty) | Secondary GCP service account JSON credentials file |

### Configuration CLI (`setup.sh --configure`)

Configure or update MCP credentials and failover settings:

```bash
./setup.sh --configure \
  --primary-project "<PRIMARY_PROJECT_ID>" \
  --failover-project "<SECONDARY_PROJECT_ID>" \
  --primary-credentials "/path/to/primary-sa.json" \
  --failover-credentials "/path/to/secondary-sa.json" \
  --gateway-url "https://api.enmaas.example.com" \
  --enmaas-key "secret-key"
```
