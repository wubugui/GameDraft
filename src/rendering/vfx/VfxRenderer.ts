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
 * **挂在实体身上的效果**（手里火把的火苗）另有一条：整团粒子钉在宿主的**同一侧**——挂件画在身前就全在
 * 宿主之后画，挂件画在身后就全在宿主之前画（`VfxSortHost`），只有对**别的**实体才逐颗按纵深分桶。
 * 否则挂件灯离身体那几 wu 的间隙抵不过湍流：朝左举火把（挂件在身后）时一半火舌飘到人前面，
 * 同一团火被人身劈成前后两半。
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
 * 受光强度 `appearance.lightGain` 走本视图自己的参数组（见 `vfxLightGain`），lit / tone 两路吃、unlit 恒 1。
 *
 * ## 尺寸与透视
 *
 * 粒子世界尺寸 wu → 画面 wu 同尺；透视缩放场景按**脚点**过 `perspective`，与实体同一规则。
 * 沿速度拉伸：把速度投到画面，quad 长轴对齐它。
 *
 * 渲染侧不写模拟状态（只读池），不 import 任何系统。
 */
import { resolveLightFactors, type LightFactors } from '../../data/lightFactors';
import {
  type BlendMode, Container, type GlProgram, type GpuProgram, type PipelinePrewarmSpec, Shader, Texture, type TextureSource, UniformGroup,
} from '../../engine2d';

import type { SceneDepthConfig } from '../../data/types';
import { sampleColorCurve, sampleCurve } from '../../systems/vfx/vfxCurve';
import type { Vec3 } from '../../utils/sceneSpace';
import type { VfxEmitterRuntime, VfxInstanceSim } from '../../systems/vfx/vfxSim';
import { VfxParticleMode } from '../../systems/vfx/vfxSim';
import { PlateContact } from '../../systems/vfx/vfxPlate';
import { plateBurnDir, plateBurnProgress } from '../../systems/vfx/vfxPlateBurn';
import type { VfxSpace } from '../../systems/vfx/vfxSpace';
import {
  beam2dLocal, beam3dLocal, beamColorAt, beamGainAt, convexHull2d, sceneQAffine, VFX_BEAM_MAX_HULL,
  type VfxBeamLocal, type VfxSceneQAffine,
} from '../../systems/vfx/vfxBeam';
import type { VfxBeamRuntime } from '../../systems/vfx/vfxSim';
import { samplerOf } from '../legacy/gpuSampler';
import { VfxBatchMesh, type VfxQuad } from './VfxBatchMesh';
import { packBeamUniforms, type VfxBeamPackEnv } from './vfxBeamGlsl';
import { VfxBeamView, createVfxBeamGeometry } from './VfxBeamView';
import { VfxPlateBatchMesh, createPlateStrip, type VfxPlateStrip } from './VfxPlateBatchMesh';
import { getVfxBeamGpuProgram } from './vfxBeamShaders';
import {
  getVfxBoltGpuProgram, getVfxBoltProgram, getVfxLitGpuProgram, getVfxLitProgram, getVfxPlateLitGpuProgram,
  getVfxPlateLitProgram, getVfxUnlitGpuProgram, getVfxUnlitProgram,
} from './vfxShaders';
import { VfxBoltBatchMesh } from './VfxBoltBatchMesh';
import { boltNeedHeight, emitBoltSegments, BOLT_QUAD_SIGMAS, type BoltLook, type BoltView } from './vfxBoltGlsl';
import { boltInstanceSeed, createBolt, extendBolt, type BoltGeometry } from '../../systems/vfx/vfxBolt';
import type { VfxBoltDef } from '../../data/types';

export const MAX_BUCKETS = 8;

/**
 * 粒子渲染会用到的全部管线(程序 × 网格顶点布局 × 混合)。组装层开局交给渲染器预建、揭幕前在遮罩下等它们编完
 * ——否则第一个受光粒子出现那一帧要等 GPU 进程把大着色器编完(WebGL 时代实测秒级,见 engine2d 卡)。
 * 几何取自各网格类本身(容量 1),布局与真画时逐项相同。新增一种粒子程序 / 网格就加进这里,漏了它就回到"第一次出现卡一下"。
 */
export function vfxPipelineSpecs(): PipelinePrewarmSpec[] {
  const stub = (gpuProgram: GpuProgram) => new Shader({ gpuProgram, resources: {} });
  const quad = new VfxBatchMesh(1, stub(getVfxUnlitGpuProgram())).mesh.geometry;
  const plate = new VfxPlateBatchMesh(1, 1, stub(getVfxPlateLitGpuProgram())).mesh.geometry;
  const bolt = new VfxBoltBatchMesh(1, stub(getVfxBoltGpuProgram())).mesh.geometry;
  // 粒子网格的混合只有 normal / add(见 bucketMesh);雷恒 add;光柱三种(VfxBeamView.setBlend)
  const particle: BlendMode[] = ['normal', 'add'];
  return [
    { program: getVfxUnlitGpuProgram(), geometry: quad, blendModes: particle },
    { program: getVfxLitGpuProgram(), geometry: quad, blendModes: particle },
    { program: getVfxUnlitGpuProgram(), geometry: plate, blendModes: particle },
    { program: getVfxPlateLitGpuProgram(), geometry: plate, blendModes: particle },
    { program: getVfxBoltGpuProgram(), geometry: bolt, blendModes: ['add'] },
    { program: getVfxBeamGpuProgram(), geometry: createVfxBeamGeometry(), blendModes: ['add', 'screen', 'normal'] },
  ];
}

/**
 * 受光程序（WebGPU 迁移期两份并存）：WebGL 跑 `gl`（GLSL，与迁移前同一个对象），WebGPU 跑 `gpu`（同一套资源布局的
 * WGSL）。照明系统的 `createCustomLitShader` 两个一起收，建出的 Shader 两个后端都能画。
 */
