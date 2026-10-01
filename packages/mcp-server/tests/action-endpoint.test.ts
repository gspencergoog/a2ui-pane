import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
});
