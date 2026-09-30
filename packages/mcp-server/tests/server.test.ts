import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, isMainModule, run } from '../src/server.js';
import { CatalogRegistry } from '../src/catalog-registry.js';
import { buildPrompt } from '../src/prompt/build-prompt.js';
import { handleA2uiInstructions } from '../src/tools/instructions.js';
import { handleRenderA2ui } from '../src/tools/render.js';

describe('MCP Server Tools and Entrypoint', () => {
  let tempDir: string;
  let serverInstance: ReturnType<typeof createServer>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'a2ui-mcp-test-'));
    serverInstance = createServer(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    delete process.env.A2UI_PANE_DATA;
    delete process.env.PLUGIN_DATA;
  });

  describe('isMainModule and run entrypoint (H1)', () => {
    it('returns a boolean safely without throwing', () => {
      expect(typeof isMainModule()).toBe('boolean');
    });

    it('run() throws an error if neither A2UI_PANE_DATA nor PLUGIN_DATA is set', async () => {
      delete process.env.A2UI_PANE_DATA;
      delete process.env.PLUGIN_DATA;
      await expect(run()).rejects.toThrow(/Neither A2UI_PANE_DATA nor PLUGIN_DATA/);
    });

    it('run() initializes server when A2UI_PANE_DATA is provided', async () => {
      process.env.A2UI_PANE_DATA = tempDir;
      // StdioServerTransport in test environment attempts to read stdin
      // We verify that run() successfully resolves createServer and transport connection
      const serverPromise = run();
      await expect(serverPromise).resolves.toBeDefined();
    });
  });

  describe('a2ui_instructions', () => {
    it('returns protocol rules and basic catalog components', () => {
      const result = handleA2uiInstructions({}, serverInstance.catalogs);
      expect(result.content).toHaveLength(1);
      const text = result.content[0].text;
      expect(text).toContain('A2UI Protocol Rules (v0.9)');
      expect(text).toContain('createSurface');
      expect(text).toContain('updateComponents');
      expect(text).toContain('updateDataModel');
      expect(text).toContain('Available Component Catalogs');
      expect(text).toContain('Column');
      expect(text).toContain('Button');
      expect(text).toContain('Text');
    });

    it('filters by catalogId when provided', () => {
      const result = handleA2uiInstructions({ catalogIds: ['basic'] }, serverInstance.catalogs);
      expect(result.content[0].text).toContain('Catalog:');
    });

    it('handles unknown catalogIds by keeping target catalogs', () => {
      const result = handleA2uiInstructions(
        { catalogIds: ['nonexistent-catalog'] },
        serverInstance.catalogs,
      );
      expect(result.content[0].text).toContain('Catalog:');
    });

    it('provides default catalog via getDefaultCatalog', () => {
      const def = serverInstance.catalogs.getDefaultCatalog();
      expect(def).toBeDefined();
      expect(def.id).toContain('basic');
    });

    it('covers CatalogRegistry fallbacks and buildPrompt edge cases', () => {
      const reg = new CatalogRegistry();
      reg.register({} as any);
      expect(reg.get('custom-catalog')).toBeDefined();

      const p = buildPrompt([
        { id: '', components: new Map([['Comp1', { schema: {} } as any]]) } as any,
        { id: 'emptyCat', components: new Map() } as any,
      ]);
      expect(p).toContain('Comp1');
      expect(p).toContain('no extra properties');
    });
  });

  describe('render_a2ui', () => {
    it('rejects invalid conversation ID format', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: '../malicious-id',
          messages: [],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid conversationId');
    });

    it('rejects when conversationId is missing and not provided in environment', async () => {
      delete process.env.ANTIGRAVITY_CONVERSATION_ID;
      const result = await handleRenderA2ui(
        {
          messages: [],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Missing required conversationId');
    });

    it('defaults to ANTIGRAVITY_CONVERSATION_ID when conversationId is omitted in args (M5)', async () => {
      process.env.ANTIGRAVITY_CONVERSATION_ID = 'host-conv-default';
      const result = await handleRenderA2ui(
        {
          messages: [
            {
              version: 'v0.9',
              createSurface: { surfaceId: 'surf-env', catalogId: 'basic' },
            },
          ],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBeUndefined();
      expect(serverInstance.store.readAll('host-conv-default')).toHaveLength(1);
    });

    it('enforces trust boundary when args.conversationId does not match host env (M5)', async () => {
      process.env.ANTIGRAVITY_CONVERSATION_ID = 'active-session-123';
      const result = await handleRenderA2ui(
        {
          conversationId: 'spoofed-session-456',
          messages: [],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unauthorized conversationId');
      expect(result.content[0].text).toContain('active-session-123');
    });

    it('processes valid surface creation and reports success', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'valid-conv-1',
          messages: [
            {
              version: 'v0.9',
              createSurface: { surfaceId: 'ui-main', catalogId: 'basic' },
            },
            {
              version: 'v0.9',
              updateComponents: {
                surfaceId: 'ui-main',
                components: [{ id: 'root', component: 'Text', text: 'Rendered Title' }],
              },
            },
          ],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Rendered 2 message(s)');
      expect(result.content[0].text).toContain('[ui-main]');

      const stored = serverInstance.store.readAll('valid-conv-1');
      expect(stored).toHaveLength(2);
      expect(stored[0].seq).toBe(1);
      expect(stored[1].seq).toBe(2);
    });

    it('returns structured validation errors on schema failures', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'valid-conv-2',
          messages: [
            {
              version: 'v0.9',
              updateDataModel: {
                surfaceId: 'missing-surface',
                path: '/item',
                value: 'x',
              },
            },
          ],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('A2UI Validation Failed');
      expect(result.content[0].text).toContain('Message #1:');

      // Verifies no lines committed
      expect(serverInstance.store.readAll('valid-conv-2')).toHaveLength(0);
    });

    it('evicts oldest conversation state when capacity limit is reached (M4)', () => {
      const { getState, conversationStates } = serverInstance;
      for (let i = 0; i < 105; i++) {
        getState(`conv-${i}`);
      }
      expect(conversationStates.size).toBeLessThanOrEqual(100);
      expect(conversationStates.has('conv-0')).toBe(false);
      expect(conversationStates.has('conv-104')).toBe(true);
    });

    it('renders inline card mode and returns <agent-embed> markup', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'inline-conv-1',
          mode: 'inline',
          messages: [
            {
              version: 'v0.9',
              createSurface: { surfaceId: 'surfInline', catalogId: 'basic' },
            },
            {
              version: 'v0.9',
              updateComponents: {
                surfaceId: 'surfInline',
                components: [{ id: 'root', component: 'Text', text: 'Inline Message' }],
              },
            },
          ],
        },
        serverInstance.getState,
        serverInstance.catalogs,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Rendered inline A2UI card');
      expect(result.content[0].text).toContain('<agent-embed src="file://');
      expect(result.content[0].text).toContain('[surfInline]');
    });

    it('returns validation failure when inline mode contains invalid messages', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'inline-conv-invalid',
          mode: 'inline',
          messages: [
            {
              version: 'v0.9',
              updateDataModel: {
                surfaceId: 'missingInlineSurf',
                path: '/invalid',
                value: 123,
              },
            },
          ],
        },
        serverInstance.getState,
        serverInstance.catalogs,
        tempDir,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('A2UI Inline Validation Failed at Message #1');
    });

    it('handles inline mode without surfaceId gracefully', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'inline-conv-nosurf',
          mode: 'inline',
          messages: [],
        },
        serverInstance.getState,
        serverInstance.catalogs,
        tempDir,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(
        'Rendered inline A2UI card with 0 message(s) to surfaces.',
      );
    });

    it('handles replaying history with corrupted message by warning and continuing', () => {
      const convId = 'corrupt-replay';
      // Write a line that will fail validation during state replay
      serverInstance.store.append(convId, 'corrupt-call', [
        {
          version: 'v0.9',
          updateDataModel: {
            surfaceId: 'nonexistent',
            path: '/x',
            value: 1,
          },
        },
      ]);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const freshState = serverInstance.getState(convId);
      expect(freshState).toBeDefined();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('renders 0 messages in pane mode and covers empty surface text branch', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'pane-empty-messages',
          messages: [],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(
        'Rendered 0 message(s) to surfaces in the A2UI pane.',
      );
    });

    it('processes deleteSurface message and extracts surfaceId correctly', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'delete-surface-conv',
          messages: [
            {
              version: 'v0.9',
              createSurface: { surfaceId: 'surfToDelete', catalogId: 'basic' },
            },
            {
              version: 'v0.9',
              deleteSurface: { surfaceId: 'surfToDelete' },
            },
          ],
        },
        serverInstance.getState,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('[surfToDelete]');
    });

    it('resolves effective dataDir from environment variables or /tmp in inline mode', async () => {
      // 1. With A2UI_PANE_DATA
      process.env.A2UI_PANE_DATA = tempDir;
      const res1 = await handleRenderA2ui(
        {
          conversationId: 'env-a2ui-pane-data',
          mode: 'inline',
          messages: [],
        },
        serverInstance.getState,
        serverInstance.catalogs,
      );
      expect(res1.isError).toBeUndefined();

      // 2. With PLUGIN_DATA
      delete process.env.A2UI_PANE_DATA;
      process.env.PLUGIN_DATA = tempDir;
      const res2 = await handleRenderA2ui(
        {
          conversationId: 'env-plugin-data',
          mode: 'inline',
          messages: [],
        },
        serverInstance.getState,
        serverInstance.catalogs,
      );
      expect(res2.isError).toBeUndefined();

      // 3. Fallback to /tmp
      delete process.env.PLUGIN_DATA;
      const res3 = await handleRenderA2ui(
        {
          conversationId: 'env-fallback-tmp',
          mode: 'inline',
          messages: [],
        },
        serverInstance.getState,
        serverInstance.catalogs,
      );
      expect(res3.isError).toBeUndefined();
    });

    it('returns false for isMainModule when argv[1] is undefined or error occurs', () => {
      const originalArgv1 = process.argv[1];
      try {
        (process.argv as any)[1] = undefined;
        expect(isMainModule()).toBe(false);

        // Path that throws in realpathSync
        process.argv[1] = '/nonexistent/path/that/cannot/exist/at/all';
        expect(isMainModule()).toBe(false);
      } finally {
        process.argv[1] = originalArgv1;
      }
    });
  });
});
