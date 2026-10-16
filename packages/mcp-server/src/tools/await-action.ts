import { z } from 'zod';
import { isValidId } from '@a2ui-pane/protocol';
import type { ActionEndpoint, AwaitActionResult } from '../action-endpoint.js';

/** Zod parameter schema for the `await_a2ui_action` MCP tool. */
export const awaitA2uiActionSchema = {
  conversationId: z.string().describe('Conversation ID owning the active A2UI surface.'),
  surfaceId: z.string().describe('Surface ID to wait for an action on.'),
  timeoutSeconds: z
    .number()
    .min(1)
    .max(600)
    .optional()
    .describe('Timeout in seconds to wait for user interaction (default: 300).'),
};

/** Input arguments accepted by `handleAwaitA2uiAction`. */
export type AwaitA2uiActionArgs = {
  conversationId: string;
  surfaceId: string;
  timeoutSeconds?: number;
};

/**
 * Waits for a user action on `surfaceId` via the loopback `ActionEndpoint` and returns the payload.
 */
export async function handleAwaitA2uiAction(
  args: AwaitA2uiActionArgs,
  endpoint?: ActionEndpoint,
): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  if (!isValidId(args.conversationId)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Invalid conversationId: "${args.conversationId}". Must be 1-128 chars [a-zA-Z0-9_-].`,
        },
      ],
    };
  }

  if (!isValidId(args.surfaceId)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Invalid surfaceId: "${args.surfaceId}". Must be 1-128 chars [a-zA-Z0-9_-].`,
        },
      ],
    };
  }

  if (!endpoint) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'unavailable',
              message:
                'A2UI action side-channel is not enabled (disabled via A2UI_PANE_SIDE_CHANNEL=0).',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const timeoutSeconds = args.timeoutSeconds ?? 300;
  const result: AwaitActionResult = await endpoint.awaitAction(
    args.conversationId,
    args.surfaceId,
    timeoutSeconds,
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
