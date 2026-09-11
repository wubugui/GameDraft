import {
  buildImpulseResponse,
  collectTaps,
  directPath,
  metersPerWu,
  earHeightWu,
  type AcousticListener,
  type AcousticPoint,
  type AcousticSpaceDef,
  type AcousticTap,
  type DirectPath,
} from './acousticSpace';

/**
 * 空间音总线 —— 场景声学的运行时落地。**每一条空间音都是一个有物理位置的声源**。
 *
 * ## 模型（2026-09-08 v3）
 *
 * 听者是 M-world 里的一个耳点（`setListener`），声源是 M-world 里的一个发声点（`playAt`）；
 * 不给发声点 = 声源就在耳朵上（自己喊）。每个声音（voice）由三部分拼成：
 *
 * ```
 *                 ┌─ 直达声：延迟(d/c) → 距离衰减 → 空气低通 → 声像(方位) ─────────┐
 * BufferSource → vol ─┼─ 早期反射：wet → 该声源格子的 early 卷积器（镜像声源法，随声源位置变）─┼→ output(= Howler.masterGain)
 *                 └─ 晚期尾：   wet → 全空间共用的 tail 卷积器（与声源位置无关）──────┘
 * ```
 *
 * - **直达声**按声源→听者的真实几何算（`directPath`）：延迟、参考距离衰减、被崖壁横挡就闷、方位角决定声像。
 *   自己喊时长度 0：不延迟、不衰减、居中——与以前完全一致。
 * - **早期反射**用镜像声源法（`collectTaps` 带 `source`）：对岸主崖对"站在崖边的 NPC 的脚步"和对"我自己的喊声"
 *   给出的是两组不同的延迟与方位。每个 IR 按**声源格子**缓存（格子大小 = 听者的重算阈值，LRU 4 条）：
 *   玩家脚步这种"同一位置连着响"的声源只建一次；听者一动，全部作废重建。
 * - **晚期尾**与声源位置无关，全空间一条，起点仍在（自己喊的）首回之后——那段空白正是山谷感的来源。
 *
 * ## 为什么不给每个声音搭延迟线
 *
 * `DelayNode(maxDelay)` 按最大延迟分配环形缓冲：山谷的二阶抽头在 5 秒外，一个抽头就是 5s×48k×4B ≈ 1MB，
 * 十几个抽头 × 每秒两步脚步 = 几十 MB 的节点在飞。卷积器一条搞定，而且按格子共用。
 *
 * ## 为什么不改 Howler 的内部节点
 *
 * 够到 `sound._node` 是碰私有实现，Howler 升一次级就碎。这里走**并行通道**：空间音用原生 Web Audio 自己播，
 * BGM / 环境 / UI 仍走 Howler，两条汇到同一个 `masterGain`，音量总线依然统一。
 *
 * ## 🔴 这条总线建在哪个 AudioContext 上
 *
 * Howler 在第一个 Howl 创建时若发现 ctx.sampleRate ≠ 44100 会 `unload()` —— **关掉重建** AudioContext。
 * 建在旧 ctx 上的总线从此全哑而不报错（2026-09-08 试听没声的根因）。`context` 暴露出去给 AudioManager 判：
 * 关了 / 换了就重建总线。
 */
export interface SpatialPlayOptions {
  /** 湿信号量 0..1（早期反射 + 晚期尾） */
  wet?: number;
  /** 干信号量 0..1（直达声） */
  dry?: number;
  /** 总音量 0..1 */
  volume?: number;
  /** 只在自然播完时回调一次；手动 stop / 听不见 / 解码失败不触发 */
  onEnd?: () => void;
  /** 真正开始出声那一刻回调一次（解码完、没被 stop、没超出最远距离）。"播放函数返回了"不算播出去 */
  onStart?: () => void;
}

export interface SpatialVoiceHandle {
  stop(): void;
}

