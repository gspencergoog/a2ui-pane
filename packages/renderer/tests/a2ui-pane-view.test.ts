import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../src/a2ui-pane-view.js';
import { A2uiPaneView, SurfaceChangedDetail } from '../src/a2ui-pane-view.js';
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
});
