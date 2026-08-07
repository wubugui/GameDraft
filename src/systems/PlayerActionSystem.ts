import type { EventBus } from '../core/EventBus';
import type { InputManager } from '../core/InputManager';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { Player } from '../entities/Player';
import type {
  ActionDef,
  ActSpotData,
  GameContext,
  IGameSystem,
  PlayerActConfig,
  PlayerActsConfig,
  PlayerPosture,
  PlayerPostureConfig,
  PlayerVerb,
} from '../data/types';
import {
  PLAYER_CROUCH_WALK_LOGICAL_STATE,
  PLAYER_VERBS,
  PLAYER_VERB_LOGICAL_STATES,
} from '../data/types';
import { PLAYBACK_SPEED_MAX, PLAYBACK_SPEED_MIN } from '../rendering/SpriteEntity';
import type { PlaneInteractionPolicy } from './InteractionSystem';

/**
 * 玩家身体动词系统（蹲 / 驻足注视 / 踢 / 跳 / 躺）。
 *
 * 两类语义，**不是动作游戏**：
 * - 姿态（crouch / gaze / lie）：持续态、单槽互斥、进出各一次回调，**不入存档**。
 * - 一次性动作（kick / jump）：播一段动画 → 到 callbackFrame 触发回调 → 回 idle。
 *   目标在**按下那一刻**由 InteractionSystem 的同一套最近目标口径给出，
 *   **没有命中判定、没有前后摇分段、没有冷却、没有扇区**。
 *
 * 依赖一律构造注入或 setter 注入（不持有任何同层 system 引用）：
 * 最近目标、zone 派发、位面门闸都是 Game 组装层给的闭包。
 */

/** 动词键位（探索态）。ruleUse 面板已让位到 KeyG，F 归身体动词。 */
export const VERB_KEYS: Record<PlayerVerb, string> = {
  crouch: 'KeyC',
  gaze: 'KeyX',
  kick: 'KeyF',
  jump: 'Space',
  lie: 'KeyC', // 躺是语境化的蹲：站在躺点上按蹲键即躺下
};

/** 姿态动词按住式；一次性动作点按式 */
const POSTURE_VERBS = ['crouch', 'gaze', 'lie'] as const;

/** 会在目标头顶出动词提示的动词（按优先级）；躺/跨点走 act_spot 那条 */
const PROMPTED_ACT_VERBS = ['kick', 'gaze'] as const;

/** 动词提示的键名标签（提示框里显示的那几个字） */
const VERB_PROMPT_LABELS: Record<PlayerVerb, string> = {
  crouch: 'C',
  gaze: 'X',
  kick: 'F',
  jump: 'Space',
  lie: 'C',
};

const DEFAULT_POSTURE: Required<Pick<PlayerPostureConfig, 'enterMs' | 'exitMs'>> = {
  enterMs: 250,
  exitMs: 300,
};
const DEFAULT_CROUCH_SPEED_SCALE = 0.45;
const DEFAULT_LIE_EXIT_MS = 900;
const DEFAULT_ACT_LOCK_MS = 500;
const DEFAULT_JUMP_DURATION_MS = 480;
const DEFAULT_JUMP_ARC_HEIGHT = 46;

/**
 * 按下动词时最近的、**图里有同名 entry** 的目标。
 * 「这个目标吃不吃这个动词」由它自己那张图回答，实体上没有另一张响应表。
 */
export interface VerbGraphTarget {
  kind: 'hotspot' | 'npc';
  id: string;
  name: string;
  graphId: string;
  x: number;
  y: number;
}

export interface PlayerActionBinding {
  /** 最近的、图里有以该动词命名 entry 的目标；无则 null */
  findVerbGraphTarget: (verb: PlayerVerb) => VerbGraphTarget | null;
  /** 从指定入口开图（动词路由的落点） */
  startGraphAtEntry: (target: VerbGraphTarget, entry: PlayerVerb) => void;
  /** 最近的支持该动词的 act_spot（躺点 / 跨点）；无则 null */
  findActSpot: (verb: PlayerVerb) => { id: string; data: ActSpotData; label: string } | null;
  /** 交给 ZoneSystem 派发（返回 true = 有 zone 接住） */
  dispatchZoneAct: (verb: PlayerVerb) => boolean;
  /** 是否处于可受理动词输入的状态（Exploring 且无演出占用） */
  canAcceptInput: () => boolean;
  /**
   * 显示 / 收起 act_spot 的动词提示（躺点、跨点）。act_spot 不出 E 提示，
   * 玩家能不能在这儿做这个动作，全靠这行提示告诉他。
   * hotspotId=null 时收起全部动词提示。
   */
  setActSpotPrompt: (hotspotId: string | null, keyLabel: string) => void;
}

