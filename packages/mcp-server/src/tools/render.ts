import { z } from 'zod';
import { isValidId } from '@a2ui-pane/protocol';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { ConversationState } from '../conversation-state.js';
import { CatalogRegistry } from '../catalog-registry.js';
import { writeEmbed } from '../embed-writer.js';

export const renderA2uiSchema = {
  conversationId: z
    .string()
    .optional()
    .describe(
      'The conversation ID to associate this layout with. Defaults to the active host conversation if omitted.',
    ),
  messages: z
    .array(z.record(z.unknown()))
    .describe('Array of A2UI v0.9 server-to-client layout operations.'),
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
    messages: unknown[];
    mode?: 'pane' | 'inline';
  },
  getState: ConversationStateFactory,
  catalogs?: CatalogRegistry,
  dataDir?: string,
) {
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
    for (let i = 0; i < args.messages.length; i++) {
      const msg = args.messages[i] as Record<string, unknown>;
      const sid =
        (msg.createSurface as any)?.surfaceId ||
        (msg.updateComponents as any)?.surfaceId ||
        (msg.updateDataModel as any)?.surfaceId;
      if (sid) surfaceIds.add(sid);

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
    const embedPath = writeEmbed(effectiveDataDir, conversationId, surfaceIdList, args.messages);

    const surfacesText =
      surfaceIdList.length > 0 ? `surface(s) [${surfaceIdList.join(', ')}]` : 'surfaces';

    return {
      content: [
        {
          type: 'text' as const,
          text: `Rendered inline A2UI card with ${args.messages.length} message(s) to ${surfacesText}.\n<agent-embed src="file://${embedPath}"></agent-embed>`,
        },
      ],
    };
  }

  // 2. PANE MODE: Persistent live AuxPane state
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const state = getState(conversationId);

  const result = await state.apply(args.messages, callId);

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
        text: `Rendered ${args.messages.length} message(s) to ${surfacesText} in the A2UI pane.\nThe live surface is visible in the A2UI side panel.`,
      },
    ],
  };
}
