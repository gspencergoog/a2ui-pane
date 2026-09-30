# a2ui-pane

A plugin for Jetski and Antigravity that renders agent-generated A2UI surfaces in the AuxPane (live and interactive) and inline in chat via `<agent-embed>`.

## Overview

`a2ui-pane` gives AI coding agents a visual interface:

- **AuxPane UI:** A live side pane that renders multi-surface A2UI layouts, updates state incrementally (`updateComponents`, `updateDataModel`), and forwards user actions (button clicks, form submits) directly back to the agent as chat turns.
- **Inline Chat Cards:** Self-contained `<agent-embed>` HTML cards rendered inline in conversation history for snapshot results.
- **Validating MCP Server:** An MCP tool (`render_a2ui`) that runs stateful validation before committing payloads, returning structured errors so the agent can self-correct.

## Repository Structure

- `packages/protocol`: Shared types for the message store, SSE stream events, and action formatting.
- `packages/theme`: CSS token mapping between host design systems and A2UI.
- `packages/renderer`: Lit renderer library wrapping `@a2ui/lit` and `@a2ui/web_core`.
- `packages/pane-app`: Vite application served in the AuxPane iframe.
- `packages/embed`: Self-contained IIFE bundle for inline `<agent-embed>` cards.
- `packages/sidecar`: Node HTTP server serving the pane app, SSE updates, and action dispatching.
- `packages/mcp-server`: Stdio MCP server exposing `render_a2ui` and `a2ui_instructions`.
- `plugin/`: Installable plugin folder (manifests and build output).
- `catalogs/`: Bundled A2UI component catalog schemas.

## Requirements

- Node.js >= 22.0.0
- Yarn 4.x (managed via Corepack)

## Development

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
```

## Installation

Run the install script to build the packages and symlink the plugin into the host plugins directory:

```bash
./scripts/install.sh
```

To remove the plugin:

```bash
./scripts/uninstall.sh
```

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
