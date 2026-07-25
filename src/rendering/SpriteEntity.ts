import { BlurFilter, Container, Sprite, Texture, Rectangle, type Shader, type TextureSource } from 'pixi.js';
import type { AnimationPlaybackParams, AnimationSetDef, AnimationStateDef } from '../data/types';
import { LitSpriteQuad } from './CharacterLitSprite';

/**
 * 烘焙照明的 shader 供给方(CharacterLightingSystem 经 Game 注入):
 * SpriteEntity 只管几何同步,shader 的建/换图集/回收都归照明系统。
 */
export interface LitShaderProvider {
  create(colorTex: TextureSource, sheetUrl: string | null): Shader | null;
  swapTextures(shader: Shader, colorTex: TextureSource, sheetUrl: string | null): void;
  release(shader: Shader): void;
}

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

/**
 * 反推图集格内**内容底部留白**（格像素）：打包器给每格上下各留同样的 pad，
 * 故 `pad = (格高 - 全图集最高帧内容高) / 2`。缺 `atlasFrames`/数据非法时返回 null。
 */
function computeContentBottomPadPx(animDef: AnimationSetDef, cellH: number): number | null {
  const boxes = animDef.atlasFrames;
  if (!Array.isArray(boxes) || boxes.length === 0) return null;
  if (!Number.isFinite(cellH) || cellH <= 0) return null;
  let maxContentH = 0;
  for (const box of boxes) {
    const h = box?.contentHeight;
    if (typeof h === 'number' && Number.isFinite(h) && h > maxContentH) maxContentH = h;
  }
  if (maxContentH <= 0) return null;
  return Math.max(0, (cellH - maxContentH) / 2);
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

  /**
   * 烘焙着色驱动:图集源 + 网格(运行时法线图集生成)+ 当前帧归一化 uv rect + 镜像。
   * 无图集(未 loadFromDef)返回 null,滤镜回退平面法线。
   */
  getShadingFrameInfo(): {
    source: TextureSource;
    /** 图集完整 URL；法线图集按 `<图集名>.normal.png` 由此寻址（离线烘焙产物） */
    sheetUrl: string | null;
    cols: number;
    rows: number;
    rect: [number, number, number, number];
    flipX: boolean;
  } | null {
    if (!this.baseTexture || !this.animDef) return null;
    const src = this.baseTexture.source;
    const w = src.width, h = src.height;
    if (!w || !h) return null;
    const fr = this.sprite.texture.frame;
    return {
      source: src,
      sheetUrl: this.animDef.resolvedSheetUrl ?? null,
      cols: this.animDef.cols,
      rows: this.animDef.rows,
      rect: [fr.x / w, fr.y / h, fr.width / w, fr.height / h],
      flipX: this.facingX < 0,
    };
  }

  private worldWidth: number = 0;
  private worldHeight: number = 0;

  /**
   * 图集格内**内容底部留白**（格像素）：打包时每帧可见内容底边对齐、格内上下各留 pad
   * （tools/video_to_atlas/atlas_core.py `pack_frames_native_equal_cells`）。pad 未入 anim.json，
   * 由 `cellH - 最高帧 contentHeight` 反推。无 `atlasFrames` 时为 null——此时内容框未知，
   * 气泡等消费方回落到格子 quad 口径。
   */
  private contentBottomPadPx: number | null = null;

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

    this.contentBottomPadPx = computeContentBottomPadPx(animDef, strideH);

    this.applySpriteScale();
    this.refreshLitQuad();   // 换图集(玩家换装/NPC 重载动画):mesh 的 color+normal 源跟随
  }

  private disposeFrameTextures(): void {
    this.contentBottomPadPx = null;
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
    this.disableBakedShading();
    this.clearPixelDensityBlur();
    this.disposeFrameTextures();
    this.baseTexture = null;
    this.animDef = null;
    this.logicalToClip.clear();
    this.container.destroy({ children: true });
  }

  // ------------------------------------------------- 烘焙照明:sprite 网格着色(2026-07-25)
  // 与 sprite 同 quad 的 Mesh 子节点,color 与 normal 用**顶点自带的同一套图集 UV** 采样;
  // 镜像/脚点/世界坐标全部来自几何。没有任何逐帧 CPU 驱动 —— filter 反推 UV 的事故面
  // (驱动缺席 → 全身采边缘列 → 通体单色/左右变色/闪烁)在结构上不存在。
  private litQuad: LitSpriteQuad | null = null;
  private litShader: Shader | null = null;
  private litProvider: LitShaderProvider | null = null;
  private litColorSrc: TextureSource | null = null;

  /** 开启网格着色(baked 场景;非 baked 或无图集时安静保持旧管线)。可重入:重复调用只刷新。 */
  enableBakedShading(provider: LitShaderProvider): void {
    this.litProvider = provider;
    this.refreshLitQuad();
  }

  disableBakedShading(): void {
    if (this.litQuad) { this.litQuad.destroy(); this.litQuad = null; }
    if (this.litShader && this.litProvider) this.litProvider.release(this.litShader);
    this.litShader = null;
    this.litColorSrc = null;
    this.litProvider = null;
    this.sprite.renderable = true;
  }

  /** 建/重建 mesh(atlas 就绪后才有意义;loadFromDef 后与 enable 时各调一次)。 */
  private refreshLitQuad(): void {
    const provider = this.litProvider;
    if (!provider || !this.baseTexture || !this.animDef) return;
    const src = this.baseTexture.source;
    if (!this.litShader) {
      const sh = provider.create(src, this.animDef.resolvedSheetUrl ?? null);
      if (!sh) return;                     // 场景无载荷:保持旧管线
      this.litShader = sh;
      this.litColorSrc = src;
      this.litQuad = new LitSpriteQuad(sh);
      // ⚠ 挂到 container 而非 sprite:Pixi v8 的 Sprite 子节点**不渲染**(实测恒红调试
      // shader 挂 sprite 下零像素、挂 Container 下立刻显示)。sprite 的变换(scale 含
      // facingX 镜像、视觉抬升 y)由 syncLitQuad 复制 —— 同步点都在换帧/换向路径上。
      this.container.addChild(this.litQuad.mesh);
      this.sprite.renderable = false;      // color 由 mesh 画(同 quad 同 UV),原精灵只当变换载体
    } else if (this.litColorSrc !== src) { // 运行时换图集(背尸/道士/setEntityField)
      provider.swapTextures(this.litShader, src, this.animDef.resolvedSheetUrl ?? null);
      this.litColorSrc = src;
    }
    this.syncLitQuad();
  }

  /** 换帧几何同步:由 applySpriteScale(所有换帧/换向/抬升路径的必经点)调用。 */
  private syncLitQuad(): void {
    if (!this.litQuad) return;
    const { frameW, frameH } = this.getCurrentFramePixelSize();
    this.litQuad.sync(this.sprite.texture, frameW, frameH, this.sprite.anchor.x, this.sprite.anchor.y);
    // mesh 与 sprite 是兄弟节点(见 refreshLitQuad 注释),变换逐项复制:
    // scale 带 facingX 符号(镜像 → 行列式变负 → 着色器翻 n.x),y 带视觉抬升。
    const m = this.litQuad.mesh;
    m.position.set(this.sprite.x, this.sprite.y);
    m.scale.set(this.sprite.scale.x, this.sprite.scale.y);
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
      /** 跳跃弧线视觉抬升（内层 sprite.y，负=离地上升，0=着地）——仅调试只读，供无头验证断言弧线。 */
      visualLiftY: this.sprite.y,
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

  /**
   * 视觉垂直抬升（容器局部 px，负=向上）：只偏移画出来的精灵（内层 anchor=脚底），
   * **不动** container 原点(脚点)。跳跃弧线用——脚点/阴影/深度排序/透视仍锚在地面，
   * 只有画面里的角色被抬起。缺省 0，落地须显式复位 0。透视一致由调用方(实体)
   * 按各自 depthScaleFactor 预乘后传入（远处跳起视觉高度按比例收缩）。
   * applySpriteScale 只写 scale、syncPosition 只写 container.x/y，均不触 sprite.y，故此偏移不会被覆盖。
   */
  setVisualLiftY(px: number): void {
    this.sprite.y = Number.isFinite(px) ? px : 0;
    this.syncLitQuad();   // mesh 跟随视觉抬升(跳跃弧线)
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
  /**
   * 内层精灵的世界包围盒 —— 法线 local UV 换算用(见 CharacterShadingFilter 的 uSpriteRect)。
   * 实体容器里若还有名字标签等兄弟节点,容器包围盒会比精灵大,必须靠它换算。
   */
  getSpriteWorldBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.sprite) return null;
    const b = this.sprite.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  getWorldSize(): { width: number; height: number } {
    return {
      width: this.worldWidth * this.depthScaleFactor,
      height: this.worldHeight * this.depthScaleFactor,
    };
  }

  /**
   * 当前帧**可见内容**的世界框（容器局部单位，已含透视系数与跳跃视觉抬升；不含实例 scale——
   * 那是实体层的事，与 `getWorldSize()` 同口径由调用方乘）。
   *
   * 为什么不能用 `getWorldSize()` 当头顶锚：那是**整张图集的格子**尺寸，per-atlas 恒定，
   * 覆盖的是最高帧；蹲/躺/跑这些矮帧上方全是透明留白（实测最矮帧只占格高 16%~25%），
   * 拿格子顶边挂气泡会飘出角色一大截。
   *
   * @returns `bottomGap` = 内容底边高于脚点的距离（含视觉抬升）；无 `atlasFrames` 等数据缺失时 null。
   */
  getContentBoxLocal(): { width: number; height: number; bottomGap: number } | null {
    const pad = this.contentBottomPadPx;
    if (pad === null || !this.animDef) return null;
    const box = this.currentFrameContentBoxPx();
    if (!box) return null;
    const { frameW, frameH } = this.getCurrentFramePixelSize();
    if (!(frameW > 0) || !(frameH > 0)) return null;
    // 与 applySpriteScale 同一口径（那里带 facingX 符号，这里取绝对值——尺寸无方向）
    const scaleX = (this.worldWidth * this.depthScaleFactor) / frameW;
    const scaleY = (this.worldHeight * this.depthScaleFactor) / frameH;
    return {
      width: box.w * scaleX,
      height: box.h * scaleY,
      // sprite.y 为跳跃弧线的视觉抬升（负=离地），减去它内容框才跟着精灵一起升
      bottomGap: pad * scaleY - this.sprite.y,
    };
  }

  /**
   * 当前状态**授权**的头顶锚（容器局部 y，脚点 0、向上为负；已含透视系数与视觉抬升）。
   * 来自 anim.json `states[*].bubbleAnchor`（格高归一化比例）；没授权返回 null，调用方走内容框自动档。
   *
   * 存在的理由：内容框顶 ≠ 头顶——举枪、扛尸、打伞这些状态，自动锚会挂到道具尖上。
   */
  getAuthoredBubbleAnchorLocalY(): number | null {
    const raw = this.currentFrameDef?.bubbleAnchor;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
    return this.sprite.y - raw * this.worldHeight * this.depthScaleFactor;
  }

  /** 当前显示帧在 `atlasFrames` 中登记的内容包围盒（格像素）；无登记/非法返回 null。 */
  private currentFrameContentBoxPx(): { w: number; h: number } | null {
    const boxes = this.animDef?.atlasFrames;
    const seq = this.currentFrameDef?.frames;
    if (!boxes || boxes.length === 0 || !seq || seq.length === 0) return null;
    const box = boxes[seq[this.frameIndex % seq.length]];
    const w = box?.contentWidth;
    const h = box?.contentHeight;
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return null;
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return null;
    return { w, h };
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
    this.syncLitQuad();   // 所有换帧/换向/透视缩放路径的必经点:mesh 顶点+UV 跟随
  }
}
