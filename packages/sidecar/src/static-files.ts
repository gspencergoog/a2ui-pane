import { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/**
 * Serves static web assets from the pane-app dist directory.
 * Defends against directory traversal attacks and correctly assigns MIME content-types.
 */
export function serveStaticFile(staticDir: string, pathname: string, res: ServerResponse): boolean {
  if (!fs.existsSync(staticDir)) {
    return false;
  }

  // Never intercept API routes as static files
  if (pathname.startsWith('/api/') || pathname.startsWith('/_sidecar/')) {
    return false;
  }

  // Normalize requested path; root '/' resolves to 'index.html'
  const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const rootDir = path.resolve(staticDir);
  const absoluteTarget = path.resolve(rootDir, relPath);

  // Security check: ensure resolved path is strictly within staticDir
  if (
    !absoluteTarget.startsWith(rootDir + path.sep) &&
    absoluteTarget !== path.join(rootDir, 'index.html') &&
    absoluteTarget !== rootDir
  ) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }

  if (!fs.existsSync(absoluteTarget) || !fs.statSync(absoluteTarget).isFile()) {
    // Only fall back to index.html for SPA page navigation routes without extensions
    const isPageRoute = !path.extname(relPath);
    if (isPageRoute) {
      const indexFallback = path.resolve(staticDir, 'index.html');
      if (fs.existsSync(indexFallback)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(indexFallback));
        return true;
      }
    }
    return false;
  }

  const ext = path.extname(absoluteTarget).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  const content = fs.readFileSync(absoluteTarget);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(content);
  return true;
}
