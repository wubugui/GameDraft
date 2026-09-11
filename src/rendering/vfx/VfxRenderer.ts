/**
 * 世界空间粒子的渲染侧：把模拟池（M-world）投成画面 quad，按**接地锚**在场上实体之间分桶，
 * 一桶一张 `VfxBatchMesh` 挂进 entityLayer。
 *
 * ## 前后关系怎么定
 *
 * 实体层的排序规则只认脚底 y（`entitySortRule`）。粒子的"脚"= 它正下方的地面点投到画面的 y
 * （轨迹 `sortY` 同一约定）。把场上没标静态档位的实体脚点 y 排好序作阈值，粒子按脚 y 落进哪个
 * 区间就进哪个桶，桶网格的 `entitySortFootY` 取该区间上界减 ε —— 排在下一个实体后面、上一个实体前面。
 * 桶数 = 实体数 + 1，上限 `MAX_BUCKETS`（多了按分位数合并）。
 *
 * ## 尺寸与透视
 *
 * 粒子世界尺寸 wu → 画面 wu 同尺；透视缩放场景按**脚点**过 `perspective`，与实体同一规则。
 * 沿速度拉伸：把速度投到画面，quad 长轴对齐它。
 *
 * 渲染侧不写模拟状态（只读池），不 import 任何系统。
 */
import { Container, type GlProgram, Shader, type Texture, type TextureSource, UniformGroup } from 'pixi.js';

import type { SceneDepthConfig, VfxCurve } from '../../data/types';
import type { Vec3 } from '../../utils/sceneSpace';
import type { VfxEmitterRuntime, VfxInstanceSim } from '../../systems/vfx/vfxSim';
import { VfxParticleMode } from '../../systems/vfx/vfxSim';
import type { VfxSpace } from '../../systems/vfx/vfxSpace';
import { VfxBatchMesh, type VfxQuad } from './VfxBatchMesh';
import { getVfxLitProgram, getVfxUnlitProgram } from './vfxShaders';

export const MAX_BUCKETS = 8;

/** 一个发射器的贴图：图集 + 帧 uv 表 + 长宽比 */
export interface VfxSpriteSheet {
  texture: Texture;
  frames: { u0: number; v0: number; u1: number; v1: number }[];
  /** 帧高 / 帧宽 */
  aspect: number;
  /** 动画包自带帧率（fx anim.json）；单张图 0 */
  frameRate: number;
  /** 静止帧（群体栖息时用；外观 `restState` 的第一帧） */
  restFrame?: { u0: number; v0: number; u1: number; v1: number };
}

export interface VfxRenderDeps {
  entityLayer: Container;
  /** 有照明载荷时给 lit shader；无则 null → 走 unlit */
  createLitShader: (program: GlProgram, colorTex: TextureSource, extra: Record<string, unknown>) => Shader | null;
  releaseLitShader: (sh: Shader) => void;
  /** 深度纹理与配置（遮挡）；无深度的场景 null */
  getDepth: () => { tex: Texture; cfg: SceneDepthConfig } | null;
  getSceneSize: () => { w: number; h: number };
  /** 透视缩放：按脚点。没配的场景恒 1 */
  perspective: (footX: number, footY: number) => number;
}

interface EmitterView {
  key: string;
  emitter: VfxEmitterRuntime;
  sheet: VfxSpriteSheet;
  shader: Shader;
  lit: boolean;
  buckets: Map<number, VfxBatchMesh>;
  depthGroup: UniformGroup;
}

const tmpScene = { x: 0, y: 0 };
const tmpScene2 = { x: 0, y: 0 };
const tmpW: Vec3 = [0, 0, 0];
const tmpQ: Vec3 = [0, 0, 0];
const quad: VfxQuad = {
  x0: 0, y0: 0, x1: 0, y1: 0, x2: 0, y2: 0, x3: 0, y3: 0,
  u0: 0, v0: 0, u1: 1, v1: 1, mirror: false,
  r: 1, g: 1, b: 1, a: 1, qx: 0, qy: 0, qz: 0, softQ: 0,
};

