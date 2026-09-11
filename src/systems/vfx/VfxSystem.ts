/**
 * 世界空间粒子 / 群体系统（VfxSystem）——场景实例的生命周期、刺激场总线、资产装载、驱动渲染。
 *
 * 三件正交的东西（见 types.ts 里 VFX 一节）：效果资产（全局）、场景实例（场景 JSON `vfx[]`）、
 * 刺激场（运行时事件）。本系统 own 后两者的运行态；模拟数学在 `vfxSim.ts`（纯函数）、
 * 画法在 `rendering/vfx/VfxRenderer.ts`。
 *
 * 表演态：不入档（serialize 恒空桶），切场景整批散掉（`scene:beforeUnload`），读档 = 换时间线 → 同上。
 * 依赖一律构造函数窄回调注入（律 11），不 import 任何系统实例。
 *
 * ## 刺激从哪来
 *
 * 1. 显式动作 `emitVfxField`（物品用途 / 对话 / 热区 / 过场）→ `emitField`；
 * 2. 玩家动静（自动）：跟着玩家脚点走的常驻恐惧场，强度随速度；
 * 3. 场景实体灯：每盏有位置的灯一个常驻恐惧场（`light` 标签），怕不怕由物种档案说；
 * 4. 脚步：组装层在脚步落地回调里 `emitField` 一个 `sfx:footstep` 脉冲。
 *
 * 每个来源都是同一种 `VfxFieldRuntime`，群体按标签查自己的权重——不认识的标签权重 0，等于没发。
 */
import type { Texture } from 'pixi.js';

import type { AssetManager } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type {
  AnimationSetDef,
  ConditionExpr,
  GameContext,
  IGameSystem,
  LightDef,
  SceneData,
  VfxAnchorDef,
  VfxAppearanceDef,
  VfxEffectDef,
  VfxFieldDef,
  VfxFlockState,
  VfxInstanceDef,
  VfxInstanceState,
} from '../../data/types';
import { vfxEffectJsonUrl } from '../../core/projectPaths';
import type { VfxRenderer, VfxSpriteSheet } from '../../rendering/vfx/VfxRenderer';
import type { Vec3 } from '../../utils/sceneSpace';
import { evaluateConditionExpr, type ConditionEvalContext } from '../graphDialogue/evaluateGraphCondition';
import { hashSeed } from './vfxRandom';
import { VfxInstanceSim, createFieldRuntime, type VfxFieldRuntime } from './vfxSim';
import type { VfxSpace } from './vfxSpace';

/** 玩家动静场：半径 / 满强度对应的速度（wu/s） */
const PLAYER_MOTION_RADIUS_WU = 320;
const PLAYER_MOTION_FULL_SPEED = 420;
/** 玩家动静场挂在脚点上方这么高（胸口） */
const PLAYER_MOTION_HEIGHT_WU = 90;
/** 灯当恐惧源：强度按作者面 intensity 折（2.5 = 编辑器缺省一盏灯 → 强度 1） */
const LIGHT_FIELD_STRENGTH_PER_INTENSITY = 1 / 2.5;
/** 条件重评的兜底周期（秒），事件驱动之外的保险 */
const CONDITION_RECHECK_S = 0.5;
/** 群体循环声的重触发周期（秒）：空间音总线没有 loop，用一次性音按节奏补 */
const LOOP_SFX_PERIOD_S = 2.4;

export interface VfxSystemDeps {
  assetManager: AssetManager;
  /** 当前场景数据 */
  getSceneData: () => SceneData | null;
  /** 建本场景的模拟空间（field / planar）；照明载荷是异步到的，每次场景就绪后调一次、载荷到了再调一次 */
  buildSpace: () => VfxSpace;
  /** 玩家脚点（场景坐标） */
  getPlayerContact: () => { x: number; y: number } | null;
  /** 当前时段 id（时段过滤） */
  getTimePhase: () => string;
  /** 当前时段激活的实体灯（有 pos 的） */
  getActiveLights: () => readonly LightDef[];
  conditionContext: () => ConditionEvalContext;
  /**
   * **便宜**地判断"真 3D 场（行走面 + 基 + 标定）现在有没有"。
   *
   * 与 `buildSpace` 分开是因为后者要把行走面反投影成 XZ 高度场（147k 点），不能每帧调。
   * 而照明载荷是**异步到达**的：`scene:ready` 那一刻它常常还没落地，实例只好先建在
   * 平面近似上——planar 没有地面高低、没有墙，蝙蝠在一个没有崖壁的虚空里飞，
   * 而且**一切判据都是空的**（groundY 恒 0、shellContact 恒 null，"没入地""没进壳"全部假成立）。
   * 所以要有一条便宜的自愈检查，见 `update` 里的升级分支。
   */
  hasFieldGeometry: () => boolean;
  /** 空间音：从世界点播一条 sfx */
  playSfxAt: (id: string, at: Vec3) => void;
  log: (msg: string) => void;
}

