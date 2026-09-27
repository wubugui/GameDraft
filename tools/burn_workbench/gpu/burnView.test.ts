/**
 * 燃烧工作台画面 == 游戏画面（无 GPU 那一半）：同一组输入（模板图 + 燃烧场 + 着色参数 + 相机），
 *
 * - **工作台**：`BurnStage`（页面经 `viewer/render.js` 调的就是它）；
 * - **游戏**：照游戏组装层现拼——`SceneManager.instantiateHotspot`（`new Hotspot` + 模板图当展示图）→ 实体层按脚点排序 →
 *   `BurnSystem` 那几步（`BurnRenderer.attach` → 模拟编码进 `fieldData` → `markDirty(…, true)` →
 *   `setShade(…, burnSceneToUvAffine(host.frame))`）→ `Game` 每帧 `burnRenderer.update(…, 世界容器位置与投影缩放)` → 渲染。
 *
 * 两边各开一台空后端设备（`NullRhiDevice`），`traceRhi` 把决定像素的全部 GPU 输入（pass、视口、管线与 WGSL、uniform 字节、
 * 纹理内容、顶点 / 索引字节、draw）记成规范化的串，**必须逐行相同**——在同一块确定性 GPU 上就逐字节同一张图。
 * 真 GPU 上的逐像素对照另有 `tools/burn_workbench/tests/parity/run.mjs`（Chrome）。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { BufferImageSource, Container, Sprite, Texture, WebGPURenderer } from '../../../src/engine2d';
import { Hotspot } from '../../../src/entities/Hotspot';
import type { HotspotDef } from '../../../src/data/types';
import { BurnRenderer } from '../../../src/rendering/burn/BurnRenderer';
import type { BurnShadeParams } from '../../../src/rendering/burn/burnShadeParams';
import { burnHotspotFrame, burnSceneToUvAffine } from '../../../src/systems/burn/burnGeometry';
import { createPerspectiveScaleResolver, type PerspectiveScaleResolver } from '../../../src/utils/perspectiveScale';
import { traceRhi } from '../../workbench_rhi/rhiTrace';
import { BurnStage, artHotspotDef, type BurnHotspotInput } from './burnView';

const VIEW_W = 320;
const VIEW_H = 200;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s & 0xffffff) / 0x1000000;
  };
}

/** 预乘的带 alpha 模板图（软边椭圆 + 一个全透明洞 + 半透明带） */
function templateTexture(w: number, h: number, seed: number): Texture {
  const r = rng(seed);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5;
      const v = (y + 0.5) / h - 0.5;
      let a = Math.max(0, Math.min(1, (1 - Math.hypot(u / 0.48, v / 0.46)) * 6));
      if (Math.hypot(u - 0.12, v + 0.08) < 0.1) a = 0;
      if (y % 7 === 3) a *= 0.45;
      const i = (y * w + x) * 4;
      data[i] = Math.round(Math.min(1, 0.35 + 0.6 * x / w + 0.1 * r()) * a * 255);
      data[i + 1] = Math.round(Math.min(1, 0.3 + 0.5 * y / h + 0.1 * r()) * a * 255);
      data[i + 2] = Math.round(0.25 * a * 255);
      data[i + 3] = Math.round(a * 255);
    }
  }
  return new Texture({ source: new BufferImageSource({ resource: data, width: w, height: h, alphaMode: 'premultiplied-alpha', scaleMode: 'linear' }) });
}

const GRID_W = 13;
const GRID_H = 9;

/** 合成燃烧场（与模拟 `encodeTexture` 同格式：RG = 点着时刻 16 位定点、B = 燃料、A = 熄灭定格） */
function encodeField(dst: Uint8Array, seed: number): void {
  const r = rng(seed);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const i = (y * GRID_W + x) * 4;
      const t = 1 + 0.75 * Math.hypot(x - 2.5, y - 3) + r() * 0.4;
      const k = r();
      const fuel = k < 0.08 ? 0 : 0.35 + 0.65 * r();
      const q = k >= 0.1 && k < 0.16 ? 65535 : Math.min(65534, Math.round(t * 16));
      dst[i] = q >> 8;
      dst[i + 1] = q & 255;
      dst[i + 2] = Math.round(fuel * 255);
      dst[i + 3] = k > 0.9 ? 255 : 0;
    }
  }
}

