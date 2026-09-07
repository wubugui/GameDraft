import {
  buildImpulseResponse,
  type AcousticListener,
  type AcousticSpaceDef,
  type AcousticTap,
} from './acousticSpace';

/**
 * 空间音总线 —— 场景声学的运行时落地。
 *
 * ## 音频图
 *
 * ```
 *                        ┌─→ dryGain ───────────────┐
 * BufferSource ─→ src ──┤                           ├─→ output(= Howler.masterGain)
 *                        └─→ wetGain → Convolver ───┘
 *                                          ↑
 *                                    场景 IR，切场景时换
 * ```
 *
 * **一个场景一个 Convolver**，所有空间音共用；每个音自己的 dry/wet 比例决定
 * 它「有多在这个空间里」。
 *
 * ## 为什么不去改 Howler 的内部节点
 *
 * 够到 `sound._node` 是碰私有实现，Howler 升一次级就碎。这里走**并行通道**：
 * 空间音用原生 Web Audio 自己播，BGM / 环境 / UI 仍走 Howler，两条汇到同一个
 * `masterGain`，音量总线依然统一。
 *
 * ## 为什么用 ConvolverNode 而不是手搭多抽头延迟
 *
 * 手搭要 30 抽头 × 4 节点 ≈ 120 个节点；`ConvolverNode` 是浏览器原生的分块 FFT
 * 卷积（C++ 实现），一个节点搞定，图简单、`destroy` 也收得干净。
 *
 * ## 环境底噪不进 wet
 *
 * 底噪本身就是这个空间，再加混响是重复。它继续走 Howler。
 */
export interface SpatialPlayOptions {
  /** 湿信号量 0..1 */
  wet?: number;
  /** 干信号量 0..1 */
  dry?: number;
  /** 总音量 0..1 */
  volume?: number;
  onEnd?: () => void;
}

export interface SpatialAudioBusDeps {
  ctx: AudioContext;
  /** 汇入点，通常是 Howler.masterGain */
  destination: AudioNode;
  /** 取音频字节。默认用 fetch。 */
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

export class SpatialAudioBus {
  private ctx: AudioContext;
  private destination: AudioNode;
  private convolver: ConvolverNode;
  private wetBus: GainNode;
  private fetchBytes: (url: string) => Promise<ArrayBuffer>;

  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  private live = new Set<AudioBufferSourceNode>();

  private spaceId: string | null = null;
  private space: AcousticSpaceDef | null = null;
  private lastTaps: AcousticTap[] = [];
  private destroyed = false;

  /** 当前听者（声学米制）。null＝用空间里作者摆的那个。 */
  private listener: AcousticListener | null = null;
  /** 上次重算 IR 时的听者位置，用于判「动得够不够多」 */
  private builtAt: AcousticListener | null = null;
  private lastBuildMs = 0;
  private lastBuildCostMs = 0;

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
  /** 当前生效的移动阈值（米），面板显示用 */
  private moveThresholdM = SpatialAudioBus.REBUILD_MIN_MOVE_M;

  constructor(deps: SpatialAudioBusDeps) {
    this.ctx = deps.ctx;
    this.destination = deps.destination;
    this.fetchBytes = deps.fetchBytes ?? (async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    this.convolver = this.ctx.createConvolver();
    this.convolver.normalize = false;   // 我们自己控增益，交给它归一会把场间差异抹平
    this.wetBus = this.ctx.createGain();
    this.wetBus.gain.value = 1;
    this.convolver.connect(this.wetBus);
    this.wetBus.connect(this.destination);
  }

  /** 当前挂的空间 id；没有挂＝空间音退化为纯干声。 */
  getSpaceId(): string | null { return this.spaceId; }
  /** 诊断用：当前 IR 的抽头表，调试面板与编辑器直接显示。 */
  getTaps(): AcousticTap[] { return this.lastTaps; }

  /**
   * 换场景声学。传 null＝没有空间（干声直出）。
   *
   * IR 由 JS 现算，一条 5 秒立体声约 48 万采样点，毫秒级，不必预存文件 ——
   * 这也是实时联动能成立的前提：改一个数字立刻重算，不用等烘焙。
   */
  setSpace(id: string | null, space: AcousticSpaceDef | null): void {
    if (this.destroyed) return;
    this.spaceId = id;
    this.space = space;
    this.listener = null;      // 换空间＝换坐标系，旧听者位置作废
    this.builtAt = null;
    this.warnedSlow = false;
    if (!space || !space.reflectors?.length) {
      this.convolver.buffer = null;
      this.lastTaps = [];
      return;
    }
    this.rebuild();
  }

  /**
   * 移动听者（**声学米制**坐标）。回音随之改变 —— 不然「实时」没有意义。
   *
   * 带两道节流：挪动不足 {@link REBUILD_MIN_MOVE_M} 米、或距上次重算不足
   * {@link REBUILD_MIN_INTERVAL_MS} 毫秒，都不重算。走两步就重算一次
   * IR 是纯浪费，而且卷积器换 buffer 会让在响的湿信号断一下。
   *
   * 返回是否真的重算了。
   */
  setListener(pos: AcousticListener, force = false): boolean {
    if (this.destroyed || !this.space) return false;
    this.listener = pos;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!force) {
      if (this.builtAt) {
        const moved = Math.hypot(
          pos.x - this.builtAt.x, pos.z - this.builtAt.z,
          (pos.y ?? 0) - (this.builtAt.y ?? 0),
        );
        if (moved < this.moveThresholdM) return false;
      }
      if (now - this.lastBuildMs < SpatialAudioBus.REBUILD_MIN_INTERVAL_MS) return false;
    }
    this.rebuild();
    return true;
  }

