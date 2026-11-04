import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChangeNotifier, conversationIdForPath } from '../src/change-notifier.js';
import { SurfaceStore } from '@a2ui-pane/protocol/store-fs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ChangeNotifier', () => {
  let tmpDir: string;
  let convDir: string;
  let notifier: ChangeNotifier;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'change-notifier-test-'));
    convDir = path.join(tmpDir, 'conversations');
    fs.mkdirSync(convDir, { recursive: true });
    // Use fast poll interval for testing
    notifier = new ChangeNotifier(tmpDir, 50);
  });

  afterEach(() => {
    notifier.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects invalid conversationId', () => {
    expect(() => notifier.subscribe('../bad', () => {})).toThrow('Invalid conversationId');
  });

  it('notifies subscriber when conversation file changes', async () => {
    const convId = 'conv_watch';
    const filePath = path.join(convDir, `${convId}.jsonl`);
    fs.writeFileSync(filePath, 'init\n');

    let changed = false;
    const unsubscribe = notifier.subscribe(convId, () => {
      changed = true;
    });

    // Append to file
    fs.appendFileSync(filePath, 'update\n');

    // Wait for event or poll notification
    const result = await notifier.waitForChange(convId, 1000);
    expect(result).toBe(true);
    expect(changed).toBe(true);

    unsubscribe();
  });

  it('notifies the conversation when a file in its subdirectory changes', async () => {
    const convId = 'conv_subdir';
    fs.mkdirSync(path.join(convDir, convId), { recursive: true });
    const changed = notifier.waitForChange(convId, 2000);
    fs.writeFileSync(path.join(convDir, convId, 'surface-1.jsonl'), '{}\n');
    expect(await changed).toBe(true);
  });

  it('notifies through a SurfaceStore commit', async () => {
    const changed = notifier.waitForChange('conv_commit', 2000);
    new SurfaceStore(tmpDir).commit('conv_commit', 'c1', [
      { version: '1.0', createSurface: { surfaceId: 'main', catalogId: 'basic' } },
    ]);
    expect(await changed).toBe(true);
  });

  it('maps watcher paths to conversation ids', () => {
    expect(conversationIdForPath('conv-1/main.jsonl')).toBe('conv-1');
    expect(conversationIdForPath('conv-1/_seq')).toBe('conv-1');
    expect(conversationIdForPath(path.join('conv-1', 'main.jsonl'))).toBe('conv-1');
    expect(conversationIdForPath('conv-1')).toBe('conv-1');
    expect(conversationIdForPath('conv-1.jsonl')).toBe('conv-1');
    expect(conversationIdForPath('conv-1.jsonl.migrated')).toBe('conv-1');
    expect(conversationIdForPath('conv-1/.lock')).toBeUndefined();
    expect(conversationIdForPath('conv-1/.lock.steal')).toBeUndefined();
    expect(conversationIdForPath('conv-1/.main.tmp-123')).toBeUndefined();
    expect(conversationIdForPath('not-jsonl.txt')).toBeUndefined();
    expect(conversationIdForPath('../escape')).toBeUndefined();
  });

  it('polls the _seq generation when the watcher misses a change', async () => {
    const polling = new ChangeNotifier(tmpDir, 20);
    (polling as any).dirWatcher?.close();
    (polling as any).dirWatcher = null;
    const store = new SurfaceStore(tmpDir);
    store.commit('conv_poll', 'c1', [
      { version: '1.0', createSurface: { surfaceId: 'main', catalogId: 'basic' } },
    ]);

    const cb = vi.fn();
    const unsubscribe = polling.subscribe('conv_poll', cb);
    await new Promise((r) => setTimeout(r, 80));
    // The baseline is taken at subscribe time, so an unchanged store is quiet.
    expect(cb).not.toHaveBeenCalled();

    store.deleteSurface('conv_poll', 'main', 'call_pane_dismissed_1');
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1), { timeout: 1000 });

    unsubscribe();
    polling.close();
  });

  it('waitForChange returns false when timeout occurs without change', async () => {
    const result = await notifier.waitForChange('conv_quiet', 100);
    expect(result).toBe(false);
  });

  it('stops polling and cleans up when all listeners unsubscribe', () => {
    const convId = 'conv_unsub';
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const unsub1 = notifier.subscribe(convId, cb1);
    const unsub2 = notifier.subscribe(convId, cb2);

    unsub1();
    unsub2();

    // Triggering notification should not invoke callbacks
    notifier.close();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it('handles listener error safely and ignores non-jsonl file notifications', () => {
    const convId = 'conv_safe_notify';
    const throwingCb = vi.fn(() => {
      throw new Error('Listener error');
    });
    const normalCb = vi.fn();

    const unsub1 = notifier.subscribe(convId, throwingCb);
    const unsub2 = notifier.subscribe(convId, normalCb);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Notify with invalid filename
    (notifier as any).dirWatcher?.emit?.('change', 'rename', 'not-jsonl.txt');

    // Notify with wildcard (null filename)
    (notifier as any).dirWatcher?.emit?.('change', 'change', null);

    // Explicit notify
    (notifier as any).notify(convId);

    expect(throwingCb).toHaveBeenCalled();
    expect(normalCb).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ChangeNotifier] Error in listener'),
      expect.anything(),
    );

    consoleSpy.mockRestore();
    unsub1();
    unsub2();
  });
});
