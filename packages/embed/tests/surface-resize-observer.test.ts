import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SurfaceResizeObserver } from '../src/surface-resize-observer.js';

describe('SurfaceResizeObserver', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('measures dimensions and dispatches callback when dimensions change', () => {
    const resizeEvents: { height: number; width: number }[] = [];
    const observer = new SurfaceResizeObserver((dims) => {
      resizeEvents.push(dims);
    });

    // Mock document.body dimensions
    Object.defineProperty(document.body, 'scrollHeight', {
      value: 300,
      configurable: true,
    });
    Object.defineProperty(document.body, 'scrollWidth', {
      value: 400,
      configurable: true,
    });

    observer.measureAndDispatch(true);
    expect(resizeEvents).toHaveLength(1);
    expect(resizeEvents[0]).toEqual({ height: 300, width: 400 });

    // Calling again without change should deduplicate (not fire callback)
    observer.measureAndDispatch(false);
    expect(resizeEvents).toHaveLength(1);

    // Change height
    Object.defineProperty(document.body, 'scrollHeight', {
      value: 350,
      configurable: true,
    });
    observer.measureAndDispatch(false);
    expect(resizeEvents).toHaveLength(2);
    expect(resizeEvents[1].height).toBe(350);

    observer.destroy();
  });

  it('ignores measurement when height is 0 or negative', () => {
    const resizeEvents: any[] = [];
    const observer = new SurfaceResizeObserver((dims) => {
      resizeEvents.push(dims);
    });

    Object.defineProperty(document.body, 'scrollHeight', {
      value: 0,
      configurable: true,
    });
    Object.defineProperty(document.body, 'offsetHeight', {
      value: 0,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, 'offsetHeight', {
      value: 0,
      configurable: true,
    });

    observer.measureAndDispatch(true);
    expect(resizeEvents).toHaveLength(0);

    observer.destroy();
  });

  it('handles DOMContentLoaded listener when document.readyState is loading', () => {
    const originalReadyState = document.readyState;
    Object.defineProperty(document, 'readyState', {
      value: 'loading',
      configurable: true,
    });

    const resizeEvents: any[] = [];
    const observer = new SurfaceResizeObserver((dims) => {
      resizeEvents.push(dims);
    });

    Object.defineProperty(document.body, 'scrollHeight', {
      value: 250,
      configurable: true,
    });
    Object.defineProperty(document.body, 'scrollWidth', {
      value: 350,
      configurable: true,
    });

    // Dispatch DOMContentLoaded
    document.dispatchEvent(new Event('DOMContentLoaded'));

    expect(resizeEvents).toHaveLength(1);
    expect(resizeEvents[0]).toEqual({ height: 250, width: 350 });

    observer.destroy();

    Object.defineProperty(document, 'readyState', {
      value: originalReadyState,
      configurable: true,
    });
  });

  it('cleans up DOMContentLoaded listener on destroy before event fires', () => {
    const originalReadyState = document.readyState;
    Object.defineProperty(document, 'readyState', {
      value: 'loading',
      configurable: true,
    });

    const resizeEvents: any[] = [];
    const observer = new SurfaceResizeObserver((dims) => {
      resizeEvents.push(dims);
    });

    // Destroy before DOMContentLoaded fires
    observer.destroy();

    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(resizeEvents).toHaveLength(0);

    Object.defineProperty(document, 'readyState', {
      value: originalReadyState,
      configurable: true,
    });
  });

  it('triggers measurement when window resize event occurs', () => {
    const resizeEvents: any[] = [];
    const observer = new SurfaceResizeObserver((dims) => {
      resizeEvents.push(dims);
    });

    Object.defineProperty(document.body, 'scrollHeight', {
      value: 120,
      configurable: true,
    });
    Object.defineProperty(document.body, 'scrollWidth', {
      value: 220,
      configurable: true,
    });

    window.dispatchEvent(new Event('resize'));
    expect(resizeEvents).toHaveLength(1);
    expect(resizeEvents[0]).toEqual({ height: 120, width: 220 });

    observer.destroy();
  });

  it('triggers measurement via ResizeObserver callback', () => {
    let capturedCallback: (() => void) | undefined;
    class MockResizeObserver {
      constructor(callback: () => void) {
        capturedCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }

    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver as any;

    try {
      const resizeEvents: any[] = [];
      const observer = new SurfaceResizeObserver((dims) => {
        resizeEvents.push(dims);
      });

      Object.defineProperty(document.body, 'scrollHeight', {
        value: 180,
        configurable: true,
      });
      Object.defineProperty(document.body, 'scrollWidth', {
        value: 280,
        configurable: true,
      });

      expect(capturedCallback).toBeDefined();
      capturedCallback?.();

      expect(resizeEvents).toHaveLength(1);
      expect(resizeEvents[0]).toEqual({ height: 180, width: 280 });

      observer.destroy();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('handles environment when ResizeObserver is undefined', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    (globalThis as any).ResizeObserver = undefined;

    try {
      const observer = new SurfaceResizeObserver(() => {});
      observer.destroy();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
