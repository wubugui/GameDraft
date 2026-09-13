/**
 * 世界空间粒子的渲染侧：把模拟池（M-world）投成画面 quad，按与实体的**真实前后**分桶，
 * 一桶一张 `VfxBatchMesh` 挂进 entityLayer。
 *
 * ## 前后关系怎么定
 *
 * 实体层的画序只认脚底 y（`entitySortRule`）。实体在伪世界里是**立在脚点上的直立 quad**
 * （角色着色 / 遮挡同一个模型），"粒子在它前面" ⟺ 粒子沿**水平视线轴**（视线去掉竖直分量）
 * 比它的脚点近——与粒子离地多高无关。所以：场上没标静态档位的实体按脚点 y 排好（= 画序）作阈值，
 * 各自带上脚点的水平纵深；粒子排在"第一个比它近的实体"之前。桶网格的 `entitySortFootY` 取那个
 * 实体的脚点 y 减 ε。桶数 = 实体数 + 1，上限 `MAX_BUCKETS`（多了按分位数合并）。
 *
 * ⚠ 此前拿"粒子正下方地面点的画面 y"直接比脚点 y：在平地上与上面等价，但悬在更低地面上方的粒子
 *   （崖边的蝙蝠、檐口上的烟）正下方的地面点投到画面很靠下，会被整批错排到人前面。
 *
 * ## 着色三条路（逐视图定，条件变了就重建视图）
 *
 * - **lit**：有照明载荷——与角色同一套 probe + 同一次 packLights 的实体灯 + 同一组显示变换；
 * - **tone**：外观要受光、但本场景 / 本时段没有照明载荷——走 NPC 此时走的那一套
 *   （`EntityLightingFilter` 的色调融入：运行时从原画建的辐照 probe 做保亮度白平衡）；
 * - **unlit**：外观写了 `lit:false`（自发光的萤火、按原画标定 tint 的纸钱）。
 * 三条都过同一组显示变换（背景 / 角色 / 粒子一个曝光）。
 *
 * ## 尺寸与透视
 *
 * 粒子世界尺寸 wu → 画面 wu 同尺；透视缩放场景按**脚点**过 `perspective`，与实体同一规则。
 * 沿速度拉伸：把速度投到画面，quad 长轴对齐它。
 *
 * 渲染侧不写模拟状态（只读池），不 import 任何系统。
 */
import { Container, type GlProgram, Shader, Texture, type TextureSource, UniformGroup } from 'pixi.js';

import type { SceneDepthConfig, VfxCurve } from '../../data/types';
import type { Vec3 } from '../../utils/sceneSpace';
import type { VfxEmitterRuntime, VfxInstanceSim } from '../../systems/vfx/vfxSim';
import { VfxParticleMode } from '../../systems/vfx/vfxSim';
import { PlateContact } from '../../systems/vfx/vfxPlate';
import type { VfxSpace } from '../../systems/vfx/vfxSpace';
import { VfxBatchMesh, type VfxQuad } from './VfxBatchMesh';
import { VfxPlateBatchMesh, createPlateStrip, type VfxPlateStrip } from './VfxPlateBatchMesh';
import { getVfxLitProgram, getVfxPlateLitProgram, getVfxUnlitProgram } from './vfxShaders';

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

/** 没有照明载荷时 NPC 吃的色调融入（`EntityLightingFilter` 同一套数） */
export interface VfxToneEnv {
  /** 运行时从原画建的辐照 probe（场景坐标归一化 uv） */
  probe: TextureSource;
  /** 色调融入强度（场景关了色调融入时 0） */
  strength: number;
  key: { color: readonly number[]; intensity: number };
  ambient: { color: readonly number[]; intensity: number };
}

