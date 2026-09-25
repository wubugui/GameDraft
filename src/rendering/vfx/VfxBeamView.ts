/**
 * 一根光柱在画面上的那一张网格：包络多边形（3D = 两圈截面顶点投到画面的凸包；2D = 梯形四角）扇形三角化，
 * 片元里跑 `vfxBeamGlsl.ts` 的核心。一根光柱一个 draw call。
 *
 * 排序：`sort: depth` 时网格的 `entitySortFootY` = 光柱落点的画面 y（与实体脚点同一把尺，整根参与实体排序）；
 * `background` / `foreground` 打 `entitySortBand`（与热点展示图 / 气泡同一个档位字段）。
 *
 * 资源有主：网格 / 几何 / 着色器 / uniform 组都归本视图，`destroy` 一并收（深度图、图案贴图归系统，不收）。
 */
import { Buffer, BufferUsage, Geometry, Mesh, Shader, Texture, type TextureSource, UniformGroup } from '../../engine2d';

import type { VfxBeamSort } from '../../data/types';
import { VFX_BEAM_MAX_CURVE_KEYS, VFX_BEAM_MAX_HULL, VFX_BEAM_MAX_PLANES } from '../../systems/vfx/vfxBeam';
import type { VfxBeamRuntime } from '../../systems/vfx/vfxSim';
import { samplerOf } from '../legacy/gpuSampler';
import { createBeamUniformValues, type VfxBeamUniformValues } from './vfxBeamGlsl';
import { getVfxBeamGpuProgram, getVfxBeamProgram } from './vfxBeamShaders';

type SortableMesh = Mesh<Geometry, Shader> & { entitySortFootY?: number; entitySortBand?: 'back' | 'front' };

/** 标量 uniform（每帧从数值表抄进组里；数组是同一块 Float32Array，原地改） */
const SCALAR_KEYS = [
  'uBeamMode', 'uBeamPlaneCount', 'uBeamLength', 'uBeamGain', 'uBeamEdgeSoft', 'uBeamThickness',
  'uBeamContactSoft', 'uBeamWuPerQ', 'uBeamBlend', 'uBeamAlongCount', 'uBeamTime', 'uBeamCookieOn',
  'uBeamCookieStrength',
] as const;

export class VfxBeamView {
  readonly mesh: SortableMesh;
  readonly values: VfxBeamUniformValues = createBeamUniformValues();
  readonly depthGroup: UniformGroup;
  private readonly beamGroup: UniformGroup;
  private readonly shader: Shader;
  private readonly posData = new Float32Array(VFX_BEAM_MAX_HULL * 2);
  private readonly idxData = new Uint32Array((VFX_BEAM_MAX_HULL - 2) * 3);
  private readonly posBuf: Buffer;
  private readonly idxBuf: Buffer;
  private lastCount = -1;

