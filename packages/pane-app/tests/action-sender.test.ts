import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ActionSender } from '../src/action-sender.js';
import { A2uiActionDetails, parseActionText } from '@a2ui-pane/protocol';

describe('ActionSender', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('formats action text and calls sendMessageFn successfully', async () => {
    const mockSend = vi.fn().mockResolvedValue({ ok: true });
    const toastSpy = vi.fn();
    const pendingChanges: number[] = [];

    const sender = new ActionSender({
      sendMessageFn: mockSend,
      showToastFn: toastSpy,
      onPendingChange: (set) => pendingChanges.push(set.size),
    });

    const action: A2uiActionDetails = {
      name: 'submitForm',
      surfaceId: 'surf1',
      sourceComponentId: 'btnSubmit',
      context: { label: 'Submit Order', step: 1 },
    };

    const dataModel = { username: 'alice', cartTotal: 50 };

    const success = await sender.sendAction(action, dataModel);
    expect(success).toBe(true);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sentText = mockSend.mock.calls[0][0];

    expect(sentText).toContain('[A2UI] Triggered "Submit Order" (submitForm) on surface surf1.');
    expect(sentText).toContain('<a2ui-action>');

    const parsed = parseActionText(sentText);
    expect(parsed).not.toBeNull();
    expect(parsed?.action.name).toBe('submitForm');
    expect(parsed?.action.surfaceId).toBe('surf1');
    expect(parsed?.dataModel).toEqual(dataModel);

    // Pending set was incremented then decremented back to 0
    expect(pendingChanges).toEqual([1, 0]);
    expect(sender.isPending('btnSubmit')).toBe(false);
  });

  it('prevents concurrent duplicate action dispatch for the same source component', async () => {
    let finishSend: (value: any) => void;
    const sendPromise = new Promise((resolve) => {
      finishSend = resolve;
    });
    const mockSend = vi.fn(() => sendPromise);

    const sender = new ActionSender({
      sendMessageFn: mockSend as any,
    });

    const action: A2uiActionDetails = {
      name: 'click',
      surfaceId: 'surf1',
      sourceComponentId: 'btnUnique',
    };

    // First call starts and stays pending
    const firstCall = sender.sendAction(action);
    expect(sender.isPending('btnUnique')).toBe(true);

    // Immediate second call should be ignored
    const secondCall = await sender.sendAction(action);
    expect(secondCall).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Resolve first call
    finishSend!({ ok: true });
    const firstResult = await firstCall;
    expect(firstResult).toBe(true);
    expect(sender.isPending('btnUnique')).toBe(false);
  });

  it('falls back to simulation mode with toast when sendMessageFn is absent', async () => {
    const toastSpy = vi.fn();
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const sender = new ActionSender({
      showToastFn: toastSpy,
    });

    const action: A2uiActionDetails = {
      name: 'standaloneClick',
      surfaceId: 'surfStandalone',
      sourceComponentId: 'btnStand',
    };

    const result = await sender.sendAction(action);
    expect(result).toBe(true);
    expect(toastSpy).toHaveBeenCalledWith('Action dispatched (standalone mode)', false);
    expect(consoleSpy).toHaveBeenCalled();
    expect(sender.isPending('btnStand')).toBe(false);

    consoleSpy.mockRestore();
  });

  it('handles transmission failure, surfaces error toast, and releases control', async () => {
    const mockSend = vi.fn().mockRejectedValue(new Error('Network disconnected'));
    const toastSpy = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sender = new ActionSender({
      sendMessageFn: mockSend,
      showToastFn: toastSpy,
    });

    const action: A2uiActionDetails = {
      name: 'failingAction',
      surfaceId: 'surfErr',
      sourceComponentId: 'btnError',
    };

    const result = await sender.sendAction(action);
    expect(result).toBe(false);
    expect(toastSpy).toHaveBeenCalledWith('Action failed: Network disconnected', true);
    expect(sender.isPending('btnError')).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('provides access to pending components set and uses window.sidecar when available', async () => {
    const mockSend = vi.fn().mockResolvedValue({ ok: true });
    (window as any).sidecar = { agent: { sendMessage: mockSend } };

    const sender = new ActionSender();
    expect(sender.getPendingComponents().size).toBe(0);

    const res = await sender.sendAction({
      name: 'testWindow',
      surfaceId: 's1',
      sourceComponentId: 'btnWin',
    });
    expect(res).toBe(true);
    expect(mockSend).toHaveBeenCalled();

    delete (window as any).sidecar;
  });
});