export interface SpatialAudioBusDeps {
  ctx: AudioContext;
  /** 汇入点，通常是 Howler.masterGain */
  destination: AudioNode;
  /** 取音频字节。默认用 fetch。 */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

/** 没绑空间时用的空空间：只剩直达声（距离缩放 1，参考距离等按缺省）。 */
const NO_SPACE: AcousticSpaceDef = { listener: { x: 0, z: 0 }, reflectors: [] };

/**
 * 早期反射格子。`users` = 还在往它里面送信号的 voice 数：听者一动格子作废，但**不能立刻拔线**——
 * 在飞的声音正等着它 2 秒后的回音；改成「退役」，最后一个 voice 走完再断开。
 */
interface EarlyCell {
  conv: ConvolverNode | null;
  taps: AcousticTap[];
  usedAt: number;
  users: number;
  retired: boolean;
}

interface TailNodes {
  delay: DelayNode;
  conv: ConvolverNode;
  users: number;
  retired: boolean;
}

interface Voice {
  src: AudioBufferSourceNode;
  nodes: AudioNode[];
  cell: EarlyCell | null;
  tail: TailNodes | null;
}

export class SpatialAudioBus {
  private ctx: AudioContext;
  private destination: AudioNode;
  /** 本总线所有声音的汇合点（→ destination）。电平表挂这里就只量空间音，BGM / 环境 / UI 不混进来 */
  private out: GainNode;
  private fetchBytes: (url: string) => Promise<ArrayBuffer>;

  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  private live = new Set<Voice>();

  private spaceId: string | null = null;
  private space: AcousticSpaceDef | null = null;
  private destroyed = false;

  /**
   * 晚期尾：全空间一条卷积器，IR 只在换空间时建一次（内容与听者 / 声源都无关）；
   * 「延后到首回之后」那段空白由前面串的 DelayNode 给，听者一动只改它的延迟。
   */
  private tail: TailNodes | null = null;
  /** 已退役但还有 voice 在用的格子 / 尾巴：最后一个 voice 走完再断开 */
  private retired: Array<EarlyCell | TailNodes> = [];
  /** 尾巴延迟节点的最大延迟（秒）：山谷首回 2 秒上下，留够 */
  static TAIL_DELAY_MAX_S = 12;
  /** 早期反射：按声源格子缓存 */
  private earlyCells = new Map<string, EarlyCell>();
  static EARLY_CELLS_MAX = 4;

  /** 当前听者（耳点，wu，M-world）。null＝还没喂过：用空间里作者摆的听者 + 耳高。 */
  private listener: AcousticPoint | null = null;
  /** 听者朝向（世界单位向量）；直达声方位以它为正前。缺省 +Z（看进画面）。 */
  private forward: [number, number, number] = [0, 0, 1];
  /** 上次重算时的耳点，用于判「动得够不够多」 */
  private builtAt: AcousticPoint | null = null;
  private lastBuildMs = 0;
  private lastBuildCostMs = 0;
  /** 自己喊的抽头（诊断 / 面板用） */
  private lastTaps: AcousticTap[] = [];

  /**
   * 听者挪动阈值**按空间尺度自适应**：取最近反射面距离的这个比例。
   * 山谷里（对岸 300m）挪 3 米对回音毫无影响，纯属白算一次 IR；
   * 棺龛墙那种 8 米的空间挪 3 米就很要紧。实测重算一次约 10ms，
   * 是一帧的六成 —— 白算的代价是肉眼可见的顿挫。
   */
  static REBUILD_MOVE_RATIO = 0.04;
  /** 阈值下限/上限（米），防止极小/极大空间退化 */
  static REBUILD_MIN_MOVE_M = 2;
  static REBUILD_MAX_MOVE_M = 25;
  /** 两次重算之间至少隔这么久（毫秒） */
  static REBUILD_MIN_INTERVAL_MS = 300;
  /** 单次重算的时间预算；超了打一次警告（只打一次，不刷屏） */
  static BUILD_BUDGET_MS = 25;
  private warnedSlow = false;
  /** 当前生效的移动阈值（米），面板显示用；也是早期反射的声源格子大小 */
  private moveThresholdM = SpatialAudioBus.REBUILD_MIN_MOVE_M;

