import { BlurFilter, Container, Graphics, Sprite, Text, Texture, type Filter } from 'pixi.js';
import type { HotspotDef } from '../data/types';
import type { DepthOcclusionFilter } from '../rendering/DepthOcclusionFilter';
import {
  blurStrengthFromPixelDensityK,
  computePixelDensityK,
  createPixelDensityBlurFilter,
  type TexelsPerWorld,
} from '../rendering/EntityPixelDensityMatch';

const TYPE_COLORS: Record<string, number> = {
  inspect: 0x44aaff,
  pickup: 0xffcc44,
  transition: 0x44ff88,
};

export class Hotspot {
  public def: HotspotDef;
  public container: Container;
  public active: boolean = true;

  private marker: Graphics;
  private displaySprite: Sprite | null = null;
  /** displayImage 世界高度；贴图为底中锚点，与 NPC/Player 脚底一致 */
  private _displayWorldHeight = 0;
  private depthOcclusionFilter: DepthOcclusionFilter | null = null;
  /** 展示图专用；与 DepthOcclusionFilter 组合为 [density, depth]，深度实例引用不变 */
  private pixelDensityBlur: BlurFilter | null = null;
  private promptIcon: Container | null = null;
  private showingPrompt: boolean = false;

  constructor(def: HotspotDef) {
    this.def = def;
    this.container = new Container();

    const color = TYPE_COLORS[def.type] ?? 0xffffff;
    this.marker = new Graphics();
    this.marker.circle(0, 0, 8).fill({ color, alpha: 0.6 });
    this.marker.circle(0, 0, 12).stroke({ color, width: 1, alpha: 0.3 });
    this.container.addChild(this.marker);

    this._syncContainerPosition();
    this._syncEntitySortBand();
  }

  /** 与 Renderer.sortEntityLayer 配合：仅在有展示图且配置了 spriteSort 时标记容器 */
  private _syncEntitySortBand(): void {
    const c = this.container as Container & { entitySortBand?: 'back' | 'front' };
    const di = this.def.displayImage;
    if (
      this.displaySprite &&
      di &&
      di.image &&
      di.worldWidth > 0 &&
      di.worldHeight > 0 &&
      di.spriteSort === 'back'
    ) {
      c.entitySortBand = 'back';
    } else if (
      this.displaySprite &&
      di &&
      di.image &&
      di.worldWidth > 0 &&
      di.worldHeight > 0 &&
      di.spriteSort === 'front'
    ) {
      c.entitySortBand = 'front';
    } else {
      delete c.entitySortBand;
    }
  }

  /**
   * 以热区 (x,y) 为底边中点铺满 worldWidth×worldHeight；有图时隐藏彩色圆点标记。
   */
  setDisplayTexture(texture: Texture, worldWidth: number, worldHeight: number): void {
    if (this.displaySprite) {
      this.displaySprite.filters = [];
      this.container.removeChild(this.displaySprite);
      this.displaySprite.destroy();
      this.displaySprite = null;
    }
    if (this.pixelDensityBlur) {
      this.pixelDensityBlur.destroy();
      this.pixelDensityBlur = null;
    }
    this._displayWorldHeight = 0;
    if (worldWidth <= 0 || worldHeight <= 0) {
      this._syncEntitySortBand();
      return;
    }
    const spr = new Sprite(texture);
    spr.anchor.set(0.5, 1);
    spr.position.set(0, 0);
    spr.width = worldWidth;
    spr.height = worldHeight;
    this.container.addChildAt(spr, 0);
    this.displaySprite = spr;
    this._displayWorldHeight = worldHeight;
    this._applyDisplayImageFacing(spr);
    this.marker.visible = false;
    this._syncEntitySortBand();
  }

  private _applyDisplayImageFacing(spr: Sprite): void {
    const f = this.def.displayImage?.facing;
    const flip = f === 'left' ? -1 : 1;
    spr.scale.x = flip * Math.abs(spr.scale.x);
  }

  /** 与 Player/NPC 一致：底中锚点下脚底即 container.y */
  depthOcclusionFootWorldY(): number {
    return this.container.y;
  }

