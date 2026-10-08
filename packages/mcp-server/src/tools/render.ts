import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isValidId } from '@a2ui-pane/protocol';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { ConversationState } from '../conversation-state.js';
import { CatalogRegistry } from '../catalog-registry.js';
import { writeEmbed } from '../embed-writer.js';
import type { ActionEndpoint } from '../action-endpoint.js';

export function readSidecarSendMessageUrl(dataDir: string): string | undefined {
  try {
    const endpointFile = path.join(dataDir, 'sidecar-endpoint.json');
    if (!fs.existsSync(endpointFile)) return undefined;
    const raw = fs.readFileSync(endpointFile, 'utf-8');
    const parsed = JSON.parse(raw) as {
      port?: number;
      uiToken?: string;
      baseUrl?: string;
    };
    if (parsed.baseUrl) {
      const url = new URL(parsed.baseUrl);
      url.pathname = '/_sidecar/send-message';
      if (parsed.uiToken && !url.searchParams.has('token')) {
        url.searchParams.set('token', parsed.uiToken);
      }
      return url.toString();
    }
    if (typeof parsed.port === 'number' && parsed.port > 0) {
      const tokenParam = parsed.uiToken ? `?token=${encodeURIComponent(parsed.uiToken)}` : '';
      return `http://127.0.0.1:${parsed.port}/_sidecar/send-message${tokenParam}`;
    }
  } catch {
    // Ignore malformed or unreadable sidecar-endpoint.json
  }
  return undefined;
}

export const renderA2uiSchema = {
  conversationId: z
    .string()
    .optional()
    .describe(
      'The conversation ID to associate this layout with. Defaults to the active host conversation if omitted.',
    ),
  messages: z
    .union([
      z.array(z.record(z.unknown())),
      z.string().describe('JSON-serialized array of A2UI v0.9 server-to-client layout operations.'),
    ])
    .describe(
      'Array of A2UI v0.9 server-to-client layout operations (or a JSON-encoded string of that array when calling via call_mcp_tool).',
    ),
  mode: z
    .enum(['pane', 'inline'])
    .optional()
    .default('pane')
    .describe(
      'Rendering destination: "pane" (live AuxPane side panel) or "inline" (embedded interactive chat card).',
    ),
};

export type ConversationStateFactory = (conversationId: string) => ConversationState;

