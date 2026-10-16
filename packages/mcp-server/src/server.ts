import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CatalogRegistry } from './catalog-registry.js';
import { StoreWriter } from './store-writer.js';
import { ConversationState } from './conversation-state.js';
import { ActionEndpoint } from './action-endpoint.js';
import { ExpressWorker } from './express-worker.js';
/** Re-exported Express worker client for embedding and test harnesses. */
export { ExpressWorker } from './express-worker.js';
import { TemplateRegistry } from './template-registry.js';
import { handleA2uiInstructions, a2uiInstructionsSchema } from './tools/instructions.js';
import { handleRenderA2ui, renderA2uiSchema } from './tools/render.js';
import { handleAwaitA2uiAction, awaitA2uiActionSchema } from './tools/await-action.js';

const MAX_CONVERSATION_STATES = 100;

/** Optional collaborators injected into `createServer`. */
export interface ServerOptions {
  actionEndpoint?: ActionEndpoint;
  worker?: ExpressWorker;
  templates?: TemplateRegistry;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

/** Directory containing the running bundle (plugin/mcp/dist in an installed plugin). */
function bundleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Builds the Express worker from environment configuration, or returns undefined when
 * neither an interpreter nor a local SDK checkout is configured.
 */
export function createExpressWorkerFromEnv(): ExpressWorker | undefined {
  const pythonBin = envValue('A2UI_PANE_PYTHON');
  const agentSdkPath = envValue('A2UI_PANE_AGENT_SDK_PATH');
  if (!pythonBin && !agentSdkPath && envValue('A2UI_PANE_EXPRESS') !== '1') {
    return undefined;
  }
  const dist = bundleDir();
  return new ExpressWorker({
    pythonBin,
    uvBin: envValue('A2UI_PANE_UV'),
    agentSdkPath,
    workerScript: envValue('A2UI_PANE_WORKER_SCRIPT') ?? path.join(dist, 'express_worker.py'),
    catalogPaths: envValue('A2UI_PANE_CATALOG_PATH')
      ? envValue('A2UI_PANE_CATALOG_PATH')!.split(path.delimiter).filter(Boolean)
      : [
          path.join(dist, 'catalogs', 'v1_0', 'basic', 'catalog.json'),
          path.join(dist, 'catalogs', 'v1_0', 'charts', 'catalog.json'),
        ],
    defaultVersion: envValue('A2UI_PANE_PROTOCOL_VERSION') ?? 'v1.0',
  });
}

/**
 * Builds the template registry: user templates under the data dir shadow the plugin's.
 */
export function createTemplateRegistryFromEnv(dataDir: string): TemplateRegistry {
  const pluginTemplates =
    envValue('A2UI_PANE_TEMPLATES_DIR') ??
    path.resolve(bundleDir(), '..', '..', 'skills', 'genui', 'templates');
  return new TemplateRegistry([
    { dir: path.join(dataDir, 'templates'), source: 'user' },
    { dir: pluginTemplates, source: 'plugin' },
  ]);
}

/**
 * Creates and configures an MCP server instance with registered A2UI tools and state.
 */
export function createServer(dataDir: string, options: ServerOptions = {}) {
  const catalogs = new CatalogRegistry();
  const store = new StoreWriter(dataDir);
  const conversationStates = new Map<string, ConversationState>();
  const actionEndpoint = options.actionEndpoint;
  const worker = options.worker;
  const templates = options.templates;

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
    'Returns the A2UI authoring instructions: the A2UI Express contract for the basic catalog, host rules for render_a2ui, and the template index (or the raw JSON protocol rules when Express is unavailable or format is "json"). Call once per session before render_a2ui.',
    a2uiInstructionsSchema,
    async (args) => handleA2uiInstructions(args, catalogs, { worker, templates }),
  );

  server.tool(
    'render_a2ui',
    'Renders and incrementally updates A2UI surfaces in the AuxPane (mode "pane") or as an inline chat card (mode "inline"). Author with `dsl` (A2UI Express), `template` + `dsl` (named template plus data assignments), or raw `messages`.',
    renderA2uiSchema,
    async (args) =>
      handleRenderA2ui(args, getState, catalogs, dataDir, actionEndpoint, { worker, templates }),
  );

  server.tool(
    'await_a2ui_action',
    'Awaits a user action triggered from an active A2UI surface. Use after rendering an interactive surface to pause execution until the user interacts.',
    awaitA2uiActionSchema,
    async (args) => handleAwaitA2uiAction(args, actionEndpoint),
  );

  return {
    server,
    catalogs,
    store,
    getState,
    conversationStates,
    actionEndpoint,
    worker,
    templates,
  };
}

/**
 * Starts the MCP server over stdio, optional loopback action endpoint, and Express worker.
 */
export async function run(): Promise<McpServer & { actionEndpoint?: ActionEndpoint }> {
  const dataDir = process.env.A2UI_PANE_DATA || process.env.PLUGIN_DATA;
  if (!dataDir) {
    throw new Error('Neither A2UI_PANE_DATA nor PLUGIN_DATA environment variable is defined.');
  }

  const enableSideChannel =
    process.env.A2UI_PANE_SIDE_CHANNEL !== '0' && process.env.A2UI_PANE_EXPERIMENTAL !== '0';

  let actionEndpoint: ActionEndpoint | undefined;
  if (enableSideChannel) {
    actionEndpoint = new ActionEndpoint({ dataDir });
    try {
      await actionEndpoint.start();
      console.error(
        `[a2ui-pane] Action side channel listening on port ${actionEndpoint.getPort()}`,
      );
    } catch (err) {
      console.error('[a2ui-pane] Failed starting action side channel:', err);
    }
  }

  const worker = createExpressWorkerFromEnv();
  if (!worker) {
    console.error(
      '[a2ui-pane] Express worker not configured (set A2UI_PANE_PYTHON or A2UI_PANE_AGENT_SDK_PATH); only raw `messages` rendering is available.',
    );
  }
  const templates = createTemplateRegistryFromEnv(dataDir);

  const { server } = createServer(dataDir, { actionEndpoint, worker, templates });
  const shutdown = () => {
    worker?.dispose();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[a2ui-pane] MCP server connected over stdio');
  return Object.assign(server, { actionEndpoint });
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
