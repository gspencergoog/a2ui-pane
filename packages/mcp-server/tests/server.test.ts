import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { handleA2uiInstructions } from '../src/tools/instructions.js';
import { handleRenderA2ui } from '../src/tools/render.js';

describe('MCP Server Tools', () => {
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

    it('handles inline mode notice gracefully', async () => {
      const result = await handleRenderA2ui(
        {
          conversationId: 'conv-inline',
          messages: [],
          mode: 'inline',
        },
        serverInstance.getState,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Phase 6');
    });
  });
});
