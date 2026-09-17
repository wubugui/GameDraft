/**
 * 世界空间粒子 / 群体模拟核心 —— **纯函数式、零 Pixi、零挂钟、定步长**。
 *
 * 三条前提（与轨迹系统同款）：
 * 1. **只吃传进来的 `dt`**，内部按固定子步 `VFX_SUBSTEP`（1/120 s）积分；同一份定义 + 同一串 dt
 *    + 同一个种子 ⇒ 逐位相同（无头验证逐帧断言靠它）。
 * 2. **所有量在 M-world、单位 wu / wu/s / wu/s²**（铁律 0：不在 q 里算任何"物理"）。地面、墙、
 *    画面换算只经 `VfxSpace`。
 * 3. **模块只随真实效果落地**：每个模块都有本仓库里一个真效果在用（蝙蝠 / 滴水 / 香火烟 / 萤火虫）。
 *
 * 结构：一个实例（`VfxInstanceSim`）= 若干发射器运行态（`VfxEmitterRuntime`），每个发射器一池
 * 结构化数组（SoA）。每子步：发射 → 力（重力 / 浮力 / 风 / 阻力 / 湍流 / 刺激场 / 群体三力 + 轨道 +
 * 避墙 + 高度）→ 积分 → 碰撞（地面 / 壳 / 子发射）→ 老化。群级状态机每帧一次。
 */
import type {
  VfxAnchorDef,
  VfxBeamDef,
  VfxCollisionResponse,
  VfxConfineDef,
  VfxEffectDef,
  VfxEmitterDef,
  VfxFieldDef,
  VfxFireSegment,
  VfxFlockBehaviorDef,
  VfxFlockState,
  VfxInstanceState,
} from '../../data/types';
import {
  consumeIfBurning, createPlateBurnState, PLATE_BURN_CONTACT_EVERY, resolvePlateBurnParams, stepPlateBurn,
  type PlateBurnParams, type PlateBurnState,
} from './vfxPlateBurn';
import { BURN_WU_PER_CM, type ResolvedBurnable } from '../../data/burnables';
import type { Vec3 } from '../../utils/sceneSpace';
import { sampleSceneWind, type SceneWindParams } from '../../utils/sceneWind';
import {
  buildConfineField, CONFINE_EXIT_FADE_S, CONFINE_EXIT_WEIGHT, confineHeightWeight, confineWeightAt,
  type ConfineField,
} from './vfxConfine';
import { curlNoise3 } from './vfxNoise';
import {
  createPlateArrays, launchPlate, placePlateOnSurface, resolvePlateParams, PLATE_GRAVITY,
  stepPlates, type PlateArrays, type PlateParams,
} from './vfxPlate';
import { VfxRng } from './vfxRandom';
import { pickAreaSurface, resolvePlateArea, type PlateArea } from './vfxSurface';
import { VfxParticleLifecycle } from './vfxLifecycle';
import { accumulateAirflow, accumulateFieldAcceleration, fieldFalloff, type VfxFieldRuntime } from './vfxFields';
import { emitterProgramErrors, resolveEmitterProgram, type VfxEmitterProgram } from './vfxProgram';
import { resolveKinematicContacts, type VfxKinematicContact } from './vfxContact';
import { ShellSide, spawnsBehindShell, thinShellSide, type VfxSpace } from './vfxSpace';
import {
  beamPulseFactor, effectBeamErrors, resolveBeam2dFrame, resolveBeam3dFrame, resolveBeamLook, sampleBeam2dPoint,
  sampleBeam3dPoint, type VfxBeam2dFrame, type VfxBeam3dFrame, type VfxBeamLook,
} from './vfxBeam';

export const VFX_SUBSTEP = 1 / 120;
export const VFX_MAX_SUBSTEPS = 12;
/** 瞬时刺激至少活这么久（秒），保证至少一批子步看得见它 */
export { VFX_PULSE_MIN_SECONDS, createFieldRuntime, type VfxFieldRuntime } from './vfxFields';
/** 群体避墙的前瞻时间（秒） */
const FLOCK_LOOKAHEAD_S = 0.35;
/** 飞行个体的最低速度（巡航的倍数）：蝙蝠不悬停 */
const FLOCK_MIN_SPEED_RATIO = 0.35;
/** 落巢判定半径（巢半径的倍数） */
const LAND_RADIUS_RATIO = 0.5;

/** 粒子模式 */
export const enum VfxParticleMode {
  Flying = 0,
  Roosting = 1,
  Stuck = 2,
}

export interface VfxParticles {
  cap: number;
  alive: Uint8Array;
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  age: Float32Array;
  /** 寿命（秒）；≤ 0 = 永生 */
  life: Float32Array;
  /** 基准尺寸（wu，已含抖动） */
  size: Float32Array;
  /** 0..1 个体种子（渲染的随机相位 / 镜像等） */
  seed: Float32Array;
  rot: Float32Array;
  spin: Float32Array;
  /** 动画相位（帧，小数） */
  phase: Float32Array;
  fear: Float32Array;
  /** 反应延迟倒计时；< 0 = 未启动 */
  reactLeft: Float32Array;
  /** 个性速度倍率 */
  cruiseMul: Float32Array;
  /** 轨道转向 ±1 */
  hand: Int8Array;
  mode: Uint8Array;
  /** 巢里的挂点（相对发射器原点） */
  hx: Float32Array; hy: Float32Array; hz: Float32Array;
  /** 上一子步的恐惧输入是否为零（用于重置反应延迟） */
  quietFor: Float32Array;
  /** 1 = 在遮挡物背后的空处（薄壳判据的滞回位，见 `thinShellSide`） */
  behind: Uint8Array;
  /** 粒子区域的淡入淡出系数（0..1，乘到透明度上）；不限定区域的实例恒 1 */
  fade: Float32Array;
  /** 每秒淡掉多少：> 0 淡出（淡完即回收）、< 0 淡入、0 不动 */
  fadeRate: Float32Array;
  liveCount: number;
}

/** 在飞的粒子整体平移（`moveAnchor` 的 followAnchor） */
function translateLive(p: VfxParticles, dx: number, dy: number, dz: number): void {
  if (dx === 0 && dy === 0 && dz === 0) return;
  for (let i = 0; i < p.cap; i++) {
    if (!p.alive[i]) continue;
    p.x[i] += dx; p.y[i] += dy; p.z[i] += dz;
  }
}

export function createParticles(cap: number): VfxParticles {
  const f = () => new Float32Array(cap);
  return {
    cap,
    alive: new Uint8Array(cap),
    x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(),
    age: f(), life: f(), size: f(), seed: f(), rot: f(), spin: f(), phase: f(),
    fear: f(), reactLeft: f(), cruiseMul: f(),
    hand: new Int8Array(cap), mode: new Uint8Array(cap),
    hx: f(), hy: f(), hz: f(), quietFor: f(),
    behind: new Uint8Array(cap),
    fade: new Float32Array(cap).fill(1), fadeRate: f(),
    liveCount: 0,
  };
}

export interface VfxPlayerContext {
  /** 玩家脚点 M-world */
  world: Vec3;
  /** 当前速度（wu/s） */
  speed: number;
}

export interface VfxStepContext {
  fields: readonly VfxFieldRuntime[];
  contacts?: readonly VfxKinematicContact[];
  player: VfxPlayerContext | null;
  /** 累计时间（秒），只给噪声做相位 */
  time: number;
  /**
   * 场景风（空气速度场，见 `utils/sceneWind`）；没有风的场景不给。
   * 普通粒子按自己的 `drag` 被它带着走（drag 就是对空气的线性阻力系数：dv = −drag·(v − u)），
   * 薄片按平板气动；群体不吃（它们自己会飞）。
   */
  wind?: SceneWindParams | null;
  /** 风的钟（秒）——与背景摆动同一个，所以两边同一拍 */
  windTime?: number;
  /**
   * 火焰段（M-world）：可燃物的火、手上燃着的火把、别的实例里燃着的纸。可燃薄片碰到会着（见 `vfxPlateBurn`）。
   * 同一实例里燃着的纸不用放进来（模拟自己算）。
   */
  fires?: readonly VfxFireSegment[];
}

/** 一组燃着的薄片（给燃烧系统：发火苗粒子、打火光、点可燃物） */
export interface VfxBurningPlateGroup {
  emitterIndex: number;
  params: PlateBurnParams;
  count: number;
  /** 每张 4 个数：x, y, z, 半尺寸（wu，已乘透视度量） */
  points: Float32Array;
  /** 一张纸的面积（cm²，真实量）：火苗发射率 / 火光强度按燃着的总面积算 */
  plateAreaCm2: number;
}

/** 实例级的额外输入（布置库里那条实例带的） */
export interface VfxInstanceOptions {
  /** 发射区域（画面坐标多边形）：`spawn.shape.kind = 'area'` 的发射器铺在这里、回收的从这里补回 */
  area?: [number, number][] | null;
  /** 范围区域的软边界（见 `VfxConfineDef`；范围区域 = `confine.area`，没写用发射区域） */
  confine?: VfxConfineDef | null;
  /**
   * 薄片绑的可燃物模板（id → 清洗后的模板，调用方先装好）。薄片 `plate.burnable.template` 查不到 / 不是面燃烧 ⇒ 这个发射器不可燃
   * （调用方负责出声）。
   */
  burnTemplates?: ReadonlyMap<string, ResolvedBurnable> | null;
}

export type VfxSimEvent =
  | { type: 'flockState'; emitter: string; from: VfxFlockState; to: VfxFlockState }
  | { type: 'sound'; emitter: string; sfx: string; at: Vec3 }
  | { type: 'field'; def: VfxFieldDef; at: Vec3 }
  | { type: 'hit'; emitter: string; at: Vec3 };

interface FlockRuntime {
  def: VfxFlockBehaviorDef;
  state: VfxFlockState;
  stateTime: number;
  calm: number;
  fearMean: number;
  /** 轨道中心（世界） */
  center: Vec3;
  /** 玩家是否在活动域内 */
  playerInRange: boolean;
  startled: boolean;
}

export interface VfxEmitterRuntime {
  def: VfxEmitterDef;
  program: VfxEmitterProgram;
  area: PlateArea;
  lifecycle: VfxParticleLifecycle;
  /** 发射器原点（世界） */
  origin: Vec3;
  p: VfxParticles;
  rng: VfxRng;
  timingRng: VfxRng;
  rateThreshold: number;
  elapsed: number;
  rateAcc: number;
  active: boolean;
  /** 子步累加器 */
  flock: FlockRuntime | null;
  /** 物理参数缓存 */
  gravity: number;
  drag: number;
  buoyancy: number;
  wind: Vec3 | null;
  turb: { strength: number; invScale: number; speed: number } | null;
  maxSpeed: number;
  /** 对刺激场的反应（非群体发射器；群体走 `flock.def.attitude`）。null = 只认 wind 场 */
  stim: { fear: Record<string, number> | null; attract: Record<string, number> | null; accel: number } | null;
  radius: number;
  /** 起播时的 burst 是否已发 */
  burstDone: boolean;
  /** 效果内 id → 发射器（子发射） */
  onHit: { emitter: string; count: number } | null;
  /** 薄片模块（纸钱 / 落叶）：挂了就走 `vfxPlate` 的模拟，不走通用粒子那条 */
  plate: { P: PlateParams; arr: PlateArrays; area: PlateArea } | null;
  /** 外部供点的出生点（`spawn.shape.kind = 'external'` 才有）：每点 4 个数 x, y, z, 半径 */
  external: { pts: Float32Array; count: number } | null;
  /** 可燃薄片的燃烧态（`plate.flammable` 才有） */
  burn: PlateBurnState | null;
}

