/**
 * 燃烧工作台 · GPU 画面（打进工作台的包，命名空间 `burnView`；页面 `viewer/render.js` 只调这里）。
 *
 * **不写任何着色器、不重组任何着色式子**：画面是游戏同一套对象拼出来的——
 *
 * - 实例 = 游戏的热点实体 `Hotspot`（展示图 Sprite：底中锚点、实例缩放 / 旋转 / 透视 / 朝向全在它自己的变换里），
 *   燃烧着色 = 游戏的 `BurnRenderer` 按「滤镜宿主」挂上的两道燃烧滤镜（`BurnMaterialFilter` → `BurnGlowFilter`，
 *   WGSL 是 `src/rendering/burn/burnShade.wgsl`），燃烧 uv 仿射 = `burnHotspotFrame`（与 `Game.burnEntityHosts` 同一个函数），
 *   相机 uniform = `BurnRenderer.update(…, 世界容器的位置与缩放)`（与 `Game` 每帧推的同一条）；
 * - 燃烧场纹理的字节由模拟 `encodeTexture` 直接写进 `BurnRenderer.fieldData`，`markDirty(…, force)` 立刻上传；
 * - 与游戏的差别只有"工作台本来就不画的那几道"：没有像素密度低通、没有深度遮挡 + 受光（材质之后直接自发光），
 *   场景视图的背景是一张平贴图；NPC 实例按实例帧平贴（游戏里 NPC 走角色受光网格，工作台没有受光）。
 *
 * 资源有主（与游戏同一个拆卸顺序）：先 `BurnRenderer.detach`（从宿主摘滤镜 → 销毁滤镜 → 销毁燃烧场纹理），再销毁实体。
 * 贴图归调用方（`workbenchRhi.loadTexture` 装的，Assets 缓存持有），这里只引用。
 */
import { Container, Matrix, Sprite, type Filter, type Texture } from '../../../src/engine2d';
import { Hotspot } from '../../../src/entities/Hotspot';
import type { HotspotDef, HotspotDisplayImage } from '../../../src/data/types';
import { BurnRenderer } from '../../../src/rendering/burn/BurnRenderer';
import type { BurnShadeParams } from '../../../src/rendering/burn/burnShadeParams';
import { burnHotspotFrame, burnSceneToUvAffine, type BurnFrame } from '../../../src/systems/burn/burnGeometry';
import type { PerspectiveScaleResolver } from '../../../src/utils/perspectiveScale';

/** 一个实例的燃烧输入（没点 = 整个传 null：与游戏一样，只在"烧过"时挂燃烧着色） */
export interface BurnFieldInput {
  gridW: number;
  gridH: number;
  /** 字节来源的身份（换了模拟 = 换了来源）与代号（同一来源里字节变了就换）：两样都没变就不重编码 */
  source: object;
  gen: number;
  /** 把燃烧场编码进 `dst`（RGBA8，gridW × gridH）——就是模拟的 `encodeTexture` */
  encode(dst: Uint8Array): void;
  params: BurnShadeParams;
}

/** 热点实例：def 的摆放字段（x / y / scale / rotation / anchor / 透视开关）+ 展示图（模板图与真实尺寸 wu） */
export interface BurnHotspotInput {
  key: string;
  kind: 'hotspot';
  def: {
    id: string;
    x: number;
    y: number;
    scale?: number;
    rotation?: number;
    anchor?: { x?: number; y?: number } | null;
    perspectiveScaleEnabled?: boolean;
    displayImage: HotspotDisplayImage;
  };
  texture: Texture;
  /** 场景透视（热点只有 `perspectiveScaleEnabled === true` 才吃，`Hotspot.setPerspectiveScale` 自己判） */
  perspective?: PerspectiveScaleResolver | null;
  burn: BurnFieldInput | null;
}

