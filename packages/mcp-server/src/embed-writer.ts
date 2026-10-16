import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isValidId } from '@a2ui-pane/protocol';
import { HOST_THEME_CSS } from '@a2ui-pane/theme';

/** Options for generating a self-contained inline embed HTML document. */
export interface EmbedWriterOptions {
  embedBundleJs?: string;
  embedBundlePath?: string;
  actionConfig?: {
    port?: number;
    key?: string;
    surfaceId: string;
    conversationId?: string;
    sidecarUrl?: string;
    targetOrigin?: string;
  };
}

let cachedBundleContent: string | null = null;
let cachedBundleMtimeMs = 0;

/**
 * Loads and caches the compiled `embed.iife.js` runtime bundle from disk.
 */
export function loadEmbedBundle(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return fs.readFileSync(customPath, 'utf-8');
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    path.resolve(here, 'embed.iife.js'),
    path.resolve(here, '../../embed/dist/embed.iife.js'),
    path.resolve(here, '../../../packages/embed/dist/embed.iife.js'),
  ];

  for (const cand of candidatePaths) {
    if (fs.existsSync(cand)) {
      const mtimeMs = fs.statSync(cand).mtimeMs;
      if (cachedBundleContent && mtimeMs === cachedBundleMtimeMs) {
        return cachedBundleContent;
      }
      cachedBundleContent = fs.readFileSync(cand, 'utf-8');
      cachedBundleMtimeMs = mtimeMs;
      return cachedBundleContent;
    }
  }

  return 'console.warn("[a2ui-embed] Embed IIFE bundle not found.");';
}

function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generates an isolated, self-contained HTML page embedding the A2UI IIFE runtime,
 * host theme CSS, and sanitized initial layout messages.
 * Escapes '<' to '\u003c' and '>' to '\u003e' to defend against script breakout vulnerabilities.
 */
export function writeEmbed(
  dataDir: string,
  conversationId: string,
  surfaceIds: string[],
  messages: unknown[],
  options: EmbedWriterOptions = {},
): string {
  if (!isValidId(conversationId)) {
    throw new Error(`Invalid conversationId: ${conversationId}`);
  }

  for (const sid of surfaceIds) {
    if (!isValidId(sid)) {
      throw new Error(`Invalid surfaceId: ${sid}`);
    }
  }

  const embedDir = path.join(dataDir, 'embeds', conversationId);
  fs.mkdirSync(embedDir, { recursive: true, mode: 0o700 });

  const randomSuffix = crypto.randomBytes(8).toString('hex');
  const primarySurface = surfaceIds[0] || 'surface';
  const fileName = `embed_${primarySurface}_${Date.now()}_${randomSuffix}.html`;
  const filePath = path.resolve(embedDir, fileName);

  const bundleJs =
    options.embedBundleJs ??
    (options.embedBundlePath ? loadEmbedBundle(options.embedBundlePath) : loadEmbedBundle());

  // Escape < and > to prevent script tag injection breakout
  const sanitizedMessagesJson = escapeJsonForScript(messages);
  const sanitizedActionConfigJson = options.actionConfig
    ? escapeJsonForScript(options.actionConfig)
    : null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>A2UI Embed - ${escapeHtml(primarySurface)}</title>
  <style>
${HOST_THEME_CSS}
  </style>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
      background: transparent;
      color: var(--a2ui-text-color-text, var(--foreground, #24292f));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    #a2ui-embed-root {
      width: 100%;
      display: flex;
      flex-direction: column;
    }
    #a2ui-embed-root a2ui-pane-view {
      height: auto;
      overflow: visible;
    }
  </style>
</head>
<body>
  <div id="a2ui-embed-root"></div>
  <script id="a2ui-messages" type="application/json">
${sanitizedMessagesJson}
  </script>
${
  sanitizedActionConfigJson
    ? `  <script id="a2ui-action-config" type="application/json">
${sanitizedActionConfigJson}
  </script>\n`
    : ''
}  <script>
${bundleJs}
  </script>
</body>
</html>
`;

  fs.writeFileSync(filePath, html, { mode: 0o600 });
  return filePath;
}
