#!/usr/bin/env bash
# claude-mcp-server/setup.sh
# @ai-rules:
# 1. [Constraint]: Idempotent — safe to run multiple times.
# 2. [Constraint]: No hardcoded paths — resolves SCRIPT_DIR from $0.
# 3. [Pattern]: Merges into ~/.cursor/mcp.json and ~/.gemini/config/mcp_config.json without clobbering existing servers.
# 4. [Gotcha]: jq is required for JSON merge; script fails fast if missing.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_CONFIG="${HOME}/.cursor/mcp.json"
GEMINI_MCP_CONFIG="${HOME}/.gemini/config/mcp_config.json"
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

generate_mcp_config() {
  local target_dir="$1"
  local server_js="$target_dir/server.js"
  cat <<EOF > "$target_dir/mcp_config.json"
{
  "mcpServers": {
    "claude-cli": {
      "command": "node",
      "args": ["$server_js"]
    }
  }
}
EOF
  green "Generated dynamic mcp_config.json in $target_dir"
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
    --arg desc "Claude CLI bridge — command builder for Cursor agents" \
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
    "$MCP_CONFIG" > "$tmp" && cat "$tmp" > "$MCP_CONFIG" && rm -f "$tmp"

  green "MCP server registered as '$SERVER_ENTRY' in $MCP_CONFIG"
}

register_antigravity_plugin() {
  local target_dir="$1"
  local plugin_dir="${HOME}/.gemini/config/plugins"
  local target_link="${plugin_dir}/claude-cli"

  mkdir -p "$plugin_dir"
  if [[ -d "$target_link" && ! -L "$target_link" ]]; then
    mv "$target_link" "${target_link}.bak.$(date +%s)"
  fi
  ln -sfn "$target_dir" "$target_link"
  green "Registered Antigravity plugin symlink: $target_link -> $target_dir"

  mkdir -p "$(dirname "$GEMINI_MCP_CONFIG")"
  if [[ ! -f "$GEMINI_MCP_CONFIG" ]]; then
    echo '{"mcpServers":{}}' > "$GEMINI_MCP_CONFIG"
  fi

  if ! jq -e ".mcpServers[\"$SERVER_ENTRY\"]" "$GEMINI_MCP_CONFIG" >/dev/null 2>&1; then
    local tmp
    tmp=$(mktemp)
    jq --arg sjs "$target_dir/server.js" \
      ".mcpServers[\"$SERVER_ENTRY\"] = { command: \"node\", args: [\$sjs] }" \
      "$GEMINI_MCP_CONFIG" > "$tmp" && cat "$tmp" > "$GEMINI_MCP_CONFIG" && rm -f "$tmp"
    green "Registered '$SERVER_ENTRY' in $GEMINI_MCP_CONFIG"
  fi
}