  constructor(deps: SpatialAudioBusDeps) {
    this.ctx = deps.ctx;
    this.destination = deps.destination;
    this.out = this.ctx.createGain();
    this.out.gain.value = 1;
    this.out.connect(this.destination);
    this.fetchBytes = deps.fetchBytes ?? (async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  }

  /** 这条总线建在哪个 AudioContext 上。它被关掉 / 被 Howler 换掉，总线就是哑的，得重建。 */
  get context(): AudioContext { return this.ctx; }
  /** 空间音的汇合节点：出声证据的电平表挂在这里（只量空间音）。 */
  get output(): AudioNode { return this.out; }
  /** 当前挂的空间 id；没有挂＝只有直达声。 */
  getSpaceId(): string | null { return this.spaceId; }
  /** 当前挂的空间定义（重建总线时要原样挂回去）。 */
  getSpaceDef(): AcousticSpaceDef | null { return this.space; }
  /** 诊断用：自己喊的抽头表，调试面板与工作台直接显示。 */
  getTaps(): AcousticTap[] { return this.lastTaps; }
  /** 当前耳点（wu）；没喂过就是空间里作者摆的听者 + 耳高。 */
  getListener(): AcousticPoint | null {
    if (this.listener) return this.listener;
    const s = this.space;
    if (!s) return null;
    return { x: s.listener.x, y: (s.listener.y ?? 0) + earHeightWu(s), z: s.listener.z };
  }
  /** 上次重算 IR 花了多少毫秒（性能诊断）。 */
  getLastBuildCostMs(): number { return this.lastBuildCostMs; }
  /** 当前生效的移动阈值（米）——按空间尺度自适应。 */
  getMoveThresholdM(): number { return this.moveThresholdM; }

  /**
   * 换场景声学。传 null＝没有空间（只剩直达声）。
   *
   * IR 由 JS 现算，一条 5 秒立体声约 48 万采样点，毫秒级，不必预存文件 ——
   * 这也是实时联动能成立的前提：改一个数字立刻重算，不用等烘焙。
   */
  setSpace(id: string | null, space: AcousticSpaceDef | null): void {
    if (this.destroyed) return;
    // 换空间 = 换场景：上一个场景的声音（脚步尾音）不该干着播进新场景；工作台重推同一个 id 不算换
    if (id !== this.spaceId) this.stopAll();
    this.spaceId = id;
    this.space = space;
    this.builtAt = null;
    this.warnedSlow = false;
    this.dropCells();
    this.dropTail();
    this.lastTaps = [];
    if (!space || !space.reflectors?.length) return;
    this.buildTail(space);
    this.rebuild();
  }

  /** 尾巴的卷积器：换空间时建一次。起点空白由 tailDelay 给（rebuild 里按首回更新）。 */
  private buildTail(space: AcousticSpaceDef): void {
    if (!space.tail || !(space.tail.seconds > 0)) return;
    const sr = this.ctx.sampleRate;
    const built = buildImpulseResponse(space, { sampleRate: sr, part: 'tail', tailAtZero: true, transient: true });
    if (!built.taps.length) return;   // 没有反射面就没有尾
    const conv = this.ctx.createConvolver();
    conv.normalize = false;   // 我们自己控增益，交给它归一会把场间差异抹平
    conv.buffer = toBuffer(this.ctx, built.left, built.right, sr);
    const delay = this.ctx.createDelay(SpatialAudioBus.TAIL_DELAY_MAX_S);
    delay.delayTime.value = Math.min(SpatialAudioBus.TAIL_DELAY_MAX_S, built.taps[0].delay);
    delay.connect(conv);
    conv.connect(this.out);
    this.tail = { delay, conv, users: 0, retired: false };
  }

  /**
   * 移动听者（**耳点，M-world wu**）。回音随之改变 —— 不然「实时」没有意义。
   *
   * 带两道节流：挪动不足阈值（按空间的距离缩放折成米再比）、或距上次重算不足
   * {@link REBUILD_MIN_INTERVAL_MS} 毫秒，都不重算。走两步就重算一次 IR 是纯浪费，
   * 而且卷积器换 buffer 会让在响的湿信号断一下。**直达声不受节流影响**：它逐声音现算。
   *
   * 返回是否真的重算了。
   */
  setListener(ear: AcousticPoint, forward?: [number, number, number] | null, force = false): boolean {
    if (this.destroyed) return false;
    this.listener = ear;
    if (forward) {
      const l = Math.hypot(forward[0], forward[1], forward[2]);
      if (l > 1e-9) this.forward = [forward[0] / l, forward[1] / l, forward[2] / l];
    }
    if (!this.space || !this.space.reflectors?.length) return false;
    const now = nowMs();
    if (!force) {
      if (this.builtAt) {
        const movedM = Math.hypot(ear.x - this.builtAt.x, ear.y - this.builtAt.y, ear.z - this.builtAt.z)
          * metersPerWu(this.space);
        if (movedM < this.moveThresholdM) return false;
      }
      if (now - this.lastBuildMs < SpatialAudioBus.REBUILD_MIN_INTERVAL_MS) return false;
    }
    this.rebuild();
    return true;
  }

  /** 某个发声点的直达声（诊断 / 工作台对表用）。 */
  getDirect(source: AcousticPoint | null): DirectPath {
    return directPath(this.space ?? NO_SPACE, { ear: this.getListener() ?? undefined, source: source ?? undefined, forward: this.forward });
  }

  /** 某个发声点的反射抽头（诊断用；运行时早期反射就是拿这一组建 IR）。 */
  getTapsFor(source: AcousticPoint | null): AcousticTap[] {
    if (!this.space) return [];
    return collectTaps(this.space, { ear: this.getListener() ?? undefined, source: source ?? undefined, forward: this.forward });
  }

  /** 诊断：退役中（还有声音在用）的格子 / 尾巴数 */
  get retiredCount(): number { return this.retired.length; }

  /** 听者动了：作废所有按声源缓存的早期反射、重建晚期尾、刷新自己喊的抽头。 */
  private rebuild(): void {
    const space = this.space;
    if (!space || !space.reflectors?.length) return;
    const t0 = nowMs();
    this.dropCells();
    // 自己喊那一格顺手建好：它就是空间音 sfx（playSfx）与试听的默认格子
    const self = this.ensureCell(null);
    this.lastTaps = self.taps;
    // 尾巴不重建，只把起点挪到（自己喊的）首回之后
    if (this.tail) {
      const first = self.taps.length ? self.taps[0].delay : 0;
      this.tail.delay.delayTime.setValueAtTime(Math.min(SpatialAudioBus.TAIL_DELAY_MAX_S, first), this.ctx.currentTime);
    }
    this.builtAt = this.listener ?? { x: space.listener.x, y: (space.listener.y ?? 0) + earHeightWu(space), z: space.listener.z };
    this.lastBuildMs = nowMs();
    this.lastBuildCostMs = this.lastBuildMs - t0;
    // 阈值跟着当前几何走：最近那面有多远，就允许挪多远才重算。
    // 再乘一个**代价因子**自平衡：重算越贵的空间要求挪得越多才重算，
    // 免得一个巨大的空间每 300ms 掉两帧。
    const nearest = self.taps.length ? self.taps[0].length / 2 : 0;
    const costFactor = Math.min(4, Math.max(1, this.lastBuildCostMs / 8));
    this.moveThresholdM = Math.min(
      SpatialAudioBus.REBUILD_MAX_MOVE_M,
      Math.max(SpatialAudioBus.REBUILD_MIN_MOVE_M,
               nearest * SpatialAudioBus.REBUILD_MOVE_RATIO * costFactor),
    );
    if (this.lastBuildCostMs > SpatialAudioBus.BUILD_BUDGET_MS && !this.warnedSlow) {
      this.warnedSlow = true;
      console.warn(
        `[SpatialAudioBus] 声学空间「${this.spaceId}」重算 IR 用了 `
        + `${this.lastBuildCostMs.toFixed(0)}ms（预算 ${SpatialAudioBus.BUILD_BUDGET_MS}ms）。`
        + `抽头 ${self.taps.length} 个；把最远的反射面拉近、或调短晚期尾可以降下来。`);
    }
  }

  /** 声源格子：早期反射按声源位置量化到「听者重算阈值」那么大的格子里缓存。 */
  private cellKey(source: AcousticPoint | null): string {
    if (!source) return 'self';
    const space = this.space ?? NO_SPACE;
    const cellWu = Math.max(30, this.moveThresholdM / metersPerWu(space));
    return `${Math.round(source.x / cellWu)},${Math.round(source.y / cellWu)},${Math.round(source.z / cellWu)}`;
  }

  private ensureCell(source: AcousticPoint | null): EarlyCell {
    const key = this.cellKey(source);
    const hit = this.earlyCells.get(key);
    if (hit) { hit.usedAt = nowMs(); return hit; }
    const space = this.space;
    let cell: EarlyCell = { conv: null, taps: [], usedAt: nowMs(), users: 0, retired: false };
    if (space && space.reflectors?.length) {
      const sr = this.ctx.sampleRate;
      const ear = this.getListener() ?? undefined;
      const built = buildImpulseResponse(space, {
        sampleRate: sr, ear, source: source ?? undefined, forward: this.forward, part: 'early', transient: true,
      });
      let conv: ConvolverNode | null = null;
      if (built.taps.length) {
        conv = this.ctx.createConvolver();
        conv.normalize = false;
        conv.buffer = toBuffer(this.ctx, built.left, built.right, sr);
        conv.connect(this.out);
      }
      cell = { conv, taps: built.taps, usedAt: nowMs(), users: 0, retired: false };
    }
    // LRU：格子只留最近几条，别随玩家走动无限涨（被挤掉的若还有声音在用，退役等它们走完）
    if (this.earlyCells.size >= SpatialAudioBus.EARLY_CELLS_MAX) {
      let oldestKey = '';
      let oldest = Infinity;
      for (const [k, c] of this.earlyCells) if (c.usedAt < oldest) { oldest = c.usedAt; oldestKey = k; }
      const victim = this.earlyCells.get(oldestKey);
      if (victim) this.retire(victim);
      this.earlyCells.delete(oldestKey);
    }
    this.earlyCells.set(key, cell);
    return cell;
  }

  /** 格子 / 尾巴不再给新声音用；还有 voice 在送信号就留着，最后一个走完再拔线（否则在飞的回音被硬切）。 */
  private retire(n: EarlyCell | TailNodes): void {
    n.retired = true;
    if (n.users > 0) { this.retired.push(n); return; }
    this.hardDisconnect(n);
  }

  private hardDisconnect(n: EarlyCell | TailNodes): void {
    try { n.conv?.disconnect(); } catch { /* 已断开 */ }
    if ('delay' in n) { try { n.delay.disconnect(); } catch { /* 已断开 */ } }
    if (n.conv) n.conv.buffer = null;
  }

  /** voice 用完一个格子 / 尾巴：退役且没人用了就真断开 */
  private release(n: EarlyCell | TailNodes | null): void {
    if (!n) return;
    n.users = Math.max(0, n.users - 1);
    if (n.retired && n.users === 0) {
      this.hardDisconnect(n);
      const i = this.retired.indexOf(n);
      if (i >= 0) this.retired.splice(i, 1);
    }
  }

  private dropCells(): void {
    for (const c of this.earlyCells.values()) this.retire(c);
    this.earlyCells.clear();
  }

  private dropTail(): void {
    if (this.tail) { this.retire(this.tail); this.tail = null; }
  }

  /** 预取并解码一条音频；重复调用共享同一个 in-flight promise。 */
  async preload(url: string): Promise<AudioBuffer | null> {
    if (this.destroyed) return null;
    const hit = this.buffers.get(url);
    if (hit) return hit;
    const inFlight = this.pending.get(url);
    if (inFlight) return inFlight;
    const task = (async () => {
      try {
        const bytes = await this.fetchBytes(url);
        const buf = await this.ctx.decodeAudioData(bytes.slice(0));
        if (!this.destroyed) this.buffers.set(url, buf);
        return buf;
      } catch (err) {
        console.warn('[SpatialAudioBus] 解码失败', url, err);
        return null;
      } finally {
        this.pending.delete(url);
      }
    })();
    this.pending.set(url, task);
    return task;
  }

  /** 播一条空间音，声源就在耳朵上（自己喊）。 */
  play(url: string, opts: SpatialPlayOptions = {}): SpatialVoiceHandle {
    return this.playAt(url, null, opts);
  }

  /**
   * 从 M-world 里的一个发声点播一条空间音。`source = null` = 自己喊。
   * 句柄立刻返回；解码期间 stop() 会取消播放。超出 `direct.maxDistanceM` 的声源不播（onEnd 不触发）。
   */
  playAt(url: string, source: AcousticPoint | null, opts: SpatialPlayOptions = {}): SpatialVoiceHandle {
    let stopped = false;
    let voice: Voice | null = null;
    const handle: SpatialVoiceHandle = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (voice) this.killVoice(voice);
        voice = null;
      },
    };
    if (this.destroyed) return handle;
    void (async () => {
      const buf = this.buffers.get(url) ?? await this.preload(url);
      if (!buf || this.destroyed || stopped) return;
      voice = this.startVoice(buf, source, opts);
    })();
    return handle;
  }

