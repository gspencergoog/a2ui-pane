#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<EOF
Usage: scripts/install.sh [--dogfood <a2ui checkout>] [--agent-sdk-path <a2ui checkout>] [--no-agent-sdk] [--protocol-version v0.9]

Builds the monorepo, stages the plugin bundles, and symlinks the plugin into
~/.gemini/config/plugins/a2ui-pane.

A2UI Express authoring needs the Python A2UI agent SDK. By default the script
creates a plugin-owned virtual environment at plugin/mcp/.venv and installs the
published package pinned in plugin/mcp/requirements.txt, which is kept in step
with the published @a2ui/web_core version the renderer uses.

Dogfood mode: --dogfood <path> (or A2UI_PANE_DOGFOOD) builds and installs
everything from a local a2ui checkout: the Python compiler runs from the
checkout's uv workspace, and @a2ui/web_core, @a2ui/lit and @a2ui/markdown-it
are built there and linked into node_modules before the plugin is built, so the
compiler and the renderer come from the same commit. Re-run without --dogfood
to go back to the pinned packages.

Python-only override: --agent-sdk-path (or A2UI_PANE_AGENT_SDK_PATH) runs only
the worker from a local checkout while the renderer stays on the published
packages. The two can disagree on the wire format; prefer --dogfood.

If you want to install without Express Python SDK support (raw JSON messages only),
pass --no-agent-sdk.

Environment overrides: A2UI_PANE_NODE, A2UI_PANE_UV, A2UI_PANE_DOGFOOD,
A2UI_PANE_AGENT_SDK_PATH, A2UI_PANE_PROTOCOL_VERSION.
EOF
}

AGENT_SDK_PATH="${A2UI_PANE_AGENT_SDK_PATH:-}"
DOGFOOD_PATH="${A2UI_PANE_DOGFOOD:-}"
NO_AGENT_SDK=0
PROTOCOL_VERSION="${A2UI_PANE_PROTOCOL_VERSION:-1.0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dogfood) DOGFOOD_PATH="$2"; shift 2 ;;
    --agent-sdk-path) AGENT_SDK_PATH="$2"; shift 2 ;;
    --no-agent-sdk|--raw-only) NO_AGENT_SDK=1; shift ;;
    --protocol-version) PROTOCOL_VERSION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "${DOGFOOD_PATH}" ]; then
  DOGFOOD_PATH="$(cd "${DOGFOOD_PATH}" && pwd)"
  if [ ! -f "${DOGFOOD_PATH}/python/a2ui_agent/pyproject.toml" ] || [ ! -f "${DOGFOOD_PATH}/typescript/core/web_core/package.json" ]; then
    echo "${DOGFOOD_PATH} does not look like an a2ui checkout (expected python/a2ui_agent and typescript/core/web_core)." >&2
    exit 1
  fi
  AGENT_SDK_PATH="${DOGFOOD_PATH}"
fi

# npm packages that dogfood mode links from the a2ui checkout, as "name:path" pairs.
DOGFOOD_PACKAGES=(
  "@a2ui/web_core:typescript/core/web_core"
  "@a2ui/lit:typescript/renderers/lit"
  "@a2ui/markdown-it:typescript/renderers/markdown-it"
)

# Removes dogfood symlinks left in node_modules/@a2ui by a previous run so the
# next `yarn install` re-links the published packages. Yarn's node_modules
# linker trusts its install state, so the state file goes too.
restore_published_packages() {
  local removed=0 entry name
  for entry in "${DOGFOOD_PACKAGES[@]}"; do
    name="${entry%%:*}"
    if [ -L "${REPO_ROOT}/node_modules/${name}" ]; then
      rm "${REPO_ROOT}/node_modules/${name}"
      removed=1
    fi
  done
  if [ "${removed}" -eq 1 ]; then
    rm -f "${REPO_ROOT}/node_modules/.yarn-state.yml"
    echo "Removed dogfood package links; yarn will re-link the published @a2ui packages."
  fi
}

# Builds the renderer-side packages in the a2ui checkout and links them into
# node_modules in place of the published versions.
link_dogfood_packages() {
  local entry name rel
  echo "=== Building @a2ui packages from ${DOGFOOD_PATH} ==="
  (
    cd "${DOGFOOD_PATH}"
    command yarn install --immutable >/dev/null 2>&1 || command yarn install >/dev/null
    command yarn workspaces foreach -A -t \
      --include '@a2ui/web_core' --include '@a2ui/lit' --include '@a2ui/markdown-it' \
      run build
  )
  for entry in "${DOGFOOD_PACKAGES[@]}"; do
    name="${entry%%:*}"
    rel="${entry#*:}"
    if [ ! -d "${DOGFOOD_PATH}/${rel}/dist" ]; then
      echo "${DOGFOOD_PATH}/${rel} has no dist/ after building; cannot dogfood ${name}." >&2
      exit 1
    fi
    rm -rf "${REPO_ROOT}/node_modules/${name}"
    ln -s "${DOGFOOD_PATH}/${rel}" "${REPO_ROOT}/node_modules/${name}"
    echo "Linked ${name} -> ${DOGFOOD_PATH}/${rel}"
  done
}