/** 按实例帧平贴的实例（NPC：游戏里走角色受光网格，工作台只平贴） */
export interface BurnFrameInput {
  key: string;
  kind: 'frame';
  frame: BurnFrame;
  texture: Texture;
  burn: BurnFieldInput | null;
}

export type BurnInstanceInput = BurnHotspotInput | BurnFrameInput;

/** BurnRenderer 的滤镜宿主（热点 = 转给游戏的 Hotspot；平贴 = 精灵的滤镜链）。记下挂上来的两道滤镜，给自检的「只挂材质」用 */
interface FilterHostView {
  host: { setBurnFilters(material: Filter | null, glow: Filter | null): void };
  filters: [Filter | null, Filter | null];
  materialOnly: boolean;
  apply(material: Filter | null, glow: Filter | null): void;
}

interface HotspotView extends FilterHostView {
  kind: 'hotspot';
  sig: string;
  size: { width: number; height: number };
  texture: Texture;
  perspective: PerspectiveScaleResolver | null;
  hotspot: Hotspot;
  node: Container;
}

interface FrameView extends FilterHostView {
  kind: 'frame';
  frame: BurnFrame;
  texture: Texture;
  sprite: Sprite;
  node: Container;
}

/** 宿主转发：BurnRenderer 挂 / 摘滤镜时先记下，「只挂材质」时自发光那一道不交给实体 */
function filterHost(view: FilterHostView): FilterHostView['host'] {
  return {
    setBurnFilters(material: Filter | null, glow: Filter | null): void {
      view.filters = [material, glow];
      view.apply(material, view.materialOnly ? null : glow);
    },
  };
}

type View = HotspotView | FrameView;

/** 燃烧场上一次编码到的 (纹理字节数组, 来源, 代号)：都没变就不重编码、不重传 */
interface FieldMark {
  data: Uint8Array;
  source: object;
  gen: number;
}

export class BurnStage {
  /** 渲染根（交给 `CanvasHost.render`） */
  readonly root = new Container();
  /** 世界容器 = 游戏的 `worldContainer`：位置 = 相机平移（屏幕 CSS 像素），缩放 = 投影缩放 */
  readonly world = new Container();
  readonly burn = new BurnRenderer();
  private background: Sprite | null = null;
  private readonly views = new Map<string, View>();
  private readonly marks = new Map<string, FieldMark>();
  private camera = { x: 0, y: 0, scale: 1 };

  constructor() {
    this.root.label = 'burn-workbench-root';
    this.world.label = 'burn-workbench-world';
    this.root.addChild(this.world);
  }

  /** 相机：场景点 p 画在屏幕 `p · scale + (x, y)`（与页面 `toScreen` 同一个变换） */
  setCamera(scale: number, x: number, y: number): void {
    this.camera = { x, y, scale };
    this.world.position.set(x, y);
    this.world.scale.set(scale, scale);
  }

  /** 场景视图的背景（平贴，铺满 0..width × 0..height）；null = 不画 */
  setBackground(texture: Texture | null, width = 0, height = 0): void {
    if (!texture || !(width > 0) || !(height > 0)) {
      if (this.background) {
        this.background.destroy();
        this.background = null;
      }
      return;
    }
    if (!this.background || this.background.texture !== texture) {
      this.background?.destroy();
      this.background = new Sprite(texture);
      this.background.label = 'burn-workbench-background';
    }
    this.background.position.set(0, 0);
    this.background.width = width;
    this.background.height = height;
  }

