export interface SequenceReviewerFrame {
  url: string;
  label: string;
  path: string;
}

export interface SequenceOrderSource {
  kind: 'manifest' | 'fallback';
  label: string;
  detail?: string;
}

export interface SequenceReviewerOptions {
  frames: SequenceReviewerFrame[];
  frameRate: number;
  loop: boolean;
  orderSource: SequenceOrderSource;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text) result.textContent = text;
  return result;
}

function clampFrameRate(value: number): number {
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(60, Math.round(value)));
}

/**
 * A disposable, DOM-only frame sequence reviewer. It deliberately owns its
 * requestAnimationFrame lifecycle so changing artifact/revision cannot leave a
 * hidden sequence advancing in the background.
 */
export class SequenceReviewer {
  readonly element: HTMLElement;

  private readonly frames: SequenceReviewerFrame[];
  private readonly stage: HTMLElement;
  private readonly currentImage: HTMLImageElement;
  private readonly frameLabel: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly timeline: HTMLInputElement;
  private readonly fpsInput: HTMLInputElement;
  private readonly loopInput: HTMLInputElement;
  private readonly overlayInput: HTMLInputElement;
  private readonly loadStatus: HTMLElement;
  private readonly preloadImages: HTMLImageElement[];
  private frameIndex = 0;
  private frameRate: number;
  private playing = true;
  private pageActive = true;
  private destroyed = false;
  private animationFrame: number | null = null;
  private lastTimestamp: number | null = null;
  private accumulatorMs = 0;

