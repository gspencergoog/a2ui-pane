import { describe, it, expect } from 'vitest';
import { HOST_THEME_CSS, injectHostTheme } from '../src/index.js';

describe('Theme module', () => {
  it('defines required A2UI variables in HOST_THEME_CSS', () => {
    expect(HOST_THEME_CSS).toContain('--a2ui-color-surface:');
    expect(HOST_THEME_CSS).toContain('--a2ui-color-primary:');
    expect(HOST_THEME_CSS).toContain('--a2ui-color-border:');
    expect(HOST_THEME_CSS).toContain('--a2ui-text-color-text:');
    expect(HOST_THEME_CSS).toContain('--a2ui-color-on-primary:');
    expect(HOST_THEME_CSS).toContain('--a2ui-spacing-m:');
    expect(HOST_THEME_CSS).toContain('--a2ui-choicepicker-chip-font-size: 13px;');
    expect(HOST_THEME_CSS).toContain('#a2ui-embed-root');
    expect(HOST_THEME_CSS).toContain('@media (prefers-color-scheme: dark)');
  });

  it('injects style tag into document head', () => {
    const fakeHead = {
      appendChild: (el: any) => el,
    };
    const fakeDoc = {
      head: fakeHead,
      createElement: (tag: string) => {
        const elem: any = { tag, attributes: {}, textContent: '' };
        elem.setAttribute = (k: string, v: string) => {
          elem.attributes[k] = v;
        };
        return elem;
      },
    };

    const style = injectHostTheme(fakeDoc as any);
    expect(style.attributes['data-a2ui-theme']).toBe('host');
    expect(style.textContent).toBe(HOST_THEME_CSS);
  });

  it('injects style tag into shadow root target', () => {
    const fakeDoc = {
      createElement: (tag: string) => {
        const elem: any = { tag, attributes: {}, textContent: '' };
        elem.setAttribute = (k: string, v: string) => {
          elem.attributes[k] = v;
        };
        return elem;
      },
    };
    const fakeShadowRoot = {
      ownerDocument: fakeDoc,
      appendChild: (el: any) => el,
    };

    const style = injectHostTheme(fakeShadowRoot as any);
    expect(style?.attributes['data-a2ui-theme']).toBe('host');
    expect(style?.textContent).toBe(HOST_THEME_CSS);
  });

  it('is idempotent when injectHostTheme is called repeatedly on the same target (L1)', () => {
    const injected: any[] = [];
    const fakeHead = {
      querySelector: (sel: string) =>
        sel === 'style[data-a2ui-theme="host"]' ? injected[0] || null : null,
      appendChild: (el: any) => {
        injected.push(el);
        return el;
      },
    };
    const fakeDoc = {
      head: fakeHead,
      createElement: (tag: string) => {
        const elem: any = { tag, attributes: {}, textContent: '' };
        elem.setAttribute = (k: string, v: string) => {
          elem.attributes[k] = v;
        };
        return elem;
      },
    };

    const first = injectHostTheme(fakeDoc as any);
    const second = injectHostTheme(fakeDoc as any);
    expect(first).toBe(second);
    expect(injected).toHaveLength(1);
  });

  it('returns null when document is undefined and no target is provided, and uses global document when present', () => {
    const origDoc = (globalThis as any).document;
    try {
      delete (globalThis as any).document;
      expect(injectHostTheme()).toBeNull();

      const fakeDoc = {
        head: {
          appendChild: (el: any) => el,
        },
        createElement: (tag: string) => ({
          tag,
          attributes: {} as Record<string, string>,
          textContent: '',
          setAttribute(k: string, v: string) {
            this.attributes[k] = v;
          },
        }),
      };
      (globalThis as any).document = fakeDoc;
      const style = injectHostTheme();
      expect(style).not.toBeNull();

      // Target without ownerDocument falls back to global document
      const bareShadowRoot = {
        appendChild: (el: any) => el,
      };
      const shadowStyle = injectHostTheme(bareShadowRoot as any);
      expect(shadowStyle).not.toBeNull();
    } finally {
      (globalThis as any).document = origDoc;
    }
  });
});
