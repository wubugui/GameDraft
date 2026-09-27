/**
 * 粒子工作台 · GPU 画面（打进工作台的包，命名空间 `vfxView`；页面 `viewer/view2d.js` / `viewer/lightning.js` 只调这里）。
 *
 * **不写任何着色器、不重组任何着色式子**：画面是游戏同一套对象拼出来的——
 *
 * - 粒子 / 薄片 / 雷 / 光柱 = 游戏的 `VfxRenderer`（`VfxBatchMesh` / `VfxPlateBatchMesh` / `VfxBoltBatchMesh` / `VfxBeamView`，
 *   WGSL 是 `vfxShaders.ts` / `vfxBeamShaders.ts` 那几份），喂的就是页面里跑的运行时模拟 `VfxInstanceSim`；
 * - 贴图表 = `loadVfxSpriteSheet`（与 `VfxSystem` 同一个函数），贴图装载 = `resolveAssetPath` + engine2d `Assets.load`
 *   （与 `AssetManager.loadTexture` 同一条）；
 * - 场景树照游戏组装层（`Renderer`）：舞台 → 世界容器（位置 = 相机平移、缩放 = 投影缩放）→ 背景层 / 实体层
 *   （`sortableChildren`，画完按 `entitySortZ` 排——`Renderer.sortEntityLayer` 同一条规则）；
 * - 原画深度 = 场景 `depthConfig.depth_map` 那张图（`sceneRuntimeAssetUrl`，与 `SceneDepthSystem` 同一个地址）+ 同一份
 *   `depth_mapping` / `depth_tolerance`：粒子、光柱被原画挡住的样子与游戏相同。
 *
 * 与游戏的差别只有"工作台本来就没有的那几样"（同 `CanvasVfxHost` 的无光口径）：没有照明载荷（受光粒子走无光路、
 * 色调融入强度 0）、显示变换恒等（`createCharLightUniforms` 缺省）、没有背景草木摆动（躺着的纸不跟草走）、
 * 背景是一张平贴的原画（游戏里过显示变换 / 重打光）。最终亮度去游戏看。
 *
 * 资源有主：网格 / 着色器归 `VfxRenderer`（`clear` / `destroy` 收）；贴图归调用方（`Assets` 缓存持有），这里只引用。
 */
import { Assets, Container, Graphics, Sprite, Texture } from '../../../src/engine2d';
import { resolveAssetPath } from '../../../src/core/assetPath';
import { sceneRuntimeAssetUrl } from '../../../src/core/projectPaths';
import type { SceneDepthConfig, VfxAppearanceDef, VfxEffectDef, VfxSurfaceKind } from '../../../src/data/types';
import { createCharLightUniforms } from '../../../src/rendering/CharacterLitSprite';
import { entitySortZ, type EntitySortBand } from '../../../src/rendering/entitySortRule';
import { VfxRenderer, type VfxSpriteSheet } from '../../../src/rendering/vfx/VfxRenderer';
import { VfxInstanceSim } from '../../../src/systems/vfx/vfxSim';
import { BOLT_STUB_SHEET, loadVfxSpriteSheet, vfxSheetKey, type VfxSheetLoader } from '../../../src/systems/vfx/vfxSpriteSheet';
import { createPlanarVfxSpace, type VfxSpace } from '../../../src/systems/vfx/vfxSpace';

/** 贴图装载：与 `AssetManager.loadJson` / `loadTexture` 同一条（fetch + json；`resolveAssetPath` + `Assets.load`） */
export const workbenchSheetLoader: VfxSheetLoader = {
  async loadJson<T = unknown>(path: string): Promise<T> {
    const resolved = resolveAssetPath(path);
    const r = await fetch(resolved);
    if (!r.ok) throw new Error(`fetch ${r.status} for ${resolved}`);
    return (await r.json()) as T;
  },
  loadTexture(path: string): Promise<Texture> {
    return Assets.load<Texture>(resolveAssetPath(path));
  },
};

