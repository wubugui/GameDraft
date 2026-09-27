/**
 * 粒子工作台逐像素对照 · 游戏侧参考页：拿工作台这一帧交出来的输入（效果定义、实例种子 / 锚点 / 选项、空间的几何数据、
 * 风、步长序列、相机、画布尺寸 / 分辨率、背景、场景深度），**照游戏组装层**重跑一遍模拟、画一遍，回读画布给对照脚本比：
 *
 * - 模拟：`new VfxInstanceSim(...)`（= `VfxSystem.ensureSim` 那一句），空间 = `createFieldVfxSpace` / `createPlanarVfxSpace`，
 *   风 = `SceneWindState`，每步 `wind.advance(dt)` → `sim.step(dt, ctx)`（= `Game` → `VfxSystem.update` 的先后）；
 * - 渲染器：`createRenderer`，与游戏 `Renderer.init` 同参（不抗锯齿、分辨率 = 设备像素比），清屏色同工作台；
 * - 场景树：舞台 → 世界容器（位置 = 相机平移、缩放 = 投影缩放）→ 背景层 / 阴影层 / 实体层（`sortableChildren`）= `Renderer`；
 * - 贴图：`loadVfxSpriteSheet`（= `VfxSystem.loadSheet`）+ 与 `AssetManager` 同式的装载（`loadJson` = fetch + json，`loadTexture` =
 *   `Assets.load(resolveAssetPath(…))`；不直接 new AssetManager：它牵着 howler，vite 预构建在这一页里导出对不上）、光柱遮罩同一条，
 *   场景深度 = `loadTexture(sceneRuntimeAssetUrl(场景, depth_map))`（= `SceneDepthSystem.load`）；
 * - 粒子：`Game.start` 那个 `new VfxRenderer({...})`（没有照明载荷的口径：不建 lit、没有色调融入）→
 *   `render(sims, sheets, hosts, beamTextures, instanceAlphas)`（= `VfxSystem.update` 末尾）→ `Renderer.sortEntityLayer` → 渲染。
 *
 * 不经工作台 RHI 接入层（`tools/workbench_rhi`），也不经工作台胶水（`gpu/vfxView.ts`）：这一侧是独立照游戏写的参考。
 */
import { Assets, Container, Sprite, createRenderer, type Texture } from '@src/engine2d';
import { resolveAssetPath } from '@src/core/assetPath';
import { sceneRuntimeAssetUrl } from '@src/core/projectPaths';
import type { SceneDepthConfig, VfxEffectDef, VfxSurfaceKind } from '@src/data/types';
import { resolveBurnable, type ResolvedBurnable } from '@src/data/burnables';
import { createCharLightUniforms } from '@src/rendering/CharacterLitSprite';
import { entitySortZ, type EntitySortBand } from '@src/rendering/entitySortRule';
import { VfxRenderer, type VfxSpriteSheet } from '@src/rendering/vfx/VfxRenderer';
import { VfxInstanceSim } from '@src/systems/vfx/vfxSim';
import { createFieldVfxSpace, createPlanarVfxSpace, type VfxSpace } from '@src/systems/vfx/vfxSpace';
import { loadVfxSpriteSheet } from '@src/systems/vfx/vfxSpriteSheet';
import { buildDepthShellField } from '@src/utils/depthShellField';
import { createPerspectiveScaleResolver } from '@src/utils/perspectiveScale';
import { viewDirWorld, type SceneSpaceGeometry, type Vec3 } from '@src/utils/sceneSpace';
import { SceneWindState } from '@src/utils/sceneWind';

interface Field { w: number; h: number; data: string }

