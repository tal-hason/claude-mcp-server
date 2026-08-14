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

Single tool: `claude_prompt` with three actions via the `action` parameter.

### Sync (default, quick tasks)

```
claude_prompt({ prompt: "Review this code", mode: "reviewer" })
```

### Async (long-running tasks)

```
// 1. Dispatch — returns immediately with a dispatchId
claude_prompt({ action: "dispatch", prompt: "Deep review of the entire repo", mode: "reviewer", model: "claude-opus-4-8" })
// → { dispatchId: "a1b2c3d4", status: "running" }

// 2. Continue your own work...

// 3. Poll for result when ready
claude_prompt({ action: "result", dispatchId: "a1b2c3d4" })
// → { status: "done", output: "...", sessionId: "...", elapsedMs: 847000 }
```

Use `action: "dispatch"` for reviewer/architect audits on large codebases that can run 15-30+ minutes. The CLI runs in background with a 1-hour ceiling — no tool-call timeout pressure.

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
| `action` | No | `"prompt"` (default, sync), `"dispatch"` (async fire-and-forget), `"result"` (poll) |
| `prompt` | Yes* | The prompt to send (*not needed for `action: "result"`) |
| `mode` | No | Dispatch mode (see table above) |
| `model` | No | Exact model name (e.g. `claude-sonnet-5`) |
| `effort` | No | `low` / `medium` / `high` / `xhigh` / `max` |
| `systemPrompt` | No | System prompt override |
| `sessionId` | No | Resume a previous session |
| `cwd` | No | Working directory for Claude CLI |
| `timeoutMs` | No | Max execution time in ms (sync only). Default `600000` (10 min). Dispatch uses a 1-hour ceiling |
| `dispatchId` | No | For `action: "result"`: the dispatchId from a prior dispatch call |

## How it works

1. Cursor calls the MCP tool via stdio
2. The server resolves mode defaults (effort, appended system prompt)
3. Spawns `claude --print --output-format stream-json` with the resolved args
4. Parses streaming output, sends MCP progress notifications
5. Returns the final text result + session ID

Claude CLI reads `~/.claude/CLAUDE.md` as global context regardless of `cwd`. Mode system prompts are **appended** (via `--append-system-prompt`), never replacing CLAUDE.md.

## Files

| File | Purpose |
|---|---|
| `server.js` | MCP entry point — serveStdio, tool registration |
| `modes.js` | Dispatch mode definitions (effort + system prompt per role) |
| `cli-executor.js` | Spawn Claude CLI, parse stream-json, callbacks |
| `stream-parser.js` | Parse individual stream-json lines |
