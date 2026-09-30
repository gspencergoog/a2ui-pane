import { Catalog } from '@a2ui/web_core/catalog';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rulesPath = join(__dirname, 'protocol-rules.md');

const FALLBACK_RULES = `# A2UI Protocol Rules (v0.9)

A2UI is a declarative, streaming-friendly UI protocol for generating and updating rich interfaces.

## 1. Message Structure
All interactions consist of a sequence of layout operations targeting one or more surfaces.
Each operation object must declare "version": "v0.9" and contain exactly one of:
- createSurface: Initializes a surface (specify surfaceId, catalogId, and optional sendDataModel: true).
- updateComponents: Declares components in a flat array (must include a component with id: "root").
- updateDataModel: Updates bound state values at a JSON pointer path.
- deleteSurface: Destroys a surface.

## 2. Key Hierarchy Rules
1. Root Component: Every surface MUST declare a component with id: "root".
2. Flat Component Array: Components are declared in a flat array. Parent containers (Column, Row, Card) reference children by ID in their children array or child property.
3. Unique IDs: Each component requires a unique non-empty string id.
4. Two-Way Data Binding: Set sendDataModel: true on createSurface to receive the surface data model on user actions.

## 3. Responding to User Actions
When the user clicks a button or triggers an event, an <a2ui-action> user message is sent back into the chat.
Always update the EXISTING surfaceId using updateDataModel or updateComponents rather than creating a new surface.`;

function getRulesText(): string {
  try {
    if (existsSync(rulesPath)) {
      return readFileSync(rulesPath, 'utf-8');
    }
  } catch {
    // ignore
  }
  return FALLBACK_RULES;
}

/**
 * Builds the complete system instruction prompt for agents describing A2UI protocol rules
 * and the specific component schemas available in the registered catalogs.
 */
export function buildPrompt(catalogs: Catalog<any>[]): string {
  const rules = getRulesText().trim();
  let prompt = `${rules}\n\n## 4. Available Component Catalogs\n\n`;

  for (const cat of catalogs) {
    const catalogId = cat.id || 'basic';
    prompt += `### Catalog: \`${catalogId}\`\n\n`;
    if (cat.components && cat.components.size > 0) {
      prompt += 'Available components and properties:\n';
      for (const [name, comp] of cat.components.entries()) {
        const shape = (comp.schema as any)?.shape;
        const propKeys = shape
          ? Object.keys(shape).filter((k) => k !== 'weight' && k !== 'accessibility')
          : [];
        const propsDesc =
          propKeys.length > 0 ? propKeys.map((k) => `\`${k}\``).join(', ') : 'no extra properties';
        prompt += `- **${name}**: ${propsDesc}\n`;
      }
    }
    prompt += '\n';
  }

  return prompt.trim();
}