export interface VfxRenderDeps {
  entityLayer: Container;
  /** 有照明载荷时给 lit shader；无则 null → 走 tone / unlit */
  createLitShader: (program: GlProgram, colorTex: TextureSource, extra: Record<string, unknown>) => Shader | null;
  releaseLitShader: (sh: Shader) => void;
  /**
   * 此刻建不建得出 lit shader（与 `createLitShader` 同一条判据）。视图建好后照明载荷才到、
   * 或着色被关掉时据此重建视图——否则进场那一拍定下的着色路一直用到换场景。
   */
  canLight: () => boolean;
  /** 显示变换那组 uniform（背景 / 角色 / 粒子同一组数）；无光路径也要过它 */
  displayUniforms: UniformGroup;
  /** 本场景没有照明载荷时 NPC 走的色调融入；场景没建 probe 就 null */
  getToneEnv: () => VfxToneEnv | null;
  /** 深度纹理与配置（遮挡）；无深度的场景 null */
  getDepth: () => { tex: Texture; cfg: SceneDepthConfig } | null;
  getSceneSize: () => { w: number; h: number };
  /** 透视缩放：按脚点。没配的场景恒 1 */
  perspective: (footX: number, footY: number) => number;
  /**
   * 背景草木在场景点的正向位移（场景 wu）：躺在草木 / 被拖动的地面上的纸钱跟着自己底下那片走，
   * 否则竹子在纸底下滑。不注入或该点不摆 ⇒ false。
   */
  swayAt?: (sceneX: number, sceneY: number, worldX: number, worldZ: number, out: { x: number; y: number }) => boolean;
  /**
   * 画布尺寸（像素）。给**视口剔除**用：常驻效果会把几百颗粒子铺满整张场景图，
   * 一屏只看得见其中一部分，屏外的没必要逐顶点投影。给不出 ⇒ 不剔除（照旧全填）。
   */
  getScreen?: () => { w: number; h: number };
}

/** 视口剔除的外扩（场景 wu）：粒子中心在框外这么多以内仍然填，免得大粒子在边缘闪 */
const CULL_MARGIN_WU = 96;

interface EmitterView {
  key: string;
  emitter: VfxEmitterRuntime;
  sheet: VfxSpriteSheet;
  shader: Shader;
  lit: boolean;
  /** 外观要受光（`appearance.lit !== false`） */
  wantLit: boolean;
  /** 建视图时绑进去的深度纹理（null = 当时没有）；换了就重建 */
  depthSrc: TextureSource | null;
  /** tone 路绑进去的辐照 probe（非 tone 路恒 null）；换了就重建 */
  toneSrc: TextureSource | null;
  buckets: Map<number, VfxBatchMesh>;
  /** 薄片发射器用这组（带逐顶点法线的条带网格）；billboard 发射器恒空 */
  plateBuckets: Map<number, VfxPlateBatchMesh>;
  /** 薄片：本视图复用的一条顶点暂存 */
  plateStrip: VfxPlateStrip | null;
  depthGroup: UniformGroup;
}

/** 参与排序的一个实体：画面脚点 y（画序键）+ 脚点沿水平视线轴的纵深 */
export interface VfxSortAnchor {
  footY: number;
  depthKey: number;
}

/**
 * 水平视线轴（M-world，只取 x / z 分量）：视线去掉竖直分量。实体是立在脚点上的直立 quad，
 * "在它前面" ⟺ 沿这根轴更近——与离地多高无关。正俯视（视线竖直）时退化，取 +z。
 */
export function horizontalViewAxis(viewDir: readonly number[]): [number, number] {
  const x = viewDir[0], z = viewDir[2];
  const l = Math.hypot(x, z);
  return l > 1e-6 ? [x / l, z / l] : [0, 1];
}

/** 分桶阈值：实体按脚点 y 升序（= 实体层画序），同一脚点只留一个，超上限按分位数合并。 */
export function buildSortThresholds(anchors: readonly VfxSortAnchor[], maxBuckets = MAX_BUCKETS): VfxSortAnchor[] {
  const th = anchors.slice().sort((a, b) => a.footY - b.footY);
  let w = 0;
  for (let i = 0; i < th.length; i++) if (w === 0 || th[i].footY !== th[w - 1].footY) th[w++] = th[i];
  th.length = w;
  if (th.length <= maxBuckets - 1) return th;
  const keep = maxBuckets - 1;
  const out: VfxSortAnchor[] = [];
  for (let i = 0; i < keep; i++) out.push(th[Math.floor(((i + 1) * th.length) / (keep + 1))]);
  return out;
}

