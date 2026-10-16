# a2ui-pane

A plugin for Antigravity and compatible agent hosts that renders agent-generated A2UI surfaces in the AuxPane or inline in chat via `<agent-embed>`. It also ships the `genui` skill to guide when and how agents use these surfaces.

## Overview

`a2ui-pane` gives AI coding agents a visual interface across five components:

| Component              | Purpose                                                                                                                                                                                                                                                                                                              |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AuxPane UI             | A live side pane that renders multi-surface A2UI layouts, applies incremental updates (`updateComponents`, `updateDataModel`), and routes user actions back to the agent as chat turns.                                                                                                                              |
| Inline Chat Cards      | Self-contained `<agent-embed>` HTML cards rendered inline in conversation history for compact decisions.                                                                                                                                                                                                             |
| A2UI Express Authoring | `render_a2ui` compiles [A2UI Express](https://github.com/a2ui-project/a2ui/tree/main/specification/proposals/express) (`dsl`) or named templates (`template` + `dsl`) through a persistent Python worker. Raw JSON `messages` also work.                                                                             |
| Validating MCP Server  | Checks every batch against the basic catalog before saving. Express parse errors return line and column numbers, and compiler errors include fix hints for self-correction.                                                                                                                                          |
| `genui` Skill          | Routes visual output across chat Markdown, artifacts, inline cards, the side pane, HTML widgets, or host question tools, with eight ready-made templates (`assumption_ledger`, `contract_workbench`, `consequence_cards`, `triage_matrix`, `state_walkthrough`, `wave_sequencer`, `confirm_gate`, `progress_board`). |

## Repository Structure

- `packages/protocol`: Shared types for the message store, SSE stream events, and action formatting.
- `packages/theme`: CSS token mapping between host design systems and A2UI.
- `packages/renderer`: Lit renderer library wrapping `@a2ui/lit` and `@a2ui/web_core`.
- `packages/pane-app`: Vite application served in the AuxPane iframe.
- `packages/embed`: Self-contained IIFE bundle for inline `<agent-embed>` cards.
- `packages/sidecar`: Node HTTP server serving the pane app, SSE updates, and action dispatching.
- `packages/mcp-server`: Stdio MCP server exposing `render_a2ui`, `a2ui_instructions`, and `await_a2ui_action`, plus `python/express_worker.py` for Express compilation.
- `plugin/`: Installable plugin folder containing manifests, build outputs, the `genui` skill and templates, and the `genui` rule.
- `catalogs/`: Bundled A2UI component catalog schemas.

## Quick Install (Pre-built Release)

Install or update the latest pre-built plugin release directly without cloning the repository or building from source:

```bash
# Basic install (raw A2UI JSON messages):
curl -fsSL https://raw.githubusercontent.com/gspencergoog/a2ui-pane/main/scripts/install-remote.sh | bash

# With A2UI Express authoring support enabled:
curl -fsSL https://raw.githubusercontent.com/gspencergoog/a2ui-pane/main/scripts/install-remote.sh | bash -s -- --agent-sdk-path ~/code/a2ui/main
```

Prerequisites: Only `node` (>= 20) and `curl` or `wget` are required.

To update to the latest release at any time, re-run the install command.

---

## Development & Building from Source

For contributors developing `a2ui-pane`:

### Requirements

- Node.js >= 22.0.0
- Yarn 4.x (managed via Corepack)
- For A2UI Express authoring: [`uv`](https://docs.astral.sh/uv/) and a local checkout of the [a2ui](https://github.com/a2ui-project/a2ui) repository containing `python/a2ui_agent`.

```bash
# Install dependencies
yarn install

# Build all packages
yarn build

# Run unit tests
yarn test

# Lint and format
yarn lint
yarn format:check

# Package release archives locally
yarn package
```

### Local Source Installation

Run the install script from your local checkout to build packages, stage the plugin, and symlink it into your host plugins directory:

```bash
./scripts/install.sh --agent-sdk-path ~/code/a2ui/main
```

Without `--agent-sdk-path` (or `A2UI_PANE_AGENT_SDK_PATH`), pass `--no-agent-sdk` to install with raw `messages` rendering only.

The script writes these into `plugin/mcp_config.json`:

| Variable                     | Meaning                                                                                                     |
| :--------------------------- | :---------------------------------------------------------------------------------------------------------- |
| `A2UI_PANE_PYTHON`           | Interpreter that can import `a2ui.inference_formats.express` (resolved from the checkout's `uv` workspace). |
| `A2UI_PANE_AGENT_SDK_PATH`   | The a2ui checkout; used with `uv run --project` if `A2UI_PANE_PYTHON` is unset.                             |
| `A2UI_PANE_PROTOCOL_VERSION` | Target protocol version for compiled Express (`v0.9` today; the renderer does not draw v1.0 yet).           |

User templates: drop `.a2ui` files into `${PLUGIN_DATA}/templates/`. They shadow built-in templates with the same id.

To remove the plugin:

```bash
./scripts/uninstall.sh
```

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