  /**
   * 仅挂到 displaySprite，避免 E 提示等子节点被深度裁切。
   * 须在场景 depth 加载完成之后调用。
   */
  attachDepthOcclusionFilter(filter: DepthOcclusionFilter | null): void {
    this.depthOcclusionFilter = filter;
    this.rebuildDisplaySpriteFilters();
  }

  /** 场景卸载前由 Game 摘除并 destroy 滤镜 */
  detachDepthOcclusionFilter(): DepthOcclusionFilter | null {
    const f = this.depthOcclusionFilter;
    this.depthOcclusionFilter = null;
    this.rebuildDisplaySpriteFilters();
    return f;
  }

  /**
   * 先密度低通、后深度遮挡（深度滤镜实例与未开密度时相同，仅数组组合变化）
   */
  private rebuildDisplaySpriteFilters(): void {
    if (!this.displaySprite) return;
    const chain: Filter[] = [];
    if (this.pixelDensityBlur) chain.push(this.pixelDensityBlur);
    if (this.depthOcclusionFilter) chain.push(this.depthOcclusionFilter);
    this.displaySprite.filters = chain.length > 0 ? chain : [];
  }

  /** 纯渲染：展示图与背景像素密度对齐 */
  applyEntityPixelDensityMatch(enabled: boolean, dBg: TexelsPerWorld | null, strengthScale = 1): void {
    if (!this.displaySprite) return;
    const di = this.def.displayImage;
    if (!enabled || !dBg || !di || di.worldWidth <= 0 || di.worldHeight <= 0) {
      this.displaySprite.roundPixels = false;
      if (this.pixelDensityBlur) {
        this.pixelDensityBlur.destroy();
        this.pixelDensityBlur = null;
      }
      this.rebuildDisplaySpriteFilters();
      return;
    }
    this.displaySprite.roundPixels = true;
    const tw = this.displaySprite.texture.width;
    const th = this.displaySprite.texture.height;
    const k = computePixelDensityK(tw, th, di.worldWidth, di.worldHeight, dBg);
    const strength = blurStrengthFromPixelDensityK(k, strengthScale);
    if (strength <= 0) {
      if (this.pixelDensityBlur) {
        this.pixelDensityBlur.destroy();
        this.pixelDensityBlur = null;
      }
      this.rebuildDisplaySpriteFilters();
      return;
    }
    if (!this.pixelDensityBlur) {
      this.pixelDensityBlur = createPixelDensityBlurFilter(strength);
    } else {
      this.pixelDensityBlur.strength = strength;
    }
    this.rebuildDisplaySpriteFilters();
  }

  getDepthOcclusionFilter(): DepthOcclusionFilter | null {
    return this.depthOcclusionFilter;
  }

  /** 已加载 displayImage 贴图（用于决定是否创建深度滤镜） */
  hasDepthDisplayImage(): boolean {
    return this.displaySprite !== null && this._displayWorldHeight > 0;
  }

  private _syncContainerPosition(): void {
    this.container.x = this.def.x;
    this.container.y = this.def.y;
  }

  get centerX(): number {
    return this.def.x;
  }

  get centerY(): number {
    return this.def.y;
  }

  showPrompt(): void {
    if (this.showingPrompt) return;
    this.showingPrompt = true;

    this.promptIcon = new Container();
    const bg = new Graphics();
    bg.roundRect(-14, -28, 28, 22, 4).fill({ color: 0x000000, alpha: 0.7 });
    this.promptIcon.addChild(bg);

    const text = new Text({
      text: 'E',
      style: { fontSize: 14, fill: 0xffffff, fontFamily: 'monospace' },
    });
    text.anchor.set(0.5, 0.5);
    text.y = -17;
    this.promptIcon.addChild(text);

    this.container.addChild(this.promptIcon);
  }

  hidePrompt(): void {
    if (!this.showingPrompt) return;
    this.showingPrompt = false;

    if (this.promptIcon) {
      this.container.removeChild(this.promptIcon);
      this.promptIcon.destroy({ children: true });
      this.promptIcon = null;
    }
  }

  setInactive(): void {
    this.active = false;
    this.hidePrompt();
    this.container.visible = false;
  }

  destroy(): void {
    this.hidePrompt();
    this.depthOcclusionFilter = null;
    if (this.pixelDensityBlur) {
      this.pixelDensityBlur.destroy();
      this.pixelDensityBlur = null;
    }
    this.displaySprite = null;
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}