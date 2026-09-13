import type { IGameSystem, GameContext, LightDef } from '../../data/types';
import type { PropLightDef, PropPresetDef, ResolvedPropAttach } from '../../data/propPresets';
import { resolvePropAttach, resolvePropStateName } from '../../data/propPresets';
import { flameOutput, flickerAmpWithWind, lightChangedEnough, transitionProgress } from './heldPropSignal';

type Vec3 = [number, number, number];

/**
 * 手持挂件（火把 / 灯笼 / 提灯）的运行态。
 *
 * ## 干三件事（都是"运行时的灯与手上的东西"，同一批依赖）
 *
 * ① **挂件的状态机**：`attach` / `setState` / `detach`。状态是**离散**的（点着 / 护火 /
 *    残炭 / 灭），动作只切状态名；连续量（灯的渐变、火焰的闪、发射率）在这里逐帧算 ——
 *    这是本项目既有的形状（轨迹烘成资产、粒子是效果资产，动作只说"谁、播哪条"）。
 * ② **跟随灯**：挂件自带的灯，以及场景里配了 `LightDef.follow` 的作者灯（更夫的灯笼），
 *    每帧解出位置后经 `SceneLightingSystem.setDynamicLights` 加在作者灯之外
 *    （**绝不写作者数据**——那份会被编辑器实时同步回写进场景 JSON）。
 *    效果锚点同理经 `VfxSystem.moveInstanceAnchor` 挪。
 * ③ **灯的渐灭 / 渐亮**（`fadeLight`）：作者灯的强度**倍率**覆盖，门口那盏灯笼被风吹灭走这条。
 *
 * ## 闪 = 一个信号
 *
 * `heldPropSignal.flameOutput` 产一个 `L(t)`，同时驱动灯的强度与发射率。
 * 两处各摇一个随机数会看出"灯在闪、火苗不动"，所以这里只有一个信号。
 *
 * ## 存档
 *
 * 只有 `persistent: true` 的预设（手持物）入档，存的是**玩法事实**
 * （谁、哪个挂点、哪支、什么状态）；贴图 / 灯 / 粒子全是从这条事实**派生**的表现，
 * 与位面对账器同一个形状：切场景与读档都重派生一次，自己零表现态持久化。
 * 演出挂件（缺省）不入档、切场景即散 —— 与既有 `attachToSocket` 行为一致。
 *
 * ## 分层
 *
 * 依赖一律窄回调注入（律 11）：本系统不 import 渲染层、不 import 别的系统。
 */

export interface HeldPropDeps {
  getPreset: (propId: string) => PropPresetDef | undefined;
  /**
   * 挂点在**当前帧**的容器局部位姿（场景 wu，y 向上为负）。
   * 这一帧没标注 ⇒ null（挂件此刻是隐着的，灯也该跟着灭 —— 刀在鞘里手上就没有火）。
   */
  getSocketLocalPose: (targetId: string, socket: string) => { x: number; y: number } | null;
  /** 实体脚点（场景坐标 wu）；实体不在场 ⇒ null */
  getEntityContact: (targetId: string) => { x: number; y: number } | null;
  /** 该实体动画包里**已标注**的挂点名；实体不在场 ⇒ null（拼错挂点名要能报出来） */
  listSockets: (targetId: string) => string[] | null;
  /** 场景点 + 离地高度（wu）→ 灯世界坐标（wu）。没有几何载荷 ⇒ null */
  sceneToLightWorld: (sceneX: number, sceneY: number, heightWu: number) => Vec3 | null;
  /**
   * 该点处的空气速度大小（wu/s，场景风）。`heightWu` = 离地高度（风的对数廓线要它）。
   * 场景没配风 ⇒ 0。
   */
  windSpeedAt: (world: Vec3, heightWu: number) => number;
  /** 挂/换贴图（切状态会重挂一次，纹理变了没法淡入淡出） */
  attachView: (targetId: string, socket: string, resolved: ResolvedPropAttach) => Promise<void>;
  detachView: (targetId: string, socket: string) => void;
  /** 把运行时灯整批推给光照系统（空数组 = 一盏也没有） */
  setDynamicLights: (lights: LightDef[]) => void;
  /** 把作者灯的强度倍率整批推给光照系统（`fadeLight`；空表 = 没有任何覆盖） */
  setLightIntensityScales: (scales: Map<string, number>) => void;
  playVfx: (effect: string, world: Vec3) => string | null;
  moveVfx: (id: string, world: Vec3) => boolean;
  /** 硬停：当场散（卸下挂件 / 拆除） */
  stopVfx: (id: string) => void;
  /** 软停：不再发射、在飞的飞完（切状态：火舌停了，空中的火星该飞完） */
  softStopVfx: (id: string) => void;
  setVfxRate: (id: string, k: number) => void;
  log: (m: string) => void;
}