export function sampleCurve(c: VfxCurve | undefined, t: number): number {
  if (!c || c.length === 0) return 1;
  if (t <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const [t0, v0] = c[i - 1];
      const [t1, v1] = c[i];
      const k = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return v0 + (v1 - v0) * k;
    }
  }
  return c[c.length - 1][1];
}

/**
 * 受光 shader 的两个外观参数（`vfxParams` 组）。抽成纯函数是为了能在没有 Pixi 上下文的
 * 情况下把接线钉住——这两个值错了画面只是"看起来不对"，不会报任何错。
 *
 * - `uSphere`：法线球化程度。加法混合的东西（火星、萤火）没有实体，球化只会让它边缘变暗，故 0。
 * - `uEmissive`：镜面 / 自发光份额，见 `VfxAppearanceDef.emissive`。夹到 0..1；
 *   `lit:false` 时整条走无光 shader，这组根本不存在，所以这里不必特判。
 */
export function vfxParamValues(ap: { blend?: string; emissive?: number }): { uSphere: number; uEmissive: number } {
  const e = ap.emissive;
  return {
    uSphere: ap.blend === 'add' ? 0 : 0.6,
    // NaN 要当 0：NaN uniform 会顺着 mix 传遍整个片元，结果是整批粒子消失，且 GL 不报错。
    uEmissive: typeof e === 'number' && Number.isFinite(e) ? Math.max(0, Math.min(1, e)) : 0,
  };
}

export class VfxRenderer {
  private readonly views = new Map<string, EmitterView>();
  private readonly thresholds: number[] = [];

  constructor(private readonly deps: VfxRenderDeps) {}

  /** 一个发射器实例的视图（首帧建）。`sheet` 由系统按外观定义装好。 */
  private ensureView(instanceId: string, e: VfxEmitterRuntime, sheet: VfxSpriteSheet): EmitterView {
    const key = `${instanceId}/${e.def.id}`;
    let v = this.views.get(key);
    if (v) return v;
    const ap = e.def.appearance;
    const depthGroup = new UniformGroup({
      uSceneSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
      uHasDepth: { value: 0, type: 'f32' },
      uInvert: { value: 0, type: 'f32' },
      uScale: { value: 1, type: 'f32' },
      uOffset: { value: 0, type: 'f32' },
      uTolerance: { value: 0.05, type: 'f32' },
      uOcclusionBlend: { value: 0, type: 'f32' },
    });
    const depth = this.deps.getDepth();
    const depthTex = depth?.tex.source ?? sheet.texture.source;
    const wantLit = ap.lit !== false;
    let shader: Shader | null = null;
    let lit = false;
    if (wantLit) {
      shader = this.deps.createLitShader(getVfxLitProgram(), sheet.texture.source, {
        vfxDepth: depthGroup,
        uDepthMap: depthTex,
        vfxParams: new UniformGroup((() => {
          const v = vfxParamValues(ap);
          return {
            uSphere: { value: v.uSphere, type: 'f32' as const },
            uEmissive: { value: v.uEmissive, type: 'f32' as const },
          };
        })()),
      });
      lit = !!shader;
    }
    if (!shader) {
      shader = new Shader({
        glProgram: getVfxUnlitProgram(),
        resources: { uColorTex: sheet.texture.source, vfxDepth: depthGroup, uDepthMap: depthTex },
      });
    }
    v = { key, emitter: e, sheet, shader, lit, buckets: new Map(), depthGroup };
    this.views.set(key, v);
    return v;
  }

  private bucketMesh(v: EmitterView, bucket: number): VfxBatchMesh {
    let m = v.buckets.get(bucket);
    if (m) return m;
    m = new VfxBatchMesh(v.emitter.p.cap, v.shader);
    m.mesh.blendMode = v.emitter.def.appearance.blend === 'add' ? 'add' : 'normal';
    m.mesh.cullable = false;
    this.deps.entityLayer.addChild(m.mesh);
    v.buckets.set(bucket, m);
    return m;
  }

