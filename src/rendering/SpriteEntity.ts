import { BlurFilter, Container, Sprite, Texture, Rectangle } from 'pixi.js';
import type { AnimationPlaybackParams, AnimationSetDef, AnimationStateDef } from '../data/types';

/** 步速匹配倍率夹取范围：帧动画循环被拉出此区间会明显难看（步频与素材脱节） */
export const LOCOMOTION_RATE_MIN = 0.5;
export const LOCOMOTION_RATE_MAX = 2;

/** 显式播放倍率的合法区间（防 0/负数/极端值把 update 帧步进循环拖垮） */
const PLAYBACK_SPEED_MIN = 0.1;
const PLAYBACK_SPEED_MAX = 10;

function normalizePlaybackSpeed(raw: unknown): number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(PLAYBACK_SPEED_MAX, Math.max(PLAYBACK_SPEED_MIN, v));
}
import {
  blurStrengthFromPixelDensityK,
  computePixelDensityK,
  createPixelDensityBlurFilter,
  type TexelsPerWorld,
} from './EntityPixelDensityMatch';

/**
 * 精灵实体
 *
 * 坐标系统（与 Camera View-Projection 管线一致）：
 * - container.x/y = worldX/Y（纯世界坐标）
 * - sprite.scale = worldSize / framePixelSize（图集帧 → 世界尺寸映射）
 * - worldContainer 的 scale 统一处理 Projection 缩放
 */
export class SpriteEntity {
  public container: Container;
  public x: number = 0;
  public y: number = 0;

  private sprite: Sprite;
  private baseTexture: Texture | null = null;
  private animDef: AnimationSetDef | null = null;
  private frames: Map<string, Texture[]> = new Map();
  private facingX: 1 | -1 = 1;

  /** 当前朝向（供调试快照只读）。 */
  get facingDirection(): 'left' | 'right' {
    return this.facingX < 0 ? 'left' : 'right';
  }

  private worldWidth: number = 0;
  private worldHeight: number = 0;

  /**
   * 场景透视缩放系数（近大远小，纯派生态不入档）：由移动驱动方按脚底 y 求值写入。
   * 单点闸：乘进帧缩放与 getWorldSize，从尺寸派生的消费方（阴影/气泡/密度匹配）自动跟随。
   */
  private depthScaleFactor: number = 1;

  private currentState: string = '';
  private currentFrames: Texture[] = [];
  private currentFrameDef: AnimationStateDef | null = null;
  /** 本次播放的有效循环标志：动作层 playback.loop 覆盖优先，否则取状态定义 frameDef.loop。 */
  private effectiveLoop: boolean = false;
  private frameIndex: number = 0;
  private frameTimer: number = 0;
  private playing: boolean = false;
  private onCompleteCallback: (() => void) | null = null;
  /** 播放倍率（显式参数或步速匹配写入；playAnimation 切状态时重置为 1） */
  private playbackSpeed: number = 1;
  /** true = 反向步进（末帧→首帧） */
  private playbackReverse: boolean = false;
  /** 非循环片段完成后自动切换的状态名（按默认参数播放） */
  private pendingThenState: string | null = null;
  /** 逻辑状态名（如 idle）-> anim.json 中的 states 键；未配置则同名 */
  private logicalToClip: Map<string, string> = new Map();

  /** 仅显示：与背景像素密度对齐的低通（内层 Sprite，不影响外层深度滤镜） */
  private pixelDensityBlur: BlurFilter | null = null;
  private pixelDensityMatchActive = false;
  /** 模糊滤镜当前是否挂在 sprite.filters 上：Pixi 8 的 filters setter 每次赋值都 slice+freeze+重建 FilterEffect，只允许在启用/禁用边界切换时增删 */
  private pixelDensityBlurMounted = false;