  constructor(
    readonly key: string,
    /** 建视图时的光柱运行态（模拟重建 = 换了一个对象 ⇒ 视图重建） */
    readonly beam: VfxBeamRuntime,
    readonly depthSrc: TextureSource | null,
    readonly cookieSrc: TextureSource | null,
    displayUniforms: UniformGroup,
  ) {
    const v = this.values;
    // ⚠ 声明顺序 = WebGPU 缓冲布局（Pixi 按声明顺序、WGSL 对齐规则排偏移），与 vfxBeamWgsl.ts 的结构逐项对应。
    // uBeamAlong 紧跟 uBeamPlanes：WGSL 里它是同一块内存的 array<vec4<f32>, N/2>（uniform 数组步长须 16 的倍数），
    // 偏移必须落在 16 的倍数上。WebGL 侧按名字逐个传 uniform，声明顺序不影响画面。
    this.beamGroup = new UniformGroup({
      uBeamMode: { value: 0, type: 'f32' },
      uBeamS2W0: { value: v.uBeamS2W0, type: 'vec4<f32>' },
      uBeamS2W1: { value: v.uBeamS2W1, type: 'vec4<f32>' },
      uBeamS2W2: { value: v.uBeamS2W2, type: 'vec4<f32>' },
      uBeamPlanes: { value: v.uBeamPlanes, type: 'vec4<f32>', size: VFX_BEAM_MAX_PLANES },
      uBeamAlong: { value: v.uBeamAlong, type: 'vec2<f32>', size: VFX_BEAM_MAX_CURVE_KEYS },
      uBeamPlaneCount: { value: 0, type: 'i32' },
      uBeamOrigin: { value: v.uBeamOrigin, type: 'vec3<f32>' },
      uBeamAxis: { value: v.uBeamAxis, type: 'vec3<f32>' },
      uBeamRight: { value: v.uBeamRight, type: 'vec3<f32>' },
      uBeamUp: { value: v.uBeamUp, type: 'vec3<f32>' },
      uBeamLength: { value: 1, type: 'f32' },
      uBeamSec: { value: v.uBeamSec, type: 'vec4<f32>' },
      uBeamTan: { value: v.uBeamTan, type: 'vec3<f32>' },
      uBeam2O: { value: v.uBeam2O, type: 'vec2<f32>' },
      uBeam2D: { value: v.uBeam2D, type: 'vec4<f32>' },
      uBeam2W: { value: v.uBeam2W, type: 'vec3<f32>' },
      uBeamPlaneQ: { value: v.uBeamPlaneQ, type: 'vec4<f32>' },
      uBeamColor0: { value: v.uBeamColor0, type: 'vec3<f32>' },
      uBeamColor1: { value: v.uBeamColor1, type: 'vec3<f32>' },
      uBeamGain: { value: 0, type: 'f32' },
      uBeamEdgeSoft: { value: 0, type: 'f32' },
      uBeamThickness: { value: 0, type: 'f32' },
      uBeamContactSoft: { value: 0, type: 'f32' },
      uBeamWuPerQ: { value: 1, type: 'f32' },
      uBeamBlend: { value: 0, type: 'i32' },
      uBeamAlongCount: { value: 0, type: 'i32' },
      uBeamNoise: { value: v.uBeamNoise, type: 'vec4<f32>' },
      uBeamNoiseVel: { value: v.uBeamNoiseVel, type: 'vec3<f32>' },
      uBeamTime: { value: 0, type: 'f32' },
      uBeamCookieOn: { value: 0, type: 'f32' },
      uBeamCookieXf: { value: v.uBeamCookieXf, type: 'vec4<f32>' },
      uBeamCookieRot: { value: v.uBeamCookieRot, type: 'vec2<f32>' },
      uBeamCookieStrength: { value: 0, type: 'f32' },
    });
    this.depthGroup = new UniformGroup({
      uSceneSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uHasDepth: { value: 0, type: 'f32' },
      uInvert: { value: 0, type: 'f32' },
      uScale: { value: 1, type: 'f32' },
      uOffset: { value: 0, type: 'f32' },
      uTolerance: { value: 0.05, type: 'f32' },
    });
    const depthTex = depthSrc ?? Texture.WHITE.source;
    const cookieTex = cookieSrc ?? Texture.WHITE.source;
    this.shader = new Shader({
      glProgram: getVfxBeamProgram(),
      // WebGPU 路径的 WGSL 孪生：资源键与下面逐个同名；「纹理名 + Sampler」是 WGSL 的采样器（samplerOf：按参数共享、
      // 不挂在纹理生命期上，见 legacy/gpuSampler；WebGL 不认这些键）
      gpuProgram: getVfxBeamGpuProgram(),
      resources: {
        vfxBeam: this.beamGroup,
        vfxDepth: this.depthGroup,
        uDepthMap: depthTex,
        uDepthMapSampler: samplerOf(depthTex),
        uBeamCookie: cookieTex,
        uBeamCookieSampler: samplerOf(cookieTex),
        // 显示变换：与背景 / 角色 / 粒子同一组数（这组里其余的灯 uniform 本程序不声明，Pixi 按名跳过）
        charLights: displayUniforms,
      },
    });
    this.posBuf = new Buffer({ data: this.posData, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.idxBuf = new Buffer({ data: this.idxData, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
    const geometry = new Geometry({
      attributes: { aPosition: { buffer: this.posBuf, format: 'float32x2' } },
      indexBuffer: this.idxBuf,
    });
    this.mesh = new Mesh({ geometry, shader: this.shader }) as SortableMesh;
    this.mesh.position.set(0, 0);
    this.mesh.cullable = false;
  }

  /** 写包络（画面坐标 xy 连排、凸、逆时针或顺时针都行）；点数 < 3 ⇒ 不画 */
  setHull(pts: Float32Array, count: number): void {
    const n = Math.min(count, VFX_BEAM_MAX_HULL);
    this.posData.fill(0);
    this.posData.set(pts.subarray(0, n * 2));
    if (n !== this.lastCount) {
      this.idxData.fill(0);
      for (let i = 1; i + 1 < n; i++) {
        const o = (i - 1) * 3;
        this.idxData[o] = 0; this.idxData[o + 1] = i; this.idxData[o + 2] = i + 1;
      }
      this.idxBuf.update();
      this.lastCount = n;
    }
    this.posBuf.update();
  }

  /** 把数值表同步进 uniform 组（数组已原地写好，这里只抄标量） */
  syncUniforms(): void {
    const u = this.beamGroup.uniforms as Record<string, unknown>;
    const v = this.values as unknown as Record<string, unknown>;
    for (const k of SCALAR_KEYS) u[k] = v[k];
    this.beamGroup.update();
  }

  setSort(sort: VfxBeamSort, footY: number): void {
    const m = this.mesh;
    if (sort === 'depth') {
      delete m.entitySortBand;
      m.entitySortFootY = footY;
    } else {
      m.entitySortBand = sort === 'background' ? 'back' : 'front';
      m.entitySortFootY = footY;
    }
  }

  setBlend(blend: 'add' | 'screen' | 'normal'): void {
    if (this.mesh.blendMode !== blend) this.mesh.blendMode = blend;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    const g = this.mesh.geometry;
    this.mesh.destroy();
    g.destroy(true);
    this.shader.destroy();
  }
}
