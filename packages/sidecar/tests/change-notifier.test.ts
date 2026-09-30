import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChangeNotifier } from '../src/change-notifier.js';
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
