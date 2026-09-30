import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CatalogRegistry } from './catalog-registry.js';
import { StoreWriter } from './store-writer.js';
import { ConversationState } from './conversation-state.js';
import { handleA2uiInstructions, a2uiInstructionsSchema } from './tools/instructions.js';
import { handleRenderA2ui, renderA2uiSchema } from './tools/render.js';

/**
 * Creates and configures an MCP server instance with registered A2UI tools and state.
 */
export function createServer(dataDir: string) {
  const catalogs = new CatalogRegistry();
  const store = new StoreWriter(dataDir);
  const conversationStates = new Map<string, ConversationState>();

  const getState = (conversationId: string): ConversationState => {
    let state = conversationStates.get(conversationId);
    if (!state) {
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
    async (args) => handleRenderA2ui(args, getState),
  );

  return { server, catalogs, store, getState };
}

async function run() {
  const dataDir = process.env.A2UI_PANE_DATA || process.env.PLUGIN_DATA;
  if (!dataDir) {
    console.error(
      '[a2ui-pane] Fatal: Neither A2UI_PANE_DATA nor PLUGIN_DATA environment variable is defined.',
    );
    process.exit(1);
  }

  const { server } = createServer(dataDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[a2ui-pane] MCP server connected over stdio');
}

// Auto-run if executed directly as entrypoint
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  run().catch((err) => {
    console.error('[a2ui-pane] Fatal server error:', err);
    process.exit(1);
  });
}