/**
 * 光柱运行态（效果里的 `beams`）。光柱没有粒子池：只有开关、淡入淡出与按锚点解出来的帧；
 * 帧随锚点（跟随实例逐帧挪）懒重算，渲染与尘埃读同一份。
 */
export interface VfxBeamRuntime {
  def: VfxBeamDef;
  look: VfxBeamLook;
  index: number;
  /** 0..1：亮度起伏的相位种子（按实例种子 + 序号取，确定性） */
  seed: number;
  /** 开着（淡入 / 保持）还是关了（淡出） */
  active: boolean;
  /** 淡入淡出系数 0..1 */
  fade: number;
  /** 解出来的帧（按 `mode` 只有一个非 null；长度退化时两个都 null = 不画不出生） */
  frame3d: VfxBeam3dFrame | null;
  frame2d: VfxBeam2dFrame | null;
  /**
   * 落点（画面 wu）：3D = 终点正下方的地面点；2D = 锚点正下方的地面点。
   * `sort: depth` 按它的 y 参与实体排序；2D 的深度遮挡面立在这里。
   */
  foot: { x: number; y: number };
  /** 帧建于哪一次锚点位置（`VfxInstanceSim.anchorRev`） */
  frameRev: number;
}

interface HitEvent {
  emitter: string;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  count: number;
}

const tmpV = [0, 0, 0];
const NO_FIRES: readonly VfxFireSegment[] = [];
const tmpN = new Float32Array(3);
const tmpWind: Vec3 = [0, 0, 0];
const tmpAcceleration: Vec3 = [0, 0, 0];
const tmpScene = { x: 0, y: 0 };
const tmpFoot: Vec3 = [0, 0, 0];
const tmpBeamPoint: Vec3 = [0, 0, 0];
const tmpBeamScene = { x: 0, y: 0 };

function clampLen3(v: number[], max: number): void {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l > max && l > 1e-9) {
    const s = max / l;
    v[0] *= s; v[1] *= s; v[2] *= s;
  }
}

/** 效果里挑发射器（子发射引用） */
/**
 * 薄片的燃烧态：绑了面燃烧模板、且调用方装好了那份模板才有。查不到 / 是消耗燃烧 ⇒ 不可燃（null）。
 */
function plateBurnOf(
  plateDef: VfxEmitterDef['plate'] | null | undefined, cap: number, templates: ReadonlyMap<string, ResolvedBurnable> | null,
): PlateBurnState | null {
  const id = typeof plateDef?.burnable?.template === 'string' ? plateDef.burnable.template.trim() : '';
  if (!id || !templates) return null;
  const t = templates.get(id);
  if (!t || t.mode !== 'spread') return null;
  return createPlateBurnState(cap, resolvePlateBurnParams(t));
}

function findEmitter(list: VfxEmitterRuntime[], id: string): VfxEmitterRuntime | null {
  for (const e of list) if (e.def.id === id) return e;
  return null;
}

export class VfxInstanceSim {
  readonly emitters: VfxEmitterRuntime[] = [];
  /** 光柱（效果的 `beams`），见 {@link VfxBeamRuntime} */
  readonly beams: VfxBeamRuntime[] = [];
  /** 锚点位置版本：`moveAnchor` 每挪一次 +1，光柱帧据此懒重算 */
  private anchorRev = 0;
  readonly events: VfxSimEvent[] = [];
  private acc = 0;
  private hits: HitEvent[] = [];
  /** 发射率倍率（见 {@link setRateScale}）。1 = 按资产里写的速率发 */
  private rateScale = 1;
  /** 新生粒子大小倍率（见 {@link setSizeScale}） */
  private sizeScale = 1;
  /** 吃场景风的倍率（见 {@link setWindScale}） */
  private windScale = 1;
  /** `life.maxDistance` 的倍率（见 {@link setDistanceScale}） */
  private distanceScale = 1;
  /** 全局子步序号（薄片据此错开刷度量 / 查唤醒） */
  private substep = 0;
  /** 预热总子步数（`effect.prewarmSeconds` 按种子取样后折成子步）；0 = 不预热 */
  private prewarmTotal = 0;
  /** 已跑完的预热子步数 */
  private prewarmDone = 0;
  /** 预热的时间锚：第一次推进时的 `ctx.time / windTime`（= 预热结束那一刻）；分几片跑都按它排 */
  private prewarmAnchor: { time: number; windTime: number } | null = null;
  /**
   * 预热一个子步的工作量（发射器数 + 全部粒子槽位）。调用方按它切分帧预算：按槽位不按活着的只数，
   * 是上界、且不随模拟状态变 ⇒ 预算怎么切可复现（不读挂钟）。
   */
  readonly prewarmStepCost: number;
  /** 自起播累计秒 */
  time = 0;
  /** 粒子区域的权重网格（实例配了 `area` + `confine` 才有）；群体不吃 */
  readonly confine: ConfineField | null;

  constructor(
    readonly id: string,
    readonly effect: VfxEffectDef,
    readonly anchorWorld: Vec3,
    seed: number,
    readonly space: VfxSpace,
    readonly countScale = 1,
    readonly options: VfxInstanceOptions = {},
  ) {
    const warm = effect.prewarmSeconds;
    if (warm !== undefined) {
      if (!Array.isArray(warm) || warm.length !== 2 || !warm.every(Number.isFinite)
          || warm[0] < 0 || warm[1] < warm[0] || warm[1] > 15) {
        throw new Error('prewarmSeconds 必须为 0..15 秒的有序范围');
      }
      this.prewarmTotal = Math.floor(new VfxRng((seed ^ 0xa511e9b3) >>> 0).pair(warm, 0) / VFX_SUBSTEP);
    }
    this.confine = buildConfineField(options.area ?? null, options.confine ?? null);
    // 光柱先建：发射器的「光柱体积」出生形状 / 「被光柱照亮」要按 id 找它。形状与引用问题一次查全再抛
    const beamErrors = effectBeamErrors(effect, (em) => resolveEmitterProgram(em as unknown as VfxEmitterDef).solver);
    if (beamErrors.length) throw new Error(`VFX ${effect.id}: ${beamErrors.join('; ')}`);
    (effect.beams ?? []).forEach((def, i) => {
      this.beams.push({
        def, look: resolveBeamLook(def), index: i,
        seed: new VfxRng(((seed + i * 104729) ^ 0x2545f491) >>> 0).next(),
        active: true, fade: 0, frame3d: null, frame2d: null, foot: { x: 0, y: 0 }, frameRev: -1,
      });
    });
    effect.emitters.forEach((def, i) => {
      const cs = Math.max(0, countScale);
      const cap = Math.max(1, Math.round(def.spawn.max * cs));
      const off = def.offset ?? [0, 0, 0];
      const m = def.motion ?? {};
      const errors = emitterProgramErrors(def);
      if (errors.length) throw new Error(`VFX ${effect.id}/${def.id}: ${errors.join('; ')}`);
      const program = resolveEmitterProgram(def);
      const beh = program.solver === 'flock' ? def.behavior! : null;
      const origin: Vec3 = [anchorWorld[0] + off[0], anchorWorld[1] + off[1], anchorWorld[2] + off[2]];
      const plateDef = program.solver === 'plate' ? def.plate! : null;
      const shape = def.spawn.shape;
      const jitter = def.spawn.intervalJitter === undefined ? 0 : def.spawn.intervalJitter;
      if (!Number.isFinite(jitter) || jitter < 0 || jitter > 0.95) {
        throw new Error('spawn.intervalJitter 必须为 0..0.95');
      }
      // 节拍用独立随机流：不改变位置 / 寿命的随机序列，关闭时保持原模拟逐帧结果。
      const timingRng = new VfxRng(((seed + i * 7919) ^ 0x63d83595) >>> 0);
      const area = resolvePlateArea(space, origin, options.area ?? null,
        program.surfaceRadius ?? (shape?.kind === 'area' ? (shape.radius ?? 200) : 200), this.confine);
      const rt: VfxEmitterRuntime = {
        def,
        program,
        area,
        lifecycle: null!, // wired below, after particle arrays exist
        origin,
        p: createParticles(cap),
        rng: new VfxRng((seed + i * 7919) >>> 0),
        timingRng,
        rateThreshold: jitter ? timingRng.range(1 - jitter, 1 + jitter) : 1,
        elapsed: 0,
        rateAcc: 0,
        active: !def.subOnly,
        flock: beh ? {
          def: beh,
          state: beh.initialState ?? 'roosting',
          stateTime: 0, calm: 0, fearMean: 0,
          center: [anchorWorld[0] + off[0], anchorWorld[1] + off[1], anchorWorld[2] + off[2]],
          playerInRange: false, startled: false,
        } : null,
        gravity: m.gravity ?? 0,
        drag: m.drag ?? 0,
        buoyancy: m.buoyancy ?? 0,
        wind: m.wind ? [m.wind[0], m.wind[1], m.wind[2]] : null,
        turb: m.turbulence ? {
          strength: m.turbulence.strength,
          invScale: 1 / Math.max(m.turbulence.scale, 1e-3),
          speed: m.turbulence.speed ?? 0.3,
        } : null,
        maxSpeed: m.maxSpeed ?? (beh ? beh.max : Infinity),
        // 群体已经有 attitude 那一套（反应延迟 / 恐惧累积 / 状态机），不许两条路同时推同一群
        stim: (!beh && m.stimulus) ? {
          fear: m.stimulus.fear ?? null,
          attract: m.stimulus.attract ?? null,
          accel: m.stimulus.accel,
        } : null,
        radius: def.collision?.radiusWu ?? Math.max(1, def.appearance.sizeWu * 0.5),
        burstDone: false,
        onHit: def.collision?.onHit ?? null,
        plate: plateDef ? {
          P: resolvePlateParams(plateDef),
          arr: createPlateArrays(cap),
          area,
        } : null,
        external: shape?.kind === 'external' ? { pts: new Float32Array(0), count: 0 } : null,
        burn: plateBurnOf(plateDef, cap, options.burnTemplates ?? null),
      };
      rt.lifecycle = new VfxParticleLifecycle({
        space, area, body: rt.p, rng: rt.rng, policy: program.recycle,
        detectLoss: program.solver === 'plate' || program.recycle.mode !== 'none',
        clampDeadFade: program.solver === 'plate',
        fallSpeed: rt.plate ? Math.sqrt(PLATE_GRAVITY / rt.plate.P.kn) : 90,
        place: (index, surface) => this.placeOnSurface(rt, index, surface),
        launch: (index, at, velocity) => this.launch(rt, index, at, velocity),
        // 燃着的纸被回收器挪走 = 这一格作废（它不会以一张新纸的样子回来）
        consume: rt.burn ? (index) => consumeIfBurning(rt.burn!, index) : undefined,
      });
      this.emitters.push(rt);
      // 群体：起播即把整群摆进巢（roosting）或直接放飞（airborne）
      if (rt.flock) this.populateFlock(rt);
    });
    let cost = this.emitters.length;
    for (const e of this.emitters) cost += e.p.cap;
    this.prewarmStepCost = Math.max(1, cost);
  }

