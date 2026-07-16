import {
  clamp,
  clientToLocalPoint,
  createSplitRects,
  fitStageIntoRect,
  hitTestPoint,
  isPointInRect,
  phaseToFrameIndex,
  placeFrameAtRoot,
  sourceRootAfterArtworkDrag,
  stageToViewport,
  targetRootAfterDrag,
  viewportToStage,
  wrapPhase,
  type AssemblyPoint,
  type AssemblyRect,
  type AssemblySize,
  type StageViewportTransform,
} from './assemblyMath';

export type AssemblyViewMode = 'overlay' | 'split' | 'transition';

export interface AssemblyWorldSize {
  width: number;
  height: number;
}

export interface AssemblyFrameArtifact {
  /** Browser-loadable PNG artifact URL. */
  url: string;
  /** Revoke this URL when it leaves the viewport. Use only for caller-created object URLs. */
  revokeOnRelease?: boolean;
}

export type AssemblyFrameSource = string | AssemblyFrameArtifact;

export interface AssemblyActionInput {
  id: string;
  label?: string;
  frames: readonly AssemblyFrameSource[];
  /** One manually chosen root in source-frame pixels, shared by every frame. */
  sourceRoot: AssemblyPoint;
  /** One manual uniform scale shared by every frame. */
  scale: number;
  visible?: boolean;
  opacity?: number;
  /** Preview-only CSS color. It is never written into frame pixels or output metadata. */
  tint?: string | null;
  /** Preview-only tint overlay strength in [0, 1]. */
  tintStrength?: number;
}

export interface AssemblyTransition {
  fromActionId: string;
  toActionId: string;
  /** Paused hard-cut side in [0, 1]: values below .5 show from, otherwise to. */
  mix: number;
}

export type AssemblyEditHandle =
  | { kind: 'none' }
  | { kind: 'targetRoot' }
  | { kind: 'sourceRoot'; actionId: string };

export interface AssemblyViewportOptions {
  canvas: HTMLCanvasElement;
  /** Common assembly/output cell in pixels. */
  stageSize: AssemblySize;
  /** Shared destination root in stage pixels. */
  targetRoot: AssemblyPoint;
  /** Role-level runtime metadata. It drives only the world-unit reference overlay, never frame resampling. */
  worldSize: AssemblyWorldSize;
  actions: readonly AssemblyActionInput[];
  mode?: AssemblyViewMode;
  transition?: AssemblyTransition;
  /** Seconds for one shared normalized 0..1 pass. */
  durationSeconds?: number;
  playbackRate?: number;
  autoplay?: boolean;
  phase?: number;
  editHandle?: AssemblyEditHandle;
  checkerSize?: number;
  checkerEnabled?: boolean;
  paneGap?: number;
  stagePadding?: number;
  rootHitRadius?: number;
  imageSmoothingEnabled?: boolean;
  autoResize?: boolean;
  onChange?: (event: AssemblyViewportChangeEvent) => void;
  onLoadError?: (error: AssemblyFrameLoadError) => void;
}

export type AssemblyChangeReason =
  | 'phase'
  | 'playback'
  | 'mode'
  | 'transition'
  | 'target-root'
  | 'source-root'
  | 'action-scale'
  | 'preview'
  | 'world-size'
  | 'stage-size'
  | 'actions';

export interface AssemblyViewportChangeEvent {
  reason: AssemblyChangeReason;
  snapshot: AssemblyViewportSnapshot;
  actionId?: string;
  interactive?: boolean;
}

export interface AssemblyFrameLoadError {
  actionId: string;
  frameIndex: number;
  url: string;
  message: string;
}

export interface AssemblyLoadReport {
  loaded: number;
  failed: AssemblyFrameLoadError[];
}

export interface AssemblyActionSnapshot {
  id: string;
  label: string;
  frameCount: number;
  sourceRoot: AssemblyPoint;
  scale: number;
  visible: boolean;
  opacity: number;
  tint: string | null;
  tintStrength: number;
}

export interface AssemblyViewportSnapshot {
  stageSize: AssemblySize;
  targetRoot: AssemblyPoint;
  /** Runtime metadata: absent from placement math, visible through the world-unit reference overlay. */
  worldSize: AssemblyWorldSize;
  actions: AssemblyActionSnapshot[];
  mode: AssemblyViewMode;
  transition: AssemblyTransition | null;
  durationSeconds: number;
  playbackRate: number;
  phase: number;
  playing: boolean;
  editHandle: AssemblyEditHandle;
}

export interface AssemblyHandleHit {
  handle: Exclude<AssemblyEditHandle, { kind: 'none' }>;
  actionId?: string;
  paneIndex: number;
  viewportPoint: AssemblyPoint;
  stagePoint: AssemblyPoint;
}

interface NormalizedFrameArtifact {
  url: string;
  revokeOnRelease: boolean;
}

interface LoadedFrame {
  artifact: NormalizedFrameArtifact;
  image: HTMLImageElement | null;
  error: string | null;
}

interface MutableAction {
  id: string;
  label: string;
  frames: LoadedFrame[];
  sourceRoot: AssemblyPoint;
  scale: number;
  visible: boolean;
  opacity: number;
  tint: string | null;
  tintStrength: number;
}

interface Pane {
  index: number;
  actionId: string | null;
  rect: AssemblyRect;
  transform: StageViewportTransform;
}