export interface VfxLitPrograms {
  gl: GlProgram;
  gpu: GpuProgram;
}

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
  /** 当前场景的粒子受光倍率（与角色独立）；缺省 1。 */
  getLightFactors?: () => LightFactors;
  /** 缺省宿主：场景路就是实体层（粒子在实体之间按纵深分桶）。 */
  entityLayer: Container;
  /**
   * 这个实例的网格该挂到哪个容器（不给 / 返回 null ⇒ {@link entityLayer}）。
   *
   * **画布**（场景之外那张屏幕空间的面）用它把每个特效实例挂进它自己那个
   * canvas item，于是**逐效果都有自己的 `order`**——实体能插在两个特效之间。
   * 宿主写死成一个容器的话，整块画布的特效只能共一个顺序。
   */
  hostFor?: (instanceId: string) => Container | null;
  /**
   * 是否按场景实体的脚底 y 分桶（缺省 true）。
   *
   * 画布给 `false`：那里没有场景实体，也不按脚底 y 排。不关的后果是阈值计算去读
   * 宿主容器的 children（画布 item 的 `y` 是**屏幕像素**），派出一组毫无意义的阈值，
   * 粒子被分到乱七八糟的桶里——**不报错，只是画面不对**。
   */
  sortByScene?: boolean;
  /**
   * 有照明载荷时给 lit shader；无则 null → 走 tone / unlit。`extra` 里除了本视图的组与深度图，还带着两个 WGSL 采样器
   * （`uColorTexSampler` / `uDepthMapSampler`，WebGL 不认这些键），照明系统原样并进 resources。
   */
  createLitShader: (programs: VfxLitPrograms, colorTex: TextureSource, extra: Record<string, unknown>) => Shader | null;
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
  /** 所属实例 id（找宿主用） */
  instanceId: string;
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
  /** 画雷的发射器（`appearance.bolt`）用这组；其余恒空 */
  boltBuckets: Map<number, VfxBoltBatchMesh>;
  depthGroup: UniformGroup;
  /** 本视图自己的参数组（lit 路 `vfxParams`、无光路 `vfxToneOn`），装着 `uLightGain` */
  paramGroup: UniformGroup;
  /** 已写进 `paramGroup` 的受光强度（逐帧与外观比对，变了就原地改） */
  lightGain: number;
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

/**
 * 挂在实体身上的效果的宿主：宿主在实体层里的那个节点 + 挂件此刻画在它身前还是身后
 * （与挂件自己在容器里的前后同一个判据，见 `SpriteEntity.getSocketPose(...).front`）。
 */
export interface VfxSortHost {
  node: Container;
  front: boolean;
}

/**
 * 分桶阈值：实体按脚点 y 升序（= 实体层画序），同一脚点只留一个，超上限按分位数合并。
 * `pinnedFootYs`（有效果挂在身上的宿主）**合并时一律保留**：宿主被并掉，"整团在它身前 / 身后"就没有边界可钉。
 */
export function buildSortThresholds(
  anchors: readonly VfxSortAnchor[], maxBuckets = MAX_BUCKETS, pinnedFootYs: ReadonlySet<number> = new Set(),
): VfxSortAnchor[] {
  const th = anchors.slice().sort((a, b) => a.footY - b.footY);
  let w = 0;
  for (let i = 0; i < th.length; i++) if (w === 0 || th[i].footY !== th[w - 1].footY) th[w++] = th[i];
  th.length = w;
  if (th.length <= maxBuckets - 1) return th;
  const pinned = th.filter((a) => pinnedFootYs.has(a.footY));
  const rest = th.filter((a) => !pinnedFootYs.has(a.footY));
  const keep = Math.max(0, maxBuckets - 1 - pinned.length);
  const out: VfxSortAnchor[] = pinned;
  for (let i = 0; i < keep && rest.length > 0; i++) out.push(rest[Math.floor(((i + 1) * rest.length) / (keep + 1))]);
  return out.sort((a, b) => a.footY - b.footY);
}

/**
 * 宿主在阈值里占的位置：`[lo, hi)` = 脚点 y 等于宿主的那几条（去重后至多一条）。
 * 宿主不在阈值里（这一帧不可见）⇒ lo === hi，调用方据此不钉。
 */
export function hostBucketRange(th: readonly VfxSortAnchor[], hostFootY: number): [number, number] {
  let lo = 0;
  while (lo < th.length && th[lo].footY < hostFootY) lo++;
  let hi = lo;
  while (hi < th.length && th[hi].footY <= hostFootY) hi++;
  return [lo, hi];
}

