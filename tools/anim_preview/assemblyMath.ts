/**
 * Pure geometry helpers for the manual animation assembly viewport.
 *
 * Coordinate spaces used by this module:
 * - frame: pixels in an individual PNG frame;
 * - stage: pixels in the common assembly/output cell;
 * - viewport: CSS pixels inside the visible canvas.
 */

export interface AssemblyPoint {
  x: number;
  y: number;
}

export interface AssemblySize {
  width: number;
  height: number;
}

export interface AssemblyRect extends AssemblyPoint, AssemblySize {}

export interface StageViewportTransform {
  /** Uniform stage-pixel -> viewport-pixel scale. */
  scale: number;
  /** Viewport-space origin of stage coordinate (0, 0). */
  offset: AssemblyPoint;
  /** Stage bounds after fitting, expressed in viewport coordinates. */
  viewportRect: AssemblyRect;
}

export interface FramePlacement extends AssemblyPoint {
  width: number;
  height: number;
}

const EPSILON = 1e-9;

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function positive(value: number, label: string): number {
  finite(value, label);
  if (value <= 0) throw new Error(`${label} must be > 0`);
  return value;
}

export function clamp(value: number, min: number, max: number): number {
  finite(value, 'value');
  finite(min, 'min');
  finite(max, 'max');
  if (min > max) throw new Error('clamp min must be <= max');
  return Math.min(max, Math.max(min, value));
}

/** Clamp a scrub position. Unlike playback wrapping, phase=1 means the last frame. */
export function clampPhase(phase: number): number {
  return clamp(finite(phase, 'phase'), 0, 1);
}

/** Wrap a playback position into [0, 1). */
export function wrapPhase(phase: number): number {
  finite(phase, 'phase');
  const wrapped = phase % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

/**
 * Resolve a frame from a shared normalized phase. Actions may have different
 * frame counts, but all of them observe the same 0..1 progress.
 */
export function phaseToFrameIndex(phase: number, frameCount: number): number {
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new Error('frameCount must be a non-negative integer');
  }
  if (frameCount === 0) return -1;
  if (frameCount === 1) return 0;
  const clamped = clampPhase(phase);
  if (clamped >= 1) return frameCount - 1;
  return Math.min(frameCount - 1, Math.floor(clamped * frameCount));
}

/** Fit a common stage into a viewport pane without changing its aspect ratio. */
export function fitStageIntoRect(
  stage: AssemblySize,
  pane: AssemblyRect,
  padding = 0,
): StageViewportTransform {
  positive(stage.width, 'stage.width');
  positive(stage.height, 'stage.height');
  positive(pane.width, 'pane.width');
  positive(pane.height, 'pane.height');
  finite(pane.x, 'pane.x');
  finite(pane.y, 'pane.y');
  finite(padding, 'padding');

  const safePadding = Math.max(0, Math.min(padding, Math.min(pane.width, pane.height) / 2 - EPSILON));
  const availableWidth = Math.max(EPSILON, pane.width - safePadding * 2);
  const availableHeight = Math.max(EPSILON, pane.height - safePadding * 2);
  const scale = Math.min(availableWidth / stage.width, availableHeight / stage.height);
  const width = stage.width * scale;
  const height = stage.height * scale;
  const x = pane.x + (pane.width - width) / 2;
  const y = pane.y + (pane.height - height) / 2;

  return {
    scale,
    offset: { x, y },
    viewportRect: { x, y, width, height },
  };
}

export function stageToViewport(
  point: AssemblyPoint,
  transform: StageViewportTransform,
): AssemblyPoint {
  return {
    x: transform.offset.x + point.x * transform.scale,
    y: transform.offset.y + point.y * transform.scale,
  };
}

export function viewportToStage(
  point: AssemblyPoint,
  transform: StageViewportTransform,
): AssemblyPoint {
  positive(transform.scale, 'transform.scale');
  return {
    x: (point.x - transform.offset.x) / transform.scale,
    y: (point.y - transform.offset.y) / transform.scale,
  };
}

/** Convert a browser client coordinate into CSS pixels local to an element. */
export function clientToLocalPoint(
  client: AssemblyPoint,
  elementBounds: Pick<AssemblyRect, 'x' | 'y' | 'width' | 'height'>,
): AssemblyPoint {
  finite(elementBounds.x, 'elementBounds.x');
  finite(elementBounds.y, 'elementBounds.y');
  return {
    x: client.x - elementBounds.x,
    y: client.y - elementBounds.y,
  };
}

