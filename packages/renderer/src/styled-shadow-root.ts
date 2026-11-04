import { adoptStyles, type LitElement } from 'lit';

/**
 * Attaches an open shadow root to `element` and adopts the element class's `static styles`.
 *
 * `@a2ui/lit` 0.15 renders `A2uiLitElement` subclasses into light DOM, so the status-catalog
 * elements override `createRenderRoot()` to get a shadow root back. Returning a bare
 * `attachShadow()` skips the `adoptStyles()` call that `LitElement.createRenderRoot()` makes,
 * which leaves every `static styles` rule unapplied (badges render as plain text and the
 * stepper as a numbered list). Use this helper from every such override instead.
 */
export function createStyledShadowRoot(element: LitElement): ShadowRoot {
  const root = element.attachShadow({ mode: 'open' });
  adoptStyles(root, (element.constructor as typeof LitElement).elementStyles);
  return root;
}