interface InstanceRuntime {
  def: VfxInstanceDef;
  effect: VfxEffectDef | null;
  sim: VfxInstanceSim | null;
  /** 条件 / 时段都过 */
  eligible: boolean;
  /** 被 stopVfx 显式停掉（直到 playVfx） */
  stopped: boolean;
  /** 上次循环声触发时刻 */
  loopAt: number;
  /** 临时实例（`playVfx` 现场生成的，不在场景 JSON 里） */
  transient: boolean;
}

export class VfxSystem implements IGameSystem {
  private eventBus: EventBus | null = null;
  private renderer: VfxRenderer | null = null;
  private readonly instances = new Map<string, InstanceRuntime>();
  private readonly fields: VfxFieldRuntime[] = [];
  private readonly effectCache = new Map<string, Promise<VfxEffectDef | null>>();
  private readonly sheetCache = new Map<string, Promise<VfxSpriteSheet | null>>();
  private readonly sheets = new Map<string, VfxSpriteSheet>();
  private space: VfxSpace | null = null;
  private generation = 0;
  private time = 0;
  private recheckIn = 0;
  private conditionsDirty = true;
  private playerPrev: { x: number; y: number } | null = null;
  private playerSpeed = 0;
  private playerField: VfxFieldRuntime | null = null;
  private lightFields: VfxFieldRuntime[] = [];
  private lightsKey = '';
  private readonly onSceneReady: () => void;
  private readonly onSceneUnload: () => void;
  private readonly onConditionsMaybeChanged: () => void;
  private enabled = true;
  private lastStats = { instances: 0, live: 0, drawCalls: 0, fields: 0, simMs: 0 };

  constructor(private readonly deps: VfxSystemDeps) {
    this.onSceneReady = () => { void this.rebuildScene(); };
    this.onSceneUnload = () => this.clearScene();
    this.onConditionsMaybeChanged = () => { this.conditionsDirty = true; };
  }

  /** 渲染器由组装层建好后注入（渲染层对象；系统层可以依赖渲染层） */
  setRenderer(r: VfxRenderer | null): void {
    this.renderer?.clear();
    this.renderer = r;
  }

  init(ctx: GameContext): void {
    this.eventBus = ctx.eventBus;
    ctx.eventBus.on('scene:ready', this.onSceneReady);
    ctx.eventBus.on('scene:beforeUnload', this.onSceneUnload);
    ctx.eventBus.on('flag:changed', this.onConditionsMaybeChanged);
    ctx.eventBus.on('narrative:stateChanged', this.onConditionsMaybeChanged);
    ctx.eventBus.on('time:phaseChanged', this.onConditionsMaybeChanged);
    ctx.eventBus.on('quest:statusChanged', this.onConditionsMaybeChanged);
  }

  serialize(): Record<string, unknown> { return {}; }

  deserialize(_data: Record<string, unknown>): void {
    // 读档 = 换时间线：在途表演整批作废（scene:beforeUnload 也会来一次，这里保险）
    this.clearScene();
  }

  destroy(): void {
    this.clearScene();
    const eb = this.eventBus;
    if (eb) {
      eb.off('scene:ready', this.onSceneReady);
      eb.off('scene:beforeUnload', this.onSceneUnload);
      eb.off('flag:changed', this.onConditionsMaybeChanged);
      eb.off('narrative:stateChanged', this.onConditionsMaybeChanged);
      eb.off('time:phaseChanged', this.onConditionsMaybeChanged);
      eb.off('quest:statusChanged', this.onConditionsMaybeChanged);
    }
    this.eventBus = null;
    this.renderer?.clear();
    this.renderer = null;
    this.effectCache.clear();
    this.sheetCache.clear();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.renderer?.clear();
  }

  get isEnabled(): boolean { return this.enabled; }

