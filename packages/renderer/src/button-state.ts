import { html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { A2uiButton } from '@a2ui/web_core/catalogs/basic/v1';

/** Minimal shape of an A2UI ComponentModel used to inspect button configuration. */
export interface ButtonComponentModelLike {
  id: string;
  type?: string;
  properties: Record<string, any>;
}

/** Minimal shape of an A2UI Surface DataModel used to read submission flags. */
export interface SurfaceDataModelLike {
  get: (path: string) => unknown;
}

/** Result of evaluating whether a button is one-shot and whether it belongs to a group. */
export interface ButtonOneShotConfig {
  oneShot: boolean;
  group?: string;
}

function extractRawEventContext(
  properties: Record<string, any> | undefined,
): Record<string, unknown> | undefined {
  const ctx = properties?.action?.event?.context;
  if (!ctx || typeof ctx !== 'object') return undefined;
  if (!Array.isArray(ctx)) {
    return ctx as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const item of ctx) {
    if (item && typeof item === 'object' && typeof item.key === 'string') {
      out[item.key] = item.value;
    }
  }
  return out;
}

function isReferencedAsModalTrigger(
  componentId: string,
  surfaceComponents?: Iterable<ButtonComponentModelLike>,
): boolean {
  if (!surfaceComponents) return false;
  for (const comp of surfaceComponents) {
    if (comp.type !== 'Modal') continue;
    const triggerId = comp.properties?.trigger ?? comp.properties?.entryPointChild;
    if (triggerId === componentId) {
      return true;
    }
  }
  return false;
}

function surfaceHasPrimaryButton(
  componentId: string,
  surfaceComponents?: Iterable<ButtonComponentModelLike>,
): boolean {
  if (!surfaceComponents) return false;
  for (const comp of surfaceComponents) {
    if (
      comp.id !== componentId &&
      comp.type === 'Button' &&
      comp.properties?.variant === 'primary'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Determines whether a Button component should disable after one click (`oneShot`)
 * and extracts its optional mutual-exclusion `_group` identifier.
 *
 * Precedence:
 * 1. Explicit `_oneShot: boolean` in `Event(name, context)` overrides all defaults.
 * 2. Modal triggers and `"borderless"` buttons default to repeatable (`oneShot: false`).
 * 3. `"primary"` buttons default to one-shot (`oneShot: true`).
 * 4. `"default"` (or omitted variant) buttons default to repeatable when a sibling `"primary"`
 *    button exists on the surface, or one-shot when no `"primary"` button exists.
 */
export function isOneShotButton(
  componentModel: ButtonComponentModelLike,
  surfaceComponents?: Iterable<ButtonComponentModelLike>,
  isModalTrigger = false,
  resolvedContext?: Record<string, unknown>,
): ButtonOneShotConfig {
  const rawCtx = extractRawEventContext(componentModel.properties);
  const rawGroup = resolvedContext?._group ?? rawCtx?._group;
  const group = typeof rawGroup === 'string' && rawGroup.trim() ? rawGroup.trim() : undefined;

  const explicitOneShot = resolvedContext?._oneShot ?? rawCtx?._oneShot;
  if (typeof explicitOneShot === 'boolean') {
    return { oneShot: explicitOneShot, group };
  }

  if (isModalTrigger || isReferencedAsModalTrigger(componentModel.id, surfaceComponents)) {
    return { oneShot: false, group };
  }

  const variant = componentModel.properties?.variant;
  if (variant === 'borderless') {
    return { oneShot: false, group };
  }
  if (variant === 'primary') {
    return { oneShot: true, group };
  }

  const hasSiblingPrimary = surfaceHasPrimaryButton(componentModel.id, surfaceComponents);
  return { oneShot: !hasSiblingPrimary, group };
}

/**
 * Returns whether the given button component or its group has been marked submitted
 * in the surface data model (`/_submitted/<componentId>` or `/_submitted/_group/<group>`).
 */
export function isComponentSubmitted(
  surfaceDataModel: SurfaceDataModelLike | undefined,
  componentId: string,
  group?: string,
): boolean {
  if (!surfaceDataModel || !componentId) return false;
  if (surfaceDataModel.get(`/_submitted/${componentId}`) === true) {
    return true;
  }
  if (group && surfaceDataModel.get(`/_submitted/_group/${group}`) === true) {
    return true;
  }
  return false;
}

let buttonStateInstalled = false;

/**
 * Patches `A2uiButton.element.prototype.render` so `<button>` elements reflect
 * one-shot submission state stored in the surface data model alongside validation checks.
 */
export function installButtonStateRenderer(): void {
  if (buttonStateInstalled) return;
  buttonStateInstalled = true;

  const ButtonElementProto = A2uiButton?.element?.prototype as
    | {
        render?: () => unknown;
        controller?: { props?: Record<string, any> };
        context?: {
          componentModel?: ButtonComponentModelLike;
          surfaceComponents?: { values?: Iterable<ButtonComponentModelLike> };
          dataContext?: { surface?: { dataModel?: SurfaceDataModelLike } };
        };
        closest?: (selector: string) => Element | null;
        renderNode?: (node: unknown) => unknown;
      }
    | undefined;
  if (!ButtonElementProto) return;

  ButtonElementProto.render = function renderButtonWithOneShotState(this: {
    controller?: { props?: Record<string, any> };
    context?: {
      componentModel?: ButtonComponentModelLike;
      surfaceComponents?: { values?: Iterable<ButtonComponentModelLike> };
      dataContext?: { surface?: { dataModel?: SurfaceDataModelLike } };
    };
    closest?: (selector: string) => Element | null;
    renderNode: (node: unknown) => unknown;
  }) {
    const props = this.controller?.props;
    if (!props) return nothing;

    const compModel = this.context?.componentModel;
    const surfaceDataModel = this.context?.dataContext?.surface?.dataModel;
    const surfaceComponents = this.context?.surfaceComponents?.values;
    const isModalTrigger =
      typeof this.closest === 'function' && Boolean(this.closest('.a2ui-modal-trigger'));

    const { group } = compModel
      ? isOneShotButton(compModel, surfaceComponents, isModalTrigger)
      : { group: undefined };
    const isSubmitted = compModel
      ? isComponentSubmitted(surfaceDataModel, compModel.id, group)
      : false;

    const isDisabled = props.isValid === false || isSubmitted;
    const variant = props.variant ?? 'default';
    const classes = {
      'a2ui-button': true,
      [variant]: true,
      ['a2ui-button-' + variant]: true,
    };

    return html`
      <button
        type="button"
        class=${classMap(classes)}
        ?data-submitted=${isSubmitted}
        @click=${() => {
          if (isDisabled) return;
          props.action?.();
        }}
        ?disabled=${isDisabled}
      >
        ${props.child ? html`${this.renderNode(props.child)}` : nothing}
      </button>
    `;
  };
}
