/**
 * 场景前景图层的装配（一场景一份）。见 [[scene-foreground-layers]]。
 *
 * 前景层**不重画任何像素**：背景里的树本来就画着，要做的只是让"站在树后的东西"在树的像素上变成虚影——
 * 那是遮挡判据的事。本类把所有层的蒙版（经位移图、跟着摆）连同**前景面深度**渲进一张覆盖图
 * （`foregroundMaskGlsl` 头注释说通道），交给遮挡的消费方（三支实体滤镜、粒子）：蒙版里用前景面深度
 * **顶替深度图**，逐像素比——站位不同、压着的部位不同，答案就不同；被挡部分与深度遮挡同一个虚影系数。
 *
 * **所有权**：覆盖图网格由 `SwayBackground` 创建并登记（它销毁时一并销毁，兜底）；本类持有覆盖图 RT。
 * 拆除时**先**以 null 通知使用者（滤镜 / 粒子绑回占位），**再**销毁 RT——BindGroup 见到已销毁的资源会自毁、
 * 下一帧渲染即抛、整局卡死（pixi-v8-traps）。
 */
import { Container, MeshGeometry, RenderTexture, Sprite, type Renderer, type Texture } from 'pixi.js';

import {
  foregroundBaseSamples, foregroundRect, quantizeForegroundDisplacement,
  type ForegroundBaseSamples, type ForegroundDepthModel, type ResolvedForegroundLayer,
} from './foregroundLayerDefs';
import { FG_COVERAGE_DILATE_PX } from './foregroundMaskGlsl';

export { FG_COVERAGE_DILATE_PX };

/** 覆盖图网格（背景对象交出来的）。`destroy` 幂等；背景对象也可能先把它销毁 */
export interface ForegroundMask {
  readonly mesh: Container;
  readonly destroyed: boolean;
  /** 换网格范围（场景 wu）：只改四个顶点与 uv */
  setRect(rect: readonly [number, number, number, number]): void;
  /** 换接地采样与深度梯度（行走面换了 / 地形推送） */
  setBase(base: ForegroundBaseSamples, uprightPerY: number): void;
  destroy(): void;
}

/** 出覆盖图网格的一方（`SwayBackground`：位移图与 id / matte 都在它手里） */
export interface ForegroundMaskHost {
  createForegroundMask(
    rect: readonly [number, number, number, number], instId: number,
    target: { w: number; h: number }, dilatePaintPx: number,
    base: ForegroundBaseSamples, uprightPerY: number,
  ): ForegroundMask | null;
}

