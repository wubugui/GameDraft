/**
 * 呼吸工作台 · GPU 画面（打进工作台的包，命名空间 `breathingView`；页面 `viewer/app.js` 只调这里）。
 *
 * **不写任何着色器、不重组任何着色式子**：画面是游戏同一套对象拼出来的——
 *
 * - 位移场 = 游戏的 `createBreathingFieldTextures`（.bin 两张 RGBA16F 背靠背）；
 * - 呼吸图 = 游戏的 `createBreathingOverlayMesh`（一张 Mesh + `breathingShade.wgsl`，层贴图按游戏装载口径：解码期已预乘、
 *   `layersPremultiplied = true`，着色器先除回去），摆法 = `percentLayerRect(屏宽, 屏高, 图宽, 图高, 50, 50, 100)`
 *   （与 `CutsceneRenderer.showBreathingLayer` 同一个函数：居中、宽 = 整屏宽、高按图的宽高比）；
 * - 每帧 uniform = 游戏的 `breathingUniforms(表演帧, rig)`（与 `BreathingOverlaySystem.uniformsOf` 同一条），经 mesh 的 `apply` 推进去。
 *
 * "屏"就是目标：预览 = 画布的 CSS 尺寸；出片 = 成品尺寸的离屏纹理（`tools/workbench_rhi/offscreenReadback.ts`）。
 * 屏尺寸变了就按新尺寸重建 mesh（游戏里等于按新屏幕重新 show 一次；位移场与层贴图不动）。
 *
 * 资源有主：层贴图归调用方（`workbenchRhi.loadTexture` 装的，Assets 缓存持有），这里只引用；位移场纹理与 mesh 归这里，
 * 拆卸顺序同游戏（`CutsceneRenderer.hideLayer`：摘下 → 销毁节点 → `disposeGpu`；再销毁位移场）。
 */
import { Container, type Texture } from '../../../src/engine2d';
import type { BreathingOverlayRig } from '../../../src/data/breathingOverlays';
import {
  createBreathingFieldTextures,
  createBreathingOverlayMesh,
  type BreathingOverlayMeshHandle,
} from '../../../src/rendering/breathingOverlayMesh';
import { breathingUniforms, type BreathingUniformInput } from '../../../src/rendering/breathingUniforms';
import { percentLayerRect } from '../../../src/rendering/overlayPercentLayout';

/** 一张呼吸图画面需要的全部输入（`resolveBreathingOverlay` 的产物里取） */
export interface BreathingAssetInput {
  size: [number, number];
  rig: BreathingOverlayRig;
  fields: { width: number; height: number };
  /** 位移场原始字节（两张 RGBA16F 背靠背） */
  fieldBytes: ArrayBuffer;
  base: Texture;
  body?: Texture | null;
  sheet?: Texture | null;
  flap?: Texture | null;
}

/** 静止帧（按住看原图）：每帧变的 uniform 全 0 */
export const REST_UNIFORMS: Readonly<Record<string, number>> = Object.freeze({ uInfl: 0, uFlapAng: 0, uShade: 0, uVentPx: 0, uCranPx: 0 });

export class BreathingStage {
  /** 渲染根（交给 `CanvasHost.render` / `OffscreenTarget.render`） */
  readonly root = new Container();
  private asset: BreathingAssetInput | null = null;
  private fields: { field1: Texture; field2: Texture } | null = null;
  private mesh: BreathingOverlayMeshHandle | null = null;
  private screen: [number, number] = [0, 0];
  private uniforms: Record<string, number> = { ...REST_UNIFORMS };

  constructor() {
    this.root.label = 'breathing-workbench-root';
  }

  /** 换一张呼吸图（旧的 mesh / 位移场先拆掉）；null = 什么都不画 */
  setAsset(asset: BreathingAssetInput | null): void {
    this.dropMesh();
    if (this.fields) {
      this.fields.field1.destroy(true);
      this.fields.field2.destroy(true);
      this.fields = null;
    }
    this.asset = asset;
    this.uniforms = { ...REST_UNIFORMS };
    if (!asset) return;
    this.fields = createBreathingFieldTextures(asset.fieldBytes, asset.fields.width, asset.fields.height);
    if (this.screen[0] > 0 && this.screen[1] > 0) this.buildMesh();
  }

  /** "屏"的逻辑尺寸（预览 = 画布 CSS 尺寸；出片 = 成品像素）。变了才重建 mesh */
  layout(screenW: number, screenH: number): void {
    if (screenW === this.screen[0] && screenH === this.screen[1] && (this.mesh || !this.asset)) return;
    this.screen = [screenW, screenH];
    if (this.asset && screenW > 0 && screenH > 0) this.buildMesh();
  }

  /** 这一帧的表演（`BreathingPerformance.frame()` + 那几个参数）→ 游戏同一个 uniform 换算 */
  applyFrame(input: BreathingUniformInput): void {
    if (!this.asset) return;
    this.apply(breathingUniforms(input, this.asset.rig));
  }

  /** 直接给每帧 uniform（`REST_UNIFORMS` = 静止帧） */
  apply(u: Readonly<Record<string, number>>): void {
    this.uniforms = { ...u };
    this.mesh?.apply(this.uniforms);
  }

  /** 当前推给着色器的每帧 uniform（自检 / 对照用） */
  currentUniforms(): Record<string, number> {
    return { ...this.uniforms };
  }

  get ready(): boolean {
    return !!this.mesh;
  }

  destroy(): void {
    this.setAsset(null);
    this.root.destroy({ children: true });
  }

  private buildMesh(): void {
    const a = this.asset;
    if (!a || !this.fields) return;
    this.dropMesh();
    const r = percentLayerRect(this.screen[0], this.screen[1], a.size[0], a.size[1], 50, 50, 100);
    const m = createBreathingOverlayMesh(
      { base: a.base, body: a.body ?? null, sheet: a.sheet ?? null, flap: a.flap ?? null, ...this.fields },
      a.rig, a.size, r.cx, r.cy, r.dispW, r.dispH,
    );
    m.mesh.label = 'breathing-workbench-overlay';
    m.apply(this.uniforms);
    this.root.addChild(m.mesh);
    this.mesh = m;
  }

  private dropMesh(): void {
    const m = this.mesh;
    if (!m) return;
    this.mesh = null;
    // 拆卸顺序同 CutsceneRenderer.hideLayer：摘下 → 销毁节点（不连贴图）→ disposeGpu（geometry + shader）
    if (m.mesh.parent) m.mesh.parent.removeChild(m.mesh);
    m.mesh.destroy({ children: true, texture: false, textureSource: false });
    m.disposeGpu();
  }
}
