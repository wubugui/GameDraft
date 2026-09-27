/**
 * 角色照明实验室 · 2D 场景视图的 GPU 画面（打进实验室的包，命名空间 `charLabView`；页面 `viewer/app.js` 只调这里）。
 *
 * **不写任何着色器、不重组任何着色式子**：角色受光是游戏同一套对象拼出来的——
 *
 * - 载荷 = 游戏的 `CharacterLightingSystem.load(…, bakeDirOverride)`：烘焙目录是 serve 现场按导出同式变换出来的
 *   虚拟目录（`/api/game_payload/<场景>/<合成参数>`，见 `game_payload.py`），装载 / 平铺 / 哈希门 / skyao 全是游戏代码；
 * - 角色 = 游戏 mesh 路径：`createEntityLitShader` + `LitSpriteQuad`（`CharacterLitSprite.ts` 的 WGSL），挂法照
 *   `SpriteEntity.refreshLitQuad / syncLitQuad / syncLitQuadWorld`（容器在脚点、变换载体精灵 + 兄弟网格、local→场景仿射）；
 * - 遮挡 = 游戏的 `SceneDepthSystem`（`load` → `createFilterForEntity` → 每帧 `updatePerFrame` / `updateEntityDepthOcclusion`，
 *   深度图是「导出深度」会写的那一份的虚拟版）挂在角色容器上（与 `Game.attachPlayerSceneFilter` 同）；
 * - 实体灯组 = 「场景有 lighting 块、零盏灯」：`applyLights(packLights({lights: []}), wuPerQUnit)` + `setShadowBasis(depthConfig R)`，
 *   与 `Game` 进场景那两步同序（probe 查表因此走 `nQ = Rᵀ·n`，与游戏同口径）；显示变换走 `applyDisplay`（实验室的「预览亮度」
 *   就是显示 EV，背景那一半页面在 CPU 上乘同一个倍率）；
 * - 每帧参数 = `CharacterLightingSystem.params` + `syncFrame`（与 `Game.charLitFrameSync` 同一条），切档照 `Game.applyCharMode`。
 *
 * 场景世界单位 = 工作分辨率像素（`load(sceneId, work.w, work.h)` ⇒ worldToWork = 1），1 个 q 单位 = `cal.ppu` 个单位。
 * 背景 / 编辑叠加 / 实验室接触阴影是普通精灵（引擎自带画法，不是着色器）；标注线点由页面画在叠在上面的 2D 画布上。
 *
 * 资源有主：载荷纹理归 `CharacterLightingSystem`（换场景它自己销毁、先把活 shader 退白图）；深度图归 `AssetManager` 缓存；
 * 背景 / 叠加 / 阴影纹理归本类（换时先摘掉精灵的引用再销毁）。
 */
import { Assets, BufferImageSource, Container, Sprite, Texture, type Shader, type TextureSource } from '../../../src/engine2d';
import { AssetManager } from '../../../src/core/AssetManager';
import { CharacterLightingSystem } from '../../../src/core/CharacterLightingSystem';
import { SceneDepthSystem } from '../../../src/core/SceneDepthSystem';
import { legacyLightFactors } from '../../../src/data/lightFactors';
import type { SceneDepthConfig, SceneLightingDef } from '../../../src/data/types';
import { LitSpriteQuad } from '../../../src/rendering/CharacterLitSprite';
import type { DepthOcclusionFilter } from '../../../src/rendering/DepthOcclusionFilter';
import { packLights } from '../../../src/rendering/lighting/lightPacking';

export interface LabSceneInput {
  sceneId: string;
  /** 场景当前第一层背景图名（游戏的哈希门按它取游戏那张图） */
  bgImage: string;
  /** 虚拟烘焙目录（serve 的 `/api/game_payload/<场景>/<合成参数>`），里面还有 `depth.json`（导出深度的虚拟 depthConfig） */
  baseUrl: string;
  work: { w: number; h: number };
  native: { w: number; h: number };
  /** 1 个 q 单位 = 多少场景世界单位（= 工作分辨率的 `cal.ppu`） */
  wuPerQUnit: number;
}

