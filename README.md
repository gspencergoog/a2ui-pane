# a2ui-pane

A plugin for Jetski and Antigravity that renders agent-generated A2UI surfaces in the AuxPane (live and interactive) and inline in chat via `<agent-embed>`, and ships the `genui` skill that teaches the agent when and how to use them.

## Overview

`a2ui-pane` gives AI coding agents a visual interface:

- **AuxPane UI:** A live side pane that renders multi-surface A2UI layouts, updates state incrementally (`updateComponents`, `updateDataModel`), and forwards user actions (button clicks, form submits) directly back to the agent as chat turns.
- **Inline Chat Cards:** Self-contained `<agent-embed>` HTML cards rendered inline in conversation history for compact decisions.
- **A2UI Express authoring:** `render_a2ui` accepts [A2UI Express](https://github.com/a2ui-project/a2ui/tree/main/specification/proposals/express) (`dsl`) or a named template plus data (`template` + `dsl`) and compiles it with the upstream Python compiler in one persistent worker process, so the agent never writes adjacency-list JSON by hand. Raw `messages` still work.
- **Validating MCP Server:** Every batch is validated against the basic catalog before it is committed; Express parse errors come back with the line and column, and compiler errors with the compiler's fix hint, so the agent can self-correct.
- **`genui` skill:** The plugin's `plugin/skills/genui` skill is a "how to show things" router (chat Markdown, artifact, inline card, pane, HTML widget, or `ask_question`) with eight ready-made templates (`assumption_ledger`, `contract_workbench`, `consequence_cards`, `triage_matrix`, `state_walkthrough`, `wave_sequencer`, `confirm_gate`, `progress_board`).

## Repository Structure

- `packages/protocol`: Shared types for the message store, SSE stream events, and action formatting.
- `packages/theme`: CSS token mapping between host design systems and A2UI.
- `packages/renderer`: Lit renderer library wrapping `@a2ui/lit` and `@a2ui/web_core`.
- `packages/pane-app`: Vite application served in the AuxPane iframe.
- `packages/embed`: Self-contained IIFE bundle for inline `<agent-embed>` cards.
- `packages/sidecar`: Node HTTP server serving the pane app, SSE updates, and action dispatching.
- `packages/mcp-server`: Stdio MCP server exposing `render_a2ui`, `a2ui_instructions`, and `await_a2ui_action`; `python/express_worker.py` is the Express compile worker it spawns.
- `plugin/`: Installable plugin folder (manifests, build output, the `genui` skill and its templates, the `genui` rule).
- `catalogs/`: Bundled A2UI component catalog schemas.

## Requirements

- Node.js >= 22.0.0
- Yarn 4.x (managed via Corepack)
- For A2UI Express authoring: [`uv`](https://docs.astral.sh/uv/) and a local checkout of the [a2ui](https://github.com/a2ui-project/a2ui) repository (a `uv` workspace containing `python/a2ui_agent`). No published `a2ui-agent-sdk` release includes the current Express compiler API yet; once one does, `install.sh` can switch to it.

## Development

```bash
# Install dependencies
yarn install

# Build all packages
yarn build

# Run unit tests (Express worker and template goldens run when a Python SDK is configured)
A2UI_PANE_PYTHON=/path/to/a2ui/.venv/bin/python3 yarn test

# Regenerate template goldens after editing a template
UPDATE_GOLDENS=1 A2UI_PANE_PYTHON=... yarn workspace @a2ui-pane/mcp-server test

# Lint and format
yarn lint
yarn format:check
```

## Installation

Run the install script to build the packages, stage the plugin, resolve the Python interpreter for the Express worker, pre-warm it, and symlink the plugin into the host plugins directory:

```bash
./scripts/install.sh --agent-sdk-path ~/code/a2ui/main
```

Without `--agent-sdk-path` (or `A2UI_PANE_AGENT_SDK_PATH`) the plugin installs with raw `messages` rendering only, and `a2ui_instructions` says so.

The script writes these into `plugin/mcp_config.json`:

| Variable                     | Meaning                                                                                                                  |
| :--------------------------- | :----------------------------------------------------------------------------------------------------------------------- |
| `A2UI_PANE_PYTHON`           | Interpreter that can import `a2ui.inference_formats.experimental.express` (resolved from the checkout's `uv` workspace). |
| `A2UI_PANE_AGENT_SDK_PATH`   | The a2ui checkout; used with `uv run --project` if `A2UI_PANE_PYTHON` is unset.                                          |
| `A2UI_PANE_PROTOCOL_VERSION` | Target protocol version for compiled Express (`v0.9` today; the renderer does not draw v1.0 yet).                        |

User templates: drop `.a2ui` files into `${PLUGIN_DATA}/templates/` (for Jetski, `~/.gemini/jetski/plugin_data/a2ui-pane/templates/`). They shadow built-in templates with the same id.

To remove the plugin:

```bash
./scripts/uninstall.sh
```

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
