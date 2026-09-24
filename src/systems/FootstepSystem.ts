import type {
  AudioCueRef,
  AudioPlaybackHandle,
  FootstepConfig,
  GameContext,
  IGameSystem,
} from '../data/types';
import { audioCueId, audioCueVolume } from '../data/audioCue';
import { resolveWorld, type AudioSpaceResolver } from '../utils/audioSpace';
import type { Vec3 } from '../utils/sceneSpace';

/**
 * 脚步声：由**动画落脚帧**驱动、经**空间化**播出的一次性音效。
 *
 * ## 数据分三处，各管各的
 *
 * - **哪一帧落脚**：动画包的 `sockets.json.contactSlots`（图集槽位），在动画浏览页
 *   看着图逐帧标，与挂点同一套机制。本系统只问发声体「这一帧是不是落脚帧」，不猜。
 * - **哪块地是什么声**：场景 / zone 选一个**脚步集** id（`SceneData.footstepSet` /
 *   `ZoneDef.footstepSet`）。
 * - **脚步集里有什么**：`footstep_sets.json`——每个片段名一条音效 key + 增益，key 与其它
 *   音效一样在 `audio_config.json` 的 sfx 区登记。**没有随机轮换、没有抖动**：地面换了
 *   声音就换，靠 zone 切集，不靠掷骰子。
 *
 * ## 三条设计约束（都是被证据逼出来的，不是偏好）
 *
 * 1. **玩家不是特例。** 发声体是一个 {@link FootstepEmitter} 鸭子协议，玩家与 NPC
 *    注册进来走同一条路径。系统内部一处 `if (isPlayer)` 都没有。
 *    **没有身体的脚步**（跟脚声/幻听，见 `FollowerFootstepSystem`）没有动画可绑，
 *    走 {@link FootstepSystem.playExternalStep} 进来——**出声那一半仍是这一条**
 *    （脚步集、音效 key、两级增益、空间化、句柄回收），只是不参与帧驱动的落脚判定。
 * 2. **帧驱动，不按时间间隔。** 实测两套装扮步频差一倍且互不相同：常态 `walk`
 *    16 帧 @8fps + `referenceSpeed=50`，默认 walkSpeed=100 把倍率顶到
 *    `LOCOMOTION_RATE_MAX=2` ⇒ 循环 1.000 s；背尸 `carry_walk` 12 帧 @6fps、
 *    **无 referenceSpeed** ⇒ 恒 1 倍速 ⇒ 循环 2.000 s，且完全不跟速度走。
 *    任何固定时间间隔的调度都必然与至少一套装扮脱节。
 * 3. **播放必须回到音频管理器。** 不在实体里 `new Howl`、也不各自 `playSfx`——
 *    后者的音量是 **Howl 组级**（`AudioManager.playSfx` 不传 soundId，同 id 共用缓存 Howl），
 *    第 N 步设的音量会**追溯性地改掉还在响的第 N−1 步**。逐步衰减必须走
 *    `playTransientSfx`（那条才是 per-soundId）。
 *
 * ## 落脚与出声是两件事
 *
 * 落脚判定（帧 / 可见 / 防抖 / 移动片段）先做，通过就发 `onContact`（带原始场景脚点）；
 * **之后**才是声音这一半（音频解锁、`setEnabled`、脚步集、音效 key、空间化）。
 * 群体刺激之类的视觉反应接在 `onContact` 上，所以音频没解锁 / 这块地没配脚步集时照样会被惊动，
 * 也不会借到音频那份做过透视重整的坐标。
 *
 * ## 生命周期
 *
 * 谁播的谁停：本系统播出的每个句柄自己记着，`destroy` / 场景卸载 / 读档三处收掉。
 */

/** 一个能发出脚步声的东西。与实体类解耦，由组装层适配（同 `ShadowSource` 的做法）。 */
export interface FootstepEmitter {
  /** 稳定标识（玩家用 `'player'`，NPC 用其 id）。用于跨帧跟踪帧号。 */
  readonly id: string;
  /** 脚点场景坐标 wu。⚠ 必须接 `contactX`/`contactY`，**不是** `x`/`y`。 */
  getContactX(): number;
  getContactY(): number;
  /** 当前动画片段名（`SpriteEntity.getCurrentState()`）。 */
  getClip(): string;
  /** 当前帧下标。 */
  getFrameIndex(): number;
  /** 当前片段帧数。 */
  getFrameCount(): number;
  /**
   * 当前片段的第 `frameIndex` 帧是不是落脚帧。
   * 由实体按「这一帧画的是图集哪一格 ∈ sockets.json.contactSlots」回答
   * （`SpriteEntity.isContactFrameAt`）。没标过 ⇒ 永远 false ⇒ 无声。
   */
  isContactFrame(frameIndex: number): boolean;
  /** 不可见时不发声（被剔除/在别的位面/未出场）。 */
  isVisible(): boolean;
}

