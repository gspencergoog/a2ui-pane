#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${HOME}/.gemini/config/plugins/a2ui-pane-probe"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -L "${TARGET_DIR}" || -d "${TARGET_DIR}" ]]; then
    rm -rf "${TARGET_DIR}"
    echo "Uninstalled probe plugin symlink at ${TARGET_DIR}"
  else
    echo "No probe plugin installed at ${TARGET_DIR}"
  fi
  exit 0
fi

mkdir -p "${HOME}/.gemini/config/plugins"
if [[ -L "${TARGET_DIR}" || -d "${TARGET_DIR}" ]]; then
  rm -rf "${TARGET_DIR}"
fi

ln -s "${SCRIPT_DIR}" "${TARGET_DIR}"
echo "Installed probe plugin symlink:"
echo "  ${TARGET_DIR} -> ${SCRIPT_DIR}"
echo ""
echo "Next steps:"
echo "1. Verify the probe MCP server in Jetski or Antigravity:"
echo "   In chat: call tool 'mcp_a2ui-probe_probe_env' or ask 'probe my environment'."
echo "2. Open the AuxPane tab for 'A2UI Probe' to verify theme tokens and SSE streaming."