  constructor(options: SequenceReviewerOptions) {
    if (!options.frames.length) throw new Error('SequenceReviewer 至少需要一帧');
    this.frames = options.frames;
    this.frameRate = clampFrameRate(options.frameRate);

    this.element = node('div', 'sequence-reviewer');

    const orderRow = node('div', 'sequence-order row');
    const sourceClass = options.orderSource.kind === 'manifest' ? 'accepted' : 'invalidated';
    const source = node('span', `pill ${sourceClass}`, options.orderSource.label);
    source.title = options.orderSource.detail || options.orderSource.label;
    orderRow.append(source);
    if (options.orderSource.kind === 'fallback') {
      const warning = node('span', 'sequence-order-warning', '⚠ 当前不是 manifest 权威帧序；通过前请先修复 manifest');
      warning.title = options.orderSource.detail || '';
      orderRow.append(warning);
    } else {
      orderRow.append(node('span', 'muted', '播放、拖动和缩略图均按 manifest.frames 顺序'));
    }

    this.stage = node('div', 'sequence-review-stage');
    this.currentImage = node('img', 'sequence-current');
    this.currentImage.alt = '动画帧序列当前帧';
    this.currentImage.draggable = false;
    this.loadStatus = node('div', 'sequence-load-status');
    this.currentImage.addEventListener('load', () => {
      this.loadStatus.textContent = '';
      this.loadStatus.classList.remove('show');
    });
    this.currentImage.addEventListener('error', () => {
      this.loadStatus.textContent = `当前帧读取失败：${this.frames[this.frameIndex]?.path || '未知路径'}`;
      this.loadStatus.classList.add('show');
    });

    const firstLast = node('div', 'sequence-first-last');
    const firstImage = node('img', 'sequence-first');
    firstImage.alt = `首帧：${this.frames[0].label}`;
    firstImage.src = this.frames[0].url;
    firstImage.draggable = false;
    const lastImage = node('img', 'sequence-last');
    lastImage.alt = `尾帧：${this.frames[this.frames.length - 1].label}`;
    lastImage.src = this.frames[this.frames.length - 1].url;
    lastImage.draggable = false;
    firstLast.append(
      firstImage,
      lastImage,
      node('span', 'sequence-edge-label first', '首帧'),
      node('span', 'sequence-edge-label last', '尾帧'),
    );
    this.stage.append(this.currentImage, firstLast, this.loadStatus);

    const controls = node('div', 'sequence-controls');
    const transport = node('div', 'row');
    const previous = node('button', 't', '◀ 帧');
    previous.type = 'button';
    previous.addEventListener('click', () => {
      this.setPlaying(false);
      this.setFrame(this.frameIndex > 0 ? this.frameIndex - 1 : (this.loopInput.checked ? this.frames.length - 1 : 0));
    });
    this.playButton = node('button', 't on', '⏸ 暂停');
    this.playButton.type = 'button';
    this.playButton.addEventListener('click', () => this.setPlaying(!this.playing));
    const next = node('button', 't', '帧 ▶');
    next.type = 'button';
    next.addEventListener('click', () => {
      this.setPlaying(false);
      this.setFrame(this.frameIndex < this.frames.length - 1 ? this.frameIndex + 1 : (this.loopInput.checked ? 0 : this.frames.length - 1));
    });
    this.timeline = node('input');
    this.timeline.type = 'range';
    this.timeline.min = '0';
    this.timeline.max = String(this.frames.length - 1);
    this.timeline.step = '1';
    this.timeline.value = '0';
    this.timeline.setAttribute('aria-label', '帧序列时间线');
    this.timeline.addEventListener('input', () => {
      this.setPlaying(false);
      this.setFrame(Number(this.timeline.value));
    });
    this.frameLabel = node('span', 'mono');
    transport.append(previous, this.playButton, next, this.timeline, this.frameLabel);

    const optionsRow = node('div', 'row');
    const fpsLabel = node('label', 'ctl', 'FPS');
    this.fpsInput = node('input', 't');
    this.fpsInput.type = 'number';
    this.fpsInput.min = '1';
    this.fpsInput.max = '60';
    this.fpsInput.step = '1';
    this.fpsInput.value = String(this.frameRate);
    this.fpsInput.addEventListener('change', () => {
      this.frameRate = clampFrameRate(Number(this.fpsInput.value));
      this.fpsInput.value = String(this.frameRate);
      this.resetClock();
    });
    fpsLabel.append(this.fpsInput);
    const loopLabel = node('label', 'ctl');
    this.loopInput = node('input');
    this.loopInput.type = 'checkbox';
    this.loopInput.checked = options.loop;
    loopLabel.append(this.loopInput, document.createTextNode(' 循环'));
    const overlayLabel = node('label', 'ctl');
    this.overlayInput = node('input');
    this.overlayInput.type = 'checkbox';
    this.overlayInput.addEventListener('change', () => {
      this.stage.classList.toggle('first-last-on', this.overlayInput.checked);
      if (this.overlayInput.checked) this.setPlaying(false);
    });
    overlayLabel.append(this.overlayInput, document.createTextNode(' 首尾叠加'));
    optionsRow.append(fpsLabel, loopLabel, overlayLabel, node('span', 'muted', '首帧蓝标 · 尾帧橙标'));
    controls.append(transport, optionsRow);

    const thumbnails = node('details', 'sequence-thumbnails');
    const summary = node('summary', '', `逐帧缩略图 · ${this.frames.length} 帧`);
    const grid = node('div', 'sequence-grid');
    this.frames.forEach((frame, index) => {
      const button = node('button', 'sequence-thumb');
      button.type = 'button';
      button.title = frame.path;
      const image = node('img');
      image.alt = `${String(index + 1).padStart(3, '0')} · ${frame.label}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = frame.url;
      const caption = node('span', 'mono', `${String(index + 1).padStart(3, '0')} · ${frame.label}`);
      button.append(image, caption);
      button.addEventListener('click', () => {
        this.setPlaying(false);
        this.setFrame(index);
      });
      grid.append(button);
    });
    thumbnails.append(summary, grid);

    this.element.append(orderRow, this.stage, controls, thumbnails);
    this.preloadImages = this.frames.map((frame) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = frame.url;
      return image;
    });
    this.setFrame(0);
    this.ensureAnimationFrame();
  }

  setPageActive(active: boolean): void {
    if (this.destroyed || this.pageActive === active) return;
    this.pageActive = active;
    this.resetClock();
    if (active) this.ensureAnimationFrame();
    else this.cancelAnimationFrame();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelAnimationFrame();
    for (const image of this.preloadImages) image.src = '';
  }

  private setPlaying(playing: boolean): void {
    if (this.destroyed) return;
    this.playing = playing;
    this.playButton.textContent = playing ? '⏸ 暂停' : '▶ 播放';
    this.playButton.classList.toggle('on', playing);
    this.resetClock();
    if (playing) this.ensureAnimationFrame();
    else this.cancelAnimationFrame();
  }

  private setFrame(index: number): void {
    if (this.destroyed) return;
    const next = Math.max(0, Math.min(this.frames.length - 1, Math.trunc(index) || 0));
    this.frameIndex = next;
    const frame = this.frames[next];
    this.currentImage.src = frame.url;
    this.currentImage.alt = `帧 ${next + 1}/${this.frames.length}：${frame.label}`;
    this.timeline.value = String(next);
    this.frameLabel.textContent = `${next + 1}/${this.frames.length} · ${frame.label}`;
    this.frameLabel.title = frame.path;
  }

  private advance(): void {
    if (this.frameIndex < this.frames.length - 1) {
      this.setFrame(this.frameIndex + 1);
      return;
    }
    if (this.loopInput.checked) {
      this.setFrame(0);
      return;
    }
    this.setPlaying(false);
  }

  private resetClock(): void {
    this.lastTimestamp = null;
    this.accumulatorMs = 0;
  }

  private ensureAnimationFrame(): void {
    if (this.destroyed || !this.playing || !this.pageActive || this.animationFrame !== null) return;
    this.animationFrame = requestAnimationFrame(this.onAnimationFrame);
  }

  private cancelAnimationFrame(): void {
    if (this.animationFrame === null) return;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  private readonly onAnimationFrame = (timestamp: number): void => {
    this.animationFrame = null;
    if (this.destroyed || !this.playing || !this.pageActive) return;
    if (this.lastTimestamp === null) {
      this.lastTimestamp = timestamp;
    } else {
      const elapsed = Math.max(0, Math.min(250, timestamp - this.lastTimestamp));
      this.lastTimestamp = timestamp;
      this.accumulatorMs += elapsed;
      const frameDuration = 1000 / this.frameRate;
      while (this.accumulatorMs >= frameDuration && this.playing) {
        this.accumulatorMs -= frameDuration;
        this.advance();
      }
    }
    this.ensureAnimationFrame();
  };
}
