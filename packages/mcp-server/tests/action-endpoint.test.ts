import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActionEndpoint } from '../src/action-endpoint.js';

describe('ActionEndpoint', () => {
  let tempDir: string;
  let endpoint: ActionEndpoint;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'a2ui-endpoint-test-'));
  });

  afterEach(async () => {
    if (endpoint) {
      await endpoint.close();
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws error when dataDir is missing', () => {
    expect(() => new ActionEndpoint({ dataDir: '' })).toThrow(
      'ActionEndpoint requires a valid dataDir',
    );
  });

  it('starts loopback server, writes action-port file, and answers CORS preflight', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();
    expect(port).toBeGreaterThan(0);
    expect(endpoint.getPort()).toBe(port);

    const portFile = join(tempDir, 'action-port');
    expect(existsSync(portFile)).toBe(true);
    expect(readFileSync(portFile, 'utf-8')).toBe(String(port));

    // Calling start() again returns the existing port
    expect(await endpoint.start()).toBe(port);

    // OPTIONS preflight
    const optRes = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'OPTIONS',
    });
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(optRes.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
  });

  it('returns 404 for unknown endpoints', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();

    const res = await fetch(`http://127.0.0.1:${port}/unknown-route`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed JSON body', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();

    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json',
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Malformed JSON');
  });

  it('rejects unauthenticated or expired embed keys with 403', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();

    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'invalid-key', action: { name: 'test' } }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Invalid or expired embed key');
  });

  it('rejects missing or invalid action payloads with 400', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();
    const key = endpoint.registerEmbed('conv1', 'surf1');

    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, action: null }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Missing or invalid action payload');
  });

  it('enforces allowedActions whitelist when specified', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();
    const key = endpoint.registerEmbed('conv1', 'surf1', ['submitOrder']);

    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, action: { name: 'unauthorizedAction' } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('not permitted for this embed');
  });

  it('routes action to a waiting awaitAction promise', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();
    const key = endpoint.registerEmbed('conv1', 'surf1');

    // Launch awaitAction in background
    const waitPromise = endpoint.awaitAction('conv1', 'surf1', 10);

    // Dispatch action to /action
    const postRes = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        action: { name: 'submitForm', context: { label: 'Submit Button' } },
        dataModel: { query: 'test' },
      }),
    });

    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.ok).toBe(true);
    expect(postBody.routedTo).toBe('await_action');

    const actionResult = await waitPromise;
    expect(actionResult.status).toBe('received');
    expect(actionResult.surfaceId).toBe('surf1');
    expect(actionResult.action?.name).toBe('submitForm');
    expect(actionResult.dataModel?.query).toBe('test');
  });

  it('times out when awaitAction does not receive an action', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    await endpoint.start();

    // 0.05 seconds timeout
    const result = await endpoint.awaitAction('conv_timeout', 'surf_timeout', 0.05);
    expect(result.status).toBe('timeout');
    expect(result.message).toContain('Timed out waiting for action');
  });

  it('replaces previous awaitAction request for the same surface', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    await endpoint.start();

    const waitPromise1 = endpoint.awaitAction('conv_replace', 'surf_replace', 10);
    const waitPromise2 = endpoint.awaitAction('conv_replace', 'surf_replace', 10);

    const res1 = await waitPromise1;
    expect(res1.status).toBe('timeout');
    expect(res1.message).toBe('Replaced by newer await request');

    await endpoint.close();
    const res2 = await waitPromise2;
    expect(res2.status).toBe('timeout');
  });

  it('routes action to sendActionDirectly when no awaitAction is pending', async () => {
    const received: { convId: string; text: string }[] = [];
    endpoint = new ActionEndpoint({
      dataDir: tempDir,
      sendActionDirectly: async (convId, text) => {
        received.push({ convId, text });
      },
    });
    const port = await endpoint.start();
    const key = endpoint.registerEmbed('conv_direct', 'surf_direct');

    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        action: { name: 'voteUp', context: { label: 'Thumbs Up' } },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routedTo).toBe('agentapi');
    expect(received).toHaveLength(1);
    expect(received[0].convId).toBe('conv_direct');
    expect(received[0].text).toContain('<a2ui-action>');
  });

  it('invokes agentapiExe fallback when sendActionDirectly is omitted', async () => {
    const fakeAgentapi = join(tempDir, 'fake-agentapi.sh');
    writeFileSync(fakeAgentapi, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    endpoint = new ActionEndpoint({
      dataDir: tempDir,
      agentapiExe: fakeAgentapi,
    });
    const port = await endpoint.start();
    const key = endpoint.registerEmbed('conv_agentapi', 'surf_agentapi');

    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        action: { name: 'voteDown' },
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routedTo).toBe('agentapi');
  });

  it('handles agentapi execution failure by returning 500', async () => {
    const failAgentapi = join(tempDir, 'fail-agentapi.sh');
    writeFileSync(failAgentapi, '#!/bin/sh\necho "failure" >&2\nexit 1\n', { mode: 0o755 });

    endpoint = new ActionEndpoint({
      dataDir: tempDir,
      agentapiExe: failAgentapi,
    });
    const port = await endpoint.start();
    const key = endpoint.registerEmbed('conv_fail', 'surf_fail');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        action: { name: 'failingAction' },
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Internal error');
    consoleSpy.mockRestore();
  });

  it('authenticates via X-A2UI-Key header without key in body and prunes expired keys (M9, L2)', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();

    // Register an already-expired key (-100ms TTL)
    const expiredKey = endpoint.registerEmbed('conv_exp', 'surf_exp', undefined, -100);
    const expiredRes = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Key': expiredKey,
      },
      body: JSON.stringify({ action: { name: 'test' } }),
    });
    expect(expiredRes.status).toBe(403);

    // Register another expired key and then a fresh key to trigger sweep in registerEmbed
    endpoint.registerEmbed('conv_exp2', 'surf_exp2', undefined, -100);
    const validKey = endpoint.registerEmbed('conv_hdr', 'surf_hdr');

    const waitPromise = endpoint.awaitAction('conv_hdr', 'surf_hdr', 5);
    const validRes = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Key': validKey,
      },
      body: JSON.stringify({
        action: { name: 'headerAuthenticatedAction' },
      }),
    });
    expect(validRes.status).toBe(200);
    const actionRes = await waitPromise;
    expect(actionRes.action?.name).toBe('headerAuthenticatedAction');
  });

  it('returns 413 when request body exceeds 120KB (M1, M10)', async () => {
    endpoint = new ActionEndpoint({ dataDir: tempDir });
    const port = await endpoint.start();
    const key = endpoint.registerEmbed('conv_big', 'surf_big');

    const oversizedBody = JSON.stringify({
      action: { name: 'huge' },
      dataModel: { blob: 'a'.repeat(130 * 1024) },
    });

    const res = await fetch(`http://127.0.0.1:${port}/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-A2UI-Key': key,
      },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain('Payload Too Large');
  });

  it('forwards action to sidecar /_sidecar/send-message when sidecar-endpoint.json exists', async () => {
    const savedAgentapiExe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    const savedLsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_AGENTAPI_EXE;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;

    const receivedRequests: Array<{ token?: string; body: any }> = [];
    let shouldFail = false;

    const mockSidecar = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/_sidecar/send-message') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          receivedRequests.push({
            token: req.headers['x-sidecar-token'] as string | undefined,
            body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
          });
          if (shouldFail) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'sidecar failure' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => mockSidecar.listen(0, '127.0.0.1', () => resolve()));
    const sidecarPort = (mockSidecar.address() as any).port;

    try {
      writeFileSync(
        join(tempDir, 'sidecar-endpoint.json'),
        JSON.stringify({ port: sidecarPort, uiToken: 'sidecar-secret-token' }),
      );

      endpoint = new ActionEndpoint({ dataDir: tempDir });
      const port = await endpoint.start();
      const key = endpoint.registerEmbed('conv_bridged', 'surf_bridged');

      const res = await fetch(`http://127.0.0.1:${port}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-A2UI-Key': key,
        },
        body: JSON.stringify({
          action: { name: 'submitGrillMe', context: { label: 'Submit Answers' } },
          dataModel: { questions: { q1: { value: 250 } } },
        }),
      });

      expect(res.status).toBe(200);
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0].token).toBe('sidecar-secret-token');
      expect(receivedRequests[0].body.conversationId).toBe('conv_bridged');
      expect(receivedRequests[0].body.message).toContain('submitGrillMe');

      // Verify error propagation when sidecar returns 500
      shouldFail = true;
      const failRes = await fetch(`http://127.0.0.1:${port}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-A2UI-Key': key,
        },
        body: JSON.stringify({
          action: { name: 'submitGrillMe' },
        }),
      });
      expect(failRes.status).toBe(500);
      const failBody = await failRes.json();
      expect(failBody.error).toContain('Sidecar send-message failed (500)');
    } finally {
      await new Promise<void>((resolve) => mockSidecar.close(() => resolve()));
      if (savedAgentapiExe !== undefined) process.env.ANTIGRAVITY_AGENTAPI_EXE = savedAgentapiExe;
      if (savedLsAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = savedLsAddr;
    }
  });
});
