import { z } from 'zod';
import { CatalogRegistry } from '../catalog-registry.js';
import { buildPrompt } from '../prompt/build-prompt.js';

export const a2uiInstructionsSchema = {
  catalogIds: z
    .array(z.string())
    .optional()
    .describe(
      'Optional list of catalog IDs or aliases to describe in the prompt. Defaults to all installed catalogs.',
    ),
};

export function handleA2uiInstructions(args: { catalogIds?: string[] }, catalogs: CatalogRegistry) {
  let targetCatalogs = catalogs.listPrimary();
  if (args.catalogIds && args.catalogIds.length > 0) {
    const selected = args.catalogIds
      .map((id) => catalogs.get(id))
      .filter((cat): cat is NonNullable<typeof cat> => !!cat);
    if (selected.length > 0) {
      targetCatalogs = selected;
    }
  }

  const promptText = buildPrompt(targetCatalogs);
  return {
    content: [
      {
        type: 'text' as const,
        text: promptText,
      },
    ],
  };
}