/** 面板上的着色参数（实验室的名字；与游戏 F2 同义的那些原样进 `CharacterLightingSystem.params`） */
export interface LabShading {
  mode: number;
  spp: number;
  step: number;
  msteps: number;
  fold: boolean;
  missMode: boolean;
  nee: boolean;
  beta: number;
  amb: number;
  bulge: number;
  flatten: number;
  eChroma: number;
  showNormals: boolean;
  /** 实验室「预览亮度」（线性倍率，不进游戏）：走显示 EV */
  previewGain: number;
  /** 天穹遮蔽（已导出几何场那份；载荷里没有时拨了也没效果） */
  skyao: boolean;
}

export interface LabFrame {
  /** 世界容器：场景点 p（work px）画在 `p · scale + (x, y)`（CSS 像素） */
  camera: { scale: number; x: number; y: number };
  /** 脚点（场景世界 = work px）；null = 不画角色 */
  foot: { x: number; y: number } | null;
  /** 角色 quad 高（work px；宽按角色图宽高比） */
  heightPx: number;
  occlusion: boolean;
  /** 实验室接触阴影强度（◌ 不进游戏；0 = 不画） */
  contact: number;
  shading: LabShading;
}

/** 游戏的 `AssetManager`（深度图 / 碰撞旁挂的装载与 `SceneDepthSystem.load` 同一条） */
let sharedAssets: AssetManager | null = null;
function assets(): AssetManager {
  return (sharedAssets ??= new AssetManager());
}

/** 法线图：alpha 是鼓包数据，与 `AssetManager.loadTexture` 的 `*.normal.png` 同一条不预乘通道 */
export function loadNormalTexture(url: string): Promise<Texture> {
  return Assets.load<Texture>({ src: url, data: { alphaMode: 'premultiplied-alpha' } });
}

/** 角色图（与游戏动画图集同一条装载路径） */
export function loadColorTexture(url: string): Promise<Texture> {
  return assets().loadTexture(url);
}

/**
 * CPU 算好的 RGBA 图 → 纹理（背景视图 / 编辑叠加）。`straight` = 字节是不预乘的（叠加层 alpha 不是 255），
 * `nearest` = 放大不插值（标定深度那种逐 work 像素的图）。
 */
export function textureFromPixels(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray,
  opts: { straight?: boolean; nearest?: boolean } = {}): Texture {
  const data = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  return new Texture({
    source: new BufferImageSource({
      resource: data, width, height, format: 'rgba8unorm',
      alphaMode: opts.straight ? 'no-premultiply-alpha' : 'premultiplied-alpha',
      scaleMode: opts.nearest ? 'nearest' : 'linear',
    }),
  });
}

