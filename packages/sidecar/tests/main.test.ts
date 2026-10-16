import { describe, it, expect, vi } from 'vitest';
import * as SidecarIndex from '../src/index.js';
import { isMainModule, resolveSidecarBaseUrl, run } from '../src/main.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('sidecar index and main', () => {
  it('resolves sidecar baseUrl from LanguageServerService/GetSidecars', async () => {
    expect(
      await resolveSidecarBaseUrl({
        port: 39027,
        dataDir: '/tmp',
      }),
    ).toBeUndefined();

    const mockFetchOk = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sidecars: [
          {
            sidecarId: 'a2ui-pane/a2ui-pane',
            webPort: 39027,
            baseUrl: 'https://sidecar.example.com?token=abc',
          },
        ],
      }),
    });

    const url = await resolveSidecarBaseUrl(
      {
        port: 39027,
        lsAddress: 'localhost:5387',
        csrfToken: 'csrf-tok',
        dataDir: '/tmp',
      },
      mockFetchOk as any,
    );
    expect(url).toBe('https://sidecar.example.com?token=abc');

    const mockFetchNotOk = vi.fn().mockResolvedValue({ ok: false });
    expect(
      await resolveSidecarBaseUrl(
        {
          port: 39027,
          lsAddress: 'localhost:5387',
          csrfToken: 'csrf-tok',
          dataDir: '/tmp',
        },
        mockFetchNotOk as any,
      ),
    ).toBeUndefined();

    const mockFetchErr = vi.fn().mockRejectedValue(new Error('net fail'));
    expect(
      await resolveSidecarBaseUrl(
        {
          port: 39027,
          lsAddress: 'localhost:5387',
          csrfToken: 'csrf-tok',
          dataDir: '/tmp',
        },
        mockFetchErr as any,
      ),
    ).toBeUndefined();
  });
  it('exports public functions and classes from index.ts', () => {
    expect(SidecarIndex.createSidecarServer).toBeDefined();
    expect(SidecarIndex.readSidecarEnv).toBeDefined();
    expect(SidecarIndex.checkToken).toBeDefined();
    expect(SidecarIndex.StoreReader).toBeDefined();
    expect(SidecarIndex.ChangeNotifier).toBeDefined();
    expect(SidecarIndex.handleStream).toBeDefined();
    expect(SidecarIndex.handlePreload).toBeDefined();
    expect(SidecarIndex.handleSendMessage).toBeDefined();
    expect(SidecarIndex.serveStaticFile).toBeDefined();
    expect(SidecarIndex.cleanupOldFiles).toBeDefined();
    expect(SidecarIndex.run).toBeDefined();
    expect(SidecarIndex.isMainModule).toBeDefined();
  });

  it('evaluates isMainModule safely', () => {
    const originalArgv = [...process.argv];
    expect(typeof isMainModule()).toBe('boolean');

    process.argv[1] = '';
    expect(isMainModule()).toBe(false);

    process.argv[1] = '/nonexistent/file/path/that/cannot/be/resolved.js';
    expect(isMainModule()).toBe(false);

    process.argv = originalArgv;
  });

  it('runs server startup, reports cleanup, and handles shutdown signal', () => {
    const originalEnv = { ...process.env };
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-main-run-'));
    const oldFile = path.join(tmpDataDir, 'conversations', 'old.jsonl');
    fs.mkdirSync(path.join(tmpDataDir, 'conversations'), { recursive: true });
    fs.writeFileSync(oldFile, 'old line');
    const pastTime = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, pastTime, pastTime);

    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT = '0';
    process.env.A2UI_PANE_DATA = tmpDataDir;

    let capturedCloseCallback: any;
    const closeSpy = vi.spyOn(http.Server.prototype, 'close').mockImplementation(function (
      this: any,
      cb: any,
    ) {
      capturedCloseCallback = cb;
      return this;
    });

    const listenSpy = vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
      this: any,
      _port: any,
      _host: any,
      cb: any,
    ) {
      cb?.();
      return this;
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    run();

    expect(listenSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[a2ui-pane-sidecar] Cleaned up 1 stale files.'),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[a2ui-pane-sidecar] Listening'));
    const endpointFile = path.join(tmpDataDir, 'sidecar-endpoint.json');
    expect(fs.existsSync(endpointFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(endpointFile, 'utf-8'))).toEqual({
      port: 0,
      visibleConversations: {},
    });

    // Trigger SIGTERM listener
    process.emit('SIGTERM');
    expect(fs.existsSync(endpointFile)).toBe(false);
    expect(closeSpy).toHaveBeenCalled();
    capturedCloseCallback?.();
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Trigger SIGINT listener
    process.emit('SIGINT');

    listenSpy.mockRestore();
    closeSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  it('handles startup error when environment is invalid', () => {
    const originalEnv = { ...process.env };
    delete process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    run();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[a2ui-pane-sidecar] Fatal startup error:'),
      expect.anything(),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errSpy.mockRestore();
    process.env = originalEnv;
  });
});