  /**
   * 这一帧要画的实例（按给的顺序从后往前画）。没列出的实例连同燃烧着色一起拆掉。
   * `nowMs` 只是 `BurnRenderer` 的上传限速钟（这里每次有新字节都强制立刻传，不受限速影响）。
   */
  sync(instances: readonly BurnInstanceInput[], nowMs: number): void {
    const want = new Set(instances.map((i) => i.key));
    for (const key of [...this.views.keys()]) if (!want.has(key)) this.drop(key);
    const order: Container[] = [];
    if (this.background) order.push(this.background);
    for (const inst of instances) {
      const view = this.viewFor(inst);
      order.push(view.node);
      this.syncBurn(inst, view, nowMs);
    }
    // 画序 = 子节点顺序（与实例列表一致；已在正确位置的不动）
    order.forEach((node, i) => {
      if (node.parent !== this.world) this.world.addChildAt(node, i);
      else if (this.world.getChildIndex(node) !== i) this.world.setChildIndex(node, i);
    });
    this.burn.update(nowMs, this.camera);
  }

  /** 只留下 key 满足 `keep` 的实例（切视图时把另一个视图的着色资源放掉） */
  retain(keep: (key: string) => boolean): void {
    for (const key of [...this.views.keys()]) if (!keep(key)) this.drop(key);
  }

  /** 这张纹理要被卸载了：先把引用它的背景 / 实例拆掉（绑定已销毁的纹理 = 那一帧抛错） */
  forgetTexture(texture: Texture | null): void {
    if (!texture) return;
    if (this.background?.texture === texture) this.setBackground(null);
    for (const [key, v] of [...this.views]) if (v.texture === texture) this.drop(key);
  }

  /** 实例此刻的实例帧（热点 = 游戏 `burnHotspotFrame` 从 Hotspot 本体量；燃烧 uv 仿射就是它）；没有 = null */
  frameOf(key: string): BurnFrame | null {
    const v = this.views.get(key);
    return v ? frameOfView(v) : null;
  }

  /**
   * 自检用：这个实例只挂燃烧材质那一道（自发光先不挂），材质就成了滤镜链的最后一道。`false` = 恢复两道。
   * 用处：材质在链中间时屏幕位置按相对 bounds 的坐标算（master 同一 bug，见 agent_docs/_meta/inbox/2026-09-28-filters-mid-chain-screen-pos.md），
   * 最后一道拿得到真屏幕坐标——两种挂法读到的像素一对比，就知道一处不对是不是这个已知 bug。返回这个实例此刻有没有挂燃烧着色。
   */
  setMaterialOnly(key: string, on: boolean): boolean {
    const v = this.views.get(key);
    if (!v) return false;
    v.materialOnly = on;
    v.apply(v.filters[0], on ? null : v.filters[1]);
    return !!v.filters[0];
  }

  /** 这个实例现在挂着燃烧着色吗（自检用） */
  burning(key: string): boolean {
    return this.burn.has(key);
  }

  keys(): string[] {
    return [...this.views.keys()];
  }

  destroy(): void {
    for (const key of [...this.views.keys()]) this.drop(key);
    this.burn.clear();
    this.setBackground(null);
    this.root.destroy({ children: true });
  }

  // ─────────────────────────────────────────────────────────────── 内部

