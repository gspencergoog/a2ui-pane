import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeEmbed, loadEmbedBundle } from '../src/embed-writer.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('embed-writer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-writer-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates self-contained HTML file in embeds directory', () => {
    const convId = 'conv_embed_test';
    const surfaceIds = ['cardSurface'];
    const messages = [
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'cardSurface', catalogId: 'basic' },
      },
    ];

    const filePath = writeEmbed(tmpDir, convId, surfaceIds, messages, {
      embedBundleJs: '// Custom Bundle Code',
    });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(filePath).toContain(path.join(tmpDir, 'embeds', convId));

    const html = fs.readFileSync(filePath, 'utf-8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>A2UI Embed - cardSurface</title>');
    expect(html).toContain('--a2ui-color-surface:');
    expect(html).toContain('<div id="a2ui-embed-root"></div>');
    expect(html).toContain('// Custom Bundle Code');
    expect(html).toContain('"surfaceId":"cardSurface"');
  });

  it('escapes < and > to prevent script tag injection breakout', () => {
    const convId = 'conv_security';
    const hostileMessage = {
      version: 'v0.9',
      updateDataModel: {
        surfaceId: 'surfMal',
        path: '/text',
        value: '</script><script>alert("hacked")</script>',
      },
    };

    const filePath = writeEmbed(tmpDir, convId, ['surfMal'], [hostileMessage]);
    const html = fs.readFileSync(filePath, 'utf-8');

    // Verify < and > are sanitized inside the script block
    expect(html).not.toContain('</script><script>alert("hacked")</script>');
    expect(html).toContain(
      '\\u003c/script\\u003e\\u003cscript\\u003ealert(\\"hacked\\")\\u003c/script\\u003e',
    );
  });

  it('rejects invalid conversationId with directory traversal', () => {
    expect(() => writeEmbed(tmpDir, '../bad_conv', ['s1'], [])).toThrow('Invalid conversationId');
  });

  it('loads embed bundle from custom path or returns fallback stub', () => {
    const customBundle = path.join(tmpDir, 'custom.js');
    fs.writeFileSync(customBundle, 'console.log("custom bundle");');

    const content = loadEmbedBundle(customBundle);
    expect(content).toBe('console.log("custom bundle");');

    const fallback = loadEmbedBundle('/nonexistent/bundle.js');
    expect(fallback).toContain('console.warn');

    // Test writeEmbed with embedBundlePath option
    const writtenPath = writeEmbed(tmpDir, 'conv_custom', ['s1'], [], {
      embedBundlePath: customBundle,
    });
    const html = fs.readFileSync(writtenPath, 'utf-8');
    expect(html).toContain('console.log("custom bundle");');
  });
});
