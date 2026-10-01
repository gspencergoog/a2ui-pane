import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CatalogRegistry } from './catalog-registry.js';
import { StoreWriter } from './store-writer.js';
import { ConversationState } from './conversation-state.js';
import { ActionEndpoint } from './action-endpoint.js';
import { handleA2uiInstructions, a2uiInstructionsSchema } from './tools/instructions.js';
import { handleRenderA2ui, renderA2uiSchema } from './tools/render.js';
import { handleAwaitA2uiAction, awaitA2uiActionSchema } from './tools/await-action.js';

const MAX_CONVERSATION_STATES = 100;

export interface ServerOptions {
  actionEndpoint?: ActionEndpoint;
}

/**
 * Creates and configures an MCP server instance with registered A2UI tools and state.
 */
export function createServer(dataDir: string, options: ServerOptions = {}) {
  const catalogs = new CatalogRegistry();
  const store = new StoreWriter(dataDir);
  const conversationStates = new Map<string, ConversationState>();
  const actionEndpoint = options.actionEndpoint;

  const getState = (conversationId: string): ConversationState => {
    let state = conversationStates.get(conversationId);
    if (!state) {
      // LRU eviction to prevent unbounded memory growth in long-running processes
      if (conversationStates.size >= MAX_CONVERSATION_STATES) {
        const oldestKey = conversationStates.keys().next().value;
        if (oldestKey) {
          conversationStates.delete(oldestKey);
        }
      }
      state = new ConversationState(conversationId, catalogs, store);
      conversationStates.set(conversationId, state);
    }
    return state;
  };

  const server = new McpServer({
    name: 'a2ui-pane',
    version: '0.1.0',
  });

  server.tool(
    'a2ui_instructions',
    'Returns the system prompt and component catalog schemas for generating valid A2UI layouts.',
    a2uiInstructionsSchema,
    async (args) => handleA2uiInstructions(args, catalogs),
  );

  server.tool(
    'render_a2ui',
    'Renders and incrementally updates A2UI surfaces in the user interface.',
    renderA2uiSchema,
    async (args) => handleRenderA2ui(args, getState, catalogs, dataDir, actionEndpoint),
  );

  server.tool(
    'await_a2ui_action',
    'Awaits a user action triggered from an active A2UI surface. Use after rendering an interactive surface to pause execution until the user interacts.',
    awaitA2uiActionSchema,
    async (args) => handleAwaitA2uiAction(args, actionEndpoint),
  );

  return { server, catalogs, store, getState, conversationStates, actionEndpoint };
}

export async function run() {
  const dataDir = process.env.A2UI_PANE_DATA || process.env.PLUGIN_DATA;
  if (!dataDir) {
    throw new Error('Neither A2UI_PANE_DATA nor PLUGIN_DATA environment variable is defined.');
  }

  const enableSideChannel =
    process.env.A2UI_PANE_EXPERIMENTAL === '1' || process.env.A2UI_PANE_SIDE_CHANNEL === '1';

  let actionEndpoint: ActionEndpoint | undefined;
  if (enableSideChannel) {
    actionEndpoint = new ActionEndpoint({ dataDir });
    try {
      await actionEndpoint.start();
      console.error(
        `[a2ui-pane] Experimental action side channel listening on port ${actionEndpoint.getPort()}`,
      );
    } catch (err) {
      console.error('[a2ui-pane] Failed starting action side channel:', err);
    }
  }

  const { server } = createServer(dataDir, { actionEndpoint });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[a2ui-pane] MCP server connected over stdio');
  return server;
}

/**
 * Checks whether the current module was launched as the CLI entrypoint,
 * properly resolving symlinks and percent-encoded paths.
 */
export function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    const realArgv = realpathSync(process.argv[1]);
    const realUrlPath = fileURLToPath(import.meta.url);
    return realArgv === realUrlPath;
  } catch {
    return false;
  }
}

// Auto-run if executed directly as entrypoint
if (isMainModule()) {
  run().catch((err) => {
    console.error('[a2ui-pane] Fatal server error:', err);
    process.exit(1);
  });
}