  /** 实例状态（条件叶 `vfxState`）：有群体模块取第一群的状态，否则 active/inactive */
  get state(): VfxInstanceState {
    for (const e of this.emitters) if (e.flock) return e.flock.state;
    return this.emitters.some((e) => e.active) || this.beams.some((b) => b.active) ? 'active' : 'inactive';
  }

  /** 光柱全关且淡完了（没有光柱恒 true）。`VfxSystem` 等它才收掉"正在淡出"的模拟 */
  get beamsDark(): boolean {
    for (const b of this.beams) if (b.active || b.fade > 0) return false;
    return true;
  }

  /** 按 id 找光柱 */
  beamById(id: string): VfxBeamRuntime | null {
    for (const b of this.beams) if (b.def.id === id) return b;
    return null;
  }

  /**
   * 光柱此刻的帧（锚点动过就重算）。3D：锚点 = 实例锚点世界点；2D：锚点投到画面上那一点。
   * 落点：3D 取终点正下方地面、2D 取锚点正下方地面（投到画面）。
   */
  beamFrame(b: VfxBeamRuntime): VfxBeamRuntime {
    if (b.frameRev === this.anchorRev) return b;
    b.frameRev = this.anchorRev;
    const a = this.anchorWorld;
    const sp = this.space;
    if (b.def.mode === '3d' && b.def.shape3d) {
      b.frame3d = resolveBeam3dFrame(b.def.shape3d, a);
      b.frame2d = null;
      const f = b.frame3d;
      const ex = f ? f.origin[0] + f.axis[0] * f.length : a[0];
      const ez = f ? f.origin[2] + f.axis[2] * f.length : a[2];
      tmpFoot[0] = ex; tmpFoot[1] = sp.groundY(ex, ez); tmpFoot[2] = ez;
      sp.toScene(tmpFoot, tmpBeamScene);
      b.foot.x = tmpBeamScene.x; b.foot.y = tmpBeamScene.y;
    } else if (b.def.mode === '2d' && b.def.shape2d) {
      sp.toScene(a, tmpBeamScene);
      b.frame2d = resolveBeam2dFrame(b.def.shape2d, tmpBeamScene);
      b.frame3d = null;
      tmpFoot[0] = a[0]; tmpFoot[1] = sp.groundY(a[0], a[2]); tmpFoot[2] = a[2];
      sp.toScene(tmpFoot, tmpBeamScene);
      b.foot.x = tmpBeamScene.x; b.foot.y = tmpBeamScene.y;
    } else {
      b.frame3d = null; b.frame2d = null;
    }
    return b;
  }

  /** 光柱此刻的亮度起伏倍率（模拟钟 + 光柱种子） */
  beamPulse(b: VfxBeamRuntime): number {
    return beamPulseFactor(b.def.pulse, this.time, b.seed);
  }

  /** 光柱体积里取一个世界点（尘埃出生）；2D 光带立在锚点脚下那一深度的直立面上 */
  private sampleInBeam(b: VfxBeamRuntime, rng: VfxRng, along: readonly [number, number], out: Vec3): boolean {
    this.beamFrame(b);
    const next = () => rng.next();
    if (b.frame3d) return sampleBeam3dPoint(b.frame3d, next, along, out);
    if (b.frame2d && this.space.uprightWorldAtScene) {
      if (!sampleBeam2dPoint(b.frame2d, next, along, tmpBeamScene)) return false;
      const w = this.space.uprightWorldAtScene(b.foot.x, b.foot.y, tmpBeamScene.x, tmpBeamScene.y);
      out[0] = w[0]; out[1] = w[1]; out[2] = w[2];
      return true;
    }
    return false;
  }

  /** 光柱淡入淡出（每帧一次，按真实 dt；`fadeIn/fadeOut` 为 0 = 当拍到位） */
  private stepBeams(dt: number): void {
    for (const b of this.beams) {
      const target = b.active ? 1 : 0;
      if (b.fade === target) continue;
      const secs = b.active ? b.look.fadeIn : b.look.fadeOut;
      const step = secs > 1e-6 ? dt / secs : 1;
      b.fade = target > b.fade ? Math.min(1, b.fade + step) : Math.max(0, b.fade - step);
    }
  }

  /**
   * 放完了：没有群体、每个发射器都不会再发（活跃时长过了 / 只有 burst 且已发 / 只靠撞击子发射），且一颗活的都没有。
   * 一次性效果据此自己收（`VfxSystem` 的 oneShot 实例）。还没跑过一步不算放完。
   */
  get finished(): boolean {
    if (this.time <= 0 || this.prewarmRemaining > 0) return false;
    if (!this.beamsDark) return false;
    for (const e of this.emitters) {
      if (e.flock) return false;
      const s = e.def.spawn;
      const willEmit = e.active && !e.def.subOnly && (!e.burstDone || (s.rate ?? 0) > 0);
      if (willEmit) return false;
    }
    return this.liveCount === 0;
  }

  get liveCount(): number {
    let n = 0;
    for (const e of this.emitters) n += e.p.liveCount;
    return n;
  }

