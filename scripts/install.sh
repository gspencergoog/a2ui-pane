#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<EOF
Usage: scripts/install.sh [--agent-sdk-path <a2ui checkout>] [--protocol-version v0.9]

Builds the monorepo, stages the plugin bundles, and symlinks the plugin into
~/.gemini/config/plugins/a2ui-pane.

A2UI Express authoring needs the Python A2UI agent SDK. Until a release with the
current Express API is published, point this script at a local a2ui checkout
(a uv workspace containing python/a2ui_agent) with --agent-sdk-path or
A2UI_PANE_AGENT_SDK_PATH. Without it the plugin still works, but only with raw
JSON \`messages\`.

Environment overrides: A2UI_PANE_NODE, A2UI_PANE_UV, A2UI_PANE_AGENT_SDK_PATH,
A2UI_PANE_PROTOCOL_VERSION.
EOF
}

AGENT_SDK_PATH="${A2UI_PANE_AGENT_SDK_PATH:-}"
PROTOCOL_VERSION="${A2UI_PANE_PROTOCOL_VERSION:-v0.9}"
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-sdk-path) AGENT_SDK_PATH="$2"; shift 2 ;;
    --protocol-version) PROTOCOL_VERSION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

echo "=== Building A2UI Pane Monorepo ==="
cd "${REPO_ROOT}"
yarn install --immutable || yarn install || true
yarn build || { echo "YARN BUILD FAILED: $?"; exit 1; }
echo "=== Build Step Succeeded ==="

echo "=== Staging Plugin Bundles ==="
mkdir -p "${REPO_ROOT}/plugin/mcp/dist"
mkdir -p "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist"

# Copy MCP Server bundle, embed IIFE bundle, Express worker, and catalogs
cp "${REPO_ROOT}/packages/mcp-server/dist/server.mjs" "${REPO_ROOT}/plugin/mcp/dist/server.mjs"
cp "${REPO_ROOT}/packages/embed/dist/embed.iife.js" "${REPO_ROOT}/plugin/mcp/dist/embed.iife.js"
cp "${REPO_ROOT}/packages/mcp-server/dist/express_worker.py" "${REPO_ROOT}/plugin/mcp/dist/express_worker.py"
rm -rf "${REPO_ROOT}/plugin/mcp/dist/catalogs"
cp -R "${REPO_ROOT}/packages/mcp-server/dist/catalogs" "${REPO_ROOT}/plugin/mcp/dist/catalogs"

# Copy Sidecar bundle
cp "${REPO_ROOT}/packages/sidecar/dist/main.mjs" "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/main.mjs"

# Copy Pane App SPA assets
rm -rf "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/pane"
mkdir -p "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/pane"
cp -R "${REPO_ROOT}/packages/pane-app/dist"/. "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/pane/"

# Resolve the Python interpreter for the Express worker (optional)
echo "=== Configuring A2UI Express Worker ==="
PYTHON_BIN=""
if [ -n "${AGENT_SDK_PATH}" ]; then
  AGENT_SDK_PATH="$(cd "${AGENT_SDK_PATH}" && pwd)"
  UV_BIN="${A2UI_PANE_UV:-}"
  if [ -z "${UV_BIN}" ]; then
    if [ -x "${HOME}/.local/bin/uv" ]; then
      UV_BIN="${HOME}/.local/bin/uv"
    elif command -v uv >/dev/null 2>&1; then
      UV_BIN="$(command -v uv)"
    fi
  fi
  if [ -z "${UV_BIN}" ]; then
    echo "uv not found. Install uv (https://docs.astral.sh/uv/) or set A2UI_PANE_UV, then re-run." >&2
    exit 1
  fi
  if [ ! -f "${AGENT_SDK_PATH}/python/a2ui_agent/pyproject.toml" ]; then
    echo "${AGENT_SDK_PATH} does not look like an a2ui checkout (missing python/a2ui_agent/pyproject.toml)." >&2
    exit 1
  fi
  PYTHON_BIN="$("${UV_BIN}" run --project "${AGENT_SDK_PATH}" --package a2ui-agent-sdk --no-sync python -c 'import sys; print(sys.executable)')"
  echo "Using Python interpreter: ${PYTHON_BIN}"
else
  echo "No agent SDK path given; Express authoring disabled (raw messages only)."
  echo "Re-run with --agent-sdk-path <a2ui checkout> to enable it."
fi

# Generate mcp_config.json from template
NODE_BIN="${A2UI_PANE_NODE:-$(command -v node)}"
echo "Using Node executable: ${NODE_BIN}"

sed \
  -e "s|@NODE@|${NODE_BIN}|g" \
  -e "s|@PLUGIN_DIR@|\${PLUGIN_ROOT}|g" \
  -e "s|@PYTHON@|${PYTHON_BIN}|g" \
  -e "s|@AGENT_SDK_PATH@|${AGENT_SDK_PATH}|g" \
  -e "s|@PROTOCOL_VERSION@|${PROTOCOL_VERSION}|g" \
  "${REPO_ROOT}/plugin/mcp_config.template.json" > "${REPO_ROOT}/plugin/mcp_config.json"

# Pre-warm: import the SDK once and compile a fixture so the first render is fast
if [ -n "${PYTHON_BIN}" ]; then
  "${PYTHON_BIN}" "${REPO_ROOT}/plugin/mcp/dist/express_worker.py" --selftest \
    --catalog "${REPO_ROOT}/plugin/mcp/dist/catalogs/v0_9_1/basic/catalog.json" \
    --version "${PROTOCOL_VERSION}" || {
    echo "Express worker selftest failed; check that ${AGENT_SDK_PATH} is synced (uv sync --all-packages)." >&2
    exit 1
  }
fi

# Update version / timestamp in sidecar.json to trigger reload
BUILD_TIME="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
tmp_json="$(mktemp)"
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const buildTime = process.argv[2];
  const out = process.argv[3];
  const raw = fs.readFileSync(p, "utf8");
  const updated = raw.replace(
    /"description":\s*"[^"]*"/,
    "\"description\": \"Interactive A2UI surfaces sidecar (built " + buildTime + ")\"",
  );
  fs.writeFileSync(out, updated);
' "${REPO_ROOT}/plugin/sidecars/a2ui-pane/sidecar.json" "${BUILD_TIME}" "${tmp_json}"
mv "${tmp_json}" "${REPO_ROOT}/plugin/sidecars/a2ui-pane/sidecar.json"

# Symlink into host plugin directories
TARGET_PLUGIN_DIR="${HOME}/.gemini/config/plugins/a2ui-pane"
mkdir -p "$(dirname "${TARGET_PLUGIN_DIR}")"

if [ -L "${TARGET_PLUGIN_DIR}" ] && [ "$(readlink "${TARGET_PLUGIN_DIR}")" = "${REPO_ROOT}/plugin" ]; then
  echo "✨ Updated a2ui-pane plugin in-place at ${TARGET_PLUGIN_DIR}"
else
  if [ -L "${TARGET_PLUGIN_DIR}" ]; then
    rm "${TARGET_PLUGIN_DIR}"
  elif [ -d "${TARGET_PLUGIN_DIR}" ]; then
    echo "Backing up existing non-symlink plugin directory..."
    mv "${TARGET_PLUGIN_DIR}" "${TARGET_PLUGIN_DIR}.bak.$(date +%s)"
  fi
  ln -s "${REPO_ROOT}/plugin" "${TARGET_PLUGIN_DIR}"
  echo "✨ Successfully installed a2ui-pane plugin to ${TARGET_PLUGIN_DIR}"
fi

# Terminate stale MCP server processes and trigger LanguageServer RefreshMcpServers
pkill -f "a2ui-pane/mcp/dist/server.mjs" 2>/dev/null || true
sleep 0.5
python3 -c '
import glob, urllib.request
for env_file in glob.glob("/proc/[0-9]*/environ"):
    try:
        raw = open(env_file, "rb").read().decode("utf-8", errors="ignore")
        env = dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)
        if "ANTIGRAVITY_LS_ADDRESS" in env and "ANTIGRAVITY_CSRF_TOKEN" in env:
            addr = env["ANTIGRAVITY_LS_ADDRESS"]
            req = urllib.request.Request(
                f"http://{addr}/exa.language_server_pb.LanguageServerService/RefreshMcpServers",
                data=b"{}",
                headers={"Content-Type": "application/json", "x-codeium-csrf-token": env["ANTIGRAVITY_CSRF_TOKEN"]},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=3).read()
            break
    except Exception:
        pass
' 2>/dev/null || true