export class PlayerActionSystem implements IGameSystem {
  private readonly eventBus: EventBus;
  private readonly inputManager: InputManager;
  private readonly actionExecutor: ActionExecutor;
  private readonly player: Player;

  private binding: PlayerActionBinding | null = null;
  private config: PlayerActsConfig = {};
  private planePolicy: (() => PlaneInteractionPolicy) | null = null;

  /** 当前姿态槽（单槽互斥）；null = 站姿 */
  private posture: PlayerPosture | null = null;
  /** 姿态所在的 act_spot（仅 lie 用；起身时跑它的 exitActions） */
  private postureSpot: { id: string; data: ActSpotData } | null = null;
  /** 姿态进入/退出动画的剩余锁定时间（秒）；>0 期间不受理新动词输入 */
  private transitionRemainSec = 0;
  /** 姿态期间已触发过 gaze 回调的目标 id（松键或换目标才清） */
  private gazeTriggeredTargetId: string | null = null;
  /** gaze 按住计时（秒），用于 holdMsToTrigger */
  private gazeHeldSec = 0;

  /** 一次性动作在途状态 */
  private pendingAct: {
    verb: PlayerVerb;
    remainSec: number;
    callbackAtSec: number;
    fired: boolean;
    run: (() => void) | null;
  } | null = null;

  /** 上一帧的姿态动画请求（避免每帧重播片段） */
  private lastPostureAnimKey: string | null = null;
  /**
   * 姿态键闩（按**键码**闩，不是一个全局开关）：某姿态是被"移动/E"这类非松键路径顶出来的，
   * 而它的键还按着时闩住该键，直到玩家真的松开。
   * 只闩那一个键——闩全局会造成「连按两下 C 后蹲键假死」。
   */
  private latchedKeys: Set<string> = new Set();
  /** 当前正显示动词提示的 act_spot id（只在变化时下发，避免每帧重建图标） */
  private promptedSpotId: string | null = null;

  constructor(
    eventBus: EventBus,
    inputManager: InputManager,
    actionExecutor: ActionExecutor,
    player: Player,
  ) {
    this.eventBus = eventBus;
    this.inputManager = inputManager;
    this.actionExecutor = actionExecutor;
    this.player = player;
  }

  init(_ctx: GameContext): void {}

  /** 姿态是瞬时表现态，**不入存档**（存了会出现「档里蹲着、精灵站着」的必然错位）。 */
  serialize(): object {
    return {};
  }
  deserialize(_data: object): void {
    this.resetToStand('hard');
  }

  setBinding(binding: PlayerActionBinding | null): void {
    this.binding = binding;
  }

  setConfig(config: PlayerActsConfig | undefined): void {
    this.config = config ?? {};
  }

  setPlaneInteractionPolicy(fn: (() => PlaneInteractionPolicy) | null): void {
    this.planePolicy = fn;
    // 切位面后当前姿态可能被禁：立即复位，避免「位面说不许蹲、玩家还蹲着」
    if (this.posture && !this.verbAllowedByPlane(this.posture)) {
      this.resetToStand();
    }
  }

  /** 只读：该动词此刻可不可用（触屏 HUD 据此隐藏死按钮）。 */
  isVerbUsable(verb: PlayerVerb): boolean {
    return this.verbUsable(verb);
  }

  /** 只读：当前姿态（`{posture}` 条件叶与调试快照消费）。 */
  getPosture(): PlayerPosture | null {
    return this.posture;
  }

  /** 只读：有没有一次性动作在跑。给每帧热路径用（别为这个去调 getDebugState）。 */
  hasPendingAct(): boolean {
    return this.pendingAct !== null;
  }

  /** 只读：调试快照用。 */
  getDebugState(): {
    posture: PlayerPosture | null;
    pendingAct: PlayerVerb | null;
    availableVerbs: PlayerVerb[];
  } {
    return {
      posture: this.posture,
      pendingAct: this.pendingAct?.verb ?? null,
      availableVerbs: PLAYER_VERBS.filter((v) => this.verbUsable(v)),
    };
  }

  /** 切场景：姿态复位 + 会话级 oncePerScene 记忆清空。 */
  onSceneChanged(): void {
    this.resetToStand('hard');
  }