  /**
   * 粒子区域的现场统计（调试面板 / 无头验证读；没限定区域 ⇒ null）。
   * 分档看的是正下方地面点的权重：深处 = 1，边带 = (出框阈值, 1)，框外 = 其余。
   * "框外可见"只数淡出系数 > 0.05 的——淡出中的纸压在框线外一点点是设计内的。
   */
  confineStats(): { inner: number; band: number; outsideVisible: number; fading: number } | null {
    const cf = this.confine;
    if (!cf) return null;
    let inner = 0, band = 0, outsideVisible = 0, fading = 0;
    for (const e of this.emitters) {
      if (e.flock) continue;
      const p = e.p;
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i]) continue;
        tmpFoot[0] = p.x[i]; tmpFoot[1] = this.space.groundY(p.x[i], p.z[i]); tmpFoot[2] = p.z[i];
        this.space.toScene(tmpFoot, tmpScene);
        const w = confineWeightAt(cf, tmpScene.x, tmpScene.y);
        if (p.fadeRate[i] > 0) fading++;
        if (w >= 1) inner++;
        else if (w >= CONFINE_EXIT_WEIGHT) band++;
        else if (p.fade[i] > 0.05) outsideVisible++;
      }
    }
    return { inner, band, outsideVisible, fading };
  }

  /** 群质心（声源位置用）；没活粒子返回锚点 */
  centroid(out: Vec3): Vec3 {
    let n = 0;
    let sx = 0, sy = 0, sz = 0;
    for (const e of this.emitters) {
      const p = e.p;
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i]) continue;
        sx += p.x[i]; sy += p.y[i]; sz += p.z[i]; n++;
      }
    }
    if (n === 0) { out[0] = this.anchorWorld[0]; out[1] = this.anchorWorld[1]; out[2] = this.anchorWorld[2]; return out; }
    out[0] = sx / n; out[1] = sy / n; out[2] = sz / n;
    return out;
  }

  /** 外部强制群状态（`setVfxState` 动作 / 调试） */
  setFlockState(state: VfxFlockState): void {
    for (const e of this.emitters) if (e.flock) this.transition(e, state);
  }

  /**
   * 跟随：把锚点整体挪到 `world`（手持火把的火焰跟着手走）。
   *
   * **已经发射出去的粒子默认留在原地**——烟和火星离手就归空气管，跟着人跑才是错的。
   * 挪的是各发射器的原点（与巢心），所以下一颗生在新位置。在飞的粒子按发射器的 `motion.followAnchor`：
   * - `rig`：平移 `carry`（M-world wu）——手持挂件"动画带出来的"那部分位移（转身翻面、换姿势、逐帧动画换帧），
   *   不是火把真的划过去；火舌不带就原地留"鬼火"、断成珠子。宿主走路那一份不在 carry 里，拖尾照留；
   * - `full`：平移锚点的整个位移（粘在发射面上的余烬红光）；
   * - `none`（缺省）：不动。烟也带上的话，飘出几百 wu 的整条烟柱会跟着手一步一晃（2026-09-15 真跑抓到）。
   *
   * ⚠ 薄片（`plate`）的 `area` 是构造时按原点解出来的贴附面，这里**不重解**：
   * 薄片是躺在地上的纸钱那一档，本来就不该挂在会动的东西上。
   */
  moveAnchor(world: Vec3, carry: Vec3 | null = null): void {
    const dx = world[0] - this.anchorWorld[0];
    const dy = world[1] - this.anchorWorld[1];
    const dz = world[2] - this.anchorWorld[2];
    if (dx === 0 && dy === 0 && dz === 0 && !carry) return;
    this.anchorWorld[0] = world[0];
    this.anchorWorld[1] = world[1];
    this.anchorWorld[2] = world[2];
    // 光柱整根跟着锚点走（它是挂在锚点上的几何，没有"在飞的"那一说）
    if (dx !== 0 || dy !== 0 || dz !== 0) this.anchorRev++;
    for (const e of this.emitters) {
      this.translateEmitterOrigin(e, dx, dy, dz);
      // 薄片与群体不跟：它们本来就不挂在会动的东西上
      if (e.plate || e.flock) continue;
      const follow = e.def.motion?.followAnchor;
      if (follow === 'full') translateLive(e.p, dx, dy, dz);
      else if (follow === 'rig' && carry) translateLive(e.p, carry[0], carry[1], carry[2]);
    }
  }

  /** Authoring preview changes future emission without rewriting live particle positions. */
  moveEmitterOrigin(id: string, world: Vec3): void {
    const e = this.emitters.find(e => e.def.id === id);
    if (e) this.translateEmitterOrigin(e, world[0] - e.origin[0], world[1] - e.origin[1], world[2] - e.origin[2]);
  }

  private translateEmitterOrigin(e: VfxEmitterRuntime, dx: number, dy: number, dz: number): void {
    if (dx === 0 && dy === 0 && dz === 0) return;
    e.origin[0] += dx; e.origin[1] += dy; e.origin[2] += dz;
    // Authored polygons stay in scene space. An unplaced disc follows its emitter.
    if (e.area.disc) Object.assign(e.area, resolvePlateArea(this.space, e.origin, null, e.area.disc.r));
    if (e.flock) { e.flock.center[0] += dx; e.flock.center[1] += dy; e.flock.center[2] += dz; }
  }

  /**
   * 发射率倍率（手持火把的燃烧强度驱动；0 = 不再发）。
   *
   * 为什么不做成 `countScale`：那个是构造时折进池容量的，改不动；
   * 这个只乘在**每一拍的发射速率**上，池容量不变（所以不会突然申请一大块）。
   * 非有限值或负数一律当 1 —— 一个 NaN 进来会让发射器**永远不再发**且零报错。
   * **0 是合法的**：火把燃烧强度降到 0 = 不再发，在飞的自然烧完（火苗是这样灭的）。
   */
  setRateScale(k: number): void {
    this.rateScale = Number.isFinite(k) && k >= 0 ? k : 1;
  }

  /**
   * 新生粒子的大小倍率（火把燃烧强度 → 火苗大小）。**只乘出生那一刻**：在飞的粒子不跟着缩放——
   * 火苗变小是新烧出来的火舌变小，不是整团火突然瘪下去。非有限 / 负数当 1。
   */
  setSizeScale(k: number): void {
    this.sizeScale = Number.isFinite(k) && k >= 0 ? k : 1;
  }

  /**
   * 吃场景风的倍率（手持火把护火 = 挡风）：乘在场景风经阻力作用于粒子的那一项上（普通粒子与薄片同一处），
   * 不碰发射器自己的恒定风、刺激场与 airflow 场。非有限 / 负数当 1。
   */
  setWindScale(k: number): void {
    this.windScale = Number.isFinite(k) && k >= 0 ? k : 1;
  }

  /**
   * `life.maxDistance` 的倍率（手持火把：燃烧强度越低、风越大，火焰越短）。**对在飞的粒子也立刻生效**——
   * 火焰长度是此刻的燃烧状况决定的。非有限 / ≤0 当 1。
   */
  setDistanceScale(k: number): void {
    this.distanceScale = Number.isFinite(k) && k > 0 ? k : 1;
  }

  /** 停：所有发射器不再发（在飞的自然老化；永生的整批清掉） */
  stop(): void {
    for (const e of this.emitters) {
      e.active = false;
      if (!e.def.life?.seconds) this.clear(e);
    }
    // 光柱按 fadeOut 淡掉（不当场消失）
    for (const b of this.beams) b.active = false;
  }

  /** 开（或重开） */
  start(): void {
    for (const b of this.beams) b.active = true;
    for (const e of this.emitters) {
      if (e.def.subOnly) continue;
      e.active = true;
      e.elapsed = 0;
      e.burstDone = false;
      if (e.flock) this.populateFlock(e);
    }
  }

  private clear(e: VfxEmitterRuntime): void {
    e.p.alive.fill(0);
    e.p.liveCount = 0;
  }

  // ------------------------------------------------------------------ 燃烧（外部供点 / 可燃薄片）

  /**
   * 外部供点：给本实例所有 `external` 形状的发射器换一批出生点（每点 x, y, z, 半径；共 `count` 个）。
   * 数组被拷走，调用方可复用自己的缓冲。`count = 0` = 没有点、不发。
   */
  setSpawnPoints(pts: Float32Array, count: number): void {
    const n = Math.max(0, Math.min(count | 0, Math.floor(pts.length / 4)));
    for (const e of this.emitters) {
      if (!e.external) continue;
      if (e.external.pts.length < n * 4) e.external.pts = new Float32Array(Math.max(n * 4, 64));
      e.external.pts.set(pts.subarray(0, n * 4));
      e.external.count = n;
    }
  }

  /** 此刻燃着的可燃薄片（逐发射器一组；没有燃着的发射器不出） */
  burningPlates(out: VfxBurningPlateGroup[]): VfxBurningPlateGroup[] {
    out.length = 0;
    this.emitters.forEach((e, emitterIndex) => {
      const S = e.burn;
      const pl = e.plate;
      if (!S || !pl || S.burning <= 0) return;
      const points = new Float32Array(S.burning * 4);
      const half = (pl.P.w + pl.P.h) / 4;
      let k = 0;
      for (let i = 0; i < e.p.cap && k < S.burning; i++) {
        if (!e.p.alive[i] || S.burnT[i] < 0) continue;
        points[k * 4] = e.p.x[i]; points[k * 4 + 1] = e.p.y[i]; points[k * 4 + 2] = e.p.z[i];
        points[k * 4 + 3] = half * Math.max(pl.arr.metric[i] || 1, 1e-6);
        k++;
      }
      out.push({
        emitterIndex, params: S.P, count: k, points: points.subarray(0, k * 4),
        plateAreaCm2: (pl.P.w / BURN_WU_PER_CM) * (pl.P.h / BURN_WU_PER_CM),
      });
    });
    return out;
  }

  /** 取走自上次以来烧没了的槽位（逐发射器）；给存档 */
  takeNewlyBurnt(): { emitterIndex: number; slots: number[] }[] {
    const out: { emitterIndex: number; slots: number[] }[] = [];
    this.emitters.forEach((e, emitterIndex) => {
      if (!e.burn || e.burn.newlyBurnt.length === 0) return;
      out.push({ emitterIndex, slots: e.burn.newlyBurnt.splice(0) });
    });
    return out;
  }

  /** 此刻燃着的槽位（离场 / 存档那一刻它们推不出来 ⇒ 算烧没了） */
  burningSlots(): { emitterIndex: number; slots: number[] }[] {
    const out: { emitterIndex: number; slots: number[] }[] = [];
    this.emitters.forEach((e, emitterIndex) => {
      const S = e.burn;
      if (!S) return;
      const slots: number[] = [];
      for (let i = 0; i < e.p.cap; i++) if (e.p.alive[i] && S.burnT[i] >= 0) slots.push(i);
      if (slots.length) out.push({ emitterIndex, slots });
    });
    return out;
  }

  /**
   * 读档 / 进场时恢复"烧没了的那几张"：标作废、活着的当场收掉。起播铺撒时仍按原来的次序给它们抽位置再收掉，
   * 其余纸的位置与没烧过时逐位相同（抽签序列不因少了几张而错位）。
   */
  applyBurntSlots(emitterIndex: number, slots: readonly number[]): void {
    const e = this.emitters[emitterIndex];
    if (!e?.burn) return;
    for (const s of slots) {
      if (!Number.isInteger(s) || s < 0 || s >= e.p.cap) continue;
      e.burn.burnt[s] = 1;
      e.burn.burnT[s] = -1;
      if (e.p.alive[s]) { e.p.alive[s] = 0; e.p.liveCount--; }
    }
  }

  /** 燃着的纸作为火焰段（给别的实例 / 燃烧系统用）；竖直向上 `flameLength` */
  plateFireSegments(out: VfxFireSegment[]): void {
    for (const e of this.emitters) {
      const S = e.burn;
      const pl = e.plate;
      if (!S || !pl || S.burning <= 0) continue;
      const half = (pl.P.w + pl.P.h) / 4;
      for (let i = 0; i < e.p.cap; i++) {
        if (!e.p.alive[i] || S.burnT[i] < 0) continue;
        const r = half * Math.max(pl.arr.metric[i] || 1, 1e-6);
        out.push({ x: e.p.x[i], y: e.p.y[i], z: e.p.z[i], ax: 0, ay: 1, az: 0, len: S.P.flameLenWu, r });
      }
    }
  }

  /** 起播铺撒填进了作废槽位的那几张：收掉（不算新烧没的） */
  private killBurntAlive(e: VfxEmitterRuntime): void {
    const S = e.burn;
    if (!S) return;
    for (let i = 0; i < e.p.cap; i++) {
      if (S.burnt[i] && e.p.alive[i]) { e.p.alive[i] = 0; e.p.liveCount--; }
    }
  }

  /** 起播铺撒期间允许把作废槽位也填上（保持抽签次序），铺完再收掉 */
  private burstFill = false;

  // ------------------------------------------------------------------ 发射

  private spawnOne(e: VfxEmitterRuntime, ox: number, oy: number, oz: number, dir: readonly number[] | null): number {
    const p = e.p;
    let i = -1;
    const burnt = e.burn && !this.burstFill ? e.burn.burnt : null;
    for (let k = 0; k < p.cap; k++) if (!p.alive[k] && !(burnt && burnt[k])) { i = k; break; }
    if (i < 0) return -1;
    const d = e.def;
    const rng = e.rng;
    const sh = d.spawn.shape ?? { kind: 'point' as const };
    let sx = ox, sy = oy, sz = oz;
    if (sh.kind === 'external') {
      // 外部供点：没有点就不发（-2：不是池满，发射率照常消耗）
      const ext = e.external;
      if (!ext || ext.count <= 0) return -2;
      const k = Math.min(ext.count - 1, Math.floor(rng.next() * ext.count));
      const o = k * 4;
      rng.unitVector(tmpV);
      const r = ext.pts[o + 3] * (sh.jitter ?? 1) * Math.cbrt(rng.next());
      // 点是世界坐标；发射器的 offset 照样加上（烟从火苗上方一截起）
      const off = d.offset;
      sx = ext.pts[o] + tmpV[0] * r + (off ? off[0] : 0);
      sy = ext.pts[o + 1] + tmpV[1] * r + (off ? off[1] : 0);
      sz = ext.pts[o + 2] + tmpV[2] * r + (off ? off[2] : 0);
    } else if (sh.kind === 'sphere') {
      rng.unitVector(tmpV);
      const r = sh.radius * Math.cbrt(rng.next());
      sx += tmpV[0] * r; sy += tmpV[1] * r; sz += tmpV[2] * r;
    } else if (sh.kind === 'disc') {
      const a = rng.range(0, Math.PI * 2);
      const r = sh.radius * Math.sqrt(rng.next());
      sx += Math.cos(a) * r; sz += Math.sin(a) * r;
    } else if (sh.kind === 'box') {
      sx += rng.range(-0.5, 0.5) * sh.size[0];
      sy += rng.range(-0.5, 0.5) * sh.size[1];
      sz += rng.range(-0.5, 0.5) * sh.size[2];
    } else if (sh.kind === 'line') {
      const t = rng.next();
      sx += sh.to[0] * t; sy += sh.to[1] * t; sz += sh.to[2] * t;
    } else if (sh.kind === 'beam') {
      // 光柱体积：位置全由光柱定（offset 不参与）；光柱退化 / 2D 光带立不起直立面 = 不发（发射率照常消耗）
      const b = this.beamById(sh.beam);
      if (!b || !this.sampleInBeam(b, rng, sh.along ?? [0, 1], tmpBeamPoint)) return -2;
      sx = tmpBeamPoint[0]; sy = tmpBeamPoint[1]; sz = tmpBeamPoint[2];
    }
    const speed = rng.pair(d.spawn.speed, 0);
    let dx = 0, dy = 0, dz = 0;
    const baseDir = dir ?? d.spawn.direction ?? null;
    if (baseDir) {
      const l = Math.hypot(baseDir[0], baseDir[1], baseDir[2]) || 1;
      const nd = [baseDir[0] / l, baseDir[1] / l, baseDir[2] / l];
      const spread = ((d.spawn.spread ?? 0) * Math.PI) / 180;
      rng.coneVector(nd, spread, tmpV);
      dx = tmpV[0]; dy = tmpV[1]; dz = tmpV[2];
    } else {
      rng.unitVector(tmpV);
      dx = tmpV[0]; dy = tmpV[1]; dz = tmpV[2];
    }
    p.alive[i] = 1;
    p.x[i] = sx; p.y[i] = sy; p.z[i] = sz;
    p.vx[i] = dx * speed; p.vy[i] = dy * speed; p.vz[i] = dz * speed;
    p.age[i] = 0;
    p.life[i] = d.life?.seconds ? rng.pair(d.life.seconds, 1) : 0;
    p.size[i] = d.appearance.sizeWu * rng.pair(d.appearance.sizeJitter, 1) * this.sizeScale;
    p.seed[i] = rng.next();
    p.rot[i] = d.appearance.spin?.randomPhase ? rng.range(0, Math.PI * 2) : 0;
    p.spin[i] = d.appearance.spin ? (rng.pair(d.appearance.spin.rate, 0) * Math.PI) / 180 : 0;
    p.phase[i] = rng.next() * 8;
    p.fear[i] = 0;
    p.reactLeft[i] = -1;
    p.quietFor[i] = 0;
    const beh = e.flock?.def;
    p.cruiseMul[i] = beh ? 1 + rng.range(-1, 1) * (beh.speedJitter ?? 0) : 1;
    p.hand[i] = beh
      ? (beh.orbit.handedness === 'cw' ? 1 : beh.orbit.handedness === 'ccw' ? -1 : (rng.next() < 0.5 ? 1 : -1))
      : 1;
    p.mode[i] = VfxParticleMode.Flying;
    p.hx[i] = 0; p.hy[i] = 0; p.hz[i] = 0;
    p.behind[i] = spawnsBehindShell(this.space, sx, sy, sz) ? 1 : 0;
    p.fade[i] = 1;
    p.fadeRate[i] = 0;
    p.liveCount++;
    return i;
  }

  /** 群体：按容量把整群摆好（roosting 挂在巢里 / airborne 在巢周围放飞） */
  private populateFlock(e: VfxEmitterRuntime): void {
    this.clear(e);
    const beh = e.def.behavior!;
    const fl = e.flock!;
    const n = e.p.cap;
    // 巢在崖壁上时，以原点为心的随机球有一半埋在石头里——那些个体被遮挡、永远看不见
    // （实测崖墓前段 60 只里 11 只）。把整团沿壳法线推出去半个巢半径，球就贴在面前面。
    const nest: Vec3 = [0, 0, 0];
    const contact = this.space.shellContact(e.origin[0], e.origin[1], e.origin[2]);
    if (contact && !contact.groundLike) {
      const nr = beh.home.nestRadius;
      nest[0] = contact.normal[0] * nr; nest[1] = contact.normal[1] * nr; nest[2] = contact.normal[2] * nr;
    }
    for (let k = 0; k < n; k++) {
      const i = this.spawnOne(e, e.origin[0], e.origin[1], e.origin[2], null);
      if (i < 0) break;
      const p = e.p;
      e.rng.unitVector(tmpV);
      const r = beh.home.nestRadius * 0.75 * Math.cbrt(e.rng.next());
      p.hx[i] = nest[0] + tmpV[0] * r; p.hy[i] = nest[1] + tmpV[1] * r; p.hz[i] = nest[2] + tmpV[2] * r;
      if (fl.state === 'roosting') {
        p.x[i] = e.origin[0] + p.hx[i]; p.y[i] = e.origin[1] + p.hy[i]; p.z[i] = e.origin[2] + p.hz[i];
        p.vx[i] = 0; p.vy[i] = 0; p.vz[i] = 0;
        p.mode[i] = VfxParticleMode.Roosting;
      } else {
        p.x[i] = e.origin[0] + p.hx[i] * 2; p.y[i] = e.origin[1] + p.hy[i] + beh.minAltitude; p.z[i] = e.origin[2] + p.hz[i] * 2;
        e.rng.unitVector(tmpV);
        p.vx[i] = tmpV[0] * beh.cruise; p.vy[i] = Math.abs(tmpV[1]) * beh.cruise * 0.3; p.vz[i] = tmpV[2] * beh.cruise;
        p.mode[i] = VfxParticleMode.Flying;
      }
      p.behind[i] = spawnsBehindShell(this.space, p.x[i], p.y[i], p.z[i]) ? 1 : 0;
    }
    fl.stateTime = 0;
    fl.calm = 0;
    fl.fearMean = 0;
    e.burstDone = true;
  }

  private emitStep(e: VfxEmitterRuntime, h: number): void {
    if (!e.active || e.flock) return;
    const s = e.def.spawn;
    if (s.duration !== undefined && e.elapsed > s.duration) { e.active = false; return; }
    if (!e.burstDone) {
      e.burstDone = true;
      const n = Math.round((s.burst ?? 0) * this.countScale);
      this.burstFill = true;
      try {
        for (let k = 0; k < n; k++) if (this.spawnEmit(e) === -1) break;
      } finally {
        this.burstFill = false;
      }
      this.killBurntAlive(e);
    }
    if (s.rate) {
      e.rateAcc += s.rate * this.countScale * this.rateScale * h;
      while (e.rateAcc >= e.rateThreshold) {
        e.rateAcc -= e.rateThreshold;
        const jitter = s.intervalJitter ?? 0;
        e.rateThreshold = jitter ? e.timingRng.range(1 - jitter, 1 + jitter) : 1;
        if (this.spawnEmit(e) === -1) { e.rateAcc = 0; break; }
      }
    }
  }

  /** Emission owns placement; solver initializers only establish physical state. */
  private spawnEmit(e: VfxEmitterRuntime): number {
    if (e.program.spawnPlacement === 'surface') {
      const surf = pickAreaSurface(this.space, e.area, e.rng);
      if (!surf) return -2;
      const i = this.spawnOne(e, surf.p[0], surf.p[1], surf.p[2], null);
      if (i < 0) return -1;
      const p = e.p;
      this.placeOnSurface(e, i, surf, e.program.initialVelocity === 'rest' ? undefined : [p.vx[i], p.vy[i], p.vz[i]]);
      return i;
    }
    return this.spawnAt(e, e.origin[0], e.origin[1], e.origin[2], null);
  }

  private spawnAt(e: VfxEmitterRuntime, x: number, y: number, z: number, dir: readonly number[] | null): number {
    const i = this.spawnOne(e, x, y, z, dir);
    if (i >= 0 && e.program.initialVelocity === 'rest') e.p.vx[i] = e.p.vy[i] = e.p.vz[i] = 0;
    if (i >= 0 && e.plate) {
      const p = e.p;
      this.launch(e, i, [p.x[i], p.y[i], p.z[i]], [p.vx[i], p.vy[i], p.vz[i]]);
    }
    return i;
  }

  private placeOnSurface(e: VfxEmitterRuntime, i: number, surf: NonNullable<ReturnType<typeof pickAreaSurface>>, velocity?: Vec3): void {
    const pl = e.plate;
    if (pl) { placePlateOnSurface(pl.P, pl.arr, e.p, i, this.space, e.rng, surf, velocity); return; }
    const p = e.p, n = surf.normal;
    p.x[i] = surf.p[0] + n[0] * e.radius;
    p.y[i] = surf.p[1] + n[1] * e.radius;
    p.z[i] = surf.p[2] + n[2] * e.radius;
    p.vx[i] = velocity?.[0] ?? 0; p.vy[i] = velocity?.[1] ?? 0; p.vz[i] = velocity?.[2] ?? 0;
    p.mode[i] = VfxParticleMode.Flying; p.behind[i] = 0;
  }

  private launch(e: VfxEmitterRuntime, i: number, at: Vec3, velocity: Vec3): void {
    const pl = e.plate;
    if (pl) { launchPlate(pl.P, pl.arr, e.p, i, this.space, e.rng, at, velocity); return; }
    const p = e.p;
    p.x[i] = at[0]; p.y[i] = at[1]; p.z[i] = at[2];
    p.vx[i] = velocity[0]; p.vy[i] = velocity[1]; p.vz[i] = velocity[2];
    p.mode[i] = VfxParticleMode.Flying;
    p.behind[i] = spawnsBehindShell(this.space, at[0], at[1], at[2]) ? 1 : 0;
  }

  // ------------------------------------------------------------------ 主步

  /** 还没跑完的预热子步数（0 = 不预热或已跑完）。还在预热的模拟是"过去"，不该被画、也不该正常推进 */
  get prewarmRemaining(): number {
    return this.prewarmTotal - this.prewarmDone;
  }

  /**
   * 推进预热最多 `maxSteps` 个子步，返回实际跑了几步。
   *
   * 时间锚在第一次推进时定（那一刻的 `ctx.time` = 预热结束的时刻），之后各片都按它排——
   * 分几片、每片多少步，结果与一口气跑完逐位相同（只要各片给的风参数相同）。
   * 只模拟过去的环境：不能把此刻玩家 / 脚步 / 刺激重复施加到过去，也不补播过去的事件（跑完清空）。
   *
   * 为什么要能分片：预热原来在第一次 `step` 里一口气补完，茶馆 30 个实例（雾 6–12 秒 = 每个上千子步）
   * 挤在同一帧里，实测这一帧 361 ms。`VfxSystem` 在揭幕遮罩下把它跑完，来不及的按帧预算接着跑。
   */
  advancePrewarm(ctx: VfxStepContext, maxSteps: number): number {
    const remaining = this.prewarmTotal - this.prewarmDone;
    const n = Math.min(remaining, Math.floor(maxSteps));
    if (!(n > 0)) return 0;
    const anchor = this.prewarmAnchor ??= { time: ctx.time, windTime: ctx.windTime ?? ctx.time };
    const quiet: VfxStepContext = { ...ctx, player: null, contacts: [], fields: [] };
    const steps = this.prewarmTotal;
    for (let k = 0; k < n; k++) {
      const offset = (this.prewarmDone - steps + 1) * VFX_SUBSTEP;
      this.prewarmDone++;
      quiet.time = anchor.time + offset;
      quiet.windTime = anchor.windTime + offset;
      this.stepCore(VFX_SUBSTEP, quiet);
    }
    this.events.length = 0;
    return n;
  }

  step(dt: number, ctx: VfxStepContext): void {
    if (!(dt > 0)) return;
    // 直接调用方（测试 / 自检）没分片：第一次推进时一口气补完。VfxSystem 会先按预算跑完再调 step。
    if (this.prewarmDone < this.prewarmTotal) this.advancePrewarm(ctx, this.prewarmTotal);
    this.stepCore(dt, ctx);
  }

  private stepCore(dt: number, ctx: VfxStepContext): void {
    this.events.length = 0;
    this.stepBeams(Math.min(dt, VFX_MAX_SUBSTEPS * VFX_SUBSTEP));
    this.acc += dt;
    let n = Math.floor(this.acc / VFX_SUBSTEP);
    if (n > VFX_MAX_SUBSTEPS) { n = VFX_MAX_SUBSTEPS; this.acc = 0; } else this.acc -= n * VFX_SUBSTEP;
    for (let k = 0; k < n; k++) {
      this.time += VFX_SUBSTEP;
      this.substep++;
      for (const e of this.emitters) {
        e.elapsed += VFX_SUBSTEP;
        e.lifecycle.wind = e.program.influences.sceneWind ? ctx.wind ?? null : null;
        e.lifecycle.windTime = ctx.windTime ?? this.time;
        this.emitStep(e, VFX_SUBSTEP);
        if (e.flock) this.stepFlock(e, VFX_SUBSTEP, ctx);
        else if (e.plate) this.stepPlate(e, VFX_SUBSTEP, ctx, k / n, (k + 1) / n);
        else this.stepGeneric(e, VFX_SUBSTEP, ctx, k / n, (k + 1) / n);
      }
      this.flushHits();
    }
    for (const e of this.emitters) if (e.flock) this.flockStateMachine(e, dt, ctx);
  }

  // ------------------------------------------------------------------ 薄片

  private stepPlate(e: VfxEmitterRuntime, h: number, ctx: VfxStepContext, contactStart: number, contactEnd: number): void {
    const p = e.p;
    const pl = e.plate!;
    if (e.def.life?.seconds) {
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i]) continue;
        p.age[i] += h;
        if (p.life[i] > 0 && p.age[i] >= p.life[i]) { p.alive[i] = 0; p.liveCount--; }
      }
    }
    if (e.burn) {
      // 可燃：碰火受热 / 着 / 烧没（燃着的片要醒着，才吃得到燃烧热托起的那股上升气流）
      const arr = pl.arr;
      p.liveCount -= stepPlateBurn(e.burn, p, p.cap, h, ctx.fires ?? NO_FIRES, (pl.P.w + pl.P.h) / 4, pl.P.w, arr.metric, arr,
        this.substep % PLATE_BURN_CONTACT_EVERY === 0,
        (i) => { arr.sleep[i] = 0; arr.still[i] = 0; });
    }
    p.liveCount -= stepPlates(pl.P, pl.arr, p.alive, p, p.cap, h, {
      space: this.space,
      wind: e.program.influences.sceneWind ? ctx.wind ?? null : null,
      windTime: ctx.windTime ?? this.time,
      turb: e.turb,
      time: this.time,
      substep: this.substep,
      confine: e.area.confine,
      lifecycle: e.lifecycle,
      fields: ctx.fields,
      contacts: e.program.influences.contact ? ctx.contacts : undefined,
      contactStart, contactEnd,
      fieldWind: e.program.influences.wind,
      airflow: e.program.influences.airflow,
      stimulus: e.program.influences.stimulus ? e.stim : null,
      rng: e.rng,
      windScale: this.windScale,
      burn: e.burn ? { burnT: e.burn.burnT, liftWu: e.burn.P.liftWu } : null,
    });
  }

  // ------------------------------------------------------------------ 通用粒子

  private stepGeneric(e: VfxEmitterRuntime, h: number, ctx: VfxStepContext, contactStart: number, contactEnd: number): void {
    const p = e.p;
    const sp = this.space;
    const col = e.def.collision;
    const groundResp: VfxCollisionResponse = col?.ground ?? 'none';
    const shellResp: VfxCollisionResponse = col?.shell ?? 'none';
    const rest = col?.restitution ?? 0.3;
    const fric = col?.friction ?? 0.2;
    const r = e.radius;
    const useShell = shellResp !== 'none' && sp.hasShell;
    const sceneWind = e.program.influences.sceneWind ? ctx.wind ?? null : null;
    const windTime = ctx.windTime ?? this.time;
    const cf = this.confine;
    e.lifecycle.beginStep();
    // 最远烧到多远：离原点越远越早走完寿命（火焰燃气离开火源超过火焰长度就烧完了）
    const maxDist = (e.def.life?.maxDistance ?? 0) * this.distanceScale;
    const ox = e.origin[0], oy = e.origin[1], oz = e.origin[2];
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      p.age[i] += h;
      if (maxDist > 0 && p.life[i] > 0) {
        const byDistance = (Math.hypot(p.x[i] - ox, p.y[i] - oy, p.z[i] - oz) / maxDist) * p.life[i];
        if (byDistance > p.age[i]) p.age[i] = byDistance;
      }
      if (p.life[i] > 0 && p.age[i] >= p.life[i]) { p.alive[i] = 0; p.liveCount--; continue; }
      if (e.lifecycle.beforeParticle(i, h)) continue;
      p.rot[i] += p.spin[i] * h;
      if (e.program.influences.contact && ctx.contacts?.length
        && resolveKinematicContacts(ctx.contacts, p, i, h, contactStart, contactEnd)) p.mode[i] = VfxParticleMode.Flying;
      if (p.mode[i] === VfxParticleMode.Stuck) continue;
      // 权重看的是**正下方地面点**落在画面上的位置（区域是地上的一块）
      let cw = 1, chw = 1;
      if (cf) {
        const gy0 = sp.groundY(p.x[i], p.z[i]);
        tmpFoot[0] = p.x[i]; tmpFoot[1] = gy0; tmpFoot[2] = p.z[i];
        sp.toScene(tmpFoot, tmpScene);
        cw = confineWeightAt(cf, tmpScene.x, tmpScene.y);
        if (cf.ceiling !== null) chw = confineHeightWeight(cf, Math.max(0, p.y[i] - gy0) / Math.max(sp.metricAt(p.x[i], p.z[i]), 1e-6));
        if (cw < CONFINE_EXIT_WEIGHT && p.fadeRate[i] <= 0) p.fadeRate[i] = 1 / CONFINE_EXIT_FADE_S;
      }
      let ax = 0, ay = -e.gravity + e.buoyancy, az = 0;
      if (e.wind) { ax += e.wind[0]; ay += e.wind[1]; az += e.wind[2]; }
      if (e.drag > 0) {
        ax -= e.drag * p.vx[i]; ay -= e.drag * p.vy[i]; az -= e.drag * p.vz[i];
        // 场景风：阻力是相对空气的（dv = −drag·(v − u)），所以有风就被带着走，没风一字不变
        if (sceneWind) {
          const hAbove = Math.max(0, p.y[i] - sp.groundY(p.x[i], p.z[i]));
          sampleSceneWind(sceneWind, windTime, p.x[i], p.z[i], hAbove, tmpWind);
          // 竖直分量来自湍流的涡（上升 / 下沉气流）——丢掉它，粒子就只会朝一个方向平推。
          // 粒子区域：边带里风按权重弱下去；过了高度上限，上升气流不再托它
          const g = sceneWind.gainVfx * cw * this.windScale;
          const uy = tmpWind[1] > 0 ? tmpWind[1] * chw : tmpWind[1];
          ax += e.drag * tmpWind[0] * g;
          ay += e.drag * uy * g;
          az += e.drag * tmpWind[2] * g;
        }
      }
      if (e.program.influences.airflow && e.drag > 0) {
        tmpWind[0] = 0; tmpWind[1] = 0; tmpWind[2] = 0;
        accumulateAirflow(ctx.fields, p.x[i], p.y[i], p.z[i], tmpWind);
        if (tmpWind[0] !== 0 || tmpWind[1] !== 0 || tmpWind[2] !== 0) {
          ax += e.drag * tmpWind[0]; ay += e.drag * tmpWind[1]; az += e.drag * tmpWind[2];
        }
      }
      if (e.turb) {
        const t = e.turb;
        // 效果自己的湍流随本次模拟计时；全场时钟只留给显式外部风场。
        // 同种子重播必须不受玩家此前在场景里停留多久影响（薄片也是这个口径）。
        curlNoise3(p.x[i] * t.invScale, p.y[i] * t.invScale, p.z[i] * t.invScale, this.time * t.speed + p.seed[i] * 3, tmpN);
        ax += tmpN[0] * t.strength; ay += tmpN[1] * t.strength; az += tmpN[2] * t.strength;
      }
      tmpAcceleration[0] = ax; tmpAcceleration[1] = ay; tmpAcceleration[2] = az;
      accumulateFieldAcceleration(ctx.fields, e.program.influences.wind,
        e.program.influences.stimulus ? e.stim : null, p.x[i], p.y[i], p.z[i], p.seed[i], tmpAcceleration);
      ax = tmpAcceleration[0]; ay = tmpAcceleration[1]; az = tmpAcceleration[2];
      p.vx[i] += ax * h; p.vy[i] += ay * h; p.vz[i] += az * h;
      const spd = Math.hypot(p.vx[i], p.vy[i], p.vz[i]);
      if (spd > e.maxSpeed) { const s = e.maxSpeed / spd; p.vx[i] *= s; p.vy[i] *= s; p.vz[i] *= s; }
      p.x[i] += p.vx[i] * h; p.y[i] += p.vy[i] * h; p.z[i] += p.vz[i] * h;
      // 地面
      if (groundResp !== 'none') {
        const gy = sp.groundY(p.x[i], p.z[i]) + r;
        if (p.y[i] < gy) {
          if (groundResp === 'kill') {
            this.queueHit(e, p.x[i], gy, p.z[i], 0, 1, 0);
            p.alive[i] = 0; p.liveCount--; continue;
          }
          p.y[i] = gy;
          if (groundResp === 'bounce') {
            p.vy[i] = -p.vy[i] * rest; p.vx[i] *= 1 - fric; p.vz[i] *= 1 - fric;
            if (Math.abs(p.vy[i]) < 2) p.vy[i] = 0;
          } else if (groundResp === 'stick') {
            p.vx[i] = 0; p.vy[i] = 0; p.vz[i] = 0; p.mode[i] = VfxParticleMode.Stuck;
            this.queueHit(e, p.x[i], gy, p.z[i], 0, 1, 0);
          } else if (groundResp === 'slide') {
            if (p.vy[i] < 0) p.vy[i] = 0;
            p.vx[i] *= 1 - fric; p.vz[i] *= 1 - fric;
          }
        }
      }
      // 壳（墙、前景）：薄壳——只有面后一个壳厚以内算撞上；更深的是遮挡物背后的空处
      if (useShell) {
        const c = sp.shellContact(p.x[i], p.y[i], p.z[i]);
        const side = c ? thinShellSide(c.penWu, r, p.behind[i] === 1) : ShellSide.Front;
        if (c) p.behind[i] = side === ShellSide.Behind ? 1 : 0;
        if (c && !c.groundLike && side === ShellSide.Contact) {
          const n = c.normal;
          if (shellResp === 'kill') {
            this.queueHit(e, p.x[i], p.y[i], p.z[i], n[0], n[1], n[2]);
            p.alive[i] = 0; p.liveCount--; continue;
          }
          // 推到壳前：沿法线退 (pen + r)
          const push = c.penWu + r;
          p.x[i] += n[0] * push; p.y[i] += n[1] * push; p.z[i] += n[2] * push;
          const vn = p.vx[i] * n[0] + p.vy[i] * n[1] + p.vz[i] * n[2];
          if (shellResp === 'bounce') {
            if (vn < 0) {
              const k = -(1 + rest) * vn;
              p.vx[i] += n[0] * k; p.vy[i] += n[1] * k; p.vz[i] += n[2] * k;
              p.vx[i] *= 1 - fric; p.vy[i] *= 1 - fric; p.vz[i] *= 1 - fric;
            }
          } else if (shellResp === 'stick') {
            p.vx[i] = 0; p.vy[i] = 0; p.vz[i] = 0; p.mode[i] = VfxParticleMode.Stuck;
            this.queueHit(e, p.x[i], p.y[i], p.z[i], n[0], n[1], n[2]);
          } else if (shellResp === 'slide') {
            if (vn < 0) { p.vx[i] -= n[0] * vn; p.vy[i] -= n[1] * vn; p.vz[i] -= n[2] * vn; }
          }
        }
      }
      e.lifecycle.afterMotion(i, p.x[i], p.y[i], p.z[i]);
    }
    p.liveCount -= e.lifecycle.killed;
  }

  private queueHit(e: VfxEmitterRuntime, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.events.push({ type: 'hit', emitter: e.def.id, at: [x, y, z] });
    if (!e.onHit) return;
    this.hits.push({ emitter: e.onHit.emitter, x, y, z, nx, ny, nz, count: e.onHit.count });
  }

  private flushHits(): void {
    if (this.hits.length === 0) return;
    const list = this.hits;
    this.hits = [];
    for (const hit of list) {
      const target = findEmitter(this.emitters, hit.emitter);
      if (!target) continue;
      const n = Math.max(1, Math.round(hit.count * this.countScale));
      const dir = target.def.spawn.direction ?? [hit.nx, hit.ny, hit.nz];
      for (let k = 0; k < n; k++) if (this.spawnAt(target, hit.x, hit.y, hit.z, dir) < 0) break;
    }
  }

  // ------------------------------------------------------------------ 群体

  private stepFlock(e: VfxEmitterRuntime, h: number, ctx: VfxStepContext): void {
    const p = e.p;
    const beh = e.def.behavior!;
    const fl = e.flock!;
    const sp = this.space;
    const state = fl.state;
    const cruise = beh.cruise;
    const maxA = beh.maxAccel;
    const margin = Math.max(e.radius * 2, 8);

    // 巢：全部挂着，不算力
    if (state === 'roosting') {
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i]) continue;
        p.age[i] += h;
        p.mode[i] = VfxParticleMode.Roosting;
        p.x[i] = e.origin[0] + p.hx[i]; p.y[i] = e.origin[1] + p.hy[i]; p.z[i] = e.origin[2] + p.hz[i];
        p.vx[i] = 0; p.vy[i] = 0; p.vz[i] = 0;
        p.fear[i] *= Math.pow(1 - beh.attitude.fearDecay, h);
      }
      return;
    }

    // 空间哈希（格 = 感知半径）
    const cell = Math.max(beh.senseRadius, 1);
    const buckets = new Map<number, number[]>();
    const keyOf = (x: number, y: number, z: number) =>
      ((Math.floor(x / cell) & 1023) << 20) | ((Math.floor(y / cell) & 1023) << 10) | (Math.floor(z / cell) & 1023);
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i] || p.mode[i] !== VfxParticleMode.Flying) continue;
      const k = keyOf(p.x[i], p.y[i], p.z[i]);
      let b = buckets.get(k);
      if (!b) { b = []; buckets.set(k, b); }
      b.push(i);
    }
    const sense2 = beh.senseRadius * beh.senseRadius;
    const sepR = beh.separation;
    const acc = [0, 0, 0];
    const sep = [0, 0, 0];
    const ali = [0, 0, 0];
    const coh = [0, 0, 0];
    const away = [0, 0, 0];
    let fearSum = 0, fearN = 0;
    const cx = fl.center[0], cy = fl.center[1], cz = fl.center[2];
    const fields = e.program.influences.stimulus ? ctx.fields : [];
    const fearW = beh.attitude.fear;
    const attractW = beh.attitude.attract;

    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      p.age[i] += h;
      if (p.mode[i] !== VfxParticleMode.Flying) {
        // 已落巢的个体：挂在巢里
        p.x[i] = e.origin[0] + p.hx[i]; p.y[i] = e.origin[1] + p.hy[i]; p.z[i] = e.origin[2] + p.hz[i];
        p.vx[i] = 0; p.vy[i] = 0; p.vz[i] = 0;
        continue;
      }
      const px = p.x[i], py = p.y[i], pz = p.z[i];
      // ---- 邻居三力
      sep[0] = sep[1] = sep[2] = 0; ali[0] = ali[1] = ali[2] = 0; coh[0] = coh[1] = coh[2] = 0;
      let nN = 0;
      const gcx = Math.floor(px / cell), gcy = Math.floor(py / cell), gcz = Math.floor(pz / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) for (let oz = -1; oz <= 1; oz++) {
        const b = buckets.get((((gcx + ox) & 1023) << 20) | (((gcy + oy) & 1023) << 10) | ((gcz + oz) & 1023));
        if (!b) continue;
        for (const j of b) {
          if (j === i) continue;
          const dx = px - p.x[j], dy = py - p.y[j], dz = pz - p.z[j];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > sense2 || d2 < 1e-9) continue;
          const d = Math.sqrt(d2);
          nN++;
          if (d < sepR) {
            const w = (1 - d / sepR) / d;
            sep[0] += dx * w; sep[1] += dy * w; sep[2] += dz * w;
          }
          ali[0] += p.vx[j]; ali[1] += p.vy[j]; ali[2] += p.vz[j];
          coh[0] += p.x[j]; coh[1] += p.y[j]; coh[2] += p.z[j];
        }
      }
      acc[0] = 0; acc[1] = 0; acc[2] = 0;
      if (nN > 0) {
        // 分离：方向 × 上限（|sep| 已按 (1−d/R) 加权，超过 1 就是贴着了）
        const sl = Math.hypot(sep[0], sep[1], sep[2]);
        if (sl > 1e-6) {
          const k = (beh.accel.separation * Math.min(1, sl)) / sl;
          acc[0] += sep[0] * k; acc[1] += sep[1] * k; acc[2] += sep[2] * k;
        }
        // 对齐：(平均速度 − 自身) 按 cruise 归一
        ali[0] = ali[0] / nN - p.vx[i]; ali[1] = ali[1] / nN - p.vy[i]; ali[2] = ali[2] / nN - p.vz[i];
        const ak = beh.accel.alignment / Math.max(cruise, 1e-3);
        ali[0] *= ak; ali[1] *= ak; ali[2] *= ak;
        clampLen3(ali, beh.accel.alignment);
        acc[0] += ali[0]; acc[1] += ali[1]; acc[2] += ali[2];
        // 凝聚：(质心 − 自身) 按感知半径归一
        coh[0] = coh[0] / nN - px; coh[1] = coh[1] / nN - py; coh[2] = coh[2] / nN - pz;
        const ck = beh.accel.cohesion / Math.max(beh.senseRadius, 1e-3);
        coh[0] *= ck; coh[1] *= ck; coh[2] *= ck;
        clampLen3(coh, beh.accel.cohesion);
        acc[0] += coh[0]; acc[1] += coh[1]; acc[2] += coh[2];
      }

      // ---- 刺激：恐惧输入 / 吸引输入
      let fearIn = 0;
      away[0] = away[1] = away[2] = 0;
      for (const f of fields) {
        if (f.def.kind !== 'fear' && f.def.kind !== 'attract') continue;
        const w = f.def.kind === 'fear' ? (fearW[f.def.tag] ?? 0) : (attractW?.[f.def.tag] ?? 0);
        if (w <= 0) continue;
        const s = fieldFalloff(f, px, py, pz) * w;
        if (s <= 0) continue;
        const dx = px - f.pos[0], dy = py - f.pos[1], dz = pz - f.pos[2];
        const d = Math.hypot(dx, dy, dz) || 1;
        const sign = f.def.kind === 'fear' ? 1 : -1;
        away[0] += (dx / d) * s * sign; away[1] += (dy / d) * s * sign; away[2] += (dz / d) * s * sign;
        if (f.def.kind === 'fear') fearIn += s;
      }
      if (fearIn > 0) {
        p.quietFor[i] = 0;
        if (p.reactLeft[i] < 0) p.reactLeft[i] = e.rng.pair(beh.attitude.reactionDelay, 0.1);
        else p.reactLeft[i] = Math.max(0, p.reactLeft[i] - h);
        if (p.reactLeft[i] <= 0) p.fear[i] = Math.min(2, p.fear[i] + fearIn * h);
      } else {
        p.quietFor[i] += h;
        if (p.quietFor[i] > 0.5) p.reactLeft[i] = -1;
      }
      p.fear[i] *= Math.pow(1 - beh.attitude.fearDecay, h);
      fearSum += p.fear[i]; fearN++;
      const reacting = p.reactLeft[i] === 0 || (p.reactLeft[i] < 0 && p.fear[i] > 0.05);
      if (reacting) {
        const al = Math.hypot(away[0], away[1], away[2]);
        if (al > 1e-6) {
          const k = (maxA * Math.min(1, p.fear[i] + fearIn)) / al;
          acc[0] += away[0] * k; acc[1] += away[1] * k; acc[2] += away[2] * k;
        }
      }

      // ---- 轨道 / 回巢：期望速度 → 转向加速度
      const cm = cruise * p.cruiseMul[i];
      let dvx = 0, dvy = 0, dvz = 0;
      if (state === 'airborne') {
        const rx = px - cx, rz = pz - cz;
        const rl = Math.hypot(rx, rz) || 1e-3;
        const hand = p.hand[i];
        const tx = (-rz / rl) * hand, tz = (rx / rl) * hand;
        const radial = (beh.orbit.radius - rl) / Math.max(beh.orbit.radius, 1);   // >0 太近往外，<0 太远往里
        dvx = tx + (rx / rl) * radial; dvz = tz + (rz / rl) * radial;
        dvy = (cy - py) / Math.max(beh.orbit.radius, 1);
      } else if (state === 'fleeing') {
        const al = Math.hypot(away[0], away[1], away[2]);
        if (al > 1e-6) { dvx = away[0] / al; dvy = away[1] / al * 0.3 + 0.15; dvz = away[2] / al; }
        else {
          const rx = e.origin[0] - px, ry = e.origin[1] + beh.minAltitude - py, rz = e.origin[2] - pz;
          const rl = Math.hypot(rx, ry, rz) || 1;
          dvx = rx / rl; dvy = ry / rl; dvz = rz / rl;
        }
      } else {
        // returning：飞回自己的挂点
        const tx = e.origin[0] + p.hx[i] - px, ty = e.origin[1] + p.hy[i] - py, tz = e.origin[2] + p.hz[i] - pz;
        const tl = Math.hypot(tx, ty, tz);
        if (tl < beh.home.nestRadius * LAND_RADIUS_RATIO || tl < 6) {
          p.mode[i] = VfxParticleMode.Roosting;
          p.x[i] = e.origin[0] + p.hx[i]; p.y[i] = e.origin[1] + p.hy[i]; p.z[i] = e.origin[2] + p.hz[i];
          p.vx[i] = 0; p.vy[i] = 0; p.vz[i] = 0;
          continue;
        }
        dvx = tx / tl; dvy = ty / tl; dvz = tz / tl;
      }
      const dl = Math.hypot(dvx, dvy, dvz) || 1;
      const want = state === 'fleeing' ? beh.max : cm;
      dvx = (dvx / dl) * want - p.vx[i]; dvy = (dvy / dl) * want - p.vy[i]; dvz = (dvz / dl) * want - p.vz[i];
      const sk = maxA / Math.max(cruise, 1e-3);
      tmpV[0] = dvx * sk; tmpV[1] = dvy * sk; tmpV[2] = dvz * sk;
      clampLen3(tmpV, maxA * 0.8);
      acc[0] += tmpV[0]; acc[1] += tmpV[1]; acc[2] += tmpV[2];

      // ---- 游走
      if (beh.wander) {
        curlNoise3(px * 0.01, py * 0.01, pz * 0.01, this.time * 0.4 + p.seed[i] * 5, tmpN);
        acc[0] += tmpN[0] * beh.wander; acc[1] += tmpN[1] * beh.wander; acc[2] += tmpN[2] * beh.wander;
      }

      // ---- 高度下限（软力）
      const gy = sp.groundY(px, pz);
      const alt = py - gy;
      if (alt < beh.minAltitude) acc[1] += maxA * (1 - Math.max(0, alt) / beh.minAltitude);

      // ---- 避墙（前瞻）：前瞻点落在遮挡物背后的空处（薄壳）不算墙，照飞过去
      if (sp.hasShell) {
        const la = sp.shellContact(px + p.vx[i] * FLOCK_LOOKAHEAD_S, py + p.vy[i] * FLOCK_LOOKAHEAD_S, pz + p.vz[i] * FLOCK_LOOKAHEAD_S);
        if (la && !la.groundLike && thinShellSide(la.penWu, margin, p.behind[i] === 1) === ShellSide.Contact) {
          const n = la.normal;
          const k = maxA * Math.min(1.5, (la.penWu + margin) / margin);
          acc[0] += n[0] * k; acc[1] += n[1] * k; acc[2] += n[2] * k;
        }
      }

      clampLen3(acc, maxA);
      p.vx[i] += acc[0] * h; p.vy[i] += acc[1] * h; p.vz[i] += acc[2] * h;
      let spd = Math.hypot(p.vx[i], p.vy[i], p.vz[i]);
      const vmax = beh.max * p.cruiseMul[i];
      if (spd > vmax) { const s = vmax / spd; p.vx[i] *= s; p.vy[i] *= s; p.vz[i] *= s; spd = vmax; }
      const vmin = cm * FLOCK_MIN_SPEED_RATIO;
      if (spd < vmin) {
        if (spd < 1e-6) { e.rng.unitVector(tmpV); p.vx[i] = tmpV[0] * vmin; p.vy[i] = 0; p.vz[i] = tmpV[2] * vmin; }
        else { const s = vmin / spd; p.vx[i] *= s; p.vy[i] *= s; p.vz[i] *= s; }
        spd = vmin;
      }
      p.x[i] += p.vx[i] * h; p.y[i] += p.vy[i] * h; p.z[i] += p.vz[i] * h;
      // 硬约束：不入地
      const gy2 = sp.groundY(p.x[i], p.z[i]) + e.radius;
      if (p.y[i] < gy2) { p.y[i] = gy2; if (p.vy[i] < 0) p.vy[i] = -p.vy[i] * 0.2; }
      // 硬约束：不进壳（薄壳：面后一个壳厚以内推回；更深的是飞到了遮挡物背后）
      if (sp.hasShell) {
        const c = sp.shellContact(p.x[i], p.y[i], p.z[i]);
        const side = c ? thinShellSide(c.penWu, e.radius, p.behind[i] === 1) : ShellSide.Front;
        if (c) p.behind[i] = side === ShellSide.Behind ? 1 : 0;
        if (c && !c.groundLike && side === ShellSide.Contact) {
          const n = c.normal;
          const push = c.penWu + e.radius;
          p.x[i] += n[0] * push; p.y[i] += n[1] * push; p.z[i] += n[2] * push;
          const vn = p.vx[i] * n[0] + p.vy[i] * n[1] + p.vz[i] * n[2];
          if (vn < 0) { p.vx[i] -= n[0] * vn; p.vy[i] -= n[1] * vn; p.vz[i] -= n[2] * vn; }
        }
      }
      // 扑翼相位随速度
      const wf = beh.wingFlap;
      if (wf) {
        const t = Math.min(1, spd / Math.max(beh.max, 1e-3));
        p.phase[i] += (wf.atCruise + (wf.atMax - wf.atCruise) * t) * h;
      }
    }
    fl.fearMean = fearN > 0 ? fearSum / fearN : 0;
  }

  private transition(e: VfxEmitterRuntime, to: VfxFlockState): void {
    const fl = e.flock!;
    if (fl.state === to) return;
    const from = fl.state;
    fl.state = to;
    fl.stateTime = 0;
    fl.calm = 0;
    this.events.push({ type: 'flockState', emitter: e.def.id, from, to });
    const beh = e.def.behavior!;
    const p = e.p;
    if (to === 'airborne' || to === 'fleeing') {
      // 从巢里放飞：给挂着的个体一个离巢初速
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i] || p.mode[i] === VfxParticleMode.Flying) continue;
        p.mode[i] = VfxParticleMode.Flying;
        e.rng.unitVector(tmpV);
        p.vx[i] = tmpV[0] * beh.cruise; p.vy[i] = Math.abs(tmpV[1]) * beh.cruise * 0.5 + beh.cruise * 0.2; p.vz[i] = tmpV[2] * beh.cruise;
        p.reactLeft[i] = -1;
      }
      if (from === 'roosting') {
        fl.startled = true;
        if (e.def.sound?.start) this.events.push({ type: 'sound', emitter: e.def.id, sfx: e.def.sound.start, at: [e.origin[0], e.origin[1], e.origin[2]] });
        if (beh.startlePulse) {
          this.events.push({
            type: 'field',
            def: { kind: 'fear', tag: 'startle', radius: beh.startlePulse.radius, strength: beh.startlePulse.strength, duration: beh.startlePulse.duration },
            at: [e.origin[0], e.origin[1], e.origin[2]],
          });
        }
      }
    } else if (to === 'roosting') {
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i]) continue;
        p.mode[i] = VfxParticleMode.Roosting;
        p.x[i] = e.origin[0] + p.hx[i]; p.y[i] = e.origin[1] + p.hy[i]; p.z[i] = e.origin[2] + p.hz[i];
        p.vx[i] = 0; p.vy[i] = 0; p.vz[i] = 0;
        p.behind[i] = spawnsBehindShell(this.space, p.x[i], p.y[i], p.z[i]) ? 1 : 0;
      }
    }
  }

  private flockStateMachine(e: VfxEmitterRuntime, dt: number, ctx: VfxStepContext): void {
    const fl = e.flock!;
    const beh = e.def.behavior!;
    fl.stateTime += dt;
    const pl = ctx.player;
    let playerDist = Infinity;
    if (pl) {
      playerDist = Math.hypot(pl.world[0] - e.origin[0], pl.world[1] - e.origin[1], pl.world[2] - e.origin[2]);
    }
    fl.playerInRange = playerDist <= beh.home.rangeRadius;
    // 轨道中心：玩家在活动域内绕玩家，否则绕巢
    if (pl && fl.playerInRange) {
      fl.center[0] = pl.world[0]; fl.center[1] = pl.world[1] + beh.orbit.height; fl.center[2] = pl.world[2];
    } else {
      fl.center[0] = e.origin[0]; fl.center[1] = e.origin[1] + beh.orbit.height; fl.center[2] = e.origin[2];
    }
    const thr = beh.attitude.fleeThreshold;
    switch (fl.state) {
      case 'roosting': {
        let startle = playerDist <= beh.home.startleRadius;
        if (!startle) {
          for (const f of (e.program.influences.stimulus ? ctx.fields : [])) {
            if (f.def.kind !== 'fear' || !(beh.attitude.fear[f.def.tag] > 0)) continue;
            if (fieldFalloff(f, e.origin[0], e.origin[1], e.origin[2]) > 0) { startle = true; break; }
          }
        }
        if (startle) this.transition(e, 'airborne');
        break;
      }
      case 'airborne': {
        if (fl.fearMean > thr) this.transition(e, 'fleeing');
        else if (!fl.playerInRange && fl.stateTime > 1.5) this.transition(e, 'returning');
        break;
      }
      case 'fleeing': {
        if (fl.fearMean < thr * 0.5) fl.calm += dt; else fl.calm = 0;
        if (fl.calm >= beh.attitude.calmSeconds) this.transition(e, fl.playerInRange ? 'airborne' : 'returning');
        break;
      }
      case 'returning': {
        if (fl.fearMean > thr) { this.transition(e, 'fleeing'); break; }
        if (fl.playerInRange && playerDist <= beh.home.startleRadius && fl.stateTime > 1) { this.transition(e, 'airborne'); break; }
        let flying = 0;
        const p = e.p;
        for (let i = 0; i < p.cap; i++) if (p.alive[i] && p.mode[i] === VfxParticleMode.Flying) flying++;
        if (flying === 0) this.transition(e, 'roosting');
        break;
      }
    }
  }
}

/** 建刺激场运行态（系统层用）。 */
/** 作者锚点 → 世界（薄包装，给系统与工作台共用同一条） */
export function resolveVfxAnchor(space: VfxSpace, a: VfxAnchorDef): Vec3 {
  return space.anchorToWorld(a);
}

// 渲染侧只读这些
export type { Vec3 };
export function sceneOf(space: VfxSpace, w: Vec3): { x: number; y: number } {
  space.toScene(w, tmpScene);
  return tmpScene;
}
