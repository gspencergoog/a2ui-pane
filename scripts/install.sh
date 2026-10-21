#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<EOF
Usage: scripts/install.sh [--agent-sdk-path <a2ui checkout>] [--no-agent-sdk] [--protocol-version v0.9] [--with-local-jev]

Builds the monorepo, stages the plugin bundles, and symlinks the plugin into
~/.gemini/config/plugins/a2ui-pane.

A2UI Express authoring needs the Python A2UI agent SDK. Until a release with the
current Express API is published, point this script at a local a2ui checkout
(a uv workspace containing python/a2ui_agent) with --agent-sdk-path or
A2UI_PANE_AGENT_SDK_PATH.

If you want to install without Express Python SDK support (raw JSON messages only),
pass --no-agent-sdk.

To install optional CPU cross-encoder dependencies for in-process Jev decision-model
UI synthesis, pass --with-local-jev.

Environment overrides: A2UI_PANE_NODE, A2UI_PANE_UV, A2UI_PANE_AGENT_SDK_PATH,
A2UI_PANE_PROTOCOL_VERSION.
EOF
}

AGENT_SDK_PATH="${A2UI_PANE_AGENT_SDK_PATH:-}"
NO_AGENT_SDK=0
WITH_LOCAL_JEV=0
PROTOCOL_VERSION="${A2UI_PANE_PROTOCOL_VERSION:-v1.0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-sdk-path) AGENT_SDK_PATH="$2"; shift 2 ;;
    --no-agent-sdk|--raw-only) NO_AGENT_SDK=1; shift ;;
    --with-local-jev) WITH_LOCAL_JEV=1; shift ;;
    --protocol-version) PROTOCOL_VERSION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "${AGENT_SDK_PATH}" ] && [ "${NO_AGENT_SDK}" -eq 0 ]; then
  cat <<'EOF' >&2
Error: Neither A2UI_PANE_AGENT_SDK_PATH nor --agent-sdk-path is set.
Please set A2UI_PANE_AGENT_SDK_PATH to your local a2ui checkout (containing python/a2ui_agent),
or pass --agent-sdk-path <path>.
To install without Express Python SDK support (raw JSON messages only), pass --no-agent-sdk.
EOF
  exit 1
fi

echo "=== Building A2UI Pane Monorepo ==="
cd "${REPO_ROOT}"
command yarn install --immutable || command yarn install || true
command yarn build || { echo "YARN BUILD FAILED: $?"; exit 1; }
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
if [ -n "${AGENT_SDK_PATH}" ] && [ "${NO_AGENT_SDK}" -eq 0 ]; then
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
  if [ "${WITH_LOCAL_JEV}" -eq 1 ]; then
    echo "Installing decision-local dependencies for in-process Jev CPU model..."
    "${UV_BIN}" sync --project "${AGENT_SDK_PATH}" --package a2ui-agent-sdk --extra decision-local
  fi
  PYTHON_BIN="$("${UV_BIN}" run --project "${AGENT_SDK_PATH}" --package a2ui-agent-sdk python -c 'import sys; print(sys.executable)')"
  echo "Using Python interpreter: ${PYTHON_BIN}"
else
  echo "Express authoring disabled (raw messages only)."
  AGENT_SDK_PATH=""
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
    --catalog "${REPO_ROOT}/plugin/mcp/dist/catalogs/v1_0/basic/catalog.json" \
    --catalog "${REPO_ROOT}/plugin/mcp/dist/catalogs/v1_0/charts/catalog.json" \
    --catalog "${REPO_ROOT}/plugin/mcp/dist/catalogs/v1_0/status/catalog.json" \
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

# Terminate stale MCP server processes and trigger LanguageServer reload
pkill -f "a2ui-pane/mcp/dist/server.mjs" 2>/dev/null || true
sleep 0.5
command python3 -c '
import glob, json, os, re, subprocess, urllib.request

instances = []