  /** 每帧：从实体层读脚点阈值 */
  private refreshThresholds(): void {
    const th = this.thresholds;
    th.length = 0;
    const own = new Set<Container>();
    for (const v of this.views.values()) for (const m of v.buckets.values()) own.add(m.mesh);
    for (const child of this.deps.entityLayer.children) {
      if (own.has(child)) continue;
      const ext = child as Container & { entitySortBand?: string; entitySortFootY?: number };
      if (ext.entitySortBand) continue;
      if (!child.visible) continue;
      th.push(ext.entitySortFootY ?? child.y);
    }
    th.sort((a, b) => a - b);
    // 去重 + 合并到上限
    let w = 0;
    for (let i = 0; i < th.length; i++) if (i === 0 || th[i] !== th[i - 1]) th[w++] = th[i];
    th.length = w;
    if (th.length > MAX_BUCKETS - 1) {
      const keep = MAX_BUCKETS - 1;
      const out: number[] = [];
      for (let i = 0; i < keep; i++) out.push(th[Math.floor(((i + 1) * th.length) / (keep + 1))]);
      th.length = 0;
      th.push(...out);
    }
  }

  private bucketOf(footY: number): number {
    const th = this.thresholds;
    let i = 0;
    while (i < th.length && footY >= th[i]) i++;
    return i;
  }

  private bucketFootY(bucket: number): number {
    const th = this.thresholds;
    if (th.length === 0) return 0;
    if (bucket < th.length) return th[bucket] - 1e-3;
    return th[th.length - 1] + 1e-3;
  }

  /**
   * 渲染一批实例。`sheets` 按 `<instanceId>/<emitterId>` 给贴图；没贴图的发射器跳过。
   */
  render(instances: readonly VfxInstanceSim[], sheets: ReadonlyMap<string, VfxSpriteSheet>): void {
    this.refreshThresholds();
    const depth = this.deps.getDepth();
    const size = this.deps.getSceneSize();
    const seen = new Set<string>();
    for (const inst of instances) {
      const space = inst.space;
      for (const e of inst.emitters) {
        const key = `${inst.id}/${e.def.id}`;
        const sheet = sheets.get(key);
        if (!sheet) continue;
        seen.add(key);
        const v = this.ensureView(inst.id, e, sheet);
        // 深度参数逐帧同步（换场景时纹理由系统重建视图，这里只刷数字）
        const du = v.depthGroup.uniforms as Record<string, unknown>;
        (du['uSceneSize'] as Float32Array).set([size.w, size.h]);
        if (depth && space.kind === 'field') {
          du['uHasDepth'] = 1;
          du['uInvert'] = depth.cfg.depth_mapping.invert ? 1 : 0;
          du['uScale'] = depth.cfg.depth_mapping.scale;
          du['uOffset'] = depth.cfg.depth_mapping.offset;
          du['uTolerance'] = depth.cfg.depth_tolerance;
        } else {
          du['uHasDepth'] = 0;
        }
        v.depthGroup.update();
        for (const m of v.buckets.values()) m.begin();
        this.fill(v, inst, e, space);
        for (const [b, m] of v.buckets) {
          m.end();
          (m.mesh as Container & { entitySortFootY?: number }).entitySortFootY = this.bucketFootY(b);
        }
      }
    }
    // 不在本帧清单里的视图（实例被收掉）→ 销毁
    for (const [key, v] of this.views) {
      if (seen.has(key)) continue;
      this.destroyView(v);
      this.views.delete(key);
    }
  }

