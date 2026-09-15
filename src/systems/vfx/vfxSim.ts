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
  VfxCollisionResponse,
  VfxConfineDef,
  VfxEffectDef,
  VfxEmitterDef,
  VfxFieldDef,
  VfxFlockBehaviorDef,
  VfxFlockState,
  VfxInstanceState,
} from '../../data/types';
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
import { ShellSide, spawnsBehindShell, thinShellSide, type VfxSpace } from './vfxSpace';

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
}

/** 实例级的额外输入（布置库里那条实例带的） */
export interface VfxInstanceOptions {
  /** 发射区域（画面坐标多边形）：`spawn.shape.kind = 'area'` 的发射器铺在这里、回收的从这里补回 */
  area?: [number, number][] | null;
  /** 范围区域的软边界（见 `VfxConfineDef`；范围区域 = `confine.area`，没写用发射区域） */
  confine?: VfxConfineDef | null;
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
}

interface HitEvent {
  emitter: string;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  count: number;
}

const tmpV = [0, 0, 0];
const tmpN = new Float32Array(3);
const tmpWind: Vec3 = [0, 0, 0];
const tmpAcceleration: Vec3 = [0, 0, 0];
const tmpScene = { x: 0, y: 0 };
const tmpFoot: Vec3 = [0, 0, 0];

function clampLen3(v: number[], max: number): void {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l > max && l > 1e-9) {
    const s = max / l;
    v[0] *= s; v[1] *= s; v[2] *= s;
  }
}

/** 效果里挑发射器（子发射引用） */
function findEmitter(list: VfxEmitterRuntime[], id: string): VfxEmitterRuntime | null {
  for (const e of list) if (e.def.id === id) return e;
  return null;
}

