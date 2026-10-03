import catalogue from '../data/loadingTransitions.json';
import type { LoadingTransitionKind } from '../data/types';

const kinds = Object.keys(catalogue) as LoadingTransitionKind[];

/** Resolve once per reveal; animation frames never choose another effect. */
export function resolveLoadingTransition(configured: unknown): LoadingTransitionKind {
  if (typeof configured === 'string' && Object.prototype.hasOwnProperty.call(catalogue, configured)) {
    return configured as LoadingTransitionKind;
  }
  if (configured !== undefined && import.meta.env.DEV) {
    console.warn('[LoadingReveal] Unknown loadingTransition; choosing a random reveal', configured);
  }
  return kinds[Math.floor(Math.random() * kinds.length)];
}

function clamp(value: number, min: number, max: number): number {
  return Number.isNaN(value) ? min : Math.max(min, Math.min(max, value));
}

function smoothstep(start: number, end: number, value: number): number {
  const t = clamp((value - start) / (end - start), 0, 1);
  return t * t * (3 - 2 * t);
}

interface InlineProperty {
  value: string;
  priority: string;
}

/** Pure presentation: its owner supplies time and handles cancellation/input shielding. */
export class LoadingReveal {
  readonly durationMs: number;
  private readonly target?: HTMLElement;
  private readonly origin?: { x: number; y: number };
  private readonly originalFilter?: InlineProperty;
  private readonly originalWillChange?: InlineProperty;
  private readonly baseFilter: string;
  private targetChanged = false;
  private disposed = false;

  constructor(
    private readonly curtain: HTMLElement,
    private readonly kind: LoadingTransitionKind,
    options: { target?: HTMLElement; origin?: { x: number; y: number } } = {},
  ) {
    this.durationMs = catalogue[kind].durationMs;
    this.target = options.target;
    this.origin = options.origin ? { ...options.origin } : undefined;
    this.baseFilter = '';
    if (kind === 'focus' && this.target) {
      const style = this.target.style;
      this.originalFilter = { value: style.getPropertyValue('filter'), priority: style.getPropertyPriority('filter') };
      this.originalWillChange = { value: style.getPropertyValue('will-change'), priority: style.getPropertyPriority('will-change') };
      const filter = this.target.ownerDocument.defaultView?.getComputedStyle(this.target).filter
        || this.originalFilter.value;
      this.baseFilter = filter && filter !== 'none' ? `${filter} ` : '';
    }
    this.update(0);
  }

  update(progress: number): void {
    if (this.disposed) return;
    const p = clamp(progress, 0, 1);
    if (p === 1) {
      this.curtain.style.opacity = '0';
      this.clearMask();
      this.restoreTarget();
      return;
    }

    if (this.kind === 'focus') {
      this.clearMask();
      this.curtain.style.opacity = String(1 - smoothstep(0.02, 0.5, p));
      this.updateFocus(p);
      return;
    }
    if (this.kind === 'fade') {
      this.clearMask();
      this.curtain.style.opacity = String(1 - smoothstep(0, 1, p));
      return;
    }

    this.curtain.style.opacity = '1';
    if (p === 0) {
      this.clearMask();
      return;
    }
    const rect = this.curtain.getBoundingClientRect();
    const width = Math.max(0, rect.width);
    const height = Math.max(0, rect.height);
    if (width === 0 || height === 0) {
      this.clearMask();
      return;
    }
    if (this.kind === 'iris') {
      const cx = Number.isFinite(this.origin?.x) ? clamp(this.origin!.x - rect.left, 0, width) : width / 2;
      const cy = Number.isFinite(this.origin?.y) ? clamp(this.origin!.y - rect.top, 0, height) : height / 2;
      const feather = Math.min(width, height) * catalogue.iris.softness;
      const cornerRadius = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
      const outerRadius = (cornerRadius + feather) * smoothstep(0, 1, p);
      const innerRadius = Math.max(0, outerRadius - feather);
      this.setMask(`radial-gradient(circle at ${cx}px ${cy}px, transparent ${innerRadius}px, #000 ${outerRadius}px)`);
    } else {
      const band = width * catalogue.wipe.softness;
      const left = p * (width + band) - band;
      this.setMask(`linear-gradient(to right, transparent ${left}px, #000 ${left + band}px)`);
    }
  }

  private updateFocus(progress: number): void {
    if (!this.target || !this.originalFilter || !this.originalWillChange) return;
    const config = catalogue.focus;
    const focus = smoothstep(0.1, 0.76 + config.softness, progress);
    const blur = config.maxBlurPx * Math.pow(1 - focus, 1.5);
    const brightness = config.minBrightness + (1 - config.minBrightness) * smoothstep(0.12, 0.72, progress);
    if (!this.targetChanged) {
      const original = this.originalWillChange.value;
      const tokens = original && original !== 'auto' ? original.split(',').map(value => value.trim()) : [];
      if (!tokens.includes('filter')) tokens.push('filter');
      this.target.style.setProperty('will-change', tokens.join(', '), this.originalWillChange.priority);
      this.targetChanged = true;
    }
    this.target.style.setProperty('filter', `${this.baseFilter}blur(${blur}px) brightness(${brightness})`, this.originalFilter.priority);
  }

  private setMask(mask: string): void {
    this.curtain.style.setProperty('mask-image', mask);
    this.curtain.style.setProperty('-webkit-mask-image', mask);
  }

  private clearMask(): void {
    this.curtain.style.removeProperty('mask-image');
    this.curtain.style.removeProperty('-webkit-mask-image');
  }

  private restoreProperty(property: string, original: InlineProperty): void {
    if (original.value) this.target!.style.setProperty(property, original.value, original.priority);
    else this.target!.style.removeProperty(property);
  }

  private restoreTarget(): void {
    if (!this.targetChanged || !this.originalFilter || !this.originalWillChange) return;
    this.restoreProperty('filter', this.originalFilter);
    this.restoreProperty('will-change', this.originalWillChange);
    this.targetChanged = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restoreTarget();
    this.clearMask();
  }
}