  // ------------------------------------------------------------------ 场景

  /**
   * 照明载荷（行走面场 / 壳）就绪：空间换成真 3D 版并重建实例。
   *
   * 组装层在载荷回调里调一次；但那个回调**早于** `scene:ready`（载荷在 depthLoader 里就装完了），
   * 那时 `getSceneData()` 还是上一个场景、实例表也是空的，所以这一发常常什么也做不成。
   * 真正兜住的是 `update` 里那条便宜的自愈检查——这里只是让"载荷刚好晚到"的那一路早一拍生效。
   */
  onSpaceMaybeChanged(): void {
    if (!this.space) return;                       // 还没进场景：scene:ready 会建
    if (this.space.kind === 'field') return;       // 已经是真 3D
    if (!this.deps.hasFieldGeometry()) return;     // 载荷还没到
    void this.rebuildScene();
  }

  private clearScene(): void {
    this.generation++;
    for (const inst of this.instances.values()) inst.sim = null;
    this.instances.clear();
    this.fields.length = 0;
    this.playerField = null;
    this.lightFields = [];
    this.lightsKey = '';
    this.sheets.clear();
    this.space = null;
    this.playerPrev = null;
    this.playerSpeed = 0;
    this.renderer?.clear();
  }

  private async rebuildScene(): Promise<void> {
    this.clearScene();
    const gen = this.generation;
    const sd = this.deps.getSceneData();
    if (!sd) return;
    this.space = this.deps.buildSpace();
    const defs = sd.vfx ?? [];
    for (const def of defs) {
      if (!def?.id || !def.effect) continue;
      this.instances.set(def.id, { def, effect: null, sim: null, eligible: false, stopped: def.autoStart === false, loopAt: -Infinity, transient: false });
    }
    this.conditionsDirty = true;
    // 资产并行装；装完各自建 sim（条件在 update 里评）
    await Promise.all(defs.map(async (def) => {
      const effect = await this.loadEffect(def.effect);
      if (gen !== this.generation) return;
      const inst = this.instances.get(def.id);
      if (!inst) return;
      if (!effect) {
        this.deps.log(`vfx: 实例「${def.id}」引用的效果「${def.effect}」装不到，跳过`);
        return;
      }
      inst.effect = effect;
      await this.ensureSheets(def.id, effect);
      if (gen !== this.generation) return;
      this.conditionsDirty = true;
    }));
  }

  private async loadEffect(id: string): Promise<VfxEffectDef | null> {
    let p = this.effectCache.get(id);
    if (!p) {
      p = this.deps.assetManager.loadJson<VfxEffectDef>(vfxEffectJsonUrl(id))
        .then((d) => (d && typeof d === 'object' && Array.isArray(d.emitters) ? d : null))
        .catch((e) => { this.deps.log(`vfx: 效果「${id}」加载失败：${String(e)}`); return null; });
      this.effectCache.set(id, p);
    }
    return p;
  }

  private async ensureSheets(instanceId: string, effect: VfxEffectDef): Promise<void> {
    await Promise.all(effect.emitters.map(async (e) => {
      const sheet = await this.loadSheet(e.appearance);
      if (sheet) this.sheets.set(`${instanceId}/${e.id}`, sheet);
      else this.deps.log(`vfx: 发射器「${effect.id}/${e.id}」的贴图装不到（animFile=${e.appearance.animFile ?? ''} image=${e.appearance.image ?? ''}）`);
    }));
  }

