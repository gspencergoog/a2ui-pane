import { ServerResponse } from 'node:http';
import fs from 'node:fs';

export const PRELOAD_SHIM_JS = `// A2UI Pane Preload Shim
(function() {
  if (window.sidecar) return;

  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token') || '';
  const conversationId = urlParams.get('conversationId') || '';

  window.sidecar = {
    agent: {
      sendMessage: async function(message) {
        try {
          const resp = await fetch('./_sidecar/send-message' + (token ? '?token=' + encodeURIComponent(token) : ''), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-sidecar-token': token,
            },
            body: JSON.stringify({
              conversationId: conversationId,
              message: message,
            }),
          });
          if (!resp.ok) {
            const errText = await resp.text();
            throw new Error('Server responded with ' + resp.status + ': ' + errText);
          }
          return await resp.json();
        } catch (err) {
          console.error('[a2ui-pane] Failed to send action message:', err);
          throw err;
        }
      }
    }
  };
})();
`;

let cachedSdkPreload: string | null = null;

export function loadSdkPreload(resolver?: (specifier: string) => string | undefined): string {
  if (cachedSdkPreload !== null && !resolver) return cachedSdkPreload;

  const resolveFn =
    resolver ??
    ((import.meta as any).resolve ? (import.meta as any).resolve.bind(import.meta) : undefined);

  if (resolveFn) {
    try {
      const resolved = resolveFn('sidecar_sdk/preload.js');
      if (resolved && typeof resolved === 'string' && resolved.startsWith('file://')) {
        const filePath = new URL(resolved).pathname;
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (!resolver) cachedSdkPreload = content;
          return content;
        }
      }
    } catch {
      // SDK preload not found
    }
  }

  if (!resolver) cachedSdkPreload = PRELOAD_SHIM_JS;
  return PRELOAD_SHIM_JS;
}

/**
 * Serves /preload.js for the sidecar web client.
 * Uses official host SDK preload.js when available, or provides a robust standalone shim.
 */
export function handlePreload(res: ServerResponse): void {
  const content = loadSdkPreload();
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(content);
}