export class VfxInstanceSim {
  readonly emitters: VfxEmitterRuntime[] = [];
  readonly events: VfxSimEvent[] = [];
  private acc = 0;
  private hits: HitEvent[] = [];
  /** 发射率倍率（见 {@link setRateScale}）。1 = 按资产里写的速率发 */
  private rateScale = 1;
  /** 全局子步序号（薄片据此错开刷度量 / 查唤醒） */
  private substep = 0;
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
    this.confine = buildConfineField(options.area ?? null, options.confine ?? null);
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
      };
      rt.lifecycle = new VfxParticleLifecycle({
        space, area, body: rt.p, rng: rt.rng, policy: program.recycle,
        detectLoss: program.solver === 'plate' || program.recycle.mode !== 'none',
        clampDeadFade: program.solver === 'plate',
        fallSpeed: rt.plate ? Math.sqrt(PLATE_GRAVITY / rt.plate.P.kn) : 90,
        place: (index, surface) => this.placeOnSurface(rt, index, surface),
        launch: (index, at, velocity) => this.launch(rt, index, at, velocity),
      });
      this.emitters.push(rt);
      // 群体：起播即把整群摆进巢（roosting）或直接放飞（airborne）
      if (rt.flock) this.populateFlock(rt);
    });
  }

  /** 实例状态（条件叶 `vfxState`）：有群体模块取第一群的状态，否则 active/inactive */
  get state(): VfxInstanceState {
    for (const e of this.emitters) if (e.flock) return e.flock.state;
    return this.emitters.some((e) => e.active) ? 'active' : 'inactive';
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
   * **已经发射出去的粒子留在原地**——烟和火星离手就归空气管，跟着人跑才是错的。
   * 挪的只有各发射器的原点（与巢心），所以下一颗生在新位置。
   *
   * ⚠ 薄片（`plate`）的 `area` 是构造时按原点解出来的贴附面，这里**不重解**：
   * 薄片是躺在地上的纸钱那一档，本来就不该挂在会动的东西上。
   */
  moveAnchor(world: Vec3): void {
    const dx = world[0] - this.anchorWorld[0];
    const dy = world[1] - this.anchorWorld[1];
    const dz = world[2] - this.anchorWorld[2];
    if (dx === 0 && dy === 0 && dz === 0) return;
    this.anchorWorld[0] = world[0];
    this.anchorWorld[1] = world[1];
    this.anchorWorld[2] = world[2];
    for (const e of this.emitters) {
      this.translateEmitterOrigin(e, dx, dy, dz);
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
   * 发射率倍率（火焰输出 `L(t)` 驱动：火苗一窜，火星跟着多蹦几颗）。
   *
   * 为什么不做成 `countScale`：那个是构造时折进池容量的，改不动；
   * 这个只乘在**每一拍的发射速率**上，池容量不变（所以不会突然申请一大块）。
   * 非有限值或负数一律当 1 —— 一个 NaN 进来会让发射器**永远不再发**且零报错。
   */
  setRateScale(k: number): void {
    this.rateScale = Number.isFinite(k) && k > 0 ? k : 1;
  }

  /** 停：所有发射器不再发（在飞的自然老化；永生的整批清掉） */
  stop(): void {
    for (const e of this.emitters) {
      e.active = false;
      if (!e.def.life?.seconds) this.clear(e);
    }
  }

  /** 开（或重开） */
  start(): void {
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

  // ------------------------------------------------------------------ 发射

  private spawnOne(e: VfxEmitterRuntime, ox: number, oy: number, oz: number, dir: readonly number[] | null): number {
    const p = e.p;
    let i = -1;
    for (let k = 0; k < p.cap; k++) if (!p.alive[k]) { i = k; break; }
    if (i < 0) return -1;
    const d = e.def;
    const rng = e.rng;
    const sh = d.spawn.shape ?? { kind: 'point' as const };
    let sx = ox, sy = oy, sz = oz;
    if (sh.kind === 'sphere') {
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
    p.size[i] = d.appearance.sizeWu * rng.pair(d.appearance.sizeJitter, 1);
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
      for (let k = 0; k < n; k++) if (this.spawnEmit(e) === -1) break;
    }
    if (s.rate) {
      e.rateAcc += s.rate * this.countScale * this.rateScale * h;
      while (e.rateAcc >= 1) {
        e.rateAcc -= 1;
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

  step(dt: number, ctx: VfxStepContext): void {
    if (!(dt > 0)) return;
    this.events.length = 0;
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
        else if (e.plate) this.stepPlate(e, VFX_SUBSTEP, ctx);
        else this.stepGeneric(e, VFX_SUBSTEP, ctx);
      }
      this.flushHits();
    }
    for (const e of this.emitters) if (e.flock) this.flockStateMachine(e, dt, ctx);
  }

  // ------------------------------------------------------------------ 薄片

  private stepPlate(e: VfxEmitterRuntime, h: number, ctx: VfxStepContext): void {
    const p = e.p;
    const pl = e.plate!;
    if (e.def.life?.seconds) {
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i]) continue;
        p.age[i] += h;
        if (p.life[i] > 0 && p.age[i] >= p.life[i]) { p.alive[i] = 0; p.liveCount--; }
      }
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
      fieldWind: e.program.influences.wind,
      airflow: e.program.influences.airflow,
      stimulus: e.program.influences.stimulus ? e.stim : null,
      rng: e.rng,
    });
  }

  // ------------------------------------------------------------------ 通用粒子

  private stepGeneric(e: VfxEmitterRuntime, h: number, ctx: VfxStepContext): void {
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
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      p.age[i] += h;
      if (p.life[i] > 0 && p.age[i] >= p.life[i]) { p.alive[i] = 0; p.liveCount--; continue; }
      if (e.lifecycle.beforeParticle(i, h)) continue;
      p.rot[i] += p.spin[i] * h;
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
          const g = sceneWind.gainVfx * cw;
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
        curlNoise3(p.x[i] * t.invScale, p.y[i] * t.invScale, p.z[i] * t.invScale, ctx.time * t.speed + p.seed[i] * 3, tmpN);
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
        curlNoise3(px * 0.01, py * 0.01, pz * 0.01, ctx.time * 0.4 + p.seed[i] * 5, tmpN);
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
