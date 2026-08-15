# claude-mcp-server

MCP server wrapping Claude CLI — lets Cursor (or any MCP host) use Claude as a sub-agent.

## Install

One command — no clone needed:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/tal-hason/claude-mcp-server/main/install.sh)
```

This downloads the latest pre-built release, installs the Cursor extension, and registers the MCP server.

**Prerequisites:** Node.js >= 20, jq, curl, [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli)

### Install from source

```bash
git clone https://github.com/tal-hason/claude-mcp-server.git
cd claude-mcp-server
./setup.sh
```

Requires npm in addition to the prerequisites above.

### Custom install location

```bash
CLAUDE_MCP_DIR=~/my-tools/claude-mcp bash <(curl -fsSL https://raw.githubusercontent.com/tal-hason/claude-mcp-server/main/install.sh)
```

### Uninstall

```bash
rm -rf ~/.local/share/claude-mcp-server
jq 'del(.mcpServers["claude-cli"])' ~/.cursor/mcp.json > /tmp/mcp.json && mv /tmp/mcp.json ~/.cursor/mcp.json
cursor --uninstall-extension thason.claude-cli-panel
```

## Usage

Single tool: `claude_prompt`.

### Quick tasks (direct call)

```
claude_prompt({ prompt: "Review this code", mode: "reviewer" })
```

### Long-running tasks (background Task wrapper)

For reviewer/architect audits that can run 15-30+ minutes, wrap the call in a Cursor background Task. Cursor handles notification delivery automatically — no polling, no custom async machinery.

```
Task({
  subagent_type: "generalPurpose",
  run_in_background: true,
  prompt: "Call claude_prompt with mode reviewer, model claude-opus-4-8, prompt: <full review prompt>"
})
// → Parent agent continues working
// → Cursor notifies when the subagent completes with the full result
```

### Modes

| Mode | Default effort | Role |
|---|---|---|
| `architect` | high | Architecture analysis — boundaries, coupling, gaps |
| `planner` | high | Plan creation — incremental steps, acceptance criteria |
| `reviewer` | max | Code review — multi-lens, severity-graded |
| `explorer` | low | Quick research — concise, evidence-cited |
| `executor` | high | Implementation — hexagonal, small batches |

Without `mode`, the tool passes through raw (caller controls everything).

### Parameters

| Param | Required | Description |
|---|---|---|
| `prompt` | Yes | The prompt to send |
| `mode` | No | Dispatch mode (see table above) |
| `model` | No | Exact model name (e.g. `claude-opus-4-8`) |
| `effort` | No | `low` / `medium` / `high` / `xhigh` / `max` |
| `systemPrompt` | No | System prompt override |
| `sessionId` | No | Resume a previous session |
| `cwd` | No | Working directory for Claude CLI |
| `timeoutMs` | No | Max execution time in ms. Default `600000` (10 min). For long tasks, use a background Task wrapper instead of raising this |

## How it works

1. Cursor calls the MCP tool via stdio (SDK v1.x, `StdioServerTransport`)
2. The server resolves mode defaults (effort, appended system prompt)
3. Spawns `claude --print --output-format stream-json`, feeds prompt via stdin
4. Parses streaming output, broadcasts to the VS Code extension panel via WebSocket
5. Returns the final text result + session ID

Claude CLI reads `~/.claude/CLAUDE.md` as global context regardless of `cwd`. Mode system prompts are **appended** (via `--append-system-prompt`), never replacing CLAUDE.md.

## Files

| File | Purpose |
|---|---|
| `server.js` | MCP entry point — `StdioServerTransport`, tool registration |
| `modes.js` | Dispatch mode definitions (effort + system prompt per role) |
| `cli-executor.js` | Spawn Claude CLI, parse stream-json, timeout attribution |
| `stream-parser.js` | Parse individual stream-json lines |
| `ws-bridge.js` | WebSocket bridge — streams CLI output to the extension panel |
