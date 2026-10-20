/**
 * Shared CSS rules injected into `<a2ui-surface>` and `<a2ui-collapsible>` shadow roots
 * to style Light DOM basic catalog components, Markdown blocks, math, and Mermaid diagrams.
 */
export const SURFACE_LAYOUT_CSS = `
  a2ui-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  a2ui-basic-row > a2ui-modal {
    flex-shrink: 0;
    white-space: nowrap;
  }
  a2ui-card,
  a2ui-card > .a2ui-card,
  a2ui-basic-column,
  a2ui-basic-column > .a2ui-column,
  a2ui-basic-text,
  a2ui-basic-text > .a2ui-text {
    min-width: 0;
    max-width: 100%;
  }
  a2ui-basic-row > a2ui-basic-column,
  a2ui-basic-row > a2ui-basic-row,
  a2ui-basic-row > a2ui-basic-text {
    min-width: 0;
  }
  a2ui-basic-row > a2ui-basic-column,
  a2ui-list .a2ui-list-item-none > a2ui-basic-column {
    --a2ui-column-gap: 2px;
    gap: 2px;
  }
  a2ui-list .a2ui-list.vertical:not(:has(> .a2ui-list-item-none > a2ui-card)) {
    gap: 0;
  }
  a2ui-list .a2ui-list.vertical > .a2ui-list-item-none:not(:has(> a2ui-card)) {
    padding: 8px 2px;
    border-bottom: 1px solid color-mix(in srgb, var(--a2ui-color-border, #dadce0) 60%, transparent);
  }
  a2ui-list .a2ui-list.vertical > .a2ui-list-item-none:not(:has(> a2ui-card)):first-child {
    padding-top: 4px;
  }
  a2ui-list .a2ui-list.vertical > .a2ui-list-item-none:not(:has(> a2ui-card)):last-child {
    border-bottom: none;
    padding-bottom: 2px;
  }
  a2ui-basic-text .a2ui-text h5,
  a2ui-list .a2ui-list-item-none > a2ui-basic-row > a2ui-basic-column:first-child > a2ui-basic-text:first-child .a2ui-text.body {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.35;
  }
  a2ui-basic-row > a2ui-card {
    display: flex;
    flex-direction: column;
  }
  a2ui-basic-row > a2ui-card > .a2ui-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }
  a2ui-slider .a2ui-slider-container {
    box-sizing: border-box;
    padding-inline: 6px;
  }
  a2ui-slider .a2ui-slider {
    box-sizing: border-box;
    margin: 0;
  }
  a2ui-basic-textfield .a2ui-textfield {
    font-size: var(--a2ui-font-size-s, 12px);
    line-height: 1.3;
  }
  a2ui-basic-text .a2ui-text {
    font-size: var(--a2ui-font-size-m, 14px);
    line-height: var(--a2ui-line-height-body, 1.4);
  }
  a2ui-basic-text .a2ui-text.caption,
  a2ui-basic-text .a2ui-text .a2ui-caption {
    font-size: var(--a2ui-font-size-xs, 12px);
    color: var(--a2ui-text-caption-color, #70757a);
    font-style: normal;
  }
  a2ui-basic-text .a2ui-text.caption p,
  a2ui-basic-text .a2ui-text h1 p,
  a2ui-basic-text .a2ui-text h2 p,
  a2ui-basic-text .a2ui-text h3 p,
  a2ui-basic-text .a2ui-text h4 p,
  a2ui-basic-text .a2ui-text h5 p {
    display: inline;
    font-size: inherit;
    font-weight: inherit;
    line-height: inherit;
    color: inherit;
    margin: 0;
  }
  a2ui-basic-text .a2ui-text code {
    font-family: var(--a2ui-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    font-size: 0.9em;
    padding: 1px 5px;
    border-radius: 4px;
    background-color: var(--a2ui-color-secondary, rgba(175, 184, 193, 0.25));
    overflow-wrap: anywhere;
  }
  a2ui-basic-text .a2ui-text pre {
    display: block;
    margin: 6px 0;
    padding: 8px 10px;
    border-radius: 6px;
    background-color: var(--a2ui-color-secondary, rgba(175, 184, 193, 0.25));
    font-family: var(--a2ui-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    font-size: 0.9em;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
    box-sizing: border-box;
    max-width: 100%;
  }
  a2ui-basic-text .a2ui-text pre code {
    display: block;
    padding: 0;
    border-radius: 0;
    background-color: transparent;
    font-size: inherit;
    line-height: inherit;
    white-space: inherit;
    overflow-wrap: inherit;
    word-break: inherit;
  }
  a2ui-basic-text .a2ui-text ul,
  a2ui-basic-text .a2ui-text ol {
    padding-inline-start: 18px;
    font-size: var(--a2ui-font-size-m, 14px);
    line-height: var(--a2ui-line-height-body, 1.4);
  }
  a2ui-basic-text .a2ui-text li + li {
    margin-top: 2px;
  }
  .a2ui-math-block {
    margin: 4px 0;
    padding: 2px 0;
    overflow-x: auto;
    overflow-y: hidden;
  }
  .a2ui-mermaid {
    margin: 4px 0;
    overflow-x: auto;
    overflow-y: hidden;
    text-align: center;
  }
  .a2ui-mermaid-svg {
    display: block;
    margin: 0 auto;
    max-width: 100%;
    height: auto;
  }
  a2ui-basic-button .a2ui-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
`;
