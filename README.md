# claude-mcp-server

MCP server wrapping Claude CLI — lets Cursor (or any MCP host) use Claude as a sub-agent.

## Setup

```bash
npm install
```

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "claude-cli": {
      "command": "node",
      "args": ["/path/to/claude-mcp-server/server.js"],
      "description": "Claude CLI bridge — use Claude as a sub-agent via MCP"
    }
  }
}
```

## Usage

Single tool: `claude_prompt` with an optional `mode` parameter.

```
claude_prompt({ prompt: "Review this code", mode: "reviewer" })
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
| `model` | No | Exact model name (e.g. `claude-sonnet-5`) |
| `effort` | No | `low` / `medium` / `high` / `xhigh` / `max` |
| `systemPrompt` | No | System prompt override |
| `sessionId` | No | Resume a previous session |
| `cwd` | No | Working directory for Claude CLI |

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