/**
 * 粒子落第几桶：排在画序里**第一个比它近的实体**之前（沿水平视线轴纵深更小 = 更近）。
 * 纵深相等算在它前面（与旧的 `>=` 脚点判据同向）。
 */
export function bucketOfDepth(th: readonly VfxSortAnchor[], depthKey: number): number {
  let i = 0;
  while (i < th.length && th[i].depthKey >= depthKey) i++;
  return i;
}

/** 桶网格的 `entitySortFootY`：上界实体脚点 −ε（排在它后面、上一个实体前面） */
export function bucketSortFootY(th: readonly VfxSortAnchor[], bucket: number): number {
  if (th.length === 0) return 0;
  if (bucket < th.length) return th[bucket].footY - 1e-3;
  return th[th.length - 1].footY + 1e-3;
}

/**
 * 无光路径下薄片的受光：均匀阴天天穹下的朗伯平板，辐照度 ∝ (1 + n·up)/2 + ρ_地·(1 − n·up)/2，
 * 按"平躺朝上 = 1"归一（`tint` 就是平躺时的颜色，拿画里那几张纸钱标定）。这是解出来的，不是调出来的。
 * 有照明载荷时整条走受光 shader（probe + 实体灯），这里不用。
 */
const PLATE_GROUND_ALBEDO = 0.25;
/** 躺着 / 贴死的纸被风掀动边角：风速到这个数（wu/s）掀到最大 */
const PLATE_FLUTTER_SATURATE = 220;
/** 边角颤动幅度（弯曲单位） */
const PLATE_FLUTTER_AMP = 0.28;
/** 贴死的纸在满风时被掀起的静弯曲（弯曲单位） */
const PLATE_PINNED_LIFT = 0.45;

const tmpA: Vec3 = [0, 0, 0];
const swayOut = { x: 0, y: 0 };
const affS = new Float64Array(8);
const affQ = new Float64Array(12);

