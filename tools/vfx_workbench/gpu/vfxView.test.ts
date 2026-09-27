/**
 * 粒子工作台画面 == 游戏画面（无 GPU 那一半）：同一个运行时模拟（同一份效果 + 同一个种子 + 同一串步长 + 同一个空间），
 *
 * - **工作台**：`VfxStage`（页面原画视图 `viewer/view2d.js` 调的就是它）；
 * - **游戏**：照游戏组装层现拼——`Renderer` 的层（舞台 → 世界容器 → 背景层 / 阴影层 / 实体层 `sortableChildren`）、
 *   `Game.start` 里 `new VfxRenderer({...})` 的那组依赖（这里是没有照明载荷的口径：不建 lit、没有色调融入，同 `CanvasVfxHost`；
 *   深度 = 场景深度图 + `depth_mapping`、透视、`getScreen` = 画布逻辑尺寸）、`VfxSystem.update` 末尾那一句
 *   `renderer.render(sims, sheets, hosts, beamTextures, instanceAlphas)`、`Renderer.sortEntityLayer` → 渲染。
 *
 * 两边各开一台空后端设备（`NullRhiDevice`），`traceRhi` 把决定像素的全部 GPU 输入（pass、视口、管线与 WGSL、uniform 字节、
 * 纹理内容、顶点 / 索引字节、draw）记成规范化的串，**必须逐行相同**——在同一块确定性 GPU 上就逐字节同一张图。
 * 三组效果：普通粒子（贴图 billboard 受光 / 无光 + 薄片纸钱，被原画深度挡）、光柱（3D 光柱 + 2D 光带 + 光柱里的尘埃）、
 * 落雷（天上那道 + 落地电弧 + 落点的火星 / 碎石 / 烟）。真 GPU 上的逐像素对照另有 `tools/vfx_workbench/tests/parity/run.mjs`（Chrome）。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { BufferImageSource, Container, Sprite, Texture, WebGPURenderer } from '../../../src/engine2d';
import type { SceneDepthConfig, VfxEffectDef } from '../../../src/data/types';
import { createCharLightUniforms } from '../../../src/rendering/CharacterLitSprite';
import { entitySortZ, type EntitySortBand } from '../../../src/rendering/entitySortRule';
import { VfxRenderer, type VfxSpriteSheet } from '../../../src/rendering/vfx/VfxRenderer';
import { VfxInstanceSim } from '../../../src/systems/vfx/vfxSim';
import { createFieldVfxSpace, createPlanarVfxSpace, type VfxSpace } from '../../../src/systems/vfx/vfxSpace';
import { BOLT_STUB_SHEET } from '../../../src/systems/vfx/vfxSpriteSheet';
import { viewDirWorld, type SceneSpaceGeometry } from '../../../src/utils/sceneSpace';
import { createPerspectiveScaleResolver } from '../../../src/utils/perspectiveScale';
import { traceRhi } from '../../workbench_rhi/rhiTrace';
import { BoltPreviewStage, VfxStage } from './vfxView';
import paperMoney from '../../../public/assets/data/vfx/paper_money.json';
import dustMotes from '../../../public/assets/data/vfx/dust_motes.json';
import boltFx from '../../../public/assets/data/vfx/lightning_bolt_01.json';

const VIEW_W = 320;
const VIEW_H = 200;
const CLEAR = 0x111318;
const SCENE_W = 640;
const SCENE_H = 360;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s & 0xffffff) / 0x1000000;
  };
}

/** 预乘的带 alpha 贴图（软边圆 + 竖条纹）：发射器贴图 / 图集 / 光柱遮罩 / 背景都用它（两边各建各的、字节相同） */
function texture(w: number, h: number, seed: number): Texture {
  const r = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5, v = (y + 0.5) / h - 0.5;
      const a = Math.max(0, Math.min(1, (1 - Math.hypot(u / 0.5, v / 0.5)) * 4)) * (x % 5 === 2 ? 0.6 : 1);
      const i = (y * w + x) * 4;
      data[i] = Math.round(Math.min(1, 0.4 + 0.5 * x / w + 0.1 * r()) * a * 255);
      data[i + 1] = Math.round(Math.min(1, 0.35 + 0.5 * y / h) * a * 255);
      data[i + 2] = Math.round(0.3 * a * 255);
      data[i + 3] = Math.round(a * 255);
    }
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: w, height: h, alphaMode: 'premultiplied-alpha', scaleMode: 'linear' }) });
}