  /** 当前听者（声学米制）；没设过就是空间里作者摆的那个。 */
  getListener(): AcousticListener | null {
    return this.listener ?? this.space?.listener ?? null;
  }

  /** 上次重算 IR 花了多少毫秒（性能诊断）。 */
  getLastBuildCostMs(): number { return this.lastBuildCostMs; }

  /** 当前生效的移动阈值（米）——按空间尺度自适应。 */
  getMoveThresholdM(): number { return this.moveThresholdM; }

  private rebuild(): void {
    const space = this.space;
    if (!space || !space.reflectors?.length) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const sr = this.ctx.sampleRate;
    const built = buildImpulseResponse(space, {
      sampleRate: sr,
      listener: this.listener ?? undefined,
      // 立刻 set() 进 AudioBuffer（那本身就是拷贝），所以可以安全地拿暂存视图
      transient: true,
    });
    const buf = this.ctx.createBuffer(2, built.left.length, sr);
    // copyToChannel 要求 Float32Array<ArrayBuffer>；buildImpulseResponse 返回的是
    // Float32Array<ArrayBufferLike>（TS 5.7 起区分 SharedArrayBuffer）。直接写通道避免这层不兼容。
    buf.getChannelData(0).set(built.left);
    buf.getChannelData(1).set(built.right);
    this.convolver.buffer = buf;
    this.lastTaps = built.taps;
    this.builtAt = this.listener ?? space.listener;
    this.lastBuildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.lastBuildCostMs = this.lastBuildMs - t0;
    // 阈值跟着当前几何走：最近那面有多远，就允许挪多远才重算。
    // 再乘一个**代价因子**自平衡：重算越贵的空间要求挪得越多才重算，
    // 免得一个巨大的空间每 300ms 掉两帧。
    const nearest = built.taps.length ? built.taps[0].length / 2 : 0;
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
        + `IR ${(built.left.length / sr).toFixed(1)}s、抽头 ${built.taps.length} 个；`
        + `把最远的反射面拉近、或调短晚期尾可以降下来。`);
    }
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

  /** 播一条空间音。已解码过就立即出声，否则先解码。 */
  async play(url: string, opts: SpatialPlayOptions = {}): Promise<void> {
    if (this.destroyed) return;
    const buf = this.buffers.get(url) ?? await this.preload(url);
    if (!buf || this.destroyed) return;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const vol = this.ctx.createGain();
    vol.gain.value = clamp01(opts.volume ?? 1);
    src.connect(vol);

    const dry = this.ctx.createGain();
    dry.gain.value = clamp01(opts.dry ?? 1);
    vol.connect(dry);
    dry.connect(this.destination);

    // 没有 IR 就别接湿路：接了等于把干声原样再送一份，白白响一倍
    if (this.convolver.buffer) {
      const wet = this.ctx.createGain();
      wet.gain.value = clamp01(opts.wet ?? 0);
      vol.connect(wet);
      wet.connect(this.convolver);
    }

    this.live.add(src);
    src.onended = () => {
      this.live.delete(src);
      try { src.disconnect(); vol.disconnect(); dry.disconnect(); } catch { /* 已断开 */ }
      opts.onEnd?.();
    };
    src.start();
  }

  /** 停掉所有在飞的空间音（切场景/过场接管时用）。 */
  stopAll(): void {
    for (const src of Array.from(this.live)) {
      try { src.stop(); } catch { /* 已停 */ }
    }
    this.live.clear();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAll();
    try {
      this.convolver.buffer = null;
      this.convolver.disconnect();
      this.wetBus.disconnect();
    } catch { /* 已断开 */ }
    this.buffers.clear();
    this.pending.clear();
    this.lastTaps = [];
    this.space = null;
    this.listener = null;
    this.builtAt = null;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