  private startVoice(buf: AudioBuffer, source: AcousticPoint | null, opts: SpatialPlayOptions): Voice | null {
    const ctx = this.ctx;
    const space = this.space ?? NO_SPACE;
    const direct = directPath(space, { ear: this.getListener() ?? undefined, source: source ?? undefined, forward: this.forward });

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const vol = ctx.createGain();
    vol.gain.value = clamp01(opts.volume ?? 1);
    src.connect(vol);
    const nodes: AudioNode[] = [src, vol];
    let anyPath = false;

    // 直达声：延迟 → 距离衰减（含遮挡）→ 空气低通 → 声像。超出最远距离只是直达声不播，反射照走
    // （对岸崖顶那个声源本来就只该听到回音）
    if (!direct.inaudible) {
      anyPath = true;
      let tail: AudioNode = vol;
      if (direct.delay > 0.001) {
        const d = ctx.createDelay(Math.max(0.05, direct.delay + 0.05));
        d.delayTime.value = direct.delay;
        tail.connect(d); tail = d; nodes.push(d);
      }
      const dry = ctx.createGain();
      dry.gain.value = clamp01(opts.dry ?? 1) * direct.gain * (1 - direct.occluded);
      tail.connect(dry); tail = dry; nodes.push(dry);
      if (direct.cutoffHz < 19000) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.max(200, direct.cutoffHz);
        tail.connect(lp); tail = lp; nodes.push(lp);
      }
      if (Math.abs(direct.pan) > 1e-3 && typeof ctx.createStereoPanner === 'function') {
        const pan = ctx.createStereoPanner();
        pan.pan.value = direct.pan;
        tail.connect(pan); tail = pan; nodes.push(pan);
      }
      tail.connect(this.out);
    }

