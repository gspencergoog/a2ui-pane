import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isValidId } from '@a2ui-pane/protocol';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import { ConversationState } from '../conversation-state.js';
import { CatalogRegistry } from '../catalog-registry.js';
import { writeEmbed } from '../embed-writer.js';
import type { ActionEndpoint } from '../action-endpoint.js';
import {
  ExpressWorker,
  ExpressWorkerError,
  ExpressWorkerUnavailableError,
} from '../express-worker.js';
import type { TemplateRegistry } from '../template-registry.js';

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

export function isPaneVisibleForConversation(dataDir: string, conversationId: string): boolean {
  try {
    const endpointFile = path.join(dataDir, 'sidecar-endpoint.json');
    if (!fs.existsSync(endpointFile)) return false;
    const parsed = JSON.parse(fs.readFileSync(endpointFile, 'utf-8')) as {
      visibleConversations?: Record<string, boolean>;
    };
    return parsed.visibleConversations?.[conversationId] === true;
  } catch {
    return false;
  }
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
    .optional()
    .describe(
      'Raw A2UI server-to-client layout operations (array, or a JSON-encoded string when calling via call_mcp_tool). Prefer `dsl` or `template`.',
    ),
  dsl: z
    .string()
    .optional()
    .describe(
      'A2UI Express source. Compiled and validated server-side. With `template`, these statements are appended after the template body (data assignments override template defaults).',
    ),
  template: z
    .string()
    .optional()
    .describe(
      'Template id from the registry (see a2ui_instructions). Inflated with `surfaceId`, then `dsl` is appended.',
    ),
  surfaceId: z
    .string()
    .optional()
    .describe(
      'Surface id used by `template` and by `dsl` blocks that have no surface(...) statement. Defaults to "main".',
    ),
  replace: z
    .boolean()
    .optional()
    .describe(
      'When true, surfaces that this batch re-creates are deleted first instead of failing with "Surface already exists".',
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

export interface RenderA2uiArgs {
  conversationId?: string;
  messages?: unknown[] | string;
  dsl?: string;
  template?: string;
  surfaceId?: string;
  replace?: boolean;
  mode?: 'pane' | 'inline';
}

export interface RenderA2uiDeps {
  worker?: ExpressWorker;
  templates?: TemplateRegistry;
}

type ToolResult = { isError?: true; content: Array<{ type: 'text'; text: string }> };

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function parseRawMessages(messages: unknown[] | string): unknown[] | ToolResult {
  if (typeof messages !== 'string') return messages;
  try {
    const parsed = JSON.parse(messages);
    if (!Array.isArray(parsed)) {
      return errorResult('Invalid messages string: JSON must decode to an array of A2UI messages.');
    }
    return parsed;
  } catch (err: any) {
    return errorResult(`Malformed messages JSON string: ${err?.message || err}`);
  }
}

function formatCompileError(err: ExpressWorkerError, source: string): string {
  const { line, column, message, kind } = err.detail;
  const where =
    line !== undefined ? ` at line ${line}${column !== undefined ? `, column ${column}` : ''}` : '';
  const lines = source.split(/\r?\n/);
  const excerpt =
    line !== undefined && line >= 1 && line <= lines.length ? `\n> ${lines[line - 1]}` : '';
  return `Express ${kind}${where}: ${message}${excerpt}\n\nFix the Express source and retry, or pass raw \`messages\` instead.`;
}

/**
 * Turns the authoring input (`messages`, `dsl`, or `template` + `dsl`) into protocol messages.
 * Returns a tool error result when the input is invalid or the Express worker is unavailable.
 */
export async function resolveMessages(
  args: RenderA2uiArgs,
  deps: RenderA2uiDeps,
): Promise<{ messages: unknown[]; authored: 'messages' | 'dsl' | 'template' } | ToolResult> {
  const hasMessages = args.messages !== undefined;
  const hasDsl = typeof args.dsl === 'string' && args.dsl.trim().length > 0;
  const hasTemplate = typeof args.template === 'string' && args.template.length > 0;

  if (hasMessages && (hasDsl || hasTemplate)) {
    return errorResult('Pass either `messages` or `dsl`/`template`, not both.');
  }
  if (!hasMessages && !hasDsl && !hasTemplate) {
    return errorResult(
      'Missing authoring input: pass `dsl`, `template` (optionally with `dsl`), or `messages`.',
    );
  }

  if (hasMessages) {
    const parsed = parseRawMessages(args.messages as unknown[] | string);
    if (!Array.isArray(parsed)) return parsed;
    return { messages: parsed, authored: 'messages' };
  }

  const surfaceId = args.surfaceId || 'main';
  if (!isValidId(surfaceId)) {
    return errorResult(`Invalid surfaceId '${surfaceId}'. ID must match ^[A-Za-z0-9_-]{1,128}$.`);
  }

  let source: string;
  if (hasTemplate) {
    if (!deps.templates) {
      return errorResult(
        'Template rendering is not configured on this server; pass `dsl` or `messages`.',
      );
    }
    try {
      source = deps.templates.inflate(args.template as string, surfaceId, { callerDsl: args.dsl });
    } catch (err: any) {
      return errorResult(String(err?.message || err));
    }
  } else {
    source = args.dsl as string;
  }

  if (!deps.worker) {
    return errorResult(
      'Express compilation is not configured on this server (no Python worker); pass raw `messages` instead.',
    );
  }

  try {
    const compiled = await deps.worker.compile(source, surfaceId);
    return { messages: compiled, authored: hasTemplate ? 'template' : 'dsl' };
  } catch (err: any) {
    if (err instanceof ExpressWorkerError) {
      return errorResult(formatCompileError(err, source));
    }
    if (err instanceof ExpressWorkerUnavailableError) {
      return errorResult(
        `Express compiler unavailable: ${err.message}. Pass raw \`messages\` instead, or reinstall the plugin (scripts/install.sh) to repair the Python worker.`,
      );
    }
    return errorResult(`Express compilation failed: ${err?.message || err}`);
  }
}

/** Collects surface ids created by a batch (used by `replace`). */
export function createdSurfaceIds(messages: unknown[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    const sid = (msg as Record<string, any>)?.createSurface?.surfaceId;
    if (typeof sid === 'string' && !ids.includes(sid)) ids.push(sid);
  }
  return ids;
}

export async function handleRenderA2ui(
  args: RenderA2uiArgs,
  getState: ConversationStateFactory,
  catalogs?: CatalogRegistry,
  dataDir?: string,
  actionEndpoint?: ActionEndpoint,
  deps: RenderA2uiDeps = {},
) {
  const resolved = await resolveMessages(args, deps);
  if (!('messages' in resolved) || !Array.isArray(resolved.messages)) {
    return resolved as ToolResult;
  }
  const parsedMessages = resolved.messages;

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

  let batch = parsedMessages;
  if (args.replace) {
    const existing = createdSurfaceIds(parsedMessages).filter((sid) => state.hasSurface(sid));
    if (existing.length > 0) {
      batch = [
        ...existing.map((sid) => ({ version: 'v0.9', deleteSurface: { surfaceId: sid } })),
        ...parsedMessages,
      ];
    }
  }

  const result = await state.apply(batch, callId);

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
  const effectiveDataDir =
    dataDir || process.env.A2UI_PANE_DATA || process.env.PLUGIN_DATA || '/tmp';
  const isVisible = isPaneVisibleForConversation(effectiveDataDir, conversationId);
  const visibilityNote = isVisible
    ? 'The live surface is visible in the open A2UI side panel. Always include [A2UI Pane](sidecar://a2ui-pane/a2ui-pane/) in your response so the user sees an inline button indicating that the pane was updated and can focus it in one click.'
    : 'The A2UI side panel is currently closed. Always include [A2UI Pane](sidecar://a2ui-pane/a2ui-pane/) in your response so the user sees an inline button indicating that the pane was updated and can open it in one click.';

  const authoredNote =
    resolved.authored === 'messages' ? '' : ` (compiled from Express ${resolved.authored})`;
  return {
    content: [
      {
        type: 'text' as const,
        text: `Rendered ${parsedMessages.length} message(s) to ${surfacesText} in the A2UI pane${authoredNote}.\n${visibilityNote}`,
      },
    ],
  };
}