/** 场景深度图（RG16：与游戏 `raw_depth_rg.png` 同编码）：下半画面近、中间一根"柱子"更近（挡住后面的粒子 / 光柱） */
function depthTexture(): Texture {
  const w = 64, h = 36;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let t = 0.85 - 0.6 * (y / h);
      if (x >= 28 && x < 34) t = 0.08;
      const q = Math.round(t * 65535);
      const i = (y * w + x) * 4;
      data[i] = q >> 8; data[i + 1] = q & 255; data[i + 2] = 0; data[i + 3] = 255;
    }
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: w, height: h, scaleMode: 'linear' }) });
}

const DEPTH_CFG = {
  depth_map: 'raw_depth_rg.png', depth_mapping: { invert: false, scale: 3, offset: -1.2 }, depth_tolerance: 0.05,
} as unknown as SceneDepthConfig;

/** 合成的真 3D 场（行走面 + 基）：绕 x 转 45° 俯视，地面深度随画面下移变近 */
function fieldSpace(): VfxSpace {
  const W = 64, H = 36;
  const ground = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) ground[y * W + x] = 2.0 - 0.9 * (y / H) + 0.05 * Math.sin(x * 0.3);
  const s = Math.SQRT1_2;
  const geo: SceneSpaceGeometry = {
    work: { w: W, h: H }, cal: { ppu: 20, cx: W / 2, cy: H / 2 }, sceneWorld: { w: SCENE_W, h: SCENE_H },
    basisRows: [1, 0, 0, 0, s, -s, 0, s, s], wuPerQUnit: 180, ground: { data: ground, w: W, h: H },
  };
  const persp = createPerspectiveScaleResolver({ near: { x: 320, y: 340, scale: 1 }, far: { x: 320, y: 60, scale: 0.6 } } as never);
  return createFieldVfxSpace({ geo, shell: null, viewDir: viewDirWorld(geo), perspective: persp ? (x, y) => persp.scaleAt(x, y) : null });
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Case {
  name: string;
  effect: VfxEffectDef;
  anchor: { x: number; y: number; h: number };
  seed: number;
  steps: number;
  camera: { zoom: number; ox: number; oy: number };
  resolution: number;
  background: boolean;
  depth: boolean;
}

/** 普通粒子：纸钱薄片（图集 4 帧、受光外观）+ 受光 billboard + 无光叠加 billboard */
function particlesEffect(): VfxEffectDef {
  const paper = clone(paperMoney.emitters[0]) as Record<string, unknown> & { spawn: Record<string, unknown>; plate: Record<string, unknown> };
  paper.spawn = { ...paper.spawn, max: 60, burst: 40, shape: { kind: 'area', radius: 120 } };
  delete paper.plate.burnable;
  const dust = clone(dustMotes.emitters[0]) as Record<string, unknown> & { spawn: Record<string, unknown>; appearance: Record<string, unknown> };
  dust.id = 'motes';
  dust.spawn = { max: 50, rate: 20, burst: 30, shape: { kind: 'sphere', radius: 90 }, speed: [2, 10] };
  delete dust.appearance.beamLit;
  const litMote = clone(dust) as Record<string, unknown> & { appearance: Record<string, unknown> };
  litMote.id = 'lit_motes';
  litMote.appearance = { ...litMote.appearance, lit: true, blend: 'normal', lightGain: 1.5, sizeWu: 10 };
  return { id: 'fx_particles', emitters: [paper, dust, litMote] } as unknown as VfxEffectDef;
}

