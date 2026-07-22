import { BlurFilter, Container, Graphics, Sprite, Text, Texture, type Filter } from 'pixi.js';
import type { HotspotDef } from '../data/types';
import type { DepthOcclusionFilter } from '../rendering/DepthOcclusionFilter';
import {
  blurStrengthFromPixelDensityK,
  computePixelDensityK,
  createPixelDensityBlurFilter,
  type TexelsPerWorld,
} from '../rendering/EntityPixelDensityMatch';
import {
  entityRotationRadOf,
  entityScaleOf,
  quadAabbAroundFoot,
  quadGroundYAroundFoot,
  quadTopLocalYAroundFoot,
} from '../utils/entityTransform';
import { hotspotCollisionPolygonToWorld } from '../utils/hotspotCollision';
import { isValidZonePolygon } from '../utils/zoneGeometry';
import type { PerspectiveScaleResolver } from '../utils/perspectiveScale';

const TYPE_COLORS: Record<string, number> = {
  inspect: 0x44aaff,
  pickup: 0xffcc44,
  transition: 0x44ff88,
};

export class Hotspot {
  public def: HotspotDef;
  public container: Container;

  /**
   * 显隐四通道，最终 active = 派生基底 ∧ 条件 ∧ override≠false ∧ !pickedUp，
   * 只在 applyEffectiveActive 一处合成。分通道的原因：InteractionSystem 每帧回写
   * 「派生基底/条件」通道，若与运行态位（拾取、会话隐藏）共用一个布尔，瞬时运行态
   * 会被下一帧的派生回写冲掉（已拾取热点复活、会话隐藏弹回）。
   */
  /** 派生基底（过场绑定 / sceneMemory enabled），InteractionSystem / SceneManager 每帧刷新 */
  private baseEnabled = true;
  /** conditionHidesEntity 的条件通道（无条件或不隐藏时恒 true） */
  private conditionEnabled = true;
  /** 会话级显隐覆盖（setEnabled / setEntitySessionEnabled 写入；不入档）；null=无覆盖，true 等价 null */
  private sessionEnabledOverride: boolean | null = null;
  /** 已被拾取/自消费（pickup 型另由 SceneManager 即时写入 sceneMemory） */
  private _pickedUp = false;
  private _active = true;

  private marker: Graphics;
  private displaySprite: Sprite | null = null;
  /** 仅运行时覆盖展示朝向，不改 def.displayImage/Save；null 则用 def（缺省视同为 right）。 */
  private runtimeDisplayFacingOverride: 'left' | 'right' | null = null;
  /** displayImage 世界高度；贴图为底中锚点，与 NPC/Player 脚底一致 */
  private _displayWorldHeight = 0;
  private depthOcclusionFilter: DepthOcclusionFilter | null = null;
  /** 展示图专用；与 DepthOcclusionFilter 组合为 [density, depth]，深度实例引用不变 */
  private pixelDensityBlur: BlurFilter | null = null;
  private promptIcon: Container | null = null;
  private showingPrompt: boolean = false;