  /**
   * 回到站姿。两种力度，区别在**要不要抢 Player 的位移与动画**：
   *
   * - `hard`（切场景 / 读档 / 销毁）：确定没有别人在开玩家，连位移带动画一起复位。
   * - 缺省（进对话/过场/面板等"离开探索态"）：**只归还自己占的东西**。此刻玩家很可能
   *   刚被动作批的 moveEntityTo / 过场接管——抢它的 moveTarget 会让那段位移瞬间"到达"、
   *   走路片段被 idle 顶掉，正是本功能的主用例（蹲下翻检 → 动作批走位）会踩的坑。
   *
   * 两种力度都**对仍按着的姿态键上闩**：被外力顶出姿态后必须重新按一次，
   * 否则「按住 C 蹲下 → 起对话 → 对话结束回探索 → C 还按着 → 又蹲又起对话」会无限循环。
   */
  resetToStand(mode: 'soft' | 'hard' = 'soft'): void {
    const from = this.posture;
    const hadOwnAct = this.pendingAct !== null;
    this.posture = null;
    this.postureSpot = null;
    this.transitionRemainSec = 0;
    this.gazeTriggeredTargetId = null;
    this.gazeHeldSec = 0;
    this.pendingAct = null;
    this.lastPostureAnimKey = null;
    this.latchPressedPostureKeys();
    // 本系统只可能拥有 jumpTarget（alignToSpot 是直接落位、不建 moveTarget），
    // 所以 soft 模式只取消**跳**——`cancelMotion()` 会连别人的 moveTarget 一起清掉。
    if (mode === 'hard') this.player.cancelMotion();
    else if (hadOwnAct) this.player.cancelJump();
    this.player.setPostureMovement(null);
    this.player.setAnimationOwnedByAction(false);
    this.player.setInputLocked(false);
    this.clearActSpotPrompt();
    // 姿态帧是 holdFrame 定格（playing=false），没人会替它复原——但玩家已被位移演出
    // 接管时不能抢它的片段（那边正播走路）。
    if (mode === 'hard' || !this.player.hasActiveMotion()) {
      this.player.playAnimation('idle');
    }
    if (from) {
      this.eventBus.emit('player:posture', { from, to: null, x: this.player.x, y: this.player.y });
    }
  }

  /**
   * 复位时把仍按着的姿态键闩住（见 resetToStand 注释里的无限重触发）。
   * **hard 模式也闩是刻意的**：按住 C 走过传送点换场景 / 读档后，玩家要松手再按才会蹲——
   * 「进新场景就自动蹲下」不是想要的行为。
   */
  private latchPressedPostureKeys(): void {
    for (const posture of POSTURE_VERBS) {
      const key = VERB_KEYS[posture];
      if (this.inputManager.isKeyDown(key)) this.latchedKeys.add(key);
    }
  }

  // ————————————————————————————— 每帧 —————————————————————————————

  /** 必须在 player.update(dt) **之前**调用：本帧设的锁/姿态/动画要当帧生效。 */
  update(dt: number): void {
    if (!this.binding || !this.binding.canAcceptInput()) {
      // 非探索态（对话/过场/面板/小游戏）一律复位，不留半个姿态
      if (this.posture || this.pendingAct || this.transitionRemainSec > 0) {
        this.resetToStand();
      }
      // 无姿态时 resetToStand 不跑，动词提示要单独收——否则对话期间「[C] 躺下」还浮着
      this.clearActSpotPrompt();
      return;
    }

    if (this.transitionRemainSec > 0) {
      this.transitionRemainSec = Math.max(0, this.transitionRemainSec - dt);
    }
    this.advancePendingAct(dt);

    // 一次性动作在途 / 姿态进出过渡中：不受理新输入（这是播放互斥，不是冷却）
    const busy = this.pendingAct !== null || this.transitionRemainSec > 0;
    if (!busy) {
      this.readPostureInput();
      // 姿态在途时不受理一次性动作：没有蹲踢/躺跳这种片段，硬播会让姿态与精灵错位
      if (this.posture === null) this.readActInput();
    }

    this.syncPostureAnimation();
    this.advanceGaze(dt);
    this.syncActSpotPrompt();
  }