  private loadSheet(ap: VfxAppearanceDef): Promise<VfxSpriteSheet | null> {
    const key = `${ap.animFile ?? ''}|${ap.image ?? ''}|${ap.state ?? ''}|${ap.restState ?? ''}`;
    let p = this.sheetCache.get(key);
    if (p) return p;
    p = (async (): Promise<VfxSpriteSheet | null> => {
      const am = this.deps.assetManager;
      if (ap.animFile) {
        const def = await am.loadJson<AnimationSetDef>(ap.animFile);
        if (!def || !def.spritesheet || !def.states) return null;
        const dir = ap.animFile.substring(0, ap.animFile.lastIndexOf('/') + 1);
        const sheetUrl = def.spritesheet.startsWith('/') ? def.spritesheet : dir + def.spritesheet;
        const tex: Texture = await am.loadTexture(sheetUrl);
        const cols = Math.max(1, def.cols | 0), rows = Math.max(1, def.rows | 0);
        const stateName = ap.state && def.states[ap.state] ? ap.state : Object.keys(def.states)[0];
        const st = def.states[stateName];
        if (!st) return null;
        const rect = (idx: number) => {
          const c = idx % cols, r = Math.floor(idx / cols);
          return { u0: c / cols, v0: r / rows, u1: (c + 1) / cols, v1: (r + 1) / rows };
        };
        const frames = (st.frames ?? [0]).map(rect);
        const cw = tex.width / cols, ch = tex.height / rows;
        let restFrame: VfxSpriteSheet['restFrame'];
        if (ap.restState && def.states[ap.restState]?.frames?.length) restFrame = rect(def.states[ap.restState].frames[0]);
        return { texture: tex, frames, aspect: ch / Math.max(cw, 1e-6), frameRate: st.frameRate ?? 8, restFrame };
      }
      if (ap.image) {
        const tex: Texture = await am.loadTexture(ap.image);
        return { texture: tex, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: tex.height / Math.max(tex.width, 1e-6), frameRate: 0 };
      }
      return null;
    })().catch((e) => { this.deps.log(`vfx: 贴图加载失败：${String(e)}`); return null; });
    this.sheetCache.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------ 条件 / 实例

  private evalEligible(inst: InstanceRuntime): boolean {
    const d = inst.def;
    if (d.timePhases?.length) {
      const ph = this.deps.getTimePhase();
      if (!d.timePhases.includes(ph)) return false;
    }
    if (d.conditions?.length) {
      const ctx = this.deps.conditionContext();
      for (const c of d.conditions as ConditionExpr[]) if (!evaluateConditionExpr(c, ctx)) return false;
    }
    return true;
  }

  private ensureSim(inst: InstanceRuntime): void {
    if (inst.sim || !inst.effect || !this.space) return;
    const seed = typeof inst.def.seed === 'number' ? (inst.def.seed >>> 0) : hashSeed(inst.def.id);
    const anchor = this.space.anchorToWorld(inst.def.anchor);
    inst.sim = new VfxInstanceSim(inst.def.id, inst.effect, anchor, seed, this.space, inst.def.countScale ?? 1);
  }

  private refreshConditions(): void {
    for (const inst of this.instances.values()) {
      const ok = this.evalEligible(inst);
      inst.eligible = ok;
      if (ok && !inst.stopped) this.ensureSim(inst);
      else if (inst.sim) inst.sim = null;
    }
  }

  // ------------------------------------------------------------------ 对外（动作 / 条件 / 调试）

  /** 条件叶 `vfxState`：不在场 → null */
  getInstanceState(id: string): VfxInstanceState | null {
    const inst = this.instances.get(id);
    if (!inst) return null;
    if (!inst.sim) return 'inactive';
    return inst.sim.state;
  }

  /**
   * `playVfx`：按实例 id 开（被 stop 过的重开；条件不满足仍不开），或现场生成一个临时实例
   * （`effect` + `anchor`，不在场景 JSON 里，切场景即散）。
   */
  playVfx(opts: { instanceId?: string; effect?: string; anchor?: VfxAnchorDef; seed?: number; countScale?: number }): void {
    if (opts.instanceId) {
      const inst = this.instances.get(opts.instanceId);
      if (!inst) { this.deps.log(`playVfx: 当前场景没有实例「${opts.instanceId}」`); return; }
      inst.stopped = false;
      if (inst.sim) inst.sim.start();
      this.conditionsDirty = true;
      return;
    }
    if (!opts.effect || !opts.anchor) { this.deps.log('playVfx: 需要 instanceId，或 effect + anchor'); return; }
    const id = `__vfx_${opts.effect}_${++this.transientSeq}`;
    const def: VfxInstanceDef = { id, effect: opts.effect, anchor: opts.anchor, seed: opts.seed, countScale: opts.countScale, autoStart: true };
    const inst: InstanceRuntime = { def, effect: null, sim: null, eligible: true, stopped: false, loopAt: -Infinity, transient: true };
    this.instances.set(id, inst);
    const gen = this.generation;
    void this.loadEffect(opts.effect).then(async (effect) => {
      if (gen !== this.generation || !effect) return;
      inst.effect = effect;
      await this.ensureSheets(id, effect);
      if (gen !== this.generation) return;
      this.conditionsDirty = true;
    });
  }

  private transientSeq = 0;

  stopVfx(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.stopped = true;
    if (inst.transient) { this.instances.delete(instanceId); return; }
    inst.sim?.stop();
  }

  setVfxState(instanceId: string, state: VfxFlockState): void {
    const inst = this.instances.get(instanceId);
    inst?.sim?.setFlockState(state);
  }

  /** 发一个刺激场（世界点）。`handle` 给常驻场（同名覆盖），不给 = 按 duration 自灭 */
  emitField(def: VfxFieldDef, at: Vec3, handle?: string): void {
    if (handle) {
      const i = this.fields.findIndex((f) => f.handle === handle);
      const f = createFieldRuntime(def, at, handle);
      if (i >= 0) this.fields[i] = f; else this.fields.push(f);
      return;
    }
    this.fields.push(createFieldRuntime(def, at));
  }

  removeField(handle: string): void {
    const i = this.fields.findIndex((f) => f.handle === handle);
    if (i >= 0) this.fields.splice(i, 1);
  }

  /** 画面点 → 世界（动作参数 `at` 解析用；没有空间时 null） */
  sceneToWorld(sceneX: number, sceneY: number, h = 0): Vec3 | null {
    if (!this.space) return null;
    const g = this.space.groundWorldAtScene(sceneX, sceneY);
    return [g[0], g[1] + h, g[2]];
  }

  /**
   * 粒子工作台联动（DEV）：用工作态的效果定义覆盖缓存，并重建所有引用它的实例（锚点不变）。
   * `def = null` 撤销覆盖（回到磁盘上那份，下次装载重读）。
   */
  applyPreviewEffect(effectId: string, def: VfxEffectDef | null): void {
    if (def) this.effectCache.set(effectId, Promise.resolve(def));
    else this.effectCache.delete(effectId);
    for (const inst of this.instances.values()) {
      if (inst.def.effect !== effectId) continue;
      inst.sim = null;
      inst.effect = null;
      const gen = this.generation;
      void this.loadEffect(effectId).then(async (eff) => {
        if (gen !== this.generation || !eff) return;
        inst.effect = eff;
        await this.ensureSheets(inst.def.id, eff);
        if (gen !== this.generation) return;
        this.conditionsDirty = true;
      });
    }
  }

  /** 工作台联动：当前场景里引用某效果的实例 id（回传给工作台画状态用） */
  instancesOfEffect(effectId: string): string[] {
    const out: string[] = [];
    for (const inst of this.instances.values()) if (inst.def.effect === effectId) out.push(inst.def.id);
    return out;
  }

  /** 当前模拟空间（F2 用来分清"真 3D 场"与"平面近似"——后者所有几何判据都空成立）。 */
  get currentSpace(): VfxSpace | null { return this.space; }

  get stats(): { instances: number; live: number; drawCalls: number; fields: number; simMs: number } {
    return this.lastStats;
  }

  /** 调试面板读：每个实例的状态 */
  debugSnapshot(): { id: string; effect: string; state: string; live: number; eligible: boolean }[] {
    const out: { id: string; effect: string; state: string; live: number; eligible: boolean }[] = [];
    for (const inst of this.instances.values()) {
      out.push({ id: inst.def.id, effect: inst.def.effect, state: this.getInstanceState(inst.def.id) ?? 'n/a', live: inst.sim?.liveCount ?? 0, eligible: inst.eligible });
    }
    return out;
  }

  // ------------------------------------------------------------------ 每帧

  update(dt: number): void {
    if (!this.enabled || !this.space) return;
    // 自愈：进场景时照明载荷往往还没到，实例先建在平面近似上（没有地面高低、没有墙，
    // 所有几何判据都空成立）。载荷一落地就换成真 3D 场重建——判据便宜（只读几个 getter），
    // 真正贵的建高度场只在 kind 真的要变时才发生。
    if (this.space.kind === 'planar' && this.deps.hasFieldGeometry()) {
      void this.rebuildScene();
      return;
    }
    this.time += dt;
    this.recheckIn -= dt;
    if (this.conditionsDirty || this.recheckIn <= 0) {
      this.conditionsDirty = false;
      this.recheckIn = CONDITION_RECHECK_S;
      this.refreshConditions();
    }
    // ---- 玩家：脚点世界坐标 + 速度（差分，低通）
    const pc = this.deps.getPlayerContact();
    let player: { world: Vec3; speed: number } | null = null;
    if (pc) {
      if (this.playerPrev && dt > 0) {
        const v = Math.hypot(pc.x - this.playerPrev.x, pc.y - this.playerPrev.y) / dt;
        this.playerSpeed += (v - this.playerSpeed) * Math.min(1, dt * 8);
      }
      this.playerPrev = { x: pc.x, y: pc.y };
      const w = this.space.groundWorldAtScene(pc.x, pc.y);
      player = { world: w, speed: this.playerSpeed };
      // 玩家动静场（常驻、跟随）
      const strength = Math.min(1.5, this.playerSpeed / PLAYER_MOTION_FULL_SPEED);
      const at: Vec3 = [w[0], w[1] + PLAYER_MOTION_HEIGHT_WU, w[2]];
      if (!this.playerField) {
        this.playerField = createFieldRuntime({ kind: 'fear', tag: 'player:motion', radius: PLAYER_MOTION_RADIUS_WU, strength }, at, 'player:motion');
        this.fields.push(this.playerField);
      } else {
        this.playerField.pos[0] = at[0]; this.playerField.pos[1] = at[1]; this.playerField.pos[2] = at[2];
        this.playerField.def = { ...this.playerField.def, strength };
      }
    }
    // ---- 灯当恐惧源（时段一变灯表就变，按 key 重建）
    this.refreshLightFields();
    // ---- 场老化
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      if (f.remaining === Infinity) continue;
      f.remaining -= dt;
      if (f.remaining <= 0) this.fields.splice(i, 1);
    }
    // ---- 模拟
    const t0 = performance.now();
    const ctx = { fields: this.fields, player, time: this.time };
    const sims: VfxInstanceSim[] = [];
    let live = 0;
    for (const inst of this.instances.values()) {
      const sim = inst.sim;
      if (!sim) continue;
      sim.step(dt, ctx);
      live += sim.liveCount;
      sims.push(sim);
      this.handleEvents(inst, sim);
    }
    const simMs = performance.now() - t0;
    // ---- 渲染
    if (this.renderer) this.renderer.render(sims, this.sheets);
    this.lastStats = {
      instances: sims.length, live, drawCalls: this.renderer?.drawCallCount ?? 0,
      fields: this.fields.length, simMs,
    };
  }

