import type { LoadingPresentationConfig, LoadingTransitionKind } from '../data/types';
import { LoadingReveal, resolveLoadingTransition } from './LoadingReveal';
import { UITheme } from './UITheme';
import './loading-surface.css';

/** One presentation surface covers both the canvas and DOM controls, including bootstrap. */
export class LoadingSurface {
  private readonly root: HTMLElement;
  private readonly curtain: HTMLElement;
  private readonly label: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly actions: HTMLElement;
  private id: string | null = null;
  private ratio = 0;
  private revealing = false;
  private indeterminate = false;
  private alpha = 1;
  private disposed = false;
  private config: LoadingPresentationConfig = {};
  private cancelAnimation: (() => void) | null = null;
  private presentationEpoch = 0;
  private revealEffect: LoadingReveal | null = null;
  private viewport: { canvas: HTMLElement; size: () => { width: number; height: number } } | null = null;
  private viewportObserver: ResizeObserver | null = null;
  private readonly blockedElements = new Map<HTMLElement, boolean>();
  private readonly pointerEvents = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend'] as const;

  constructor(initialId = 'boot') {
    this.root = document.getElementById('game-loading') ?? document.createElement('div');
    this.root.id = 'game-loading';
    this.root.className = 'game-loading';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.tabIndex = -1;
    this.root.innerHTML = '';
    this.curtain = document.createElement('div');
    this.curtain.className = 'game-loading-curtain';
    this.curtain.setAttribute('aria-hidden', 'true');
    if (import.meta.env.DEV) this.root.classList.add('game-loading-development');
    const cssColor = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;
    this.root.style.setProperty('--loading-track', cssColor(UITheme.colors.sliderTrack));
    this.root.style.setProperty('--loading-border', cssColor(UITheme.colors.borderSubtle));
    this.root.style.setProperty('--loading-fill', cssColor(UITheme.colors.progressFill));
    const content = document.createElement('div');
    content.className = 'game-loading-content';
    this.label = document.createElement('div');
    this.label.className = 'game-loading-label';
    this.label.textContent = '正在准备…';
    const track = document.createElement('div');
    track.className = 'game-loading-track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    this.bar = document.createElement('div');
    this.bar.className = 'game-loading-bar';
    track.append(this.bar);
    this.actions = document.createElement('div');
    this.actions.className = 'game-loading-actions';
    content.append(this.label, track, this.actions);
    this.root.append(this.curtain, content);
    if (!this.root.parentElement) document.body.append(this.root);
    this.id = initialId;
    this.root.hidden = false;
    this.root.setAttribute('aria-busy', 'true');
    this.setAlpha(1);
    for (const event of this.pointerEvents) {
      window.addEventListener(event, this.blockPointer, { capture: true, passive: false });
      this.root.addEventListener(event, this.stopPointer, { passive: false });
    }
    this.blockUnderlyingElements();
    window.addEventListener('resize', this.layoutProgress);
  }

  /** Keep the original logical-canvas progress bar placement, including letterboxing. */
  setViewport(canvas: HTMLElement, size: () => { width: number; height: number }): void {
    this.viewportObserver?.disconnect();
    this.viewport = { canvas, size };
    if (typeof ResizeObserver !== 'undefined') {
      this.viewportObserver = new ResizeObserver(this.layoutProgress);
      this.viewportObserver.observe(canvas);
    }
    this.layoutProgress();
  }

  private layoutProgress = (): void => {
    if (!this.viewport || this.disposed) return;
    const rect = this.viewport.canvas.getBoundingClientRect();
    const logical = this.viewport.size();
    if (rect.width <= 0 || rect.height <= 0 || logical.width <= 0 || logical.height <= 0) return;
    const sx = rect.width / logical.width;
    const sy = rect.height / logical.height;
    this.root.style.setProperty('--loading-x', `${rect.left + rect.width / 2}px`);
    this.root.style.setProperty('--loading-y', `${rect.top + rect.height * 0.88}px`);
    this.root.style.setProperty('--loading-width', `${Math.min(480, Math.max(200, Math.round(logical.width * 0.72))) * sx}px`);
    this.root.style.setProperty('--loading-height', `${Math.max(6, Math.round(logical.height * 0.014)) * sy}px`);
    this.root.style.setProperty('--loading-label-size', `${10 * sy}px`);
    this.root.style.setProperty('--loading-label-gap', `${8 * sy}px`);
  };

  private isActionTarget(target: EventTarget | null): boolean {
    return target instanceof Element && this.root.contains(target)
      && target.closest('button[data-loading-action]') !== null;
  }