/** 场景深度图的地址（与 `SceneDepthSystem.load` 同一个） */
export function sceneDepthUrl(sceneId: string, cfg: Pick<SceneDepthConfig, 'depth_map'>): string {
  return sceneRuntimeAssetUrl(sceneId, cfg.depth_map);
}

interface SheetRec {
  promise: Promise<void>;
  sheet: VfxSpriteSheet | null;
  err: string;
  done: boolean;
}

interface TexRec {
  promise: Promise<void>;
  tex: Texture | null;
  err: string;
  done: boolean;
}

/**
 * 发射器贴图表 / 光柱图案遮罩的装载簿（与 `VfxSystem` 同一个按外观的缓存键）：还没装到的不在表里（渲染器照游戏的闸跳过它），
 * 装到了叫 `onReady`（页面重画）。
 */
export class VfxSheetBook {
  private readonly sheets = new Map<string, SheetRec>();
  private readonly cookies = new Map<string, TexRec>();
  pending = 0;

  constructor(private readonly loader: VfxSheetLoader = workbenchSheetLoader, private readonly onReady: () => void = () => {}) {}

  private sheetRec(ap: VfxAppearanceDef): SheetRec {
    const key = vfxSheetKey(ap);
    let r = this.sheets.get(key);
    if (r) return r;
    this.pending++;
    const rec: SheetRec = { promise: Promise.resolve(), sheet: null, err: '', done: false };
    rec.promise = loadVfxSpriteSheet(ap, this.loader).then(
      (s) => { rec.sheet = s; if (!s) rec.err = '外观没有贴图（animFile / image 都没写，或动画包没有状态）'; },
      (e) => { rec.err = String((e as Error)?.message ?? e); },
    ).finally(() => { rec.done = true; this.pending--; this.onReady(); });
    this.sheets.set(key, rec);
    r = rec;
    return r;
  }

  private cookieRec(url: string): TexRec {
    let r = this.cookies.get(url);
    if (r) return r;
    this.pending++;
    const rec: TexRec = { promise: Promise.resolve(), tex: null, err: '', done: false };
    rec.promise = this.loader.loadTexture(url).then(
      (t) => { rec.tex = t ?? null; },
      (e) => { rec.err = String((e as Error)?.message ?? e); },
    ).finally(() => { rec.done = true; this.pending--; this.onReady(); });
    this.cookies.set(url, rec);
    return rec;
  }

  /**
   * 这一份效果的贴图表（`<实例 id>/<发射器 id>`，与 `VfxSystem.sheets` 同键）与光柱遮罩（`<实例 id>/<光柱 id>`）。
   * 没装到的先不在表里（发射器不画、光柱先不带图案画），装到后 `onReady`。
   */
  tables(instanceId: string, effect: Pick<VfxEffectDef, 'emitters' | 'beams'>): {
    sheets: Map<string, VfxSpriteSheet>; beamTextures: Map<string, Texture>; errors: string[];
  } {
    const sheets = new Map<string, VfxSpriteSheet>();
    const beamTextures = new Map<string, Texture>();
    const errors: string[] = [];
    for (const em of effect.emitters ?? []) {
      if (!em || !em.appearance) continue;
      const r = this.sheetRec(em.appearance);
      if (r.sheet) sheets.set(`${instanceId}/${em.id}`, r.sheet);
      else if (r.done && r.err) errors.push(`发射器「${em.id}」的贴图装不到：${r.err}`);
    }
    for (const b of effect.beams ?? []) {
      const url = b && b.cookie && b.cookie.image;
      if (!url) continue;
      const r = this.cookieRec(url);
      if (r.tex) beamTextures.set(`${instanceId}/${b.id}`, r.tex);
      else if (r.done && r.err) errors.push(`光柱「${b.id}」的图案遮罩装不到：${r.err}`);
    }
    return { sheets, beamTextures, errors };
  }

