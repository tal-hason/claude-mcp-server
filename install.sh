#!/usr/bin/env bash
# claude-mcp-server/install.sh
# @ai-rules:
# 1. [Constraint]: Curl-pipeable — no interactive prompts by default (FORCE=1 skips overwrite prompt).
# 2. [Constraint]: Self-contained — no git clone, no npm build. Downloads pre-built release tarball.
# 3. [Pattern]: Installs to INSTALL_DIR (default ~/.local/share/claude-mcp-server).
# 4. [Pattern]: Idempotent MCP registration via jq merge.

set -euo pipefail

REPO="tal-hason/claude-mcp-server"
INSTALL_DIR="${CLAUDE_MCP_DIR:-${HOME}/.local/share/claude-mcp-server}"
MCP_CONFIG="${HOME}/.cursor/mcp.json"
GEMINI_MCP_CONFIG="${HOME}/.gemini/config/mcp_config.json"
SERVER_ENTRY="claude-cli"

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }

die() { red "$@" >&2; exit 1; }

check_deps() {
  local missing=()
  command -v node   >/dev/null 2>&1 || missing+=(node)
  command -v jq     >/dev/null 2>&1 || missing+=(jq)
  command -v curl   >/dev/null 2>&1 || missing+=(curl)
  command -v claude >/dev/null 2>&1 || missing+=(claude)

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "Missing required tools: ${missing[*]}. Install them and re-run."
  fi

  local node_major
  node_major=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
  if (( node_major < 20 )); then
    die "Node.js >= 20 required (found v${node_major})"
  fi
}

get_latest_release() {
  local api_url="https://api.github.com/repos/${REPO}/releases/latest"
  local release_json
  release_json=$(curl -fsSL "$api_url") || die "Failed to fetch latest release from GitHub."

  TAG=$(echo "$release_json" | jq -r '.tag_name')
  VERSION="${TAG#v}"
  TARBALL_URL=$(echo "$release_json" | jq -r '.assets[] | select(.name | endswith(".tar.gz")) | .browser_download_url')

  if [[ -z "$TARBALL_URL" || "$TARBALL_URL" == "null" ]]; then
    die "No .tar.gz asset found in release ${TAG}."
  fi
}

download_and_extract() {
  local tmp_dir
  tmp_dir=$(mktemp -d)
  trap 'rm -rf "$tmp_dir"' EXIT

  blue "Downloading claude-mcp-server ${TAG}..."
  curl -fsSL -o "$tmp_dir/release.tar.gz" "$TARBALL_URL"

  blue "Extracting to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"

  tar xzf "$tmp_dir/release.tar.gz" -C "$tmp_dir"

  local extracted_dir
  extracted_dir=$(find "$tmp_dir" -mindepth 1 -maxdepth 1 -type d | head -1)
  if [[ -z "$extracted_dir" ]]; then
    die "Extraction failed — no directory found in tarball."
  fi

  if [[ -d "$INSTALL_DIR/node_modules" ]]; then
    rm -rf "$INSTALL_DIR/node_modules"
  fi

  cp -a "$extracted_dir"/. "$INSTALL_DIR/"
  chmod +x "$INSTALL_DIR/setup.sh" 2>/dev/null || true

  green "Installed to ${INSTALL_DIR}"
}

register_mcp() {
  blue "Registering MCP server..."

  mkdir -p "$(dirname "$MCP_CONFIG")"

  if [[ ! -f "$MCP_CONFIG" ]]; then
    echo '{"mcpServers":{}}' > "$MCP_CONFIG"
  fi

  local server_js="$INSTALL_DIR/server.js"
  local new_entry
  new_entry=$(jq -n \
    --arg cmd "node" \
    --arg arg "$server_js" \
    --arg desc "Claude CLI bridge — command builder for Cursor agents" \
    '{ command: $cmd, args: [$arg], description: $desc }')

  if jq -e ".mcpServers[\"$SERVER_ENTRY\"]" "$MCP_CONFIG" >/dev/null 2>&1; then
    local existing_arg
    existing_arg=$(jq -r ".mcpServers[\"$SERVER_ENTRY\"].args[0] // empty" "$MCP_CONFIG")
    if [[ "$existing_arg" == "$server_js" ]]; then
      green "MCP server already registered. Skipping."
      return
    fi
    echo "Existing '$SERVER_ENTRY' entry points to: $existing_arg"
    echo "This install points to:                   $server_js"
    if [[ "${FORCE:-}" == "1" ]]; then
      echo "FORCE=1 — overwriting."
    elif [ -t 0 ]; then
      read -rp "Overwrite? [y/N] " answer
      if [[ ! "$answer" =~ ^[Yy]$ ]]; then
        echo "Skipped MCP registration. You can update ~/.cursor/mcp.json manually."
        return
      fi
    else
      echo "Non-interactive session detected — updating MCP registration."
    fi
  fi

  local tmp
  tmp=$(mktemp)
  jq --argjson entry "$new_entry" \
    ".mcpServers[\"$SERVER_ENTRY\"] = \$entry" \
    "$MCP_CONFIG" > "$tmp" && mv "$tmp" "$MCP_CONFIG"

  green "MCP server registered as '$SERVER_ENTRY'."
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
      "$GEMINI_MCP_CONFIG" > "$tmp" && mv "$tmp" "$GEMINI_MCP_CONFIG"
    green "Registered '$SERVER_ENTRY' in $GEMINI_MCP_CONFIG"
  fi
}

main() {
  echo
  blue "=== Claude CLI MCP Server — Installer ==="
  echo

  check_deps
  get_latest_release
  download_and_extract
  generate_mcp_config "$INSTALL_DIR"
  register_mcp
  register_antigravity_plugin "$INSTALL_DIR"

  echo
  green "=== Installation complete (v${VERSION}) ==="
  echo
  echo "Next steps:"
  echo "  1. Restart Cursor (or reload MCP servers)"
  echo "  2. Use claude_prompt from any Cursor chat"
  echo
  echo "Installed to: ${INSTALL_DIR}"
  echo
  echo "Uninstall:"
  echo "  rm -rf ${INSTALL_DIR}"
  echo "  jq 'del(.mcpServers[\"claude-cli\"])' ~/.cursor/mcp.json > /tmp/mcp.json && mv /tmp/mcp.json ~/.cursor/mcp.json"
  echo
}

main "$@"
