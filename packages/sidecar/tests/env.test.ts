import { describe, it, expect } from 'vitest';
import { readSidecarEnv } from '../src/env.js';

describe('readSidecarEnv', () => {
  it('parses valid environment variables correctly', () => {
    const env = {
      ANTIGRAVITY_SIDECAR_WEB_PORT: '8080',
      ANTIGRAVITY_SIDECAR_UI_TOKEN: 'secret_tok',
      ANTIGRAVITY_CONVERSATION_ID: 'conv_123',
      ANTIGRAVITY_PROJECT_ID: 'proj_abc',
      ANTIGRAVITY_AGENTAPI_EXE: '/opt/bin/agentapi',
      A2UI_PANE_DATA: '/tmp/pane_data',
    };

    const config = readSidecarEnv(env);
    expect(config).toEqual({
      port: 8080,
      uiToken: 'secret_tok',
      conversationId: 'conv_123',
      projectId: 'proj_abc',
      agentapiExe: '/opt/bin/agentapi',
      dataDir: '/tmp/pane_data',
    });
  });

  it('handles optional variables when absent', () => {
    const env = {
      ANTIGRAVITY_SIDECAR_WEB_PORT: '3000',
      A2UI_PANE_DATA: '/data',
    };

    const config = readSidecarEnv(env);
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe('/data');
    expect(config.uiToken).toBeUndefined();
    expect(config.conversationId).toBeUndefined();
    expect(config.projectId).toBeUndefined();
    expect(config.agentapiExe).toBeUndefined();
  });

  it('throws when ANTIGRAVITY_SIDECAR_WEB_PORT is missing', () => {
    expect(() => readSidecarEnv({ A2UI_PANE_DATA: '/data' })).toThrow(
      'Missing required environment variable ANTIGRAVITY_SIDECAR_WEB_PORT',
    );
  });

  it('throws when port is invalid or out of range', () => {
    expect(() =>
      readSidecarEnv({
        ANTIGRAVITY_SIDECAR_WEB_PORT: 'invalid',
        A2UI_PANE_DATA: '/data',
      }),
    ).toThrow('Invalid port number');

    expect(() =>
      readSidecarEnv({
        ANTIGRAVITY_SIDECAR_WEB_PORT: '-1',
        A2UI_PANE_DATA: '/data',
      }),
    ).toThrow('Invalid port number');

    const config0 = readSidecarEnv({
      ANTIGRAVITY_SIDECAR_WEB_PORT: '0',
      A2UI_PANE_DATA: '/data',
    });
    expect(config0.port).toBe(0);

    expect(() =>
      readSidecarEnv({
        ANTIGRAVITY_SIDECAR_WEB_PORT: '70000',
        A2UI_PANE_DATA: '/data',
      }),
    ).toThrow('Invalid port number');
  });

  it('throws when A2UI_PANE_DATA is missing', () => {
    expect(() => readSidecarEnv({ ANTIGRAVITY_SIDECAR_WEB_PORT: '3000' })).toThrow(
      'Missing required environment variable A2UI_PANE_DATA',
    );
  });
});