  /** 场景透视缩放句柄（Game 注入；热点缺省不参与，perspectiveScaleEnabled===true 才存） */
  private perspectiveResolver: PerspectiveScaleResolver | null = null;
  /** 当前透视系数 f(脚底点投影)（派生态不入档）；与实例 scale 复合在 container 级 */
  private _depthScaleFactor = 1;

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
    this.applyInstanceTransform();
  }

  /**
   * 注入/清除场景透视缩放（近大远小）。热点缺省**不参与**（多为 WYSIWYG 贴背景绘制，
   * 缩放破坏对位；贴墙热点脚底 y 也不代表真实深度），perspectiveScaleEnabled===true 才生效。
   */
  setPerspectiveScale(resolver: PerspectiveScaleResolver | null): void {
    this.perspectiveResolver = this.def.perspectiveScaleEnabled === true ? resolver : null;
    this._refreshDepthScale();
  }

  /** 透视系数（供碰撞多边形换算/调试读取） */
  get depthScaleFactor(): number {
    return this._depthScaleFactor;
  }

  /** 实例 scale × 透视系数：容器缩放与全部 extent 派生量的统一口径 */
  private _combinedScale(): number {
    return entityScaleOf(this.def) * this._depthScaleFactor;
  }

  /** 按当前脚底点重求透视系数；变化时经 applyInstanceTransform 重派生全部派生量。 */
  private _refreshDepthScale(): void {
    const f = this.perspectiveResolver?.scaleAt(this.def.x, this.def.y) ?? 1;
    if (f === this._depthScaleFactor) return;
    this._depthScaleFactor = f;
    this.applyInstanceTransform();
  }

  /**
   * 实例 transform（def.scale/rotation，quad 级真变换，绕脚底锚点）×透视系数：容器级施加；
   * 彩色圆点/E 提示反向补偿保持可读；遮挡多边形与深度接地线同步重派生。
   * setEntityField 改字段后调用即生效；碰撞/交互半径在各自求值处读 def，无需失效。
   */
  applyInstanceTransform(): void {
    const s = this._combinedScale();
    this.container.scale.set(s, s);
    this.container.rotation = entityRotationRadOf(this.def);
    this._syncOverlayCompensation();
    this._syncEntitySortBand();
    this._syncSortFootY();
  }

  /** 圆点标记 / E 提示：抵消缩放（实例×透视）与旋转（展示图/朝向不受影响）。 */
  private _syncOverlayCompensation(): void {
    const s = this._combinedScale();
    const inv = 1 / s;
    const rot = -this.container.rotation;
    for (const child of [this.marker as Container | null, this.promptIcon]) {
      if (!child) continue;
      child.rotation = rot;
      child.scale.set(inv, inv);
    }
  }

  /** 深度排序接地线：旋转时把变换后 quad 底边 y 写给 Renderer.sortEntityLayer。 */
  private _syncSortFootY(): void {
    const c = this.container as Container & { entitySortFootY?: number };
    const rad = entityRotationRadOf(this.def);
    const size = this.getWorldSize();
    if (rad === 0 || size.height <= 0) {
      delete c.entitySortFootY;
      return;
    }
    c.entitySortFootY = quadGroundYAroundFoot(this.def.y, size.width, size.height, rad);
  }

  /** EventBus 调试 trace 投影：只吐可序列化关键数据，绝不暴露 `container`（活 PIXI 对象图，
   *  深拷贝会顺 parent/children 摊开整个场景）或 `def` 全量。见 EventBus.canonicalizeTraceValue。 */
  toTraceJSON(): { id: string; type: HotspotDef['type']; active: boolean } {
    return { id: this.def.id, type: this.def.type, active: this._active };
  }

  /** 与 Renderer.sortEntityLayer 配合：仅在有展示图且配置了 spriteSort 时标记容器 */
  private _syncEntitySortBand(): void {
    const c = this.container as Container & {
      entitySortBand?: 'back' | 'front';
      entityOcclusionPolygon?: ReadonlyArray<{ x: number; y: number }>;
    };
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

    const worldPoly = hotspotCollisionPolygonToWorld(this.def, this._depthScaleFactor);
    if (worldPoly && isValidZonePolygon(worldPoly)) {
      c.entityOcclusionPolygon = worldPoly;
    } else {
      delete c.entityOcclusionPolygon;
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
      // 清除展示图后恢复占位圆点（否则热点在场上完全不可见也无标记）
      this.marker.visible = true;
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
    // 换图后尺寸变了：实例 transform 的接地线/遮挡多边形一并重派生（含 band 同步）
    this.applyInstanceTransform();
  }

  private _effectiveDisplayFacing(): 'left' | 'right' {
    if (this.runtimeDisplayFacingOverride !== null) return this.runtimeDisplayFacingOverride;
    return this.def.displayImage?.facing === 'left' ? 'left' : 'right';
  }

  private _applyDisplayImageFacing(spr: Sprite): void {
    const flip = this._effectiveDisplayFacing() === 'left' ? -1 : 1;
    spr.scale.x = flip * Math.abs(spr.scale.x);
  }

  /**
   * 仅运行时：设定展示图左右朝向，或传入 null 清除覆盖（改用 def.displayImage.facing）。
   * 不写入场景 JSON/Save/displayImage。
   */
  setRuntimeDisplayFacing(facing: 'left' | 'right' | null): void {
    this.runtimeDisplayFacingOverride = facing;
    if (this.displaySprite) {
      this._applyDisplayImageFacing(this.displaySprite);
    }
  }

  /** 与 Player/NPC 一致：底中锚点下脚底即 container.y */
  depthOcclusionFootWorldY(): number {
    return this.container.y;
  }

  /** 投射阴影用：展示图**有效**世界尺寸（× 实例 scale × 透视系数）；无展示图时为 0（阴影源该帧不画） */
  getWorldSize(): { width: number; height: number } {
    const s = this._combinedScale();
    return {
      width: (this.def.displayImage?.worldWidth ?? 0) * s,
      height: this._displayWorldHeight * s,
    };
  }

  /** 投射阴影用：当前展示帧纹理（剪影）；无展示图返回 null */
  getDisplayTexture(): Texture | null {
    return this.displaySprite?.texture ?? null;
  }

  /** 投射阴影用：左右朝向（与展示图镜像一致），left=-1 / right=+1 */
  getFacing(): 1 | -1 {
    return this._effectiveDisplayFacing() === 'left' ? -1 : 1;
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

  /** 交互半径 × |实例 scale| × 透视系数（放大后交互圈也大；透视缩小同步收窄）。 */
  get effectiveInteractionRange(): number {
    return this.def.interactionRange * this._combinedScale();
  }

  setPosition(x: number, y: number): void {
    this.def.x = x;
    this.def.y = y;
    this._syncContainerPosition();
    // 透视系数是脚底点的派生量：移动后先重求（变化时内部已整套重派生）
    this._refreshDepthScale();
    // 遮挡带多边形是位置的派生量（world 坐标缓存在容器上），移动后必须重派生——
    // 否则 Renderer 前后带判定按旧位置多边形算，与求值时变换的阻挡碰撞裂脑（审查 F6）。
    this._syncEntitySortBand();
    const c = this.container as Container & { entitySortFootY?: number };
    if (c.entitySortFootY !== undefined) this._syncSortFootY();
  }

  /** 合成后的可交互/可见态（只读；写入走各通道 setter）。 */
  get active(): boolean {
    return this._active;
  }

  get pickedUp(): boolean {
    return this._pickedUp;
  }

  /** 四通道合成的唯一出口。 */
  private applyEffectiveActive(): void {
    const next =
      this.baseEnabled &&
      this.conditionEnabled &&
      this.sessionEnabledOverride !== false &&
      !this._pickedUp;
    if (this._active === next && this.container.visible === next) return;
    this._active = next;
    if (!next) this.hidePrompt();
    this.container.visible = next;
  }

  /**
   * 外部（Action / 持久化立即生效路径）显隐入口：写会话覆盖通道，
   * 不会被 InteractionSystem 的每帧派生回写冲掉；true 即清除覆盖。
   */
  setEnabled(enabled: boolean): void {
    this.setSessionEnabledOverride(enabled ? null : false);
  }

  /** 会话级覆盖通道（SceneManager.setEntitySessionEnabled / setEnabled 落点）。 */
  setSessionEnabledOverride(v: boolean | null): void {
    this.sessionEnabledOverride = v;
    this.applyEffectiveActive();
  }

  /** 派生基底通道：过场绑定 / sceneMemory enabled 推导值，由 InteractionSystem / SceneManager 每帧刷新。 */
  setDerivedBaseEnabled(base: boolean): void {
    this.baseEnabled = base;
    this.applyEffectiveActive();
  }

  /** 条件通道：conditionHidesEntity 时的条件求值结果（其余情况传 true）。 */
  setConditionEnabled(ok: boolean): void {
    this.conditionEnabled = ok;
    this.applyEffectiveActive();
  }

  /** 拾取/自消费：置运行态位（持久化由 SceneManager 决定——pickup 型即时入 sceneMemory）。 */
  markPickedUp(): void {
    this._pickedUp = true;
    this.applyEffectiveActive();
  }

  /** showEmote 取包围盒：有展示 sprite 则只量sprite（世界四边形）；否则量整容器（含占位圆点）。 */
  getEmoteBoundsProbe(): Container {
    return this.displaySprite ?? this.container;
  }

  /** showEmote 使用的热点世界 quad：展示图按底中锚点，未加载展示图时退化到占位圆点范围。 */
  getEmoteWorldQuad(): { left: number; top: number; width: number; height: number } {
    const di = this.def.displayImage;
    if (this.displaySprite && di && di.worldWidth > 0 && this._displayWorldHeight > 0) {
      const size = this.getWorldSize();
      return quadAabbAroundFoot(
        this.container.x,
        this.container.y,
        size.width,
        size.height,
        entityRotationRadOf(this.def),
      );
    }
    const markerSize = 16;
    return {
      left: this.container.x - markerSize / 2,
      top: this.container.y - markerSize / 2,
      width: markerSize,
      height: markerSize,
    };
  }

  /** 气泡父节点容器（与本类其它展示一致）。 */
  getDisplayObject(): unknown {
    return this.container;
  }

  /**
   * 有 displayImage 时：贴图为底中锚点，世界高度即为四边形竖直范围；
   * 气泡底边对齐在「sprite 顶端」之上 headGap（与 NPC 语义一致）。
   * 仅有彩色圆点时：对齐在圆点上方的估算位置。
   */
  getEmoteBubbleAnchorLocalY(): number {
    // 仅 entityAttachLayer 缺席的退化路径会走到（正常路径用 getEmoteWorldQuad，已变换）；
    // 同口径取变换后 quad 顶部（审查 P3-7）。
    const headGap = 8;
    if (this.displaySprite && this._displayWorldHeight > 0) {
      const size = this.getWorldSize();
      return quadTopLocalYAroundFoot(
        Math.max(size.width, 1),
        Math.max(size.height, 1),
        entityRotationRadOf(this.def),
      ) - headGap;
    }
    return -16 - headGap;
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
    // 迟建的提示图标立即抵消实例 transform（保持可读、不随实体旋转缩放）
    this._syncOverlayCompensation();
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