  /**
   * act_spot 的动词提示：站在躺点/跨点范围内时把键名浮在那个点上。
   * 有姿态或动作在途时收起（此刻按键另有语义）。
   */
  private syncActSpotPrompt(): void {
    if (this.posture !== null || this.pendingAct !== null) {
      this.clearActSpotPrompt();
      return;
    }
    // ① act_spot（躺点 / 跨点）：不出 E 提示，只出动词提示
    let spot: { id: string; data: ActSpotData; label: string } | null = null;
    let keyLabel = '';
    if (this.verbUsable('lie')) {
      spot = this.binding?.findActSpot('lie') ?? null;
      if (spot) keyLabel = 'C';
    }
    if (!spot && this.verbUsable('jump')) {
      spot = this.binding?.findActSpot('jump') ?? null;
      if (spot) keyLabel = 'Space';
    }
    if (spot) {
      if (this.promptedSpotId === spot.id) return;
      this.promptedSpotId = spot.id;
      // 提示词：promptKey（策划写的「躺下歇一气」，可含 [tag:…]）> 热点 label > 只有键名
      const text = (spot.data.promptKey || spot.label || '').trim();
      this.binding?.setActSpotPrompt(spot.id, text ? `${keyLabel} ${text}` : keyLabel);
      return;
    }
    // ② 图里有同名 entry 的目标：这就是「能不能踢由提示告诉玩家」的承接物
    for (const verb of PROMPTED_ACT_VERBS) {
      if (!this.verbUsable(verb)) continue;
      const target = this.binding?.findVerbGraphTarget(verb) ?? null;
      if (!target) continue;
      const key = `${target.id}:${verb}`;
      if (this.promptedSpotId === key) return;
      this.promptedSpotId = key;
      this.binding?.setActSpotPrompt(target.id, VERB_PROMPT_LABELS[verb]);
      return;
    }
    this.clearActSpotPrompt();
  }

  private clearActSpotPrompt(): void {
    if (this.promptedSpotId === null) return;
    this.promptedSpotId = null;
    this.binding?.setActSpotPrompt(null, '');
  }

  /** 提示句柄：act_spot 是热点 id，动词目标是 `id:verb`（同一目标换动词要重画）。 */

  private advancePendingAct(dt: number): void {
    const act = this.pendingAct;
    if (!act) return;
    act.remainSec = Math.max(0, act.remainSec - dt);
    if (!act.fired && act.remainSec <= act.callbackAtSec) {
      act.fired = true;
      act.run?.();
      act.run = null;
    }
    if (act.remainSec > 0) return;
    this.pendingAct = null;
    // 收招：动画所有权与腿一起还给玩家（姿态仍在时由姿态继续持有）。
    // lastPostureAnimKey 必须无条件清——动作片段已经把姿态定格帧顶掉了，
    // 不清就会因"请求没变"而跳过重建，精灵停在动作末帧、系统却以为还蹲着。
    this.player.setInputLocked(false);
    this.lastPostureAnimKey = null;
    if (!this.posture) {
      this.player.setAnimationOwnedByAction(false);
    }
  }

  // ————————————————————————————— 姿态 —————————————————————————————

  private readPostureInput(): void {
    const crouchHeld = this.inputManager.isKeyDown(VERB_KEYS.crouch);
    const gazeHeld = this.inputManager.isKeyDown(VERB_KEYS.gaze);

    // 松键 = 退出当前姿态（lie 的退出键在 readLieExit 里另有出口）
    if (this.posture === 'crouch' && !crouchHeld) {
      this.exitPosture();
      return;
    }
    if (this.posture === 'gaze' && !gazeHeld) {
      this.exitPosture();
      return;
    }
    if (this.posture === 'lie') {
      this.readLieExit();
      return;
    }
    if (this.posture !== null) return;

    // 松开即解闩（逐键判定）
    if (!crouchHeld) this.latchedKeys.delete(VERB_KEYS.crouch);
    if (!gazeHeld) this.latchedKeys.delete(VERB_KEYS.gaze);

    // 进入：注视优先于蹲（两键同按时以后按下的为准无法区分，取固定优先级更可预期）
    if (gazeHeld && !this.latchedKeys.has(VERB_KEYS.gaze) && this.verbUsable('gaze')) {
      this.enterPosture('gaze');
      return;
    }
    if (crouchHeld && !this.latchedKeys.has(VERB_KEYS.crouch)) {
      // 站在躺点上时蹲键语境化为躺
      if (this.verbUsable('lie')) {
        const spot = this.binding?.findActSpot('lie') ?? null;
        // freeAnywhere=true 时没有躺点也能就地躺下（缺省 false：躺的地点由策划钉）
        if (spot) {
          this.enterPosture('lie', spot);
          return;
        }
        if (this.config.lie?.freeAnywhere === true) {
          this.enterPosture('lie', null);
          return;
        }
      }
      if (this.verbUsable('crouch')) this.enterPosture('crouch');
    }
  }

