/**
 * 角色照明实验室 2D 场景视图 == 游戏画面（无 GPU 那一半）：同一份载荷（游戏格式）+ 同一组输入（脚点 / 角色高 / 着色参数 / 相机），
 *
 * - **实验室**：`CharLabStage`（页面 `viewer/app.js` 交给它的就是这些）；
 * - **游戏**：照游戏组装层现拼——`Game` 的 depthLoader（`SceneDepthSystem.load`）→ `CharacterLightingSystem.load` →
 *   `onReady`（行走面注入深度系统）→ lightingLoader（`applyDisplay` / `applyLightFactors` / `applyLights`）→
 *   `rebuildEntityShadows`（`setShadowBasis`）→ `attachPlayerSceneFilter`（`SpriteEntity.enableBakedShading` 的 lit 网格 +
 *   `createFilterForEntity`）→ `applyCharMode`（切档）→ 每帧 `charLitFrameSync`（`syncFrame`）+ `updatePerFrame` /
 *   `updateEntityDepthOcclusion` → 渲染。
 *
 * 载荷走真网络路径（装载器自己 fetch / 解图）：`fetch`、`createImageBitmap`、`OffscreenCanvas` 换成测试替身（图是约定格式的原始 RGBA）。
 * 两边各开一台空后端设备（`NullRhiDevice`），`traceRhi` 把决定像素的全部 GPU 输入记成规范化的串，**必须逐行相同**。
 * 真 GPU 上的逐像素对照另有 `tools/character_lighting_lab/tests/parity/run.mjs`（Chrome）。
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Assets, BufferImageSource, Container, DOMAdapter, Sprite, Texture, WebGPURenderer } from '../../../src/engine2d';
import { AssetManager } from '../../../src/core/AssetManager';
import { CharacterLightingSystem } from '../../../src/core/CharacterLightingSystem';
import { SceneDepthSystem } from '../../../src/core/SceneDepthSystem';
import { legacyLightFactors } from '../../../src/data/lightFactors';
import type { SceneDepthConfig, SceneLightingDef } from '../../../src/data/types';
import { LitSpriteQuad } from '../../../src/rendering/CharacterLitSprite';
import { packLights } from '../../../src/rendering/lighting/lightPacking';
import { traceRhi } from '../../workbench_rhi/rhiTrace';
import { CharLabStage, displayForGain, type LabFrame, type LabSceneInput } from './charLabView';

// ─────────────────────────────────────────────────────────── 合成载荷（游戏格式）

const SID = 'zz_lab';
const BASE = '/api/game_payload/zz_lab/n0-a1.000';
const WORK = { w: 40, h: 24 };
const NATIVE = { w: 80, h: 48 };
const PN = { nx: 3, ny: 2, nz: 4 };
const VOL = { nx: 5, ny: 4, nz: 6, tiles_x: 3, tiles_y: 2 };
const VIEW_W = 200;
const VIEW_H = 120;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (s & 0xffffff) / 0x1000000;
  };
}

/** f32 → f16 位型（够用的舍入：测试数据落在正常数范围） */
function half(v: number): number {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const man = (x >>> 13) & 0x3ff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | man;
}

function f16Array(n: number, r: () => number, lo: number, hi: number): Uint16Array {
  const a = new Uint16Array(n);
  for (let i = 0; i < n; i++) a[i] = half(lo + (hi - lo) * r());
  return a;
}

