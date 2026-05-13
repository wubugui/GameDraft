import { BlurFilter, Container, Sprite, Texture, Rectangle } from 'pixi.js';
import type { AnimationSetDef, AnimationStateDef } from '../data/types';
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

  private worldWidth: number = 0;
  private worldHeight: number = 0;

  private currentState: string = '';
  private currentFrames: Texture[] = [];
  private currentFrameDef: AnimationStateDef | null = null;
  private frameIndex: number = 0;
  private frameTimer: number = 0;
  private playing: boolean = false;
  private onCompleteCallback: (() => void) | null = null;
  /** 逻辑状态名（如 idle）-> anim.json 中的 states 键；未配置则同名 */
  private logicalToClip: Map<string, string> = new Map();

  /** 仅显示：与背景像素密度对齐的低通（内层 Sprite，不影响外层深度滤镜） */
  private pixelDensityBlur: BlurFilter | null = null;
  private pixelDensityMatchActive = false;

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
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.playing = false;
    this.onCompleteCallback = null;
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

  playAnimation(stateName: string, onComplete?: () => void): void {
    const clip = this.resolveClip(stateName);
    if (this.currentState === clip && this.playing) return;

    const frameDef = this.animDef?.states[clip];
    const textures = this.frames.get(clip);
    if (!frameDef || !textures || textures.length === 0) return;

    this.currentState = clip;
    this.currentFrames = textures;
    this.currentFrameDef = frameDef;
    this.frameIndex = 0;
    this.frameTimer = 0;
    this.playing = true;
    this.onCompleteCallback = onComplete ?? null;
    this.sprite.texture = textures[0];
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
    const frameDuration = 1 / fps;

    while (this.frameTimer >= frameDuration) {
      this.frameTimer -= frameDuration;
      this.frameIndex++;

      if (this.frameIndex >= this.currentFrames.length) {
        if (this.currentFrameDef.loop) {
          this.frameIndex = 0;
        } else {
          this.frameIndex = this.currentFrames.length - 1;
          this.playing = false;
          this.onCompleteCallback?.();
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

  getWorldSize(): { width: number; height: number } {
    return { width: this.worldWidth, height: this.worldHeight };
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
    const k = computePixelDensityK(frameW, frameH, this.worldWidth, this.worldHeight, dBg);
    const strength = blurStrengthFromPixelDensityK(k, strengthScale);
    if (strength <= 0) {
      this.sprite.filters = [];
      return;
    }
    if (!this.pixelDensityBlur) {
      this.pixelDensityBlur = createPixelDensityBlurFilter(strength);
    } else {
      this.pixelDensityBlur.strength = strength;
    }
    this.sprite.filters = [this.pixelDensityBlur];
  }

  private clearPixelDensityBlur(): void {
    this.sprite.filters = [];
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
      (this.worldWidth / frameW) * this.facingX,
      this.worldHeight / frameH,
    );
  }
}