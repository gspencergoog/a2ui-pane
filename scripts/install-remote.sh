#!/usr/bin/env bash
#
# install-remote.sh: Install pre-built a2ui-pane plugin directly from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gspencergoog/a2ui-pane/main/scripts/install-remote.sh | bash
#
# Options:
#   --version <tag>         Install specific release tag (default: latest)
#   --repo <owner/repo>     GitHub repository (default: gspencergoog/a2ui-pane)
#   --target-dir <path>     Target installation directory (default: ~/.gemini/config/plugins/a2ui-pane)
#   --tarball-url <url>     Direct URL to tarball archive
#   --tarball-path <path>   Local tarball archive to install from (for testing/offline)
#   --agent-sdk-path <path> Path to a2ui checkout for Python Express authoring
#   --no-agent-sdk          Explicitly disable Express authoring (raw messages only)
#

set -euo pipefail

REPO="gspencergoog/a2ui-pane"
VERSION="latest"
TARGET_DIR="${HOME}/.gemini/config/plugins/a2ui-pane"
TARBALL_URL=""
TARBALL_PATH=""
AGENT_SDK_PATH="${A2UI_PANE_AGENT_SDK_PATH:-}"
NO_AGENT_SDK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --target-dir)
      TARGET_DIR="$2"
      shift 2
      ;;
    --tarball-url)
      TARBALL_URL="$2"
      shift 2
      ;;
    --tarball-path)
      TARBALL_PATH="$(cd "$(dirname "$2")" 2>/dev/null && pwd)/$(basename "$2")"
      shift 2
      ;;
    --agent-sdk-path)
      AGENT_SDK_PATH="$2"
      shift 2
      ;;
    --no-agent-sdk)
      NO_AGENT_SDK=1
      shift
      ;;
    -h|--help)
      cat << 'EOF'
Usage: install-remote.sh [OPTIONS]

Options:
  --version <tag>         Install a specific release version (default: latest)
  --repo <owner/repo>     GitHub repository (default: gspencergoog/a2ui-pane)
  --target-dir <path>     Target directory (default: ~/.gemini/config/plugins/a2ui-pane)
  --tarball-url <url>     Download directly from a custom URL
  --tarball-path <path>   Install from a local .tar.gz archive
  --agent-sdk-path <path> Path to a2ui checkout for Python Express authoring
  --no-agent-sdk          Explicitly disable Express authoring (raw messages only)
  -h, --help              Show this help message
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

echo "=== Installing A2UI Pane Plugin ==="

# 1. Check prerequisite tools
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "Error: 'node' executable not found in PATH." >&2
  echo "Node.js (>=20) is required to run the A2UI Pane sidecar and MCP server." >&2
  exit 1
fi

NODE_MAJOR="$("${NODE_BIN}" -v | sed 's/^v//' | cut -d. -f1)"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Error: Node.js version $("${NODE_BIN}" -v) is older than 20. Node >= 20 is required." >&2
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "Error: 'tar' utility not found." >&2
  exit 1
fi

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
fi

if [[ -z "${TARBALL_PATH}" && -z "${DOWNLOADER}" ]]; then
  echo "Error: Neither 'curl' nor 'wget' was found to download the release." >&2
  exit 1
fi

# 2. Resolve download source
TEMP_DIR="$(mktemp -d -t a2ui-install-XXXXXX)"
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

ARCHIVE_FILE=""
if [[ -n "${TARBALL_PATH}" ]]; then
  if [[ ! -f "${TARBALL_PATH}" ]]; then
    echo "Error: Specified tarball does not exist: ${TARBALL_PATH}" >&2
    exit 1
  fi
  ARCHIVE_FILE="${TARBALL_PATH}"
  echo "Using local archive: ${ARCHIVE_FILE}"
