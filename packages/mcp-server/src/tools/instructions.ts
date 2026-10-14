import { z } from 'zod';
import { CatalogRegistry } from '../catalog-registry.js';
import { buildPrompt } from '../prompt/build-prompt.js';
import { HOST_RULES } from '../prompt/host-rules.js';
import type { ExpressWorker } from '../express-worker.js';
import type { TemplateRegistry } from '../template-registry.js';

export const a2uiInstructionsSchema = {
  catalogIds: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of catalog IDs or aliases to describe. Only honored by the raw-JSON fallback prompt; the Express prompt always describes the basic catalog.',
    ),
  format: z
    .enum(['express', 'json'])
    .optional()
    .describe(
      'Prompt flavor: "express" (default; A2UI Express authoring contract plus host rules and the template index) or "json" (raw protocol rules for `messages`).',
    ),
};

export interface InstructionsDeps {
  worker?: ExpressWorker;
  templates?: TemplateRegistry;
}

function templateSection(templates?: TemplateRegistry): string {
  const index = templates?.renderIndex() ?? '';
  if (!index) return '';
  return [
    '## 7. Templates',
    '',
    'Render a template with `render_a2ui({ conversationId, template: "<id>", surfaceId, mode, dsl: "<data assignments>" })`.',
    'Provide every data key listed for the template as `$/key = value` statements in `dsl`; later assignments override template defaults. Do not put `surface(...)` in `dsl`; the server emits it from `surfaceId`.',
    'List items are arrays of objects; keys inside `[]` entries are relative bindings used by the template rows.',
    '',
    index,
  ].join('\n');
}

function jsonFallbackPrompt(
  args: { catalogIds?: string[] },
  catalogs: CatalogRegistry,
  reason: string | undefined,
): string {
  let targetCatalogs = catalogs.listPrimary();
  if (args.catalogIds && args.catalogIds.length > 0) {
    const selected = args.catalogIds
      .map((id) => catalogs.get(id))
      .filter((cat): cat is NonNullable<typeof cat> => !!cat);
    if (selected.length > 0) {
      targetCatalogs = selected;
    }
  }
  const header = reason
    ? `> Note: A2UI Express authoring is unavailable on this host (${reason}). Pass raw \`messages\` to render_a2ui.\n\n`
    : '';
  return header + buildPrompt(targetCatalogs);
}

/**
 * Returns the authoring instructions. With a working Express worker this is the
 * catalog-derived Express contract plus host rules and the template index; otherwise
 * the raw JSON protocol rules with a note explaining why.
 */
export async function handleA2uiInstructions(
  args: { catalogIds?: string[]; format?: 'express' | 'json' },
  catalogs: CatalogRegistry,
  deps: InstructionsDeps = {},
) {
  let promptText: string;
  if (args.format === 'json' || !deps.worker) {
    promptText = jsonFallbackPrompt(
      args,
      catalogs,
      args.format === 'json' ? undefined : 'no Python worker configured',
    );
  } else {
    try {
      const expressPrompt = await deps.worker.instructions();
      promptText = [expressPrompt.trim(), HOST_RULES.trim(), templateSection(deps.templates)]
        .filter(Boolean)
        .join('\n\n');
    } catch (err: any) {
      promptText = jsonFallbackPrompt(args, catalogs, err?.message || String(err));
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: promptText,
      },
    ],
  };
}