/** 光柱：dust_motes 原样（3D 光柱 + 柱里的尘埃）+ 一条 2D 光带（叠加、背景档） */
function beamEffect(): VfxEffectDef {
  const fx = clone(dustMotes) as unknown as VfxEffectDef & { beams: Record<string, unknown>[] };
  fx.beams.push({
    id: 'band', mode: '2d', shape2d: { from: [-60, -150], to: [20, 0], width: [30, 110] }, color: [0.9, 0.95, 1],
    intensity: 0.6, blend: 'add', sort: 'background', cookie: { image: '/cookie.png', strength: 0.5 },
  });
  return fx;
}

const CASES: Case[] = [
  { name: '普通粒子', effect: particlesEffect(), anchor: { x: 300, y: 250, h: 0 }, seed: 7, steps: 90,
    camera: { zoom: 0.9, ox: -110.5, oy: -80.25 }, resolution: 1, background: true, depth: true },
  { name: '光柱', effect: beamEffect(), anchor: { x: 330, y: 280, h: 0 }, seed: 11, steps: 120,
    camera: { zoom: 0.7, ox: -60, oy: -40.5 }, resolution: 1.25, background: true, depth: true },
  { name: '落雷', effect: clone(boltFx) as unknown as VfxEffectDef, anchor: { x: 320, y: 240, h: 0 }, seed: 23, steps: 6,
    camera: { zoom: 0.55, ox: -20, oy: 20 }, resolution: 1, background: true, depth: true },
];

/** 一份用例的全部纹理（两边各建各的、内容逐字节相同）：发射器贴图表按外观建、光柱遮罩、背景、深度图 */
function assetsFor(c: Case, instanceId: string) {
  const sheets = new Map<string, VfxSpriteSheet>();
  c.effect.emitters.forEach((em, i) => {
    if (em.appearance.bolt) { sheets.set(`${instanceId}/${em.id}`, BOLT_STUB_SHEET); return; }
    const anim = !!em.appearance.animFile;
    const tex = anim ? texture(32, 8, 100 + i) : texture(12, 12, 200 + i);
    const frames = anim ? [0, 1, 2, 3].map((k) => ({ u0: k / 4, v0: 0, u1: (k + 1) / 4, v1: 1 })) : [{ u0: 0, v0: 0, u1: 1, v1: 1 }];
    sheets.set(`${instanceId}/${em.id}`, { texture: tex, frames, aspect: 1, frameRate: anim ? 1 : 0 });
  });
  const beamTextures = new Map<string, Texture>();
  for (const b of c.effect.beams ?? []) if (b.cookie?.image) beamTextures.set(`${instanceId}/${b.id}`, texture(16, 16, 300));
  return { sheets, beamTextures, bg: c.background ? texture(40, 24, 5) : null, depth: c.depth ? depthTexture() : null };
}

/** 同一个模拟（两边各跑各的：同效果、同种子、同空间、同步长 ⇒ 状态逐位相同） */
function simFor(c: Case, space: VfxSpace): VfxInstanceSim {
  const sim = new VfxInstanceSim('inst', clone(c.effect), space.anchorToWorld(c.anchor), c.seed, space, 1, {});
  let t = 0;
  for (let i = 0; i < c.steps; i++) {
    sim.step(1 / 60, { fields: [], contacts: [], player: null, time: t, wind: null, windTime: t, fires: [] });
    t += 1 / 60;
  }
  return sim;
}

function setup(resolution: number) {
  const rhi = new NullRhiDevice({ swapchainSize: [Math.round(VIEW_W * resolution), Math.round(VIEW_H * resolution)] });
  const trace = traceRhi(rhi);
  const canvas = { width: Math.round(VIEW_W * resolution), height: Math.round(VIEW_H * resolution), style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: VIEW_W, height: VIEW_H, resolution, background: CLEAR });
  return { renderer, trace };
}