function shade(now: number): BurnShadeParams {
  return {
    gridW: GRID_W, gridH: GRID_H, now, timeStep: 1 / 16, flameSeconds: 3, emberSeconds: 4, scorchSeconds: 1.5,
    ashFadeSeconds: 2, edgeNoise: 0.6, scorchColor: [0.86, 0.64, 0.38], charColor: [0.09, 0.07, 0.06],
    ashColor: [0.56, 0.54, 0.5], ashAlpha: 0.3, glow: [2.4, 1.0, 0.3], emberGlow: [1.2, 0.3, 0.06],
  };
}

interface Case {
  camera: { scale: number; x: number; y: number };
  /** 背景（平贴，工作台场景视图那张） */
  background: { w: number; h: number } | null;
  hotspots: Array<{ def: BurnHotspotInput['def']; burnNow: number | null; seed: number }>;
  perspective: PerspectiveScaleResolver | null;
  resolution: number;
}

function setup(resolution: number) {
  const rhi = new NullRhiDevice({ swapchainSize: [Math.round(VIEW_W * resolution), Math.round(VIEW_H * resolution)] });
  const trace = traceRhi(rhi);
  const canvas = { width: Math.round(VIEW_W * resolution), height: Math.round(VIEW_H * resolution), style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: VIEW_W, height: VIEW_H, resolution, background: 0x111113 });
  return { renderer, trace };
}

/** 每个用例一份纹理（两边各建各的、内容逐字节相同） */
function texturesFor(c: Case) {
  return { tpl: templateTexture(48, 32, 7), bg: c.background ? templateTexture(64, 40, 3) : null };
}

/** 工作台：BurnStage（页面 render.js 交给它的就是这些） */
function drawWorkbench(c: Case): string[] {
  const { renderer, trace } = setup(c.resolution);
  const tex = texturesFor(c);
  const stage = new BurnStage();
  stage.setCamera(c.camera.scale, c.camera.x, c.camera.y);
  if (c.background && tex.bg) stage.setBackground(tex.bg, c.background.w, c.background.h);
  const src = {};
  stage.sync(c.hotspots.map((h, i) => ({
    key: `k${i}`, kind: 'hotspot', def: h.def, texture: tex.tpl, perspective: c.perspective,
    burn: h.burnNow === null ? null : { gridW: GRID_W, gridH: GRID_H, source: src, gen: 1, encode: (d: Uint8Array) => encodeField(d, h.seed), params: shade(h.burnNow) },
  })), 0);
  renderer.render(stage.root);
  return trace.lines;
}

/** 游戏：照 SceneManager / BurnSystem / Game 的组装顺序现拼 */
function drawLikeTheGame(c: Case): string[] {
  const { renderer, trace } = setup(c.resolution);
  const tex = texturesFor(c);
  const appStage = new Container();
  const worldContainer = new Container();
  const backgroundLayer = new Container();
  const shadowLayer = new Container();
  const entityLayer = new Container();
  worldContainer.addChild(backgroundLayer, shadowLayer, entityLayer);
  appStage.addChild(worldContainer);
  worldContainer.position.set(c.camera.x, c.camera.y);
  worldContainer.scale.set(c.camera.scale, c.camera.scale);
  if (c.background && tex.bg) {
    const bg = new Sprite(tex.bg);
    bg.width = c.background.w;
    bg.height = c.background.h;
    backgroundLayer.addChild(bg);
  }
  const burn = new BurnRenderer();
  const hotspots = c.hotspots.map((h) => {
    const hs = new Hotspot({ type: 'inspect', interactionRange: 0, data: {}, ...structuredClone(h.def) } as unknown as HotspotDef);
    entityLayer.addChild(hs.container);
    hs.setDisplayTexture(tex.tpl, h.def.displayImage.worldWidth, h.def.displayImage.worldHeight);
    hs.setPerspectiveScale(c.perspective);
    return hs;
  });
  c.hotspots.forEach((h, i) => {
    if (h.burnNow === null) return;
    const key = `s:k${i}`;
    burn.attach(key, { kind: 'filters', host: hotspots[i] }, GRID_W, GRID_H);
    encodeField(burn.fieldData(key)!, h.seed);
    burn.markDirty(key, 0, true);
    const size = { width: h.def.displayImage.worldWidth, height: h.def.displayImage.worldHeight };
    burn.setShade(key, shade(h.burnNow), burnSceneToUvAffine(burnHotspotFrame(hotspots[i], size)));
  });
  burn.update(0, { x: worldContainer.x, y: worldContainer.y, scale: c.camera.scale });
  renderer.render(appStage);
  return trace.lines;
}

