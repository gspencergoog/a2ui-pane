import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSidecarServer, SidecarDeps } from '../src/server.js';
import { StoreReader } from '../src/store-reader.js';
import { ChangeNotifier } from '../src/change-notifier.js';
import { serializeStoreLine, StoreLine } from '@a2ui-pane/protocol';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SidecarServer', () => {
  let tmpDir: string;
  let staticDir: string;
  let convDir: string;
  let server: http.Server;
  let port: number;
  let storeReader: StoreReader;
  let notifier: ChangeNotifier;

  const env = {
    port: 0,
    uiToken: 'test-secret-token',
    conversationId: 'default-conv-id',
    projectId: 'test-project',
    agentapiExe: '/bin/fake-agentapi',
    dataDir: '',
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-server-test-'));
    staticDir = path.join(tmpDir, 'pane-app-dist');
    convDir = path.join(tmpDir, 'conversations');
    fs.mkdirSync(staticDir, { recursive: true });
    fs.mkdirSync(convDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<html>Pane App</html>');

    env.dataDir = tmpDir;
    storeReader = new StoreReader(tmpDir);
    notifier = new ChangeNotifier(tmpDir, 50);

    const deps: SidecarDeps = {
      storeReader,
      notifier,
      staticDir,
      keepaliveIntervalMs: 500,
    };

    server = createSidecarServer(env, deps);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    notifier.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const request = async (
    urlPath: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> => {
    const method = options.method || 'GET';
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (method === 'POST' && !headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}${urlPath}`,
        {
          method,
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              body: data,
            });
          });
        },
      );
      req.on('error', reject);
      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  };

  it('handles OPTIONS preflight with 204 and CORS headers', async () => {
    const res = await request('/api/config', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET, POST, OPTIONS');
  });

  it('serves GET /api/health with status ok', async () => {
    const res = await request('/api/health');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe('ok');
    expect(typeof data.uptime).toBe('number');
  });

  it('serves GET /api/config with configured conversationId', async () => {
    const res = await request('/api/config');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.conversationId).toBe('default-conv-id');
    expect(data.projectId).toBe('test-project');
  });

  it('serves GET /preload.js with javascript content type', async () => {
    const res = await request('/preload.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.body).toContain('window.sidecar');
  });

  describe('GET /api/stream', () => {
    it('returns 401 when token is missing or invalid', async () => {
      const res1 = await request('/api/stream');
      expect(res1.status).toBe(401);

      const res2 = await request('/api/stream?token=wrong_token');
      expect(res2.status).toBe(401);
    });

    it('returns 400 when conversationId is invalid', async () => {
      const res = await request('/api/stream?token=test-secret-token&conversationId=../bad/id');
      expect(res.status).toBe(400);
      expect(res.body).toContain('Invalid or missing conversationId');
    });

    it('returns 403 when conversationId mismatches host-configured env.conversationId (M3)', async () => {
      const res = await request('/api/stream?token=test-secret-token&conversationId=other-conv');
      expect(res.status).toBe(403);
      expect(res.body).toContain('Forbidden conversationId');
    });

    it('connects to SSE stream and streams existing lines and keepalives', async () => {
      const convId = 'default-conv-id';
      const convFile = path.join(convDir, `${convId}.jsonl`);

      const line1: StoreLine = {
        seq: 1,
        ts: new Date().toISOString(),
        callId: 'c1',
        message: { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'basic' } },
      };
      fs.writeFileSync(convFile, serializeStoreLine(line1) + '\n');

      return new Promise<void>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${port}/api/stream?token=test-secret-token&conversationId=${convId}`,
          { method: 'GET' },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');

            let buffer = '';
            res.on('data', (chunk) => {
              buffer += chunk.toString('utf-8');
              if (buffer.includes('event: line') && buffer.includes('id: 1')) {
                req.destroy();
                resolve();
              }
            });
            res.on('error', reject);
          },
        );
        req.on('error', (err: any) => {
          if (err.code === 'ECONNRESET') resolve();
          else reject(err);
        });
        req.end();
      });
    });
  });

  describe('POST /_sidecar/send-message', () => {
    it('returns 401 when token is missing or invalid', async () => {
      const res = await request('/_sidecar/send-message', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'default-conv-id', message: 'hello' }),
      });
      expect(res.status).toBe(401);
    });

    it('returns 415 when Content-Type is not application/json (M2)', async () => {
      const res = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ conversationId: 'default-conv-id', message: 'hello' }),
      });
      expect(res.status).toBe(415);
      expect(res.body).toContain('Unsupported Media Type');
    });

    it('returns 400 when payload is malformed JSON', async () => {
      const res = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        body: 'invalid-json',
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain('Malformed JSON');
    });

    it('returns 400 when conversationId is invalid or missing', async () => {
      const res1 = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        body: JSON.stringify({ message: 'hello' }),
      });
      expect(res1.status).toBe(400);

      const res2 = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        body: JSON.stringify({ conversationId: '../bad', message: 'hello' }),
      });
      expect(res2.status).toBe(400);
      expect(res2.body).toContain('Invalid conversationId');
    });

    it('returns 403 when conversationId mismatches env.conversationId (M3)', async () => {
      const res = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'wrong_conv', message: 'hello' }),
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain('Forbidden conversationId');
    });

    it('returns 400 when message is empty or missing', async () => {
      const res = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'default-conv-id', message: '   ' }),
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Missing required 'message'");
    });

    it('successfully invokes agentapi without redundant argv element and returns JSON result (H3, L8)', async () => {
      const mockExecFile = vi.fn((file: any, args: any, _options: any, callback: any) => {
        expect(file).toBe('/bin/fake-agentapi');
        expect(args).toEqual(['send-message', 'default-conv-id', 'clicked button']);
        callback(null, JSON.stringify({ status: 'sent', messageId: 'm123' }), '');
      });

      const customServer = createSidecarServer(env, {
        storeReader,
        notifier,
        staticDir,
        execFileFn: mockExecFile as any,
      });

      let customPort = 0;
      await new Promise<void>((resolve) => {
        customServer.listen(0, '127.0.0.1', () => {
          customPort = (customServer.address() as any).port;
          resolve();
        });
      });

      const res = await new Promise<any>((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${customPort}/_sidecar/send-message?token=test-secret-token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve({ status: r.statusCode, body: data }));
          },
        );
        req.write(
          JSON.stringify({
            conversationId: 'default-conv-id',
            message: 'clicked button',
          }),
        );
        req.end();
      });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed).toEqual({ status: 'sent', messageId: 'm123' });
      expect(mockExecFile).toHaveBeenCalledTimes(1);

      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    });

    it('returns 500 when agentapi execution fails', async () => {
      const mockExecFile = vi.fn((_file: any, _args: any, _options: any, callback: any) => {
        callback(new Error('Agent execution failed'), '', 'Error output');
      });

      const customServer = createSidecarServer(env, {
        storeReader,
        notifier,
        staticDir,
        execFileFn: mockExecFile as any,
      });

      let customPort = 0;
      await new Promise<void>((resolve) => {
        customServer.listen(0, '127.0.0.1', () => {
          customPort = (customServer.address() as any).port;
          resolve();
        });
      });

      const res = await new Promise<any>((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${customPort}/_sidecar/send-message?token=test-secret-token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve({ status: r.statusCode, body: data }));
          },
        );
        req.write(
          JSON.stringify({
            conversationId: 'default-conv-id',
            message: 'failing message',
          }),
        );
        req.end();
      });

      expect(res.status).toBe(500);
      const parsed = JSON.parse(res.body);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('Agent execution failed');

      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    });

    it('returns 413 when payload exceeds 120KB (M1)', async () => {
      const hugeBody = JSON.stringify({
        conversationId: 'default-conv-id',
        message: 'x'.repeat(120 * 1024 + 100),
      });

      const res = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: hugeBody,
      });

      expect(res.status).toBe(413);
      expect(res.body).toContain('Payload Too Large');
    });

    it('handles non-JSON plain text stdout from agentapi', async () => {
      const mockExecFile = vi.fn((_file: any, _args: any, _options: any, callback: any) => {
        callback(null, 'Plain text confirmation', '');
      });

      const customServer = createSidecarServer(env, {
        storeReader,
        notifier,
        staticDir,
        execFileFn: mockExecFile as any,
      });

      let customPort = 0;
      await new Promise<void>((resolve) => {
        customServer.listen(0, '127.0.0.1', () => {
          customPort = (customServer.address() as any).port;
          resolve();
        });
      });

      const res = await new Promise<any>((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${customPort}/_sidecar/send-message?token=test-secret-token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (r) => {
            let data = '';
            r.on('data', (c) => (data += c));
            r.on('end', () => resolve({ status: r.statusCode, body: data }));
          },
        );
        req.write(
          JSON.stringify({
            conversationId: 'default-conv-id',
            message: 'hello',
          }),
        );
        req.end();
      });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed).toEqual({ ok: true, output: 'Plain text confirmation' });

      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    });

    it('invokes agentapi with fallback command when agentapiExe is not configured', async () => {
      const envNoExe = { ...env, agentapiExe: undefined, conversationId: undefined };
      const mockExec = vi.fn((file, args, _opts, cb) => {
        expect(file).toBe('agentapi');
        expect(args).toEqual(['send-message', 'c_no_exe', 'msg']);
        cb(null, JSON.stringify({ ok: true }), '');
      });
      const custom = createSidecarServer(envNoExe, {
        storeReader,
        notifier,
        staticDir,
        execFileFn: mockExec as any,
      });
      let p = 0;
      await new Promise<void>((resolve) => {
        custom.listen(0, '127.0.0.1', () => {
          p = (custom.address() as any).port;
          resolve();
        });
      });
      const res = await new Promise<any>((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${p}/_sidecar/send-message?token=test-secret-token`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (r) => {
            let d = '';
            r.on('data', (c) => (d += c));
            r.on('end', () => resolve({ status: r.statusCode, body: d }));
          },
        );
        req.write(JSON.stringify({ conversationId: 'c_no_exe', message: 'msg' }));
        req.end();
      });
      expect(res.status).toBe(200);
      expect(mockExec).toHaveBeenCalled();
      await new Promise<void>((resolve) => custom.close(() => resolve()));
    });

    it('handles empty stdout from agentapi', async () => {
      const mockExec = vi.fn((_file, _args, _opts, cb) => {
        cb(null, '', '');
      });
      const custom = createSidecarServer(env, {
        storeReader,
        notifier,
        staticDir,
        execFileFn: mockExec as any,
      });
      let p = 0;
      await new Promise<void>((resolve) => {
        custom.listen(0, '127.0.0.1', () => {
          p = (custom.address() as any).port;
          resolve();
        });
      });
      const res = await new Promise<any>((resolve) => {
        const req = http.request(
          `http://127.0.0.1:${p}/_sidecar/send-message?token=test-secret-token`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' } },
          (r) => {
            let d = '';
            r.on('data', (c) => (d += c));
            r.on('end', () => resolve({ status: r.statusCode, body: d }));
          },
        );
        req.write(JSON.stringify({ conversationId: 'default-conv-id', message: 'hello' }));
        req.end();
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
      await new Promise<void>((resolve) => custom.close(() => resolve()));
    });

    it('returns 400 when message is not a string or body is null', async () => {
      const res1 = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'default-conv-id', message: 123 }),
      });
      expect(res1.status).toBe(400);

      const res2 = await request('/_sidecar/send-message?token=test-secret-token', {
        method: 'POST',
        body: 'null',
      });
      expect(res2.status).toBe(400);
    });
  });

  it('exercises preload cache on repeated calls', async () => {
    const res1 = await request('/preload.js');
    const res2 = await request('/preload.js');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body).toBe(res2.body);
  });

  it('serves static files and returns 404 for unhandled paths', async () => {
    const resRoot = await request('/');
    expect(resRoot.status).toBe(200);
    expect(resRoot.body).toBe('<html>Pane App</html>');

    const res404 = await request('/api/unknown-endpoint');
    expect(res404.status).toBe(404);
  });
});
