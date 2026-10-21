import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  A2uiPaneView,
  createProcessor,
  STATUS_CATALOG_ID,
  StepperApi,
  StepperStepSchema,
  normalizeStepperSteps,
  clampStepperIndex,
} from '../src/index.js';

const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

const STEPS = [
  { label: 'Draft' },
  { label: 'Review', detail: 'Waiting on two reviewers' },
  { label: 'Approved' },
  { label: 'CI green' },
  { label: 'Merged' },
];

interface StepperSurfaceOptions {
  steps?: unknown;
  current?: number;
  tone?: string;
  orientation?: string;
  weight?: number;
  label?: string;
}

function stepperMessages(surfaceId: string, opts: StepperSurfaceOptions) {
  const stepper: Record<string, unknown> = {
    id: 'life',
    component: 'Stepper',
    catalogId: STATUS_CATALOG_ID,
    steps: { '@path': '/steps' },
    current: { '@path': '/cur' },
  };
  if (opts.tone !== undefined) stepper.tone = opts.tone;
  if (opts.orientation !== undefined) stepper.orientation = opts.orientation;
  if (opts.weight !== undefined) stepper.weight = opts.weight;
  if (opts.label !== undefined) stepper.accessibility = { label: opts.label };
  return [
    { version: 'v1.0', createSurface: { surfaceId, sendDataModel: true } },
    {
      version: 'v1.0',
      updateDataModel: {
        surfaceId,
        path: '/',
        value: { steps: opts.steps ?? STEPS, cur: opts.current ?? 0 },
      },
    },
    {
      version: 'v1.0',
      updateComponents: {
        surfaceId,
        components: [
          {
            id: 'root',
            component: 'Column',
            catalogId: BASIC_CATALOG_ID,
            children: ['life'],
          },
          stepper,
        ],
      },
    },
  ];
}