const ART: Case = {
  camera: { scale: 2.75, x: 31.25, y: 18.5 }, background: null, perspective: null, resolution: 1,
  hotspots: [{ def: artHotspotDef('/tpl.png', 48, 32), burnNow: 5, seed: 11 }],
};

const PERSP = createPerspectiveScaleResolver({ near: { x: 160, y: 190, scale: 1 }, far: { x: 160, y: 40, scale: 0.5 } } as never);

const SCENE: Case = {
  camera: { scale: 0.8, x: 12.5, y: -6 }, background: { w: 400, h: 250 }, perspective: PERSP, resolution: 1.25,
  hotspots: [
    // 顺序 = 实体层按脚点 y 排好的画序
    { def: { id: 'far', x: 90, y: 80, displayImage: { image: '/tpl.png', worldWidth: 60, worldHeight: 40 } }, burnNow: null, seed: 1 },
    { def: { id: 'rot', x: 250, y: 130, scale: 0.88, rotation: 12, displayImage: { image: '/tpl.png', worldWidth: 90, worldHeight: 60 } }, burnNow: 1.8, seed: 2 },
    { def: { id: 'mirror', x: 150, y: 170, perspectiveScaleEnabled: true, displayImage: { image: '/tpl.png', worldWidth: 120, worldHeight: 80, facing: 'left' } }, burnNow: 10.5, seed: 3 },
  ],
};

describe('燃烧工作台画面 == 游戏画面（空后端，逐条 GPU 命令与字节）', () => {
  it('原画视图：模板图当热点、两道燃烧滤镜、相机 uniform', () => {
    const wb = drawWorkbench(ART);
    const game = drawLikeTheGame(ART);
    expect(wb.filter((l) => l.startsWith('  draw')).length).toBeGreaterThanOrEqual(3); // 精灵进滤镜 + 材质 + 自发光
    expect(wb).toEqual(game);
  });

  it('场景视图：背景 + 三个热点（未点 / 旋转缩放 / 透视 + 朝左镜像）、分辨率 1.25', () => {
    const wb = drawWorkbench(SCENE);
    const game = drawLikeTheGame(SCENE);
    expect(wb).toEqual(game);
  });

  it('记录器够灵敏：相机差半个像素、燃烧时刻差一点、燃烧场差一格，串都不同', () => {
    const base = drawWorkbench(ART);
    expect(drawWorkbench({ ...ART, camera: { ...ART.camera, x: ART.camera.x + 0.5 } })).not.toEqual(base);
    expect(drawWorkbench({ ...ART, hotspots: [{ ...ART.hotspots[0], burnNow: 5.01 }] })).not.toEqual(base);
    expect(drawWorkbench({ ...ART, hotspots: [{ ...ART.hotspots[0], seed: 12 }] })).not.toEqual(base);
  });

  it('只在"烧过"时挂：没点的实例没有燃烧滤镜（与游戏 BurnRenderer 同一条）', () => {
    const stage = new BurnStage();
    const tex = templateTexture(8, 8, 1);
    stage.sync([
      { key: 'a', kind: 'hotspot', def: artHotspotDef('/x.png', 8, 8), texture: tex, burn: null },
      { key: 'b', kind: 'hotspot', def: { ...artHotspotDef('/x.png', 8, 8), id: 'b' }, texture: tex,
        burn: { gridW: 2, gridH: 2, source: {}, gen: 0, encode: () => {}, params: shade(1) } },
    ], 0);
    expect(stage.burning('a')).toBe(false);
    expect(stage.burning('b')).toBe(true);
    stage.sync([{ key: 'b', kind: 'hotspot', def: { ...artHotspotDef('/x.png', 8, 8), id: 'b' }, texture: tex, burn: null }], 0);
    expect(stage.burning('b')).toBe(false);
    expect(stage.keys()).toEqual(['b']);
    stage.destroy();
  });
});