  /** 躺的出口：任意移动键或 E。起身耗时不可打断（这是躺的代价）。 */
  private readLieExit(): void {
    const dir = this.inputManager.getMovementDirection();
    // E **消费掉**：躺着按 E 只起身，不该同帧再触发身边热点（InteractionSystem 排在本系统之后）
    const pressedE = this.inputManager.consumeKeyJustPressed('KeyE');
    if (dir.x !== 0 || dir.y !== 0 || pressedE) this.exitPosture();
  }

  private enterPosture(posture: PlayerPosture, spot?: { id: string; data: ActSpotData } | null): void {
    const cfg = this.postureConfig(posture);
    this.posture = posture;
    this.postureSpot = spot ?? null;
    this.gazeTriggeredTargetId = null;
    this.gazeHeldSec = 0;
    this.lastPostureAnimKey = null;

    this.player.setAnimationOwnedByAction(true);
    this.player.setPostureMovement({
      speedScale: this.postureSpeedScale(posture, cfg),
      allowRun: cfg?.allowRun ?? false,
    });

    // 进入动画：完整播一遍下蹲/躺下过程（之后由 syncPostureAnimation 定格末帧，不重播）。
    // 片段本身 16 帧 @8fps = 2s，远长于想要的手感；用 playback.speed 把它压进 enterMs，
    // 而不是播一半被 holdFrame 硬切（那会看见明显跳帧）。
    const logical = PLAYER_VERB_LOGICAL_STATES[posture];
    const enterMs = cfg?.enterMs ?? (posture === 'lie' ? 700 : DEFAULT_POSTURE.enterMs);
    this.transitionRemainSec = this.playClipFittedTo(logical, Math.max(1, enterMs), { loop: false });
    // 进入过渡期间锁腿（起手要站定），过渡结束自动解
    this.player.setInputLocked(true);

    let handledBySpot = false;
    if (posture === 'lie' && spot) {
      this.alignToSpot(spot.data);
      if (spot.data.actions?.length) {
        this.runActions(spot.data.actions);
        handledBySpot = true; // act_spot 自己接住了：匹配到即停，不再往目标/区域层叠
      }
    }

    // 姿态也走三层派发：目标级 acts[posture] → 区域级 onPlayerAct[posture] → 无
    // （不派发的话，编辑器写得出、校验器放行、游戏里永不触发——最坏的一种"配置死区"）
    if (posture !== 'gaze' && !handledBySpot) {
      this.dispatchVerb(posture); // gaze 的派发由 advanceGaze 按 holdMs 管
    }

    this.eventBus.emit('player:posture', {
      from: null,
      to: posture,
      x: this.player.x,
      y: this.player.y,
    });
  }

  /**
   * 三层派发的唯一出口：目标级（开它的图、entry=动词名）→ 区域级 → 全局兜底。
   * 返回是否被接住。
   *
   * 目标级为什么是"开图"而不是"跑一串 actions"：动作列表**没有条件分支**
   * （`ActionRegistry` 只有问玩家的 chooseAction 与掷骰的 randomBranch），
   * 而"同一个目标对不同动词有不同反应"本质就是分支——只有图的 switch 能分。
   * 于是动词名直接当 entry：踢狗＝开狗那张图的 `kick` 入口；图里没这个入口就不吃这一脚。
   */
  private dispatchVerb(verb: PlayerVerb): boolean {
    const target = this.binding?.findVerbGraphTarget(verb) ?? null;
    if (target) {
      this.player.setFacing(target.x - this.player.x, target.y - this.player.y);
      this.binding?.startGraphAtEntry(target, verb);
      this.emitAct(verb, target.id, true);
      return true;
    }
    if (this.binding?.dispatchZoneAct(verb)) {
      this.emitAct(verb, null, false);
      return true;
    }
    return false;
  }