/** 约定图格式：'FAKEIMG' + u32 宽 + u32 高 + RGBA（替身 createImageBitmap 解它） */
function fakeImage(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(7 + 8 + rgba.length);
  out.set(new TextEncoder().encode('FAKEIMG'), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(7, w, true);
  dv.setUint32(11, h, true);
  out.set(rgba, 15);
  return out;
}

function rg16(values: Float32Array, lo: number, hi: number): Uint8Array {
  const px = new Uint8Array(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const n = Math.round((values[i] - lo) / (hi - lo) * 65535);
    px[i * 4] = n >> 8; px[i * 4 + 1] = n & 255; px[i * 4 + 3] = 255;
  }
  return px;
}

function buildPayload(): Map<string, { body: Uint8Array; type: string }> {
  const r = rng(11);
  const files = new Map<string, { body: Uint8Array; type: string }>();
  const bin = (name: string, a: ArrayBufferView) => files.set(`${BASE}/${name}`, { body: new Uint8Array(a.buffer, a.byteOffset, a.byteLength), type: 'application/octet-stream' });
  const P = PN.nx * PN.ny * PN.nz;
  bin('atlas_l1.bin', f16Array(P * 4 * 4, r, 0.02, 0.9));
  bin('atlas_l2.bin', f16Array(P * 9 * 4, r, -0.05, 0.9));
  bin('atlas_bin.bin', f16Array(P * 64 * 4, r, 0.01, 1.2));
  const valid = new Uint8Array(P);
  for (let i = 0; i < P; i++) valid[i] = r() > 0.2 ? 255 : 0;
  bin('probes_valid.bin', valid);
  const vw = VOL.nx * VOL.tiles_x, vh = VOL.ny * VOL.tiles_y;
  bin('vol_rad.bin', f16Array(vw * vh * 4, r, 0, 1));
  bin('vol_emit.bin', f16Array(vw * vh * 4, r, 0, 0.2));
  // 行走面（work 分辨率 RG16）与深度图（原生 RG16）
  const walk = new Float32Array(WORK.w * WORK.h);
  for (let y = 0; y < WORK.h; y++) for (let x = 0; x < WORK.w; x++) walk[y * WORK.w + x] = 0.4 + 2.2 * y / WORK.h + 0.05 * Math.sin(x);
  files.set(`${BASE}/ground_d.png`, { body: fakeImage(WORK.w, WORK.h, rg16(walk, 0.3, 2.8)), type: 'image/png' });
  const depth = new Float32Array(NATIVE.w * NATIVE.h);
  for (let y = 0; y < NATIVE.h; y++) for (let x = 0; x < NATIVE.w; x++) {
    depth[y * NATIVE.w + x] = 0.4 + 2.2 * y / NATIVE.h - (x > 40 && x < 60 && y > 12 && y < 30 ? 1.2 : 0);
  }
  files.set(`${BASE}/raw_depth_rg.png`, { body: fakeImage(NATIVE.w, NATIVE.h, rg16(depth, -1, 3)), type: 'image/png' });
  const bg = fakeImage(4, 4, new Uint8Array(64).fill(200));
  files.set(`/resources/runtime/scenes/${SID}/background.png`, { body: bg, type: 'image/png' });
  const c = Math.SQRT1_2;
  const meta = {
    version: 3,
    background_sha1: createHash('sha1').update(bg).digest('hex').slice(0, 12),
    work: WORK,
    cal: { theta: Math.PI / 4, ppu: 9, cx: WORK.w / 2, cy: WORK.h / 2 },
    world: { M: [[1, 0, 0], [0, c, -c], [0, -c, -c]], x0: -2, x1: 2, y0: -0.3, y1: 1.6, z0: -1.4, z1: 1.8 },
    probes: PN,
    vol: { ...VOL, qx_min: -2.2, qx_max: 2.2, qy_min: -1.4, qy_max: 1.4, qz_min: -1.5, qz_max: 2.0 },
    ambient_sh: Array.from({ length: 27 }, (_, i) => 0.05 + 0.01 * (i % 5)),
    lights: [{ pos: [0.2, 0.5, 0.1], radiance: [0.4, 0.3, 0.2], area: 0.02 }],
    ground_d: { min: 0.3, max: 2.8 },
    shading: { mode: 3, spp: 64, step: 0.9, msteps: 160, fold: 1, miss_mode: 0, nee: 0, beta: 0, amb: 1, bulge: 0.22, flatten: 0 },
  };
  files.set(`${BASE}/lighting.json`, { body: new TextEncoder().encode(JSON.stringify(meta)), type: 'application/json' });
  const cfg: SceneDepthConfig = {
    depth_map: `${BASE}/raw_depth_rg.png`,
    M: { R: [[1, 0, 0], [0, c, -c], [0, c, c]], ppu: 18, cx: NATIVE.w / 2, cy: NATIVE.h / 2 },
    depth_mapping: { invert: false, scale: 4, offset: -1 },
    shader: { depth_per_sy: 1 / 18 },
    depth_tolerance: 0.05,
    floor_offset: 0,
  } as unknown as SceneDepthConfig;
  files.set(`${BASE}/depth.json`, { body: new TextEncoder().encode(JSON.stringify(cfg)), type: 'application/json' });
  return files;
}

const FILES = buildPayload();

class FakeBitmap {
  constructor(readonly width: number, readonly height: number, readonly data: Uint8Array) {}
  close(): void {}
}

class FakeCanvas {
  private img: FakeBitmap | null = null;
  constructor(readonly width: number, readonly height: number) {}
  getContext(): unknown {
    return {
      drawImage: (b: FakeBitmap) => { this.img = b; },
      getImageData: () => ({ data: new Uint8ClampedArray(this.img!.data) }),
    };
  }
}

beforeAll(() => {
  vi.stubGlobal('fetch', async (u: string | URL, init?: RequestInit) => {
    const path = new URL(String(u), 'http://127.0.0.1/').pathname;
    const hit = FILES.get(decodeURIComponent(path));
    if (!hit) return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    if (init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': hit.type } });
    return new Response(hit.body.slice(), { status: 200, headers: { 'content-type': hit.type } });
  });
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const b = new Uint8Array(await blob.arrayBuffer());
    if (new TextDecoder().decode(b.subarray(0, 7)) !== 'FAKEIMG') return new FakeBitmap(1, 1, new Uint8Array(4));
    const dv = new DataView(b.buffer, b.byteOffset);
    return new FakeBitmap(dv.getUint32(7, true), dv.getUint32(11, true), b.slice(15));
  });
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  Assets.setPreferences({ preferWorkers: false });
  // 空后端环境没有 document:装载器拼绝对地址要基址
  DOMAdapter.set({ ...DOMAdapter.get(), getBaseUrl: () => 'http://127.0.0.1/' });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────── 两边的画法

function charTextures(): { color: Texture; normal: Texture } {
  const r = rng(5);
  const w = 12, h = 30;
  const color = new Uint8Array(w * h * 4);
  const nrm = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = Math.abs(x - w / 2 + 0.5) < w * 0.4 * (0.6 + 0.4 * y / h);
      const a = inside ? 255 : 0;
      color[i] = Math.round((0.3 + 0.5 * r()) * a); color[i + 1] = Math.round(0.4 * a); color[i + 2] = Math.round(0.35 * a); color[i + 3] = a;
      nrm[i] = 90 + Math.round(70 * x / w); nrm[i + 1] = 100 + Math.round(40 * y / h); nrm[i + 2] = 220; nrm[i + 3] = inside ? 120 : 0;
    }
  }
  return {
    color: new Texture({ source: new BufferImageSource({ resource: color, width: w, height: h, alphaMode: 'premultiplied-alpha' }) }),
    normal: new Texture({ source: new BufferImageSource({ resource: nrm, width: w, height: h, alphaMode: 'no-premultiply-alpha' }) }),
  };
}

