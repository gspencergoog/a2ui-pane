#!/usr/bin/env bash
set -euo pipefail

TARGET_PLUGIN_DIR="${HOME}/.gemini/config/plugins/a2ui-pane"

if [ -L "${TARGET_PLUGIN_DIR}" ]; then
  rm "${TARGET_PLUGIN_DIR}"
  echo "Removed symlink at ${TARGET_PLUGIN_DIR}"
elif [ -d "${TARGET_PLUGIN_DIR}" ]; then
  echo "Target ${TARGET_PLUGIN_DIR} is a real directory, not removing automatically."
  exit 1
else
  echo "No existing installation found at ${TARGET_PLUGIN_DIR}"
fi

echo "✨ Successfully uninstalled a2ui-pane plugin."