/** 工作台：VfxStage（页面 view2d.js 交给它的就是这些） */
function drawWorkbench(c: Case): string[] {
  const { renderer, trace } = setup(c.resolution);
  const space = fieldSpace();
  const sim = simFor(c, space);
  const a = assetsFor(c, sim.id);
  const stage = new VfxStage();
  stage.setCamera(c.camera.zoom, c.camera.ox, c.camera.oy);
  stage.setScreen(VIEW_W, VIEW_H);
  const persp = createPerspectiveScaleResolver({ near: { x: 320, y: 340, scale: 1 }, far: { x: 320, y: 60, scale: 0.6 } } as never);
  stage.setScene({ width: SCENE_W, height: SCENE_H, depth: a.depth ? { texture: a.depth, config: DEPTH_CFG } : null,
    perspective: persp ? (x, y) => persp.scaleAt(x, y) : null });
  stage.setBackground(a.bg, SCENE_W, SCENE_H, 1);
  stage.sync(sim, a.sheets, a.beamTextures, { particles: true, beams: true, beamsFull: false });
  renderer.render(stage.root);
  return trace.lines;
}

/** 游戏：照 Renderer / Game / VfxSystem 的组装现拼 */
function drawLikeTheGame(c: Case): string[] {
  const { renderer, trace } = setup(c.resolution);
  const space = fieldSpace();
  const sim = simFor(c, space);
  const a = assetsFor(c, sim.id);
  // Renderer 的层
  const appStage = new Container();
  const worldContainer = new Container();
  const backgroundLayer = new Container();
  const shadowLayer = new Container();
  const entityLayer = new Container();
  worldContainer.addChild(backgroundLayer);
  worldContainer.addChild(shadowLayer);
  entityLayer.sortableChildren = true;
  worldContainer.addChild(entityLayer);
  appStage.addChild(worldContainer);
  worldContainer.position.set(c.camera.ox, c.camera.oy);
  worldContainer.scale.set(c.camera.zoom, c.camera.zoom);
  if (a.bg) {
    const bg = new Sprite(a.bg);
    bg.width = SCENE_W;
    bg.height = SCENE_H;
    backgroundLayer.addChild(bg);
  }
  // Game.start 里建的那一个（没有照明载荷的口径）
  const persp = createPerspectiveScaleResolver({ near: { x: 320, y: 340, scale: 1 }, far: { x: 320, y: 60, scale: 0.6 } } as never);
  const depth = a.depth ? { tex: a.depth, cfg: DEPTH_CFG } : null;
  const vfxRenderer = new VfxRenderer({
    entityLayer,
    createLitShader: () => null,
    releaseLitShader: () => {},
    canLight: () => false,
    displayUniforms: createCharLightUniforms(),
    getToneEnv: () => null,
    getDepth: () => depth,
    getSceneSize: () => ({ w: SCENE_W, h: SCENE_H }),
    perspective: (fx, fy) => persp?.scaleAt(fx, fy) ?? 1,
    getScreen: () => ({ w: renderer.screen.width, h: renderer.screen.height }),
  });
  // VfxSystem.update 末尾
  vfxRenderer.render([sim], a.sheets, new Map(), a.beamTextures, new Map());
  // Renderer.sortEntityLayer
  for (const child of entityLayer.children) {
    const ext = child as Container & { entitySortBand?: EntitySortBand; entitySortFootY?: number };
    child.zIndex = entitySortZ({ band: ext.entitySortBand, sortFootY: ext.entitySortFootY, y: child.y }, 0, 0);
  }
  entityLayer.sortChildren();
  renderer.render(appStage);
  return trace.lines;
}

const draws = (lines: string[]) => lines.filter((l) => /^ {2}draw/.test(l)).length;