/** 这一次挂载的显式覆盖（动作参数里写的"这次歪着拿"）。切状态时仍然生效。 */
export interface HeldPropOverrides {
  images?: string[];
  anchorX?: number;
  anchorY?: number;
  rotation?: number;
  scale?: number;
  lit?: boolean;
  mirror?: boolean;
}

interface HeldEntry {
  target: string;
  socket: string;
  propId: string;
  overrides: HeldPropOverrides;
  /** 当前状态名；没有状态表时是空串 */
  state: string;
  persistent: boolean;
  resolved: ResolvedPropAttach;
  /** 自挂上累计秒（火焰信号的钟，不读挂钟） */
  time: number;
  /** 火焰信号的种子：两支并排的火把不同步 */
  seed: number;
  /** 状态过渡：强度从 → 到（毫秒计时） */
  fadeFrom: number;
  fadeTo: number;
  fadeMs: number;
  fadeElapsedMs: number;
  /**
   * 这一帧**用哪盏灯的形状**（色温 / 半径 / 软化 / 闪烁）。
   *
   * 与 `resolved.light` 不同的一种情况就是"渐灭到没有灯的状态"：目标状态 `light: null`
   * 时它仍是上一个状态那盏，强度插值到 0 之后才置 null —— 否则 `fadeMs` 算了也发不出去，
   * 画面上是啪一下黑（2026-09-12 无头实测抓到）。
   */
  lightDef: PropLightDef | null;
  vfxIds: string[];
  /** 效果该开但锚点当时还解不出来（挂点没标注 / 载荷未到）：等 update 里解出来再开 */
  vfxPending: boolean;
  /**
   * 上次推灯以来逐帧强度的累加与帧数 —— 推出去的是**这一段的均值**，不是当帧瞬时值。
   *
   * 为什么必须这样:闪烁的三个分量在 7 / 16.9 / 36.6 Hz,而推送限速到 20 Hz,
   * 瞬时采样的 Nyquist 只有 10 Hz ⇒ 上面两个谐波**折叠**成 1~2 Hz 的慢晃,
   * 谷底还被削掉(实测 RMS 偏离真值 10.8%、单次跳变到基准的 20%)。
   * 取区间均值就是正规的抽取滤波:推送率不变、混叠消掉,灯读起来是干净的 7 Hz 呼吸,
   * 细碎的爆裂交给逐帧免费的发射率那一路(眼睛从火苗读爆裂、从光圈读呼吸)。
   */
  iSum: number;
  iCount: number;
  lastLight: { pos: Vec3; intensity: number } | null;
}

/** 运行时灯的 id 前缀：`__` 开头，与作者灯 id 天然不撞（校验器不许作者用 `__`） */
const DYNAMIC_LIGHT_PREFIX = '__prop';

/** 位置死区（wu）：1 wu ≈ 角色身高的 1/150，屏幕上远小于一个像素 */
const POS_EPS_WU = 1;

/**
 * 闪烁的**推送频率上限**（Hz）。不是表现参数，是性能闸：灯每推一次就重烘一次整张
 * 光照缓存。7 Hz 的明灭按 20 Hz 采样人眼看不出台阶（每个周期约 3 个样本），
 * 而稳态重算从"几乎每帧"降到三分之一。要更顺滑就把它调高，代价直接写在帧时上。
 */
const FLICKER_PUSH_HZ = 20;
const FLICKER_PUSH_INTERVAL_MS = 1000 / FLICKER_PUSH_HZ;

