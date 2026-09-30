#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "=== Building A2UI Pane Monorepo ==="
cd "${REPO_ROOT}"
yarn install --immutable || yarn install || true
yarn build || { echo "YARN BUILD FAILED: $?"; exit 1; }
echo "=== Build Step Succeeded ==="

echo "=== Staging Plugin Bundles ==="
mkdir -p "${REPO_ROOT}/plugin/mcp/dist"
mkdir -p "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist"

# Copy MCP Server bundle and embed IIFE bundle
cp "${REPO_ROOT}/packages/mcp-server/dist/server.mjs" "${REPO_ROOT}/plugin/mcp/dist/server.mjs"
cp "${REPO_ROOT}/packages/embed/dist/embed.iife.js" "${REPO_ROOT}/plugin/mcp/dist/embed.iife.js"

# Copy Sidecar bundle
cp "${REPO_ROOT}/packages/sidecar/dist/main.mjs" "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/main.mjs"

# Copy Pane App SPA assets
rm -rf "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/pane"
mkdir -p "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/pane"
cp -R "${REPO_ROOT}/packages/pane-app/dist"/. "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/pane/"

# Generate mcp_config.json from template
NODE_BIN="${A2UI_PANE_NODE:-$(command -v node)}"
echo "Using Node executable: ${NODE_BIN}"

sed \
  -e "s|@NODE@|${NODE_BIN}|g" \
  -e "s|@PLUGIN_DIR@|\${PLUGIN_ROOT}|g" \
  "${REPO_ROOT}/plugin/mcp_config.template.json" > "${REPO_ROOT}/plugin/mcp_config.json"

# Update version / timestamp in sidecar.json to trigger reload
BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
tmp_json="$(mktemp)"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const buildTime = process.argv[2];
  const out = process.argv[3];
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  data.description = "Interactive A2UI surfaces sidecar (built " + buildTime + ")";
  fs.writeFileSync(out, JSON.stringify(data, null, 2) + "\n");
' "${REPO_ROOT}/plugin/sidecars/a2ui-pane/sidecar.json" "${BUILD_TIME}" "${tmp_json}"
mv "${tmp_json}" "${REPO_ROOT}/plugin/sidecars/a2ui-pane/sidecar.json"

# Symlink into host plugin directories
TARGET_PLUGIN_DIR="${HOME}/.gemini/config/plugins/a2ui-pane"
mkdir -p "$(dirname "${TARGET_PLUGIN_DIR}")"

if [ -L "${TARGET_PLUGIN_DIR}" ]; then
  rm "${TARGET_PLUGIN_DIR}"
elif [ -d "${TARGET_PLUGIN_DIR}" ]; then
  echo "Backing up existing non-symlink plugin directory..."
  mv "${TARGET_PLUGIN_DIR}" "${TARGET_PLUGIN_DIR}.bak.$(date +%s)"
fi

ln -s "${REPO_ROOT}/plugin" "${TARGET_PLUGIN_DIR}"
echo "✨ Successfully installed a2ui-pane plugin to ${TARGET_PLUGIN_DIR}"