# 1. Environment variables (set inside agent subshells)
env_addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
env_token = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
if env_addr and env_token:
    instances.append((env_addr, env_token))

# 2. Linux /proc scan
for env_file in glob.glob("/proc/[0-9]*/environ"):
    try:
        raw = open(env_file, "rb").read().decode("utf-8", errors="ignore")
        env = dict(item.split("=", 1) for item in raw.split("\0") if "=" in item)
        addr = env.get("ANTIGRAVITY_LS_ADDRESS")
        token = env.get("ANTIGRAVITY_CSRF_TOKEN")
        if addr and token and (addr, token) not in instances:
            instances.append((addr, token))
    except Exception:
        pass

# 3. Process table inspection (macOS & Linux external terminals)
try:
    res = subprocess.run(["ps", "ax", "-o", "pid=,command="], capture_output=True, text=True, check=False)
    if res.returncode == 0:
        for line in res.stdout.splitlines():
            if "language_server" in line and "--csrf_token" in line:
                m_token = re.search(r"--csrf_token[= ]([a-f0-9-]+)", line)
                if not m_token:
                    continue
                token = m_token.group(1)

                port = None
                log_path = os.path.expanduser("~/Library/Logs/Antigravity/language_server.log")
                if os.path.isfile(log_path):
                    try:
                        with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                            for l in reversed(f.readlines()[-200:]):
                                m_port = re.search(r"listening on .* port at (\d+) for HTTP\b", l)
                                if m_port:
                                    port = m_port.group(1)
                                    break
                    except Exception:
                        pass

                if not port:
                    m_pid = re.match(r"\s*(\d+)", line)
                    if m_pid:
                        pid = m_pid.group(1)
                        try:
                            lsof_res = subprocess.run(
                                ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid],
                                capture_output=True, text=True, check=False
                            )
                            for p_match in re.finditer(r":(\d+)\s+\(LISTEN\)", lsof_res.stdout):
                                test_port = p_match.group(1)
                                try:
                                    req = urllib.request.Request(
                                        f"http://127.0.0.1:{test_port}/exa.language_server_pb.LanguageServerService/GetUnleashData",
                                        data=b"{}",
                                        headers={"Content-Type": "application/json", "x-codeium-csrf-token": token},
                                        method="POST",
                                    )
                                    with urllib.request.urlopen(req, timeout=1) as resp:
                                        if resp.status == 200:
                                            port = test_port
                                            break
                                except Exception:
                                    pass
                        except Exception:
                            pass

                if port:
                    addr = f"127.0.0.1:{port}"
                    if (addr, token) not in instances:
                        instances.append((addr, token))
except Exception:
    pass

# Ensure plugin is enabled in config.json as fallback for cold starts
cfg_path = os.path.expanduser("~/.gemini/config/config.json")
if os.path.isfile(cfg_path):
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        plugins = cfg.setdefault("plugins", {})
        if "a2ui-pane" not in plugins or not plugins["a2ui-pane"].get("enabled"):
            plugins["a2ui-pane"] = {"enabled": True}
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
    except Exception:
        pass

for addr, token in instances:
    # 1. Enable plugin live in Language Server
    try:
        state_req = urllib.request.Request(
            f"http://{addr}/exa.language_server_pb.LanguageServerService/JetboxWriteState",
            data=json.dumps({"userConfig": {"plugins": {"a2ui-pane": {"enabled": True}}}}).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-codeium-csrf-token": token},
            method="POST",
        )
        urllib.request.urlopen(state_req, timeout=3).read()
    except Exception:
        pass

    # 2. Refresh MCP servers
    try:
        refresh_req = urllib.request.Request(
            f"http://{addr}/exa.language_server_pb.LanguageServerService/RefreshMcpServers",
            data=b"{}",
            headers={"Content-Type": "application/json", "x-codeium-csrf-token": token},
            method="POST",
        )
        urllib.request.urlopen(refresh_req, timeout=3).read()
    except Exception:
        pass
' 2>/dev/null || true