describe('粒子工作台原画视图 == 游戏画面（空后端，逐条 GPU 命令与字节）', () => {
  for (const c of CASES) {
    it(`${c.name}：同一个模拟经工作台 VfxStage 与照游戏组装的 VfxRenderer 画出来的 GPU 命令逐条相同`, () => {
      const wb = drawWorkbench(c);
      const game = drawLikeTheGame(c);
      expect(draws(wb)).toBeGreaterThanOrEqual(2);
      expect(wb).toEqual(game);
    });
  }

  it('三组用例真画到了该画的东西（贴图粒子 + 薄片 / 光柱两根 / 雷身几层）', () => {
    const space = fieldSpace();
    const stats = CASES.map((c) => {
      const sim = simFor(c, space);
      const a = assetsFor(c, sim.id);
      const stage = new VfxStage();
      stage.setScreen(VIEW_W, VIEW_H);
      stage.setCamera(c.camera.zoom, c.camera.ox, c.camera.oy);
      stage.setScene({ width: SCENE_W, height: SCENE_H, depth: a.depth ? { texture: a.depth, config: DEPTH_CFG } : null, perspective: null });
      stage.sync(sim, a.sheets, a.beamTextures);
      const s = stage.stats();
      stage.destroy();
      return { live: sim.liveCount, ...s };
    });
    expect(stats[0].live).toBeGreaterThan(40);
    expect(stats[0].meshes).toBeGreaterThanOrEqual(3);
    expect(stats[1].beams).toBe(2);
    expect(stats[1].visibleBeams).toBeGreaterThanOrEqual(1);
    expect(stats[2].meshes).toBeGreaterThanOrEqual(3);
  });

  it('记录器够灵敏：相机差半个像素、种子差一、多推一帧，串都不同', () => {
    const c = CASES[0];
    const base = drawWorkbench(c);
    expect(drawWorkbench({ ...c, camera: { ...c.camera, ox: c.camera.ox + 0.5 } })).not.toEqual(base);
    expect(drawWorkbench({ ...c, seed: c.seed + 1 })).not.toEqual(base);
    expect(drawWorkbench({ ...c, steps: c.steps + 1 })).not.toEqual(base);
  });

  it('图层开关：粒子去勾一颗不画、光柱去勾光柱网格不画；「还没播画满」只在画的那一下改淡入，画完还原', () => {
    const c = CASES[1];
    const space = fieldSpace();
    const sim = new VfxInstanceSim('inst', clone(c.effect), space.anchorToWorld(c.anchor), c.seed, space, 1, {});
    const a = assetsFor(c, sim.id);
    const stage = new VfxStage();
    stage.setScreen(VIEW_W, VIEW_H);
    stage.setCamera(c.camera.zoom, c.camera.ox, c.camera.oy);
    stage.setScene({ width: SCENE_W, height: SCENE_H, depth: null, perspective: null });
    // t = 0：光柱淡入还是 0（游戏里这一帧不画）；工作台「画满」这一下当 1 画、画完还原成 0
    const fade0 = sim.beams.map((b) => b.fade);
    stage.sync(sim, a.sheets, a.beamTextures, { beamsFull: false });
    const dark = stage.stats().visibleBeams;
    stage.sync(sim, a.sheets, a.beamTextures, { beamsFull: true });
    const full = stage.stats().visibleBeams;
    expect(sim.beams.map((b) => b.fade)).toEqual(fade0);
    expect(full).toBeGreaterThan(dark);
    for (let i = 0; i < 60; i++) sim.step(1 / 60, { fields: [], contacts: [], player: null, time: i / 60, wind: null, windTime: i / 60 });
    stage.sync(sim, a.sheets, a.beamTextures, { beams: false });
    expect(stage.stats().beams).toBe(2);
    expect(stage.stats().visibleBeams).toBe(0);
    stage.sync(sim, a.sheets, a.beamTextures, { particles: false });
    expect(stage.stats().meshes).toBe(2);
    stage.destroy();
  });
});