  private handleEvents(inst: InstanceRuntime, sim: VfxInstanceSim): void {
    for (const ev of sim.events) {
      if (ev.type === 'sound') this.deps.playSfxAt(ev.sfx, ev.at);
      else if (ev.type === 'field') this.emitField(ev.def, ev.at);
      else if (ev.type === 'hit') {
        const e = sim.emitters.find((x) => x.def.id === ev.emitter);
        if (e?.def.sound?.hit) this.deps.playSfxAt(e.def.sound.hit, ev.at);
      }
    }
    // 循环声：飞着的群按节奏重触发一次性音（空间音总线没有 loop）
    for (const e of sim.emitters) {
      const loop = e.def.sound?.loop;
      if (!loop) continue;
      const flying = e.flock ? (e.flock.state !== 'roosting') : e.p.liveCount > 0;
      if (!flying) continue;
      if (this.time - inst.loopAt >= LOOP_SFX_PERIOD_S) {
        inst.loopAt = this.time;
        this.deps.playSfxAt(loop, sim.centroid([0, 0, 0]));
      }
    }
  }

  private refreshLightFields(): void {
    const lights = this.deps.getActiveLights();
    let key = '';
    for (const l of lights) if (l.pos) key += `${l.id}:${l.pos[0]},${l.pos[1]},${l.pos[2]},${l.intensity},${l.range ?? ''};`;
    if (key === this.lightsKey) return;
    this.lightsKey = key;
    for (const f of this.lightFields) {
      const i = this.fields.indexOf(f);
      if (i >= 0) this.fields.splice(i, 1);
    }
    this.lightFields = [];
    for (const l of lights) {
      if (!l.pos || !(l.intensity > 0)) continue;
      const f = createFieldRuntime(
        { kind: 'fear', tag: 'light', radius: l.range ?? 450, strength: Math.min(3, l.intensity * LIGHT_FIELD_STRENGTH_PER_INTENSITY) },
        [l.pos[0], l.pos[1], l.pos[2]], `light:${l.id}`,
      );
      this.lightFields.push(f);
      this.fields.push(f);
    }
  }
}
