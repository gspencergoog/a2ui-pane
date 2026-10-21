import type { A2uiLinkClickDetail } from './a2ui-pane-view.js';

/** Host capabilities `openLink` needs; injected so the router stays a pure function. */
export interface LinkRouterDeps {
  /** `window.open` or an equivalent; returns `null` when the host blocks the popup. */
  open: (url: string, target: string, features: string) => Window | null;
  /** Copies text to the clipboard; rejects when no clipboard path is available. */
  copy: (text: string) => Promise<void>;
  /** Shows a short, non-error notice to the user. */
  toast: (message: string) => void;
}

/** Outcome of routing one link click. */
export type LinkRouteResult = 'opened' | 'copied' | 'failed';

const BROWSER_SCHEMES: ReadonlySet<string> = new Set(['http', 'https']);

function tryOpen(open: LinkRouterDeps['open'], href: string): boolean {
  try {
    return open(href, '_blank', 'noopener,noreferrer') !== null;
  } catch {
    return false;
  }
}

/**
 * Routes a Markdown link click from a surface. `http(s)` links open in a new browser tab; when
 * the host blocks that (`open` returns `null`), and for every other scheme (`file`,
 * `conversation`, `sidecar`, ...), the destination is copied to the clipboard and a
 * `Copied <href>` toast is shown. Returns `'failed'` when copying was the only option and it
 * rejected, so the host can surface the destination another way.
 */
export async function openLink(
  detail: A2uiLinkClickDetail,
  deps: LinkRouterDeps,
): Promise<LinkRouteResult> {
  const { href, scheme } = detail;
  if (BROWSER_SCHEMES.has(scheme.toLowerCase()) && tryOpen(deps.open, href)) {
    return 'opened';
  }
  try {
    await deps.copy(href);
  } catch {
    return 'failed';
  }
  deps.toast(`Copied ${href}`);
  return 'copied';
}
