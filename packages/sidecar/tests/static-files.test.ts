import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { serveStaticFile } from '../src/static-files.js';
import { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createMockResponse(): {
  res: ServerResponse;
  getOutput: () => { statusCode: number; headers: Record<string, string>; body: Buffer };
} {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  const res = {
    writeHead(code: number, hdrs: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    end(chunk?: any) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    },
  } as unknown as ServerResponse;

  return {
    res,
    getOutput: () => ({
      statusCode,
      headers,
      body: Buffer.concat(chunks),
    }),
  };
}

describe('serveStaticFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-files-test-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html>Index</html>');
    fs.writeFileSync(path.join(tmpDir, 'bundle.js'), 'console.log("bundle");');
    fs.writeFileSync(path.join(tmpDir, 'style.css'), 'body { margin: 0; }');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when directory does not exist', () => {
    const { res } = createMockResponse();
    const served = serveStaticFile('/nonexistent-dir', '/', res);
    expect(served).toBe(false);
  });

  it('serves root / as index.html with HTML content-type', () => {
    const { res, getOutput } = createMockResponse();
    const served = serveStaticFile(tmpDir, '/', res);
    expect(served).toBe(true);

    const out = getOutput();
    expect(out.statusCode).toBe(200);
    expect(out.headers['Content-Type']).toContain('text/html');
    expect(out.body.toString('utf-8')).toBe('<html>Index</html>');
  });

  it('serves specific assets with appropriate MIME types', () => {
    const { res: resJs, getOutput: getOutJs } = createMockResponse();
    const servedJs = serveStaticFile(tmpDir, '/bundle.js', resJs);
    expect(servedJs).toBe(true);
    expect(getOutJs().headers['Content-Type']).toContain('application/javascript');

    const { res: resCss, getOutput: getOutCss } = createMockResponse();
    const servedCss = serveStaticFile(tmpDir, '/style.css', resCss);
    expect(servedCss).toBe(true);
    expect(getOutCss().headers['Content-Type']).toContain('text/css');
  });

  it('blocks directory traversal with 403 Forbidden', () => {
    const { res, getOutput } = createMockResponse();
    const served = serveStaticFile(tmpDir, '/../../etc/passwd', res);
    expect(served).toBe(true);
    expect(getOutput().statusCode).toBe(403);
    expect(getOutput().body.toString('utf-8')).toBe('Forbidden');
  });

  it('falls back to index.html for SPA sub-routes', () => {
    const { res, getOutput } = createMockResponse();
    const served = serveStaticFile(tmpDir, '/surfaces/s1', res);
    expect(served).toBe(true);
    expect(getOutput().statusCode).toBe(200);
    expect(getOutput().body.toString('utf-8')).toBe('<html>Index</html>');
  });
});
