import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handlePreload, loadSdkPreload, PRELOAD_SHIM_JS } from '../src/preload-route.js';
import { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createMockResponse(): {
  res: ServerResponse;
  getOutput: () => { statusCode: number; headers: Record<string, string>; body: string };
} {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  let body = '';

  const res = {
    writeHead(code: number, hdrs: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    end(chunk?: any) {
      if (chunk) body += chunk.toString('utf-8');
    },
  } as unknown as ServerResponse;

  return {
    res,
    getOutput: () => ({ statusCode, headers, body }),
  };
}

describe('preload-route', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preload-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves preload script with correct content-type header', () => {
    const { res, getOutput } = createMockResponse();
    handlePreload(res);

    const out = getOutput();
    expect(out.statusCode).toBe(200);
    expect(out.headers['Content-Type']).toContain('application/javascript');
    expect(out.body).toContain('window.sidecar');
  });

  it('resolves and reads custom SDK preload file when resolver returns valid file URL', () => {
    const customPreloadFile = path.join(tmpDir, 'custom-preload.js');
    fs.writeFileSync(customPreloadFile, '// Official Host SDK Preload Content');

    const result = loadSdkPreload(() => `file://${customPreloadFile}`);
    expect(result).toBe('// Official Host SDK Preload Content');
  });

  it('falls back to PRELOAD_SHIM_JS when resolver throws or returns missing file', () => {
    const throwingResult = loadSdkPreload(() => {
      throw new Error('Module not found');
    });
    expect(throwingResult).toBe(PRELOAD_SHIM_JS);

    const missingFileResult = loadSdkPreload(() => 'file:///nonexistent/path/preload.js');
    expect(missingFileResult).toBe(PRELOAD_SHIM_JS);

    const nonFileUrlResult = loadSdkPreload(() => 'https://example.com/preload.js');
    expect(nonFileUrlResult).toBe(PRELOAD_SHIM_JS);
  });

  it('caches the preload script when invoked without a custom resolver', () => {
    const first = loadSdkPreload();
    const second = loadSdkPreload();
    expect(first).toBe(second);
    expect(first).toBe(PRELOAD_SHIM_JS);
  });
});
