import { describe, it, expect, vi } from 'vitest';
import { a2uiDevPlugin } from '../src/dev-server.js';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function createMockReqRes(url: string, method = 'GET') {
  const req: any = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost:5173' };

  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: '',
    setHeader(key: string, val: string) {
      this.headers[key] = val;
    },
    writeHead(code: number, headers: Record<string, string>) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
    },
    write(chunk: string) {
      this.body += chunk;
    },
    end(chunk = '') {
      this.body += chunk;
      this.ended = true;
    },
    ended: false,
  };

  return { req, res };
}

describe('a2uiDevPlugin', () => {
  it('registers vite middleware and handles /preload.js', () => {
    const plugin = a2uiDevPlugin();
    let middleware: any;
    const mockServer: any = {
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    };

    (plugin as any).configureServer(mockServer);
    expect(middleware).toBeDefined();

    const { req, res } = createMockReqRes('/preload.js');
    const next = vi.fn();
    middleware(req, res, next);

    expect(res.ended).toBe(true);
    expect(res.headers['Content-Type']).toBe('application/javascript');
    expect(res.body).toContain('window.sidecar');
    expect(next).not.toHaveBeenCalled();
  });

  it('handles /api/config', () => {
    const plugin = a2uiDevPlugin();
    let middleware: any;
    const mockServer: any = {
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    };
    (plugin as any).configureServer(mockServer);

    const { req, res } = createMockReqRes('/api/config');
    const next = vi.fn();
    middleware(req, res, next);

    expect(res.ended).toBe(true);
    expect(res.headers['Content-Type']).toBe('application/json');
    const data = JSON.parse(res.body);
    expect(data.conversationId).toBe('dev-conversation');
  });

  it('handles /_sidecar/send-message POST requests', () => {
    const plugin = a2uiDevPlugin();
    let middleware: any;
    const mockServer: any = {
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    };
    (plugin as any).configureServer(mockServer);

    const { req, res } = createMockReqRes('/_sidecar/send-message', 'POST');
    const next = vi.fn();
    middleware(req, res, next);

    req.emit('data', JSON.stringify({ message: 'hello agent' }));
    req.emit('end');

    expect(res.ended).toBe(true);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.echo).toContain('hello agent');
  });

  it('handles /api/stream with default lines and cleans up on close', () => {
    vi.useFakeTimers();
    const plugin = a2uiDevPlugin();
    let middleware: any;
    const mockServer: any = {
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    };
    (plugin as any).configureServer(mockServer);

    const { req, res } = createMockReqRes('/api/stream');
    const next = vi.fn();
    middleware(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.body).toContain('event: line');
    expect(res.body).toContain('devSurface');

    // Advance timers for keepalive
    vi.advanceTimersByTime(15000);
    expect(res.body).toContain(': keepalive');

    req.emit('close');
    vi.useRealTimers();
  });

  it('handles /api/stream with custom fixture file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-server-test-'));
    const fixturePath = path.join(tmpDir, 'test.jsonl');
    fs.writeFileSync(fixturePath, JSON.stringify({ seq: 1, message: { custom: true } }) + '\n');

    const plugin = a2uiDevPlugin({ fixturePath });
    let middleware: any;
    const mockServer: any = {
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    };
    (plugin as any).configureServer(mockServer);

    const { req, res } = createMockReqRes('/api/stream');
    middleware(req, res, vi.fn());

    expect(res.body).toContain('custom');

    req.emit('close');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles empty whitespace lines and file watcher triggers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-server-watch-'));
    const fixturePath = path.join(tmpDir, 'test_watch.jsonl');
    fs.writeFileSync(
      fixturePath,
      '   \n\n' + JSON.stringify({ seq: 1, message: { val: 1 } }) + '\n',
    );

    let watchCallback: any;
    const originalWatch = fs.watch;
    (fs as any).watch = (file: string, cb: any) => {
      watchCallback = cb;
      return { close: vi.fn() };
    };

    const plugin = a2uiDevPlugin({ fixturePath });
    let middleware: any;
    (plugin as any).configureServer({
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    });

    const { req, res } = createMockReqRes('/api/stream');
    middleware(req, res, vi.fn());

    expect(res.body).toContain('"val":1');

    // Trigger watch callback
    watchCallback?.();

    req.emit('close');
    fs.watch = originalWatch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ignores malformed line in fixture safely', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-server-bad-'));
    const fixturePath = path.join(tmpDir, 'test_bad.jsonl');
    fs.writeFileSync(
      fixturePath,
      'invalid-json-content\n' + JSON.stringify({ seq: 1, message: { ok: true } }) + '\n',
    );
    const plugin = a2uiDevPlugin({ fixturePath });
    let middleware: any;
    (plugin as any).configureServer({
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    });

    const { req, res } = createMockReqRes('/api/stream');
    middleware(req, res, vi.fn());
    expect(res.body).toContain('"ok":true');
    req.emit('close');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles fs.watch error gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-server-err-'));
    const fixturePath = path.join(tmpDir, 'test_err.jsonl');
    fs.writeFileSync(fixturePath, JSON.stringify({ seq: 1, message: { ok: true } }) + '\n');

    const originalWatch = fs.watch;
    (fs as any).watch = () => {
      throw new Error('Watch failed');
    };

    const plugin = a2uiDevPlugin({ fixturePath });
    let middleware: any;
    (plugin as any).configureServer({
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    });

    const { req, res } = createMockReqRes('/api/stream');
    expect(() => middleware(req, res, vi.fn())).not.toThrow();

    req.emit('close');
    fs.watch = originalWatch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes through unmatched routes via next()', () => {
    const plugin = a2uiDevPlugin();
    let middleware: any;
    const mockServer: any = {
      middlewares: {
        use: (fn: any) => {
          middleware = fn;
        },
      },
    };
    (plugin as any).configureServer(mockServer);

    const { req, res } = createMockReqRes('/some/other/path');
    const next = vi.fn();
    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.ended).toBe(false);
  });
});