  private blockPointer = (event: Event): void => {
    if (this.id === null || this.disposed || this.isActionTarget(event.target)) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };

  private stopPointer = (event: Event): void => {
    if (!this.isActionTarget(event.target) && event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };

  private blockUnderlyingElements(): void {
    for (const element of Array.from(document.body.children)) {
      if (!(element instanceof HTMLElement) || element === this.root || element.contains(this.root)) continue;
      if (!this.blockedElements.has(element)) this.blockedElements.set(element, element.inert);
      element.inert = true;
    }
    this.root.focus({ preventScroll: true });
  }

  private releaseUnderlyingElements(): void {
    for (const [element, inert] of this.blockedElements) element.inert = inert;
    this.blockedElements.clear();
  }

  private replaceAnimation(): number {
    this.presentationEpoch++;
    this.cancelAnimation?.();
    this.revealEffect?.dispose();
    this.revealEffect = null;
    delete this.root.dataset.transition;
    return this.presentationEpoch;
  }

  private checkAnimation(id: string, epoch: number, signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Loading cancelled', 'AbortError');
    if (this.disposed || this.id !== id || this.presentationEpoch !== epoch) {
      throw new DOMException('Loading presentation replaced', 'AbortError');
    }
  }

  configure(config: LoadingPresentationConfig | undefined): void {
    this.config = config ?? {};
  }

  get activeId(): string | null { return this.id; }

  handleKey(event: KeyboardEvent): void {
    const focused = document.activeElement;
    if ((event.code === 'Enter' || event.code === 'Space') && focused instanceof HTMLButtonElement
      && this.root.contains(focused) && focused.hasAttribute('data-loading-action')) focused.click();
  }

  async cover(id: string, signal?: AbortSignal, immediate = false): Promise<void> {
    if (this.disposed) throw new Error('Loading surface was destroyed');
    const wasRevealing = this.revealing;
    const epoch = this.replaceAnimation();
    const wasVisible = this.id !== null;
    this.id = id;
    // An additional request changes the remaining workload. Show honest activity instead
    // of rewinding a visible bar or inventing a new total for an open-ended queue.
    this.indeterminate = wasVisible && (this.indeterminate || this.ratio > 0);
    if (!wasVisible) this.ratio = 0;
    this.revealing = false;
    if (this.indeterminate) this.root.classList.add('game-loading-indeterminate');
    else this.root.classList.remove('game-loading-indeterminate');
    this.actions.replaceChildren();
    this.root.hidden = false;
    this.root.classList.remove('game-loading-revealing', 'game-loading-failed');
    this.root.setAttribute('aria-busy', 'true');
    this.blockUnderlyingElements();
    this.layoutProgress();
    // Replacement during a spatial reveal must first close every exposed part of the world.
    if (wasRevealing) this.setAlpha(1);
    else if (!wasVisible) this.setAlpha(immediate ? 1 : 0);
    this.progress(id, 0, '正在准备…');
    await this.animate(id, epoch, 1, immediate ? 0 : this.duration('fadeOutMs', 180), signal);
    this.checkAnimation(id, epoch, signal);
    // A frame boundary lets the opaque DOM surface be painted before world teardown.
    await this.animate(id, epoch, 1, 1, signal);
  }

  progress(id: string, ratio: number, label: string): void {
    if (this.disposed || this.id !== id) return;
    if (Number.isFinite(ratio)) this.ratio = Math.max(this.ratio, Math.min(this.revealing ? 1 : 0.99, Math.max(0, ratio)));
    this.bar.style.transform = `scaleX(${this.ratio})`;
    if (this.indeterminate) this.bar.parentElement?.removeAttribute('aria-valuenow');
    else this.bar.parentElement?.setAttribute('aria-valuenow', String(Math.round(this.ratio * 100)));
    // Detailed filenames and engine stages stay in diagnostics, not in the player's loading UI.
    const message = this.revealing ? '就绪' : label.startsWith('恢复') ? '正在恢复场景…' : '正在加载…';
    this.label.textContent = import.meta.env.DEV && !this.indeterminate ? `[${Math.round(this.ratio * 100)}%] ${message}` : message;
    this.root.dataset.progress = String(this.ratio);
  }

  async reveal(id: string, signal?: AbortSignal, presentation?: {
    transition?: LoadingTransitionKind;
    target?: HTMLElement;
    origin?: { x: number; y: number };
  }): Promise<void> {
    if (this.id !== id || this.disposed) return;
    const epoch = this.replaceAnimation();
    this.revealing = true;
    this.indeterminate = false;
    this.root.classList.remove('game-loading-indeterminate');
    this.root.classList.add('game-loading-revealing');
    this.progress(id, 1, '就绪');
    const kind = presentation ? resolveLoadingTransition(presentation.transition) : 'fade';
    const effect = new LoadingReveal(this.curtain, kind, presentation);
    this.revealEffect = effect;
    this.root.dataset.transition = kind;
    try {
      effect.update(0);
      await this.animateProgress(id, epoch, this.duration('revealMs', presentation ? effect.durationMs : 420),
        (progress) => effect.update(progress), signal);
      this.checkAnimation(id, epoch, signal);
      this.alpha = 0;
    } catch (error) {
      if (this.presentationEpoch === epoch && this.id === id && !this.disposed) this.setAlpha(1);
      throw error;
    } finally {
      // A stale reveal can never clear the mask/filter of its replacement.
      if (this.revealEffect === effect) {
        effect.dispose();
        this.revealEffect = null;
      }
    }
    // Keep the transparent pointer shield until the state owner completes the handoff.
  }

  finish(id: string): void {
    if (this.id !== id || this.disposed) return;
    this.replaceAnimation();
    this.id = null;
    this.revealing = false;
    this.root.hidden = true;
    this.root.setAttribute('aria-busy', 'false');
    this.actions.replaceChildren();
    this.releaseUnderlyingElements();
  }

  fail(id: string, error: unknown, retry?: () => void): void {
    if (this.id !== id || this.disposed) return;
    this.replaceAnimation();
    this.revealing = false;
    this.setAlpha(1);
    this.root.hidden = false;
    this.root.classList.remove('game-loading-revealing');
    this.root.classList.add('game-loading-failed');
    this.root.setAttribute('aria-busy', 'false');
    console.error('[LoadingSurface] Loading failed', error);
    this.label.textContent = '加载未完成，请重试或重新启动。';
    this.actions.replaceChildren();
    const add = (label: string, action: () => void): void => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.loadingAction = '';
      button.textContent = label;
      button.addEventListener('click', action);
      this.actions.append(button);
    };
    if (retry) add('重试', retry);
    add('重新启动', () => window.location.reload());
    this.actions.querySelector('button')?.focus();
  }