/**
 * 一次落脚：动画真的推进到落脚帧上的那一刻，与这一步**出不出声无关**。
 * 坐标是原始场景脚点——**不是**音频的 M-world（那份在配了透视线的场景里做过纵深重整，是音频专用的）。
 */
export interface FootstepContact {
  emitterId: string;
  clip: string;
  frame: number;
  /** 脚点场景坐标 wu（发声体的 contactX / contactY 原值） */
  contactX: number;
  contactY: number;
}

export interface FootstepSpatialContext {
  /** 场景坐标 + 高度 → M-world 的解算器（field / planar） */
  resolver: AudioSpaceResolver;
}

export interface FootstepSystemDeps {
  /**
   * 从 M-world 里的一个发声点播一条一次性音效（`AudioManager.playSfxAt`）。
   * 脚步是**有物理位置的声源**：距离衰减、声像、崖壁回音全由空间音总线按听者与脚点的几何算，
   * 本系统只负责"哪一帧、哪块地、哪条音效、多响"。
   */
  playAt(
    id: string,
    world: Vec3,
    options: { volume?: number; onEnd?: () => void; spatialized?: boolean },
  ): AudioPlaybackHandle | null;
  /**
   * 本帧的解算器；返回 null = 本帧不发声（场景没就绪/音频没解锁）。
   * ⚠ 只管声音：落脚判定与 {@link onContact} 照常进行，不受它影响。
   */
  getSpatialContext(): FootstepSpatialContext | null;
  /**
   * 落脚事件（群体刺激等视觉反应从这里接）。每个通过可见 / 防抖 / 移动片段三道判定的落脚都发，
   * **不看**音频解锁、`setEnabled`、脚点处有没有脚步集——地虫被惊散不该取决于这一步能不能响。
   */
  onContact?(contact: FootstepContact): void;
  /** 脚点处该用哪个脚步集：zone 覆盖 → 场景默认 → null（本处不发脚步）。 */
  resolveSetAt(sceneX: number, sceneY: number): string | null;
  getConfig(): FootstepConfig | null;
}

interface EmitterState {
  clip: string;
  frameIndex: number;
  /**
   * 上一次发声之后，动画**推进了多少帧**。
   *
   * 🔴 这是防抖闸，而且**必须按帧计、不许按时间计**。
   * 播放速率本身就是可调的（`applyLocomotionSpeed` 最高 2×、过场还能另设 `playbackSpeed`），
   * 拿墙钟当闸的话，速率一提上去合法的脚步就会被误挡掉——
   * 而这正是「声音绑帧不绑时间」这条原则的意义所在。
   *
   * 它挡住的是这个真实退化情形：玩家在碰撞边缘抖动 ⇒ 片段每帧 walk↔idle 来回切 ⇒
   * 每次切回 walk 都从第 0 帧重起 ⇒ 每帧一响。按帧计的闸天然挡住它
   * （walk 的动画根本没推进过），且对任何播放速率都成立。
   */
  framesSinceStep: number;
}

/** 初值要足够大，保证「第一步」永远放行。 */
const FRAMES_SINCE_STEP_INIT = Number.MAX_SAFE_INTEGER;

/** 最近发过的脚步，供无头验证断言「响的是不是该响的那条」。 */
export interface FootstepDebugRecord {
  atMs: number;
  emitterId: string;
  setId: string;
  clip: string;
  frame: number;
  audioId: string;
  /** 配置增益（集 + 缺省，dB 折线性）；距离衰减 / 声像在空间音总线里，不在这 */
  gain: number;
  /** 脚点，M-world wu */
  world: Vec3;
  mode: 'field' | 'planar';
  /**
   * 这一步走没走空间化。`false` = `defaults.spatialized` 关着，声音绕开了空间总线,
   * `world` / `mode` 这一行仍照常记（脚点还是算出来了），但**它们没参与发声**——
   * 不记这一条就会出现"调试状态里坐标好好的、听感却完全没有空间感"而查不出原因。
   */
  spatialized: boolean;
}

