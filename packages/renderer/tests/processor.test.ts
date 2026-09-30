import { describe, it, expect, vi } from 'vitest';
import { createProcessor, LineApplier, A2uiPaneView } from '../src/index.js';
import { A2uiActionDetails } from '@a2ui-pane/protocol';

describe('createProcessor', () => {
  it('exports public classes and functions', () => {
    expect(createProcessor).toBeDefined();
    expect(LineApplier).toBeDefined();
    expect(A2uiPaneView).toBeDefined();
  });

  it('registers basicCatalog and aliases so createSurface succeeds for basic catalog IDs', () => {
    const onAction = vi.fn();
    const processor = createProcessor(onAction);

    // Test alias: 'basic'
    expect(() => {
      processor.processMessages([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf1', catalogId: 'basic' },
        },
      ]);
    }).not.toThrow();

    expect(processor.getSurface('surf1')).toBeDefined();

    // Test alias: 'v0_9/basic'
    expect(() => {
      processor.processMessages([
        {
          version: 'v0.9',
          createSurface: { surfaceId: 'surf2', catalogId: 'v0_9/basic' },
        },
      ]);
    }).not.toThrow();

    expect(processor.getSurface('surf2')).toBeDefined();

    // Test canonical URL
    expect(() => {
      processor.processMessages([
        {
          version: 'v0.9',
          createSurface: {
            surfaceId: 'surf3',
            catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
          },
        },
      ]);
    }).not.toThrow();

    expect(processor.getSurface('surf3')).toBeDefined();
  });

  it('forwards dispatched actions to onAction callback with dataModel when sendDataModel is true', () => {
    let capturedAction: A2uiActionDetails | null = null;
    let capturedDataModel: Record<string, unknown> | undefined = undefined;

    const processor = createProcessor((action, dataModel) => {
      capturedAction = action;
      capturedDataModel = dataModel;
    });

    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: {
          surfaceId: 'formSurface',
          catalogId: 'basic',
          sendDataModel: true,
        },
      },
      {
        version: 'v0.9',
        updateDataModel: {
          surfaceId: 'formSurface',
          path: '/formData',
          value: { username: 'testuser', email: 'test@example.com' },
        },
      },
    ]);

    const surface = processor.getSurface('formSurface');
    expect(surface).toBeDefined();

    // Dispatch action on the surface
    surface.dispatchAction({
      name: 'submitForm',
      context: { formId: 'login' },
    });

    expect(capturedAction).not.toBeNull();
    expect(capturedAction!.name).toBe('submitForm');
    expect(capturedAction!.surfaceId).toBe('formSurface');
    expect(capturedAction!.context).toEqual({ formId: 'login' });

    expect(capturedDataModel).toBeDefined();
    expect((capturedDataModel as any).version).toBe('v0.9');
    expect((capturedDataModel as any).surfaces.formSurface).toEqual({
      formData: { username: 'testuser', email: 'test@example.com' },
    });
  });

  it('does not attach dataModel when sendDataModel is false', () => {
    let capturedDataModel: Record<string, unknown> | undefined = { dummy: true };

    const processor = createProcessor((_action, dataModel) => {
      capturedDataModel = dataModel;
    });

    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: {
          surfaceId: 'readOnlySurface',
          catalogId: 'basic',
          sendDataModel: false,
        },
      },
      {
        version: 'v0.9',
        updateDataModel: {
          surfaceId: 'readOnlySurface',
          path: '/title',
          value: 'Hello',
        },
      },
    ]);

    const surface = processor.getSurface('readOnlySurface');
    surface.dispatchAction({ name: 'click' });

    expect(capturedDataModel).toBeUndefined();
  });

  it('safely handles action dispatch when onAction is not provided', () => {
    const processor = createProcessor();

    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: { surfaceId: 's1', catalogId: 'basic' },
      },
    ]);

    const surface = processor.getSurface('s1');
    expect(() => {
      surface.dispatchAction({ name: 'noop' });
    }).not.toThrow();
  });
});