/** 正交投影是仿射的：拿四个点探出 M-world → 场景 / q 的系数（逐顶点投影不再分配对象） */
function probeAffine(space: VfxSpace): void {
  const s = { x: 0, y: 0 };
  const q: Vec3 = [0, 0, 0];
  tmpA[0] = 0; tmpA[1] = 0; tmpA[2] = 0;
  space.toScene(tmpA, s); const sx0 = s.x, sy0 = s.y;
  space.toQ(tmpA, q); const q0 = q[0], q1 = q[1], q2 = q[2];
  for (let a = 0; a < 3; a++) {
    tmpA[0] = a === 0 ? 1 : 0; tmpA[1] = a === 1 ? 1 : 0; tmpA[2] = a === 2 ? 1 : 0;
    space.toScene(tmpA, s);
    affS[a] = s.x - sx0; affS[3 + a] = s.y - sy0;
    space.toQ(tmpA, q);
    affQ[a] = q[0] - q0; affQ[3 + a] = q[1] - q1; affQ[6 + a] = q[2] - q2;
  }
  affS[6] = sx0; affS[7] = sy0;
  affQ[9] = q0; affQ[10] = q1; affQ[11] = q2;
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
  /** 本帧可见的场景矩形（实体层局部坐标 = 场景 wu）；算不出 ⇒ null = 不剔除 */
  private cullX0 = 0;
  private cullY0 = 0;
  private cullX1 = 0;
  private cullY1 = 0;
  private culling = false;
  private thresholds: VfxSortAnchor[] = [];
  /** 水平视线轴（本帧，随空间） */
  private hx = 0;
  private hz = 1;
  /** tone 路的共享参数（逐帧从场景的光照环境同步，与 NPC 的 EntityLightingFilter 同一组数） */
  private readonly toneGroup = new UniformGroup({
    uToneStrength: { value: 0, type: 'f32' },
    uKeyColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uKeyIntensity: { value: 0, type: 'f32' },
    uAmbientColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uAmbientIntensity: { value: 1, type: 'f32' },
  });

  constructor(private readonly deps: VfxRenderDeps) {}

  /** 视图是按"当时有什么"建的；这几样一变就得重建，否则一路错到换场景。 */
  private viewStale(
    v: EmitterView, e: VfxEmitterRuntime, sheet: VfxSpriteSheet,
    canLight: boolean, toneSrc: TextureSource | null, depthSrc: TextureSource | null,
  ): boolean {
    if (v.emitter !== e || v.sheet !== sheet || v.depthSrc !== depthSrc) return true;
    if (!v.wantLit) return false;
    if (v.lit !== canLight) return true;
    return !v.lit && v.toneSrc !== toneSrc;
  }

  /** 一个发射器实例的视图（首帧建）。`sheet` 由系统按外观定义装好。 */
  private ensureView(
    instanceId: string, e: VfxEmitterRuntime, sheet: VfxSpriteSheet,
    canLight: boolean, tone: VfxToneEnv | null,
  ): EmitterView {
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
    const depthSrc = depth?.tex.source ?? null;
    const depthTex = depthSrc ?? sheet.texture.source;
    const wantLit = ap.lit !== false;
    const isPlate = !!e.plate;
    let shader: Shader | null = null;
    let lit = false;
    let toneSrc: TextureSource | null = null;
    if (wantLit && canLight) {
      // 薄片的受光程序声明了 aNrm，只能配薄片网格（见 VfxPlateBatchMesh 头注释）
      shader = this.deps.createLitShader(isPlate ? getVfxPlateLitProgram() : getVfxLitProgram(), sheet.texture.source, {
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
      // 要受光却没有照明载荷 → NPC 此时走的色调融入；lit:false 的不染（自发光 / 按原画标定的 tint）
      const toneOn = wantLit && !!tone;
      toneSrc = toneOn ? tone!.probe : null;
      shader = new Shader({
        glProgram: getVfxUnlitProgram(),
        resources: {
          uColorTex: sheet.texture.source, vfxDepth: depthGroup, uDepthMap: depthTex,
          // 显示变换：与背景 / 角色同一组数（这组里其余的灯 uniform 本程序不声明，Pixi 按名跳过）
          charLights: this.deps.displayUniforms,
          vfxTone: this.toneGroup,
          vfxToneOn: new UniformGroup({ uToneOn: { value: toneOn ? 1 : 0, type: 'f32' } }),
          uProbe: toneSrc ?? Texture.WHITE.source,
        },
      });
    }
    v = {
      key, emitter: e, sheet, shader, lit, wantLit, depthSrc, toneSrc,
      buckets: new Map(), plateBuckets: new Map(),
      plateStrip: e.plate ? createPlateStrip(e.plate.P.segments) : null, depthGroup,
    };
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

  private plateBucketMesh(v: EmitterView, bucket: number): VfxPlateBatchMesh {
    let m = v.plateBuckets.get(bucket);
    if (m) return m;
    m = new VfxPlateBatchMesh(v.emitter.p.cap, v.emitter.plate!.P.segments, v.shader);
    m.mesh.blendMode = v.emitter.def.appearance.blend === 'add' ? 'add' : 'normal';
    m.mesh.cullable = false;
    this.deps.entityLayer.addChild(m.mesh);
    v.plateBuckets.set(bucket, m);
    return m;
  }

  /**
   * 每帧：从实体层读排序阈值——脚点 y（画序）+ 脚点落到地面后沿水平视线轴的纵深。
   * 实体脚点的世界位置走 `groundWorldAtScene`（与脚步声 / 摆灯同一条换算）。
   */
  private refreshThresholds(space: VfxSpace): void {
    const [hx, hz] = horizontalViewAxis(space.viewDir);
    this.hx = hx; this.hz = hz;
    const own = new Set<Container>();
    for (const v of this.views.values()) {
      for (const m of v.buckets.values()) own.add(m.mesh);
      for (const m of v.plateBuckets.values()) own.add(m.mesh);
    }
    const anchors: VfxSortAnchor[] = [];
    for (const child of this.deps.entityLayer.children) {
      if (own.has(child)) continue;
      const ext = child as Container & { entitySortBand?: string; entitySortFootY?: number };
      if (ext.entitySortBand) continue;
      if (!child.visible) continue;
      const footY = ext.entitySortFootY ?? child.y;
      const g = space.groundWorldAtScene(child.x, footY);
      anchors.push({ footY, depthKey: g[0] * hx + g[2] * hz });
    }
    this.thresholds = buildSortThresholds(anchors);
  }

  /** 粒子（世界 x / z）落第几桶 */
  private bucketOf(wx: number, wz: number): number {
    return bucketOfDepth(this.thresholds, wx * this.hx + wz * this.hz);
  }

  /**
   * 渲染一批实例。`sheets` 按 `<instanceId>/<emitterId>` 给贴图；没贴图的发射器跳过。
   */
  render(instances: readonly VfxInstanceSim[], sheets: ReadonlyMap<string, VfxSpriteSheet>): void {
    if (instances.length > 0) this.refreshThresholds(instances[0].space);
    this.refreshCull();
    const depth = this.deps.getDepth();
    const depthSrc = depth?.tex.source ?? null;
    const size = this.deps.getSceneSize();
    const canLight = this.deps.canLight();
    const tone = this.deps.getToneEnv();
    this.syncTone(tone);
    const seen = new Set<string>();
    for (const inst of instances) {
      const space = inst.space;
      for (const e of inst.emitters) {
        const key = `${inst.id}/${e.def.id}`;
        const sheet = sheets.get(key);
        if (!sheet) continue;
        seen.add(key);
        const old = this.views.get(key);
        if (old && this.viewStale(old, e, sheet, canLight, tone?.probe ?? null, depthSrc)) {
          this.destroyView(old);
          this.views.delete(key);
        }
        const v = this.ensureView(inst.id, e, sheet, canLight, tone);
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
        for (const m of v.plateBuckets.values()) m.begin();
        if (e.plate) this.fillPlate(v, inst, e, space);
        else this.fill(v, inst, e, space);
        for (const [b, m] of v.buckets) {
          m.end();
          (m.mesh as Container & { entitySortFootY?: number }).entitySortFootY = bucketSortFootY(this.thresholds, b);
        }
        for (const [b, m] of v.plateBuckets) {
          m.end();
          (m.mesh as Container & { entitySortFootY?: number }).entitySortFootY = bucketSortFootY(this.thresholds, b);
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

  /**
   * 本帧的可见矩形：屏幕四角经实体层的世界变换逆变换回场景坐标，再外扩一圈。
   * 相机在动、缩放在变都自动跟上；拿不到画布尺寸就不剔除。
   */
  private refreshCull(): void {
    const scr = this.deps.getScreen?.();
    if (!scr || !(scr.w > 0) || !(scr.h > 0)) { this.culling = false; return; }
    const m = this.deps.entityLayer.worldTransform;
    const det = m.a * m.d - m.b * m.c;
    if (!(Math.abs(det) > 1e-12)) { this.culling = false; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const px = k === 0 || k === 3 ? 0 : scr.w;
      const py = k < 2 ? 0 : scr.h;
      const dx = px - m.tx, dy = py - m.ty;
      const sx = (dx * m.d - dy * m.c) / det;
      const sy = (dy * m.a - dx * m.b) / det;
      if (sx < x0) x0 = sx;
      if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy;
      if (sy > y1) y1 = sy;
    }
    this.cullX0 = x0 - CULL_MARGIN_WU;
    this.cullY0 = y0 - CULL_MARGIN_WU;
    this.cullX1 = x1 + CULL_MARGIN_WU;
    this.cullY1 = y1 + CULL_MARGIN_WU;
    this.culling = true;
  }

  /** 这一颗的画面位置在视口外 ⇒ 本帧不填它的顶点 */
  private culled(sx: number, sy: number): boolean {
    return this.culling && (sx < this.cullX0 || sx > this.cullX1 || sy < this.cullY0 || sy > this.cullY1);
  }

  /** tone 路参数逐帧跟场景的光照环境（光环境曲线会原地改它，NPC 的滤镜同样逐帧读） */
  private syncTone(tone: VfxToneEnv | null): void {
    const u = this.toneGroup.uniforms as Record<string, unknown>;
    if (!tone) {
      u['uToneStrength'] = 0;
    } else {
      u['uToneStrength'] = Math.max(0, Math.min(1, tone.strength));
      (u['uKeyColor'] as Float32Array).set(tone.key.color);
      u['uKeyIntensity'] = tone.key.intensity;
      (u['uAmbientColor'] as Float32Array).set(tone.ambient.color);
      u['uAmbientIntensity'] = tone.ambient.intensity;
    }
    this.toneGroup.update();
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
      if (this.culled(sx, sy)) continue;
      // 脚点 = 正下方地面点（只管透视系数；前后分桶按水平纵深，见 bucketOf）
      tmpW[1] = space.groundY(p.x[i], p.z[i]);
      space.toScene(tmpW, tmpScene2);
      const footY = tmpScene2.y;
      const persp = this.deps.perspective(tmpScene2.x, footY);
      const t = p.life[i] > 0 ? Math.min(1, p.age[i] / p.life[i]) : 0;
      // × 粒子区域的淡入淡出（不限定区域的实例恒 1）
      const alpha = sampleCurve(ap.alphaOverLife, t) * p.fade[i];
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
      this.bucketMesh(v, this.bucketOf(p.x[i], p.z[i])).push(quad);
    }
  }

  /**
   * 薄片：每张片按自己的朝向 / 弯曲 / 颤动在 M-world 里拼出一条带，逐顶点正交投影，再按脚点的
   * 透视系数绕中心缩放（伪世界横向 1 wu = 1 画面 wu，透视场景远处的纸真实尺寸画出来要更小）。
   * 躺着的是"碗"（两边翘），贴死的是"悬臂"（一边钉住、另一边被风掀）。
   */
  private fillPlate(v: EmitterView, inst: VfxInstanceSim, e: VfxEmitterRuntime, space: VfxSpace): void {
    const pl = e.plate!;
    const P = pl.P, A = pl.arr, p = e.p;
    const segs = P.segments;
    const strip = v.plateStrip!;
    const sheet = v.sheet;
    const nFrames = sheet.frames.length;
    const ap = e.def.appearance;
    const tint = ap.tint ?? [1, 1, 1];
    const sizeWu = Math.max(1e-6, ap.sizeWu);
    const lit = v.lit;
    const vd = space.viewDir;
    const time = inst.time;
    probeAffine(space);
    const S = affS, Q = affQ;
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      const t01 = p.life[i] > 0 ? Math.min(1, p.age[i] / p.life[i]) : 0;
      const alpha = sampleCurve(ap.alphaOverLife, t01) * p.fade[i];
      if (alpha <= 0.002) continue;
      const cx = p.x[i], cy = p.y[i], cz = p.z[i];
      // 脚点：正下方地面投到画面（透视）
      const gy = space.groundY(cx, cz);
      const footX = S[0] * cx + S[1] * gy + S[2] * cz + S[6];
      const footY = S[3] * cx + S[4] * gy + S[5] * cz + S[7];
      if (this.culled(footX, footY)) continue;
      let s = A.metric[i];
      if (!(s > 0)) s = this.deps.perspective(footX, footY);
      const k = (p.size[i] / sizeWu) * sampleCurve(ap.sizeOverLife, t01);
      const halfW = (P.w * k) / 2, halfH = (P.h * k) / 2;
      const nx = A.nx[i], ny = A.ny[i], nz = A.nz[i];
      const tx = A.tx[i], ty = A.ty[i], tz = A.tz[i];
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const pinned = A.hold[i] === Infinity;
      let bend = A.bend[i];
      if (A.contact[i] !== PlateContact.Free) {
        const wf = Math.min(1, A.wind[i] / PLATE_FLUTTER_SATURATE);
        const fl = PLATE_FLUTTER_AMP * wf * Math.sin(time * P.bendOmega * (0.55 + 0.45 * wf) + p.seed[i] * 40);
        bend = pinned ? A.restBend[i] + PLATE_PINNED_LIFT * wf + fl : bend + fl;
      }
      const f = sheet.frames[nFrames > 1 ? Math.floor(p.seed[i] * nFrames) % nFrames : 0];
      // 躺着 / 贴着的纸跟着底下那片草木走（与背景摆动同一个位移）
      let swX = 0, swY = 0;
      if (A.contact[i] !== PlateContact.Free && this.deps.swayAt) {
        const csx = S[0] * cx + S[1] * cy + S[2] * cz + S[6];
        const csy = S[3] * cx + S[4] * cy + S[5] * cz + S[7];
        if (this.deps.swayAt(csx, csy, cx, cz, swayOut)) { swX = swayOut.x; swY = swayOut.y; }
      }
      for (let c = 0; c <= segs; c++) {
        const u = c / segs;
        const lx = (u * 2 - 1) * halfW;
        // 位移 d 与斜率 dd/dlx：碗 d = bend·halfW·(2u−1)²；悬臂 d = bend·halfW·u²
        let d: number, dd: number;
        if (pinned) { d = bend * halfW * u * u; dd = bend * u; } else { const m = u * 2 - 1; d = bend * halfW * m * m; dd = 2 * bend * m; }
        let mx = nx - dd * tx, my = ny - dd * ty, mz = nz - dd * tz;
        const ml = Math.hypot(mx, my, mz) || 1;
        mx /= ml; my /= ml; mz /= ml;
        if (mx * vd[0] + my * vd[1] + mz * vd[2] > 0) { mx = -mx; my = -my; mz = -mz; }
        const sh = lit ? 1 : 0.5 * (1 + my) + PLATE_GROUND_ALBEDO * 0.5 * (1 - my);
        const uu = f.u0 + (f.u1 - f.u0) * u;
        for (let side = 0; side < 2; side++) {
          const ly = side === 0 ? -halfH : halfH;
          const wx = cx + (lx * tx + ly * bx + d * nx) * s;
          const wy = cy + (lx * ty + ly * by + d * ny) * s;
          const wz = cz + (lx * tz + ly * bz + d * nz) * s;
          const vi = 2 * c + side;
          strip.pos[vi * 2] = S[0] * wx + S[1] * wy + S[2] * wz + S[6] + swX;
          strip.pos[vi * 2 + 1] = S[3] * wx + S[4] * wy + S[5] * wz + S[7] + swY;
          strip.uv[vi * 2] = uu;
          strip.uv[vi * 2 + 1] = side === 0 ? f.v0 : f.v1;
          strip.col[vi * 4] = tint[0] * sh * alpha;
          strip.col[vi * 4 + 1] = tint[1] * sh * alpha;
          strip.col[vi * 4 + 2] = tint[2] * sh * alpha;
          strip.col[vi * 4 + 3] = alpha;
          strip.q[vi * 3] = Q[0] * wx + Q[1] * wy + Q[2] * wz + Q[9];
          strip.q[vi * 3 + 1] = Q[3] * wx + Q[4] * wy + Q[5] * wz + Q[10];
          strip.q[vi * 3 + 2] = Q[6] * wx + Q[7] * wy + Q[8] * wz + Q[11];
          strip.nrm[vi * 3] = mx; strip.nrm[vi * 3 + 1] = my; strip.nrm[vi * 3 + 2] = mz;
        }
      }
      this.plateBucketMesh(v, this.bucketOf(cx, cz)).push(strip);
    }
  }

  private destroyView(v: EmitterView): void {
    for (const m of v.buckets.values()) m.destroy();
    v.buckets.clear();
    for (const m of v.plateBuckets.values()) m.destroy();
    v.plateBuckets.clear();
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
    for (const v of this.views.values()) {
      for (const m of v.buckets.values()) if (m.used > 0) n++;
      for (const m of v.plateBuckets.values()) if (m.used > 0) n++;
    }
    return n;
  }
}

