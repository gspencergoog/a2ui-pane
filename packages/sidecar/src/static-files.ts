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

interface CachedAsset {
  content: Buffer;
  mtimeMs: number;
  contentType: string;
}

const staticAssetCache = new Map<string, CachedAsset>();

/**
 * Returns an identifier for the pane build currently served from `staticDir`: the
 * `index.html` mtime in whole milliseconds. It changes whenever the bundle is repackaged,
 * even without a sidecar restart, because it comes from the same `stat` the static cache
 * uses to invalidate. Returns an empty string when `index.html` does not exist.
 */
export function currentBuildId(staticDir: string): string {
  const indexPath = path.resolve(staticDir, 'index.html');
  try {
    return String(Math.round(fs.statSync(indexPath).mtimeMs));
  } catch {
    return '';
  }
}

function readAssetCached(filePath: string, mtimeMs: number, contentType: string): Buffer {
  const cached = staticAssetCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }
  const content = fs.readFileSync(filePath);
  staticAssetCache.set(filePath, { content, mtimeMs, contentType });
  return content;
}

/**
 * Serves static web assets from the pane-app dist directory with in-memory caching.
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

  const stat = fs.existsSync(absoluteTarget) ? fs.statSync(absoluteTarget) : null;
  if (!stat || !stat.isFile()) {
    // Only fall back to index.html for SPA page navigation routes without extensions
    const isPageRoute = !path.extname(relPath);
    if (isPageRoute) {
      const indexFallback = path.resolve(staticDir, 'index.html');
      if (fs.existsSync(indexFallback)) {
        const fallbackStat = fs.statSync(indexFallback);
        const content = readAssetCached(
          indexFallback,
          fallbackStat.mtimeMs,
          'text/html; charset=utf-8',
        );
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
        return true;
      }
    }
    return false;
  }

  const ext = path.extname(absoluteTarget).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = readAssetCached(absoluteTarget, stat.mtimeMs, contentType);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(content);
  return true;
}