function bgTexture(): Texture {
  const r = rng(3);
  const px = new Uint8Array(WORK.w * WORK.h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 60 + 100 * r(); px[i + 1] = 70; px[i + 2] = 80; px[i + 3] = 255; }
  return new Texture({ source: new BufferImageSource({ resource: px, width: WORK.w, height: WORK.h, alphaMode: 'premultiplied-alpha' }) });
}

interface Case {
  frame: LabFrame;
  resolution: number;
}

function setup(resolution: number) {
  const rhi = new NullRhiDevice({ swapchainSize: [Math.round(VIEW_W * resolution), Math.round(VIEW_H * resolution)] });
  const trace = traceRhi(rhi);
  const canvas = { width: Math.round(VIEW_W * resolution), height: Math.round(VIEW_H * resolution), style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: VIEW_W, height: VIEW_H, resolution, background: 0x0a0d0f });
  return { renderer, trace };
}

const INPUT: LabSceneInput = { sceneId: SID, bgImage: 'background.png', baseUrl: BASE, work: WORK, native: NATIVE, wuPerQUnit: 9 };

/** 实验室：CharLabStage */
async function drawLab(c: Case): Promise<string[]> {
  const { renderer, trace } = setup(c.resolution);
  const tex = charTextures();
  const stage = new CharLabStage();
  expect(await stage.load(INPUT)).toBe(true);
  expect(stage.depth.isEnabled).toBe(true);
  stage.setCharacterTextures(tex.color, tex.normal.source);
  stage.setBackground(bgTexture());
  await stage.requestMode(c.frame.shading.mode);
  stage.sync(c.frame);
  trace.clear();
  renderer.render(stage.root);
  stage.destroy();
  return trace.lines;
}