  private viewFor(inst: BurnInstanceInput): View {
    const cur = this.views.get(inst.key);
    if (inst.kind === 'hotspot') {
      const sig = JSON.stringify(inst.def);
      const persp = inst.perspective ?? null;
      if (cur && cur.kind === 'hotspot' && cur.sig === sig && cur.texture === inst.texture && cur.perspective === persp) return cur;
      if (cur) this.drop(inst.key);
      const def = { type: 'inspect', interactionRange: 0, data: {}, ...structuredClone(inst.def) } as unknown as HotspotDef;
      const hotspot = new Hotspot(def);
      hotspot.setPerspectiveScale(persp);
      hotspot.setDisplayTexture(inst.texture, inst.def.displayImage.worldWidth, inst.def.displayImage.worldHeight);
      const size = { width: inst.def.displayImage.worldWidth, height: inst.def.displayImage.worldHeight };
      const view = {
        kind: 'hotspot', sig, size, texture: inst.texture, perspective: persp, hotspot, node: hotspot.container,
        filters: [null, null], materialOnly: false, apply: (m: Filter | null, g: Filter | null) => hotspot.setBurnFilters(m, g),
      } as unknown as HotspotView;
      view.host = filterHost(view);
      this.views.set(inst.key, view);
      return view;
    }
    if (cur && cur.kind === 'frame' && cur.texture === inst.texture) {
      cur.frame = inst.frame;
      placeOnFrame(cur.sprite, inst.frame);
      return cur;
    }
    if (cur) this.drop(inst.key);
    const sprite = new Sprite(inst.texture);
    sprite.label = `burn-frame:${inst.key}`;
    placeOnFrame(sprite, inst.frame);
    const view = {
      kind: 'frame', frame: inst.frame, texture: inst.texture, sprite, node: sprite, filters: [null, null], materialOnly: false,
      apply: (material: Filter | null, glow: Filter | null) => {
        const chain: Filter[] = [];
        if (material) chain.push(material);
        if (glow) chain.push(glow);
        sprite.filters = chain;
      },
    } as unknown as FrameView;
    view.host = filterHost(view);
    this.views.set(inst.key, view);
    return view;
  }

  private syncBurn(inst: BurnInstanceInput, view: View, nowMs: number): void {
    const b = inst.burn;
    if (!b) {
      if (this.burn.has(inst.key)) this.burn.detach(inst.key);
      this.marks.delete(inst.key);
      return;
    }
    const host = view.host;
    // 同一宿主同尺寸 = 什么都不做；换了宿主 / 网格尺寸 = BurnRenderer 自己先拆再挂（换了新纹理，字节数组身份跟着变）
    this.burn.attach(inst.key, { kind: 'filters', host }, b.gridW, b.gridH);
    const data = this.burn.fieldData(inst.key);
    const mark = this.marks.get(inst.key);
    if (data && (!mark || mark.data !== data || mark.source !== b.source || mark.gen !== b.gen)) {
      b.encode(data);
      this.marks.set(inst.key, { data, source: b.source, gen: b.gen });
      this.burn.markDirty(inst.key, nowMs, true);
    }
    this.burn.setShade(inst.key, b.params, burnSceneToUvAffine(frameOfView(view)));
  }

  private drop(key: string): void {
    // 拆卸顺序同游戏：先摘燃烧滤镜（BurnRenderer：摘 → 销毁滤镜 → 销毁燃烧场纹理），再销毁实体
    if (this.burn.has(key)) this.burn.detach(key);
    this.marks.delete(key);
    const v = this.views.get(key);
    this.views.delete(key);
    if (!v) return;
    if (v.kind === 'hotspot') v.hotspot.destroy();
    else {
      v.sprite.filters = [];
      v.sprite.destroy();
    }
  }
}

function frameOfView(v: View): BurnFrame {
  return v.kind === 'hotspot' ? burnHotspotFrame(v.hotspot, v.size) : v.frame;
}

/** 精灵按实例帧摆：贴图像素 (px, py) → 场景 `o + u·px/tw + v·py/th` */
function placeOnFrame(sprite: Sprite, f: BurnFrame): void {
  const tw = Math.max(1e-6, sprite.texture.frame.width);
  const th = Math.max(1e-6, sprite.texture.frame.height);
  sprite.anchor.set(0, 0);
  sprite.setFromMatrix(new Matrix(f.ux / tw, f.uy / tw, f.vx / th, f.vy / th, f.ox, f.oy));
}

/**
 * 原画视图那个实例的热点 def：图按**像素**摆在 (0, 0)–(W, H)（原画视图的坐标就是图像素），
 * 等价于游戏里一个脚点在 (W/2, H)、展示尺寸 W × H、不缩放不旋转的热点。
 */
export function artHotspotDef(image: string, width: number, height: number): BurnHotspotInput['def'] {
  return { id: '__template__', x: width / 2, y: height, displayImage: { image, worldWidth: width, worldHeight: height } };
}
