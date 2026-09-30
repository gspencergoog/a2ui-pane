import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanupOldFiles } from '../src/cleanup.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('cleanupOldFiles', () => {
  let tmpDir: string;
  let convDir: string;
  let embedDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
    convDir = path.join(tmpDir, 'conversations');
    embedDir = path.join(tmpDir, 'embeds');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(embedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes files older than maxAgeDays and retains recent files', () => {
    const oldFile = path.join(convDir, 'old.jsonl');
    const recentFile = path.join(convDir, 'recent.jsonl');
    const oldEmbed = path.join(embedDir, 'old-embed.html');

    fs.writeFileSync(oldFile, 'old content');
    fs.writeFileSync(recentFile, 'recent content');
    fs.writeFileSync(oldEmbed, 'old embed');

    // Set mtime of old files to 40 days ago
    const pastTime = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, pastTime, pastTime);
    fs.utimesSync(oldEmbed, pastTime, pastTime);

    const result = cleanupOldFiles(tmpDir, 30);
    expect(result.deleted).toBe(2);
    expect(result.errors).toBe(0);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(oldEmbed)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it('handles non-existent target directories safely', () => {
    const nonExistentDir = path.join(tmpDir, 'does-not-exist');
    const result = cleanupOldFiles(nonExistentDir, 30);
    expect(result).toEqual({ deleted: 0, errors: 0 });
  });

  it('handles filesystem errors during cleanup safely', () => {
    const oldFile = path.join(convDir, 'stuck.jsonl');
    fs.writeFileSync(oldFile, 'data');
    const pastTime = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, pastTime, pastTime);

    const originalUnlink = fs.unlinkSync;
    (fs as any).unlinkSync = () => {
      throw new Error('Permission denied');
    };

    const originalReaddir = fs.readdirSync;
    let readdirCalled = false;
    (fs as any).readdirSync = (dir: string) => {
      if (dir === embedDir && !readdirCalled) {
        readdirCalled = true;
        throw new Error('EACCES');
      }
      return originalReaddir(dir);
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = cleanupOldFiles(tmpDir, 30);
    expect(result.errors).toBeGreaterThan(0);

    fs.unlinkSync = originalUnlink;
    fs.readdirSync = originalReaddir;
    consoleSpy.mockRestore();
  });
});
