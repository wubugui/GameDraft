/**
 * Chromium reports a benign error when ResizeObserver callbacks trigger nested
 * layout in the same frame (Pixi resizeTo, flex layouts, embedded WebEngine).
 */
const RESIZE_OBSERVER_NOISE =
  /ResizeObserver loop (?:completed with undelivered notifications|limit exceeded)/;

export function installResizeObserverQuiet(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener(
    'error',
    (event) => {
      const message = event.message ?? '';
      if (RESIZE_OBSERVER_NOISE.test(message)) {
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}
