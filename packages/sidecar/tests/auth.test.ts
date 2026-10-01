import { describe, it, expect } from 'vitest';
import { checkToken } from '../src/auth.js';
import { IncomingMessage } from 'node:http';

function createMockRequest(
  urlPath: string,
  headers: Record<string, string> = {},
): { req: IncomingMessage; url: URL } {
  const req = {
    headers,
  } as unknown as IncomingMessage;
  const url = new URL(urlPath, 'http://127.0.0.1:8080');
  return { req, url };
}

describe('checkToken', () => {
  it('fails closed when no expected token is configured unless explicitly allowed (M2)', () => {
    const { req, url } = createMockRequest('/api/stream');
    expect(checkToken(req, url, undefined)).toBe(false);
    expect(checkToken(req, url, '')).toBe(false);

    // Allowed when allowUnauthenticated option is true
    expect(checkToken(req, url, undefined, { allowUnauthenticated: true })).toBe(true);

    // Allowed when A2UI_PANE_ALLOW_NO_TOKEN=1
    process.env.A2UI_PANE_ALLOW_NO_TOKEN = '1';
    expect(checkToken(req, url, undefined)).toBe(true);
    delete process.env.A2UI_PANE_ALLOW_NO_TOKEN;

    // Allowed when NODE_ENV=development
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    expect(checkToken(req, url, undefined)).toBe(true);
    process.env.NODE_ENV = prevEnv;
  });

  it('validates matching token from query parameter', () => {
    const { req, url } = createMockRequest('/api/stream?token=my-secret-token');
    expect(checkToken(req, url, 'my-secret-token')).toBe(true);
  });

  it('validates matching token from x-sidecar-token header', () => {
    const { req, url } = createMockRequest('/api/stream', {
      'x-sidecar-token': 'header-token-123',
    });
    expect(checkToken(req, url, 'header-token-123')).toBe(true);
  });

  it('validates matching token from x-token header', () => {
    const { req, url } = createMockRequest('/api/stream', {
      'x-token': 'xtoken-456',
    });
    expect(checkToken(req, url, 'xtoken-456')).toBe(true);
  });

  it('validates matching token from Authorization Bearer header', () => {
    const { req, url } = createMockRequest('/api/stream', {
      authorization: 'Bearer bearer-token-789',
    });
    expect(checkToken(req, url, 'bearer-token-789')).toBe(true);
  });

  it('rejects when token is absent', () => {
    const { req, url } = createMockRequest('/api/stream');
    expect(checkToken(req, url, 'secret')).toBe(false);
  });

  it('rejects when token has mismatched length', () => {
    const { req, url } = createMockRequest('/api/stream?token=short');
    expect(checkToken(req, url, 'longer-secret')).toBe(false);
  });

  it('rejects when token has same length but different content', () => {
    const { req, url } = createMockRequest('/api/stream?token=wrong_token');
    expect(checkToken(req, url, 'right_token')).toBe(false);
  });
});
