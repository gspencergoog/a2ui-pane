#!/usr/bin/env bash
#
# package.sh: Build, stage, and package a2ui-pane into standalone release archives.
#
# Usage:
#   ./scripts/package.sh [--skip-tests] [--output-dir <path>]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${REPO_ROOT}/dist"
SKIP_TESTS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    --output-dir)
      OUTPUT_DIR="$(cd "$2" 2>/dev/null && pwd || echo "$2")"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./scripts/package.sh [--skip-tests] [--output-dir <path>]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cd "${REPO_ROOT}"

echo "=== Packaging a2ui-pane Release Bundle ==="

if [[ "${SKIP_TESTS}" -eq 0 ]]; then
  echo "--- Running test suite and linter ---"
  command yarn test
  command yarn lint
else
  echo "--- Skipping test suite (--skip-tests) ---"
fi

echo "--- Building monorepo packages ---"
command yarn build

STAGING_DIR="${OUTPUT_DIR}/staging"
rm -rf "${STAGING_DIR}"
mkdir -p "${STAGING_DIR}"
mkdir -p "${OUTPUT_DIR}"

echo "--- Staging release assets ---"
# 1. Plugin metadata and configuration
cp "${REPO_ROOT}/plugin/plugin.json" "${STAGING_DIR}/"
cp "${REPO_ROOT}/plugin/mcp_config.template.json" "${STAGING_DIR}/"

# Default mcp_config.json with 'node' fallback for standalone extractions
cat > "${STAGING_DIR}/mcp_config.json" << 'EOF'
{
  "mcpServers": {
    "a2ui-pane": {
      "command": "node",
      "args": [
        "${PLUGIN_DIR}/mcp/dist/server.mjs"
      ],
      "env": {
        "A2UI_PANE_DATA": "${PLUGIN_DATA}"
      }
    }
  }
}
EOF

# 2. Rules and skills
cp -R "${REPO_ROOT}/plugin/rules" "${STAGING_DIR}/"
cp -R "${REPO_ROOT}/plugin/skills" "${STAGING_DIR}/"

# 3. MCP server bundle and assets
mkdir -p "${STAGING_DIR}/mcp/dist"
cp "${REPO_ROOT}/packages/mcp-server/dist/server.mjs" "${STAGING_DIR}/mcp/dist/"
cp "${REPO_ROOT}/packages/embed/dist/embed.iife.js" "${STAGING_DIR}/mcp/dist/"
cp "${REPO_ROOT}/packages/mcp-server/dist/express_worker.py" "${STAGING_DIR}/mcp/dist/"
cp -R "${REPO_ROOT}/packages/mcp-server/dist/catalogs" "${STAGING_DIR}/mcp/dist/"

# 4. Sidecar server and web application
mkdir -p "${STAGING_DIR}/sidecars/a2ui-pane/dist"
mkdir -p "${STAGING_DIR}/sidecars/a2ui-pane/web"
cp "${REPO_ROOT}/plugin/sidecars/a2ui-pane/sidecar.json" "${STAGING_DIR}/sidecars/a2ui-pane/"
cp "${REPO_ROOT}/packages/sidecar/dist/main.mjs" "${STAGING_DIR}/sidecars/a2ui-pane/dist/"
cp -R "${REPO_ROOT}/packages/pane-app/dist"/. "${STAGING_DIR}/sidecars/a2ui-pane/web/"

# Also keep the plugin/ directory in sync
mkdir -p "${REPO_ROOT}/plugin/sidecars/a2ui-pane/web"
mkdir -p "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist"
mkdir -p "${REPO_ROOT}/plugin/mcp/dist"
cp -R "${STAGING_DIR}/sidecars/a2ui-pane/web"/. "${REPO_ROOT}/plugin/sidecars/a2ui-pane/web/"
cp "${STAGING_DIR}/sidecars/a2ui-pane/dist/main.mjs" "${REPO_ROOT}/plugin/sidecars/a2ui-pane/dist/"
cp "${STAGING_DIR}/mcp/dist/server.mjs" "${REPO_ROOT}/plugin/mcp/dist/"

echo "--- Creating archives in ${OUTPUT_DIR} ---"
TARBALL="${OUTPUT_DIR}/a2ui-pane.tar.gz"
ZIPFILE="${OUTPUT_DIR}/a2ui-pane.zip"

rm -f "${TARBALL}" "${ZIPFILE}"

# Build .tar.gz
tar -czf "${TARBALL}" -C "${STAGING_DIR}" .

# Build .zip if zip utility is available
if command -v zip >/dev/null 2>&1; then
  (cd "${STAGING_DIR}" && zip -r -q "${ZIPFILE}" .)
fi

# Generate SHA256 checksums
compute_sha256() {
  local target="$1"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$(dirname "$target")" && shasum -a 256 "$(basename "$target")" > "$(basename "$target").sha256")
  elif command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$target")" && sha256sum "$(basename "$target")" > "$(basename "$target").sha256")
  fi
}

compute_sha256 "${TARBALL}"
if [[ -f "${ZIPFILE}" ]]; then
  compute_sha256 "${ZIPFILE}"
fi

# Clean up temporary staging directory
rm -rf "${STAGING_DIR}"

echo "=== Packaging Complete ==="
ls -lh "${OUTPUT_DIR}"/a2ui-pane.*
echo ""
echo "Archive contents sample:"
(tar -ztvf "${TARBALL}" 2>/dev/null || true) | head -n 25 || true
