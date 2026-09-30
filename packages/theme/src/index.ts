/**
 * Embedded host theme stylesheet bridging host tokens to Lit A2UI variables.
 */
export const HOST_THEME_CSS = `:root {
  --a2ui-color-surface: var(--card, var(--background, #ffffff));
  --a2ui-color-input: var(--card, var(--background, #ffffff));
  --a2ui-color-secondary: var(--secondary, #f1f3f4);

  --a2ui-text-color-text: var(--foreground, #1f1f1f);
  --a2ui-text-caption-color: var(--muted-foreground, #70757a);
  --a2ui-color-on-background: var(--foreground, #1f1f1f);
  --a2ui-color-on-input: var(--foreground, #1f1f1f);
  --a2ui-color-on-primary: #ffffff;

  --a2ui-color-primary: var(--primary, #0b57d0);
  --a2ui-color-primary-hover: var(--primary-hover, #0842a0);
  --a2ui-color-primary-light: var(--primary-light, #d3e3fd);
  --a2ui-color-primary-dark: var(--primary-dark, #041e49);

  --a2ui-color-border: var(--border, #dadce0);
  --a2ui-border-width: 1px;
  --a2ui-border-radius: 8px;
  --a2ui-spacing-xs: 4px;
  --a2ui-spacing-s: 8px;
  --a2ui-spacing-m: 16px;
  --a2ui-spacing-l: 24px;
  --a2ui-font-size-s: 12px;
  --a2ui-font-size-m: 14px;
  --a2ui-font-size-l: 16px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --a2ui-color-surface: var(--card, var(--background, #1e1e1e));
    --a2ui-color-input: var(--card, var(--background, #1e1e1e));
    --a2ui-color-secondary: var(--secondary, #2d2d2d);
    --a2ui-text-color-text: var(--foreground, #e3e3e3);
    --a2ui-text-caption-color: var(--muted-foreground, #9aa0a6);
    --a2ui-color-on-background: var(--foreground, #e3e3e3);
    --a2ui-color-on-input: var(--foreground, #e3e3e3);
    --a2ui-color-primary: var(--primary, #a8c7fa);
    --a2ui-color-primary-hover: var(--primary-hover, #c2e7ff);
    --a2ui-color-on-primary: #041e49;
    --a2ui-color-border: var(--border, #3c4043);
  }
}`;

/**
 * Injects the host theme stylesheet into a DOM Document or ShadowRoot.
 */
export function injectHostTheme(target?: Document | ShadowRoot | null): HTMLStyleElement | null {
  if (typeof document === 'undefined' && !target) {
    return null;
  }
  const resolvedTarget = target ?? document;
  const doc = (resolvedTarget as Document).head
    ? (resolvedTarget as Document)
    : (resolvedTarget as ShadowRoot).ownerDocument || document;
  const style = doc.createElement('style');
  style.setAttribute('data-a2ui-theme', 'host');
  style.textContent = HOST_THEME_CSS;
  if ((resolvedTarget as Document).head) {
    (resolvedTarget as Document).head.appendChild(style);
  } else {
    resolvedTarget.appendChild(style);
  }
  return style;
}
