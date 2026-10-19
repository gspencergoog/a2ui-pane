import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../src/a2ui-pane-view.js';
import { A2uiPaneView, SurfaceChangedDetail } from '../src/a2ui-pane-view.js';
import { ICON_SVG_PATHS, resolveIconSvgPath } from '../src/icon-paths.js';
import { createProcessor } from '../src/processor.js';

describe('A2uiPaneView', () => {
  let element: A2uiPaneView;

  beforeEach(() => {
    element = document.createElement('a2ui-pane-view');
    document.body.appendChild(element);
  });

  afterEach(() => {
    if (element.parentElement) {
      document.body.removeChild(element);
    }
  });

  it('renders default empty state when processor is absent or surfaces are empty', async () => {
    await element.updateComplete;
    const shadowRoot = element.shadowRoot;
    expect(shadowRoot).not.toBeNull();
    const emptyState = shadowRoot!.querySelector('.a2ui-empty-state');
    expect(emptyState).not.toBeNull();
    expect(emptyState!.textContent).toContain('No surfaces rendered');
  });

  it('renders surfaces present on the processor when bound', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfA', catalogId: 'basic' },
      },
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfB', catalogId: 'basic' },
      },
    ]);

    element.processor = processor;
    await element.updateComplete;

    const shadowRoot = element.shadowRoot!;
    const wrappers = shadowRoot.querySelectorAll('.a2ui-surface-wrapper');
    expect(wrappers).toHaveLength(2);
    expect(wrappers[0].getAttribute('data-surface-id')).toBe('surfA');
    expect(wrappers[1].getAttribute('data-surface-id')).toBe('surfB');

    const surfaceElements = shadowRoot.querySelectorAll('a2ui-surface');
    expect(surfaceElements).toHaveLength(2);
    const layoutStyle = surfaceElements[0].shadowRoot?.querySelector(
      'style[data-a2ui-surface-layout]',
    );
    expect(layoutStyle).not.toBeNull();
    expect(layoutStyle?.textContent).toContain('a2ui-basic-row > a2ui-card > .a2ui-card');
    expect(layoutStyle?.textContent).toContain('a2ui-basic-text .a2ui-text pre');
    expect(layoutStyle?.textContent).toContain('white-space: pre-wrap');
    expect(layoutStyle?.textContent).toContain('a2ui-basic-text .a2ui-text pre code');
  });

  it('listens to onSurfaceCreated, updates DOM and dispatches surface-changed event', async () => {
    const processor = createProcessor();
    element.processor = processor;
    await element.updateComplete;

    const events: CustomEvent<SurfaceChangedDetail>[] = [];
    element.addEventListener('surface-changed', (e) => {
      events.push(e as CustomEvent<SurfaceChangedDetail>);
    });

    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'dynamicSurf', catalogId: 'basic' },
      },
    ]);

    await element.updateComplete;

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      surfaceId: 'dynamicSurf',
      action: 'created',
    });

    const wrapper = element.shadowRoot!.querySelector('[data-surface-id="dynamicSurf"]');
    expect(wrapper).not.toBeNull();
  });

  it('listens to onSurfaceDeleted, updates DOM and dispatches surface-changed event', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfToDelete', catalogId: 'basic' },
      },
    ]);

    element.processor = processor;
    await element.updateComplete;

    expect(element.shadowRoot!.querySelector('[data-surface-id="surfToDelete"]')).not.toBeNull();

    const events: CustomEvent<SurfaceChangedDetail>[] = [];
    element.addEventListener('surface-changed', (e) => {
      events.push(e as CustomEvent<SurfaceChangedDetail>);
    });

    processor.processMessages([
      {
        version: 'v0.9',
        deleteSurface: { surfaceId: 'surfToDelete' },
      },
    ]);

    await element.updateComplete;

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      surfaceId: 'surfToDelete',
      action: 'deleted',
    });

    expect(element.shadowRoot!.querySelector('[data-surface-id="surfToDelete"]')).toBeNull();
  });

  it('unsubscribes and cleans up when processor is unassigned or element disconnected', async () => {
    const processor = createProcessor();
    element.processor = processor;
    await element.updateComplete;

    // Disconnect element
    document.body.removeChild(element);

    const events: any[] = [];
    element.addEventListener('surface-changed', (e) => events.push(e));

    // Message on processor should not trigger events since disconnected
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'postDisconnect', catalogId: 'basic' },
      },
    ]);

    expect(events).toHaveLength(0);

    // Reconnect and unassign processor
    document.body.appendChild(element);
    element.processor = undefined;
    await element.updateComplete;

    expect(element.surfaceIds).toEqual([]);
    expect(element.shadowRoot!.querySelector('.a2ui-empty-state')).not.toBeNull();
  });

  it('renders data-busy and data-pending-components when pendingComponents is non-empty (M4)', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfBusy', catalogId: 'basic' },
      },
    ]);

    element.processor = processor;
    element.pendingComponents = new Set(['btnSubmit', 'btnCancel']);
    await element.updateComplete;

    const surfacesDiv = element.shadowRoot!.querySelector('.a2ui-surfaces');
    expect(surfacesDiv).not.toBeNull();
    expect(surfacesDiv!.hasAttribute('data-busy')).toBe(true);
    expect(surfacesDiv!.getAttribute('data-pending-components')).toBe('btnSubmit,btnCancel');

    element.pendingComponents = new Set();
    await element.updateComplete;
    expect(surfacesDiv!.hasAttribute('data-busy')).toBe(false);
    expect(surfacesDiv!.hasAttribute('data-pending-components')).toBe(false);
  });

  it('replaces a submitted surface with a Submitted banner and supports Edit/Resubmit, Clear, and auto-dismiss on new surface', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfSubmit', catalogId: 'basic' },
      },
    ]);

    element.processor = processor;
    await element.updateComplete;

    expect(element.shadowRoot!.querySelector('a2ui-surface')).not.toBeNull();
    expect(element.isSurfaceSubmitted('surfSubmit')).toBe(false);

    // Mark surface submitted -> replaces <a2ui-surface> with banner
    element.markSurfaceSubmitted('surfSubmit', 'Submit Alignment');
    await element.updateComplete;

    expect(element.isSurfaceSubmitted('surfSubmit')).toBe(true);
    expect(element.shadowRoot!.querySelector('a2ui-surface')).toBeNull();
    const banner = element.shadowRoot!.querySelector('.a2ui-surface-submitted-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('✓ Submitted "Submit Alignment" to agent.');

    // Click Edit / Resubmit -> restores <a2ui-surface>
    const resubmitBtn = banner!.querySelector('.a2ui-surface-resubmit-btn') as HTMLButtonElement;
    resubmitBtn.click();
    await element.updateComplete;

    expect(element.isSurfaceSubmitted('surfSubmit')).toBe(false);
    expect(element.shadowRoot!.querySelector('a2ui-surface')).not.toBeNull();

    // Mark submitted again, then click Clear -> removes surface and renders empty state
    element.markSurfaceSubmitted('surfSubmit');
    await element.updateComplete;
    const clearBtn = element.shadowRoot!.querySelector(
      '.a2ui-surface-dismiss-btn',
    ) as HTMLButtonElement;
    clearBtn.click();
    await element.updateComplete;

    expect(element.shadowRoot!.querySelector('.a2ui-empty-state')).not.toBeNull();

    // Re-marking a dismissed surface restores its submitted banner, and clearSubmittedSurfaces resets all
    element.markSurfaceSubmitted('surfSubmit');
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('.a2ui-surface-submitted-banner')).not.toBeNull();

    // Creating a new surface auto-dismisses the previously submitted surface
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfNext', catalogId: 'basic' },
      },
    ]);
    await element.updateComplete;

    expect(element.shadowRoot!.querySelector('[data-surface-id="surfSubmit"]')).toBeNull();
    expect(element.shadowRoot!.querySelector('[data-surface-id="surfNext"]')).not.toBeNull();

    element.clearSubmittedSurfaces();
    await element.updateComplete;
    expect(element.shadowRoot!.querySelector('[data-surface-id="surfSubmit"]')).not.toBeNull();
  });

  it('renders top-right X close button when dismissibleSurfaces is true and dispatches surface-dismissed on click', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfDismissible', catalogId: 'basic' },
      },
    ]);

    element.processor = processor;
    element.dismissibleSurfaces = true;
    await element.updateComplete;

    const closeBtn = element.shadowRoot!.querySelector(
      '.a2ui-surface-close-btn',
    ) as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    const dismissedIds: string[] = [];
    element.addEventListener('surface-dismissed', (evt: Event) => {
      dismissedIds.push((evt as CustomEvent).detail.surfaceId);
    });

    closeBtn.click();
    await element.updateComplete;

    expect(dismissedIds).toEqual(['surfDismissible']);
    expect(element.isSurfaceDismissed('surfDismissible')).toBe(true);
    expect(element.shadowRoot!.querySelector('.a2ui-empty-state')).not.toBeNull();
  });

  it('renders named A2UI catalog icons as inline SVGs instead of web font ligatures', async () => {
    expect(Object.keys(ICON_SVG_PATHS).length).toBeGreaterThanOrEqual(59);
    expect(resolveIconSvgPath('warning')).toBe(ICON_SVG_PATHS.warning);
    expect(resolveIconSvgPath('favorite_border')).toBe(ICON_SVG_PATHS.favoriteOff);
    expect(resolveIconSvgPath('account_circle')).toBe(ICON_SVG_PATHS.accountCircle);

    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfIcon', catalogId: 'basic' },
      },
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'surfIcon',
          components: [
            {
              id: 'root',
              component: 'Row',
              children: ['warn-icon'],
            },
            {
              id: 'warn-icon',
              component: 'Icon',
              name: 'warning',
            },
          ],
        },
      },
    ]);

    element.processor = processor;
    await element.updateComplete;

    const surfaceEl = element.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    const iconEl = surfaceEl.shadowRoot!.querySelector('a2ui-icon');
    expect(iconEl).not.toBeNull();
    await (iconEl as any).updateComplete;

    const svgEl = iconEl!.querySelector('svg.a2ui-icon.svg');
    expect(svgEl).not.toBeNull();
    expect(svgEl!.getAttribute('data-icon')).toBe('warning');
    expect(svgEl!.querySelector('path')?.getAttribute('d')).toBe(ICON_SVG_PATHS.warning);
    expect(iconEl!.querySelector('i.material-icons')).toBeNull();
  });

  it('renders inline Markdown inside caption and h1-h5 Text variants', async () => {
    const processor = createProcessor();
    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfRichText', catalogId: 'basic' },
      },
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'surfRichText',
          components: [
            {
              id: 'root',
              component: 'Column',
              children: ['h4-node', 'caption-node'],
            },
            {
              id: 'h4-node',
              component: 'Text',
              variant: 'h4',
              text: '#### Heading with `code`',
            },
            {
              id: 'caption-node',
              component: 'Text',
              variant: 'caption',
              text: '**Rollout:** `Stacked PRs`',
            },
          ],
        },
      },
    ]);

    element.processor = processor;
    await element.updateComplete;

    const surfaceEl = element.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    await new Promise((r) => setTimeout(r, 30));

    const captionSpan = surfaceEl.shadowRoot!.querySelector('.a2ui-text.caption .a2ui-caption');
    expect(captionSpan).not.toBeNull();
    expect(captionSpan!.innerHTML).toContain('<strong>Rollout:</strong>');
    expect(captionSpan!.innerHTML).toContain('<code>Stacked PRs</code>');

    const h4El = surfaceEl.shadowRoot!.querySelector('.a2ui-text.h4 h4');
    expect(h4El).not.toBeNull();
    expect(h4El!.innerHTML).toContain('<code>code</code>');
  });

  it('disables one-shot and grouped buttons on click while keeping repeatable buttons active', async () => {
    const actions: any[] = [];
    const processor = createProcessor((action) => {
      actions.push(action);
    });

    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 'surfButtons', catalogId: 'basic' },
      },
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'surfButtons',
          components: [
            {
              id: 'root',
              component: 'Row',
              children: ['approve_btn', 'cancel_btn', 'helper_btn'],
            },
            { id: 'approve_txt', component: 'Text', text: 'Approve' },
            { id: 'cancel_txt', component: 'Text', text: 'Cancel' },
            { id: 'helper_txt', component: 'Text', text: 'Inspect' },
            {
              id: 'approve_btn',
              component: 'Button',
              variant: 'primary',
              child: 'approve_txt',
              action: {
                event: {
                  name: 'decide',
                  context: { approved: true, _oneShot: true, _group: 'gate' },
                },
              },
            },
            {
              id: 'cancel_btn',
              component: 'Button',
              variant: 'default',
              child: 'cancel_txt',
              action: {
                event: {
                  name: 'decide',
                  context: { approved: false, _oneShot: true, _group: 'gate' },
                },
              },
            },
            {
              id: 'helper_btn',
              component: 'Button',
              variant: 'borderless',
              child: 'helper_txt',
              action: {
                event: {
                  name: 'inspect',
                  context: { _oneShot: false },
                },
              },
            },
          ],
        },
      },
    ]);

    element.processor = processor;
    await element.updateComplete;

    const surfaceEl = element.shadowRoot!.querySelector('a2ui-surface')!;
    await (surfaceEl as any).updateComplete;
    await new Promise((r) => setTimeout(r, 30));

    const buttonHosts = Array.from(surfaceEl.shadowRoot!.querySelectorAll('a2ui-basic-button'));
    expect(buttonHosts).toHaveLength(3);
    for (const host of buttonHosts) {
      await (host as any).updateComplete;
    }

    const approveBtn = buttonHosts[0].querySelector('button') as HTMLButtonElement;
    const cancelBtn = buttonHosts[1].querySelector('button') as HTMLButtonElement;
    const helperBtn = buttonHosts[2].querySelector('button') as HTMLButtonElement;

    expect(approveBtn.disabled).toBe(false);
    expect(cancelBtn.disabled).toBe(false);
    expect(helperBtn.disabled).toBe(false);

    // Clicking repeatable borderless button fires action and stays enabled
    helperBtn.click();
    await (buttonHosts[2] as any).updateComplete;
    expect(actions).toHaveLength(1);
    expect(actions[0].name).toBe('inspect');
    expect(actions[0].oneShot).toBe(false);
    expect(helperBtn.disabled).toBe(false);

    helperBtn.click();
    expect(actions).toHaveLength(2);

    // Clicking primary button disables both approveBtn and grouped cancelBtn
    approveBtn.click();
    for (const host of buttonHosts) {
      await (host as any).updateComplete;
    }

    expect(actions).toHaveLength(3);
    expect(actions[2].name).toBe('decide');
    expect(actions[2].oneShot).toBe(true);
    expect(actions[2].group).toBe('gate');
    expect(actions[2].context).toEqual({ approved: true });

    expect(approveBtn.disabled).toBe(true);
    expect(approveBtn.hasAttribute('data-submitted')).toBe(true);
    expect(cancelBtn.disabled).toBe(true);
    expect(cancelBtn.hasAttribute('data-submitted')).toBe(true);
    expect(helperBtn.disabled).toBe(false);

    // Clicking disabled buttons does not fire another action
    approveBtn.click();
    cancelBtn.click();
    expect(actions).toHaveLength(3);

    // Clearing submitted state re-enables both grouped buttons
    element.clearSubmittedState('surfButtons');
    for (const host of buttonHosts) {
      await (host as any).updateComplete;
    }
    expect(approveBtn.disabled).toBe(false);
    expect(approveBtn.hasAttribute('data-submitted')).toBe(false);
    expect(cancelBtn.disabled).toBe(false);
  });
});