export interface FootstepContactDebugRecord extends FootstepContact {
  atMs: number;
}

const DEBUG_RING = 16;

export class FootstepSystem implements IGameSystem {
  private readonly deps: FootstepSystemDeps;
  private readonly emitters = new Map<string, FootstepEmitter>();
  private readonly states = new Map<string, EmitterState>();
  /** 在播的句柄：谁播的谁停。 */
  private readonly live = new Set<AudioPlaybackHandle>();
  private readonly recent: FootstepDebugRecord[] = [];
  /** 最近的落脚（不论出没出声）；与 `recent` 对照就能分清「没落脚」和「落了脚但没响」 */
  private readonly recentContacts: FootstepContactDebugRecord[] = [];
  /**
   * 累计时间，**只用来给调试记录打时间戳**（`FootstepDebugRecord.atMs`）。
   *
   * 🔴 绝不许拿它参与任何「响不响」的判断。触发是纯帧驱动的：播放速率
   * （`frameRate` × `playbackSpeed` × `referenceSpeed` 换算出的倍率）本身就是可调量，
   * 任何时间阈值都会随速率漂移，快放时误挡、慢放时误放。
   */
  private nowMs = 0;
  private enabled = true;
  /** 已经警告过的「集/片段查不到」，避免每帧刷屏。 */
  private readonly warned = new Set<string>();

  constructor(deps: FootstepSystemDeps) {
    this.deps = deps;
  }

  init(_ctx: GameContext): void {}

  registerEmitter(e: FootstepEmitter): void {
    this.emitters.set(e.id, e);
  }

  unregisterEmitter(id: string): void {
    this.emitters.delete(id);
    this.states.delete(id);
  }