  private exitPosture(): void {
    const posture = this.posture;
    if (!posture) return;
    const cfg = this.postureConfig(posture);
    const logical = PLAYER_VERB_LOGICAL_STATES[posture];
    const spot = this.postureSpot;

    // 起身 = 进入片段倒放（人形包没有单独的「起身」段，这是过场里验证过的手艺）
    const exitMs = cfg?.exitMs ?? (posture === 'lie' ? DEFAULT_LIE_EXIT_MS : DEFAULT_POSTURE.exitMs);
    this.transitionRemainSec = Math.max(0, exitMs) / 1000;
    if (this.player.hasAnimationState(logical)) {
      this.transitionRemainSec = this.playClipFittedTo(logical, Math.max(1, exitMs), {
        loop: false, reverse: true, thenState: 'idle',
      });
    }

    this.posture = null;
    this.postureSpot = null;
    this.gazeTriggeredTargetId = null;
    this.gazeHeldSec = 0;
    this.lastPostureAnimKey = null;
    this.player.setPostureMovement(null);
    this.player.setInputLocked(true);

    if (posture === 'lie' && spot) this.runActions(spot.data.exitActions);
    // 上闩：只在"退出时该键仍按着"才闩，且只闩这一个键。
    // 正常的松键退出不上闩——否则「点一下 C 起身、还没到 300ms 又按住 C」会假死到松手。
    const key = VERB_KEYS[posture];
    if (this.inputManager.isKeyDown(key)) this.latchedKeys.add(key);

    this.eventBus.emit('player:posture', {
      from: posture,
      to: null,
      x: this.player.x,
      y: this.player.y,
    });
  }

  /**
   * 落位对齐：把玩家挪到 act_spot 的 align 点并转向。
   * 距离很近（都在 interactionRange 内）时直接落位，避免为几十像素引入一段异步位移——
   * 位移在途遇到切场景/读档就是"旧时间线写新状态"的经典破口。
   */
  private alignToSpot(data: ActSpotData): void {
    const align = data.align;
    if (align && Number.isFinite(align.x) && Number.isFinite(align.y)) {
      this.player.cancelMotion();
      this.player.x = align.x;
      this.player.y = align.y;
    }
    if (data.facing) this.player.setFacing(data.facing === 'left' ? -1 : 1, 0);
  }

  /**
   * 播一个片段并把它**压缩/拉伸到指定毫秒**播完（用 playback.speed）。
   * 图集里的姿态片段都是 16 帧 @8fps＝2 秒，直接播会慢得像慢动作；
   * 按配置时长变速，既保证播完整、又拿到想要的手感。
   */
  private playClipFittedTo(
    logicalName: string,
    ms: number,
    playback: { loop?: boolean; reverse?: boolean; thenState?: string },
  ): number {
    // 先按原速载入以量出片段真实时长，再按比例重播（playAnimation 幂等保护对带
    // playback 的调用不生效，两次调用都会真的重启片段，故这里只多花一次赋值）
    this.player.playAnimation(logicalName, { ...playback, speed: 1 });
    const { durationSec } = this.player.getCurrentClipTiming();
    const wantSec = Math.max(0.001, ms / 1000);
    if (durationSec <= 0) return wantSec;
    // SpriteEntity 会把 speed 钳到 [0.1, 10]：钳住时片段播不完想要的那么快，
    // 返回**实际**时长让调用方把锁窗对齐过去，否则锁一到就 holdFrame 硬切＝跳帧回来了
    const raw = durationSec / wantSec;
    const speed = Math.min(PLAYBACK_SPEED_MAX, Math.max(PLAYBACK_SPEED_MIN, raw));
    this.player.playAnimation(logicalName, { ...playback, speed });
    return durationSec / speed;
  }

  /**
   * 回调离动作开始有多远：把 callbackFrame 换算成时间偏移（从动作起点算）。
   * 这是**表演对齐**（脚落地那一下要和世界反应对上），不是命中窗口，不影响成败。
   */
  private callbackRemainSec(
    callbackFrame: number | undefined,
    timing: { frameCount: number; durationSec: number },
    lockSec: number,
  ): number {
    const frames = Math.max(1, timing.frameCount);
    const raw = typeof callbackFrame === 'number' && Number.isFinite(callbackFrame)
      ? Math.trunc(callbackFrame)
      : Math.floor(frames / 2);
    const frame = ((raw % frames) + frames) % frames;
    const perFrame = (timing.durationSec > 0 ? timing.durationSec : lockSec) / frames;
    // 剩余时间口径：越靠后的帧剩得越少
    return Math.min(lockSec, Math.max(0, lockSec - frame * perFrame));
  }

