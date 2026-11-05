import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  A2uiPaneView,
  createProcessor,
  STATUS_CATALOG_ID,
  ChoiceCardsApi,
  ChoiceCardOptionSchema,
  normalizeChoiceCardOptions,
  nextChoiceValue,
} from '../src/index.js';

const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

const OPTIONS = [
  {
    value: 'a',
    label: 'A · Keep one page',
    description: 'Questions stay on **one** scrolling page.',
    badge: 'Recommended',
    tone: 'success',
  },
  { value: 'b', label: 'B · Stepper deck', description: 'One question per step.' },
  { value: 'c', label: 'C · Tabs' },
  { value: 'defer', label: 'Defer', quiet: true },
];

interface ChoiceCardsSurfaceOptions {
  options?: unknown;
  value?: string[];
  variant?: string;
  direction?: string;
  weight?: number;
  label?: string;
}

function choiceCardsMessages(surfaceId: string, opts: ChoiceCardsSurfaceOptions) {
  const cards: Record<string, unknown> = {
    id: 'cards',
    component: 'ChoiceCards',
    catalogId: STATUS_CATALOG_ID,
    options: { '@path': '/options' },
    value: { '@path': '/choice' },
  };
  if (opts.variant !== undefined) cards.variant = opts.variant;
  if (opts.direction !== undefined) cards.direction = opts.direction;
  if (opts.weight !== undefined) cards.weight = opts.weight;
  if (opts.label !== undefined) cards.accessibility = { label: opts.label };
  return [
    { version: '1.0', createSurface: { surfaceId, sendDataModel: true } },
    {
      version: '1.0',
      updateDataModel: {
        surfaceId,
        path: '/',
        value: { options: opts.options ?? OPTIONS, choice: opts.value ?? [] },
      },
    },
    {
      version: '1.0',
      updateComponents: {
        surfaceId,
        components: [
          {
            id: 'root',
            component: 'Column',
            catalogId: BASIC_CATALOG_ID,
            children: ['cards'],
          },
          cards,
        ],
      },
    },
  ];
}

