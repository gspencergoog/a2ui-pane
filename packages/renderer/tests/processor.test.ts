import { describe, it, expect, vi } from 'vitest';
import {
  createProcessor,
  markComponentSubmitted,
  clearSubmittedState,
  isOneShotButton,
  isComponentSubmitted,
  LineApplier,
  A2uiPaneView,
  type DispatchedActionDetails,
} from '../src/index.js';
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

  it('strips _oneShot, _group, and /_submitted metadata and records submission state', () => {
    let capturedAction: DispatchedActionDetails | null = null;
    let capturedDataModel: Record<string, unknown> | undefined = undefined;

    const processor = createProcessor((action, dataModel) => {
      capturedAction = action;
      capturedDataModel = dataModel;
    });

    processor.processMessages([
      {
        version: 'v0.9',
        createSurface: {
          surfaceId: 'gateSurf',
          catalogId: 'basic',
          sendDataModel: true,
        },
      },
      {
        version: 'v0.9',
        updateDataModel: {
          surfaceId: 'gateSurf',
          path: '/note',
          value: 'Looks good',
        },
      },
      {
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'gateSurf',
          components: [
            {
              id: 'root',
              component: 'Row',
              children: ['confirm_btn', 'cancel_btn'],
            },
            {
              id: 'confirm_lbl',
              component: 'Text',
              text: 'Approve',
            },
            {
              id: 'cancel_lbl',
              component: 'Text',
              text: 'Cancel',
            },
            {
              id: 'confirm_btn',
              component: 'Button',
              variant: 'primary',
              child: 'confirm_lbl',
              action: {
                event: {
                  name: 'confirm_gate_decision',
                  context: {
                    approved: true,
                    _oneShot: true,
                    _group: 'gate_decision',
                  },
                },
              },
            },
            {
              id: 'cancel_btn',
              component: 'Button',
              variant: 'default',
              child: 'cancel_lbl',
              action: {
                event: {
                  name: 'confirm_gate_decision',
                  context: {
                    approved: false,
                    _oneShot: true,
                    _group: 'gate_decision',
                  },
                },
              },
            },
          ],
        },
      },
    ]);

    const surface = processor.getSurface('gateSurf');
    surface.dispatchAction(
      {
        name: 'confirm_gate_decision',
        context: {
          approved: true,
          _oneShot: true,
          _group: 'gate_decision',
        },
      },
      'confirm_btn',
    );

    expect(capturedAction).not.toBeNull();
    expect(capturedAction!.oneShot).toBe(true);
    expect(capturedAction!.group).toBe('gate_decision');
    expect(capturedAction!.context).toEqual({ approved: true });

    // Surface data model has /_submitted flags, but capturedDataModel strips _submitted
    expect(isComponentSubmitted(surface.dataModel, 'confirm_btn', 'gate_decision')).toBe(true);
    expect(isComponentSubmitted(surface.dataModel, 'cancel_btn', 'gate_decision')).toBe(true);
    expect((capturedDataModel as any).surfaces.gateSurf).toEqual({ note: 'Looks good' });

    // Dispatch a second action while /_submitted is already present on surface.dataModel
    surface.dispatchAction(
      {
        name: 'refresh_check',
        context: { _oneShot: false },
      },
      'cancel_btn',
    );
    expect(capturedAction!.oneShot).toBe(false);
    expect((capturedDataModel as any).surfaces.gateSurf).toEqual({ note: 'Looks good' });

    // Clearing submitted state resets both button and group flags
    clearSubmittedState(processor, 'gateSurf');
    expect(isComponentSubmitted(surface.dataModel, 'confirm_btn', 'gate_decision')).toBe(false);
    expect(isComponentSubmitted(surface.dataModel, 'cancel_btn', 'gate_decision')).toBe(false);

    // Re-marking directly via markComponentSubmitted sets flags
    markComponentSubmitted(processor, 'gateSurf', 'confirm_btn', 'gate_decision');
    expect(isComponentSubmitted(surface.dataModel, 'confirm_btn', 'gate_decision')).toBe(true);
  });

  it('evaluates isOneShotButton defaults across variants and modal triggers', () => {
    const primaryComp = { id: 'b1', type: 'Button', properties: { variant: 'primary' } };
    const defaultComp = { id: 'b2', type: 'Button', properties: { variant: 'default' } };
    const borderlessComp = { id: 'b3', type: 'Button', properties: { variant: 'borderless' } };
    const modalComp = { id: 'm1', type: 'Modal', properties: { trigger: 'b2', content: 'b1' } };

    // Primary is one-shot
    expect(isOneShotButton(primaryComp, [primaryComp, defaultComp]).oneShot).toBe(true);
    // Default alongside a sibling primary is repeatable
    expect(isOneShotButton(defaultComp, [primaryComp, defaultComp]).oneShot).toBe(false);
    // Default as sole button is one-shot
    expect(isOneShotButton(defaultComp, [defaultComp]).oneShot).toBe(true);
    // Borderless is repeatable
    expect(isOneShotButton(borderlessComp, [borderlessComp]).oneShot).toBe(false);
    // Modal trigger is repeatable
    expect(isOneShotButton(defaultComp, [defaultComp, modalComp]).oneShot).toBe(false);
    expect(isOneShotButton(primaryComp, [primaryComp], true).oneShot).toBe(false);
  });
});