/**
 * 推送率的**观感代价**（2026-09-12 实测 + 盒式滤波响应推算，两者对得上，误差 < 2%）：
 * 窗口均值把高谐波滤掉，于是灯的摆幅小于作者写的 `amp`。
 *
 * | Hz | 振幅保留率 | 60 fps 下重算帧占比 |
 * |---|---|---|
 * | 20（缺省） | 0.65（实测） | 1/3 |
 * | 30 | ~0.79 | 1/2 |
 * | 40 | ~0.85 | 2/3 |
 * | ≥73 | ~1.0（无滤波） | 几乎每帧，省下的全吐回去 |
 *
 * 这是**观感 × 帧时**的取舍，没有正确答案 —— 所以它可以在 F2 里当场换着看
 * （`setFlickerPushHz`，调试态、不落盘）。
 */
export const FLICKER_PUSH_HZ_CHOICES = [20, 30, 40, 60] as const;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class HeldPropSystem implements IGameSystem {
  private entries = new Map<string, HeldEntry>();
  /** 世代号：读档 / 拆除让在途的异步挂载自杀（律 4「旧时间线不写新状态」） */
  private generation = 0;
  /** 上一帧推出去的灯数，用于"从有到无"也要推一次空表 */
  private pushedCount = 0;
  /** 距上次推灯过了多少毫秒（闪烁限速用） */
  private sincePushMs = FLICKER_PUSH_INTERVAL_MS;
  /** 当前推送间隔（毫秒）。F2 可临时换档看观感，见 {@link setFlickerPushHz} */
  private pushIntervalMs = FLICKER_PUSH_INTERVAL_MS;
  /** 本场景里配了 `follow` 的作者灯（进场景时由组装层给） */
  private followLights: LightDef[] = [];
  /** 跟随灯的死区基准（灯 id → 上一次推出去的位置与强度） */
  private followLastPos = new Map<string, { pos: Vec3; intensity: number }>();
  /** 作者灯的强度倍率（落定值）与在途过渡。见 {@link fadeLight} */
  private scales = new Map<string, number>();
  private fades = new Map<string, { from: number; to: number; ms: number; elapsed: number }>();

  constructor(private readonly deps: HeldPropDeps) {}

  init(_ctx: GameContext): void {
    // 无外部状态；重 init 与首次一致（清空即可）
    this.clearAll(false);
  }

  private key(target: string, socket: string): string {
    return `${target}::${socket}`;
  }

  // ------------------------------------------------------------------ 对外（动作 / 组装层）

  /**
   * 挂一支（或换一支）。`stateName` 不给时走预设的 `defaultState`。
   *
   * 贴图的实际挂载由组装层的回调做（它管资源），本系统只管"这个挂点上现在是哪支、
   * 什么状态"以及灯与效果。同名挂点重复挂 = 先把旧的收干净。
   */
  async attach(
    targetId: string, socket: string, propId: string,
    stateName?: string, overrides: HeldPropOverrides = {},
  ): Promise<void> {
    const target = targetId.trim();
    const sock = socket.trim();
    const prop = propId.trim();
    if (!target || !sock || !prop) return;
    const preset = this.deps.getPreset(prop);
    /**
     * 预设根本不在表里 ⇒ **不登记**（组装层已经报过警）。
     * 登记会留一条幽灵：占着这个挂点的 key、在调试面板里显示一个不存在的挂件，
     * 而它连图都没有、永远挂不出东西（2026-09-12 无头实测抓到）。
     */
    if (!preset) {
      this.deps.log(`attachToSocket: 挂件预设「${prop}」不在 prop_presets.json 里，未登记`);
      return;
    }
    const state = resolvePropStateName(preset, stateName);
    if (stateName && preset.states && !state) {
      this.deps.log(`attachToSocket: 挂件「${prop}」没有状态「${stateName}」`);
    }
    /**
     * 挂点名拼错是内容侧最容易犯的错，而它的表现是**完全静默**：每帧 `getSocketLocalPose`
     * 返回 null ⇒ 不发光、不起效果，看起来像"预设配错了"。这里查一次并报出可选名单。
     * 只报不拒 —— 实体可能还没进场（读档时序），拒了会让合法的手持物挂不上。
     */
    const known = this.deps.listSockets(target);
    if (known && !known.includes(sock)) {
      this.deps.log(
        `attachToSocket: ${target} 的动画包没有挂点「${sock}」`
        + `（本包有：${known.length ? known.join('、') : '一个都没标'}）—— 灯与效果不会出现`,
      );
    }
    this.detach(target, sock);
    const resolved = resolvePropAttach(preset, overrides, state);
    const entry: HeldEntry = {
      target, socket: sock, propId: prop, overrides, state,
      persistent: preset?.persistent === true,
      resolved,
      time: 0,
      seed: hashSeed(`${target}/${sock}/${prop}`),
      fadeFrom: resolved.light?.intensity ?? 0,
      fadeTo: resolved.light?.intensity ?? 0,
      fadeMs: 0,
      fadeElapsedMs: 0,
      lightDef: resolved.light,
      vfxIds: [],
      vfxPending: false,
      iSum: 0,
      iCount: 0,
      lastLight: null,
    };
    this.entries.set(this.key(target, sock), entry);
    this.startVfx(entry);
    await this.applyView(entry);
  }

  /**
   * 把当前状态的贴图挂上去。**跨 await 拍世代号**：贴图是异步加载的，回来时世界可能已经
   * 换了（读档 / 切场景 / 这个挂点已被卸下），此时刚挂上的就是个孤儿 —— 当场收掉并中止，
   * 不留残影（teardown-ordering 卡里的"世代号自杀"形状）。
   */
  private async applyView(entry: HeldEntry): Promise<void> {
    const gen = this.generation;
    const resolved = entry.resolved;
    await this.deps.attachView(entry.target, entry.socket, resolved);
    if (gen === this.generation && this.entries.get(this.key(entry.target, entry.socket)) === entry) return;
    this.deps.detachView(entry.target, entry.socket);
  }

  /**
   * 切状态。`fadeMs` 只作用于**灯的强度**（贴图与效果是离散的，纹理没法淡入淡出——
   * 想要"渐变的火焰"就多配一个中间状态）。
   *
   * 挂点上没有挂件时安静返回 false，调用方据此报警。
   */
  setState(targetId: string, socket: string, stateName: string, fadeMs = 0): boolean {
    const entry = this.entries.get(this.key(targetId.trim(), socket.trim()));
    if (!entry) return false;
    const preset = this.deps.getPreset(entry.propId);
    const want = stateName.trim();
    if (!preset?.states?.[want]) {
      this.deps.log(`setPropState: 挂件「${entry.propId}」没有状态「${want}」`);
      return false;
    }
    if (entry.state === want) return true;
    const prevIntensity = this.currentBaseIntensity(entry);
    const prevLight = entry.lightDef;
    entry.state = want;
    entry.resolved = resolvePropAttach(preset, entry.overrides, want);
    entry.fadeFrom = prevIntensity;
    entry.fadeTo = entry.resolved.light?.intensity ?? 0;
    entry.fadeMs = Math.max(0, fadeMs);
    entry.fadeElapsedMs = 0;
    /**
     * 新状态没有灯（`light: null`，灭了的火把）而又要渐灭 ⇒ **留着上一盏的形状**把强度
     * 送到 0，过渡跑完才真的撤灯。直接换成 null 的话 update 那边整段跳过，`fadeMs`
     * 白算、画面第一帧就黑（2026-09-12 实测：内部 0.6→0 走得好好的，画面啪一下）。
     */
    entry.lightDef = entry.resolved.light
      ?? (entry.fadeMs > 0 && prevIntensity > 0 ? prevLight : null);
    // 效果整批换：上一批**软停**（不再发射、在飞的自己老化完）——火舌停了、空中那几点
    // 火星该飞完再灭，瞬间清空是假的
    this.stopVfx(entry, true);
    this.startVfx(entry);
    void this.applyView(entry);
    return true;
  }

  /** 卸下：贴图、灯、效果一起收走。 */
  detach(targetId: string, socket: string): void {
    const k = this.key(targetId.trim(), socket.trim());
    const entry = this.entries.get(k);
    if (!entry) return;
    this.entries.delete(k);
    this.stopVfx(entry);
    this.deps.detachView(entry.target, entry.socket);
  }

  /**
   * 第三件事：**作者灯的渐灭 / 渐亮**（`fadeLight` 动作）。
   *
   * 存的是**强度倍率**而不是绝对强度：作者在编辑器里把那盏灯调亮调暗，运行时这条覆盖
   * 仍然成立（绝对值会把作者的调整整个盖掉）。倍率到 0 = 熄灭（那盏灯连灯槽都不占）。
   *
   * 演出态：不落盘、切场景清空。
   */
  fadeLight(lightId: string, toScale: number, fadeMs = 0): void {
    const id = lightId.trim();
    if (!id) return;
    const to = Number.isFinite(toScale) ? Math.max(0, toScale) : 0;
    const from = this.scaleOf(id);
    if (!(fadeMs > 0)) {
      this.fades.delete(id);
      this.scales.set(id, to);
      this.pushScales();
      return;
    }
    this.fades.set(id, { from, to, ms: fadeMs, elapsed: 0 });
  }

  /** 当前倍率：有在途过渡取插值，否则取落定值，都没有 ⇒ 1（没被碰过的灯） */
  private scaleOf(lightId: string): number {
    const f = this.fades.get(lightId);
    if (f) return f.from + (f.to - f.from) * transitionProgress(f.elapsed, f.ms);
    return this.scales.get(lightId) ?? 1;
  }

  /** 推进在途的灯光过渡；有变化就整批推一次倍率表 */
  private advanceFades(dtMs: number): void {
    if (this.fades.size === 0) return;
    for (const [id, f] of [...this.fades]) {
      f.elapsed += dtMs;
      const p = transitionProgress(f.elapsed, f.ms);
      this.scales.set(id, f.from + (f.to - f.from) * p);
      if (p >= 1) this.fades.delete(id);
    }
    this.pushScales();
  }

  private pushScales(): void {
    this.deps.setLightIntensityScales(new Map(this.scales));
  }

  /**
   * 调试态：临时换闪烁的推送率（不落盘、切场景不重置——就是要能前后对比）。
   * 定下来要改缺省的话改 `FLICKER_PUSH_HZ` 那个常量，不要把调试值写进数据。
   */
  setFlickerPushHz(hz: number): void {
    const v = Number.isFinite(hz) && hz > 0 ? hz : FLICKER_PUSH_HZ;
    this.pushIntervalMs = 1000 / v;
  }

  get flickerPushHz(): number {
    return Math.round(1000 / this.pushIntervalMs);
  }

  /** 当前挂着什么（调试快照 / 编辑器实时面板）。 */
  debugSnapshot(): { target: string; socket: string; prop: string; state: string; lightIntensity: number }[] {
    return [...this.entries.values()].map((e) => ({
      target: e.target, socket: e.socket, prop: e.propId, state: e.state,
      lightIntensity: this.currentBaseIntensity(e),
    }));
  }

  /**
   * 换场景：演出挂件散掉，手持物按玩法事实重挂（实体是新建出来的，视图必须重贴）。
   * 与位面对账器同一个形状 —— 每个边界重派生一次。
   *
   * `followLights` = 新场景里配了 `follow` 的作者灯（组装层从场景数据挑出来给）。
   */
  onSceneChanged(followLights: readonly LightDef[] = []): void {
    /**
     * 留下谁：手持物（入档的）**以及玩家身上的演出挂件**。
     *
     * 后半条是**既有语义**，不是新规则：玩家跨场景长活，组装层的 `destroySceneSocketViews`
     * 刻意只收 NPC 的挂件、留着玩家的（"重挂由内容侧决定"）。NPC 的不留——它们连实体
     * 本身都换了一批，同名 NPC 在新场景重新长出来时手上凭空多把剑才是错的。
     */
    const keep = [...this.entries.values()].filter((e) => e.persistent || e.target === 'player');
    this.clearAll(true);
    this.followLights = followLights.map((l) => ({ ...l }));
    this.followLastPos.clear();
    // 灯的渐灭覆盖是演出态：新场景的灯表是另一套 id，留着只会误伤同名灯
    if (this.scales.size > 0 || this.fades.size > 0) {
      this.scales.clear();
      this.fades.clear();
      this.pushScales();
    }
    for (const e of keep) void this.attach(e.target, e.socket, e.propId, e.state || undefined, e.overrides);
  }

  /**
   * 场景里配了 `follow` 的作者灯：每帧解成运行时灯。
   *
   * 解不出来（目标不在场 / 挂点这帧没标注 / 没有几何载荷）⇒ **这一帧这盏灯不发光**，
   * 不回落到作者写的 `pos`（回落 = 一盏灯莫名钉在半空，比不亮更难查）。
   */
  private resolveFollowLight(l: LightDef): LightDef | null {
    const f = l.follow;
    if (!f) return null;
    const contact = this.deps.getEntityContact(f.target);
    if (!contact) return null;
    let sceneX = contact.x;
    let height = f.heightWu ?? 0;
    const sock = f.socket?.trim();
    if (sock) {
      const pose = this.deps.getSocketLocalPose(f.target, sock);
      if (!pose) return null;
      sceneX += pose.x;
      height += -pose.y;
    }
    const w = this.deps.sceneToLightWorld(sceneX, contact.y, height);
    if (!w) return null;
    const off = f.offset;
    const pos: [number, number, number] = off
      ? [w[0] + off[0], w[1] + off[1], w[2] + off[2]]
      : [w[0], w[1], w[2]];
    // 强度倍率（fadeLight）在光照系统那一层作用于作者灯，而跟随灯走的是运行时灯这条路
    // （原件已被那边跳过），所以要在这里自己乘一次 —— 两条路都吹得灭，语义才一致。
    const intensity = l.intensity * this.scaleOf(l.id);
    if (!(intensity > 0)) return null;
    const out: LightDef = { ...l, pos, intensity, enabled: true };
    delete out.follow;
    return out;
  }

  // ------------------------------------------------------------------ 逐帧

  update(dt: number): void {
    this.advanceFades(dt * 1000);
    if (this.entries.size === 0 && this.followLights.length === 0) {
      if (this.pushedCount > 0) {
        this.pushedCount = 0;
        this.deps.setDynamicLights([]);
      }
      return;
    }
    this.sincePushMs += dt * 1000;
    const lights: LightDef[] = [];
    /** 位置动了 / 灯的增减 ⇒ 立刻推；只有强度在变（闪烁）⇒ 限速推（见 FLICKER_PUSH_HZ） */
    let moved = false;
    let flickered = false;
    // ① 场景里配了 follow 的作者灯
    for (const src of this.followLights) {
      const resolved = this.resolveFollowLight(src);
      const prev = this.followLastPos.get(src.id) ?? null;
      if (!resolved) {
        if (prev) { moved = true; this.followLastPos.delete(src.id); }
        continue;
      }
      lights.push(resolved);
      const now = { pos: resolved.pos as Vec3, intensity: resolved.intensity };
      if (lightChangedEnough(prev, now, POS_EPS_WU, Infinity)) moved = true;
      else if (lightChangedEnough(prev, now)) flickered = true;
    }
    // ② 挂件自带的灯
    for (const entry of this.entries.values()) {
      entry.time += dt;
      entry.fadeElapsedMs += dt * 1000;
      const anchor = this.resolveAnchorWorld(entry);
      // 渐灭到"没有灯"的状态时这里仍是上一盏的形状，强度到 0 之后才撤（见 lightDef 注释）
      if (entry.lightDef && !entry.resolved.light
        && transitionProgress(entry.fadeElapsedMs, entry.fadeMs) >= 1) {
        entry.lightDef = null;
      }
      const light = entry.lightDef;
      // 挂点这一帧没标注（挂件隐着）或场景没有几何 ⇒ 这一帧不发光、效果原地不动
      if (anchor && light) {
        // 逐帧算真值（发射率吃这一个），累进区间均值（灯吃均值，见 iSum 注释）
        const instant = this.liveIntensity(entry, anchor.world, anchor.heightWu, light);
        entry.iSum += instant;
        entry.iCount++;
        const intensity = entry.iSum / entry.iCount;
        if (intensity > 0) {
          const def = this.buildLightDef(entry, light, anchor.world, intensity);
          lights.push(def);
          const now = { pos: anchor.world, intensity };
          if (lightChangedEnough(entry.lastLight, now, POS_EPS_WU, Infinity)) moved = true;
          else if (lightChangedEnough(entry.lastLight, now)) flickered = true;
        } else if (entry.lastLight) {
          moved = true;
        }
      } else if (entry.lastLight) {
        moved = true;
      }
      if (anchor) {
        // 挂上时锚点还没解出来（载荷未到 / 挂点那帧没标注）的，这里补开
        if (entry.vfxPending) this.startVfx(entry);
        this.syncVfx(entry, anchor.world);
      }
    }
    /**
     * 推不推：
     * - 位置动了 / 灯的数量变了（从有到无、从无到有）⇒ 立刻推，不走任何限速；
     * - **只有强度在变（闪烁）⇒ 限速**到 `FLICKER_PUSH_HZ`。
     *
     * 为什么要限速:灯每推一次,`SceneLightingPass` 就重烘一次整张光照缓存(全屏 RGBA16F
     * 一遍)。实测(2026-09-12,雾津街头夜)举着 amp 0.2 / 7 Hz 的火把**站着不动**时
     * 73/80 帧都在重算 —— 位置死区帮不上忙,因为强度每帧都越过 1% 的阈值。
     * 而 7 Hz 的明灭在 20 Hz 采样下人眼已经看不出台阶,于是这一条把稳态重算砍掉约 2/3。
     */
    const due = this.sincePushMs >= this.pushIntervalMs;
    if (moved || lights.length !== this.pushedCount || (flickered && due)) {
      this.pushedCount = lights.length;
      this.sincePushMs = 0;
      this.commitPushed(lights);
      this.deps.setDynamicLights(lights);
    }
  }

  /** 推出去之后才更新死区基准 —— 限速跳过的那些帧必须留着"还欠一次推"的账 */
  private commitPushed(lights: readonly LightDef[]): void {
    const byId = new Map(lights.map((l) => [l.id, l]));
    for (const src of this.followLights) {
      const l = byId.get(src.id);
      if (l && l.pos) this.followLastPos.set(src.id, { pos: [l.pos[0], l.pos[1], l.pos[2]], intensity: l.intensity });
      else this.followLastPos.delete(src.id);
    }
    for (const entry of this.entries.values()) {
      const l = byId.get(`${DYNAMIC_LIGHT_PREFIX}_${entry.target}_${entry.socket}`);
      entry.lastLight = l && l.pos
        ? { pos: [l.pos[0], l.pos[1], l.pos[2]], intensity: l.intensity }
        : null;
      // 均值窗口跟着推送重开——不重开的话窗口越来越长，闪烁会被平均成一条直线
      entry.iSum = 0;
      entry.iCount = 0;
    }
  }

  /** 状态基准强度（过渡期间是插值出来的那一档，不含闪烁） */
  private currentBaseIntensity(entry: HeldEntry): number {
    const p = transitionProgress(entry.fadeElapsedMs, entry.fadeMs);
    return entry.fadeFrom + (entry.fadeTo - entry.fadeFrom) * p;
  }

  /** 这一帧真正要用的强度 = 基准 × 火焰输出（风把波动幅度推高） */
  private liveIntensity(entry: HeldEntry, anchor: Vec3, heightWu: number, light: PropLightDef): number {
    const base = this.currentBaseIntensity(entry);
    if (!(base > 0)) return 0;
    const f = light.flicker;
    if (!f) return base;
    const amp = flickerAmpWithWind(f.amp, this.deps.windSpeedAt(anchor, heightWu), f.windAmp);
    const L = flameOutput(entry.time, amp, f.hz, entry.seed);
    // 同一个 L 也喂给发射率：火苗一窜火星跟着多蹦几颗（一个信号，不两处摇随机）
    for (const id of entry.vfxIds) this.deps.setVfxRate(id, L);
    return base * L;
  }

  private buildLightDef(entry: HeldEntry, light: PropLightDef, anchor: Vec3, intensity: number): LightDef {
    const off = light.offset;
    const pos: [number, number, number] = off
      ? [anchor[0] + off[0], anchor[1] + off[1], anchor[2] + off[2]]
      : [anchor[0], anchor[1], anchor[2]];
    const def: LightDef = {
      id: `${DYNAMIC_LIGHT_PREFIX}_${entry.target}_${entry.socket}`,
      kind: 'point',
      pos,
      intensity,
      enabled: true,
    };
    if (light.color) def.color = light.color;
    else if (light.kelvin !== undefined) def.kelvin = light.kelvin;
    if (light.range !== undefined) def.range = light.range;
    if (light.softeningRadius !== undefined) def.softeningRadius = light.softeningRadius;
    if (light.castShadow) def.castShadow = true;
    return def;
  }

  /**
   * 挂点 → 灯世界坐标（wu）。
   *
   * 走"画面点正下方地面 + 抬高"这条既有路（与摆灯的作者模型、粒子的 `at + h` 同口径）：
   * 挂点的画面 x 决定横向、脚点决定纵深、挂点相对脚点的高度就是抬高量。
   * **铁律 0**：换算一次到底交给组装层注入的 `sceneToLightWorld`（内部走
   * `utils/sceneSpace`，朝向过 R、尺度过 wuPerQUnit），本系统不自己拼矩阵。
   */
  private resolveAnchorWorld(entry: HeldEntry): { world: Vec3; heightWu: number } | null {
    const contact = this.deps.getEntityContact(entry.target);
    if (!contact) return null;
    const socketName = entry.resolved.light?.socket?.trim() || entry.socket;
    const pose = this.deps.getSocketLocalPose(entry.target, socketName);
    if (!pose) return null;
    // pose.y 向上为负：离地高度 = −y
    const heightWu = -pose.y;
    const world = this.deps.sceneToLightWorld(contact.x + pose.x, contact.y, heightWu);
    return world ? { world, heightWu } : null;
  }

  /**
   * 开这一状态的效果。
   *
   * ⚠ **锚点还解不出来时不开**（挂点这一帧没标注 / 照明载荷还没到），改成挂账等 update：
   * 硬拿一个 [0,0,0] 顶上会在世界原点喷一团烟，而世界原点通常在画面外某处 ——
   * 现象是"火把点着的瞬间别处冒了一下"，查起来完全不着边。
   */
  private startVfx(entry: HeldEntry): void {
    if (entry.resolved.vfx.length === 0) { entry.vfxPending = false; return; }
    const anchor = this.resolveAnchorWorld(entry);
    if (!anchor) { entry.vfxPending = true; return; }
    entry.vfxPending = false;
    for (const effect of entry.resolved.vfx) {
      const id = this.deps.playVfx(effect, anchor.world);
      if (id) entry.vfxIds.push(id);
    }
  }

  /**
   * @param soft true = 不再发射、在飞的飞完（切状态用）；false = 当场散（卸下 / 拆除用）。
   * 卸下时**不能**软停：火把离手了，空中还挂着一串没有来源的火星，看起来就是个 bug。
   */
  private stopVfx(entry: HeldEntry, soft = false): void {
    for (const id of entry.vfxIds) {
      if (soft) this.deps.softStopVfx(id);
      else this.deps.stopVfx(id);
    }
    entry.vfxIds = [];
    entry.vfxPending = false;
  }

  private syncVfx(entry: HeldEntry, anchor: Vec3): void {
    if (entry.vfxIds.length === 0) return;
    let lost = false;
    for (const id of entry.vfxIds) if (!this.deps.moveVfx(id, anchor)) lost = true;
    // 实例被切场景散掉了（粒子是表演态）：重开一批，别让火把从此没有火
    if (lost) {
      entry.vfxIds = [];
      this.startVfx(entry);
    }
  }

  // ------------------------------------------------------------------ 存档 / 拆除

  serialize(): object {
    const held = [...this.entries.values()]
      .filter((e) => e.persistent)
      .map((e) => ({ target: e.target, socket: e.socket, prop: e.propId, state: e.state }));
    return held.length > 0 ? { held } : {};
  }

  deserialize(data: object): void {
    // 读档 = 换时间线：在途挂载作废，当前挂的全收走，再按档里的事实重挂
    this.clearAll(true);
    const raw = (data as { held?: unknown }).held;
    if (!Array.isArray(raw)) return;
    for (const it of raw) {
      if (!it || typeof it !== 'object') continue;
      const r = it as Record<string, unknown>;
      const target = typeof r.target === 'string' ? r.target : '';
      const socket = typeof r.socket === 'string' ? r.socket : '';
      const prop = typeof r.prop === 'string' ? r.prop : '';
      const state = typeof r.state === 'string' ? r.state : '';
      if (!target || !socket || !prop) continue;
      void this.attach(target, socket, prop, state || undefined);
    }
  }

  destroy(): void {
    this.clearAll(true);
    this.followLights = [];
    this.scales.clear();
    this.fades.clear();
  }

  /** `bumpGeneration` = 让在途的异步挂载作废（读档 / 拆除 / 切场景都要） */
  private clearAll(bumpGeneration: boolean): void {
    if (bumpGeneration) this.generation++;
    for (const entry of this.entries.values()) {
      this.stopVfx(entry);
      this.deps.detachView(entry.target, entry.socket);
    }
    this.entries.clear();
    this.followLastPos.clear();
    if (this.pushedCount > 0) {
      this.pushedCount = 0;
      this.deps.setDynamicLights([]);
    }
  }
}
