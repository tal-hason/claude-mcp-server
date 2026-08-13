#!/usr/bin/env bash
# claude-mcp-server/setup.sh
# @ai-rules:
# 1. [Constraint]: Idempotent — safe to run multiple times.
# 2. [Constraint]: No hardcoded paths — resolves SCRIPT_DIR from $0.
# 3. [Pattern]: Merges into ~/.cursor/mcp.json without clobbering existing servers.
# 4. [Pattern]: Builds + installs the VS Code extension VSIX into Cursor.
# 5. [Gotcha]: jq is required for JSON merge; script fails fast if missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_CONFIG="${HOME}/.cursor/mcp.json"
SERVER_ENTRY="claude-cli"

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }

check_deps() {
  local missing=()
  command -v node   >/dev/null 2>&1 || missing+=(node)
  command -v jq     >/dev/null 2>&1 || missing+=(jq)
  command -v claude >/dev/null 2>&1 || missing+=(claude)

  if [[ ${#missing[@]} -gt 0 ]]; then
    red "Missing required tools: ${missing[*]}"
    echo "Install them and re-run this script."
    exit 1
  fi

  local node_major
  node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
  if (( node_major < 20 )); then
    red "Node.js >= 20 required (found v${node_major})"
    exit 1
  fi
}

is_prebuilt() {
  [[ -f "$SCRIPT_DIR/extension/claude-cli-panel.vsix" ]] && [[ -d "$SCRIPT_DIR/node_modules" ]]
}

install_server_deps() {
  if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
    green "Server dependencies already present. Skipping npm install."
    return
  fi
  command -v npm >/dev/null 2>&1 || { red "npm required to install from source."; exit 1; }
  blue "Installing MCP server dependencies..."
  cd "$SCRIPT_DIR"
  npm install --no-fund --no-audit
  green "Server dependencies installed."
}

build_extension() {
  if [[ -f "$SCRIPT_DIR/extension/claude-cli-panel.vsix" ]]; then
    green "Pre-built VSIX found. Skipping extension build."
    return
  fi
  command -v npm >/dev/null 2>&1 || { red "npm required to build from source."; exit 1; }
  blue "Building VS Code extension..."
  cd "$SCRIPT_DIR/extension"

  npm install --no-fund --no-audit

  npx tsc -p tsconfig.json

  npx @vscode/vsce package --no-dependencies -o claude-cli-panel.vsix 2>/dev/null \
    || npx @vscode/vsce package -o claude-cli-panel.vsix

  green "Extension built: extension/claude-cli-panel.vsix"
}

install_extension() {
  blue "Installing extension into Cursor..."
  local vsix="$SCRIPT_DIR/extension/claude-cli-panel.vsix"

  if [[ ! -f "$vsix" ]]; then
    red "VSIX not found at $vsix — build may have failed."
    exit 1
  fi

  if command -v cursor >/dev/null 2>&1; then
    cursor --install-extension "$vsix" 2>/dev/null && green "Extension installed via 'cursor'." && return
  fi

  if command -v code >/dev/null 2>&1; then
    code --install-extension "$vsix" 2>/dev/null && green "Extension installed via 'code'." && return
  fi

  echo "Neither 'cursor' nor 'code' CLI found in PATH."
  echo "Manually install: cursor --install-extension $vsix"
}

register_mcp() {
  blue "Registering MCP server in $MCP_CONFIG..."

  mkdir -p "$(dirname "$MCP_CONFIG")"

  if [[ ! -f "$MCP_CONFIG" ]]; then
    echo '{"mcpServers":{}}' > "$MCP_CONFIG"
  fi

  local server_js="$SCRIPT_DIR/server.js"
  local new_entry
  new_entry=$(jq -n \
    --arg cmd "node" \
    --arg arg "$server_js" \
    --arg desc "Claude CLI bridge — use Claude as a sub-agent via MCP" \
    '{
      command: $cmd,
      args: [$arg],
      description: $desc
    }')

  if jq -e ".mcpServers[\"$SERVER_ENTRY\"]" "$MCP_CONFIG" >/dev/null 2>&1; then
    local existing_arg
    existing_arg=$(jq -r ".mcpServers[\"$SERVER_ENTRY\"].args[0] // empty" "$MCP_CONFIG")
    if [[ "$existing_arg" == "$server_js" ]]; then
      green "MCP server already registered (path matches). Skipping."
      return
    fi
    echo "Existing '$SERVER_ENTRY' points to: $existing_arg"
    echo "This install points to:            $server_js"
    read -rp "Overwrite? [y/N] " answer
    if [[ ! "$answer" =~ ^[Yy]$ ]]; then
      echo "Skipped MCP registration."
      return
    fi
  fi

  local tmp
  tmp=$(mktemp)
  jq --argjson entry "$new_entry" \
    ".mcpServers[\"$SERVER_ENTRY\"] = \$entry" \
    "$MCP_CONFIG" > "$tmp" && mv "$tmp" "$MCP_CONFIG"

  green "MCP server registered as '$SERVER_ENTRY' in $MCP_CONFIG"
}

main() {
  echo
  blue "=== Claude CLI MCP Server — Setup ==="
  echo

  check_deps
  install_server_deps
  build_extension
  install_extension
  register_mcp

  echo
  green "=== Setup complete ==="
  echo
  echo "Next steps:"
  echo "  1. Restart Cursor (or reload MCP servers)"
  echo "  2. Open Command Palette → 'Claude CLI: Show Panel'"
  echo "  3. Use the claude_prompt tool from any Cursor chat"
  echo
  echo "Uninstall:"
  echo "  jq 'del(.mcpServers[\"claude-cli\"])' ~/.cursor/mcp.json > /tmp/mcp.json && mv /tmp/mcp.json ~/.cursor/mcp.json"
  echo "  cursor --uninstall-extension thason.claude-cli-panel"
  echo
}

main "$@"