/** 覆盖图网格用的一块矩形：铺在 `rect`（场景 wu），uv = rect 在整张场景里的那一段（场景归一化） */
export function foregroundRectGeometry(
  rect: readonly [number, number, number, number], worldW: number, worldH: number,
): MeshGeometry {
  const [x0, y0, x1, y1] = rect;
  return new MeshGeometry({
    positions: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    uvs: new Float32Array([
      x0 / worldW, y0 / worldH, x1 / worldW, y0 / worldH, x1 / worldW, y1 / worldH, x0 / worldW, y1 / worldH,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
}

/** 原地改一块网格的范围（四个顶点 + uv，口径同 {@link foregroundRectGeometry}） */
export function setForegroundRect(
  geometry: MeshGeometry, rect: readonly [number, number, number, number], worldW: number, worldH: number,
): void {
  const [x0, y0, x1, y1] = rect;
  geometry.positions = new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]);
  geometry.uvs = new Float32Array([
    x0 / worldW, y0 / worldH, x1 / worldW, y0 / worldH, x1 / worldW, y1 / worldH, x0 / worldW, y1 / worldH,
  ]);
}

/**
 * 覆盖图分辨率 = 原画的几分之一。覆盖图每帧随摆动重渲，GPU 开销大头是**清整张图**
 * （2026-09-26 跑马梁实测：1/2 分辨率 1024×576 光清屏 0.12 ms、绘制 0.14 ms），1/4 两样都降到四分之一。
 * 细枝靠前景面那一路按纹素足迹取样兜住（见 `FG_COVERAGE_FRAG`），不靠分辨率。
 */
export const FG_COVERAGE_DOWNSCALE = 4;

export interface SceneForegroundLayersOptions {
  layers: readonly ResolvedForegroundLayer[];
  maskHost: ForegroundMaskHost;
  /** 原画像素尺寸（覆盖图按它的 1/{@link FG_COVERAGE_DOWNSCALE} 开） */
  paintSize: readonly [number, number];
  /** 场景世界尺寸（网格范围钳在它里面） */
  sceneSize: readonly [number, number];
  /** 各株网格顶点此刻的真实最大位移（场景 wu）：建层时取一次，之后逐帧经 {@link SceneForegroundLayers.updateDisplacement} 跟 */
  displacementOf: (instId: number) => number;
  /** 前景面深度模型（行走面深度场 + 直立面深度梯度）；没有行走面场 ⇒ null，整层建不起来 */
  depthModel: ForegroundDepthModel | null;
  /**
   * 覆盖图换了：第一次渲出来之后给纹理；关掉 / 渲染失败 / 拆除时给 null。
   * 使用者（实体滤镜、粒子）据此绑 / 解绑。
   */
  onCoverage: (tex: Texture | null) => void;
  log?: (msg: string) => void;
}

interface Part {
  layer: ResolvedForegroundLayer;
  mask: ForegroundMask;
  /** 当前网格按哪一档位移铺的 */
  pad: number;
  base: ForegroundBaseSamples;
}

export class SceneForegroundLayers {
  private readonly parts: Part[] = [];
  private readonly maskRoot = new Container();
  private coverage: RenderTexture | null = null;
  /** 覆盖图已交给使用者（第一次渲成功之后） */
  private coverageLive = false;
  private coverageDirty = true;
  private coverageBroken = false;
  private enabled = true;
  private destroyed = false;
  private debugSprite: Sprite | null = null;
  private ms = 0;
  readonly layers: readonly ResolvedForegroundLayer[];

  constructor(private readonly opts: SceneForegroundLayersOptions) {
    const built: ResolvedForegroundLayer[] = [];
    const cw = Math.max(1, Math.ceil(opts.paintSize[0] / FG_COVERAGE_DOWNSCALE));
    const ch = Math.max(1, Math.ceil(opts.paintSize[1] / FG_COVERAGE_DOWNSCALE));
    const model = opts.depthModel;
    if (!model) {
      if (opts.layers.length) opts.log?.('本场景没有行走面深度场，前景面深度算不出来，前景层全部跳过');
      this.layers = [];
      return;
    }
    for (const L of opts.layers) {
      const base = foregroundBaseSamples(L, model, opts.sceneSize);
      if (!base) {
        opts.log?.(`前景层「${L.id}」的接地点取不到行走面深度（在行走面场外？），跳过`);
        continue;
      }
      const pad = quantizeForegroundDisplacement(opts.displacementOf(L.instId));
      const rect0 = foregroundRect(L.bbox, pad, opts.sceneSize);
      const mask = opts.maskHost.createForegroundMask(rect0, L.instId, { w: cw, h: ch }, FG_COVERAGE_DILATE_PX, base, model.uprightPerY);
      if (!mask) {
        opts.log?.(`前景层「${L.id}」的覆盖图网格没建起来（草木拆层已拆？），跳过`);
        continue;
      }
      this.parts.push({ layer: L, mask, pad, base });
      built.push(L);
    }
    this.layers = built;
    this.orderFarToNear();
    if (this.parts.length > 0) {
      // 半浮点：G 存的是预乘过的深度（可以为负、要几位小数）
      this.coverage = RenderTexture.create({
        width: cw, height: ch, format: 'rgba16float', scaleMode: 'linear', antialias: false,
      });
    }
  }

  /** 多层叠覆盖图按远→近画（预乘"over"：近的盖远的）。深度越大越远 */
  private orderFarToNear(): void {
    const sorted = [...this.parts].sort((a, b) => b.base.meanDepth - a.base.meanDepth);
    for (const p of sorted) if (!p.mask.destroyed) this.maskRoot.addChild(p.mask.mesh);
  }

  get layerCount(): number { return this.layers.length; }
  get isEnabled(): boolean { return this.enabled; }
  /** 覆盖图渲染的 CPU 耗时（毫秒，平滑过）；F2 读 */
  get coverageMs(): number { return this.ms; }
  /** 已交给使用者的覆盖图（关着 / 还没渲过 / 坏了 ⇒ null） */
  get coverageTexture(): Texture | null {
    return this.enabled && this.coverageLive && this.coverage ? this.coverage : null;
  }

  /** 各层此刻的接地采样（调试 / 测试） */
  get bases(): ForegroundBaseSamples[] { return this.parts.map((p) => p.base); }

  /** 背景又画了新的一帧位移图（草木动了）：下一次 `renderCoverage` 重渲 */
  markCoverageDirty(): void { this.coverageDirty = true; }

  /** 此刻各层的网格范围（场景 wu；调试 / 测试） */
  get rects(): Array<[number, number, number, number]> {
    return this.parts.map((p) => foregroundRect(p.layer.bbox, p.pad, this.opts.sceneSize));
  }

  /**
   * 逐帧（位移图渲完之后）：各株网格顶点的真实最大位移按档量化，**变档**才改该层覆盖图网格的四个顶点——
   * 树摆出网格的那一截就不再算前景面，所以不能只在建层时铺一次。不变档是一次比较。
   */
  updateDisplacement(displacementOf: (instId: number) => number = this.opts.displacementOf): void {
    if (this.destroyed) return;
    for (const p of this.parts) {
      const d = displacementOf(p.layer.instId);
      if (!Number.isFinite(d)) continue;
      const pad = quantizeForegroundDisplacement(d);
      if (pad === p.pad) continue;
      p.pad = pad;
      if (!p.mask.destroyed) p.mask.setRect(foregroundRect(p.layer.bbox, pad, this.opts.sceneSize));
      this.coverageDirty = true;
    }
  }

  /** 行走面深度场换了（载荷落地 / 地形工作台推送）：接地深度按新的场重取。取不到的层保留旧值并出声 */
  refreshBase(model: ForegroundDepthModel | null): void {
    if (this.destroyed || !model) return;
    for (const p of this.parts) {
      const base = foregroundBaseSamples(p.layer, model, this.opts.sceneSize);
      if (!base) { this.opts.log?.(`前景层「${p.layer.id}」换行走面后接地深度取不到，沿用旧值`); continue; }
      p.base = base;
      if (!p.mask.destroyed) p.mask.setBase(base, model.uprightPerY);
    }
    for (const p of this.parts) if (!p.mask.destroyed) this.maskRoot.removeChild(p.mask.mesh);
    this.orderFarToNear();
    this.coverageDirty = true;
  }

  /**
   * 把覆盖图渲出来。放在位移图之后、主画面之前（与 `SwayBackground.renderUv` 同一拍）。
   * 渲染路径上抛一次 = 整局卡死，所以兜住：大声报一次，之后覆盖图作废（遮挡照旧按深度判）。
   */
  renderCoverage(renderer: Renderer): void {
    if (this.destroyed || !this.enabled || this.coverageBroken || !this.coverage || !this.coverageDirty) return;
    const t0 = performance.now();
    try {
      renderer.render({ container: this.maskRoot, target: this.coverage, clear: true, clearColor: [0, 0, 0, 0] });
      this.coverageDirty = false;
      if (!this.coverageLive) {
        this.coverageLive = true;
        this.opts.onCoverage(this.coverage);
      }
    } catch (e) {
      this.coverageBroken = true;
      console.error('[foreground] 覆盖图渲染失败，前景层失效、遮挡照旧按深度判', e);
      if (this.coverageLive) this.opts.onCoverage(null);
      this.coverageLive = false;
    }
    this.ms += (performance.now() - t0 - this.ms) * 0.1;
  }

  /** F2：整体开关。关 = 遮挡的使用方不读覆盖图（与没配前景层逐像素相同） */
  setEnabled(on: boolean): void {
    if (this.destroyed || on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      if (this.coverageLive) this.opts.onCoverage(null);
      this.coverageLive = false;
      if (this.debugSprite) this.debugSprite.visible = false;
    } else {
      this.coverageDirty = true;            // 下一次 renderCoverage 渲完再交出去
      if (this.debugSprite) this.debugSprite.visible = true;
    }
  }

  /**
   * F2：把覆盖图半透明叠在世界上（品红 = 前景面，按前景面深度判遮挡；红 = 外沿，只关掉深度图的误挡）。
   * `parent` = 世界容器（覆盖图按场景尺寸铺满）。
   */
  setCoverageView(on: boolean, parent: Container | null, sceneSize: readonly [number, number]): void {
    if (this.destroyed) return;
    if (!on || !parent || !this.coverage) {
      this.debugSprite?.destroy();
      this.debugSprite = null;
      return;
    }
    if (this.debugSprite) return;
    const s = new Sprite(this.coverage);
    s.label = 'fg:coverage-view';
    s.eventMode = 'none';
    s.tint = 0xff33cc;
    s.alpha = 0.45;
    s.width = sceneSize[0];
    s.height = sceneSize[1];
    s.visible = this.enabled;
    parent.addChild(s);
    this.debugSprite = s;
  }

  get coverageViewOn(): boolean { return this.debugSprite !== null; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // ⚠ 顺序即正确性：先让使用者绑回占位，再拆读它的调试图，最后才销毁 RT
    if (this.coverageLive) this.opts.onCoverage(null);
    this.coverageLive = false;
    this.debugSprite?.destroy();
    this.debugSprite = null;
    for (const p of this.parts) p.mask.destroy();
    this.parts.length = 0;
    this.maskRoot.destroy();
    this.coverage?.destroy(true);
    this.coverage = null;
  }
}