  /** 场景卸载：发声体全撤，在播的尾音全停（画面已经换了，尾音留着就是泄漏）。 */
  clearEmitters(): void {
    this.emitters.clear();
    this.states.clear();
    this.stopAllLive();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.stopAllLive();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  update(dt: number): void {
    this.nowMs += Math.max(0, dt) * 1000;
    if (this.emitters.size === 0) return;
    // 配置缺失 = 没有任何片段登记为移动片段，落脚也就无从判起
    const cfg = this.deps.getConfig();
    if (!cfg) return;
    // ctx 只管出不出声：噤声 / 音频没解锁时照样逐帧跟踪、照样发落脚事件
    const ctx = this.enabled ? this.deps.getSpatialContext() : null;

    for (const emitter of this.emitters.values()) {
      this.updateEmitter(emitter, cfg, ctx);
    }
  }

  private updateEmitter(
    emitter: FootstepEmitter,
    cfg: FootstepConfig,
    ctx: FootstepSpatialContext | null,
  ): void {
    const clip = emitter.getClip();
    const frame = emitter.getFrameIndex();
    const count = emitter.getFrameCount();
    const prev = this.states.get(emitter.id);

    if (!prev || prev.clip !== clip) {
      // 换片段：以当前帧为新起点。**当前帧若是落脚帧就发一声**——
      // 这正是「站住 → 起步」的第一步，漏掉它会让每次起步都缺第一响。
      // ⚠ `framesSinceStep` 跨片段**继承**，不重置：否则 walk↔idle 抖动时每次切回来
      //   都算「新片段的第一步」，防抖闸就白设了。
      this.states.set(emitter.id, {
        clip,
        frameIndex: frame,
        framesSinceStep: prev?.framesSinceStep ?? FRAMES_SINCE_STEP_INIT,
      });
      if (isContactFrame(emitter, frame, count)) this.tryEmit(emitter, cfg, ctx, clip, frame);
      return;
    }

    if (prev.frameIndex === frame) return;

    // 逐帧走过 prev.frameIndex → frame 之间**经过**的每一帧，判断有没有跨过落脚帧。
    // 直接比较「当前帧是不是落脚帧」会漏：一帧里可能推进多帧
    // （`SpriteEntity.update` 是 `while (frameTimer >= frameDuration)` 循环，
    //  低帧率、卡顿或高 playbackSpeed 下会一次推进好几帧）。
    const passed = framesBetween(prev.frameIndex, frame, count);
    prev.frameIndex = frame;
    // 先记推进量再判落脚：本次跨过的帧本身就是「动画确实在走」的证据
    prev.framesSinceStep = prev.framesSinceStep === FRAMES_SINCE_STEP_INIT
      ? FRAMES_SINCE_STEP_INIT
      : prev.framesSinceStep + passed.length;
    for (const f of passed) {
      if (isContactFrame(emitter, f, count)) {
        this.tryEmit(emitter, cfg, ctx, clip, f);
        break; // 一帧内最多一响：连响两声只会像机枪，不像跑步
      }
    }
  }

  private tryEmit(
    emitter: FootstepEmitter,
    cfg: FootstepConfig,
    ctx: FootstepSpatialContext | null,
    clip: string,
    frame: number,
  ): void {
    if (!emitter.isVisible()) return;
    const st = this.states.get(emitter.id);
    if (!st) return;

    // 防抖闸：上一次落脚之后动画必须**至少推进过一帧**。按帧计，与播放速率无关。
    if (st.framesSinceStep <= 0) return;
    // 只有显式登记过的片段才算走路：站着的 idle 复用了走路的某一格也不是落脚（见 resolveSfx 的注释）
    if (!isLocomotionClip(cfg, clip)) return;

    const x = emitter.getContactX();
    const y = emitter.getContactY();
    st.framesSinceStep = 0;
    this.pushContact({ atMs: this.nowMs, emitterId: emitter.id, clip, frame, contactX: x, contactY: y });
    this.deps.onContact?.({ emitterId: emitter.id, clip, frame, contactX: x, contactY: y });

    if (ctx) this.emitSound(emitter.id, cfg, ctx, clip, frame, x, y);
  }

  /**
   * 外部驱动的一步：**没有身体的脚步**（跟脚声/幻听）从这里进来，复用脚步集解析、
   * 空间化、增益两级与句柄管理——另起一条播放路径就会出现「跟脚声不吃 zone 换地、
   * 关了空间化它还在总线上」这类只有听感能发现的分裂。
   *
   * 与 {@link registerEmitter} 的分工：发声体是**有动画**的东西（玩家/NPC），由帧驱动；
   * 这条是调用方自己决定「此刻响一步」，帧号只用于查音效与记调试。
   *
   * @returns 真的播出了声音（音频没解锁 / 没配脚步集 / 被 `setEnabled(false)` 关着都返回 false）
   */
  playExternalStep(args: {
    emitterId: string;
    clip: string;
    /** 脚点场景坐标 wu（与发声体的 contactX/contactY 同口径） */
    sceneX: number;
    sceneY: number;
    /** 指定脚步集；不给 = 按脚点那块地解（zone 覆盖场景） */
    setId?: string;
    /** 叠在「集 + 缺省」之上的相对增益（dB） */
    gainDb?: number;
  }): boolean {
    if (!this.enabled) return false;
    const cfg = this.deps.getConfig();
    if (!cfg) return false;
    const ctx = this.deps.getSpatialContext();
    if (!ctx) return false;
    return this.emitSound(
      args.emitterId, cfg, ctx, args.clip, -1, args.sceneX, args.sceneY,
      { setId: args.setId, gainDb: args.gainDb },
    );
  }

  /**
   * 这一步的声音：脚步集 → 片段音效 → 空间化播放。任何一环缺了就这一步无声（落脚事件已经发过了）。
   * @returns 是否真的播出了声音
   */
  private emitSound(
    emitterId: string,
    cfg: FootstepConfig,
    ctx: FootstepSpatialContext,
    clip: string,
    frame: number,
    x: number,
    y: number,
    override?: { setId?: string; gainDb?: number },
  ): boolean {
    // 指定集优先于按地解：跟脚声可以「踩在石板上也响纸钱」（幻听不吃这块地的材质）
    const setId = override?.setId || this.deps.resolveSetAt(x, y);
    if (!setId) return false;
    const set = cfg.sets?.[setId];
    if (!set) {
      this.warnOnce(`footstep: 脚步集 "${setId}" 不在 footstep_sets.json 里`);
      return false;
    }

    const cue = resolveSfx(set.sfx, cfg.clipFallback, clip);
    const audioId = audioCueId(cue);
    if (!audioId) {
      // 走到这里的片段都登记过（= 被认定为移动片段，tryEmit 已判），查不到音效就是配置错误。
      // 没登记的片段在 tryEmit 就静默返回了——对它们 warn 只会把控制台刷满。
      this.warnOnce(`footstep: 脚步集 "${setId}" 没有片段 "${clip}" 的音效（回落链也没命中）`);
      return false;
    }

    // 脚点 → 音频 M-world：脚步恒在行走面上 ⇒ 高度 0。距离 / 声像 / 回音全交给空间音总线按这个点算。
    // ⚠ 这份坐标做过透视纵深重整，只给声音用；落脚事件带的是原始场景脚点。
    const world = resolveWorld(ctx.resolver, { contactX: x, contactY: y, heightWu: 0 });

    // 两级：dB 管“这块地整体多响”，本条 volume 管“这个片段相对本集多响”（相乘，不是替换）。
    // ≠ playSfx 的“替换素材级”口径：脚步根本不读素材级 volume，它的基准就是 gainDb。
    // 第三级是**调用方**的相对增益（跟脚声通常比自己的脚步轻）：与前两级同为 dB 相加，
    // 不是另起一个线性乘子——三级混着两种口径时「-6 dB」和「0.5」会被写串。
    const gainDb = firstNum(set.gainDb, 0, 0) + firstNum(cfg.defaults?.gainDb, 0, 0)
      + firstNum(override?.gainDb, 0, 0);
    const volume = dbToLin(gainDb) * (audioCueVolume(cue) ?? 1);
    // 缺省走空间化；只有显式写 false 才退成"就播一个声音"（作者面的对照开关）。
    // 用 !== false 而不是 === true：这个键在绝大多数文件里根本不存在。
    const spatialized = cfg.defaults?.spatialized !== false;

    // 句柄要在 onEnd 闭包里被摘掉，而句柄本身是这次调用的返回值——先声明一个可变槽，
    // 别在闭包里引用尚未初始化的 const（那是 TDZ，只在 onEnd 被同步调用时才炸，最难查的那种）。
    let handle: AudioPlaybackHandle | null = null;
    handle = this.deps.playAt(audioId, world, {
      volume,
      spatialized,
      onEnd: () => { if (handle) this.live.delete(handle); },
    });
    if (handle) this.live.add(handle);

    this.pushDebug({
      atMs: this.nowMs,
      emitterId,
      setId,
      clip,
      frame,
      audioId,
      gain: volume,
      world,
      mode: ctx.resolver.mode,
      spatialized,
    });
    return true;
  }

  private warnOnce(msg: string): void {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(msg);
  }

  private pushDebug(r: FootstepDebugRecord): void {
    this.recent.push(r);
    if (this.recent.length > DEBUG_RING) this.recent.shift();
  }

  private pushContact(r: FootstepContactDebugRecord): void {
    this.recentContacts.push(r);
    if (this.recentContacts.length > DEBUG_RING) this.recentContacts.shift();
  }

  private stopAllLive(): void {
    for (const h of this.live) {
      try { h.stop(); } catch { /* 已结束/已卸载安全忽略 */ }
    }
    this.live.clear();
  }

  /**
   * 无头验证用：最近若干次脚步（时刻 / 发声体 / 脚步集 / 片段 / 帧 / 音效 / 增益 / 声像 / 距离 / 精度级别）。
   * 脚步靠听没法做回归——「走过木栈道那段响的是不是栈道音」「是不是只在落脚帧上响」
   * 「镜头拉远是不是变轻了」全靠这份记录断言。
   */
  getDebugOutputState(): Record<string, unknown> {
    // 每个发声体**此刻**的片段/帧：判「响没响在落脚帧上」第一步是先看它到底在播哪个片段第几帧。
    // 只读一次 getter，不缓存、不参与判定。
    const live = Array.from(this.emitters.values())
      .map((e) => ({
        id: e.id,
        clip: e.getClip(),
        frame: e.getFrameIndex(),
        frameCount: e.getFrameCount(),
        contact: e.isContactFrame(e.getFrameIndex()),
        visible: e.isVisible(),
        framesSinceStep: this.states.get(e.id)?.framesSinceStep ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return {
      enabled: this.enabled,
      emitters: live.map((e) => e.id),
      emitterState: live,
      liveHandles: this.live.size,
      recent: this.recent.slice(),
      recentContacts: this.recentContacts.slice(),
    };
  }

  /** 脚步不入存档：它是位置与动画的瞬时函数，读档后由实体状态自然重建。 */
  serialize(): object {
    return {};
  }

  deserialize(_data: object): void {
    // 读档 = 换时间线：在途尾音一律作废，别让上一条时间线的脚步响在新场景里
    this.stopAllLive();
    this.states.clear();
  }

  destroy(): void {
    this.stopAllLive();
    this.emitters.clear();
    this.states.clear();
    this.recent.length = 0;
    this.recentContacts.length = 0;
    this.warned.clear();
  }
}

// ===========================================================================
// 纯函数（可单测，不碰任何运行时状态）
// ===========================================================================

/**
 * 这一帧是不是落脚帧。单帧（或空）片段的 `SpriteEntity.update` 直接早退、帧号永不推进，
 * 不可能有脚步；其余交给发声体按 `contactSlots` 回答。
 */
function isContactFrame(emitter: FootstepEmitter, frame: number, count: number): boolean {
  if (count <= 1) return false;
  return emitter.isContactFrame(frame);
}

/**
 * 从 `from` 走到 `to` **经过**的帧号序列（不含 `from`，含 `to`）。
 *
 * 三种情形都要吃住，且都真实存在：
 * - 正向推进：`from+1 … to`
 * - 循环回绕（`to <= from` 且正向）：`from+1 … n-1`，再 `0 … to`
 * - 反向播放（`playbackReverse`）：`from-1 … to` 递减；回绕同理
 *
 * 为什么不能只看「当前帧是不是落脚帧」：一帧里可能推进多帧
 * （`SpriteEntity.update` 是 `while (frameTimer >= frameDuration)` 循环），
 * 低帧率或高倍速下会直接跨过落脚帧——那一步就无声了，而且只在卡顿时偶发，极难查。
 */
export function framesBetween(from: number, to: number, count: number): number[] {
  if (count <= 1) return [];
  const n = count;
  const a = ((from % n) + n) % n;
  const b = ((to % n) + n) % n;
  if (a === b) return [];
  const out: number[] = [];
  // 正向与反向的最短路径：取步数少的那个方向，避免把「反向退一帧」误判成「正向绕一圈」
  const fwd = (b - a + n) % n;
  const bwd = (a - b + n) % n;
  if (fwd <= bwd) {
    for (let i = 1; i <= fwd; i++) out.push((a + i) % n);
  } else {
    for (let i = 1; i <= bwd; i++) out.push(((a - i) % n + n) % n);
  }
  return out;
}

/**
 * 按片段名取音效 key，回落**完全声明式**：`<clip>` → `clipFallback[clip]` → …（可链式，防环）。
 * 链走到头还没命中就返回 null。
 *
 * ## 🔴 绝不能有「最后兜底到 walk」这种隐式回落
 *
 * 我第一版写了那条兜底，36 条单测全绿，**真机一跑就露馅**：站着不动时片段是 `idle`，
 * 它查不到音效 → 兜底成 `walk` → 于是**原地不动每秒响一声脚步**。
 * 单测没抓到是因为测试配置里从来没出现过 `idle`。
 *
 * 根子上的问题是：隐式兜底把「这个片段是不是走路」这个判断偷偷变成了「所有片段都是走路」。
 * 正确的判据只有一条 —— **只有在 `sfx` 或 `clipFallback` 里被显式登记过的片段才是
 * 移动片段**。没登记的（idle / gaze / lie / 跳跃 / 任何新加的姿态）一律不发声。
 *
 * 代价是：新增一个移动片段忘了登记 = 那个姿态没脚步声。这是**安静的失败**，
 * 比「站着不动响脚步」好得多，而且校验器会把它报出来。
 */
export function resolveSfx(
  sfx: Record<string, AudioCueRef> | undefined,
  clipFallback: Record<string, string> | undefined,
  clip: string,
): AudioCueRef | null {
  if (!sfx) return null;
  const seen = new Set<string>();
  let key: string | undefined = clip;
  while (key && !seen.has(key)) {
    seen.add(key);
    const hit = sfx[key];
    // 值可能是裸 id，也可能是带本处音量的 { id, volume }——一律走 audioCueId 判“算不算登记过”。
    if (audioCueId(hit)) return hit;
    key = clipFallback?.[key];
  }
  return null;
}

/**
 * 这个片段算不算「移动片段」（即：走它的时候该不该有脚步声）。
 *
 * 判据只有一条：**在任何一个脚步集的 `sfx` 里、或在 `clipFallback` 里被显式登记过**。
 * 没有隐式规则、不按名字猜（不看它叫不叫 "walk"）——名字判断迟早会被
 * `carry_walk` / `hero_walk_guangcai` / `crouchWalk` 这类真实片段名撞穿。
 */
export function isLocomotionClip(cfg: FootstepConfig, clip: string): boolean {
  if (cfg.clipFallback && clip in cfg.clipFallback) return true;
  for (const set of Object.values(cfg.sets ?? {})) {
    if (set.sfx && clip in set.sfx) return true;
  }
  return false;
}

export function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

function firstNum(...vals: Array<number | undefined>): number {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}