describe('ChoiceCards schema', () => {
  it('accepts bound options and value plus the optional props', () => {
    const result = ChoiceCardsApi.schema.safeParse({
      options: { '@path': '/q1/options' },
      value: { '@path': '/q1/choice' },
      variant: 'multipleSelection',
      direction: 'horizontal',
      weight: 2,
      accessibility: { label: 'Question 1' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a static option array with every option field', () => {
    const result = ChoiceCardsApi.schema.safeParse({
      options: OPTIONS,
      value: ['a'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an option without a value, unknown option keys, unknown variants, and unknown props', () => {
    expect(ChoiceCardOptionSchema.safeParse({ label: 'no value' }).success).toBe(false);
    expect(
      ChoiceCardOptionSchema.safeParse({ value: 'x', label: 'X', icon: 'check' }).success,
    ).toBe(false);
    expect(
      ChoiceCardsApi.schema.safeParse({ options: OPTIONS, value: [], variant: 'single' }).success,
    ).toBe(false);
    expect(
      ChoiceCardsApi.schema.safeParse({ options: OPTIONS, value: [], direction: 'grid' }).success,
    ).toBe(false);
    expect(
      ChoiceCardsApi.schema.safeParse({ options: OPTIONS, value: [], dense: true }).success,
    ).toBe(false);
    expect(ChoiceCardsApi.schema.safeParse({ options: OPTIONS }).success).toBe(false);
  });
});

describe('ChoiceCards helpers', () => {
  it('normalizes options, dropping entries without a value and defaulting the label', () => {
    expect(
      normalizeChoiceCardOptions([
        { value: 'a', label: 'A', description: 'why', badge: 'Recommended', tone: 'success' },
        { value: 'b' },
        { value: 3, label: 'Three', tone: 'bogus', quiet: 'yes' },
        { label: 'orphan' },
        'string',
        null,
        { value: 'd', label: 'D', description: '', badge: '', quiet: true },
      ]),
    ).toEqual([
      {
        value: 'a',
        label: 'A',
        description: 'why',
        badge: 'Recommended',
        tone: 'success',
        quiet: false,
      },
      {
        value: 'b',
        label: 'b',
        description: undefined,
        badge: undefined,
        tone: undefined,
        quiet: false,
      },
      {
        value: '3',
        label: 'Three',
        description: undefined,
        badge: undefined,
        tone: 'neutral',
        quiet: false,
      },
      {
        value: 'd',
        label: 'D',
        description: undefined,
        badge: undefined,
        tone: undefined,
        quiet: true,
      },
    ]);
    expect(normalizeChoiceCardOptions('nope')).toEqual([]);
    expect(normalizeChoiceCardOptions(undefined)).toEqual([]);
  });

  it('replaces the selection in mutuallyExclusive mode, including from and to quiet options', () => {
    expect(nextChoiceValue([], 'a', 'mutuallyExclusive')).toEqual(['a']);
    expect(nextChoiceValue(['a'], 'b', 'mutuallyExclusive')).toEqual(['b']);
    expect(nextChoiceValue(['a'], 'a', 'mutuallyExclusive')).toEqual(['a']);
    expect(nextChoiceValue(['a', 'b'], 'defer', 'mutuallyExclusive')).toEqual(['defer']);
    expect(nextChoiceValue(['defer'], 'a', 'mutuallyExclusive')).toEqual(['a']);
    expect(nextChoiceValue(['a'], 'b', undefined)).toEqual(['b']);
  });

  it('toggles the value in multipleSelection mode and keeps the others', () => {
    expect(nextChoiceValue([], 'a', 'multipleSelection')).toEqual(['a']);
    expect(nextChoiceValue(['a'], 'b', 'multipleSelection')).toEqual(['a', 'b']);
    expect(nextChoiceValue(['a', 'b'], 'a', 'multipleSelection')).toEqual(['b']);
    expect(nextChoiceValue(['a', 'defer'], 'defer', 'multipleSelection')).toEqual(['a']);
  });
});

describe('<a2ui-choice-cards>', () => {
  let pane: A2uiPaneView;

  beforeEach(() => {
    pane = document.createElement('a2ui-pane-view') as A2uiPaneView;
    document.body.appendChild(pane);
  });

  afterEach(() => {
    pane.remove();
  });

  async function mount(surfaceId: string, opts: ChoiceCardsSurfaceOptions) {
    const processor = createProcessor();
    processor.processMessages(choiceCardsMessages(surfaceId, opts) as any);
    pane.processor = processor;
    await pane.updateComplete;
    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    for (const col of Array.from(
      (surfaceEl.shadowRoot ?? surfaceEl).querySelectorAll('a2ui-basic-column'),
    )) {
      await (col as any).updateComplete;
    }
    const el = (surfaceEl.shadowRoot ?? surfaceEl).querySelector('a2ui-choice-cards')!;
    expect(el).not.toBeNull();
    await (el as any).updateComplete;
    return {
      processor,
      el: el as HTMLElement & { updateComplete: Promise<boolean> },
      root: el.shadowRoot!,
      choice: () => processor.getSurface(surfaceId)?.dataModel?.get('/choice'),
    };
  }

  function cards(root: ShadowRoot): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button.a2ui-choice-card-button'));
  }

  function cardWrappers(root: ShadowRoot): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('div.a2ui-choice-card'));
  }

  function quietToggles(root: ShadowRoot): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('button.a2ui-choice-quiet'));
  }

  function allItems(root: ShadowRoot): HTMLButtonElement[] {
    return Array.from(root.querySelectorAll<HTMLButtonElement>('[data-choice-index]'));
  }

  function checked(root: ShadowRoot): string[] {
    return allItems(root).map((b) => b.getAttribute('aria-checked') ?? '');
  }

  function tabindexes(root: ShadowRoot): string[] {
    return allItems(root).map((b) => b.getAttribute('tabindex') ?? '');
  }

  function click(el: Element) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  }

  function key(el: Element, k: string) {
    const event = new KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    el.dispatchEvent(event);
    return event;
  }

  it('renders a radiogroup of radio cards plus quiet toggles with aria-checked from value', async () => {
    const { root } = await mount('ccBasic', { value: ['a'] });
    const group = root.querySelector('.a2ui-choice-cards')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Choices');
    expect(group.classList.contains('a2ui-choice-cards--vertical')).toBe(true);

    const cardEls = cards(root);
    expect(cardEls).toHaveLength(3);
    expect(cardEls.map((c) => c.getAttribute('role'))).toEqual(['radio', 'radio', 'radio']);
    expect(cardWrappers(root).map((c) => c.dataset.value)).toEqual(['a', 'b', 'c']);
    expect(cardWrappers(root).map((c) => c.dataset.checked)).toEqual(['true', 'false', 'false']);
    expect(
      cardEls.map((c) => c.querySelector('.a2ui-choice-card-label')!.textContent!.trim()),
    ).toEqual(['A · Keep one page', 'B · Stepper deck', 'C · Tabs']);

    const quiet = quietToggles(root);
    expect(quiet).toHaveLength(1);
    expect(quiet[0].dataset.value).toBe('defer');
    expect(quiet[0].getAttribute('role')).toBe('radio');
    expect(quiet[0].textContent!.trim()).toBe('Defer');

    expect(checked(root)).toEqual(['true', 'false', 'false', 'false']);
    expect(cardEls[0].querySelector('.a2ui-choice-check-icon')).not.toBeNull();
    expect(cardEls[1].querySelector('.a2ui-choice-check-icon')).toBeNull();
  });

  it('renders the badge with its tone and the description as Markdown', async () => {
    const { root, el } = await mount('ccBadge', { value: [] });
    const badge = cards(root)[0].querySelector('.a2ui-badge')!;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('data-tone')).toBe('success');
    expect(badge.textContent!.trim()).toBe('Recommended');
    expect(cards(root)[2].querySelector('.a2ui-badge')).toBeNull();

    // Markdown renders asynchronously; wait for the strong tag to land.
    for (let i = 0; i < 20 && !root.querySelector('.a2ui-choice-card-description strong'); i++) {
      await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;
    }
    const description = cardWrappers(root)[0].querySelector('.a2ui-choice-card-description')!;
    expect(description.querySelector('strong')?.textContent).toBe('one');
    expect(cardWrappers(root)[2].querySelector('.a2ui-choice-card-description')).toBeNull();
  });

  it('keeps the description out of the button and links it with aria-describedby', async () => {
    const { root } = await mount('ccDescribedBy', { value: [] });
    const [withDescription, , withoutDescription] = cards(root);
    expect(withDescription.querySelector('.a2ui-choice-card-description')).toBeNull();
    const id = withDescription.getAttribute('aria-describedby')!;
    expect(id).toBeTruthy();
    const description = root.getElementById(id)!;
    expect(description).not.toBeNull();
    expect(description.classList.contains('a2ui-choice-card-description')).toBe(true);
    expect(description.parentElement).toBe(cardWrappers(root)[0]);
    expect(description.previousElementSibling).toBe(withDescription);
    expect(withoutDescription.hasAttribute('aria-describedby')).toBe(false);
    expect(cards(root)[1].getAttribute('aria-describedby')).not.toBe(id);
  });

  it('chooses the option when the description is clicked, but not when a link inside it is', async () => {
    const { root, el, choice } = await mount('ccDescriptionClick', {
      value: [],
      options: [
        { value: 'a', label: 'A', description: 'See [the doc](https://example.com/doc).' },
        { value: 'b', label: 'B', description: 'Plain text.' },
      ],
    });
    for (let i = 0; i < 20 && !root.querySelector('.a2ui-choice-card-description a'); i++) {
      await new Promise((r) => setTimeout(r, 10));
      await el.updateComplete;
    }
    const link = root.querySelector<HTMLAnchorElement>('.a2ui-choice-card-description a')!;
    expect(link).not.toBeNull();
    link.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }),
    );
    await el.updateComplete;
    expect(choice()).toEqual([]);

    click(cardWrappers(root)[1].querySelector('.a2ui-choice-card-description')!);
    await el.updateComplete;
    expect(choice()).toEqual(['b']);

    click(cardWrappers(root)[0]);
    await el.updateComplete;
    expect(choice()).toEqual(['a']);
  });

  it('clicking a card writes [value] in mutuallyExclusive mode and quiet options clear the cards', async () => {
    const { root, el, choice } = await mount('ccExclusive', { value: ['a'] });
    click(cards(root)[1]);
    await el.updateComplete;
    expect(choice()).toEqual(['b']);
    expect(checked(root)).toEqual(['false', 'true', 'false', 'false']);

    click(quietToggles(root)[0]);
    await el.updateComplete;
    expect(choice()).toEqual(['defer']);
    expect(checked(root)).toEqual(['false', 'false', 'false', 'true']);

    click(cards(root)[0]);
    await el.updateComplete;
    expect(choice()).toEqual(['a']);
    expect(checked(root)).toEqual(['true', 'false', 'false', 'false']);
  });

  it('toggles values in multipleSelection mode with checkbox roles inside a group', async () => {
    const { root, el, choice } = await mount('ccMulti', {
      value: ['a'],
      variant: 'multipleSelection',
    });
    expect(root.querySelector('.a2ui-choice-cards')!.getAttribute('role')).toBe('group');
    expect(allItems(root).map((c) => c.getAttribute('role'))).toEqual([
      'checkbox',
      'checkbox',
      'checkbox',
      'checkbox',
    ]);

    click(cards(root)[2]);
    await el.updateComplete;
    expect(choice()).toEqual(['a', 'c']);
    expect(checked(root)).toEqual(['true', 'false', 'true', 'false']);

    click(cards(root)[0]);
    await el.updateComplete;
    expect(choice()).toEqual(['c']);

    click(quietToggles(root)[0]);
    await el.updateComplete;
    expect(choice()).toEqual(['c', 'defer']);
    expect(checked(root)).toEqual(['false', 'false', 'true', 'true']);
  });

  it('gives the first selected option the roving tabindex, or the first option when none is selected', async () => {
    const { root } = await mount('ccTabindex', { value: ['defer'] });
    expect(tabindexes(root)).toEqual(['-1', '-1', '-1', '0']);

    const { root: none } = await mount('ccTabindexNone', { value: [] });
    expect(tabindexes(none)).toEqual(['0', '-1', '-1', '-1']);

    const { root: unknown } = await mount('ccTabindexUnknown', { value: ['zzz'] });
    expect(tabindexes(unknown)).toEqual(['0', '-1', '-1', '-1']);
    expect(checked(unknown)).toEqual(['false', 'false', 'false', 'false']);
  });

  it('arrow keys move focus and select in mutuallyExclusive mode, wrapping through quiet options', async () => {
    const { root, el, choice } = await mount('ccArrows', { value: ['a'] });
    const first = cards(root)[0];
    first.focus();

    const right = key(first, 'ArrowRight');
    await el.updateComplete;
    expect(right.defaultPrevented).toBe(true);
    expect(choice()).toEqual(['b']);
    expect(root.activeElement).toBe(cards(root)[1]);
    expect(tabindexes(root)).toEqual(['-1', '0', '-1', '-1']);

    key(cards(root)[1], 'ArrowDown');
    await el.updateComplete;
    key(cards(root)[2], 'ArrowDown');
    await el.updateComplete;
    expect(choice()).toEqual(['defer']);
    expect(root.activeElement).toBe(quietToggles(root)[0]);

    key(quietToggles(root)[0], 'ArrowRight');
    await el.updateComplete;
    expect(choice()).toEqual(['a']);
    expect(root.activeElement).toBe(cards(root)[0]);

    key(cards(root)[0], 'ArrowUp');
    await el.updateComplete;
    expect(choice()).toEqual(['defer']);

    key(quietToggles(root)[0], 'Home');
    await el.updateComplete;
    expect(choice()).toEqual(['a']);
    key(cards(root)[0], 'End');
    await el.updateComplete;
    expect(choice()).toEqual(['defer']);

    const other = key(quietToggles(root)[0], 'Tab');
    expect(other.defaultPrevented).toBe(false);
    expect(choice()).toEqual(['defer']);
  });

  it('arrow keys only move focus in multipleSelection mode; Space toggles via the button click', async () => {
    const { root, el, choice } = await mount('ccMultiKeys', {
      value: ['a'],
      variant: 'multipleSelection',
    });
    cards(root)[0].focus();
    key(cards(root)[0], 'ArrowRight');
    await el.updateComplete;
    expect(choice()).toEqual(['a']);
    expect(root.activeElement).toBe(cards(root)[1]);
    // The roving tabindex follows focus, not the checked card, so Tab leaves the group.
    expect(tabindexes(root)).toEqual(['-1', '0', '-1', '-1']);

    key(cards(root)[1], 'ArrowLeft');
    await el.updateComplete;
    expect(root.activeElement).toBe(cards(root)[0]);
    key(cards(root)[0], 'ArrowLeft');
    await el.updateComplete;
    expect(root.activeElement).toBe(quietToggles(root)[0]);
    expect(tabindexes(root)).toEqual(['-1', '-1', '-1', '0']);
    expect(choice()).toEqual(['a']);

    // Space on a native <button> dispatches click; keydown itself must stay unhandled.
    const space = key(cards(root)[1], ' ');
    expect(space.defaultPrevented).toBe(false);
    click(cards(root)[1]);
    await el.updateComplete;
    expect(choice()).toEqual(['a', 'b']);
    expect(checked(root)).toEqual(['true', 'true', 'false', 'false']);
  });

  it('moves the roving tabindex to a card that receives focus by pointer or script', async () => {
    const { root, el } = await mount('ccFocusTracking', {
      value: ['a'],
      variant: 'multipleSelection',
    });
    expect(tabindexes(root)).toEqual(['0', '-1', '-1', '-1']);
    cards(root)[2].focus();
    await el.updateComplete;
    expect(tabindexes(root)).toEqual(['-1', '-1', '0', '-1']);

    // In mutuallyExclusive mode the checked radio keeps the tabindex, per WAI-ARIA.
    const { root: single, el: singleEl } = await mount('ccFocusTrackingSingle', { value: ['a'] });
    cards(single)[2].focus();
    await singleEl.updateComplete;
    expect(tabindexes(single)).toEqual(['0', '-1', '-1', '-1']);
  });

  it('falls back to the checked or first option when the focused index is out of range', async () => {
    const { root, el, processor } = await mount('ccFocusRange', {
      value: ['b'],
      variant: 'multipleSelection',
    });
    quietToggles(root)[0].focus();
    await el.updateComplete;
    expect(tabindexes(root)).toEqual(['-1', '-1', '-1', '0']);
    processor.processMessages([
      {
        version: '1.0',
        updateDataModel: {
          surfaceId: 'ccFocusRange',
          path: '/options',
          value: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      },
    ] as any);
    await el.updateComplete;
    expect(tabindexes(root)).toEqual(['-1', '0']);
  });

  it('re-renders when the bound options change', async () => {
    const { root, el, processor } = await mount('ccLive', { value: ['b'] });
    expect(cards(root)).toHaveLength(3);
    processor.processMessages([
      {
        version: '1.0',
        updateDataModel: {
          surfaceId: 'ccLive',
          path: '/options',
          value: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No', badge: 'Risky', tone: 'warning' },
          ],
        },
      },
    ] as any);
    await el.updateComplete;
    expect(cardWrappers(root).map((c) => c.dataset.value)).toEqual(['yes', 'no']);
    expect(quietToggles(root)).toHaveLength(0);
    expect(root.querySelector('.a2ui-choice-cards-quiet')).toBeNull();
    expect(cards(root)[1].querySelector('.a2ui-badge')!.getAttribute('data-tone')).toBe('warning');
    expect(checked(root)).toEqual(['false', 'false']);

    processor.processMessages([
      {
        version: '1.0',
        updateDataModel: { surfaceId: 'ccLive', path: '/choice', value: ['no'] },
      },
    ] as any);
    await el.updateComplete;
    expect(checked(root)).toEqual(['false', 'true']);
  });

  it('renders no items for non-array options and ignores keys without options', async () => {
    const { root, el } = await mount('ccEmpty', { options: 'nope', value: [] });
    expect(allItems(root)).toHaveLength(0);
    expect(root.querySelector('.a2ui-choice-cards')).not.toBeNull();
    await el.updateComplete;
  });

  it('sets the horizontal modifier class and data attribute when direction is horizontal', async () => {
    const { root } = await mount('ccHorizontal', { value: [], direction: 'horizontal' });
    const group = root.querySelector('.a2ui-choice-cards')!;
    expect(group.classList.contains('a2ui-choice-cards--horizontal')).toBe(true);
    expect(group.classList.contains('a2ui-choice-cards--vertical')).toBe(false);
    expect(group.getAttribute('data-direction')).toBe('horizontal');
    expect(group.getAttribute('data-variant')).toBe('mutuallyExclusive');
  });

  it('applies weight as flex on the host and the accessibility label on the group', async () => {
    const { el, root } = await mount('ccWeight', { value: [], weight: 3, label: 'Question 1' });
    expect(el.style.flexGrow).toBe('3');
    expect(root.querySelector('.a2ui-choice-cards')!.getAttribute('aria-label')).toBe('Question 1');

    const { el: plain } = await mount('ccNoWeight', { value: [] });
    expect(plain.style.flex).toBe('');
  });

  it('adopts its static styles, including the badge sheet, into the shadow root it creates', async () => {
    const { root } = await mount('ccStyles', { value: [] });
    const adopted = root.adoptedStyleSheets ?? [];
    const adoptedText = adopted
      .flatMap((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText))
      .join('\n');
    const inlineText = Array.from(root.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    const all = `${adoptedText}\n${inlineText}`;
    expect(all).toContain('.a2ui-choice-card');
    expect(all).toContain('.a2ui-badge[data-tone=');
  });

  it('follows the status-catalog host rules for Row and Column layout', () => {
    const styles = (customElements.get('a2ui-choice-cards') as any).styles as Array<{
      cssText: string;
    }>;
    const cssText = styles[styles.length - 1].cssText;
    const hostBlock = /:host \{([^}]*)\}/.exec(cssText)?.[1] ?? '';
    expect(hostBlock).not.toContain('width: 100%');
    expect(hostBlock).toContain('min-width: 0');
    expect(hostBlock).toContain('align-self: stretch');
    expect(cssText).toContain(':host([data-a2ui-row-item])');
    expect(cssText).toContain('flex: 1 1 0%');
    expect(cssText).toContain('.a2ui-choice-cards--horizontal .a2ui-choice-cards-list');
    expect(cssText).toContain('flex-wrap: wrap');
    expect(cssText).toContain("[data-checked='true']");
    expect(cssText).toContain('--a2ui-tone-active-bg');
  });
});