/** 实验室接触阴影的剖面：a = 1 − smoothstep(0.25, 1, r)（r = 到中心的归一化距离），与旧 SHADOW_FS 同式 */
export function contactShadowPixels(size = 128): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size - 0.5) * 2;
      const dy = ((y + 0.5) / size - 0.5) * 2;
      const r = Math.hypot(dx, dy);
      const t = Math.max(0, Math.min(1, (r - 0.25) / 0.75));
      const a = 1 - t * t * (3 - 2 * t);
      px[(y * size + x) * 4 + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/** 实验室「预览亮度」→ 场景显示变换（恒等其余项；背景那一半页面在 CPU 上乘同一个倍率） */
export function displayForGain(gain: number): NonNullable<SceneLightingDef['display']> {
  return { ev: Math.log2(Math.max(gain, 1e-6)), tonemap: 'none', saturation: 1, contrast: 1, lift: 0 } as NonNullable<SceneLightingDef['display']>;
}

interface CharView {
  /** = SpriteEntity.container：位置 = 脚点（场景世界） */
  box: Container;
  /** = SpriteEntity.sprite：变换载体（不画） */
  carrier: Sprite;
  quad: LitSpriteQuad;
  shader: Shader;
}

export class CharLabStage {
  /** 渲染根（交给 `CanvasHost.render`） */
  readonly root = new Container();
  /** = 游戏的 worldContainer */
  readonly world = new Container();
  readonly lighting = new CharacterLightingSystem();
  readonly depth = new SceneDepthSystem();
  private readonly bg = new Sprite(Texture.EMPTY);
  private readonly overlay = new Sprite(Texture.EMPTY);
  private readonly shadow: Sprite;
  private readonly shadowTex: Texture;
  private char: CharView | null = null;
  private charTex: { color: Texture; normal: TextureSource | null } | null = null;
  private depthFilter: DepthOcclusionFilter | null = null;
  private scene: LabSceneInput | null = null;
  private loadSeq = 0;
  /** 在途的装载数:>0 时不建角色 shader */
  private loading = 0;
  /** 资源已到位的档（切档照 Game.applyCharMode：资源到了才真切） */
  private activeMode = 3;
  private wantMode = 3;
  private switching: Promise<void> | null = null;
  private lastGain = NaN;
  /** 最近一帧交给着色的输入（离屏出角色贴图时重放） */
  private last: LabFrame | null = null;
  /** 装载 / 切档的最近一条失败原因（页面显示；空 = 没有） */
  lastProblem = '';

  constructor() {
    this.root.label = 'char-lab-root';
    this.world.label = 'char-lab-world';
    this.bg.label = 'char-lab-bg';
    this.overlay.label = 'char-lab-overlay';
    this.shadowTex = textureFromPixels(128, 128, contactShadowPixels(128), { straight: true });
    this.shadow = new Sprite(this.shadowTex);
    this.shadow.label = 'char-lab-contact-shadow';
    this.shadow.anchor.set(0.5, 0.5);
    this.shadow.tint = 0x000000;
    this.shadow.visible = false;
    this.overlay.visible = false;
    this.root.addChild(this.world);
    this.world.addChild(this.bg, this.overlay, this.shadow);
  }

  get loaded(): boolean {
    return this.lighting.active;
  }

  /** 当前真正在画的档（切档资源在途时仍是旧档） */
  get mode(): number {
    return this.activeMode;
  }

  // ─────────────────────────────────────────────────────────── 场景

  /**
   * 进场景（与 Game 同序：深度系统 → 角色照明载荷 → 行走面注入深度系统 → 灯组 / 深度基 → 实体着色 / 遮挡滤镜）。
   * 返回载荷是否可用；不可用的原因在 `lastProblem`。
   */
  async load(input: LabSceneInput, opts: { lightingOnly?: boolean } = {}): Promise<boolean> {
    this.loading++;
    try {
      return await this.loadInner(input, opts);
    } finally {
      this.loading--;
      // 装载途中不许建角色 shader(装载器开头会把活 shader 退成白图——途中建的那个就一直绑着白图);
      // 装完一律按新载荷重建
      this.dropChar();
    }
  }

  private async loadInner(input: LabSceneInput, opts: { lightingOnly?: boolean }): Promise<boolean> {
    const seq = ++this.loadSeq;
    const sameScene = !!this.scene && this.scene.sceneId === input.sceneId && this.depthFilter !== null;
    this.scene = input;
    this.lastProblem = '';
    this.dropChar();
    // 只换了图集的合成参数(nee / amb):深度与场景没变,深度系统不重装(遮挡滤镜照旧)
    if (!(opts.lightingOnly && sameScene)) {
      this.detachDepthFilter();
      let cfg: SceneDepthConfig | null = null;
      try {
        const r = await fetch(`${input.baseUrl}/depth.json`, { cache: 'no-store' });
        if (r.ok) cfg = await r.json() as SceneDepthConfig;
      } catch { /* 下面按没有深度处理 */ }
      if (seq !== this.loadSeq) return false;
      const w2px = input.native.w / input.work.w;
      const h2px = input.native.h / input.work.h;
      if (cfg) {
        await this.depth.load(input.sceneId, cfg, assets(), input.work.w, input.work.h, w2px, h2px);
      } else {
        this.depth.loadDefault();
        this.lastProblem = '没有深度(depth.json 取不到):遮挡关闭';
      }
      if (seq !== this.loadSeq) return false;
    }
    await this.lighting.load(input.sceneId, input.work.w, input.work.h, input.bgImage, undefined, input.baseUrl);
    if (seq !== this.loadSeq) return false;
    this.depth.setGroundDepthField(this.lighting.groundDepthField, this.lighting.groundDepthTexture);
    // lightingLoader：显示变换 / 受光倍率 / 实体灯（零盏）；rebuildEntityShadows：深度基
    this.lighting.applyLightFactors(undefined);
    this.lighting.applyLights(packLights({ lights: [] } as unknown as SceneLightingDef, input.wuPerQUnit), input.wuPerQUnit);
    const sctx = this.depth.getShadowSceneContext();
    this.lighting.setShadowBasis(sctx
      ? [sctx.r00, sctx.r01, sctx.r02, sctx.r10, sctx.r11, sctx.r12, sctx.r20, sctx.r21, sctx.r22]
      : null);
    this.lastGain = NaN;
    this.activeMode = this.lighting.params.mode;
    if (!this.lighting.active) {
      this.lastProblem = this.lastProblem || '角色照明载荷没装上(见控制台)';
      return false;
    }
    this.depthFilter ??= this.depth.createFilterForEntity();
    await this.applyMode(this.wantMode);
    return seq === this.loadSeq && this.lighting.active;
  }

  /** 换角色图（换场景不用重设；载荷重装后本类自己重建 shader） */
  setCharacterTextures(color: Texture, normal: TextureSource | null): void {
    this.charTex = { color, normal };
    this.dropChar();
  }

  /** 背景：铺满 0..work（场景世界）；null = 不画 */
  setBackground(texture: Texture | null): void {
    this.bg.texture = texture ?? Texture.EMPTY;
    this.bg.visible = !!texture;
    this.fitToWork(this.bg);
  }

  /** 编辑叠加层（不预乘 RGBA，与背景同尺寸铺满）；null = 不画 */
  setOverlay(texture: Texture | null, alpha = 0.75): void {
    this.overlay.texture = texture ?? Texture.EMPTY;
    this.overlay.visible = !!texture;
    this.overlay.alpha = alpha;
    this.fitToWork(this.overlay);
  }

  private fitToWork(s: Sprite): void {
    const w = this.scene?.work;
    if (!w || s.texture === Texture.EMPTY) return;
    s.position.set(0, 0);
    s.width = w.w;
    s.height = w.h;
  }

  // ─────────────────────────────────────────────────────────── 切档（照 Game.applyCharMode）

  /** 要这一档（0 = RT，1/2/3 = L1/SH/八面体）；资源异步到位后才真正切过去 */
  requestMode(mode: number): Promise<void> {
    this.wantMode = mode;
    if (!this.lighting.active || mode === this.activeMode) return this.switching ?? Promise.resolve();
    return this.applyMode(mode);
  }

  private async applyMode(next: number): Promise<void> {
    while (this.switching) await this.switching;
    if (!this.lighting.active) return;
    if (next === this.activeMode && (next >= 1 || this.lighting.hasVolumes)) return;
    const cl = this.lighting;
    const task = (async () => {
      if (next < 1) {
        if (!await cl.ensureVolumes()) { this.lastProblem = 'RT 体素卷没拉到,保持原档'; return; }
      } else {
        cl.releaseVolumes();
        if (!await cl.ensureProbeAtlas(next)) { this.lastProblem = 'probe 图集没拉到,保持原档'; return; }
      }
      cl.params.mode = next;
      this.activeMode = next;
      // mesh 路径：图集 / 体素卷热替换已由系统就地重绑到活 shader；遮挡滤镜不绑它们，不用重挂
      cl.disposeStaleVolumeTextures();
      cl.disposeStaleProbeTextures();
    })();
    this.switching = task;
    try { await task; } finally { this.switching = null; }
    if (this.wantMode !== this.activeMode && this.lighting.active) await this.applyMode(this.wantMode);
  }

  // ─────────────────────────────────────────────────────────── 每帧

  /** 这一帧的画面状态（页面每次重画前调） */
  sync(frame: LabFrame): void {
    this.last = frame;
    const cam = frame.camera;
    this.world.position.set(cam.x, cam.y);
    this.world.scale.set(cam.scale, cam.scale);
    this.applyShading(frame.shading);
    const foot = frame.foot;
    const cv = foot && this.lighting.active ? this.ensureChar() : null;
    if (!cv || !foot) {
      if (this.char) this.char.box.visible = false;
      this.shadow.visible = false;
      return;
    }
    this.placeChar(cv, foot, frame.heightPx, 1);
    cv.box.visible = true;
    // 遮挡：与 Game 同一条（updatePerFrame + updateEntityDepthOcclusion，脚点 = 接地点）
    const f = frame.occlusion ? this.depthFilter : null;
    cv.box.filters = f ? [f] : [];
    if (f) {
      this.depth.updatePerFrame(cam.x, cam.y, cam.scale);
      this.depth.updateEntityDepthOcclusion(f, foot.x, foot.y, 0);
    }
    // 实验室接触阴影（◌ 不进游戏）：宽 = 1.15 × 角色宽、高 = 0.38 × 角色宽，画在角色下面
    const wPx = frame.heightPx * this.charAspect();
    this.shadow.visible = frame.contact > 0;
    this.shadow.position.set(foot.x, foot.y);
    this.shadow.width = wPx * 1.15;
    this.shadow.height = wPx * 0.38;
    this.shadow.alpha = Math.max(0, Math.min(1, frame.contact));
  }

  private applyShading(p: LabShading): void {
    const cl = this.lighting;
    if (!(p.previewGain === this.lastGain)) {
      cl.applyDisplay(displayForGain(p.previewGain));
      this.lastGain = p.previewGain;
    }
    if (p.mode !== this.wantMode) void this.requestMode(p.mode);
    Object.assign(cl.params, {
      mode: this.activeMode, spp: p.spp, step: p.step, msteps: p.msteps,
      fold: p.fold, missMode: p.missMode, nee: p.nee,
      beta: p.beta, ambStrength: p.amb, giStrength: 1,
      bulge: p.bulge, flatten: p.flatten, showNormals: p.showNormals,
      // 场景没配受光倍率时游戏取的旧式等价（间接 = giStrength、直接 = 1、总 = 2^β/π）——实验室面板调的正是它
      ...legacyLightFactors(p.beta, 1),
    });
    cl.eChroma = p.eChroma;
    cl.setSkyaoBlend(p.skyao ? 1 : 0);
    cl.syncFrame(this.world.position.x, this.world.position.y, this.world.scale.x);
  }

  private charAspect(): number {
    const t = this.charTex?.color;
    return t && t.height > 0 ? t.width / t.height : 0.5;
  }

  private ensureChar(): CharView | null {
    if (this.char) return this.char;
    if (!this.charTex || this.loading > 0) return null;
    const view = this.buildChar();
    if (!view) return null;
    this.world.addChild(view.box);
    this.char = view;
    return view;
  }

  /** 照 SpriteEntity.refreshLitQuad：容器 + 变换载体精灵（不画）+ 兄弟网格（着色）。 */
  private buildChar(): CharView | null {
    const tex = this.charTex;
    if (!tex) return null;
    const shader = this.lighting.createEntityLitShader(tex.color.source, tex.normal);
    if (!shader) return null;
    const box = new Container();
    box.label = 'char-lab-character';
    const carrier = new Sprite(tex.color);
    carrier.anchor.set(0.5, 1);
    carrier.renderable = false;
    box.addChild(carrier);
    const quad = new LitSpriteQuad(shader);
    box.addChild(quad.mesh);
    return { box, carrier, quad, shader };
  }

  /**
   * 照 SpriteEntity.syncLitQuad + syncLitQuadWorld：换帧几何（整张图一帧，锚点底中）+ 精灵变换抄给网格 +
   * local→场景仿射（容器 = 脚点，外层恒等）。`display` = 容器的显示缩放（离屏出贴图时把角色放大到目标大小；
   * 着色只读场景仿射，不受它影响）。
   */
  private placeChar(cv: CharView, foot: { x: number; y: number }, heightPx: number, display: number,
    displayAt: { x: number; y: number } = foot): void {
    const color = this.charTex!.color;
    const frameW = color.width;
    const frameH = color.height;
    const s = heightPx / Math.max(frameH, 1e-6);
    cv.box.position.set(displayAt.x, displayAt.y);
    cv.box.scale.set(display, display);
    cv.carrier.scale.set(s, s);
    cv.quad.sync(color, frameW, frameH, cv.carrier.anchor.x, cv.carrier.anchor.y);
    const m = cv.quad.mesh;
    m.position.set(cv.carrier.x, cv.carrier.y);
    m.scale.set(cv.carrier.scale.x, cv.carrier.scale.y);
    m.rotation = cv.carrier.rotation;
    cv.quad.setWorldTransform(foot.x, foot.y, 1, 1, cv.carrier.x, cv.carrier.y,
      cv.carrier.scale.x, cv.carrier.scale.y, cv.carrier.rotation);
  }

  // ─────────────────────────────────────────────────────────── 3D 视图用的角色贴图

  private offChar: CharView | null = null;
  private readonly offRoot = new Container();

  /**
   * 把角色按**当前这一帧**的着色画进一张离屏图（角色 quad 占满 `width × height`，底中 = 脚点）：
   * 直立 quad 的受光只取决于它在伪世界里的位置与法线，与看它的相机无关——所以 3D 视图把这张图贴到同一个
   * 直立 quad 上，看到的就是游戏同一份着色。不带遮挡（遮挡是屏幕空间的事）。没有载荷 / 角色 = null。
   */
  characterRoot(width: number, height: number): Container | null {
    const f = this.last;
    if (!f || !f.foot || !this.lighting.active || !this.charTex || this.loading > 0) return null;
    if (!this.offChar) {
      this.offChar = this.buildChar();
      if (!this.offChar) return null;
      this.offRoot.addChild(this.offChar.box);
    }
    this.applyShading(f.shading);
    this.placeChar(this.offChar, f.foot, f.heightPx, height / Math.max(f.heightPx, 1e-6), { x: width / 2, y: height });
    return this.offRoot;
  }

  // ─────────────────────────────────────────────────────────── 拆卸

  private dropChar(): void {
    for (const v of [this.char, this.offChar]) {
      if (!v) continue;
      v.box.filters = [];
      v.quad.destroy();
      v.box.destroy({ children: true });
      this.lighting.releaseEntityLitShader(v.shader);
    }
    this.char = null;
    this.offChar = null;
  }

  private detachDepthFilter(): void {
    if (this.depthFilter) {
      this.depth.removeFilter(this.depthFilter);
      this.depthFilter.destroy();
      this.depthFilter = null;
    }
  }

  destroy(): void {
    this.dropChar();
    this.detachDepthFilter();
    this.depth.destroy();
    this.lighting.destroy();
    this.root.destroy({ children: true });
    this.shadowTex.destroy(true);
  }
}
