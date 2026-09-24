/**
 * The small amount of state the shell and the pages share.
 *
 * `revision` is bumped whenever the profile arrays change. The arrays are
 * typed arrays mutated in place, which Svelte cannot observe, so a counter is
 * the honest way to tell a template that a derived number needs recomputing -
 * far cheaper than proxying 1.6 MB of Uint8Array.
 */

export type View = 'word' | 'settings' | 'coverage' | 'timing' | 'account' | 'picker' | 'lists' | 'published';

export const ui = $state({
  view: 'word' as View,
  ready: false,
  bootError: '',
  toast: '',
  revision: 0,
  /** The headword the list picker is adding, while it is open. */
  pickerWord: '',
  /** The share code being viewed on the published-list page. */
  publishedCode: '',
});

let toastTimer: number | null = null;

export function showToast(message: string, ms = 4000): void {
  ui.toast = message;
  if (toastTimer !== null) self.clearTimeout(toastTimer);
  toastTimer = self.setTimeout(() => {
    toastTimer = null;
    ui.toast = '';
  }, ms);
}

/**
 * Navigation is a stack mirrored into browser history.
 *
 * Every overlay opened pushes a history entry tagged with its depth, so the
 * in-app back button, Escape, the browser's back button and Android's system
 * back all do the same thing: return to the view underneath. Without the
 * history entries, system back on an installed PWA would close the app from
 * inside the settings page.
 */
const stack: View[] = [];

export function go(view: View): void {
  if (view === ui.view) return;
  if (view === 'word') {
    closeAll();
    return;
  }
  stack.push(ui.view);
  ui.view = view;
  history.pushState({ twdDepth: stack.length }, '');
}

/** Return to the view underneath. A no-op on the word screen. */
export function back(): void {
  if (stack.length > 0) history.back();
}

export function canGoBack(): boolean {
  return stack.length > 0;
}

/** Unwind every overlay in one step, collapsing their history entries too. */
function closeAll(): void {
  if (stack.length === 0) {
    ui.view = 'word';
    return;
  }
  history.go(-stack.length);
}

/**
 * The popped-to entry says how deep it was; unwind the stack to match. One
 * handler covers a single back and a multi-step `history.go(-n)`, because
 * both land on an entry whose depth is simply smaller than the stack.
 */
addEventListener('popstate', (event: PopStateEvent) => {
  const depth = Number((event.state as { twdDepth?: number } | null)?.twdDepth ?? 0);
  while (stack.length > depth) ui.view = stack.pop()!;
});