  /** 全部在途的装载落定（自检 / 对照用） */
  async settle(): Promise<void> {
    for (let i = 0; i < 20 && this.pending > 0; i++) {
      await Promise.all([...this.sheets.values(), ...this.cookies.values()].map((r) => r.promise));
    }
  }
}

/** 实体层排序（`Renderer.sortEntityLayer` 同一条规则：档位 × 脚底 y；工作台没有玩家、没有热点遮挡带） */
function sortEntityLayer(layer: Container): void {
  for (const child of layer.children) {
    const ext = child as Container & { entitySortBand?: EntitySortBand; entitySortFootY?: number };
    child.zIndex = entitySortZ({ band: ext.entitySortBand, sortFootY: ext.entitySortFootY, y: child.y });
  }
  layer.sortChildren();
}

/** 光柱的网格（`VfxBeamView`：着色器资源里带 `vfxBeam` 组）；图层「光柱」去勾时这些不画 */
function isBeamMesh(c: Container): boolean {
  const sh = (c as Container & { shader?: { resources?: Record<string, unknown> } }).shader;
  return !!(sh && sh.resources && sh.resources['vfxBeam']);
}

export interface VfxSceneInput {
  /** 场景世界尺寸（wu；原画铺满 0..w × 0..h） */
  width: number;
  height: number;
  /** 原画深度（遮挡）；没有深度载荷的场景 null */
  depth: { texture: Texture; config: SceneDepthConfig } | null;
  /** 透视系数（按脚点）；没配 = null（恒 1） */
  perspective: ((x: number, y: number) => number) | null;
}

export interface VfxSyncOptions {
  /** 图层「粒子」（含雷身）：去勾 = 这一帧一颗都不画 */
  particles?: boolean;
  /** 图层「光柱」 */
  beams?: boolean;
  /** 还没播（本地预览 t = 0）时光柱画满：光柱运行态的淡入先当 1（只在画的这一下，画完还原），好调形状 */
  beamsFull?: boolean;
}

/**
 * 原画视图的 GPU 画面：背景原画 + 本地预览那一个模拟实例（游戏的 `VfxRenderer` 画）。
 * 页面每帧：`setCamera` → `sync(模拟, 贴图表, 遮罩表)` → `CanvasHost.render(stage.root)`。
 */
export class VfxStage {
  readonly root = new Container();
  /** 游戏的 `worldContainer`：位置 = 相机平移（CSS 像素），缩放 = 投影缩放（每场景 wu 多少 CSS 像素） */
  readonly world = new Container();
  readonly backgroundLayer = new Container();
  readonly entityLayer = new Container();
  /** 显示变换（背景 / 角色 / 粒子同一组）：工作台没有场景显示参数 = 恒等缺省 */
  readonly displayUniforms = createCharLightUniforms();
  readonly renderer: VfxRenderer;
  private background: Sprite | null = null;
  private scene: VfxSceneInput = { width: 1, height: 1, depth: null, perspective: null };
  private screen = { w: 0, h: 0 };

  constructor() {
    this.root.label = 'vfx-workbench-root';
    this.world.label = 'vfx-workbench-world';
    this.backgroundLayer.label = 'backgroundLayer';
    this.entityLayer.label = 'entityLayer';
    this.entityLayer.sortableChildren = true;
    this.world.addChild(this.backgroundLayer, this.entityLayer);
    this.root.addChild(this.world);
    this.renderer = new VfxRenderer({
      entityLayer: this.entityLayer,
      // 工作台没有照明载荷：不建 lit shader、不走色调融入（同 CanvasVfxHost 的无光口径）
      createLitShader: () => null,
      releaseLitShader: () => {},
      canLight: () => false,
      getToneEnv: () => null,
      displayUniforms: this.displayUniforms,
      getDepth: () => (this.scene.depth ? { tex: this.scene.depth.texture, cfg: this.scene.depth.config } : null),
      getSceneSize: () => ({ w: this.scene.width, h: this.scene.height }),
      perspective: (fx, fy) => this.scene.perspective?.(fx, fy) ?? 1,
      getScreen: () => this.screen,
    });
  }