patch_mcp_env() {
  local target_file="$1"
  local key="$2"
  local val="$3"

  [[ -z "$val" ]] && return 0
  mkdir -p "$(dirname "$target_file")"
  if [[ ! -f "$target_file" ]]; then
    echo '{"mcpServers":{}}' > "$target_file"
  fi

  local tmp
  tmp=$(mktemp)
  jq --arg key "$key" --arg val "$val" '
    .mcpServers["claude-cli"] = (.mcpServers["claude-cli"] // {}) |
    .mcpServers["claude-cli"].env = (.mcpServers["claude-cli"].env // {}) |
    .mcpServers["claude-cli"].env[$key] = $val
  ' "$target_file" > "$tmp" && cat "$tmp" > "$target_file" && rm -f "$tmp"
  chmod 600 "$target_file"
}

configure_mcp() {
  local primary_project=""
  local secondary_project=""
  local tertiary_project=""
  local primary_credentials=""
  local secondary_credentials=""
  local tertiary_credentials=""
  local enmaas_key=""
  local gateway_url=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --configure)
        shift
        ;;
      --primary-project)
        if [[ $# -ge 2 ]]; then primary_project="$2"; shift 2; else shift; fi
        ;;
      --secondary-project|--failover-project)
        if [[ $# -ge 2 ]]; then secondary_project="$2"; shift 2; else shift; fi
        ;;
      --tertiary-project|--fallback-project)
        if [[ $# -ge 2 ]]; then tertiary_project="$2"; shift 2; else shift; fi
        ;;
      --primary-credentials)
        if [[ $# -ge 2 ]]; then primary_credentials="$2"; shift 2; else shift; fi
        ;;
      --secondary-credentials|--failover-credentials)
        if [[ $# -ge 2 ]]; then secondary_credentials="$2"; shift 2; else shift; fi
        ;;
      --tertiary-credentials|--fallback-credentials)
        if [[ $# -ge 2 ]]; then tertiary_credentials="$2"; shift 2; else shift; fi
        ;;
      --enmaas-key)
        if [[ $# -ge 2 ]]; then enmaas_key="$2"; shift 2; else shift; fi
        ;;
      --gateway-url)
        if [[ $# -ge 2 ]]; then gateway_url="$2"; shift 2; else shift; fi
        ;;
      *)
        shift
        ;;
    esac
  done

  if [[ -n "$tertiary_credentials" && -f "$tertiary_credentials" ]]; then
    tertiary_credentials="$(cd "$(dirname "$tertiary_credentials")" && pwd)/$(basename "$tertiary_credentials")"
  fi
  if [[ -n "$secondary_credentials" && -f "$secondary_credentials" ]]; then
    secondary_credentials="$(cd "$(dirname "$secondary_credentials")" && pwd)/$(basename "$secondary_credentials")"
  fi
  if [[ -n "$primary_credentials" && -f "$primary_credentials" ]]; then
    primary_credentials="$(cd "$(dirname "$primary_credentials")" && pwd)/$(basename "$primary_credentials")"
  fi
  if [[ -n "$gateway_url" ]]; then
    gateway_url="${gateway_url%/}"
  fi

  local cursor_config="${HOME}/.cursor/mcp.json"
  local gemini_config="${HOME}/.gemini/config/mcp_config.json"

  for config_file in "$cursor_config" "$gemini_config"; do
    if [[ -n "$primary_project" ]]; then
      patch_mcp_env "$config_file" "VERTEX_PRIMARY_PROJECT" "$primary_project"
      patch_mcp_env "$config_file" "ANTHROPIC_VERTEX_PROJECT_ID" "$primary_project"
    fi
    if [[ -n "$secondary_project" ]]; then
      patch_mcp_env "$config_file" "VERTEX_SECONDARY_PROJECT" "$secondary_project"
    fi
    if [[ -n "$tertiary_project" ]]; then
      patch_mcp_env "$config_file" "VERTEX_TERTIARY_PROJECT" "$tertiary_project"
    fi
    if [[ -n "$primary_credentials" ]]; then
      patch_mcp_env "$config_file" "VERTEX_PRIMARY_CREDENTIALS" "$primary_credentials"
    fi
    if [[ -n "$secondary_credentials" ]]; then
      patch_mcp_env "$config_file" "VERTEX_SECONDARY_CREDENTIALS" "$secondary_credentials"
    fi
    if [[ -n "$tertiary_credentials" ]]; then
      patch_mcp_env "$config_file" "VERTEX_TERTIARY_CREDENTIALS" "$tertiary_credentials"
    fi
    if [[ -n "$enmaas_key" ]]; then
      patch_mcp_env "$config_file" "ENMAAS_KEY" "$enmaas_key"
    fi
    if [[ -n "$gateway_url" ]]; then
      patch_mcp_env "$config_file" "ENMAAS_BASE_URL" "$gateway_url"
    fi
    if [[ -f "$config_file" ]]; then
      chmod 600 "$config_file"
    fi
  done

  green "Successfully updated claude-cli environment in $cursor_config and $gemini_config"
}

main() {
  for arg in "$@"; do
    if [[ "$arg" == "--configure" ]]; then
      configure_mcp "$@"
      return 0
    fi
  done

  echo
  blue "=== Claude CLI MCP Server — Setup ==="
  echo

  check_deps
  install_server_deps
  generate_mcp_config "$SCRIPT_DIR"
  register_mcp
  register_antigravity_plugin "$SCRIPT_DIR"

  echo
  green "=== Setup complete ==="
  echo
  echo "Next steps:"
  echo "  1. Restart Cursor (or reload MCP servers)"
  echo "  2. Use the claude_prompt tool from any Cursor chat or Antigravity agent"
  echo
  echo "Uninstall:"
  echo "  jq 'del(.mcpServers[\"claude-cli\"])' ~/.cursor/mcp.json > /tmp/mcp.json && mv /tmp/mcp.json ~/.cursor/mcp.json"
  echo
}

main "$@"
