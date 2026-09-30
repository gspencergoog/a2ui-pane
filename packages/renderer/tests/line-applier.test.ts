import { describe, it, expect, vi } from 'vitest';
import { LineApplier } from '../src/line-applier.js';
import { StoreLine } from '@a2ui-pane/protocol';
import { createProcessor } from '../src/processor.js';

describe('LineApplier', () => {
  it('sequentially applies valid StoreLines and updates lastAppliedSeq', () => {
    const applier = new LineApplier();

    const lines: StoreLine[] = [
      {
        seq: 1,
        timestamp: new Date().toISOString(),
        callId: 'call_1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf1', catalogId: 'basic' },
        },
      },
      {
        seq: 2,
        timestamp: new Date().toISOString(),
        callId: 'call_1',
        message: {
          version: 'v0.9',
          updateDataModel: {
            surfaceId: 'surf1',
            path: '/greeting',
            value: 'hello',
          },
        },
      },
    ];

    applier.apply(lines);

    expect(applier.getLastAppliedSeq()).toBe(2);
    expect(applier.getErrors()).toHaveLength(0);
    expect(applier.getProcessor().getSurface('surf1')).toBeDefined();
    expect(applier.getProcessor().getSurface('surf1')?.dataModel.get('/greeting')).toBe('hello');
  });

  it('skips duplicate or older sequence numbers', () => {
    const applier = new LineApplier();

    const line1: StoreLine = {
      seq: 5,
      timestamp: new Date().toISOString(),
      callId: 'c1',
      message: {
        version: 'v0.9',
        createSurface: { surfaceId: 'surf5', catalogId: 'basic' },
      },
    };

    applier.apply([line1]);
    expect(applier.getLastAppliedSeq()).toBe(5);

    // Apply seq 4 and seq 5 again
    const oldLines: StoreLine[] = [
      {
        seq: 4,
        timestamp: new Date().toISOString(),
        callId: 'c2',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf4', catalogId: 'basic' },
        },
      },
      {
        seq: 5,
        timestamp: new Date().toISOString(),
        callId: 'c3',
        message: {
          version: 'v0.9',
          updateDataModel: { surfaceId: 'surf5', path: '/val', value: 123 },
        },
      },
    ];

    applier.apply(oldLines);
    expect(applier.getLastAppliedSeq()).toBe(5);
    // surf4 was never created because seq 4 was dropped
    expect(applier.getProcessor().getSurface('surf4')).toBeUndefined();
  });

  it('auto-adds version to message if omitted', () => {
    const applier = new LineApplier();

    const line: StoreLine = {
      seq: 1,
      timestamp: new Date().toISOString(),
      callId: 'c1',
      message: {
        createSurface: { surfaceId: 'surfNoVer', catalogId: 'basic' },
      } as any,
    };

    applier.apply([line]);
    expect(applier.getLastAppliedSeq()).toBe(1);
    expect(applier.getProcessor().getSurface('surfNoVer')).toBeDefined();
  });

  it('records errors for failing lines and continues applying subsequent lines', () => {
    const applier = new LineApplier();

    const lines: StoreLine[] = [
      {
        seq: 1,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'valid1', catalogId: 'basic' },
        },
      },
      {
        seq: 2,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          // Updating non-existent surface causes A2uiStateError
          updateDataModel: {
            surfaceId: 'nonexistent',
            path: '/foo',
            value: 'bar',
          },
        },
      },
      {
        seq: 3,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'valid2', catalogId: 'basic' },
        },
      },
    ];

    applier.apply(lines);

    // seq 1 and 3 should apply, seq 2 failed
    expect(applier.getLastAppliedSeq()).toBe(3);
    const errors = applier.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].seq).toBe(2);
    expect(errors[0].error).toContain('nonexistent');

    expect(applier.getProcessor().getSurface('valid1')).toBeDefined();
    expect(applier.getProcessor().getSurface('valid2')).toBeDefined();

    applier.clearErrors();
    expect(applier.getErrors()).toHaveLength(0);
  });

  it('safely handles empty or non-array inputs', () => {
    const applier = new LineApplier();
    applier.apply([] as any);
    applier.apply(null as any);
    applier.apply([null as any, undefined as any]);
    expect(applier.getLastAppliedSeq()).toBe(0);
  });

  it('resets processor, clears seq and errors, and notifies onReset listeners', () => {
    const applier = new LineApplier();
    const onResetSpy = vi.fn();
    const unsubscribe = applier.onReset(onResetSpy);

    applier.apply([
      {
        seq: 1,
        timestamp: new Date().toISOString(),
        callId: 'c1',
        message: {
          version: 'v0.9',
          createSurface: { surfaceId: 'surfReset', catalogId: 'basic' },
        },
      },
    ]);

    expect(applier.getLastAppliedSeq()).toBe(1);
    expect(applier.getProcessor().getSurface('surfReset')).toBeDefined();

    applier.reset();

    expect(applier.getLastAppliedSeq()).toBe(0);
    expect(applier.getErrors()).toHaveLength(0);
    // After reset, previous surface should no longer exist on the new processor
    expect(applier.getProcessor().getSurface('surfReset')).toBeUndefined();
    expect(onResetSpy).toHaveBeenCalledTimes(1);

    unsubscribe();
    applier.reset();
    expect(onResetSpy).toHaveBeenCalledTimes(1);

    // Test error in listener does not break reset()
    const throwingListener = vi.fn(() => {
      throw new Error('Listener failed');
    });
    applier.onReset(throwingListener);
    expect(() => applier.reset()).not.toThrow();

    // Test processor dispose is called if it exists
    const mockDispose = vi.fn();
    const mockProcessor = {
      dispose: mockDispose,
      processMessages: vi.fn(),
    } as any;
    const disposableApplier = new LineApplier(() => mockProcessor);
    disposableApplier.reset();
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('supports custom processor factory and direct processor instance', () => {
    const customFactory = vi.fn(() => createProcessor());
    const applierWithFactory = new LineApplier(customFactory);
    expect(customFactory).toHaveBeenCalledTimes(1);
    applierWithFactory.reset();
    expect(customFactory).toHaveBeenCalledTimes(2);

    const directProcessor = createProcessor();
    const applierWithDirect = new LineApplier(directProcessor);
    expect(applierWithDirect.getProcessor()).toBe(directProcessor);
  });
});