  /** 相机：场景点 p 画在屏幕 `p · zoom + (ox, oy)`（CSS 像素；与页面 `toCanvas` 同一个变换） */
  setCamera(zoom: number, ox: number, oy: number): void {
    this.world.position.set(ox, oy);
    this.world.scale.set(zoom, zoom);
  }

  /** 画布逻辑尺寸（CSS 像素）：视口剔除与雷的屏幕下限（768 高画面换算）用它，与游戏 `app.screen` 同义 */
  setScreen(w: number, h: number): void {
    this.screen = { w, h };
  }

  /** 换场景：尺寸、原画深度、透视。深度图换了，粒子 / 光柱视图下一帧按新纹理重建（`VfxRenderer.viewStale`） */
  setScene(scene: VfxSceneInput): void {
    this.scene = scene;
  }

  /** 背景原画（平贴，铺满 0..w × 0..h）；`alpha` = 图层「场景压暗」；null = 不画 */
  setBackground(texture: Texture | null, width = 0, height = 0, alpha = 1): void {
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
      this.background.label = 'vfx-workbench-background';
      this.backgroundLayer.addChild(this.background);
    }
    this.background.position.set(0, 0);
    this.background.width = width;
    this.background.height = height;
    this.background.alpha = alpha;
  }

  /** 此刻画着的背景（自检用） */
  get backgroundTexture(): Texture | null {
    return this.background ? this.background.texture : null;
  }

  /**
   * 这一帧：把模拟交给游戏的 `VfxRenderer`（按 `sheets` 画发射器、按 `beamTextures` 给光柱图案），再按游戏规则排实体层。
   * `sim` 为 null = 没有本地预览（画面只剩背景）。
   */
  sync(sim: VfxInstanceSim | null, sheets: ReadonlyMap<string, VfxSpriteSheet>, beamTextures: ReadonlyMap<string, Texture>,
    opts: VfxSyncOptions = {}): void {
    const showParticles = opts.particles !== false;
    const showBeams = opts.beams !== false;
    const saved: number[] = [];
    if (sim && opts.beamsFull) for (const b of sim.beams) { saved.push(b.fade); b.fade = 1; }
    try {
      this.renderer.render(sim ? [sim] : [], showParticles ? sheets : new Map(), undefined, beamTextures);
    } finally {
      if (sim && opts.beamsFull) sim.beams.forEach((b, i) => { b.fade = saved[i]; });
    }
    if (!showBeams) for (const c of this.entityLayer.children) if (isBeamMesh(c)) c.visible = false;
    sortEntityLayer(this.entityLayer);
  }

  /** 这张纹理要被卸载了：先让场景树不再引用它（绑定已销毁的纹理 = 那一帧抛错） */
  forgetTexture(texture: Texture | null): void {
    if (!texture) return;
    if (this.background && this.background.texture === texture) this.setBackground(null);
    if (this.scene.depth && this.scene.depth.texture === texture) {
      this.scene = { ...this.scene, depth: null };
      this.renderer.clear();
    }
  }

  /** 丢掉全部粒子 / 光柱视图（换场景 / 换效果时；下一帧按新模拟重建） */
  clear(): void {
    this.renderer.clear();
  }

  /** 实体层里此刻的网格数（自检用：粒子 / 光柱 / 雷各几张） */
  stats(): { meshes: number; beams: number; visibleBeams: number; drawCalls: number } {
    let beams = 0;
    let visibleBeams = 0;
    for (const c of this.entityLayer.children) if (isBeamMesh(c)) { beams++; if (c.visible) visibleBeams++; }
    return { meshes: this.entityLayer.children.length, beams, visibleBeams, drawCalls: this.renderer.drawCallCount };
  }

  destroy(): void {
    this.renderer.clear();
    this.setBackground(null);
    this.root.destroy({ children: true });
  }
}