interface RefInput {
  css: [number, number];
  dpr: number;
  background: number;
  cam: { zoom: number; ox: number; oy: number };
  sceneId: string;
  world: { w: number; h: number };
  bg: { url: string; alpha: number } | null;
  depthConfig: SceneDepthConfig | null;
  perspective: Record<string, unknown> | null;
  space:
    | { kind: 'field'; geo: Omit<SceneSpaceGeometry, 'ground'> & { ground: Field }; shell: (Field & { cal: { ppu: number; cx: number; cy: number }; rows: number[] }) | null }
    | { kind: 'planar'; k: number };
  sim: {
    id: string; effect: VfxEffectDef; anchorWorld: Vec3; seed: number; countScale: number;
    area: [number, number][] | null; confine: Record<string, unknown> | null; surfaceKind: VfxSurfaceKind | undefined;
    burnDocs: Record<string, unknown> | null;
  };
  wind: Record<string, unknown> | null;
  steps: number[];
}

function f32(b64: string): Float32Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

function toB64(u8: Uint8ClampedArray | Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 模拟状态的摘要（与对照脚本给工作台页算的同一个式子）：两边模拟不同步时先报这个，像素比较才有意义 */
function simDigest(sim: VfxInstanceSim): { live: number; sum: number } {
  let sum = 0;
  for (const e of sim.emitters) {
    const p = e.p;
    for (let i = 0; i < p.cap; i++) if (p.alive[i]) sum += p.x[i] * 1.3 + p.y[i] * 1.7 + p.z[i] * 1.9 + p.age[i];
  }
  return { live: sim.liveCount, sum };
}

function buildSpace(inp: RefInput): VfxSpace {
  const ps = createPerspectiveScaleResolver(inp.perspective as never);
  const persp = ps ? (x: number, y: number) => ps.scaleAt(x, y) : null;
  if (inp.space.kind === 'planar') return createPlanarVfxSpace(inp.space.k, persp);
  const g = inp.space.geo;
  const geo: SceneSpaceGeometry = { ...g, ground: { w: g.ground.w, h: g.ground.h, data: f32(g.ground.data) } };
  const sh = inp.space.shell;
  const shell = sh ? buildDepthShellField(f32(sh.data), sh.w, sh.h, sh.cal, sh.rows) : null;
  return createFieldVfxSpace({ geo, shell, viewDir: viewDirWorld(geo), perspective: persp });
}

async function renderRef(inp: RefInput): Promise<{ w: number; h: number; pixels: string; digest: { live: number; sum: number } }> {
  // ---- 模拟（VfxSystem.ensureSim + Game → VfxSystem.update 的步进）
  const space = buildSpace(inp);
  let burnTemplates: Map<string, ResolvedBurnable> | null = null;
  if (inp.sim.burnDocs) {
    burnTemplates = new Map();
    for (const [id, doc] of Object.entries(inp.sim.burnDocs)) { const t = resolveBurnable(doc, id); if (t) burnTemplates.set(id, t); }
  }
  const sim = new VfxInstanceSim(inp.sim.id, inp.sim.effect, inp.sim.anchorWorld, inp.sim.seed, space, inp.sim.countScale,
    { area: inp.sim.area, confine: inp.sim.confine as never, burnTemplates, surfaceKind: inp.sim.surfaceKind });
  const wind = new SceneWindState();
  wind.reset(inp.wind as never);
  let time = 0;
  for (const dt of inp.steps) {
    wind.advance(dt);
    sim.step(dt, { fields: [], contacts: [], player: null, time, wind: wind.params, windTime: wind.time, fires: [] });
    time += dt;
  }
  const digest = simDigest(sim);

  // ---- 渲染器（Renderer.init）
  const canvas = document.createElement('canvas');
  canvas.style.width = `${inp.css[0]}px`;
  canvas.style.height = `${inp.css[1]}px`;
  document.body.appendChild(canvas);
  const renderer = await createRenderer({
    canvas, width: inp.css[0], height: inp.css[1], resolution: inp.dpr, antialias: false, background: inp.background,
  });
  try {
    // ---- 贴图（AssetManager / VfxSystem.loadSheet / SceneDepthSystem.load）
    // = AssetManager.loadJson / loadTexture（非法线图那一支）
    const am = {
      async loadJson<T = unknown>(path: string): Promise<T> {
        const r = await fetch(resolveAssetPath(path));
        if (!r.ok) throw new Error(`fetch ${r.status} for ${path}`);
        return (await r.json()) as T;
      },
      loadTexture: (path: string) => Assets.load<Texture>(resolveAssetPath(path)),
    };
    const sheets = new Map<string, VfxSpriteSheet>();
    for (const em of inp.sim.effect.emitters) {
      const s = await loadVfxSpriteSheet(em.appearance, am).catch(() => null);
      if (s) sheets.set(`${sim.id}/${em.id}`, s);
    }
    const beamTextures = new Map<string, Texture>();
    for (const b of inp.sim.effect.beams ?? []) {
      if (!b.cookie?.image) continue;
      const t = await am.loadTexture(b.cookie.image).catch(() => null);
      if (t) beamTextures.set(`${sim.id}/${b.id}`, t);
    }
    const depthTex = inp.depthConfig ? await am.loadTexture(sceneRuntimeAssetUrl(inp.sceneId, inp.depthConfig.depth_map)) : null;
    const bgTex = inp.bg ? await Assets.load<Texture>({ src: inp.bg.url, parser: 'loadTextures' }) : null;

    // ---- 场景树（Renderer）
    const stage = new Container();
    const worldContainer = new Container();
    const backgroundLayer = new Container();
    const shadowLayer = new Container();
    const entityLayer = new Container();
    worldContainer.addChild(backgroundLayer);
    worldContainer.addChild(shadowLayer);
    entityLayer.sortableChildren = true;
    worldContainer.addChild(entityLayer);
    stage.addChild(worldContainer);
    worldContainer.position.set(inp.cam.ox, inp.cam.oy);
    worldContainer.scale.set(inp.cam.zoom, inp.cam.zoom);
    if (bgTex && inp.bg) {
      const bg = new Sprite(bgTex);
      bg.width = inp.world.w;
      bg.height = inp.world.h;
      bg.alpha = inp.bg.alpha;
      backgroundLayer.addChild(bg);
    }

    // ---- 粒子（Game.start 的 new VfxRenderer + VfxSystem.update 末尾 + Renderer.sortEntityLayer）
    const ps = createPerspectiveScaleResolver(inp.perspective as never);
    const depth = depthTex && inp.depthConfig ? { tex: depthTex, cfg: inp.depthConfig } : null;
    const vfx = new VfxRenderer({
      entityLayer,
      createLitShader: () => null,
      releaseLitShader: () => {},
      canLight: () => false,
      displayUniforms: createCharLightUniforms(),
      getToneEnv: () => null,
      getDepth: () => depth,
      getSceneSize: () => ({ w: inp.world.w, h: inp.world.h }),
      perspective: (fx, fy) => ps?.scaleAt(fx, fy) ?? 1,
      getScreen: () => ({ w: renderer.screen.width, h: renderer.screen.height }),
    });
    vfx.render([sim], sheets, new Map(), beamTextures, new Map());
    for (const child of entityLayer.children) {
      const ext = child as Container & { entitySortBand?: EntitySortBand; entitySortFootY?: number };
      child.zIndex = entitySortZ({ band: ext.entitySortBand, sortFootY: ext.entitySortFootY, y: child.y });
    }
    entityLayer.sortChildren();

    // 画 + 回读在同一个任务里（WebGPU 画布呈现之后读不回来）
    renderer.render(stage);
    const rc = document.createElement('canvas');
    rc.width = canvas.width;
    rc.height = canvas.height;
    const ctx = rc.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, rc.width, rc.height).data;
    vfx.clear();
    stage.destroy({ children: true });
    return { w: rc.width, h: rc.height, pixels: toB64(data), digest };
  } finally {
    renderer.destroy();
    canvas.remove();
  }
}

(window as unknown as { __renderRef: typeof renderRef; __refReady: boolean }).__renderRef = renderRef;
(window as unknown as { __refReady: boolean }).__refReady = true;
