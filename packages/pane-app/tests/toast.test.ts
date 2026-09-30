import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast } from '../src/toast.js';

describe('showToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const existing = document.getElementById('a2ui-toast-container');
    if (existing) existing.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
    const existing = document.getElementById('a2ui-toast-container');
    if (existing) existing.remove();
  });

  it('creates container and renders error toast by default', () => {
    const toast = showToast('Operation failed', true, 2000);
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toBe('Operation failed');

    const container = document.getElementById('a2ui-toast-container');
    expect(container).not.toBeNull();
    expect(container?.contains(toast!)).toBe(true);

    // Fast-forward past duration
    vi.advanceTimersByTime(2000);
    expect(toast?.style.opacity).toBe('0');

    // Fast-forward past fadeout transition
    vi.advanceTimersByTime(250);
    expect(container?.contains(toast!)).toBe(false);
  });

  it('renders success/info toast with distinct styling and reuses container', () => {
    const toast1 = showToast('First message', false, 1000);
    const toast2 = showToast('Second message', true, 1000);

    const container = document.getElementById('a2ui-toast-container');
    expect(container?.children.length).toBe(2);
    expect(toast1?.style.backgroundColor).toBe('#dcffe4');
    expect(toast2?.style.backgroundColor).toBe('#ffeef0');
  });
});
