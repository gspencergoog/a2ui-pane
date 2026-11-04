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

  const age = (target: string, days: number) => {
    const t = (Date.now() - days * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(target, t, t);
  };

  const makeConversation = (name: string, files: Record<string, string>, days: number) => {
    const dir = path.join(convDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, file), content);
      age(path.join(dir, file), days);
    }
    age(dir, days);
    return dir;
  };

  it('removes stale conversation directories and .migrated files', () => {
    const stale = makeConversation('conv-stale', { 'main.jsonl': '{}', _seq: '3' }, 40);
    const fresh = makeConversation('conv-fresh', { 'main.jsonl': '{}', _seq: '1' }, 0);
    const migrated = path.join(convDir, 'conv-stale.jsonl.migrated');
    const recentMigrated = path.join(convDir, 'conv-fresh.jsonl.migrated');
    fs.writeFileSync(migrated, 'old');
    fs.writeFileSync(recentMigrated, 'new');
    age(migrated, 40);

    const result = cleanupOldFiles(tmpDir, 30);
    expect(result).toEqual({ deleted: 2, errors: 0 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(migrated)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(recentMigrated)).toBe(true);
  });

  it('keeps a conversation directory whose newest file is recent', () => {
    const dir = makeConversation('conv-mixed', { 'old.jsonl': '{}', _seq: '9' }, 40);
    fs.writeFileSync(path.join(dir, 'new.jsonl'), '{}');
    age(dir, 40);

    expect(cleanupOldFiles(tmpDir, 30).deleted).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('skips a stale conversation directory that holds a lock', () => {
    const dir = makeConversation('conv-locked', { 'main.jsonl': '{}', '.lock': '1 x' }, 40);

    expect(cleanupOldFiles(tmpDir, 30)).toEqual({ deleted: 0, errors: 0 });
    expect(fs.existsSync(path.join(dir, 'main.jsonl'))).toBe(true);
  });

  it('leaves per-conversation embed directories alone', () => {
    const embedConv = path.join(embedDir, 'conv-embed');
    fs.mkdirSync(embedConv);
    fs.writeFileSync(path.join(embedConv, 'embed_1.html'), 'x');
    age(path.join(embedConv, 'embed_1.html'), 40);
    age(embedConv, 40);

    expect(cleanupOldFiles(tmpDir, 30).deleted).toBe(0);
    expect(fs.existsSync(path.join(embedConv, 'embed_1.html'))).toBe(true);
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