/** 游戏：照 Game / SceneDepthSystem / CharacterLightingSystem / SpriteEntity 的组装顺序现拼 */
async function drawLikeTheGame(c: Case): Promise<string[]> {
  const { renderer, trace } = setup(c.resolution);
  const tex = charTextures();
  const f = c.frame, p = f.shading;
  // depthLoader
  const cfg = await (await fetch(`${BASE}/depth.json`)).json() as SceneDepthConfig;
  const depth = new SceneDepthSystem();
  await depth.load(SID, cfg, new AssetManager(), WORK.w, WORK.h, NATIVE.w / WORK.w, NATIVE.h / WORK.h);
  expect(depth.isEnabled).toBe(true);
  const cl = new CharacterLightingSystem();
  cl.onReady = () => depth.setGroundDepthField(cl.groundDepthField, cl.groundDepthTexture);
  await cl.load(SID, WORK.w, WORK.h, 'background.png', undefined, BASE);
  // lightingLoader（场景有 lighting 块、零盏灯；显示变换 = 预览亮度的显示 EV）
  cl.applyDisplay(displayForGain(p.previewGain));
  cl.applyLightFactors(undefined);
  cl.applyLights(packLights({ lights: [] } as unknown as SceneLightingDef, INPUT.wuPerQUnit), INPUT.wuPerQUnit);
  // rebuildEntityShadows
  const s = depth.getShadowSceneContext()!;
  cl.setShadowBasis([s.r00, s.r01, s.r02, s.r10, s.r11, s.r12, s.r20, s.r21, s.r22]);
  // applyCharMode
  if (p.mode < 1) await cl.ensureVolumes(); else { cl.releaseVolumes(); await cl.ensureProbeAtlas(p.mode); }
  cl.params.mode = p.mode;
  cl.disposeStaleVolumeTextures();
  cl.disposeStaleProbeTextures();
  // 场景图：worldContainer ⊃ 背景 + 玩家容器（变换载体精灵 + lit 网格，SpriteEntity.refreshLitQuad / syncLitQuad）
  const appStage = new Container();
  const world = new Container();
  appStage.addChild(world);
  world.position.set(f.camera.x, f.camera.y);
  world.scale.set(f.camera.scale, f.camera.scale);
  const bg = new Sprite(bgTexture());
  bg.width = WORK.w; bg.height = WORK.h;
  world.addChild(bg);
  const player = new Container();
  const sprite = new Sprite(tex.color);
  sprite.anchor.set(0.5, 1);
  const k = f.heightPx / tex.color.height;
  sprite.scale.set(k, k);
  sprite.renderable = false;
  player.addChild(sprite);
  const quad = new LitSpriteQuad(cl.createEntityLitShader(tex.color.source, tex.normal.source)!);
  player.addChild(quad.mesh);
  quad.sync(tex.color, tex.color.width, tex.color.height, 0.5, 1);
  quad.mesh.position.set(sprite.x, sprite.y);
  quad.mesh.scale.set(sprite.scale.x, sprite.scale.y);
  quad.mesh.rotation = sprite.rotation;
  player.position.set(f.foot!.x, f.foot!.y);
  quad.setWorldTransform(player.x, player.y, 1, 1, sprite.x, sprite.y, sprite.scale.x, sprite.scale.y, 0);
  world.addChild(player);
  const filter = depth.createFilterForEntity();
  player.filters = f.occlusion && filter ? [filter] : [];
  // 每帧：F2 参数（场景没配受光倍率 → 旧式等价）+ charLitFrameSync + 深度逐帧驱动
  Object.assign(cl.params, {
    spp: p.spp, step: p.step, msteps: p.msteps, fold: p.fold, missMode: p.missMode, nee: p.nee,
    beta: p.beta, ambStrength: p.amb, giStrength: 1, bulge: p.bulge, flatten: p.flatten, showNormals: p.showNormals,
    ...legacyLightFactors(p.beta, 1),
  });
  cl.eChroma = p.eChroma;
  cl.setSkyaoBlend(p.skyao ? 1 : 0);
  cl.syncFrame(world.x, world.y, f.camera.scale);
  if (f.occlusion && filter) {
    depth.updatePerFrame(world.x, world.y, f.camera.scale);
    depth.updateEntityDepthOcclusion(filter, f.foot!.x, f.foot!.y, 0);
  }
  trace.clear();
  renderer.render(appStage);
  return trace.lines;
}