// ─────────────────────────────────────────────────────────────── 雷电样式的现画预览（检视器那块画布）

/** 雷预览的"深度"：白图 + 恒等映射（平面近似空间里渲染器不开遮挡，只是给深度槽一张活的纹理） */
const BOLT_PREVIEW_NO_DEPTH: { tex: Texture; cfg: SceneDepthConfig } = {
  tex: Texture.WHITE,
  cfg: { depth_map: '', depth_mapping: { invert: false, scale: 1, offset: 0 }, depth_tolerance: 0 } as unknown as SceneDepthConfig,
};

/** 一格：画布上的 x 范围 + 每场景 wu 多少 CSS 像素 */
export interface BoltPanel {
  x: number;
  w: number;
  scale: number;
}

interface PanelView {
  frame: Container;
  mask: Graphics;
  deco: Graphics;
  world: Container;
  entityLayer: Container;
  renderer: VfxRenderer;
}

/**
 * 雷的动态预览：同一道雷在两格里按两个远近画（左远右近），像两块缩小了的游戏画面。
 * 一格 = 游戏同一套组装（世界容器缩放 = 这一格的投影缩放、实体层、`VfxRenderer`），雷 = 页面给的「套用之后」的效果
 * （bolts + 样式那几层发射器）在平面近似空间里现跑的运行时模拟（`VfxInstanceSim`，落点在格子的地面线上）——
 * 雷形、挑细分级、粗细、按寿命曲线的亮度与颜色全是游戏那一份。两格各用一个遮罩裁边（与原来的 scissor 同义）。
 */
export class BoltPreviewStage {
  readonly root = new Container();
  private readonly divider = new Graphics();
  private readonly panels: PanelView[] = [];
  private readonly space: VfxSpace = createPlanarVfxSpace();
  private effect: VfxEffectDef | null = null;
  private sim: VfxInstanceSim | null = null;
  private simSeed = 1;
  private surface: VfxSurfaceKind = 'ground';
  private simTime = 0;
  private screen = { w: 1, h: 1 };
  private readonly displayUniforms = createCharLightUniforms();

  constructor() {
    this.root.label = 'bolt-preview-root';
    for (let i = 0; i < 2; i++) {
      const frame = new Container();
      const mask = new Graphics();
      const deco = new Graphics();
      const world = new Container();
      const entityLayer = new Container();
      entityLayer.sortableChildren = true;
      world.addChild(entityLayer);
      frame.addChild(deco, world);
      frame.mask = mask;
      this.root.addChild(mask, frame);
      const renderer = new VfxRenderer({
        entityLayer,
        createLitShader: () => null,
        releaseLitShader: () => {},
        canLight: () => false,
        getToneEnv: () => null,
        displayUniforms: this.displayUniforms,
        // ⚠ 不能给 null：`VfxRenderer.ensureView` 在没有深度图时拿发射器贴图顶替深度槽，雷层的占位贴图表没有贴图 ⇒ 当场抛
        //   （游戏里没有深度的场景 / 画布特效放雷同样会抛，见报告）。给一张白图：雷层的深度槽在游戏里没深度时绑的也正是它
        //   （`boltDepth = depthSrc ?? Texture.WHITE.source`），平面近似空间下 `uHasDepth` 恒 0，不遮挡——画法与游戏逐位同一条
        getDepth: () => BOLT_PREVIEW_NO_DEPTH,
        getSceneSize: () => ({ w: 1, h: 1 }),
        perspective: () => 1,
        getScreen: () => this.screen,
      });
      this.panels.push({ frame, mask, deco, world, entityLayer, renderer });
    }
    this.root.addChild(this.divider);
  }

