import { z } from 'zod';
import { isValidId } from '@a2ui-pane/protocol';
import { ConversationState } from '../conversation-state.js';

export const renderA2uiSchema = {
  conversationId: z.string().describe('The conversation ID to associate this layout with.'),
  messages: z
    .array(z.record(z.unknown()))
    .describe('Array of A2UI v0.9 server-to-client layout operations.'),
  mode: z
    .enum(['pane', 'inline'])
    .optional()
    .default('pane')
    .describe(
      'Rendering destination: "pane" (default, live AuxPane) or "inline" (snapshot card in chat).',
    ),
};

export type ConversationStateFactory = (conversationId: string) => ConversationState;

export async function handleRenderA2ui(
  args: {
    conversationId: string;
    messages: unknown[];
    mode?: 'pane' | 'inline';
  },
  getState: ConversationStateFactory,
) {
  const { conversationId, messages, mode = 'pane' } = args;

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

  if (mode === 'inline') {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: 'Inline rendering mode will be enabled in Phase 6.',
        },
      ],
    };
  }

  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const state = getState(conversationId);

  const result = await state.apply(messages, callId);

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
        text: `Rendered ${messages.length} message(s) to ${surfacesText} in the A2UI pane.\nThe live surface is visible in the A2UI side panel.`,
      },
    ],
  };
}