    // 湿路：早期反射（按声源格子）+ 晚期尾（共用）。没有 IR 就别接——接了等于把干声原样再送一份
    let cell: EarlyCell | null = null;
    let tailNodes: TailNodes | null = null;
    const wetAmt = clamp01(opts.wet ?? 0);
    if (wetAmt > 0 && this.space && this.space.reflectors?.length) {
      const c = this.ensureCell(source);
      if (c.conv || this.tail) {
        const wet = ctx.createGain();
        wet.gain.value = wetAmt;
        vol.connect(wet);
        if (c.conv) { wet.connect(c.conv); cell = c; c.users += 1; }
        if (this.tail) { wet.connect(this.tail.delay); tailNodes = this.tail; this.tail.users += 1; }
        nodes.push(wet);
        anyPath = true;
      }
    }
    if (!anyPath) {
      for (const n of nodes) { try { n.disconnect(); } catch { /* 已断开 */ } }
      return null;
    }

    const voice: Voice = { src, nodes, cell, tail: tailNodes };
    this.live.add(voice);
    src.onended = () => {
      if (!this.live.has(voice)) return;   // 手动停的不算自然播完
      this.live.delete(voice);
      this.disconnectVoice(voice);
      opts.onEnd?.();
    };
    src.start();
    opts.onStart?.();
    return voice;
  }

  private killVoice(v: Voice): void {
    if (!this.live.has(v)) return;
    this.live.delete(v);
    try { v.src.stop(); } catch { /* 已停 */ }
    this.disconnectVoice(v);
  }

  private disconnectVoice(v: Voice): void {
    for (const n of v.nodes) { try { n.disconnect(); } catch { /* 已断开 */ } }
    this.release(v.cell); v.cell = null;
    this.release(v.tail); v.tail = null;
  }

  /** 停掉所有在飞的空间音（切场景/过场接管时用）。 */
  stopAll(): void {
    for (const v of Array.from(this.live)) this.killVoice(v);
    this.live.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAll();
    this.dropCells();
    this.dropTail();
    for (const n of this.retired) this.hardDisconnect(n);
    this.retired = [];
    try { this.out.disconnect(); } catch { /* 已断开 */ }
    this.buffers.clear();
    this.pending.clear();
    this.lastTaps = [];
    this.space = null;
    this.listener = null;
    this.builtAt = null;
  }
}

function toBuffer(ctx: AudioContext, left: Float32Array, right: Float32Array, sr: number): AudioBuffer {
  const buf = ctx.createBuffer(2, Math.max(1, left.length), sr);
  // copyToChannel 要求 Float32Array<ArrayBuffer>；buildImpulseResponse 返回的是
  // Float32Array<ArrayBufferLike>（TS 5.7 起区分 SharedArrayBuffer）。直接写通道避免这层不兼容。
  buf.getChannelData(0).set(left);
  buf.getChannelData(1).set(right);
  return buf;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export type { AcousticListener };