  /** 姿态动画的每帧维持：静止定格末帧、移动切蹲行片段；仅在请求变化时才下发。 */
  private syncPostureAnimation(): void {
    if (this.transitionRemainSec <= 0 && !this.pendingAct) {
      // 过渡结束：解锁腿；无姿态时把动画所有权也还回去
      this.player.setInputLocked(false);
      if (!this.posture) {
        this.player.setAnimationOwnedByAction(false);
        this.lastPostureAnimKey = null;
        return;
      }
    }
    if (!this.posture || this.transitionRemainSec > 0 || this.pendingAct) return;

    const dir = this.inputManager.getMovementDirection();
    const moving = dir.x !== 0 || dir.y !== 0;
    const logical = PLAYER_VERB_LOGICAL_STATES[this.posture];
    // 蹲行有专门片段就走它（循环播）；没有就定格在姿态末帧（滑着走，是已知的将就）
    const crouchWalkable =
      this.posture === 'crouch' && this.player.hasAnimationState(PLAYER_CROUCH_WALK_LOGICAL_STATE);
    const key = moving && crouchWalkable ? `move:${PLAYER_CROUCH_WALK_LOGICAL_STATE}` : `hold:${logical}`;
    if (key === this.lastPostureAnimKey) return;
    this.lastPostureAnimKey = key;
    if (moving && crouchWalkable) {
      this.player.playAnimation(PLAYER_CROUCH_WALK_LOGICAL_STATE, { loop: true });
    } else {
      // holdFrame:-1 = 末帧（内部取模），直接定格，不重播下蹲过程
      this.player.playAnimation(logical, { holdFrame: -1 });
    }
  }

  /** 注视的回调：进入即触发（holdMsToTrigger 缺省 0）；换目标可再触发一次。 */
  private advanceGaze(dt: number): void {
    if (this.posture !== 'gaze' || this.transitionRemainSec > 0) return;
    this.gazeHeldSec += dt;
    const cfg = this.config.gaze;
    const holdSec = Math.max(0, cfg?.holdMsToTrigger ?? 0) / 1000;
    if (this.gazeHeldSec < holdSec) return;
    if (this.gazeTriggeredTargetId !== null) return; // 已触发：注视期间站定，不重复开图
    const target = this.binding?.findVerbGraphTarget('gaze') ?? null;
    if (target) {
      this.gazeTriggeredTargetId = target.id;
      this.dispatchVerb('gaze');
      return;
    }
    // 没有目标就交给 zone。**不占位**：玩家虽站定，巡逻 NPC 会走进范围、
    // 实体 conditions 也会翻，占位会让"看着看着才出现的东西"永远看不出门道。
    if (this.binding?.dispatchZoneAct('gaze')) {
      this.gazeTriggeredTargetId = '\u0000zone'; // zone 接住了才封口，防重复触发
      this.emitAct('gaze', null, false);
    }
  }

  // ———————————————————————— 一次性动作 ————————————————————————

  private readActInput(): void {
    if (this.inputManager.wasKeyJustPressed(VERB_KEYS.jump) && this.verbUsable('jump')) {
      this.doJump();
      return;
    }
    if (this.inputManager.wasKeyJustPressed(VERB_KEYS.kick) && this.verbUsable('kick')) {
      this.doKick();
    }
  }

  private doKick(): void {
    const cfg = this.actConfig('kick');
    // 朝向在真正派发那一刻由 dispatchVerb 设（那时才知道命中谁）；起手先不转身
    this.player.setAnimationOwnedByAction(true);
    this.player.setInputLocked(true);
    this.player.playAnimation(PLAYER_VERB_LOGICAL_STATES.kick, { loop: false, thenState: 'idle' });

    // 锁腿时长缺省 = 片段自己播完一遍；回调对齐到 callbackFrame（缺省片段中点）
    const timing = this.player.getCurrentClipTiming();
    const lockSec =
      cfg?.lockMs !== undefined
        ? Math.max(0, cfg.lockMs) / 1000
        : timing.durationSec > 0
          ? timing.durationSec
          : DEFAULT_ACT_LOCK_MS / 1000;
    this.pendingAct = {
      verb: 'kick',
      remainSec: lockSec,
      callbackAtSec: this.callbackRemainSec(cfg?.callbackFrame, timing, lockSec),
      fired: false,
      run: () => {
        // 目标级（开图）→ 区域级 → 全局兜底（可以什么都不配）
        if (this.dispatchVerb('kick')) return;
        this.runActions(cfg?.missActions);
        this.emitAct('kick', null, false);
      },
    };
  }