export function isPointInRect(point: AssemblyPoint, rect: AssemblyRect): boolean {
  return point.x >= rect.x
    && point.y >= rect.y
    && point.x <= rect.x + rect.width
    && point.y <= rect.y + rect.height;
}

export function hitTestPoint(
  pointer: AssemblyPoint,
  handle: AssemblyPoint,
  radius: number,
): boolean {
  if (radius < 0 || !Number.isFinite(radius)) throw new Error('radius must be finite and >= 0');
  const dx = pointer.x - handle.x;
  const dy = pointer.y - handle.y;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Locate a frame on the common stage. The same sourceRoot and uniform scale are
 * intentionally used for every frame in an action.
 */
export function placeFrameAtRoot(
  frameSize: AssemblySize,
  sourceRoot: AssemblyPoint,
  targetRoot: AssemblyPoint,
  uniformScale: number,
): FramePlacement {
  positive(frameSize.width, 'frameSize.width');
  positive(frameSize.height, 'frameSize.height');
  positive(uniformScale, 'uniformScale');
  finite(sourceRoot.x, 'sourceRoot.x');
  finite(sourceRoot.y, 'sourceRoot.y');
  finite(targetRoot.x, 'targetRoot.x');
  finite(targetRoot.y, 'targetRoot.y');
  return {
    x: targetRoot.x - sourceRoot.x * uniformScale,
    y: targetRoot.y - sourceRoot.y * uniformScale,
    width: frameSize.width * uniformScale,
    height: frameSize.height * uniformScale,
  };
}

/** A direct target-root drag follows the pointer in stage space. */
export function targetRootAfterDrag(
  initialRoot: AssemblyPoint,
  stageDelta: AssemblyPoint,
): AssemblyPoint {
  return {
    x: initialRoot.x + stageDelta.x,
    y: initialRoot.y + stageDelta.y,
  };
}

/**
 * Source-root editing is presented as dragging the action artwork beneath a
 * fixed shared target. Moving the artwork right/down therefore moves the source
 * root left/up in frame pixels. No per-frame offset is introduced.
 */
export function sourceRootAfterArtworkDrag(
  initialRoot: AssemblyPoint,
  stageDelta: AssemblyPoint,
  uniformScale: number,
): AssemblyPoint {
  positive(uniformScale, 'uniformScale');
  return {
    x: initialRoot.x - stageDelta.x / uniformScale,
    y: initialRoot.y - stageDelta.y / uniformScale,
  };
}

/**
 * Split a viewport into stable row-major panes. The pane count, not action
 * visibility, determines layout so toggling visibility does not move handles.
 */
export function createSplitRects(
  bounds: AssemblyRect,
  count: number,
  gap = 8,
): AssemblyRect[] {
  if (!Number.isInteger(count) || count < 0) throw new Error('count must be a non-negative integer');
  if (count === 0) return [];
  positive(bounds.width, 'bounds.width');
  positive(bounds.height, 'bounds.height');
  finite(bounds.x, 'bounds.x');
  finite(bounds.y, 'bounds.y');
  if (!Number.isFinite(gap) || gap < 0) throw new Error('gap must be finite and >= 0');

  const aspect = bounds.width / bounds.height;
  const columns = Math.max(1, Math.min(count, Math.ceil(Math.sqrt(count * aspect))));
  const rows = Math.ceil(count / columns);
  const horizontalGapLimit = columns > 1 ? bounds.width / (columns - 1) : gap;
  const verticalGapLimit = rows > 1 ? bounds.height / (rows - 1) : gap;
  const safeGap = Math.min(gap, horizontalGapLimit, verticalGapLimit);
  const cellWidth = Math.max(EPSILON, (bounds.width - safeGap * (columns - 1)) / columns);
  const cellHeight = Math.max(EPSILON, (bounds.height - safeGap * (rows - 1)) / rows);

  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: bounds.x + column * (cellWidth + safeGap),
      y: bounds.y + row * (cellHeight + safeGap),
      width: cellWidth,
      height: cellHeight,
    };
  });
}