describe('Stepper schema', () => {
  it('accepts a $/steps binding, a $/cur binding, and the optional props', () => {
    const result = StepperApi.schema.safeParse({
      steps: { '@path': '/steps' },
      current: { '@path': '/cur' },
      tone: 'danger',
      orientation: 'vertical',
      weight: 2,
      accessibility: { label: 'Lifecycle' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a static array of steps with optional detail', () => {
    const result = StepperApi.schema.safeParse({
      steps: [{ label: 'Draft' }, { label: 'Review', detail: 'two reviewers' }],
      current: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a step without a label, an unknown orientation, and unknown properties', () => {
    expect(StepperStepSchema.safeParse({ detail: 'no label' }).success).toBe(false);
    expect(
      StepperApi.schema.safeParse({ steps: [{ detail: 'no label' }], current: 0 }).success,
    ).toBe(false);
    expect(
      StepperApi.schema.safeParse({ steps: STEPS, current: 0, orientation: 'diagonal' }).success,
    ).toBe(false);
    expect(StepperApi.schema.safeParse({ steps: STEPS, current: 0, dense: true }).success).toBe(
      false,
    );
    expect(StepperApi.schema.safeParse({ steps: STEPS }).success).toBe(false);
  });
});

describe('Stepper helpers', () => {
  it('normalizes steps, keeping strings and dropping entries without a label', () => {
    expect(
      normalizeStepperSteps([
        { label: 'A', detail: 'why' },
        'B',
        { label: 3 },
        { detail: 'orphan' },
        null,
        { label: 'C', detail: '' },
      ]),
    ).toEqual([
      { label: 'A', detail: 'why' },
      { label: 'B' },
      { label: '3', detail: undefined },
      { label: 'C', detail: undefined },
    ]);
    expect(normalizeStepperSteps('nope')).toEqual([]);
  });

  it('clamps the current index into the step range', () => {
    expect(clampStepperIndex(2, 5)).toBe(2);
    expect(clampStepperIndex(9, 5)).toBe(4);
    expect(clampStepperIndex(-3, 5)).toBe(0);
    expect(clampStepperIndex('3', 5)).toBe(3);
    expect(clampStepperIndex(1.7, 5)).toBe(1);
    expect(clampStepperIndex(undefined, 5)).toBe(0);
    expect(clampStepperIndex('abc', 5)).toBe(0);
    expect(clampStepperIndex(0, 0)).toBe(-1);
  });
});

describe('<a2ui-stepper>', () => {
  let pane: A2uiPaneView;

  beforeEach(() => {
    pane = document.createElement('a2ui-pane-view') as A2uiPaneView;
    document.body.appendChild(pane);
  });

  afterEach(() => {
    pane.remove();
  });

  async function mount(surfaceId: string, opts: StepperSurfaceOptions) {
    const processor = createProcessor();
    processor.processMessages(stepperMessages(surfaceId, opts) as any);
    pane.processor = processor;
    await pane.updateComplete;
    const surfaceEl = pane.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    for (const col of Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-basic-column'))) {
      await (col as any).updateComplete;
    }
    const stepperEl = surfaceEl.shadowRoot!.querySelector('a2ui-stepper')!;
    expect(stepperEl).not.toBeNull();
    await (stepperEl as any).updateComplete;
    return { processor, stepperEl: stepperEl as HTMLElement, root: stepperEl.shadowRoot! };
  }

  function stepItems(root: ShadowRoot): HTMLElement[] {
    return Array.from(root.querySelectorAll('ol.a2ui-stepper > li'));
  }

  function tones(root: ShadowRoot): string[] {
    return stepItems(root).map((li) => li.dataset.tone ?? '');
  }

  it('renders one step per entry with success before, active at, and neutral after current', async () => {
    const { root } = await mount('stepperTones', { current: 2 });
    const items = stepItems(root);
    expect(items).toHaveLength(STEPS.length);
    expect(items.map((li) => li.querySelector('.a2ui-stepper-label')!.textContent!.trim())).toEqual(
      ['Draft', 'Review', 'Approved', 'CI green', 'Merged'],
    );
    expect(tones(root)).toEqual(['success', 'success', 'active', 'neutral', 'neutral']);
    expect(items.map((li) => li.hasAttribute('data-current'))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(items[2].getAttribute('aria-current')).toBe('step');
    expect(items[0].hasAttribute('aria-current')).toBe(false);
    expect(root.querySelector('ol')!.getAttribute('aria-label')).toBe('Step: Approved');
  });

  it('applies tone="danger" to the current step only', async () => {
    const { root } = await mount('stepperDanger', { current: 3, tone: 'danger' });
    expect(tones(root)).toEqual(['success', 'success', 'success', 'danger', 'neutral']);
  });

  it('clamps current beyond the last index to the last step', async () => {
    const { root } = await mount('stepperClamp', { current: 42 });
    expect(tones(root)).toEqual(['success', 'success', 'success', 'success', 'active']);
    expect(stepItems(root)[4].hasAttribute('data-current')).toBe(true);
  });

  it('renders detail as a title tooltip and every dot once', async () => {
    const { root } = await mount('stepperDetail', { current: 1 });
    const items = stepItems(root);
    expect(items[1].getAttribute('title')).toBe('Waiting on two reviewers');
    expect(items[0].hasAttribute('title')).toBe(false);
    expect(root.querySelectorAll('.a2ui-stepper-dot')).toHaveLength(STEPS.length);
  });

  it('sets the vertical modifier class and data attribute when orientation is vertical', async () => {
    const { root } = await mount('stepperVertical', { current: 0, orientation: 'vertical' });
    const list = root.querySelector('ol')!;
    expect(list.classList.contains('a2ui-stepper--vertical')).toBe(true);
    expect(list.classList.contains('a2ui-stepper--horizontal')).toBe(false);
    expect(list.getAttribute('data-orientation')).toBe('vertical');

    const { root: hRoot } = await mount('stepperHorizontal', { current: 0 });
    expect(hRoot.querySelector('ol')!.classList.contains('a2ui-stepper--horizontal')).toBe(true);
  });

  it('applies weight as flex on the host and the accessibility label on the list', async () => {
    const { stepperEl, root } = await mount('stepperWeight', {
      current: 0,
      weight: 3,
      label: 'PR lifecycle',
    });
    expect(stepperEl.style.flexGrow).toBe('3');
    expect(root.querySelector('ol')!.getAttribute('aria-label')).toBe('PR lifecycle');

    const { stepperEl: plain } = await mount('stepperNoWeight', { current: 0 });
    expect(plain.style.flex).toBe('');
  });

  it('follows the status-catalog host rules for Row and Column layout', () => {
    const cssText = String((customElements.get('a2ui-stepper') as any).styles.cssText);
    const hostBlock = /:host \{([^}]*)\}/.exec(cssText)?.[1] ?? '';
    expect(hostBlock).not.toContain('width: 100%');
    expect(hostBlock).toContain('min-width: 0');
    expect(hostBlock).toContain('align-self: stretch');
    expect(cssText).toContain(':host([data-a2ui-row-item])');
    expect(cssText).toContain('flex: 1 1 0%');
    expect(cssText).toContain('@keyframes a2ui-badge-pulse');
  });

  it('re-renders tones when the bound current index changes', async () => {
    const { root, processor } = await mount('stepperLive', { current: 0 });
    expect(tones(root)).toEqual(['active', 'neutral', 'neutral', 'neutral', 'neutral']);
    processor.processMessages([
      {
        version: 'v1.0',
        updateDataModel: { surfaceId: 'stepperLive', path: '/cur', value: 4 },
      },
    ] as any);
    const stepperEl = root.host as any;
    await stepperEl.updateComplete;
    expect(tones(root)).toEqual(['success', 'success', 'success', 'success', 'active']);
  });
});
