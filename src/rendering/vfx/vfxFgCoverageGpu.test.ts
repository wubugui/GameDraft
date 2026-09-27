/**
 * 粒子 × 场景前景层覆盖图,在空后端(NullRhiDevice)上真画一遍:四个粒子程序(受光 billboard / 受光薄片 / 无光 / 雷)
 * 的每个 WGSL 绑定都要有资源(空后端与 luma 同一条判据:着色器声明了的名字缺一个就当场报,真 GPU 上是整批不画),
 * 覆盖图交来之后绑的是那张覆盖图、收回之后绑回占位——覆盖图 RT 随后销毁,粒子照画不误
 * (拆除顺序:先 setForegroundCoverage(null) 再销毁 RT;反过来的话下一帧就绑到已销毁的纹理)。
 *
 * master 的 Pixi 路径靠按名跳过不认识的 uniform / 纹理兜底,WGSL 路径没有这层兜底,所以这里真走一遍绑定解析。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  Container, DOMAdapter, RenderTexture, Texture, TextureSource, WebGPURenderer, type Shader,
} from '../../engine2d';
import { CharacterLightingSystem } from '../../core/CharacterLightingSystem';
import type { VfxEmitterRuntime, VfxInstanceSim } from '../../systems/vfx/vfxSim';
import { createSceneLitUniforms } from '../CharacterLitSprite';
import type { RhiBindings, RhiCommandList, RhiRenderPassEncoder } from '../rhi';
import { NullRhiDevice } from '../rhi/backends/null/NullRhiDevice';
import { VfxBatchMesh } from './VfxBatchMesh';
import { VfxBoltBatchMesh } from './VfxBoltBatchMesh';
import { VfxPlateBatchMesh, createPlateStrip } from './VfxPlateBatchMesh';
import { VfxRenderer, type VfxRenderDeps, type VfxSpriteSheet } from './VfxRenderer';

/** 截下每次 setBindings 收到的绑定表(与 renderHotPath.test 同一个包法) */
function captureBindings(rhi: NullRhiDevice): RhiBindings[] {
  const seen: RhiBindings[] = [];
  const submit = rhi.submit.bind(rhi);
  vi.spyOn(rhi, 'submit').mockImplementation((label, record) => submit(label, (commands) => {
    const wrapped = Object.create(commands) as RhiCommandList;
    wrapped.beginRenderPass = (desc) => {
      const pass = commands.beginRenderPass(desc);
      const w = Object.create(pass) as RhiRenderPassEncoder;
      w.setBindings = (b) => {
        seen.push(b);
        pass.setBindings(b);
      };
      return w;
    };
    record(wrapped);
  }));
  return seen;
}

/** 真的照明系统,载荷按 loadScene 同名同形注入(只要 createCustomLitShader 建得出) */
function lighting(): CharacterLightingSystem {
  const sys = new CharacterLightingSystem();
  const priv = sys as unknown as Record<string, unknown>;
  const t = (label: string) => new TextureSource({ width: 2, height: 2, label });
  priv.resources = {
    atlasL1: t('L1'), atlasL2: t('L2'), atlasBin: t('bin'), valid: t('valid'), volRad: t('volRad'), volEmit: t('volEmit'),
    skyao: { tex: t('skyao') },
  };
  priv.groundTex = t('ground');
  priv.sceneLit = createSceneLitUniforms({
    worldToWorkX: 1, worldToWorkY: 1, cal: { ppu: 1, cx: 0, cy: 0, theta: 0 },
    vol: { nx: 1, ny: 1, nz: 1, tilesX: 1, tilesY: 1, qMin: [0, 0, 0], qMax: [1, 1, 1] },
    mCol: new Float32Array(9), wMin: [0, 0, 0], wScale: [1, 1, 1], pn: [1, 1, 1], probeT: 1, shK: 9, binOb: 8,
    ambSH: new Float32Array(27), lightsQ: new Float32Array(192), lightsE: new Float32Array(192), lightCount: 0,
    groundMin: 0, groundMax: 1, sceneWorldW: 1, sceneWorldH: 1, workW: 1, workH: 1,
  });
  return sys;
}

function emitter(id: string, ap: Record<string, unknown>, plate = false): VfxEmitterRuntime {
  return {
    def: { id, appearance: { image: 'x', sizeWu: 4, ...ap } }, p: { cap: 0 },
    plate: plate ? { P: { segments: 2 }, arr: {} } : null,
  } as unknown as VfxEmitterRuntime;
}

