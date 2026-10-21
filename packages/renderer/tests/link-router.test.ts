import { describe, it, expect, vi } from 'vitest';
import { openLink, type LinkRouterDeps } from '../src/link-router.js';

function makeDeps(overrides: Partial<LinkRouterDeps> = {}): LinkRouterDeps & {
  open: ReturnType<typeof vi.fn>;
  copy: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn(() => ({}) as Window),
    copy: vi.fn(async () => {}),
    toast: vi.fn(),
    ...overrides,
  } as any;
}

describe('openLink', () => {
  it('opens https links in a new tab with noopener,noreferrer', async () => {
    const deps = makeDeps();
    const result = await openLink(
      { href: 'https://example.com/pr/1', label: 'PR 1', scheme: 'https' },
      deps,
    );
    expect(result).toBe('opened');
    expect(deps.open).toHaveBeenCalledWith(
      'https://example.com/pr/1',
      '_blank',
      'noopener,noreferrer',
    );
    expect(deps.copy).not.toHaveBeenCalled();
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('copies the href when window.open returns null (blocked popup or sandbox)', async () => {
    const deps = makeDeps({ open: vi.fn(() => null) });
    const result = await openLink(
      { href: 'http://example.com/', label: 'x', scheme: 'http' },
      deps,
    );
    expect(result).toBe('copied');
    expect(deps.copy).toHaveBeenCalledWith('http://example.com/');
    expect(deps.toast).toHaveBeenCalledWith('Copied http://example.com/');
  });

  it('copies file:// paths without calling open', async () => {
    const deps = makeDeps();
    const result = await openLink(
      { href: 'file:///tmp/a.md', label: 'notes', scheme: 'file' },
      deps,
    );
    expect(result).toBe('copied');
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.copy).toHaveBeenCalledWith('file:///tmp/a.md');
  });

  it('copies conversation:// links without calling open', async () => {
    const deps = makeDeps();
    const result = await openLink(
      { href: 'conversation://abc-123', label: 'thread', scheme: 'conversation' },
      deps,
    );
    expect(result).toBe('copied');
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.copy).toHaveBeenCalledWith('conversation://abc-123');
  });

  it('includes the href in the toast text', async () => {
    const deps = makeDeps();
    await openLink(
      { href: 'sidecar://a2ui-pane/a2ui-pane/', label: 'pane', scheme: 'sidecar' },
      deps,
    );
    expect(deps.toast).toHaveBeenCalledTimes(1);
    expect(deps.toast.mock.calls[0][0]).toContain('sidecar://a2ui-pane/a2ui-pane/');
  });

  it('returns failed without a toast when copying rejects', async () => {
    const deps = makeDeps({
      copy: vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
    });
    const result = await openLink({ href: 'file:///tmp/a.md', label: 'a', scheme: 'file' }, deps);
    expect(result).toBe('failed');
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('falls back to copying when open throws', async () => {
    const deps = makeDeps({
      open: vi.fn(() => {
        throw new Error('SecurityError');
      }),
    });
    const result = await openLink({ href: 'https://h/', label: 'h', scheme: 'HTTPS' }, deps);
    expect(result).toBe('copied');
    expect(deps.copy).toHaveBeenCalledWith('https://h/');
  });
});