  constructor() {
    this.container = new Container();
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5, 1);
    this.container.addChild(this.sprite);
  }

  loadFromDef(texture: Texture, animDef: AnimationSetDef): void {
    this.disposeFrameTextures();
    this.baseTexture = texture;
    this.animDef = animDef;
    this.worldWidth = animDef.worldWidth;
    this.worldHeight = animDef.worldHeight;

    const cols = animDef.cols;
    const rows = animDef.rows;
    const strideW =
      typeof animDef.cellWidth === 'number' && animDef.cellWidth > 0
        ? animDef.cellWidth
        : texture.width / cols;
    const strideH =
      typeof animDef.cellHeight === 'number' && animDef.cellHeight > 0
        ? animDef.cellHeight
        : texture.height / rows;

    for (const [stateName, stateDef] of Object.entries(animDef.states)) {
      const textures: Texture[] = [];
      for (const frameIdx of stateDef.frames) {
        const col = frameIdx % cols;
        const row = Math.floor(frameIdx / cols);
        const box = animDef.atlasFrames?.[frameIdx];
        const rw = box && box.width > 0 ? box.width : strideW;
        const rh = box && box.height > 0 ? box.height : strideH;
        const rect = new Rectangle(col * strideW, row * strideH, rw, rh);
        const frameTex = new Texture({ source: texture.source, frame: rect });
        textures.push(frameTex);
      }
      this.frames.set(stateName, textures);
    }

    this.applySpriteScale();
  }

  private disposeFrameTextures(): void {
    this.sprite.texture = Texture.EMPTY;
    for (const textures of this.frames.values()) {
      for (const t of textures) {
        // 子纹理与图集共享 Assets 管理的 TextureSource，不可 destroy(true) 否则会拆掉整张贴图
        t.destroy(false);
      }
    }
    this.frames.clear();
    this.currentFrames = [];
    this.currentFrameDef = null;
    this.effectiveLoop = false;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.playing = false;
    this.onCompleteCallback = null;
    this.playbackSpeed = 1;
    this.playbackReverse = false;
    this.pendingThenState = null;
    this.currentState = '';
  }

  /** 释放帧子纹理与 Pixi 子节点（不销毁传入 loadFromDef 的图集基纹理） */
  destroy(): void {
    this.clearPixelDensityBlur();
    this.disposeFrameTextures();
    this.baseTexture = null;
    this.animDef = null;
    this.logicalToClip.clear();
    this.container.destroy({ children: true });
  }

  /**
   * 配置逻辑状态到图集 states 键的映射（玩家化身等）。未出现在 map 中的逻辑名仍按原名解析。
   */
  setLogicalStateMap(map: Record<string, string> | undefined): void {
    this.logicalToClip.clear();
    if (!map) return;
    for (const [logical, clip] of Object.entries(map)) {
      if (logical && clip) this.logicalToClip.set(logical, clip);
    }
  }

  private resolveClip(stateName: string): string {
    return this.logicalToClip.get(stateName) ?? stateName;
  }

  /**
   * 播放状态。`playback` 缺省时与旧签名行为完全一致（同状态播放中重入为幂等 no-op——
   * Player.update 每帧调用依赖此路径）；显式携带 `playback` 时总是按新参数重启片段，
   * 语义可预期（内容侧动作是一次性触发，不走每帧路径）。
   */
  playAnimation(stateName: string, onComplete?: () => void, playback?: AnimationPlaybackParams): void {
    const clip = this.resolveClip(stateName);
    if (!playback && this.currentState === clip && this.playing) return;

    const frameDef = this.animDef?.states[clip];
    const textures = this.frames.get(clip);
    if (!frameDef || !textures || textures.length === 0) return;

    this.currentState = clip;
    this.currentFrames = textures;
    this.currentFrameDef = frameDef;
    // 有效循环标志：动作层 playback.loop（显式 true/false）覆盖状态定义，缺省沿用 frameDef.loop
    this.effectiveLoop = playback?.loop ?? frameDef.loop;
    this.frameTimer = 0;
    this.onCompleteCallback = onComplete ?? null;
    this.playbackSpeed = playback?.speed !== undefined ? normalizePlaybackSpeed(playback.speed) : 1;
    this.playbackReverse = playback?.reverse === true;
    const thenState = playback?.thenState?.trim();
    this.pendingThenState = thenState || null;

    const hold = playback?.holdFrame;
    const start = playback?.startFrame;
    if (typeof hold === 'number' && Number.isFinite(hold)) {
      const n = textures.length;
      this.frameIndex = ((Math.trunc(hold) % n) + n) % n;
      this.playing = false;
      this.pendingThenState = null;
    } else if (typeof start === 'number' && Number.isFinite(start)) {
      // 起播帧（去同步错相）：正/反向都从此帧开始步进
      const n = textures.length;
      this.frameIndex = ((Math.trunc(start) % n) + n) % n;
      this.playing = true;
    } else {
      this.frameIndex = this.playbackReverse ? textures.length - 1 : 0;
      this.playing = true;
    }
    this.sprite.texture = textures[this.frameIndex];
    // 帧框尺寸可能逐帧不同（atlasFrames），起播/定格帧非 0 时须立刻按所示帧重算缩放
    this.applySpriteScale();
  }

  setDirection(dx: number, _dy: number): void {
    if (dx > 0) this.facingX = 1;
    else if (dx < 0) this.facingX = -1;
    this.applySpriteScale();
  }

  update(dt: number): void {
    if (!this.playing || !this.currentFrameDef || this.currentFrames.length <= 1) {
      this.syncPosition();
      return;
    }

    this.frameTimer += dt;
    const fpsRaw = Number(this.currentFrameDef.frameRate);
    const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 8;
    const frameDuration = 1 / (fps * this.playbackSpeed);

    while (this.frameTimer >= frameDuration) {
      this.frameTimer -= frameDuration;
      this.frameIndex += this.playbackReverse ? -1 : 1;

      if (this.frameIndex < 0 || this.frameIndex >= this.currentFrames.length) {
        if (this.effectiveLoop) {
          this.frameIndex = this.playbackReverse ? this.currentFrames.length - 1 : 0;
        } else {
          this.frameIndex = this.playbackReverse ? 0 : this.currentFrames.length - 1;
          this.playing = false;
          this.onCompleteCallback?.();
          const next = this.pendingThenState;
          this.pendingThenState = null;
          if (next) this.playAnimation(next);
          break;
        }
      }
    }

    this.sprite.texture = this.currentFrames[this.frameIndex];
    this.applySpriteScale();
    this.syncPosition();
  }

  private syncPosition(): void {
    this.container.x = this.x;
    this.container.y = this.y;
  }

  getCurrentState(): string {
    return this.currentState;
  }

  /** 当前状态可播放帧数（供预览工具做时间轴/逐帧）。 */
  getFrameCount(): number {
    return this.currentFrames.length;
  }

  /** 当前显示的帧下标（0 基，指向当前状态的 frames 序列）。 */
  getFrameIndex(): number {
    return this.frameIndex;
  }

  /** 跨运行壳视觉门禁：只读导出当前动画游标与帧裁切，不参与游戏逻辑。 */
  getDebugVisualState(): Record<string, unknown> {
    const frame = this.sprite.texture?.frame;
    return {
      state: this.currentState,
      frameIndex: this.frameIndex,
      frameTimer: this.frameTimer,
      playing: this.playing,
      facing: this.facingDirection,
      worldWidth: this.worldWidth,
      worldHeight: this.worldHeight,
      depthScaleFactor: this.depthScaleFactor,
      frame: frame ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height } : null,
      pixelDensityMatchActive: this.pixelDensityMatchActive,
    };
  }

  /**
   * 步速匹配：当前状态声明了 referenceSpeed 时，按实际移动速度缩放播放倍率（夹取
   * LOCOMOTION_RATE_MIN..MAX 防丑）；未声明或速度非法时回到 1 倍速。移动驱动方每帧调用，
   * 只改倍率不重启片段。
   */
  applyLocomotionSpeed(worldSpeed: number): void {
    const ref = Number(this.currentFrameDef?.referenceSpeed);
    if (!Number.isFinite(ref) || ref <= 0 || !Number.isFinite(worldSpeed) || worldSpeed <= 0) {
      this.playbackSpeed = 1;
      return;
    }
    this.playbackSpeed = Math.min(
      LOCOMOTION_RATE_MAX,
      Math.max(LOCOMOTION_RATE_MIN, worldSpeed / ref),
    );
  }

  /** 固定时钟门禁起点：保留当前动画状态/播放标志，只归零游标与余量（反向播放起点为末帧）。 */
  resetAnimationClock(): void {
    this.frameIndex = this.playbackReverse ? Math.max(0, this.currentFrames.length - 1) : 0;
    this.frameTimer = 0;
    if (this.currentFrames.length > 0) {
      this.sprite.texture = this.currentFrames[this.frameIndex];
      this.applySpriteScale();
    }
  }

  /** 直接定位到某一帧并显示（供预览工具 scrub/逐帧）；不改变 playing 标志，越界自动夹取。 */
  setFrameIndex(index: number): void {
    if (this.currentFrames.length === 0) return;
    const n = this.currentFrames.length;
    const i = ((Math.trunc(index) % n) + n) % n;
    this.frameIndex = i;
    this.frameTimer = 0;
    this.sprite.texture = this.currentFrames[i];
    this.applySpriteScale();
    this.syncPosition();
  }

  /** 暂停 / 恢复帧推进（供预览工具）。恢复时若已到非循环终点帧则回到起点帧（反向播放的终点是首帧）。 */
  setPlaying(playing: boolean): void {
    if (playing && !this.playing && this.currentFrames.length > 0) {
      if (!this.effectiveLoop) {
        const atEnd = this.playbackReverse
          ? this.frameIndex <= 0
          : this.frameIndex >= this.currentFrames.length - 1;
        if (atEnd) {
          this.frameIndex = this.playbackReverse ? this.currentFrames.length - 1 : 0;
        }
      }
    }
    this.playing = playing && this.currentFrames.length > 0;
  }

  /** anim.json 中定义的全部状态名。 */
  getStateNames(): string[] {
    return this.animDef ? Object.keys(this.animDef.states) : [];
  }

  /** **有效**世界尺寸（× 透视缩放系数）；阴影/气泡/密度匹配等派生消费方经此自动跟随 */
  getWorldSize(): { width: number; height: number } {
    return {
      width: this.worldWidth * this.depthScaleFactor,
      height: this.worldHeight * this.depthScaleFactor,
    };
  }

  /** 透视缩放系数（近大远小）；非法/≤0 回落 1。变化时立即重投帧缩放。 */
  setDepthScaleFactor(f: number): void {
    const v = Number.isFinite(f) && f > 0 ? f : 1;
    if (v === this.depthScaleFactor) return;
    this.depthScaleFactor = v;
    this.applySpriteScale();
  }

  getDepthScaleFactor(): number {
    return this.depthScaleFactor;
  }

  /** 当前显示帧纹理（供投影阴影复用剪影）；未加载时返回 null */
  getDisplayTexture(): Texture | null {
    const t = this.sprite.texture;
    return t && t !== Texture.EMPTY ? t : null;
  }

  /**
   * 是否参与「实体与背景像素密度匹配」。关时移除内层密度滤镜。
   */
  setPixelDensityMatchActive(active: boolean): void {
    if (this.pixelDensityMatchActive === active) return;
    this.pixelDensityMatchActive = active;
    this.sprite.roundPixels = active;
    if (!active) {
      this.clearPixelDensityBlur();
    }
  }

  getPixelDensityMatchActive(): boolean {
    return this.pixelDensityMatchActive;
  }

  /**
   * 按当前帧与背景 dBg 更新内层 Sprite 的模糊强度；需在每帧或切帧后调用。
   * @param dBg 背景 texels/world；为 null 或功能关闭时由调用方先 setActive(false)
   * @param strengthScale 强度倍率（配置 / 调试）
   */
  applyPixelDensityMatch(dBg: TexelsPerWorld | null, strengthScale = 1): void {
    if (!this.pixelDensityMatchActive) return;
    if (!dBg || !this.baseTexture || !this.animDef) {
      this.clearPixelDensityBlur();
      return;
    }
    const { frameW, frameH } = this.getCurrentFramePixelSize();
    // 透视缩小后有效世界尺寸变小 → k 变大 → 低通更强，随深度自适应
    const k = computePixelDensityK(
      frameW,
      frameH,
      this.worldWidth * this.depthScaleFactor,
      this.worldHeight * this.depthScaleFactor,
      dBg,
    );
    const strength = blurStrengthFromPixelDensityK(k, strengthScale);
    if (strength <= 0) {
      this.unmountPixelDensityBlur();
      return;
    }
    if (!this.pixelDensityBlur) {
      this.pixelDensityBlur = createPixelDensityBlurFilter(strength);
    } else {
      this.pixelDensityBlur.strength = strength;
    }
    if (!this.pixelDensityBlurMounted) {
      this.sprite.filters = [this.pixelDensityBlur];
      this.pixelDensityBlurMounted = true;
    }
  }

  /** 从 sprite.filters 摘除（保留滤镜实例复用，强度回升时免重建） */
  private unmountPixelDensityBlur(): void {
    if (!this.pixelDensityBlurMounted) return;
    this.sprite.filters = [];
    this.pixelDensityBlurMounted = false;
  }

  private clearPixelDensityBlur(): void {
    this.unmountPixelDensityBlur();
    if (this.pixelDensityBlur) {
      this.pixelDensityBlur.destroy();
      this.pixelDensityBlur = null;
    }
  }

  private getCurrentFramePixelSize(): { frameW: number; frameH: number } {
    const tex = this.baseTexture;
    const def = this.animDef;
    if (!tex || !def) {
      return { frameW: 1, frameH: 1 };
    }
    const strideW =
      typeof def.cellWidth === 'number' && def.cellWidth > 0
        ? def.cellWidth
        : tex.width / def.cols;
    const strideH =
      typeof def.cellHeight === 'number' && def.cellHeight > 0
        ? def.cellHeight
        : tex.height / def.rows;
    let frameW = strideW;
    let frameH = strideH;
    if (this.currentFrameDef && def.atlasFrames && def.atlasFrames.length > 0) {
      const seq = this.currentFrameDef.frames;
      const slot = seq[this.frameIndex % seq.length];
      const box = def.atlasFrames[slot];
      if (box && box.width > 0 && box.height > 0) {
        frameW = box.width;
        frameH = box.height;
      }
    }
    return { frameW, frameH };
  }

  private applySpriteScale(): void {
    const tex = this.baseTexture;
    const def = this.animDef;
    if (!tex || !def) {
      this.sprite.scale.set(this.facingX, 1);
      return;
    }
    const { frameW, frameH } = this.getCurrentFramePixelSize();

    this.sprite.scale.set(
      (this.worldWidth * this.depthScaleFactor / frameW) * this.facingX,
      (this.worldHeight * this.depthScaleFactor) / frameH,
    );
  }
}