  /** 「套用之后」的效果（服务端拼的 bolts + 样式那几层）；换了就从劈下那一刻重来 */
  setEffect(effect: VfxEffectDef | null): void {
    this.effect = effect;
    this.restart(this.simSeed, this.surface);
  }

  /** 从劈下那一刻重来：`seed` = 实例种子（「再劈一道」换一个），`surface` = 落在地面还是水面 */
  restart(seed: number, surface: VfxSurfaceKind): void {
    this.simSeed = seed >>> 0;
    this.surface = surface;
    this.simTime = 0;
    this.sim = null;
    for (const p of this.panels) p.renderer.clear();
    if (!this.effect) return;
    const anchor = this.space.anchorToWorld({ x: 0, y: 0, h: 0 });
    this.sim = new VfxInstanceSim('bolt-preview', this.effect, anchor, this.simSeed, this.space, 1, { surfaceKind: surface });
  }

  /** 模拟推进到 `t` 秒（往回 = 从头重跑） */
  advanceTo(t: number): void {
    if (!this.sim) return;
    if (t < this.simTime) this.restart(this.simSeed, this.surface);
    const sim = this.sim;
    if (!sim) return;
    while (this.simTime < t - 1e-9) {
      const dt = Math.min(1 / 30, t - this.simTime);
      sim.step(dt, { fields: [], contacts: [], player: null, time: this.simTime, wind: null, windTime: this.simTime });
      this.simTime += dt;
    }
  }

  get time(): number { return this.simTime; }

  /** 此刻还亮着的雷层粒子数（自检用） */
  get live(): number {
    return this.sim ? this.sim.liveCount : 0;
  }

  /**
   * 摆两格并画这一帧：`cssW × cssH` 画布，地面线离底 `groundFromBottom`，落点在格宽 55% 处；
   * 每格左边摆一个 150 wu 高的人形剪影当尺度参考（与原来的预览同一套摆法）。
   */
  layout(cssW: number, cssH: number, panels: readonly BoltPanel[], groundFromBottom = 34): void {
    this.screen = { w: cssW, h: cssH };
    const groundY = cssH - groundFromBottom;
    panels.slice(0, 2).forEach((P, i) => {
      const v = this.panels[i];
      const cx = P.x + P.w * 0.55;
      v.mask.clear().rect(P.x, 0, P.w, cssH).fill(0xffffff);
      const ph = 150 * P.scale;
      const pw = ph * 0.26;
      const px = cx - 120 * P.scale - pw / 2;
      v.deco.clear()
        .rect(P.x, groundY, P.w, cssH - groundY).fill(0x161920)
        .rect(P.x, groundY, P.w, 1).fill(0x30353f)
        .rect(px, groundY - ph, pw, ph).fill(0x3d434e)
        .circle(px + pw / 2, groundY - ph - pw * 0.45, pw * 0.45).fill(0x3d434e);
      v.world.position.set(cx, groundY);
      v.world.scale.set(P.scale, P.scale);
    });
    const split = panels[1] ? panels[1].x : cssW;
    this.divider.clear().rect(Math.round(split), 0, 1, cssH).fill(0x2a2e36);
  }

  /** 把这一刻的模拟交给两格各自的 `VfxRenderer`（雷层用游戏 `VfxSystem` 给雷层的那张占位贴图表：渲染侧不读贴图） */
  sync(): void {
    const sim = this.sim;
    const sheets = new Map<string, VfxSpriteSheet>();
    if (sim) {
      for (const e of sim.emitters) if (e.def.appearance && e.def.appearance.bolt) sheets.set(`${sim.id}/${e.def.id}`, BOLT_STUB_SHEET);
    }
    for (const p of this.panels) {
      p.renderer.render(sim ? [sim] : [], sheets);
      sortEntityLayer(p.entityLayer);
    }
  }

  destroy(): void {
    for (const p of this.panels) p.renderer.clear();
    this.root.destroy({ children: true });
  }
}