describe('雷电样式的现画预览（工具视图：两格、游戏的模拟 + VfxRenderer）', () => {
  const composed = () => ({
    id: 'bolt_preview', bolts: clone(boltFx.bolts),
    emitters: clone(boltFx.emitters.filter((e) => ['bolt', 'bolt_stroke', 'ground_arcs', 'water_arcs'].includes(e.id))),
  }) as unknown as VfxEffectDef;

  function drawPreview(opts: { t: number; water: boolean; seed: number; w?: number }): { lines: string[]; live: number } {
    const W = opts.w ?? 420, H = 300;
    const rhi = new NullRhiDevice({ swapchainSize: [W, H] });
    const trace = traceRhi(rhi);
    const canvas = { width: W, height: H, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: W, height: H, resolution: 1, background: 0x0b0d12 });
    const st = new BoltPreviewStage();
    st.setEffect(composed());
    st.restart(opts.seed, opts.water ? 'water' : 'ground');
    st.advanceTo(opts.t);
    const k = H / 768, split = Math.round(W * 0.42);
    st.layout(W, H, [{ x: 0, w: split, scale: 0.45 * k }, { x: split, w: W - split, scale: 2 * k }]);
    st.sync();
    renderer.render(st.root);
    const live = st.live;
    st.destroy();
    return { lines: trace.lines, live };
  }

  it('劈下来那一刻两格都画雷（模板遮罩裁边 + 雷层走游戏的雷管线）；落在地面 / 水面换电弧层', () => {
    const g = drawPreview({ t: 0.05, water: false, seed: 1 });
    const w = drawPreview({ t: 0.05, water: true, seed: 1 });
    expect(g.live).toBe(3);                         // 主雷 + 回击加粗 + 落地电弧（水面电弧只在水面上）
    expect(w.live).toBe(3);                         // 主雷 + 回击加粗 + 水面电弧
    expect(g.lines.some((l) => /^ {2}stencil/.test(l))).toBe(true);
    expect(draws(g.lines)).toBeGreaterThanOrEqual(6);
    expect(g.lines).not.toEqual(w.lines);
  });

  it('同一刻同一种子重画逐条相同（确定性）；换种子 / 换时刻不同；停顿期（雷已灭）只剩底图', () => {
    const a = drawPreview({ t: 0.12, water: false, seed: 5 });
    expect(drawPreview({ t: 0.12, water: false, seed: 5 }).lines).toEqual(a.lines);
    expect(drawPreview({ t: 0.12, water: false, seed: 6 }).lines).not.toEqual(a.lines);
    expect(drawPreview({ t: 0.2, water: false, seed: 5 }).lines).not.toEqual(a.lines);
    const quiet = drawPreview({ t: 1.0, water: false, seed: 5 });
    expect(quiet.live).toBe(0);
    expect(draws(quiet.lines)).toBeLessThan(draws(a.lines));
  });

  it('往回拨时间 = 从劈下那一刻重跑（与一口气推到那一刻逐条相同）', () => {
    const st = new BoltPreviewStage();
    st.setEffect(composed());
    st.restart(9, 'ground');
    st.advanceTo(0.3);
    st.advanceTo(0.1);
    expect(st.time).toBeCloseTo(0.1, 9);
    expect(st.live).toBe(3);
    st.destroy();
  });

  it('平面近似空间：落点在格子地面线上（与游戏平面近似同一条 [x, 0, −y·k]）', () => {
    const space = createPlanarVfxSpace();
    const a = space.anchorToWorld({ x: 0, y: 0, h: 0 });
    const o = { x: 1, y: 1 };
    space.toScene(a, o);
    expect(Math.abs(o.x) + Math.abs(o.y)).toBeLessThan(1e-9);
  });
});