  private duration(key: 'fadeOutMs' | 'revealMs', fallback: number): number {
    const value = this.config[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  private setAlpha(alpha: number): void {
    this.alpha = alpha;
    this.curtain.style.opacity = String(alpha);
    const content = this.label.parentElement;
    if (content) content.style.opacity = String(alpha);
  }

  private animate(id: string, epoch: number, target: number, ms: number, signal?: AbortSignal): Promise<void> {
    const from = this.alpha;
    return this.animateProgress(id, epoch, ms,
      (t) => this.setAlpha(from + (target - from) * (t * t * (3 - 2 * t))), signal);
  }

  private animateProgress(id: string, epoch: number, ms: number, update: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let raf = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const started = performance.now();
      const done = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        cancelAnimationFrame(raf);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (this.cancelAnimation === cancel) this.cancelAnimation = null;
        error !== undefined ? reject(error) : resolve();
      };
      const abort = (): void => done(signal?.reason ?? new DOMException('Loading cancelled', 'AbortError'));
      const cancel = (): void => done(new DOMException('Loading presentation replaced', 'AbortError'));
      const apply = (progress: number): boolean => {
        try { update(progress); return true; }
        catch (error) { done(error); return false; }
      };
      const step = (): void => {
        if (this.disposed || this.id !== id || this.presentationEpoch !== epoch) { cancel(); return; }
        if (signal?.aborted) { abort(); return; }
        const t = ms <= 0 ? 1 : Math.min(1, (performance.now() - started) / ms);
        if (!apply(t)) return;
        if (t >= 1) { done(); return; }
        raf = requestAnimationFrame(step);
      };
      this.cancelAnimation = cancel;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      // A hidden page may not receive rAF; it can settle presentation without opening gameplay.
      timer = setTimeout(() => {
        if (this.disposed || this.id !== id || this.presentationEpoch !== epoch) { cancel(); return; }
        if (signal?.aborted) { abort(); return; }
        if (!apply(1)) return;
        done();
      }, ms + 250);
      if (ms <= 0) { if (apply(1)) done(); }
      else raf = requestAnimationFrame(step);
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.replaceAnimation();
    window.removeEventListener('resize', this.layoutProgress);
    this.viewportObserver?.disconnect();
    this.viewportObserver = null;
    this.viewport = null;
    for (const event of this.pointerEvents) {
      window.removeEventListener(event, this.blockPointer, true);
      this.root.removeEventListener(event, this.stopPointer);
    }
    this.releaseUnderlyingElements();
    this.root.remove();
    this.id = null;
  }
}
