/**
 * Client-to-server action message as specified in A2UI v0.9.
 */
export interface A2uiActionDetails {
  name: string;
  surfaceId: string;
  sourceComponentId?: string;
  timestamp?: string;
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface A2uiClientActionPayload {
  version: string;
  action: A2uiActionDetails;
  dataModel?: Record<string, unknown>;
}

export interface ActionTextOptions {
  /** Descriptive human-readable label of the triggering control (e.g. Button text). */
  label?: string;
  /** Bound data model included when the surface specifies sendDataModel: true. */
  dataModel?: Record<string, unknown>;
}

/**
 * Formats an A2UI user action into human-readable chat summary text plus
 * machine-readable `<a2ui-action>` JSON envelope.
 */
export function formatActionText(
  action: A2uiActionDetails,
  options: ActionTextOptions = {},
): string {
  const surfaceId = action.surfaceId || 'unknown-surface';
  const safeLabel = options.label
    ? ` "${options.label
        .replace(/[\r\n"]/g, ' ')
        .trim()
        .slice(0, 80)}"`
    : '';
  const actionName = action.name || 'action';

  const summary = `[A2UI] Triggered${safeLabel} (${actionName}) on surface ${surfaceId}.`;

  const payload: A2uiClientActionPayload = {
    version: 'v0.9',
    action: {
      ...action,
      surfaceId,
    },
  };

  if (options.dataModel && typeof options.dataModel === 'object') {
    payload.dataModel = options.dataModel;
  }

  // Escape '<' as '\\u003c' to prevent tag-breaking when dataModel contains '</a2ui-action>'
  const jsonStr = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `${summary}\n<a2ui-action>${jsonStr}</a2ui-action>`;
}

/**
 * Parses an `<a2ui-action>` tag from chat text, if present.
 * Searches all tags in the text until a valid A2UI action payload is found.
 */
export function parseActionText(text: string): A2uiClientActionPayload | null {
  if (!text || typeof text !== 'string') return null;
  const matches = text.matchAll(/<a2ui-action>([\s\S]*?)<\/a2ui-action>/g);
  for (const match of matches) {
    if (!match[1]) continue;
    try {
      const parsed = JSON.parse(match[1]);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.action === 'object' &&
        parsed.action !== null
      ) {
        return parsed as A2uiClientActionPayload;
      }
    } catch {
      // Continue to next match if this tag had malformed JSON
    }
  }
  return null;
}