else
  if [[ -z "${TARBALL_URL}" ]]; then
    if [[ "${VERSION}" == "latest" ]]; then
      TARBALL_URL="https://github.com/${REPO}/releases/latest/download/a2ui-pane.tar.gz"
    else
      TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION}/a2ui-pane.tar.gz"
    fi
  fi

  ARCHIVE_FILE="${TEMP_DIR}/a2ui-pane.tar.gz"
  echo "Downloading A2UI Pane release from: ${TARBALL_URL}"
  if [[ "${DOWNLOADER}" == "curl" ]]; then
    if ! curl -fsSL "${TARBALL_URL}" -o "${ARCHIVE_FILE}"; then
      echo "Error: Failed to download release from ${TARBALL_URL}" >&2
      exit 1
    fi
  else
    if ! wget -q "${TARBALL_URL}" -O "${ARCHIVE_FILE}"; then
      echo "Error: Failed to download release from ${TARBALL_URL}" >&2
      exit 1
    fi
  fi
fi

# 3. Extract to target directory
echo "Extracting plugin into: ${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"

# Remove existing plugin-managed directories and files cleanly (preserving user data if any)
rm -rf "${TARGET_DIR}/mcp" "${TARGET_DIR}/sidecars" "${TARGET_DIR}/rules" "${TARGET_DIR}/skills"
rm -f "${TARGET_DIR}/plugin.json" "${TARGET_DIR}/mcp_config.template.json"

tar -xzf "${ARCHIVE_FILE}" -C "${TARGET_DIR}"

# 4. Configure Python Express worker (optional)
PYTHON_BIN=""
if [[ -n "${AGENT_SDK_PATH}" && "${NO_AGENT_SDK}" -eq 0 ]]; then
  AGENT_SDK_PATH="$(cd "${AGENT_SDK_PATH}" && pwd)"
  UV_BIN="${A2UI_PANE_UV:-}"
  if [[ -z "${UV_BIN}" ]]; then
    UV_BIN="$(command -v uv 2>/dev/null || true)"
  fi
  if [[ -z "${UV_BIN}" && -x "${HOME}/.local/bin/uv" ]]; then
    UV_BIN="${HOME}/.local/bin/uv"
  fi
  if [[ -z "${UV_BIN}" ]]; then
    echo "Warning: 'uv' not found. Disabling Express worker." >&2
  elif [[ ! -f "${AGENT_SDK_PATH}/python/a2ui_agent/pyproject.toml" ]]; then
    echo "Warning: ${AGENT_SDK_PATH} is missing python/a2ui_agent/pyproject.toml. Disabling Express worker." >&2
  else
    PYTHON_BIN="$("${UV_BIN}" run --project "${AGENT_SDK_PATH}" --package a2ui-agent-sdk python -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
  fi
fi

# 5. Generate mcp_config.json from template
TEMPLATE="${TARGET_DIR}/mcp_config.template.json"
TARGET_CONFIG="${TARGET_DIR}/mcp_config.json"

if [[ -f "${TEMPLATE}" ]]; then
  if [[ -n "${PYTHON_BIN}" ]]; then
    EXPRESS_CMD="${PYTHON_BIN} -m a2ui_agent.express_worker"
  else
    EXPRESS_CMD=""
  fi

  command python3 - "${TEMPLATE}" "${TARGET_CONFIG}" "${NODE_BIN}" "${EXPRESS_CMD}" << 'EOF'
import sys, json

template_path, target_path, node_bin, express_cmd = sys.argv[1:5]
with open(template_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

server = cfg.get("mcpServers", {}).get("a2ui-pane", {})
server["command"] = node_bin
env = server.get("env", {})
if express_cmd:
    env["A2UI_PANE_EXPRESS_CMD"] = express_cmd
else:
    env.pop("A2UI_PANE_EXPRESS_CMD", None)

with open(target_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
EOF
fi

# 6. Signal Language Server & update config.json
echo "Registering plugin with Antigravity / Jetski..."
pkill -f "a2ui-pane/mcp/dist/server.mjs" 2>/dev/null || true

command python3 -c '
import glob, json, os, re, subprocess, urllib.request

instances = []

# 1. Environment variables
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

# 3. Process table inspection (macOS & external terminals)
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

# Ensure plugin is enabled in config.json
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

echo ""
echo "✨ Successfully installed a2ui-pane to: ${TARGET_DIR}"
echo "You can toggle the sidecar pane at: sidecar://a2ui-pane/a2ui-pane/"
