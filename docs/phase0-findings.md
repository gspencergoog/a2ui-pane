# Phase 0 Findings & Spikes

Completed: 2026-09-30

This document records the empirical results of Phase 0 host checks, spikes, and probe plugin tests for `a2ui-pane`.

---

## 1. Host Checks Matrix

| Question                        | Finding                                                                                                                                                                                 | Verified By                                                                                   | Notes / Impact on Design                                                                                                    |
| :------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- |
| **Plugin Folder**               | `~/.gemini/config/plugins/`                                                                                                                                                             | Filesystem inspection (`Google.securecoder.securecoder` installed there) & `agent-plugins.md` | Both Jetski and Antigravity discover plugins in `~/.gemini/config/plugins/<name>/`. Symlinking works.                       |
| **Node on PATH**                | `/usr/bin/node` (`v22.22.2`)                                                                                                                                                            | Direct CLI check & `probe-mcp.mjs` execution                                                  | Node 22 is available on system `PATH`. Suitable for MCP servers and sidecars.                                               |
| **MCP Server Environment**      | `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded; `ANTIGRAVITY_CONVERSATION_ID`, `ANTIGRAVITY_PROJECT_ID`, `ANTIGRAVITY_AGENTAPI_EXE` present in host agent environment.              | `agent-plugins.md` § "Plugin paths" & `probe-mcp.mjs` test run                                | MCP server can access `${PLUGIN_DATA}` reliably. `conversationId` is known in the agent's context.                          |
| **mcp_config.json Expansion**   | `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded in `args`, `env`, and `cwd`.                                                                                                         | Documented in `agent-plugins.md`                                                              | Can use `"args": ["${PLUGIN_ROOT}/mcp/dist/server.mjs"]` and `"env": {"A2UI_PANE_DATA": "${PLUGIN_DATA}"}`.                 |
| **Sidecar Environment & Query** | Host supplies port in `ANTIGRAVITY_SIDECAR_WEB_PORT`, token in `ANTIGRAVITY_SIDECAR_UI_TOKEN`, conversation ID in `ANTIGRAVITY_CONVERSATION_ID`, and passes `?token=...` in iframe URL. | `sidecar_sdk/node/index.mjs` & probe sidecar test run                                         | Sidecar extracts token from query parameter or headers, and checks on protected endpoints (SSE, `/_sidecar/send-message`).  |
| **Agent Conversation ID**       | Verified: `"4a376f22-6987-4fb1-ac56-16453167bd5c"` injected in system prompt and environment.                                                                                           | Inspected environment variables in active session                                             | Agent can pass its conversation ID to `render_a2ui`.                                                                        |
| **`<agent-embed>` Location**    | Verified: `<agent-embed src="file:///...">` loads any local file URL.                                                                                                                   | Generated `file:///tmp/probe-embed/test-embed.html` via `probe_embed` tool                    | Embed files can reside in `${PLUGIN_DATA}/embeds/...` or artifact directories.                                              |
| **SSE Delivery & Buffering**    | Confirmed: plain Node `http.createServer` with `text/event-stream` and `X-Accel-Buffering: no` streams events at exact 1000ms intervals with 0 buffering.                               | Probe sidecar test run on `127.0.0.1:49876/api/sse-test`                                      | Option A (custom HTTP server + SSE) is verified to work cleanly.                                                            |
| **preload.js Resolution**       | When run under the host's loader, `sidecar_sdk` resolves. Standalone runs use our fallback preload shim.                                                                                | Probe sidecar runtime resolution test                                                         | We ship `preload-shim.js` as a fallback when `sidecar_sdk` is not resolved, ensuring the sidecar works in all environments. |

---

## 2. Streaming Spike Results

### Command Tested

```bash
$ANTIGRAVITY_AGENTAPI_EXE agentapi stream-conversation --conversation <id>
```

### Result

```json
{
  "response": {},
  "error": "unknown command: stream-conversation"
}
```

Available `agentapi` commands in the host binary:

- `get-conversation-metadata <conversation_id>`
- `new-conversation [--model=<...>] [--title=<...>] <prompt>`
- `send-message [--title=<...>] <recipient_id> <content>`

### Decision & Impact

- `agentapi stream-conversation` is not supported by the language server daemon.
- **Mid-call token/argument streaming (Phase 8) is NOT possible** via `agentapi`.
- As planned, streaming is achieved **line-by-line across sequential `render_a2ui` calls** or progressive JSONL appends. The store's one-message-per-line structure handles progressive UI construction as multiple calls are executed.

---

## 3. Bundle-Size Spike Results

### Build Target

Bundled `@a2ui/lit/v0_9` (including `A2uiSurface`, `basicCatalog`, and context), `web_core/v0_9` (`MessageProcessor`, `Catalog`), `@a2ui/markdown-it`, and Lit core into an IIFE.

### Measured Sizes

- **Minified IIFE (`lit-v09.min.js`)**: **259.5 KB** (~260 KB)
- **Gzipped IIFE**: **69.9 KB** (~70 KB)

### Decision & Impact

- A ~260 KB minified bundle is very lightweight (compared to the 15 MB Angular bundle previously used by Ads TrustGraph).
- Inlining this bundle into self-contained `<agent-embed>` snapshot HTML files in Phase 6 is completely viable and will not cause performance or artifact storage issues.