const SHADING = {
  mode: 1, spp: 16, step: 0.9, msteps: 48, fold: true, missMode: false, nee: false,
  beta: 1.5, amb: 1, bulge: 0.22, flatten: 0.1, eChroma: 0.3, showNormals: false, previewGain: 1, skyao: true,
};
const BASE_CASE: Case = {
  resolution: 1,
  frame: { camera: { scale: 4.5, x: -12.25, y: -8.5 }, foot: { x: 21.5, y: 17.25 }, heightPx: 10.5, occlusion: true, contact: 0, shading: SHADING },
};

describe('实验室 2D 场景视图 == 游戏画面（空后端，逐条 GPU 命令与字节）', () => {
  it('L1 档 + 深度遮挡：载荷装载、lit 网格、遮挡滤镜、帧参数', async () => {
    const lab = await drawLab(BASE_CASE);
    const game = await drawLikeTheGame(BASE_CASE);
    expect(lab.filter((l) => l.startsWith('  draw')).length).toBeGreaterThanOrEqual(3);   // 背景 + 网格进滤镜 + 滤镜
    expect(lab).toEqual(game);
  });

  it.each([2, 3, 0])('档 %i（SH / 八面体 / RT 体素卷），不遮挡、法线视图、预览亮度 2、分辨率 1.25', async (mode) => {
    const c: Case = { resolution: 1.25, frame: { ...BASE_CASE.frame, occlusion: false,
      shading: { ...SHADING, mode, showNormals: mode === 2, previewGain: 2, nee: mode === 0, missMode: mode === 0, skyao: false } } };
    expect(await drawLab(c)).toEqual(await drawLikeTheGame(c));
  });

  it('记录器够灵敏：脚点差半个 work 像素、β 差一点、档不同，串都不同', async () => {
    const base = await drawLab(BASE_CASE);
    expect(await drawLab({ ...BASE_CASE, frame: { ...BASE_CASE.frame, foot: { x: 22, y: 17.25 } } })).not.toEqual(base);
    expect(await drawLab({ ...BASE_CASE, frame: { ...BASE_CASE.frame, shading: { ...SHADING, beta: 1.51 } } })).not.toEqual(base);
    expect(await drawLab({ ...BASE_CASE, frame: { ...BASE_CASE.frame, shading: { ...SHADING, mode: 3 } } })).not.toEqual(base);
    // 角色真的画了:去掉角色少掉网格进滤镜 + 滤镜两次 draw;实验室接触阴影(游戏没有)是额外一次 draw
    const draws = (l: string[]) => l.filter((x) => x.startsWith('  draw')).length;
    expect(draws(await drawLab({ ...BASE_CASE, frame: { ...BASE_CASE.frame, foot: null } }))).toBeLessThan(draws(base) - 1);
    expect(draws(await drawLab({ ...BASE_CASE, frame: { ...BASE_CASE.frame, contact: 0.5 } }))).toBe(draws(base) + 1);
  });
});