export async function handleRenderA2ui(
  args: {
    conversationId?: string;
    messages: unknown[] | string;
    mode?: 'pane' | 'inline';
  },
  getState: ConversationStateFactory,
  catalogs?: CatalogRegistry,
  dataDir?: string,
  actionEndpoint?: ActionEndpoint,
) {
  let parsedMessages: unknown[];
  if (typeof args.messages === 'string') {
    try {
      const parsed = JSON.parse(args.messages);
      if (!Array.isArray(parsed)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'Invalid messages string: JSON must decode to an array of A2UI messages.',
            },
          ],
        };
      }
      parsedMessages = parsed;
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Malformed messages JSON string: ${err?.message || err}`,
          },
        ],
      };
    }
  } else {
    parsedMessages = args.messages;
  }

  const hostConvId = process.env.ANTIGRAVITY_CONVERSATION_ID;
  const conversationId = args.conversationId || hostConvId || '';

  if (!conversationId) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: 'Missing required conversationId. Specify conversationId or run within an active host session.',
        },
      ],
    };
  }

  // Enforce trust boundary: prevent modifying external conversations when host environment specifies active ID
  if (hostConvId && args.conversationId && args.conversationId !== hostConvId) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Unauthorized conversationId '${args.conversationId}'. Operations are restricted to the active conversation '${hostConvId}'.`,
        },
      ],
    };
  }

  if (!isValidId(conversationId)) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `Invalid conversationId '${conversationId}'. ID must match ^[A-Za-z0-9_-]{1,128}$.`,
        },
      ],
    };
  }

  // 1. INLINE MODE: Standalone self-contained card
  if (args.mode === 'inline') {
    const catalogList = catalogs ? catalogs.list() : [];
    const freshProcessor = new MessageProcessor(catalogList, () => {}, {
      validationConfig: {
        allowUnknownElements: false,
        allowOrphanComponents: false,
        allowDanglingReferences: false,
        allowMissingRoot: false,
      },
    });

    const surfaceIds = new Set<string>();
    for (let i = 0; i < parsedMessages.length; i++) {
      const msg = parsedMessages[i] as Record<string, unknown>;
      const sid =
        (msg.createSurface as any)?.surfaceId ??
        (msg.updateComponents as any)?.surfaceId ??
        (msg.updateDataModel as any)?.surfaceId ??
        (msg.deleteSurface as any)?.surfaceId;
      if (sid !== undefined) {
        if (typeof sid !== 'string' || !isValidId(sid)) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Invalid surfaceId '${String(sid)}'. ID must match ^[A-Za-z0-9_-]{1,128}$.`,
              },
            ],
          };
        }
        surfaceIds.add(sid);
      }

      try {
        const versionedMsg = !msg.version ? { version: 'v0.9', ...msg } : msg;
        freshProcessor.processMessages([versionedMsg as any]);
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `A2UI Inline Validation Failed at Message #${i + 1}: ${err?.message || err}`,
            },
          ],
        };
      }
    }

    const effectiveDataDir =
      dataDir || process.env.A2UI_PANE_DATA || process.env.PLUGIN_DATA || '/tmp';
    const surfaceIdList = Array.from(surfaceIds);

    let actionConfig:
      | {
          port?: number;
          key?: string;
          surfaceId: string;
          conversationId?: string;
          sidecarUrl?: string;
        }
      | undefined;

    if (surfaceIdList.length > 0) {
      const primarySurface = surfaceIdList[0];
      const sidecarUrl = readSidecarSendMessageUrl(effectiveDataDir);
      const hasActionEndpoint = Boolean(actionEndpoint && actionEndpoint.getPort() > 0);
      if (hasActionEndpoint || sidecarUrl) {
        const key = hasActionEndpoint
          ? actionEndpoint!.registerEmbed(conversationId, primarySurface)
          : undefined;
        actionConfig = {
          port: hasActionEndpoint ? actionEndpoint!.getPort() : undefined,
          key,
          surfaceId: primarySurface,
          conversationId: sidecarUrl ? conversationId : undefined,
          sidecarUrl,
        };
      }
    }

    const embedPath = writeEmbed(effectiveDataDir, conversationId, surfaceIdList, parsedMessages, {
      actionConfig,
    });

    const surfacesText =
      surfaceIdList.length > 0 ? `surface(s) [${surfaceIdList.join(', ')}]` : 'surfaces';

    return {
      content: [
        {
          type: 'text' as const,
          text: `Rendered inline A2UI card with ${parsedMessages.length} message(s) to ${surfacesText}.\n<agent-embed src="file://${embedPath}"></agent-embed>`,
        },
      ],
    };
  }

  // 2. PANE MODE: Persistent live AuxPane state
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const state = getState(conversationId);

  const result = await state.apply(parsedMessages, callId);

  if (!result.ok) {
    const errorLines = result.issues.map(
      (iss) => `• Message #${iss.messageIndex + 1}: ${iss.message}`,
    );
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: `A2UI Validation Failed (${result.issues.length} issue(s)):\n${errorLines.join('\n')}\n\nPlease correct the layout messages and try again.`,
        },
      ],
    };
  }

  const surfacesText =
    result.surfaceIds.length > 0 ? `surface(s) [${result.surfaceIds.join(', ')}]` : 'surfaces';

  return {
    content: [
      {
        type: 'text' as const,
        text: `Rendered ${parsedMessages.length} message(s) to ${surfacesText} in the A2UI pane.\nThe live surface is visible in the A2UI side panel.`,
      },
    ],
  };
}