  private fill(v: EmitterView, inst: VfxInstanceSim, e: VfxEmitterRuntime, space: VfxSpace): void {
    const p = e.p;
    const ap = e.def.appearance;
    const sheet = v.sheet;
    const nFrames = sheet.frames.length;
    const tint = ap.tint ?? [1, 1, 1];
    const fps = typeof ap.frameRate === 'number' ? ap.frameRate : sheet.frameRate;
    const stretch = ap.stretchByVelocity ?? 0;
    const soft = ap.softEdgeWu ?? 0;
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      tmpW[0] = p.x[i]; tmpW[1] = p.y[i]; tmpW[2] = p.z[i];
      space.toScene(tmpW, tmpScene);
      const sx = tmpScene.x, sy = tmpScene.y;
      // 脚点 = 正下方地面点
      tmpW[1] = space.groundY(p.x[i], p.z[i]);
      space.toScene(tmpW, tmpScene2);
      const footY = tmpScene2.y;
      const persp = this.deps.perspective(tmpScene2.x, footY);
      const t = p.life[i] > 0 ? Math.min(1, p.age[i] / p.life[i]) : 0;
      const alpha = sampleCurve(ap.alphaOverLife, t);
      if (alpha <= 0.002) continue;
      const w = p.size[i] * sampleCurve(ap.sizeOverLife, t) * persp;
      let h = w * sheet.aspect;
      // 朝向 / 旋转
      let rot = p.rot[i];
      let mirror = false;
      if (ap.faceVelocity) mirror = p.vx[i] < 0;
      if (stretch > 0) {
        tmpW[0] = p.x[i] + p.vx[i]; tmpW[1] = p.y[i] + p.vy[i]; tmpW[2] = p.z[i] + p.vz[i];
        space.toScene(tmpW, tmpScene2);
        const dx = tmpScene2.x - sx, dy = tmpScene2.y - sy;
        const len = Math.hypot(dx, dy);
        if (len > 1e-3) {
          rot = Math.atan2(dy, dx) + Math.PI / 2;   // 贴图竖直方向对齐速度
          h = Math.max(h, len * stretch * persp);
        }
      }
      const hw = w / 2, hh = h / 2;
      const c = Math.cos(rot), s = Math.sin(rot);
      // 四角（TL TR BR BL），y 向下
      quad.x0 = sx + (-hw * c - (-hh) * s); quad.y0 = sy + (-hw * s + (-hh) * c);
      quad.x1 = sx + (hw * c - (-hh) * s);  quad.y1 = sy + (hw * s + (-hh) * c);
      quad.x2 = sx + (hw * c - hh * s);     quad.y2 = sy + (hw * s + hh * c);
      quad.x3 = sx + (-hw * c - hh * s);    quad.y3 = sy + (-hw * s + hh * c);
      // 帧
      let fi = 0;
      if (nFrames > 1) {
        const ph = e.def.behavior ? p.phase[i] : p.age[i] * fps + p.seed[i] * nFrames;
        fi = ((Math.floor(ph) % nFrames) + nFrames) % nFrames;
      }
      const f = sheet.frames[fi];
      quad.u0 = f.u0; quad.v0 = f.v0; quad.u1 = f.u1; quad.v1 = f.v1;
      quad.mirror = mirror;
      quad.r = tint[0]; quad.g = tint[1]; quad.b = tint[2]; quad.a = alpha;
      // q（遮挡 / 照明）
      tmpW[0] = p.x[i]; tmpW[1] = p.y[i]; tmpW[2] = p.z[i];
      space.toQ(tmpW, tmpQ);
      quad.qx = tmpQ[0]; quad.qy = tmpQ[1]; quad.qz = tmpQ[2];
      quad.softQ = soft > 0 ? soft / Math.max(space.wuPerQ, 1e-6) : 0;
      // 巢里挂着的个体：用静止帧（外观 restState），没配就停在第一帧
      if (p.mode[i] === VfxParticleMode.Roosting) {
        const hf = sheet.restFrame ?? sheet.frames[0];
        quad.u0 = hf.u0; quad.v0 = hf.v0; quad.u1 = hf.u1; quad.v1 = hf.v1;
      }
      const bucket = this.bucketOf(footY);
      this.bucketMesh(v, bucket).push(quad);
    }
  }

  private destroyView(v: EmitterView): void {
    for (const m of v.buckets.values()) m.destroy();
    v.buckets.clear();
    if (v.lit) this.deps.releaseLitShader(v.shader);
    else v.shader.destroy();
  }

  /** 切场景 / 系统销毁：整批清掉（先于纹理销毁） */
  clear(): void {
    for (const v of this.views.values()) this.destroyView(v);
    this.views.clear();
  }

  get viewCount(): number { return this.views.size; }

  get drawCallCount(): number {
    let n = 0;
    for (const v of this.views.values()) for (const m of v.buckets.values()) if (m.used > 0) n++;
    return n;
  }
}

