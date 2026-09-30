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
    expect(style.attributes['data-a2ui-theme']).toBe('host');
    expect(style.textContent).toBe(HOST_THEME_CSS);
  });
});