# Locates uv (required for both the pinned venv and the checkout override).
find_uv() {
  local uv_bin="${A2UI_PANE_UV:-}"
  if [ -z "${uv_bin}" ]; then
    if [ -x "${HOME}/.local/bin/uv" ]; then
      uv_bin="${HOME}/.local/bin/uv"
    elif command -v uv >/dev/null 2>&1; then
      uv_bin="$(command -v uv)"
    fi
  fi
  if [ -z "${uv_bin}" ]; then
    echo "uv not found. Install uv (https://docs.astral.sh/uv/) or set A2UI_PANE_UV, then re-run." >&2
    exit 1
  fi
  printf '%s' "${uv_bin}"
}

echo "=== Building A2UI Pane Monorepo ==="
cd "${REPO_ROOT}"
restore_published_packages
command yarn install --immutable || command yarn install || true
if [ -n "${DOGFOOD_PATH}" ]; then
  link_dogfood_packages
fi
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
if [ "${NO_AGENT_SDK}" -eq 1 ]; then
  echo "Express authoring disabled (raw messages only)."
  AGENT_SDK_PATH=""
elif [ -n "${AGENT_SDK_PATH}" ]; then
  # Developer override: run the worker from a local a2ui checkout.
  AGENT_SDK_PATH="$(cd "${AGENT_SDK_PATH}" && pwd)"
  UV_BIN="$(find_uv)"
  if [ ! -f "${AGENT_SDK_PATH}/python/a2ui_agent/pyproject.toml" ]; then
    echo "${AGENT_SDK_PATH} does not look like an a2ui checkout (missing python/a2ui_agent/pyproject.toml)." >&2
    exit 1
  fi
  PYTHON_BIN="$("${UV_BIN}" run --project "${AGENT_SDK_PATH}" --package a2ui-agent-sdk python -c 'import sys; print(sys.executable)')"
  if [ -n "${DOGFOOD_PATH}" ]; then
    echo "Using Python interpreter from the a2ui checkout (dogfood): ${PYTHON_BIN}"
  else
    echo "Using Python interpreter from the a2ui checkout (Python-only override): ${PYTHON_BIN}"
    echo "Warning: the checkout's compiler may emit a newer wire format than the bundled renderer reads; prefer --dogfood." >&2
  fi
else
  # Default: a plugin-owned venv with the published SDK pinned in plugin/mcp/requirements.txt.
  UV_BIN="$(find_uv)"
  VENV_DIR="${REPO_ROOT}/plugin/mcp/.venv"
  REQUIREMENTS="${REPO_ROOT}/plugin/mcp/requirements.txt"
  if [ ! -x "${VENV_DIR}/bin/python3" ]; then
    "${UV_BIN}" venv -q "${VENV_DIR}"
  fi
  "${UV_BIN}" pip install -q --python "${VENV_DIR}/bin/python3" -r "${REQUIREMENTS}"
  PYTHON_BIN="${VENV_DIR}/bin/python3"
  AGENT_SDK_PATH=""
  echo "Using Python interpreter: ${PYTHON_BIN} ($(grep -v '^#' "${REQUIREMENTS}" | tr -d '[:space:]'))"
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
    if [ -n "${AGENT_SDK_PATH}" ]; then
      echo "Express worker selftest failed; check that ${AGENT_SDK_PATH} is synced (uv sync --all-packages)." >&2
    else
      echo "Express worker selftest failed; delete ${REPO_ROOT}/plugin/mcp/.venv and re-run to rebuild the pinned environment." >&2
    fi
    exit 1
  }
fi

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

# Restart the running sidecar so it loads the new build. The host runs it with
# restart_policy "always" and respawns it within a few seconds. Match on the
# process's working directory (the host starts it as `node dist/main.mjs` from
# the sidecar directory), so sidecars of other plugins are left alone. This
# replaces stamping a build time into sidecar.json, which dirtied the repo.
SIDECAR_DIR="$(cd "${REPO_ROOT}/plugin/sidecars/a2ui-pane" && pwd -P)"
restarted_sidecar=false
for pid in $(pgrep -f "dist/main.mjs" 2>/dev/null || true); do
  if [ "$(readlink "/proc/${pid}/cwd" 2>/dev/null)" = "${SIDECAR_DIR}" ]; then
    kill "${pid}" 2>/dev/null && restarted_sidecar=true
  fi
done
if [ "${restarted_sidecar}" = true ]; then
  echo "Restarted the a2ui-pane sidecar; the host respawns it in a few seconds."
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