/** 挂在宿主身上的粒子：对别的实体照常按纵深分桶，对宿主钉在挂件那一侧（身前 ⇒ 宿主之后，身后 ⇒ 宿主之前） */
export function clampBucketToHost(bucket: number, lo: number, hi: number, front: boolean): number {
  if (lo === hi) return bucket;
  return front ? Math.max(bucket, hi) : Math.min(bucket, lo);
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
/** 燃着的纸烧完时卷起的弯曲（弯曲单位）：纸受热失水、烧过的一侧收缩，朝火线方向卷 */
const PLATE_BURN_CURL = 0.9;

function smoothstep01(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

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

// 曲线采样搬到纯模块（光柱与粒子工作台共用），这里原名转出，老调用方与测试不动
export { sampleColorCurve, sampleCurve };

const tmpLifeColor: [number, number, number] = [1, 1, 1];
const tmpBeamLocal: VfxBeamLocal = { t01: 0, u: 0, v: 0, edge: 0 };
const tmpBeamColor: [number, number, number] = [1, 1, 1];
const tmpHullIn = new Float32Array(VFX_BEAM_MAX_HULL * 2);
const tmpHullOut = new Float32Array(VFX_BEAM_MAX_HULL * 2);
const tmpBeamW: Vec3 = [0, 0, 0];
const tmpBeamS = { x: 0, y: 0 };
/** 被光柱照亮的尘埃：亮度超过 1 的那份按颜色提亮，封顶这么多倍（再往上显示变换也钳掉了） */
const BEAM_LIT_COLOR_BOOST_MAX = 8;

/** 算不出可见矩形时（没有画布尺寸）天上那道雷先算到多高（真实 wu） */
const BOLT_PREVIEW_HEIGHT_WU = 3000;
/** 雷段暂存：ax ay bx by σ amp color */
const BOLT_SCRATCH_STRIDE = 7;
const boltScratch = {
  n: 0,
  data: new Float32Array(1024 * BOLT_SCRATCH_STRIDE),
  segment(ax: number, ay: number, bx: number, by: number, sigma: number, amp: number, color: 0 | 1): void {
    const o = this.n * BOLT_SCRATCH_STRIDE;
    if (o + BOLT_SCRATCH_STRIDE > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const d = this.data;
    d[o] = ax; d[o + 1] = ay; d[o + 2] = bx; d[o + 3] = by; d[o + 4] = sigma; d[o + 5] = amp; d[o + 6] = color;
    this.n++;
  },
};
const boltCx = new Float64Array(4);
const boltCy = new Float64Array(4);
const boltQ = new Float64Array(12);

/**
 * 被光柱照亮（`appearance.beamLit`）：粒子所在位置的光柱亮度倍率。3D 光柱按粒子世界点、2D 光带按粒子画面点。
 * 在柱外 / 光柱退化 = 0。颜色写进 `color`（光柱沿长度的 sRGB 颜色）。
 */
export function beamLitFactor(
  bl: VfxBeamRuntime, pulse: number, gain: number,
  wx: number, wy: number, wz: number, sx: number, sy: number, color: [number, number, number],
): number {
  const inside = bl.frame3d ? beam3dLocal(bl.frame3d, wx, wy, wz, tmpBeamLocal)
    : bl.frame2d ? beam2dLocal(bl.frame2d, sx, sy, tmpBeamLocal) : false;
  if (!inside) return 0;
  beamColorAt(bl.look, tmpBeamLocal.t01, color);
  return beamGainAt(bl.def, bl.look, tmpBeamLocal, pulse, bl.fade) * gain;
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

/** `appearance.lightGain` 的上限（与工作台 / 校验器的 0..10 同口径） */
export const VFX_LIGHT_GAIN_MAX = 10;

/**
 * 受光强度（`uLightGain`）：乘在这个发射器**收到的光**上——lit 路乘 E（probe 底光 + 实体灯，着色之前），
 * tone 路乘色调融入的光照因子；自发光份额不乘。缺省 / 非有限数 = 1，夹到 0..10。
 * `lit:false` 恒 1：无光路径忽略它（片元里 `uLightGain != 1.0` 那一支不进，输出与改动前逐位相同）。
 *
 * ⚠ 它进的是**本视图自己的** UniformGroup（lit 路 `vfxParams`、无光路 `vfxToneOn`），不是
 * sceneShade / charLights 那几组角色共用的；粒子 frameShade 也不能写逐效果强度。
 */
export function vfxLightGain(ap: { lit?: boolean; lightGain?: number }): number {
  if (ap.lit === false) return 1;
  const g = ap.lightGain;
  return typeof g === 'number' && Number.isFinite(g) ? Math.max(0, Math.min(VFX_LIGHT_GAIN_MAX, g)) : 1;
}

export class VfxRenderer {
  private readonly views = new Map<string, EmitterView>();
  /** 光柱视图：`<instanceId>/beam:<beamId>`，一根一张网格 */
  private readonly beamViews = new Map<string, VfxBeamView>();
  /** 光柱打包用的场景量（按空间缓存：换空间才重探仿射） */
  private beamEnvSpace: VfxSpace | null = null;
  private beamAffine: VfxSceneQAffine | null = null;
  private beamUpright: VfxBeamPackEnv['uprightQz'] = null;
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
  /** 本帧宿主节点 → 它的脚点 y（`refreshThresholds` 顺手记下，与阈值同一个数） */
  private readonly hostFootY = new Map<Container, number>();
  private hostLo = 0;
  private hostHi = 0;
  private hostFront = true;
  /** tone 路的共享参数（逐帧从场景的光照环境同步，与 NPC 的 EntityLightingFilter 同一组数） */
  private readonly toneGroup = new UniformGroup({
    uToneStrength: { value: 0, type: 'f32' },
    uKeyColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uKeyIntensity: { value: 0, type: 'f32' },
    uAmbientColor: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
    uAmbientIntensity: { value: 1, type: 'f32' },
  });

  /** 雷形缓存：`<instanceId>/<boltId>` → 这一次的雷形（同一实例的几层画同一道雷；按需往上续算） */
  private readonly boltGeoms = new Map<string, { def: VfxBoltDef; geom: BoltGeometry }>();

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
    const isBolt = !!ap.bolt;
    // 雷是光源：不吃灯、不走色调融入（见 vfxShaders 的 FRAG_BOLT）
    const wantLit = ap.lit !== false && !isBolt;
    const isPlate = !!e.plate;
    const lightGain = vfxLightGain(ap);
    let shader: Shader | null = null;
    let lit = false;
    let toneSrc: TextureSource | null = null;
    let paramGroup: UniformGroup | null = null;
    // WGSL 的采样器（「纹理名 + Sampler」= 与该纹理采样参数相同的共享采样器，见 legacy/gpuSampler；WebGL 不认这些键）
    const colorSrc = sheet.texture.source;
    if (isBolt) {
      paramGroup = new UniformGroup({ uLightGain: { value: 1, type: 'f32' } });
      const boltDepth = depthSrc ?? Texture.WHITE.source;
      shader = new Shader({
        glProgram: getVfxBoltProgram(),
        gpuProgram: getVfxBoltGpuProgram(),
        resources: { vfxDepth: depthGroup, uDepthMap: boltDepth, uDepthMapSampler: samplerOf(boltDepth) },
      });
    } else if (wantLit && canLight) {
      const pv = vfxParamValues(ap);
      // 逐视图一组：createLitShader 每次 new 一个 Shader，这组只挂在这一个视图上（受光强度不许进角色共用组）
      paramGroup = new UniformGroup({
        uSphere: { value: pv.uSphere, type: 'f32' },
        uEmissive: { value: pv.uEmissive, type: 'f32' },
        uLightGain: { value: lightGain, type: 'f32' },
        uVfxIndirectFactor: { value: 1, type: 'f32' },
        uVfxDirectFactor: { value: 1, type: 'f32' },
        uVfxTotalFactor: { value: 1, type: 'f32' },
      });
      // 薄片的受光程序声明了 aNrm，只能配薄片网格（见 VfxPlateBatchMesh 头注释）
      const programs: VfxLitPrograms = isPlate
        ? { gl: getVfxPlateLitProgram(), gpu: getVfxPlateLitGpuProgram() }
        : { gl: getVfxLitProgram(), gpu: getVfxLitGpuProgram() };
      shader = this.deps.createLitShader(programs, colorSrc, {
        vfxDepth: depthGroup,
        uDepthMap: depthTex,
        vfxParams: paramGroup,
        uColorTexSampler: samplerOf(colorSrc),
        uDepthMapSampler: samplerOf(depthTex),
      });
      lit = !!shader;
    }
    if (!shader) {
      // 要受光却没有照明载荷 → NPC 此时走的色调融入；lit:false 的不染（自发光 / 按原画标定的 tint）
      const toneOn = wantLit && !!tone;
      toneSrc = toneOn ? tone!.probe : null;
      paramGroup = new UniformGroup({
        uToneOn: { value: toneOn ? 1 : 0, type: 'f32' },
        uLightGain: { value: lightGain, type: 'f32' },
      });
      const probeSrc = toneSrc ?? Texture.WHITE.source;
      shader = new Shader({
        glProgram: getVfxUnlitProgram(),
        gpuProgram: getVfxUnlitGpuProgram(),
        resources: {
          uColorTex: colorSrc, uColorTexSampler: samplerOf(colorSrc),
          vfxDepth: depthGroup, uDepthMap: depthTex, uDepthMapSampler: samplerOf(depthTex),
          // 显示变换：与背景 / 角色同一组数（这组里其余的灯 uniform 本程序不声明，Pixi 按名跳过）
          charLights: this.deps.displayUniforms,
          vfxTone: this.toneGroup,
          vfxToneOn: paramGroup,
          uProbe: probeSrc, uProbeSampler: samplerOf(probeSrc),
        },
      });
    }
    v = {
      key, instanceId, emitter: e, sheet, shader, lit, wantLit, depthSrc, toneSrc,
      buckets: new Map(), plateBuckets: new Map(), boltBuckets: new Map(),
      plateStrip: e.plate ? createPlateStrip(e.plate.P.segments) : null, depthGroup,
      paramGroup: paramGroup!, lightGain,
    };
    this.views.set(key, v);
    return v;
  }

  /** 该实例的网格挂哪（不给 / 返回 null ⇒ 实体层） */
  private hostOf(instanceId: string): Container {
    return this.deps.hostFor?.(instanceId) ?? this.deps.entityLayer;
  }

  private bucketMesh(v: EmitterView, bucket: number): VfxBatchMesh {
    let m = v.buckets.get(bucket);
    if (m) return m;
    m = new VfxBatchMesh(v.emitter.p.cap, v.shader);
    m.mesh.blendMode = v.emitter.def.appearance.blend === 'add' ? 'add' : 'normal';
    m.mesh.cullable = false;
    this.hostOf(v.instanceId).addChild(m.mesh);
    v.buckets.set(bucket, m);
    return m;
  }

  private boltBucketMesh(v: EmitterView, bucket: number): VfxBoltBatchMesh {
    let m = v.boltBuckets.get(bucket);
    if (m) return m;
    m = new VfxBoltBatchMesh(256, v.shader);
    m.mesh.blendMode = 'add';
    m.mesh.cullable = false;
    this.hostOf(v.instanceId).addChild(m.mesh);
    v.boltBuckets.set(bucket, m);
    return m;
  }

  private plateBucketMesh(v: EmitterView, bucket: number): VfxPlateBatchMesh {
    let m = v.plateBuckets.get(bucket);
    if (m) return m;
    m = new VfxPlateBatchMesh(v.emitter.p.cap, v.emitter.plate!.P.segments, v.shader);
    m.mesh.blendMode = v.emitter.def.appearance.blend === 'add' ? 'add' : 'normal';
    m.mesh.cullable = false;
    this.hostOf(v.instanceId).addChild(m.mesh);
    v.plateBuckets.set(bucket, m);
    return m;
  }

  /**
   * 每帧：从实体层读排序阈值——脚点 y（画序）+ 脚点落到地面后沿水平视线轴的纵深。
   * 实体脚点的世界位置走 `groundWorldAtScene`（与脚步声 / 摆灯同一条换算）。
   */
  private refreshThresholds(space: VfxSpace, hosts: ReadonlyMap<string, VfxSortHost> | undefined): void {
    if (this.deps.sortByScene === false) {
      // 画布：没有场景实体可分，整个实例就是一桶（顺序由 canvas item 的 order 定）。
      // 仍要刷视线轴：粒子的深度键还要用它（只是桶就一个）。
      const [ax, az] = horizontalViewAxis(space.viewDir);
      this.hx = ax; this.hz = az;
      this.thresholds = [];
      this.hostFootY.clear();
      return;
    }
    const [hx, hz] = horizontalViewAxis(space.viewDir);
    this.hx = hx; this.hz = hz;
    const own = new Set<Container>();
    for (const v of this.views.values()) {
      for (const m of v.buckets.values()) own.add(m.mesh);
      for (const m of v.plateBuckets.values()) own.add(m.mesh);
      for (const m of v.boltBuckets.values()) own.add(m.mesh);
    }
    for (const bv of this.beamViews.values()) own.add(bv.mesh);
    const anchors: VfxSortAnchor[] = [];
    this.hostFootY.clear();
    const hostNodes = new Set<Container>();
    if (hosts) for (const h of hosts.values()) hostNodes.add(h.node);
    const pinned = new Set<number>();
    for (const child of this.deps.entityLayer.children) {
      if (own.has(child)) continue;
      const ext = child as Container & { entitySortBand?: string; entitySortFootY?: number };
      if (ext.entitySortBand) continue;
      if (!child.visible) continue;
      const footY = ext.entitySortFootY ?? child.y;
      const g = space.groundWorldAtScene(child.x, footY);
      anchors.push({ footY, depthKey: g[0] * hx + g[2] * hz });
      if (hostNodes.has(child)) { this.hostFootY.set(child, footY); pinned.add(footY); }
    }
    this.thresholds = buildSortThresholds(anchors, MAX_BUCKETS, pinned);
  }

  /** 本实例的宿主钉位（`fill` / `fillPlate` 期间有效）；没有宿主 / 宿主不在场 ⇒ lo === hi */
  private bindHost(host: VfxSortHost | undefined): void {
    const footY = host ? this.hostFootY.get(host.node) : undefined;
    if (!host || footY === undefined) { this.hostLo = 0; this.hostHi = 0; return; }
    [this.hostLo, this.hostHi] = hostBucketRange(this.thresholds, footY);
    this.hostFront = host.front;
  }

  /** 粒子（世界 x / z）落第几桶 */
  private bucketOf(wx: number, wz: number): number {
    const b = bucketOfDepth(this.thresholds, wx * this.hx + wz * this.hz);
    return clampBucketToHost(b, this.hostLo, this.hostHi, this.hostFront);
  }

  /**
   * 渲染一批实例。`sheets` 按 `<instanceId>/<emitterId>` 给贴图；没贴图的发射器跳过。
   * `hosts`：挂在实体身上的实例 id → 宿主（见 {@link VfxSortHost}）；不在表里的照常逐颗分桶。
   */
  render(
    instances: readonly VfxInstanceSim[], sheets: ReadonlyMap<string, VfxSpriteSheet>,
    hosts?: ReadonlyMap<string, VfxSortHost>,
    /** 光柱图案遮罩贴图：`<instanceId>/<beamId>`；还没装到的光柱先不带图案画 */
    beamTextures?: ReadonlyMap<string, Texture>,
    /** 整团退场倍率；不改粒子寿命、轨迹、发射或受光。 */
    instanceAlphas?: ReadonlyMap<string, number>,
  ): void {
    if (instances.length > 0) this.refreshThresholds(instances[0].space, hosts);
    this.refreshCull();
    const depth = this.deps.getDepth();
    const depthSrc = depth?.tex.source ?? null;
    const size = this.deps.getSceneSize();
    const canLight = this.deps.canLight();
    const tone = this.deps.getToneEnv();
    this.syncTone(tone);
    const seen = new Set<string>();
    const liveBolts = new Set<string>();
    for (const inst of instances) {
      const alpha = Math.max(0, Math.min(1, instanceAlphas?.get(inst.id) ?? 1));
      const space = inst.space;
      this.bindHost(hosts?.get(inst.id));
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
        this.syncLightGain(v, this.deps.getLightFactors?.());
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
        for (const m of v.boltBuckets.values()) m.begin();
        if (e.def.appearance.bolt) this.fillBolt(v, inst, e, space, liveBolts);
        else if (e.plate) this.fillPlate(v, inst, e, space);
        else this.fill(v, inst, e, space);
        for (const [b, m] of v.buckets) {
          m.end();
          m.mesh.alpha = alpha;
          (m.mesh as Container & { entitySortFootY?: number }).entitySortFootY = bucketSortFootY(this.thresholds, b);
        }
        for (const [b, m] of v.plateBuckets) {
          m.end();
          m.mesh.alpha = alpha;
          (m.mesh as Container & { entitySortFootY?: number }).entitySortFootY = bucketSortFootY(this.thresholds, b);
        }
        for (const [b, m] of v.boltBuckets) {
          m.end();
          m.mesh.alpha = alpha;
          (m.mesh as Container & { entitySortFootY?: number }).entitySortFootY = bucketSortFootY(this.thresholds, b);
        }
      }
      // 测试桩 / 旧调用方的实例可能没有 beams 表
      if ((inst.beams?.length ?? 0) > 0) this.renderBeams(inst, depth, depthSrc, size, beamTextures, seen, alpha);
    }
    // 不在本帧清单里的视图（实例被收掉）→ 销毁
    for (const [key, v] of this.views) {
      if (seen.has(key)) continue;
      this.destroyView(v);
      this.views.delete(key);
    }
    for (const [key, bv] of this.beamViews) {
      if (seen.has(key)) continue;
      bv.destroy();
      this.beamViews.delete(key);
    }
    // 雷形缓存跟着实例走：这一帧没画到的（实例收了 / 定义换了）扔掉
    for (const key of this.boltGeoms.keys()) if (!liveBolts.has(key)) this.boltGeoms.delete(key);
  }

  /** 光柱打包的场景量：仿射与直立面按空间缓存 */
  private beamEnv(space: VfxSpace, time: number, hasDepth: boolean): VfxBeamPackEnv {
    if (this.beamEnvSpace !== space) {
      this.beamEnvSpace = space;
      this.beamAffine = sceneQAffine(space);
      const upright = space.uprightWorldAtScene?.bind(space);
      const q: Vec3 = [0, 0, 0];
      this.beamUpright = upright
        ? (fx, fy, sx, sy) => { space.toQ(upright(fx, fy, sx, sy), q); return q[2]; }
        : null;
    }
    return { affine: this.beamAffine, wuPerQ: space.wuPerQ, time, uprightQz: this.beamUpright, hasDepth };
  }

  /**
   * 一个实例的光柱：一根一张网格。视图按"建的那一拍有什么"建（光柱运行态对象 / 深度纹理 / 图案贴图），
   * 变了就重建；其余（形状、颜色、强度、淡入淡出）逐帧打包进 uniform。
   */
  private renderBeams(
    inst: VfxInstanceSim, depth: { tex: Texture; cfg: SceneDepthConfig } | null, depthSrc: TextureSource | null,
    size: { w: number; h: number }, beamTextures: ReadonlyMap<string, Texture> | undefined, seen: Set<string>,
    alpha: number,
  ): void {
    const space = inst.space;
    const useDepth = !!depth && space.kind === 'field';
    const env = this.beamEnv(space, inst.time, useDepth);
    for (const b of inst.beams) {
      const key = `${inst.id}/beam:${b.def.id}`;
      seen.add(key);
      const cookieSrc = b.def.cookie ? beamTextures?.get(`${inst.id}/${b.def.id}`)?.source ?? null : null;
      let v = this.beamViews.get(key);
      if (v && (v.beam !== b || v.depthSrc !== depthSrc || v.cookieSrc !== cookieSrc)) {
        v.destroy();
        this.beamViews.delete(key);
        v = undefined;
      }
      if (!v) {
        v = new VfxBeamView(key, b, depthSrc, cookieSrc, this.deps.displayUniforms);
        this.hostOf(inst.id).addChild(v.mesh);
        this.beamViews.set(key, v);
      }
      inst.beamFrame(b);
      let ok = packBeamUniforms(b, inst.beamPulse(b), env, v.values);
      v.mesh.alpha = alpha;
      // 图案贴图还没装到：先不带图案画（装到后视图按贴图重建）
      if (b.def.cookie && !cookieSrc) v.values.uBeamCookieOn = 0;
      // 画面包络
      let n = 0;
      if (ok && b.frame3d) {
        const c = b.frame3d.corners;
        const m = c.length / 3;
        for (let k = 0; k < m; k++) {
          tmpBeamW[0] = c[k * 3]; tmpBeamW[1] = c[k * 3 + 1]; tmpBeamW[2] = c[k * 3 + 2];
          space.toScene(tmpBeamW, tmpBeamS);
          tmpHullIn[k * 2] = tmpBeamS.x; tmpHullIn[k * 2 + 1] = tmpBeamS.y;
        }
        n = convexHull2d(tmpHullIn, m, tmpHullOut);
      } else if (ok && b.frame2d) {
        tmpHullOut.set(b.frame2d.corners);
        n = 4;
      }
      if (n < 3) ok = false;
      if (ok && this.culling) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let k = 0; k < n; k++) {
          const x = tmpHullOut[k * 2], y = tmpHullOut[k * 2 + 1];
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (x1 < this.cullX0 || x0 > this.cullX1 || y1 < this.cullY0 || y0 > this.cullY1) ok = false;
      }
      v.mesh.visible = ok;
      if (!ok) continue;
      const du = v.depthGroup.uniforms as Record<string, unknown>;
      (du['uSceneSize'] as Float32Array).set([size.w, size.h]);
      if (useDepth) {
        du['uHasDepth'] = 1;
        du['uInvert'] = depth!.cfg.depth_mapping.invert ? 1 : 0;
        du['uScale'] = depth!.cfg.depth_mapping.scale;
        du['uOffset'] = depth!.cfg.depth_mapping.offset;
        du['uTolerance'] = depth!.cfg.depth_tolerance;
      } else {
        du['uHasDepth'] = 0;
      }
      v.depthGroup.update();
      v.setHull(tmpHullOut, n);
      v.syncUniforms();
      v.setSort(b.look.sort, b.foot.y);
      v.setBlend(b.look.blend);
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

  /**
   * 场景的三项倍率与效果受光强度逐帧同步；倍率调整不重建/重启粒子。
   * 工作台推来的新定义会换掉发射器（`viewStale` 按身份重建视图），
   * 这里再兜住"同一个发射器的定义被原地改了"——只动本视图自己那组，值没变不写。
   * ⚠ 外观的原地兜底只管 lightGain；其余外观（lit / blend →
   * 程序与混合模式、emissive / sphere）不做原地同步，一律靠换发射器重建视图——运行时目前没有任何
   * 代码原地改定义，推送路径（`applyPreviewEffect`）总是整组重建，所以这不是漏同步。
   */
  private syncLightGain(v: EmitterView, lighting?: Partial<LightFactors>): void {
    const f = resolveLightFactors(lighting);
    // 缺载荷的 tone 路只存在环境底光；unlit 自发光保持原样。
    const g = vfxLightGain(v.emitter.def.appearance)
      * (!v.lit && v.wantLit ? f.indirectFactor * f.totalFactor : 1);
    const u = v.paramGroup.uniforms as Record<string, unknown>;
    let changed = g !== v.lightGain;
    v.lightGain = g;
    u['uLightGain'] = g;
    if (v.lit) {
      for (const [key, value] of [
        ['uVfxIndirectFactor', f.indirectFactor], ['uVfxDirectFactor', f.directFactor],
        ['uVfxTotalFactor', f.totalFactor],
      ] as const) {
        if (u[key] !== value) { u[key] = value; changed = true; }
      }
    }
    if (changed) v.paramGroup.update();
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
    // 被光柱照亮（光柱里的尘埃）：同一实例里那根光柱的帧 / 起伏每个发射器取一次
    const bl = ap.beamLit ? inst.beamById(ap.beamLit.beam) : null;
    const blGain = ap.beamLit?.gain ?? 1;
    const blPulse = bl ? inst.beamPulse(inst.beamFrame(bl)) : 1;
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      tmpW[0] = p.x[i]; tmpW[1] = p.y[i]; tmpW[2] = p.z[i];
      space.toScene(tmpW, tmpScene);
      const sx = tmpScene.x, sy = tmpScene.y;
      if (this.culled(sx, sy)) continue;
      let beamK = 1;
      if (bl) {
        beamK = beamLitFactor(bl, blPulse, blGain, p.x[i], p.y[i], p.z[i], sx, sy, tmpBeamColor);
        if (beamK <= 0.002) continue;
      }
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
        const ph = e.flock ? p.phase[i] : p.age[i] * fps + p.seed[i] * nFrames;
        fi = ((Math.floor(ph) % nFrames) + nFrames) % nFrames;
      }
      const f = sheet.frames[fi];
      quad.u0 = f.u0; quad.v0 = f.v0; quad.u1 = f.u1; quad.v1 = f.v1;
      quad.mirror = mirror;
      if (ap.tintOverLife) {
        sampleColorCurve(ap.tintOverLife, t, tmpLifeColor);
        quad.r = tint[0] * tmpLifeColor[0]; quad.g = tint[1] * tmpLifeColor[1]; quad.b = tint[2] * tmpLifeColor[2];
      } else {
        quad.r = tint[0]; quad.g = tint[1]; quad.b = tint[2];
      }
      quad.a = alpha;
      if (bl) {
        // 亮度 ≤ 1 的部分当不透明度（柱边上的尘埃淡掉），超过 1 的部分按光柱颜色提亮
        const boost = Math.min(BEAM_LIT_COLOR_BOOST_MAX, Math.max(1, beamK));
        quad.r *= tmpBeamColor[0] * boost; quad.g *= tmpBeamColor[1] * boost; quad.b *= tmpBeamColor[2] * boost;
        quad.a = alpha * Math.min(1, beamK);
      }
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
   * 画雷（`appearance.bolt`）：每颗粒子 = 一道雷的落点。雷形按**实例种子 + 落点世界坐标**现算
   * （同一实例的几层画同一道雷；落点不同就长得不同，同一位置重放逐位相同），往上只续算到镜头要的高度；
   * 逐段交给 `emitBoltSegments` 挑细分级、定粗细、剔掉看不见的，一段一层光斑一张 quad。
   *
   * 剔除按**每一段自己的范围**，不按落点：落点在画外、雷身穿过画面照样画（09-24 制作人：雷在世界里，
   * 看不看得见只是镜头的事）。逐顶点 q 取雷身直立面上那一点（`uprightWorldAtScene`，平面上是线性的）。
   */
  private fillBolt(v: EmitterView, inst: VfxInstanceSim, e: VfxEmitterRuntime, space: VfxSpace, live: Set<string>): void {
    const ap = e.def.appearance;
    const L = ap.bolt!;
    const def = inst.effect.bolts?.find((b) => b.id === L.bolt);
    if (!def || (def.kind === 'sky' ? !def.sky : !def.surface)) return;
    const key = `${inst.id}/${def.id}`;
    live.add(key);
    let entry = this.boltGeoms.get(key);
    if (!entry || entry.def !== def) {
      // 种子 = 实例种子 × 落点（与落雷演出摆灯同一个，见 boltInstanceSeed）
      entry = { def, geom: createBolt(def, boltInstanceSeed(inst.seed, inst.anchorWorld)) };
      this.boltGeoms.set(key, entry);
    }
    const g = entry.geom;
    const p = e.p;
    const wt = this.deps.entityLayer.worldTransform;
    const pxPerScene = Math.hypot(wt.a, wt.b) || 1;
    const scr = this.deps.getScreen?.();
    const k768 = scr && scr.h > 0 ? scr.h / 768 : 1;
    const tint = ap.tint ?? [1, 1, 1];
    const core = L.coreColor ?? [1, 1, 1];
    const glow = L.glowColor;
    const sizeWu = Math.max(1e-6, ap.sizeWu);
    const view = this.culling ? { x0: this.cullX0, y0: this.cullY0, x1: this.cullX1, y1: this.cullY1 } : null;
    if (g.kind === 'surface') probeAffine(space);
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      const t = p.life[i] > 0 ? Math.min(1, p.age[i] / p.life[i]) : 0;
      const alpha = sampleCurve(ap.alphaOverLife, t) * p.fade[i];
      if (alpha <= 0.002) continue;
      const wx = p.x[i], wy = p.y[i], wz = p.z[i];
      tmpW[0] = wx; tmpW[1] = wy; tmpW[2] = wz;
      space.toScene(tmpW, tmpScene);
      const fx = tmpScene.x, fy = tmpScene.y;
      const persp = this.deps.perspective(fx, fy);
      const bv: BoltView = { footX: fx, footY: fy, persp, pxPerScene, k768, view };
      // q：落点那一点 + 直立面上沿画面 x / y 各走一个场景 wu 的增量（直立面是平面，q 对画面坐标线性）
      space.toQ(tmpW, tmpQ);
      const q0 = tmpQ[0], q1 = tmpQ[1], q2 = tmpQ[2];
      let dxq0 = 0, dxq1 = 0, dxq2 = 0, dyq0 = 0, dyq1 = 0, dyq2 = 0;
      if (g.kind === 'sky') {
        extendBolt(g, boltNeedHeight(bv, BOLT_PREVIEW_HEIGHT_WU));
        if (space.uprightWorldAtScene) {
          space.toQ(space.uprightWorldAtScene(fx, fy, fx + 1, fy), tmpQ);
          dxq0 = tmpQ[0] - q0; dxq1 = tmpQ[1] - q1; dxq2 = tmpQ[2] - q2;
          space.toQ(space.uprightWorldAtScene(fx, fy, fx, fy + 1), tmpQ);
          dyq0 = tmpQ[0] - q0; dyq1 = tmpQ[1] - q1; dyq2 = tmpQ[2] - q2;
        }
      } else {
        // 贴地的电弧：世界点 = 落点 + (dx, 地面高, dz)，过正交投影换场景坐标
        const S = affS;
        bv.groundToScene = (dx, dz, out) => {
          const x = wx + dx * persp, z = wz + dz * persp;
          const y = space.groundY(x, z);
          out.x = S[0] * x + S[1] * y + S[2] * z + S[6];
          out.y = S[3] * x + S[4] * y + S[5] * z + S[7];
        };
      }
      const lc = ap.tintOverLife ? sampleColorCurve(ap.tintOverLife, t, tmpLifeColor) : null;
      const tr = tint[0] * (lc ? lc[0] : 1), tg = tint[1] * (lc ? lc[1] : 1), tb = tint[2] * (lc ? lc[2] : 1);
      const look: BoltLook = {
        part: L.part === 'main' ? 'main' : 'all',
        coreWu: L.coreWu, coreMinPx: L.coreMinPx, glowWu: L.glowWu, glowMinPx: L.glowMinPx,
        haloWu: L.haloWu ?? 0, haloMinPx: L.haloMinPx ?? 0,
        coreGain: L.coreGain, glowGain: L.glowGain, haloGain: L.haloGain ?? 0,
        widthMul: (p.size[i] / sizeWu) * sampleCurve(ap.sizeOverLife, t),
      };
      const sc = boltScratch;
      sc.n = 0;
      emitBoltSegments(g, look, bv, sc);
      if (sc.n === 0) continue;
      const mesh = this.boltBucketMesh(v, this.bucketOf(wx, wz));
      mesh.reserve(mesh.used + sc.n);
      const d = sc.data;
      for (let s = 0; s < sc.n; s++) {
        const o = s * BOLT_SCRATCH_STRIDE;
        const ax = d[o], ay = d[o + 1], bx = d[o + 2], by = d[o + 3], sig = d[o + 4], amp = d[o + 5];
        const isCore = d[o + 6] === 0;
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1e-6) continue;
        const r = sig * BOLT_QUAD_SIGMAS;
        const tx = (bx - ax) / len * r, ty = (by - ay) / len * r;
        const nx = -ty, ny = tx;
        boltCx[0] = ax - tx - nx; boltCy[0] = ay - ty - ny;
        boltCx[1] = bx + tx - nx; boltCy[1] = by + ty - ny;
        boltCx[2] = bx + tx + nx; boltCy[2] = by + ty + ny;
        boltCx[3] = ax - tx + nx; boltCy[3] = ay - ty + ny;
        for (let k = 0; k < 4; k++) {
          const ox = boltCx[k] - fx, oy = boltCy[k] - fy;
          boltQ[k * 3] = q0 + ox * dxq0 + oy * dyq0;
          boltQ[k * 3 + 1] = q1 + ox * dxq1 + oy * dyq1;
          boltQ[k * 3 + 2] = q2 + ox * dxq2 + oy * dyq2;
        }
        const c = isCore ? core : glow;
        mesh.push(boltCx, boltCy, ax, ay, bx, by, sig, amp, c[0] * tr, c[1] * tg, c[2] * tb, alpha, boltQ);
      }
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
      const lc = ap.tintOverLife ? sampleColorCurve(ap.tintOverLife, t01, tmpLifeColor) : null;
      const cr = lc ? tint[0] * lc[0] : tint[0];
      const cg = lc ? tint[1] * lc[1] : tint[1];
      const cb = lc ? tint[2] * lc[2] : tint[2];
      // 燃着的纸：火线从被火碰到的那一边扫到另一边（方向着的那一刻定），扫过的焦黑、卷起、成灰淡掉，火线那一带发亮
      const burn = e.burn;
      const bk = burn ? plateBurnProgress(burn, i) : -1;
      const burnDir = burn && bk >= 0 ? plateBurnDir(burn, i) : 1;
      const burnFront = -0.15 + bk * 1.3;
      if (bk >= 0) bend += burnDir * bk * PLATE_BURN_CURL;
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
        // 燃烧着色（没着的纸：vr/vg/vb = 原色 × 明暗、vAlpha = alpha、自发光 0，与改动前逐位相同）
        let vr = cr * sh, vg = cg * sh, vb = cb * sh, vAlpha = alpha, vEm = 0;
        if (bk >= 0 && burn) {
          const along = burnDir > 0 ? u : 1 - u;
          const behind = burnFront - along;                       // > 0 = 火线已经扫过
          const charAmt = smoothstep01(-0.05, 0.1, behind);
          const glowAmt = Math.max(0, 1 - Math.abs(behind) / 0.12);
          const cc = burn.P.charColor;
          vr = vr + (cc[0] * sh - vr) * charAmt;
          vg = vg + (cc[1] * sh - vg) * charAmt;
          vb = vb + (cc[2] * sh - vb) * charAmt;
          const gs = burn.P.glowStrength * glowAmt;
          vr += burn.P.glow[0] * gs; vg += burn.P.glow[1] * gs; vb += burn.P.glow[2] * gs;
          vAlpha = alpha * (1 - smoothstep01(0.25, 0.45, behind));
          vEm = Math.min(1, glowAmt);
        }
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
          strip.col[vi * 4] = vr * vAlpha;
          strip.col[vi * 4 + 1] = vg * vAlpha;
          strip.col[vi * 4 + 2] = vb * vAlpha;
          strip.col[vi * 4 + 3] = vAlpha;
          strip.misc[vi * 2] = 0;
          strip.misc[vi * 2 + 1] = vEm;
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
    for (const m of v.boltBuckets.values()) m.destroy();
    v.boltBuckets.clear();
    if (v.lit) this.deps.releaseLitShader(v.shader);
    else v.shader.destroy();
  }

  /** 切场景 / 系统销毁：整批清掉（先于纹理销毁） */
  clear(): void {
    for (const v of this.views.values()) this.destroyView(v);
    this.views.clear();
    for (const bv of this.beamViews.values()) bv.destroy();
    this.beamViews.clear();
    this.beamEnvSpace = null;
    this.beamAffine = null;
    this.beamUpright = null;
    this.boltGeoms.clear();
  }

  get viewCount(): number { return this.views.size; }

  /** 光柱视图数与本帧可见（真画了）的光柱数 */
  get beamStats(): { views: number; visible: number } {
    let visible = 0;
    for (const bv of this.beamViews.values()) if (bv.mesh.visible) visible++;
    return { views: this.beamViews.size, visible };
  }

  get drawCallCount(): number {
    let n = 0;
    for (const v of this.views.values()) {
      for (const m of v.buckets.values()) if (m.used > 0) n++;
      for (const m of v.plateBuckets.values()) if (m.used > 0) n++;
      for (const m of v.boltBuckets.values()) if (m.used > 0) n++;
    }
    for (const bv of this.beamViews.values()) if (bv.mesh.visible) n++;
    return n;
  }
}