interface ActiveDrag {
  pointerId: number;
  handle: Exclude<AssemblyEditHandle, { kind: 'none' }>;
  actionId?: string;
  pane: Pane;
  startStagePoint: AssemblyPoint;
  initialTargetRoot: AssemblyPoint;
  initialSourceRoot?: AssemblyPoint;
  pointerViewport: AssemblyPoint;
}

const ACTION_GUIDE_COLORS = ['#58a6ff', '#f97316', '#34d399', '#e879f9', '#facc15', '#22d3ee', '#fb7185'];

function copyPoint(point: AssemblyPoint): AssemblyPoint {
  return { x: point.x, y: point.y };
}

function copySize(size: AssemblySize): AssemblySize {
  return { width: size.width, height: size.height };
}

function assertFinitePoint(point: AssemblyPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${label} must contain finite x/y values`);
  }
}

function assertPositiveSize(size: AssemblySize, label: string): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)
    || size.width <= 0 || size.height <= 0) {
    throw new Error(`${label} width/height must be finite and > 0`);
  }
}

function normalizeFrame(source: AssemblyFrameSource): NormalizedFrameArtifact {
  if (typeof source === 'string') {
    if (!source) throw new Error('frame URL must not be empty');
    return { url: source, revokeOnRelease: false };
  }
  if (!source.url) throw new Error('frame URL must not be empty');
  return { url: source.url, revokeOnRelease: source.revokeOnRelease === true };
}

function cloneEditHandle(handle: AssemblyEditHandle): AssemblyEditHandle {
  return handle.kind === 'sourceRoot' ? { kind: 'sourceRoot', actionId: handle.actionId } : { kind: handle.kind };
}

function safeCallback(callback: (() => void) | undefined, label = 'AssemblyViewport callback'): void {
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    console.error(label, error);
  }
}

/**
 * Human-operated R-stage renderer. It owns only preview resources and never
 * infers roots, changes frame geometry, persists data, or invokes an agent.
 */
export class AssemblyViewport {
  readonly canvas: HTMLCanvasElement;
  readonly ready: Promise<AssemblyLoadReport>;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly onChange?: AssemblyViewportOptions['onChange'];
  private readonly onLoadError?: AssemblyViewportOptions['onLoadError'];
  private readonly pendingLoadCancels = new Set<() => void>();
  private readonly revokedObjectUrls = new Set<string>();
  private readonly resizeObserver: ResizeObserver | null;
  private readonly boundPointerDown: (event: PointerEvent) => void;
  private readonly boundPointerMove: (event: PointerEvent) => void;
  private readonly boundPointerUp: (event: PointerEvent) => void;
  private readonly previousTouchAction: string;
  private readonly previousCursor: string;

  private stageSize: AssemblySize;
  private targetRoot: AssemblyPoint;
  private worldSize: AssemblyWorldSize;
  private actions: MutableAction[] = [];
  private mode: AssemblyViewMode;
  private transition: AssemblyTransition | null;
  private durationSeconds: number;
  private playbackRate: number;
  private phase: number;
  private playing: boolean;
  private editHandle: AssemblyEditHandle;
  private checkerSize: number;
  private checkerEnabled: boolean;
  private paneGap: number;
  private stagePadding: number;
  private rootHitRadius: number;
  private imageSmoothingEnabled: boolean;
  private loadEpoch = 0;
  private animationFrameId: number | null = null;
  private lastAnimationTime: number | null = null;
  private renderQueued = false;
  private destroyed = false;
  private activeDrag: ActiveDrag | null = null;
  private scratchCanvas: HTMLCanvasElement | null = null;
  private latestLoadReport: AssemblyLoadReport = { loaded: 0, failed: [] };

  constructor(options: AssemblyViewportOptions) {
    this.canvas = options.canvas;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('AssemblyViewport requires a Canvas2D context');
    this.ctx = context;

    assertPositiveSize(options.stageSize, 'stageSize');
    assertFinitePoint(options.targetRoot, 'targetRoot');
    assertPositiveSize(options.worldSize, 'worldSize');
    this.stageSize = copySize(options.stageSize);
    this.targetRoot = {
      x: clamp(options.targetRoot.x, 0, options.stageSize.width),
      y: clamp(options.targetRoot.y, 0, options.stageSize.height),
    };
    this.worldSize = copySize(options.worldSize);
    this.mode = options.mode ?? 'overlay';
    this.transition = options.transition ? { ...options.transition, mix: clamp(options.transition.mix, 0, 1) } : null;
    this.durationSeconds = options.durationSeconds ?? 1;
    this.playbackRate = options.playbackRate ?? 1;
    this.phase = clamp(options.phase ?? 0, 0, 1);
    this.playing = options.autoplay ?? true;
    this.editHandle = cloneEditHandle(options.editHandle ?? { kind: 'none' });
    this.checkerSize = options.checkerSize ?? 16;
    this.checkerEnabled = options.checkerEnabled ?? true;
    this.paneGap = options.paneGap ?? 8;
    this.stagePadding = options.stagePadding ?? 24;
    this.rootHitRadius = options.rootHitRadius ?? 14;
    this.imageSmoothingEnabled = options.imageSmoothingEnabled ?? true;
    this.onChange = options.onChange;
    this.onLoadError = options.onLoadError;
    this.validateRuntimeOptions();

    this.boundPointerDown = (event) => this.handlePointerDown(event);
    this.boundPointerMove = (event) => this.handlePointerMove(event);
    this.boundPointerUp = (event) => this.handlePointerUp(event);
    this.previousTouchAction = this.canvas.style.touchAction;
    this.previousCursor = this.canvas.style.cursor;
    this.canvas.style.touchAction = 'none';
    this.updateCursor();
    this.canvas.addEventListener('pointerdown', this.boundPointerDown);
    this.canvas.addEventListener('pointermove', this.boundPointerMove);
    this.canvas.addEventListener('pointerup', this.boundPointerUp);
    this.canvas.addEventListener('pointercancel', this.boundPointerUp);

    if ((options.autoResize ?? true) && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      // Watching the container avoids a feedback loop when backing dimensions
      // affect an otherwise unstyled canvas's intrinsic CSS dimensions.
      this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    } else {
      this.resizeObserver = null;
    }

    this.resize();
    this.ready = this.setActions(options.actions, false);
    if (this.playing) this.startAnimationLoop();
  }

  static async create(options: AssemblyViewportOptions): Promise<AssemblyViewport> {
    const viewport = new AssemblyViewport(options);
    await viewport.ready;
    return viewport;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Most recent completed frame-load result, retained for review gating. */
  get loadReport(): AssemblyLoadReport {
    return {
      loaded: this.latestLoadReport.loaded,
      failed: this.latestLoadReport.failed.map((failure) => ({ ...failure })),
    };
  }

  get snapshot(): AssemblyViewportSnapshot {
    return {
      stageSize: copySize(this.stageSize),
      targetRoot: copyPoint(this.targetRoot),
      worldSize: copySize(this.worldSize),
      actions: this.actions.map((action) => ({
        id: action.id,
        label: action.label,
        frameCount: action.frames.length,
        sourceRoot: copyPoint(action.sourceRoot),
        scale: action.scale,
        visible: action.visible,
        opacity: action.opacity,
        tint: action.tint,
        tintStrength: action.tintStrength,
      })),
      mode: this.mode,
      transition: this.transition ? { ...this.transition } : null,
      durationSeconds: this.durationSeconds,
      playbackRate: this.playbackRate,
      phase: this.phase,
      playing: this.playing,
      editHandle: cloneEditHandle(this.editHandle),
    };
  }

  async setActions(inputs: readonly AssemblyActionInput[], emit = true): Promise<AssemblyLoadReport> {
    this.assertAlive();
    const ids = new Set<string>();
    for (const input of inputs) {
      if (!input.id) throw new Error('action id must not be empty');
      if (ids.has(input.id)) throw new Error(`duplicate action id: ${input.id}`);
      ids.add(input.id);
      if (input.frames.length === 0) throw new Error(`action ${input.id} must contain at least one PNG frame URL`);
      assertFinitePoint(input.sourceRoot, `action ${input.id} sourceRoot`);
      if (!Number.isFinite(input.scale) || input.scale <= 0) throw new Error(`action ${input.id} scale must be > 0`);
    }
    if (this.editHandle.kind === 'sourceRoot' && !ids.has(this.editHandle.actionId)) {
      throw new Error(`editHandle references an action absent from the new action set: ${this.editHandle.actionId}`);
    }
    if (this.transition
      && (!ids.has(this.transition.fromActionId) || !ids.has(this.transition.toActionId))) {
      throw new Error('transition references an action absent from the new action set');
    }

    const nextActions: MutableAction[] = inputs.map((input) => ({
      id: input.id,
      label: input.label ?? input.id,
      frames: input.frames.map((source) => ({ artifact: normalizeFrame(source), image: null, error: null })),
      sourceRoot: copyPoint(input.sourceRoot),
      scale: input.scale,
      visible: input.visible ?? true,
      opacity: clamp(input.opacity ?? 1, 0, 1),
      tint: input.tint ?? null,
      tintStrength: clamp(input.tintStrength ?? 0.22, 0, 1),
    }));

    const epoch = ++this.loadEpoch;
    const retainedOwnedUrls = new Set(nextActions.flatMap((action) => action.frames
      .filter((frame) => frame.artifact.revokeOnRelease)
      .map((frame) => frame.artifact.url)));
    this.releaseActions(retainedOwnedUrls);
    this.actions = nextActions;
    this.requestRender();

    const failures: AssemblyFrameLoadError[] = [];
    let loaded = 0;
    const loads = this.actions.flatMap((action) => action.frames.map(async (frame, frameIndex) => {
      const result = await this.loadFrame(frame.artifact);
      if (epoch !== this.loadEpoch || this.destroyed) {
        this.releaseImage(result.image);
        return;
      }
      frame.image = result.image;
      frame.error = result.error;
      if (result.image) {
        loaded += 1;
      } else if (result.error !== 'cancelled') {
        const failure = { actionId: action.id, frameIndex, url: frame.artifact.url, message: result.error };
        failures.push(failure);
        safeCallback(
          this.onLoadError ? () => this.onLoadError?.(failure) : undefined,
          'AssemblyViewport onLoadError',
        );
      }
      this.requestRender();
    }));
    await Promise.all(loads);

    const report = { loaded, failed: failures };
    if (epoch === this.loadEpoch && !this.destroyed) {
      this.latestLoadReport = {
        loaded,
        failed: failures.map((failure) => ({ ...failure })),
      };
      if (emit) this.emitChange('actions');
    }
    return report;
  }

  setMode(mode: AssemblyViewMode): void {
    this.assertAlive();
    if (this.mode === mode) return;
    this.mode = mode;
    this.emitChange('mode');
    this.requestRender();
  }

  setTransition(transition: AssemblyTransition | null): void {
    this.assertAlive();
    if (transition) {
      this.requireAction(transition.fromActionId);
      this.requireAction(transition.toActionId);
      if (transition.fromActionId === transition.toActionId) {
        throw new Error('transition actions must be distinct');
      }
    }
    this.transition = transition ? { ...transition, mix: clamp(transition.mix, 0, 1) } : null;
    this.emitChange('transition');
    this.requestRender();
  }

  setEditHandle(handle: AssemblyEditHandle): void {
    this.assertAlive();
    if (handle.kind === 'sourceRoot') this.requireAction(handle.actionId);
    this.editHandle = cloneEditHandle(handle);
    this.activeDrag = null;
    this.updateCursor();
    this.requestRender();
  }

  setTargetRoot(root: AssemblyPoint, interactive = false): void {
    this.assertAlive();
    assertFinitePoint(root, 'targetRoot');
    this.targetRoot = {
      x: clamp(root.x, 0, this.stageSize.width),
      y: clamp(root.y, 0, this.stageSize.height),
    };
    this.emitChange('target-root', undefined, interactive);
    this.requestRender();
  }

  setActionTransform(
    actionId: string,
    transform: { sourceRoot?: AssemblyPoint; scale?: number },
    interactive = false,
  ): void {
    this.assertAlive();
    const action = this.requireAction(actionId);
    let reason: AssemblyChangeReason | null = null;
    if (transform.sourceRoot) {
      assertFinitePoint(transform.sourceRoot, `action ${actionId} sourceRoot`);
      action.sourceRoot = copyPoint(transform.sourceRoot);
      reason = 'source-root';
    }
    if (transform.scale !== undefined) {
      if (!Number.isFinite(transform.scale) || transform.scale <= 0) {
        throw new Error(`action ${actionId} scale must be finite and > 0`);
      }
      action.scale = transform.scale;
      reason = reason ?? 'action-scale';
    }
    if (!reason) return;
    this.emitChange(reason, actionId, interactive);
    this.requestRender();
  }

  setActionPreview(
    actionId: string,
    preview: { visible?: boolean; opacity?: number; tint?: string | null; tintStrength?: number },
  ): void {
    this.assertAlive();
    const action = this.requireAction(actionId);
    if (preview.visible !== undefined) action.visible = preview.visible;
    if (preview.opacity !== undefined) action.opacity = clamp(preview.opacity, 0, 1);
    if (preview.tint !== undefined) action.tint = preview.tint;
    if (preview.tintStrength !== undefined) action.tintStrength = clamp(preview.tintStrength, 0, 1);
    this.emitChange('preview', actionId);
    this.requestRender();
  }

  setWorldSize(worldSize: AssemblyWorldSize): void {
    this.assertAlive();
    assertPositiveSize(worldSize, 'worldSize');
    this.worldSize = copySize(worldSize);
    // Never alter frame placement/resampling. The reference grid redraws so the
    // human can see how large this fixed artwork quad is in shared world units.
    this.emitChange('world-size');
    this.requestRender();
  }

  setStageSize(stageSize: AssemblySize): void {
    this.assertAlive();
    assertPositiveSize(stageSize, 'stageSize');
    this.stageSize = copySize(stageSize);
    this.targetRoot = {
      x: clamp(this.targetRoot.x, 0, this.stageSize.width),
      y: clamp(this.targetRoot.y, 0, this.stageSize.height),
    };
    this.emitChange('stage-size');
    this.requestRender();
  }

  setDurationSeconds(durationSeconds: number): void {
    this.assertAlive();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('durationSeconds must be finite and > 0');
    }
    this.durationSeconds = durationSeconds;
    this.emitChange('playback');
  }

  setPlaybackRate(playbackRate: number): void {
    this.assertAlive();
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
      throw new Error('playbackRate must be finite and > 0');
    }
    this.playbackRate = playbackRate;
    this.emitChange('playback');
  }

  setCheckerEnabled(enabled: boolean): void {
    this.assertAlive();
    this.checkerEnabled = Boolean(enabled);
    this.requestRender();
  }

  play(): void {
    this.assertAlive();
    if (this.playing) return;
    if (this.phase >= 1) this.phase = 0;
    this.playing = true;
    this.lastAnimationTime = null;
    this.emitChange('playback');
    this.startAnimationLoop();
  }

  pause(): void {
    this.assertAlive();
    if (!this.playing) return;
    this.playing = false;
    this.lastAnimationTime = null;
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;
    this.emitChange('playback');
    this.requestRender();
  }

  togglePlayback(): void {
    if (this.playing) this.pause(); else this.play();
  }

  /** Scrub every action to the same normalized phase. */
  scrub(phase: number): void {
    this.setPhase(phase);
  }

  setPhase(phase: number): void {
    this.assertAlive();
    this.phase = clamp(phase, 0, 1);
    this.emitChange('phase');
    this.requestRender();
  }

  /** Public hit test for external toolbars or custom pointer controllers. */
  hitTestHandle(clientX: number, clientY: number): AssemblyHandleHit | null {
    this.assertAlive();
    if (this.editHandle.kind === 'none') return null;
    const editHandle = this.editHandle;
    const point = this.clientToViewport({ x: clientX, y: clientY });
    const panes = this.getPanes();
    const candidatePanes = this.mode === 'split'
      ? panes.filter((pane) => pane.actionId === null || editHandle.kind === 'targetRoot'
        || pane.actionId === editHandle.actionId)
      : panes;

    for (const pane of candidatePanes) {
      if (!isPointInRect(point, pane.rect)) continue;
      const handlePoint = stageToViewport(this.targetRoot, pane.transform);
      if (!hitTestPoint(point, handlePoint, this.rootHitRadius)) continue;
      return {
        handle: cloneEditHandle(editHandle) as Exclude<AssemblyEditHandle, { kind: 'none' }>,
        actionId: editHandle.kind === 'sourceRoot' ? editHandle.actionId : undefined,
        paneIndex: pane.index,
        viewportPoint: point,
        stagePoint: viewportToStage(point, pane.transform),
      };
    }
    return null;
  }

  /** Reconcile backing pixels to CSS size and current device pixel ratio. */
  resize(): void {
    if (this.destroyed) return;
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width || this.canvas.width || this.stageSize.width);
    const cssHeight = Math.max(1, rect.height || this.canvas.height || this.stageSize.height);
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.requestRender();
  }

  render(): void {
    this.assertAlive();
    this.renderQueued = false;
    const { width, height, dpr } = this.viewportMetrics();
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, width, height);
    if (this.checkerEnabled) this.drawChecker({ x: 0, y: 0, width, height });
    else {
      this.ctx.fillStyle = '#101722';
      this.ctx.fillRect(0, 0, width, height);
    }

    const panes = this.getPanes();
    if (this.mode === 'split') {
      panes.forEach((pane) => this.drawSplitPane(pane));
    } else {
      const pane = panes[0];
      if (pane) this.drawCombinedPane(pane);
    }
    this.drawActiveDragGhost();
  }

  /**
   * Release RAF, observers, DOM listeners, Images and owned object URLs. The
   * instance is terminal after destroy(); construct a new one to reinitialize.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadEpoch += 1;
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;
    this.lastAnimationTime = null;
    this.renderQueued = false;
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.boundPointerDown);
    this.canvas.removeEventListener('pointermove', this.boundPointerMove);
    this.canvas.removeEventListener('pointerup', this.boundPointerUp);
    this.canvas.removeEventListener('pointercancel', this.boundPointerUp);
    this.canvas.style.touchAction = this.previousTouchAction;
    this.canvas.style.cursor = this.previousCursor;
    if (this.activeDrag && this.canvas.hasPointerCapture(this.activeDrag.pointerId)) {
      this.canvas.releasePointerCapture(this.activeDrag.pointerId);
    }
    this.activeDrag = null;
    this.releaseActions();
    this.scratchCanvas = null;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private validateRuntimeOptions(): void {
    if (!Number.isFinite(this.durationSeconds) || this.durationSeconds <= 0) {
      throw new Error('durationSeconds must be finite and > 0');
    }
    if (!Number.isFinite(this.playbackRate) || this.playbackRate <= 0) {
      throw new Error('playbackRate must be finite and > 0');
    }
    for (const [value, label] of [
      [this.checkerSize, 'checkerSize'],
      [this.stagePadding, 'stagePadding'],
      [this.rootHitRadius, 'rootHitRadius'],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and > 0`);
    }
    if (!Number.isFinite(this.paneGap) || this.paneGap < 0) throw new Error('paneGap must be finite and >= 0');
  }

  private requireAction(actionId: string): MutableAction {
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new Error(`unknown action: ${actionId}`);
    return action;
  }

  private updateCursor(): void {
    this.canvas.style.cursor = this.editHandle.kind === 'none' ? 'default' : 'grab';
  }

  private emitChange(reason: AssemblyChangeReason, actionId?: string, interactive = false): void {
    safeCallback(
      this.onChange ? () => this.onChange?.({ reason, snapshot: this.snapshot, actionId, interactive }) : undefined,
      'AssemblyViewport onChange',
    );
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('AssemblyViewport has been destroyed');
  }

  private viewportMetrics(): { width: number; height: number; dpr: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    return {
      width: Math.max(1, rect.width || this.canvas.width / dpr),
      height: Math.max(1, rect.height || this.canvas.height / dpr),
      dpr,
    };
  }

  private clientToViewport(client: AssemblyPoint): AssemblyPoint {
    const rect = this.canvas.getBoundingClientRect();
    return clientToLocalPoint(client, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }

  private getPanes(): Pane[] {
    const { width, height } = this.viewportMetrics();
    const bounds = { x: 0, y: 0, width, height };
    if (this.mode !== 'split') {
      return [{ index: 0, actionId: null, rect: bounds, transform: fitStageIntoRect(this.stageSize, bounds, this.stagePadding) }];
    }
    return createSplitRects(bounds, this.actions.length, this.paneGap).map((rect, index) => ({
      index,
      actionId: this.actions[index]?.id ?? null,
      rect,
      transform: fitStageIntoRect(this.stageSize, rect, Math.min(this.stagePadding, 18)),
    }));
  }

  private requestRender(): void {
    if (this.destroyed || this.renderQueued || this.playing) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      if (!this.destroyed) this.render();
    });
  }

  private startAnimationLoop(): void {
    if (this.destroyed || !this.playing || this.animationFrameId !== null) return;
    this.animationFrameId = requestAnimationFrame((time) => this.animate(time));
  }

  private animate(time: number): void {
    this.animationFrameId = null;
    if (this.destroyed || !this.playing) return;
    if (this.lastAnimationTime !== null) {
      const dt = Math.min(0.25, Math.max(0, (time - this.lastAnimationTime) / 1000));
      this.phase = wrapPhase(this.phase + (dt * this.playbackRate) / this.durationSeconds);
    }
    this.lastAnimationTime = time;
    this.render();
    this.startAnimationLoop();
  }

  private async loadFrame(artifact: NormalizedFrameArtifact): Promise<{ image: HTMLImageElement | null; error: string }> {
    return new Promise((resolve) => {
      const image = new Image();
      image.decoding = 'async';
      let settled = false;
      const finish = (result: { image: HTMLImageElement | null; error: string }) => {
        if (settled) return;
        settled = true;
        this.pendingLoadCancels.delete(cancel);
        image.onload = null;
        image.onerror = null;
        resolve(result);
      };
      const cancel = () => {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute('src');
        finish({ image: null, error: 'cancelled' });
      };
      image.onload = () => finish({ image, error: '' });
      image.onerror = () => finish({ image: null, error: `failed to load PNG: ${artifact.url}` });
      this.pendingLoadCancels.add(cancel);
      image.src = artifact.url;
    });
  }

  private releaseActions(retainOwnedUrls: ReadonlySet<string> = new Set()): void {
    for (const cancel of [...this.pendingLoadCancels]) cancel();
    this.pendingLoadCancels.clear();
    for (const action of this.actions) {
      for (const frame of action.frames) {
        this.releaseImage(frame.image);
        if (frame.artifact.revokeOnRelease
          && !retainOwnedUrls.has(frame.artifact.url)
          && !this.revokedObjectUrls.has(frame.artifact.url)) {
          URL.revokeObjectURL(frame.artifact.url);
          this.revokedObjectUrls.add(frame.artifact.url);
        }
      }
    }
    this.actions = [];
  }

  private releaseImage(image: HTMLImageElement | null): void {
    if (!image) return;
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
  }

  private drawChecker(rect: AssemblyRect): void {
    const size = this.checkerSize;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height);
    this.ctx.clip();
    for (let y = rect.y; y < rect.y + rect.height; y += size) {
      for (let x = rect.x; x < rect.x + rect.width; x += size) {
        const parity = (Math.floor((x - rect.x) / size) + Math.floor((y - rect.y) / size)) & 1;
        this.ctx.fillStyle = parity ? '#232b38' : '#18202b';
        this.ctx.fillRect(x, y, size, size);
      }
    }
    this.ctx.restore();
  }

  private drawCombinedPane(pane: Pane): void {
    this.drawStageBorder(pane);
    this.drawWorldReference(pane);
    if (this.mode === 'transition') {
      const pair = this.resolveTransitionActions();
      if (pair) {
        const showTo = this.playing
          ? Math.floor(performance.now() / 250) % 2 === 1
          : pair.mix >= 0.5;
        this.drawAction(showTo ? pair.to : pair.from, pane, 1);
      }
    } else {
      this.actions.forEach((action) => this.drawAction(action, pane, 1));
    }
    this.drawRootGuides(pane, null);
  }

  private drawSplitPane(pane: Pane): void {
    this.drawStageBorder(pane);
    this.drawWorldReference(pane);
    const action = pane.actionId ? this.actions.find((candidate) => candidate.id === pane.actionId) : undefined;
    if (action) this.drawAction(action, pane, 1);
    this.drawRootGuides(pane, action ?? null);
    if (action) {
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(7, 12, 19, 0.78)';
      this.ctx.fillRect(pane.rect.x + 5, pane.rect.y + 5, Math.min(pane.rect.width - 10, 220), 22);
      this.ctx.fillStyle = action.visible ? '#e5edf8' : '#8190a6';
      this.ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(`${action.label}${action.visible ? '' : '（隐藏）'}`, pane.rect.x + 10, pane.rect.y + 16);
      this.ctx.restore();
    }
  }

  private drawStageBorder(pane: Pane): void {
    const rect = pane.transform.viewportRect;
    this.ctx.save();
    this.ctx.strokeStyle = 'rgba(124, 148, 179, 0.45)';
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.width - 1), Math.max(0, rect.height - 1));
    this.ctx.restore();
  }

  private drawWorldReference(pane: Pane): void {
    const rect = pane.transform.viewportRect;
    const worldWidth = Math.max(0.0001, this.worldSize.width);
    const worldHeight = Math.max(0.0001, this.worldSize.height);
    const pixelsPerWorldX = rect.width / worldWidth;
    const pixelsPerWorldY = rect.height / worldHeight;
    const desiredLines = 5;
    const roughStep = worldHeight / desiredLines;
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(roughStep, 0.0001)));
    const normalized = roughStep / magnitude;
    const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(rect.x, rect.y, rect.width, rect.height);
    this.ctx.clip();
    this.ctx.strokeStyle = 'rgba(91, 145, 255, 0.13)';
    this.ctx.lineWidth = 1;
    for (let value = step; value < worldWidth; value += step) {
      const x = rect.x + value * pixelsPerWorldX;
      this.ctx.beginPath();
      this.ctx.moveTo(x, rect.y);
      this.ctx.lineTo(x, rect.y + rect.height);
      this.ctx.stroke();
    }
    for (let value = step; value < worldHeight; value += step) {
      const y = rect.y + rect.height - value * pixelsPerWorldY;
      this.ctx.beginPath();
      this.ctx.moveTo(rect.x, y);
      this.ctx.lineTo(rect.x + rect.width, y);
      this.ctx.stroke();
    }

    const unitHeight = Math.min(rect.height, pixelsPerWorldY);
    const rulerX = rect.x + rect.width - 16;
    const rulerBottom = rect.y + rect.height - 12;
    const rulerTop = rulerBottom - unitHeight;
    this.ctx.strokeStyle = 'rgba(207, 225, 251, 0.82)';
    this.ctx.lineWidth = 1.5;
    this.ctx.beginPath();
    this.ctx.moveTo(rulerX, rulerTop);
    this.ctx.lineTo(rulerX, rulerBottom);
    this.ctx.moveTo(rulerX - 5, rulerTop);
    this.ctx.lineTo(rulerX + 5, rulerTop);
    this.ctx.moveTo(rulerX - 5, rulerBottom);
    this.ctx.lineTo(rulerX + 5, rulerBottom);
    this.ctx.stroke();
    this.ctx.fillStyle = 'rgba(7, 12, 19, 0.78)';
    this.ctx.fillRect(rect.x + 7, rect.y + 7, Math.max(20, Math.min(210, rect.width - 28)), 22);
    this.ctx.fillStyle = '#cfe1fb';
    this.ctx.font = '11px -apple-system, PingFang SC, sans-serif';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(
      `世界尺寸 ${worldWidth.toFixed(2)} × ${worldHeight.toFixed(2)} · 网格 ${step.toFixed(step < 1 ? 2 : 1)}`,
      rect.x + 12,
      rect.y + 18,
      Math.max(20, rect.width - 42),
    );
    this.ctx.save();
    this.ctx.translate(rulerX - 7, (rulerTop + rulerBottom) / 2);
    this.ctx.rotate(-Math.PI / 2);
    this.ctx.textAlign = 'center';
    this.ctx.fillText('1 世界单位', 0, 0, Math.max(36, unitHeight - 8));
    this.ctx.restore();
    this.ctx.restore();
  }

  private drawAction(action: MutableAction, pane: Pane, modeOpacity: number): void {
    if (!action.visible || action.opacity <= 0 || modeOpacity <= 0) return;
    const frameIndex = phaseToFrameIndex(this.phase, action.frames.length);
    const frame = action.frames[frameIndex];
    if (!frame?.image) {
      if (frame?.error) this.drawFrameError(action, pane, frame.error);
      return;
    }
    const image = frame.image;
    const placement = placeFrameAtRoot(
      { width: image.naturalWidth, height: image.naturalHeight },
      action.sourceRoot,
      this.targetRoot,
      action.scale,
    );
    const origin = stageToViewport({ x: placement.x, y: placement.y }, pane.transform);
    const width = placement.width * pane.transform.scale;
    const height = placement.height * pane.transform.scale;

    this.ctx.save();
    const clip = pane.transform.viewportRect;
    this.ctx.beginPath();
    this.ctx.rect(clip.x, clip.y, clip.width, clip.height);
    this.ctx.clip();
    this.ctx.globalAlpha = action.opacity * modeOpacity;
    this.ctx.imageSmoothingEnabled = this.imageSmoothingEnabled;
    if (action.tint && action.tintStrength > 0) {
      const tinted = this.tintFrame(image, action.tint, action.tintStrength);
      this.ctx.drawImage(tinted, origin.x, origin.y, width, height);
    } else {
      this.ctx.drawImage(image, origin.x, origin.y, width, height);
    }
    this.ctx.restore();
  }

  private tintFrame(image: HTMLImageElement, tint: string, strength: number): HTMLCanvasElement {
    const scratch = this.scratchCanvas ?? document.createElement('canvas');
    this.scratchCanvas = scratch;
    if (scratch.width !== image.naturalWidth || scratch.height !== image.naturalHeight) {
      scratch.width = image.naturalWidth;
      scratch.height = image.naturalHeight;
    }
    const context = scratch.getContext('2d');
    if (!context) return scratch;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, scratch.width, scratch.height);
    context.drawImage(image, 0, 0);
    context.globalCompositeOperation = 'source-atop';
    context.globalAlpha = clamp(strength, 0, 1);
    context.fillStyle = tint;
    context.fillRect(0, 0, scratch.width, scratch.height);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    return scratch;
  }

  private drawFrameError(action: MutableAction, pane: Pane, message: string): void {
    this.ctx.save();
    this.ctx.fillStyle = 'rgba(66, 18, 24, 0.86)';
    this.ctx.fillRect(pane.rect.x + 8, pane.rect.y + pane.rect.height - 32, pane.rect.width - 16, 24);
    this.ctx.fillStyle = '#fca5a5';
    this.ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(`${action.label}: ${message}`, pane.rect.x + 14, pane.rect.y + pane.rect.height - 20, pane.rect.width - 28);
    this.ctx.restore();
  }

  private resolveTransitionActions(): { from: MutableAction; to: MutableAction; mix: number } | null {
    const fallback = this.actions.filter((action) => action.visible);
    const from = this.transition
      ? this.actions.find((action) => action.id === this.transition?.fromActionId)
      : fallback[0];
    const to = this.transition
      ? this.actions.find((action) => action.id === this.transition?.toActionId)
      : fallback[1];
    if (!from || !to) return null;
    return { from, to, mix: clamp(this.transition?.mix ?? 0.5, 0, 1) };
  }

  private drawRootGuides(pane: Pane, paneAction: MutableAction | null): void {
    const point = stageToViewport(this.targetRoot, pane.transform);
    const targetSelected = this.editHandle.kind === 'targetRoot';
    this.ctx.save();
    this.ctx.lineWidth = targetSelected ? 2.5 : 1.5;
    this.ctx.strokeStyle = targetSelected ? '#ffdf6e' : '#ff5d73';
    this.ctx.beginPath();
    this.ctx.moveTo(point.x - 13, point.y);
    this.ctx.lineTo(point.x + 13, point.y);
    this.ctx.moveTo(point.x, point.y - 13);
    this.ctx.lineTo(point.x, point.y + 13);
    this.ctx.stroke();
    this.ctx.beginPath();
    this.ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    this.ctx.stroke();

    const actionGuides = paneAction ? [paneAction] : this.actions;
    actionGuides.forEach((action, index) => {
      const selected = this.editHandle.kind === 'sourceRoot' && this.editHandle.actionId === action.id;
      this.ctx.strokeStyle = ACTION_GUIDE_COLORS[this.actions.indexOf(action) % ACTION_GUIDE_COLORS.length] ?? '#58a6ff';
      this.ctx.lineWidth = selected ? 3 : 1;
      this.ctx.beginPath();
      this.ctx.arc(point.x, point.y, 7 + index * 2, 0, Math.PI * 2);
      this.ctx.stroke();
      if (selected) {
        this.ctx.fillStyle = 'rgba(7, 12, 19, 0.84)';
        this.ctx.fillRect(point.x + 10, point.y - 31, 190, 20);
        this.ctx.fillStyle = '#dbeafe';
        this.ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(
          `${action.label} root ${action.sourceRoot.x.toFixed(1)},${action.sourceRoot.y.toFixed(1)} ×${action.scale.toFixed(3)}`,
          point.x + 14,
          point.y - 21,
          182,
        );
      }
    });
    this.ctx.restore();
  }

  private drawActiveDragGhost(): void {
    if (!this.activeDrag) return;
    const start = stageToViewport(this.activeDrag.startStagePoint, this.activeDrag.pane.transform);
    const current = this.activeDrag.pointerViewport;
    this.ctx.save();
    this.ctx.setLineDash([5, 4]);
    this.ctx.lineWidth = 1.5;
    this.ctx.strokeStyle = '#f8fafc';
    this.ctx.beginPath();
    this.ctx.moveTo(start.x, start.y);
    this.ctx.lineTo(current.x, current.y);
    this.ctx.stroke();
    this.ctx.setLineDash([]);
    this.ctx.beginPath();
    this.ctx.arc(current.x, current.y, 5, 0, Math.PI * 2);
    this.ctx.stroke();
    this.ctx.restore();
  }

  private handlePointerDown(event: PointerEvent): void {
    if (this.destroyed || event.button !== 0) return;
    const hit = this.hitTestHandle(event.clientX, event.clientY);
    if (!hit) return;
    const pane = this.getPanes().find((candidate) => candidate.index === hit.paneIndex);
    if (!pane) return;
    const handle = hit.handle;
    const action = handle.kind === 'sourceRoot' ? this.requireAction(handle.actionId) : null;
    this.activeDrag = {
      pointerId: event.pointerId,
      handle,
      actionId: action?.id,
      pane,
      startStagePoint: hit.stagePoint,
      initialTargetRoot: copyPoint(this.targetRoot),
      initialSourceRoot: action ? copyPoint(action.sourceRoot) : undefined,
      pointerViewport: hit.viewportPoint,
    };
    this.canvas.style.cursor = 'grabbing';
    this.canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.requestRender();
  }

  private handlePointerMove(event: PointerEvent): void {
    const drag = this.activeDrag;
    if (!drag || drag.pointerId !== event.pointerId || this.destroyed) return;
    const viewportPoint = this.clientToViewport({ x: event.clientX, y: event.clientY });
    const stagePoint = viewportToStage(viewportPoint, drag.pane.transform);
    const delta = {
      x: stagePoint.x - drag.startStagePoint.x,
      y: stagePoint.y - drag.startStagePoint.y,
    };
    drag.pointerViewport = viewportPoint;
    if (drag.handle.kind === 'targetRoot') {
      const nextRoot = targetRootAfterDrag(drag.initialTargetRoot, delta);
      this.targetRoot = {
        x: clamp(nextRoot.x, 0, this.stageSize.width),
        y: clamp(nextRoot.y, 0, this.stageSize.height),
      };
      this.emitChange('target-root', undefined, true);
    } else if (drag.initialSourceRoot) {
      const action = this.requireAction(drag.handle.actionId);
      action.sourceRoot = sourceRootAfterArtworkDrag(drag.initialSourceRoot, delta, action.scale);
      this.emitChange('source-root', action.id, true);
    }
    event.preventDefault();
    this.requestRender();
  }

  private handlePointerUp(event: PointerEvent): void {
    const drag = this.activeDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.activeDrag = null;
    this.updateCursor();
    event.preventDefault();
    this.requestRender();
  }
}

export type {
  AssemblyPoint,
  AssemblyRect,
  AssemblySize,
  StageViewportTransform,
} from './assemblyMath';