describe('粒子 × 前景覆盖图 · 空后端上真画', () => {
  const adapter0 = DOMAdapter.get();
  beforeAll(() => { DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never }); });
  afterAll(() => { DOMAdapter.set(adapter0); });

  it('四个程序绑定齐;交来覆盖图绑它、收回绑占位;收回后销毁覆盖图 RT 照画不误', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const seen = captureBindings(rhi);

    const sys = lighting();
    const depthTex = new Texture({ source: new TextureSource({ width: 4, height: 4, label: 'depthMap' }) });
    const deps: VfxRenderDeps = {
      entityLayer: new Container(),
      createLitShader: (programs, colorTex, extra) => sys.createCustomLitShader(programs, colorTex, extra),
      releaseLitShader: (sh) => sys.releaseEntityLitShader(sh),
      canLight: () => true,
      displayUniforms: sys.displayUniforms,
      getToneEnv: () => null,
      getDepth: () => ({ tex: depthTex, cfg: { depth_mapping: { invert: false, scale: 1, offset: 0 }, depth_tolerance: 0.05 } as never }),
      getSceneSize: () => ({ w: 64, h: 64 }),
      perspective: () => 1,
    };
    const r = new VfxRenderer(deps);
    const ems = [emitter('lit', {}), emitter('plate', {}, true), emitter('unlit', { lit: false }), emitter('bolt', { bolt: { bolt: 'x' }, blend: 'add' })];
    const sheet: VfxSpriteSheet = { texture: Texture.WHITE, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: 1, frameRate: 0 };
    const inst = {
      id: 'inst', emitters: ems, time: 0, effect: { bolts: [] }, beams: [],
      space: {
        kind: 'field', viewDir: [0, -0.7, 0.7], wuPerQ: 1, groundWorldAtScene: () => [0, 0, 0],
        toScene: (w: number[], o: { x: number; y: number }) => { o.x = w[0]; o.y = w[2]; },
        toQ: (w: number[], o: number[]) => { o[0] = w[0]; o[1] = w[1]; o[2] = w[2]; },
      },
    } as unknown as VfxInstanceSim;
    const sheets = new Map(ems.map((e) => [`inst/${e.def.id}`, sheet] as const));
    r.render([inst], sheets);
    const views = (r as unknown as { views: Map<string, { shader: Shader; lit: boolean }> }).views;
    expect(views.get('inst/lit')!.lit && views.get('inst/plate')!.lit).toBe(true);

    // 每个视图的 shader 挂一张写了一只图元的网格(渲染器自己的分桶网格要真粒子池,这里直接用同一个 shader)
    const root = new Container();
    const quad = {
      x0: 10, y0: 10, x1: 20, y1: 10, x2: 20, y2: 20, x3: 10, y3: 20, u0: 0, v0: 0, u1: 1, v1: 1, mirror: false,
      r: 1, g: 1, b: 1, a: 1, qx: 0, qy: 0, qz: 0.5, softQ: 0,
    };
    const lit = new VfxBatchMesh(1, views.get('inst/lit')!.shader);
    const unlit = new VfxBatchMesh(1, views.get('inst/unlit')!.shader);
    for (const m of [lit, unlit]) { m.begin(); m.push(quad); m.end(); root.addChild(m.mesh); }
    const plate = new VfxPlateBatchMesh(1, 2, views.get('inst/plate')!.shader);
    plate.begin(); plate.push(createPlateStrip(2)); plate.end(); root.addChild(plate.mesh);
    const bolt = new VfxBoltBatchMesh(4, views.get('inst/bolt')!.shader);
    bolt.begin();
    bolt.push([10, 20, 20, 10], [10, 10, 20, 20], 12, 12, 18, 18, 2, 1, 1, 1, 1, 1, new Array(12).fill(0.5));
    bolt.end();
    root.addChild(bolt.mesh);
    const rt = RenderTexture.create({ width: 64, height: 64, label: 'vfxTarget' });

    const frame = () => {
      seen.length = 0;
      const log0 = rhi.log.length;
      renderer.render({ container: root, target: rt });
      const log = rhi.log.slice(log0);
      expect(log.filter((l) => l.startsWith('skip draw'))).toEqual([]);
      expect(log.filter((l) => l.startsWith('drawIndexed')).length).toBe(4);
      const fg = seen.filter((b) => 'uFgCoverage' in b);
      expect(fg.length).toBe(4);
      return fg.map((b) => (b.uFgCoverage as { label: string }).label);
    };

    // 1) 没有前景层:四个程序都绑占位
    const empty = frame();
    expect(new Set(empty).size).toBe(1);
    expect(empty[0]).not.toBe('fgCoverage');

    // 2) 交来覆盖图:当场换绑,下一帧四个程序都绑它
    const cov = RenderTexture.create({ width: 16, height: 16, format: 'rgba16float', label: 'fgCoverage' });
    r.setForegroundCoverage(cov.source);
    expect(frame()).toEqual(['fgCoverage', 'fgCoverage', 'fgCoverage', 'fgCoverage']);

    // 3) 收回 → 销毁 RT(前景层的拆除顺序):照画,绑回占位
    r.setForegroundCoverage(null);
    cov.destroy(true);
    expect(frame()).toEqual(empty);

    // 反例钉住守门的灵敏度:不收回就销毁,下一帧绑到已销毁的覆盖图、当场报
    const cov2 = RenderTexture.create({ width: 16, height: 16, format: 'rgba16float', label: 'fgCoverage2' });
    r.setForegroundCoverage(cov2.source);
    frame();
    cov2.destroy(true);
    expect(() => renderer.render({ container: root, target: rt })).toThrow(/已销毁/);
    r.setForegroundCoverage(null);

    r.clear();
    renderer.destroy();
  });
});