  private doJump(): void {
    const cfg = this.actConfig('jump');
    const spot = this.binding?.findActSpot('jump') ?? null;
    const durationMs = spot?.data.durationMs ?? cfg?.durationMs ?? DEFAULT_JUMP_DURATION_MS;
    const arcHeight = spot?.data.arcHeight ?? cfg?.arcHeight ?? DEFAULT_JUMP_ARC_HEIGHT;
    // 跨点跳落到策划钉的落点；否则原地跳（不位移）。跳没有目标，也不做落点判定。
    const landing = spot?.data.landing;
    if (spot) this.alignToSpot(spot.data);
    const targetX = landing?.x ?? this.player.x;
    const targetY = landing?.y ?? this.player.y;

    this.player.setAnimationOwnedByAction(true);
    this.player.setInputLocked(true);
    void this.player
      .jumpTo(
        targetX,
        targetY,
        durationMs,
        arcHeight,
        PLAYER_VERB_LOGICAL_STATES.jump,
        'idle',
        landing !== undefined,
      )
      .catch((e) => console.warn('PlayerActionSystem: jumpTo 失败', e));

    const lockSec = Math.max(0, durationMs) / 1000;
    this.pendingAct = {
      verb: 'jump',
      remainSec: lockSec,
      callbackAtSec: 0, // 跳的回调落在落地那一拍
      fired: false,
      run: () => {
        if (spot?.data.actions?.length) {
          this.runActions(spot.data.actions);
          this.emitAct('jump', spot.id, true);
          return;
        }
        if (this.dispatchVerb('jump')) return;
        this.emitAct('jump', null, false);
      },
    };
  }

  // ————————————————————————— 回调派发 —————————————————————————

  private emitAct(verb: PlayerVerb, targetId: string | null, hit: boolean): void {
    this.eventBus.emit('player:act', {
      verb,
      targetId,
      hit,
      x: this.player.x,
      y: this.player.y,
    });
  }

  /** 动作批一律走统一执行器；失败只记不抛（内容错误不许把输入卡死）。 */
  private runActions(actions: ActionDef[] | undefined): void {
    if (!actions || actions.length === 0) return;
    void this.actionExecutor
      .executeBatchAwait(actions)
      .catch((e: unknown) => console.warn('PlayerActionSystem: 动作批执行失败', e));
  }

  // ————————————————————————— 可用性判定 —————————————————————————

  /**
   * 动词可用 = 全局未禁用 ∧ 位面允许 ∧ 当前装扮能播出它的片段。
   * 第三条就是「缺项即禁用」：背尸包没有 kick，扛着尸体自然踢不了，不需要额外开关。
   */
  private verbUsable(verb: PlayerVerb): boolean {
    if (this.verbEnabledInConfig(verb) === false) return false;
    if (!this.verbAllowedByPlane(verb)) return false;
    return this.player.hasAnimationState(PLAYER_VERB_LOGICAL_STATES[verb]);
  }

  private verbEnabledInConfig(verb: PlayerVerb): boolean {
    const slot = this.config[verb] as { enabled?: boolean } | undefined;
    return slot?.enabled !== false;
  }

  private verbAllowedByPlane(verb: PlayerVerb): boolean {
    const allowed = this.planePolicy?.().allowedVerbs ?? null;
    if (allowed === null) return true;
    return allowed.includes(verb);
  }

  private postureConfig(posture: PlayerPosture): PlayerPostureConfig | undefined {
    return this.config[posture];
  }

  private actConfig(verb: 'kick' | 'jump'): PlayerActConfig | undefined {
    return this.config[verb];
  }

  private postureSpeedScale(posture: PlayerPosture, cfg: PlayerPostureConfig | undefined): number {
    // 显式 0 是合法值（驻足注视＝站定不动），不能被 `>0` 的守卫当成"没配"吞掉
    const v = cfg?.speedScale;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    if (posture === 'crouch') return DEFAULT_CROUCH_SPEED_SCALE;
    // 注视与躺都站定：设计上「驻足」就是不动
    return 0;
  }

  /** 只读：POSTURE_VERBS 供测试与编辑器口径对齐 */
  static get postureVerbs(): readonly PlayerVerb[] {
    return POSTURE_VERBS;
  }

  destroy(): void {
    this.resetToStand('hard');
    this.binding = null;
    this.planePolicy = null;
    this.config = {};
  }
}
