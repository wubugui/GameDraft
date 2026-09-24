/**
 * 世界脑：开关打开时，把一整条街上的人交给决策服务（System One 格式：局域网 Laya，或公网 Jev；
 * 下文统称"决策服务"）来"想"，本地逐帧"做"。关着时**什么都不做**——NPC 走的是场景数据里写的默认逻辑（巡逻 / 站桩）。
 *
 * ## 不影响正常游戏的四道闸
 * 1. **缺省关**，只有调试面板 / URL `?jevBrain=1` / 控制台能打开（开发模式才有 Jev 转发）；
 * 2. **只在有配置的场景起作用**（`public/assets/data/world_brain/<sceneId>.json`）；
 * 3. **全是内存态**：停巡逻、位移、播动画、会话级显隐——不写 flag、不改场景数据，不进 `registeredSystems`
 *    （没有存档桶）；唯一的例外是配置里写了"发道具"职责的人，玩家找他说话时给的东西进背包；
 * 4. **懒接管、交还原位**：某个人第一次拿到 Jev 的决定才停他的巡逻；关掉时每个被接管的人
 *    站起来、现身、走回作者摆的原位，再按原样重启巡逻。
 *
 * ## 感知是通用的（不认技能、不认动作）
 * 三路，都是"一件事一句话"，**同一种处理**：
 * - **世界里的事**：旁听动作执行器（压暗天色、闪屏、震屏、起风、落雷、放声音、有人喊话、实体出现消失……
 *   按动作类型描述）、旁听粒子系统（冒出 / 收掉的效果，用效果自带的 label）、着火、受伤、换时辰（`worldSenses.ts`）；
 * - **玩家干的事**：引擎的玩家状态串（`PlayerActivity`）报来的一句话——用道具、踢、蹲、找人说话、捡、点火、买、扔、
 *   手上换东西……句子取道具表 / 实体名 / 挂件 label 等数据，**世界脑不一个动作一个 case**；
 * - **街上别人干的事、说的话**：每个人开始一件事、说出一句话都记成一件事（带 actor），别人看得见；
 *   每个人的 state 里还有"看得见的人此刻在做啥"——人与人之间相互影响，不只是冲玩家。
 * **这事吓不吓人由决策服务判**（每件新事单独一发显著度题），本地不写死分数：玩家 / 别人干的事先只惊动
 * 跟前（或被冲着）的人，判成吓人的再惊动看得见的所有人（人传人有冷却，防互相惊动没完）；
 * 蹲下抱头、扑地、吓一跳、跑这几样"怕"的反应，只在他感觉得到吓人的事时才进菜单。
 *
 * ## 发道具的职责
 * 配置里给某人写 `handOut`：玩家找他说话，他把玩家缺的那几样塞给玩家（走背包的正式加物品入口，进存档），
 * 这是世界脑唯一写进游戏状态的地方，只在开关开着、玩家亲手找他时发生。
 *
 * ## 节奏：一人一发、排队
 * 整条街塞一个 state 再按"第几个人"问，Laya 实测全错（窗口 2048，state 超了还会被截）——
 * 所以**一个人单独一发**（只含他自己和他感觉得到的事），**一件事的显著度单独一发**。
 * 所有发请求的活进一条本地队列，同时在途 `maxConcurrentRequests` 发（Laya 在 GPU 上合批，缺省 16），
 * 多出来的按这个次序排：
 * - 玩家按 E 搭话的回话**最先**（不排在常规决策后头）；
 * - 其次是街上出了事被标记的人，离玩家近的先问；再其次是新事的显著度；最后是手上的事做完了的人；
 * - 在新决定回来之前照做手上的事（不会僵在原地等网络）；按分钟限次数。
 *
 * ## 怎么问：选择题 / 逐项是非（`tuning.decisionMode`，缺省 auto：Laya 逐项是非、Jev 选择题）
 * Laya 的基础模型答选择题只看选项措辞、不看情况（平静时和雷劈在跟前挑的一样）；是非题却跟得上情况。
 * 所以连 Laya 时每个选项单独一道是非题，跟**基线**比涨了多少再挑：先问"要不要放下手上的事去应付"
 * （比他平静时涨够了才打断），打断了在反应里挑，没打断就接着做 / 做完了在日常里挑。
 * 基线每人每句只问一次（缓存），跟决策并行发。细节见 {@link WorldBrainSystem.applyPerOption}。
 *
 * ## 决策分层（越远问得越少，太远不问）
 * 一个决定做出来要时间，不用每时每刻都想：每个人按离玩家多远分近 / 中 / 远 / 停四档，
 * 日常决策、大事、小事在各档的频率不同，太远的一概不问（拉近了补问）；另有固定频率、跟距离无关的
 * 显著度判断和背景巡检。规则表见 {@link WorldBrainSystem.enqueueDue}。
 *
 * ## 说话
 * - 被搭话时怎么回（招呼 / 说忙 / 说要去哪 / 摆刚才那件事 / 怀疑是你搞的 / 撵人 / 吓得不敢说……）
 *   **按他此刻的情形出选项**，由 Jev 挑；句子带槽位，填的是此刻真实的事（`speech.ts`）。
 * - 说了就一定冒气泡：人不在屏幕上不说，被别的气泡挤住先排队；调试牌上只列气泡还挂着的那句。
 *
 * ## 时钟
 * 世界脑自己的钟只在探索态且世界没暂停时走：开背包 / 对话 / 演出期间，街上的人原地挂起，
 * 回来接着做；网络回包在暂停期间到达也先排队，恢复后才落地。
 */
import type { AnimationPlaybackParams } from '../../data/types';
import {
  buildBaselineRequest,
  buildMenu,
  buildPerOptionQuestions,
  buildPersonQuestions,
  buildPersonState,
  buildSalienceRequest,
  JEV_USD_PER_M_INPUT,
  parseJevResponse,
  personSnapshot,
  rankOptions,
  REACTION_KINDS,
  ROUTINE_KINDS,
  unmapAnswer,
  type ActOption,
  type JevAnswer,
  type JevQuestion,
  type ParsedJevResponse,
  type PerOptionRole,
  type PersonSnapshot,
  type QuestionRef,
} from './jevProtocol';
import {
  backendName,
  deciderName,
  type JevBackend,
  type JevCallResult,
  type JevStatus,
  type JevTransport,
} from './jevTransport';
import type { PackStats, PackTier } from './packTransport';
import type { PlayerActivityEntry } from '../PlayerActivity';
import { describeAgo, describeDistance, PlayerMotionSampler, WorldPerception } from './perception';
import type { StateSnapshot } from './stateAssembly';
import {
  bubbleDurationMs,
  buildReplyOptions,
  buildSayOptions,
  pickLine,
  replyPools,
  sayPools,
  type ReplyContext,
  type SlotValues,
} from './speech';
import { StreetActor, type ActorWorld, type BrainNpc } from './streetActor';
import {
  eventGist,
  eventText,
  type DecisionMode,
  type DecisionTier,
  type ReplyIntent,
  type WorldBrainEvent,
} from './types';
import { parseWorldBrainConfig, type ResolvedPerson, type ResolvedWorldBrainConfig } from './worldBrainConfig';
import {
  describeAction,
  describeBurn,
  describeVfx,
  effectName,
  shortGist,
  spokenEffectName,
  type SenseHelpers,
} from './worldSenses';

export type { BrainNpc } from './streetActor';

interface EventBusLike {
  on(event: string, cb: (payload?: any) => void): void;
  off(event: string, cb: (payload?: any) => void): void;
}

/** 引擎动作串的只读信息（`core/actionRun.ts` 的 ActionRunInfo，这里只认形状，不依赖引擎模块） */
export interface WorldRunInfo {
  readonly id: number;
  readonly initiator: { readonly kind: string; readonly id?: string };
}

/**
 * 哪些发起方算"关二狗自己起的头"（引擎给的发起方种类，见 `core/actionRun.ts`）：
 * 背包里用物品、用规矩、买卖、自己的身体动作、按 E 检视 / 拾取、遭遇里选、长按、翻档案 / 线索、坐地图走。
 * 叙事图、过场、区域、信号、时辰这些是世界自己的事。
 */
const PLAYER_INITIATOR_KINDS: ReadonlySet<string> = new Set([
  'item', 'rule', 'shop', 'playerAction', 'hotspot', 'encounter', 'pressureHold', 'clue', 'archive', 'mapTravel',
]);

export function isPlayerInitiated(run: WorldRunInfo | null | undefined): boolean {
  return !!run && PLAYER_INITIATOR_KINDS.has(run.initiator.kind);
}

export interface WorldBrainDeps {
  eventBus: EventBusLike;
  /** 读本场景的世界脑配置；没有返回 null */
  loadConfig: (sceneId: string) => Promise<unknown | null>;
  currentSceneId: () => string;
  isExploring: () => boolean;
  isWorldPaused: () => boolean;
  /** 场上某 NPC 的操作面（每次现取，不缓存对象：时段换装会重建实体） */
  getNpc: (npcId: string) => BrainNpc | null;
  /** 作者摆的原位与有没有巡逻 */
  npcAuthored: (npcId: string) => { x: number; y: number; hasPatrol: boolean } | null;
  stopNpcPatrol: (npcId: string) => void;
  startNpcPatrol: (npcId: string) => void;
  playerPos: () => { x: number; y: number };
  isRunHeld: () => boolean;
  /**
   * 玩家状态串（`PlayerActivity`）：玩家干的任何事一句话报过来，外加此刻的样子（姿态、手上拿的）。
   * 世界脑对玩家的感知**只走这一路**，不按动作一个一个接。
   */
  playerActivity: {
    onActivity: (fn: (a: PlayerActivityEntry) => void) => () => void;
    now: () => { posture: string | null; holding: string | null; heldName: string | null };
  };
  timeOfDay: () => string;
  /**
   * 旁听动作执行器：每一条要执行的动作（返回退订）。`ctx.run` = 这条动作属于哪一串、谁起的头
   * （引擎的动作串，见 `core/actionRun.ts`）。
   */
  addActionListener: (
    fn: (type: string, params: Record<string, unknown>, ctx?: { run: WorldRunInfo }) => void,
  ) => () => void;
  /** 旁听"这一串结束了"（返回退订）：事平息靠它，不靠时间窗口去猜 */
  addRunEndListener: (fn: (end: { run: WorldRunInfo; interrupted: boolean }) => void) => () => void;
  /** 旁听粒子系统：世界里冒出 / 收掉一个效果（返回退订）；`runId` = 开它的动作串（代码直接放的为 null） */
  addVfxListener: (
    fn: (kind: 'start' | 'stop', effectId: string, anchor: { x: number; y: number } | null, runId?: number | null) => void,
  ) => () => void;
  /** 粒子效果资产的 label（作者写的中文说明）；还没加载返回 null */
  vfxLabel: (effectId: string) => string | null;
  /**
   * 世界此刻的样子（只报数，怎么说归世界脑）：天色压暗倍率（1 = 原样）、场景风（此刻风速与场景写的平常风速；
   * 这个场景没风为 null）、此刻开着的效果 id（雨、烟、火光……）。
   */
  worldLook: () => { dim: number; wind: { speed: number; base: number } | null; effects: string[] };
  /** 道具表里的名字；没有这件为 null（发道具的职责用） */
  itemName: (itemId: string) => string | null;
  /** 玩家背包里某样东西有几件 */
  itemCount: (itemId: string) => number;
  /** 走背包的正式加物品入口给玩家东西（发道具的职责）；给不进去返回 false */
  giveItem: (itemId: string, count: number) => boolean;
  /** 场上实体（NPC / 热点 / 演员）的显示名 */
  entityName: (id: string) => string | null;
  /** 场上实体（热点 / NPC）的位置，给"某处烧起来了"这类事定位 */
  entityPos: (id: string) => { x: number; y: number } | null;
  /**
   * 头顶冒一句（归属世界脑）；说不出返回 false。`reply` = 回玩家的话：用正式气泡皮肤，
   * 且顶掉这个人头上世界脑自己的旧气泡（别的系统的气泡不动，返回 false 由调用方排队）。
   */
  speak: (npcId: string, text: string, ms: number, opts: { reply: boolean; scale: number }) => boolean;
  /** 这个点此刻在不在屏幕上（气泡冒在看不见的地方 = 没说） */
  onScreen: (x: number, y: number) => boolean;
  bubbleCount: () => number;
  clearBubbles: () => void;
  transport: JevTransport;
  random: () => number;
  /** 真实毫秒钟（成本闸按真实时间算，不按游戏钟） */
  wallMs: () => number;
}

export type WorldBrainStatus =
  | 'off' | 'no_config' | 'loading' | 'idle' | 'waiting' | 'error' | 'throttled' | 'returning';

export interface WorldBrainPersonRow {
  label: string;
  npcId: string;
  doing: string;
  pick: string | null;
  p: number | null;
  conf: number | null;
  /** 头上**此刻挂着**的那句（气泡收了就不显示——牌子上有的，画面上一定有） */
  say: string | null;
  /** 那句是回玩家的话 */
  sayIsReply: boolean;
  /** 被搭话了、正在等决策服务想怎么回 */
  replyPending: boolean;
  /** 决策档：近 / 中 / 远 / 停 */
  tier: string;
  /** 逐项是非：上一次"要不要放下手上的事"比他平静时涨了多少（没问过为 null） */
  gate: number | null;
  away: boolean;
  takenOver: boolean;
}

export interface WorldBrainDebugState {
  enabled: boolean;
  sceneId: string;
  hasConfig: boolean;
  status: WorldBrainStatus;
  statusText: string;
  configErrors: string[];
  configWarnings: string[];
  jev: JevStatus | null;
  /** 决策服务的显示名（Laya / Jev） */
  decider: string;
  /** 怎么问：`perOption` 逐项是非 / `choice` 选择题 / `null` 还不知道连的是谁 */
  decisionMode: 'perOption' | 'choice' | null;
  /** 问法的设定：游戏里切的（覆盖配置）或配置里的 */
  decisionModeSetting: DecisionMode;
  /** 游戏里切到哪一路决策服务；null = 跟 .env.local 的缺省 */
  backend: JevBackend | null;
  /** 正在看哪个人的详情（点名字 / 开了「按 E 开详情」时按 E 跟他说话）；没有为 null */
  inspectTarget: string | null;
  /** 按 E 搭话时是否自动打开这个人的详情（缺省关） */
  inspectOnInteract: boolean;
  /** 逐项是非：还在问的对照条数（对照跟每一发同时问，用完即删） */
  baselines: { pending: number };
  /** 排着队还没发的活 / 在途的 */
  queueLength: number;
  inFlight: number;
  /** 包通道（一拍一包）：熔断开了多久 / 为什么、暂代了几单、撤了几单、P50 / P95、在途几个包；旧通道为 null */
  channel: PackStats | null;
  /** 最近一发实际用到的模型（Laya 回 laya-*）、服务端推理耗时、state 的 token 数 */
  servedModel: string | null;
  serverLatencyMs: number | null;
  stateTokens: number | null;
  /** 服务端提示（Laya 截断了 state 时只在这里说）：最近几条 + 累计条数 */
  warnings: string[];
  warningCount: number;
  /** 各档多少人 */
  tierCounts: Record<string, number>;
  /** 最近一分钟各层发了几发（回话 / 大事小事 / 拉近补问 / 日常 / 背景巡检 / 显著度）与合计 */
  callsPerMinute: Record<CallLayer, number> & { total: number };
  requests: number;
  inputTokens: number;
  /** 累计花费（美元）；`costEstimated` = 其中有按 token 与官方价估的（直连官方时回包不带花费） */
  cost: number;
  costEstimated: boolean;
  /** 照最近几分钟的节奏，一小时大约花多少（美元）；数据不够（刚打开）为 null */
  costPerHourUsd: number | null;
  /** 同上：一小时大约多少输入 token / 多少次请求 */
  tokensPerHour: number | null;
  requestsPerHour: number | null;
  /** 估算用的是最近多少秒 */
  rateWindowSec: number;
  lastLatencyMs: number | null;
  avgLatencyMs: number | null;
  lastError: string | null;
  clock: number;
  /** 街上多紧张（决策服务判的显著度按时间衰减取最大），只给人看 */
  tension: number;
  /** 最近的事：说法 + 判的显著度（没判为 null） */
  events: string[];
  people: WorldBrainPersonRow[];
}

/** 一个人的一次决定（详情面板的"最近怎么想的"） */
export interface WorldBrainDecisionRecord {
  /** 世界脑时钟 */
  at: number;
  /** 为啥问（日常 / 出事 / 拉近补问 / 回话 / 背景巡检）、谁问的、怎么问的 */
  layer: string;
  decider: string;
  mode: 'perOption' | 'choice';
  /** 结果一句话（"挑了：撒腿就跑" / "接着做手上的事（没打断）" / "没拿到决定：……"） */
  outcome: string;
  /** 逐项是非的打断涨幅 */
  gate: number | null;
  /** 候选：分组（打断 / 反应 / 日常 / 开腔 / 回话 / 走位）、说法、此刻概率、基线、分（涨幅或概率）、是不是挑中的 */
  rows: { group: string; text: string; p: number | null; base: number | null; score: number | null; picked: boolean }[];
  /** 这次说了的那句 */
  said: string | null;
}

/** 落地时边做边记的那份（时刻 / 层 / 谁问的 / 怎么问的由 record 补上） */
type DecisionDraft = Omit<WorldBrainDecisionRecord, 'at' | 'layer' | 'decider' | 'mode'>;

/** 详情面板：一个人的一切（只读快照） */
export interface WorldBrainInspection {
  npcId: string;
  label: string;
  kind: 'human' | 'animal';
  identity: string;
  temper: string;
  activity: string;
  home: string;
  haunts: string[];
  relations: string[];
  says: string[];
  handOut: string[];
  now: {
    doing: string;
    phase: string | null;
    heading: string | null;
    forSec: number;
    leftSec: number | null;
    takenOver: boolean;
    away: boolean;
    tier: string;
    playerDist: number | null;
    lastReason: string;
    request: 'queued' | 'inFlight' | null;
    say: string | null;
  };
  /** 他此刻感觉得到的事（新的在后），带决策服务判的显著度 */
  perceives: string[];
  history: WorldBrainDecisionRecord[];
  /** 最近一发问他的请求：state（JSON）+ 每道题（说法 / 答案） */
  lastAsk: { at: number; state: string; questions: { key: string; text: string; answer: string }[] } | null;
}

/** 两种问法：街面的常规决策；玩家按 E 搭话的回话（最先问） */
type Channel = 'main' | 'reply';

/**
 * 排队的一发。一发只问一个人（走位 + 闲话 / 回话），或只问一件事的显著度。
 * 请求体在**轮到它发出时**才现做——排队这几秒里街上可能又变了。
 */
type Job =
  | { kind: 'person'; channel: Channel; npcId: string; priority: number; seq: number; layer: CallLayer }
  | { kind: 'salience'; event: WorldBrainEvent; priority: number; seq: number; layer: 'salience' };

/** 队列次序（小的先发）：回话 → 出了事的人 → 新事的显著度 → 手上的事做完了的人 */
const PRIORITY = { reply: 0, urgent: 1, salience: 2, routine: 3 } as const;

/** 一发是哪一层问的（状态牌上按层数每分钟多少发）；`baseline` = 逐项是非的基线（每人每句只算一次，缓存） */
export type CallLayer = 'reply' | 'event' | 'catchup' | 'routine' | 'background' | 'salience' | 'baseline';

/** 标记的轻重（见 markOne）；`none` = 没有待处理的标记 */
type MarkLevel = 'none' | 'routine' | 'minor' | 'major';
const MARK_RANK: Record<MarkLevel, number> = { none: 0, routine: 1, minor: 2, major: 3 };

const TIER_RANK: Record<DecisionTier, number> = { near: 0, mid: 1, far: 2, frozen: 3 };
const TIER_NAME: Record<DecisionTier, string> = { near: '近', mid: '中', far: '远', frozen: '停' };

interface PendingResult {
  job: Job;
  channel: Channel;
  /** 发出时的世界脑时钟 */
  sentAt: number;
  result: JevCallResult;
  refs: Map<string, QuestionRef>;
  /** 这一发问的那个人的菜单 / 闲话选项 / 回话选项 / 槽位（照发出时的情形） */
  menu: ActOption[];
  sayOpts: Record<string, string> | null;
  replyOpts: Record<string, string> | null;
  slots: SlotValues | null;
  /** 发出时这个人的标记序号：之后又被标记（街上又出了事），这份旧答案落地后还要再问一遍 */
  markSeqAtSend: number;
  /** 逐项是非：每道题要对照的基线（题键 → 基线）；选择题为 null */
  baseKeys: Map<string, BaseRef> | null;
  /** 回包落地的真实时刻（等基线最多等多久从这算） */
  landedWall: number;
}

/**
 * 逐项是非一道题对照的基线（**反事实**：同一发、同一个街面，只改一样东西；键 `这一发的序号|陈述`，用完即删）：
 * - `cf` 去掉刚才的事（"刚才街上发生的事"换成"没得啥子特别的事"）：打断、反应、开腔、回话跟它比——
 *   涨了多少 = 那几件事让他更可能这么做多少；街上啥都没出时涨幅恒为 0，不会平白打断
 * - `anon` 去掉他是谁（身份、脾气换成 N/A）：日常的下一件跟它比——涨了多少 = 他这个人让他更可能这么做多少
 *
 * 2026-09-22 在 laya-multilingual 上实测：日常跟空白 state（`{这个人:'N/A'}`）比，没上下文时"走到某处去"
 * 的基线几乎为 0，涨幅被抬虚，半条街乱跑、"接着做"加到 0.5 也只有 14/21 人留；跟"去掉他是谁"比，
 * 加 0.2 就 16/21 留、0.3 就 18/21 留，可控。打断跟"平静时的他"比会被 state 里别的差异（看得见的人……）
 * 抬过门槛：卖香烛的婆婆街上啥都没出就"离开这条街"。
 */
interface BaseRef {
  kind: 'cf' | 'anon';
  key: string;
}

interface ActorEntry {
  actor: StreetActor;
  takenOver: boolean;
  /** 玩家是否在跟前（边沿检测用） */
  playerNear: boolean;
  lastNearEventAt: number;
  lastStillEventAt: number;
  /** 玩家按 E 跟他搭话、还没发出去的时刻；null = 没人找他 */
  replyWanted: number | null;
  /** 回话请求发出去的时刻（常规通道更早发出的旧答案落地时，不能盖掉这份更新的） */
  replySentAt: number;
  /** 回话在途 */
  replyInFlight: boolean;
  /** 这个人有一发排在队里 / 在途（同一个人不重复排） */
  jobQueued: boolean;
  jobInFlight: boolean;
  /** 上一次给他发决策的时刻（各档日常间隔、远处大事间隔都从这算） */
  lastAskedAt: number;
  /** 上一次落地一个决定（开始做一件事）的时刻：刚做的这几秒小事不打断他 */
  lastDecidedAt: number;
  /** 待处理的标记（大事 / 小事），问出去就清掉 */
  markLevel: MarkLevel;
  /** 决策档（离玩家多远；带回差） */
  tier: DecisionTier;
  /** 在"停"一档时街上出过大事、没问他：拉近了要补问 */
  missedMajor: boolean;
  /** 档位定过没有（第一次定档不算"拉近"，不补问） */
  tierKnown: boolean;
  /** 被别的气泡挡住、等着冒的那句 */
  queued: { text: string; category: string; until: number; reply: boolean } | null;
  /** 最近一次被标记"该重问"时的全局序号 */
  markSeq: number;
  /** 逐项是非：上一次"要不要放下手上的事"比平静时涨了多少（调试牌） */
  lastGate: number | null;
  /** 上一次被别人的吓人动静惊动（人传人）的时刻 */
  lastContagionAt: number;
  /** 最近几次决定（详情面板），新的在后 */
  history: WorldBrainDecisionRecord[];
  /** 最近一发问他的请求与回包（详情面板） */
  lastAsk: { at: number; state: unknown; questions: Record<string, JevQuestion>; answers: Map<string, JevAnswer> | null } | null;
  /** 跟关二狗说过的话（"谁：说了啥"，旧的在前）：搭话时整段进 state */
  dialogue: string[];
}

const HISTORY_MAX = 12;
/** 一个人跟关二狗的话最多记多少句（再多就是很久以前的了；进 state 时还要按模型容量裁） */
const DIALOGUE_MAX = 30;
/** 关二狗最近干的事最多记几件 */
const PLAYER_RECENT_MAX = 8;
/** 新事还没判显著度时，常规决策最多让它几秒（游戏钟；显著度题一般几十毫秒就回） */
const SALIENCE_WAIT_SEC = 1.5;
/** 被别人的吓人动静惊动过的人，这么多秒内不再被"人传人"惊动（防甲乙互相惊动、全街永远重想） */
const CONTAGION_COOLDOWN_SEC = 20;
const LAYER_NAME: Record<CallLayer, string> = {
  reply: '回话', event: '出事 / 小事', catchup: '拉近补问', routine: '日常', background: '背景巡检', salience: '显著度', baseline: '基线',
};

/** 牌子上的"约合人民币"用的汇率（只是给人估个数） */
export const USD_TO_CNY = 7.1;
/** 按最近多少秒的节奏估每小时花费 */
const RATE_WINDOW_SEC = 300;

const ME = '世界脑';

export class WorldBrainSystem {
  private enabled = false;
  private sceneId = '';
  private config: ResolvedWorldBrainConfig | null = null;
  private configErrors: string[] = [];
  private configWarnings: string[] = [];
  private loadingScene: string | null = null;
  /** 场景代：换场景 / 读档 / 实体重建 +1，旧场景的回包与交还一律作废 */
  private sceneGen = 0;
  /** 请求代：关开关 / 换场景 +1，旧回包作废 */
  private reqGen = 0;
  /** 这一代请求共用的撤单信号（dropRequests 时 abort，包通道随之撤单） */
  private reqAbort = new AbortController();
  private readonly actors = new Map<string, ActorEntry>();
  // 街上每个人的动作、说的话也记成事：缓冲放大（90 秒窗口里玩家与世界的事不能被挤掉）
  private readonly perception = new WorldPerception(160);
  private readonly motion = new PlayerMotionSampler();
  private clock = 0;
  private wasExploring = false;
  private sceneDirty = false;

  /** 排队等发的活（按 PRIORITY、离玩家远近、先来后到） */
  private readonly queue: Job[] = [];
  /** 在途的：发出时刻（看门狗用）；回包落地时按 seq 认领，被看门狗放行的旧回包作废 */
  private readonly inFlightJobs = new Map<number, { job: Job; since: number }>();
  private jobSeq = 0;
  private backoffUntil = 0;
  /** 最近一件大事的时刻（拉近补问看这个）、上一次背景巡检的时刻 */
  private lastMajorAt = -1e9;
  private lastBackgroundAt = -1e9;
  /** 最近一分钟每一发是哪一层问的（状态牌看分层的调用频率） */
  private readonly callLog: { wall: number; layer: CallLayer }[] = [];
  /** 逐项是非的对照（见 BaseRef）：回来的值 / 还在问的键；这一发落地后删掉它那几条 */
  private readonly baseValues = new Map<string, number>();
  private readonly baselinePending = new Set<string>();
  private consecutiveErrors = 0;
  private readonly requestTimes: number[] = [];
  private readonly pending: PendingResult[] = [];

  private status: WorldBrainStatus = 'off';
  private statusText = '关着';
  private requests = 0;
  private inputTokens = 0;
  private cost = 0;
  private costEstimated = false;
  /** 每发请求的花费记录（真实毫秒钟），估"一小时大约花多少" */
  private readonly costLog: { wall: number; usd: number; tokens: number }[] = [];
  /** 这次打开开关的真实时刻（估节奏时窗口不超过开着的时长） */
  private enabledAtWall = 0;
  private lastLatencyMs: number | null = null;
  private latencySum = 0;
  private latencyCount = 0;
  private lastError: string | null = null;
  private jevStatus: JevStatus | null = null;
  /** 最近一发的请求与回包（调试：看它到底被问了啥、回了啥） */
  private lastExchange: { who: string; request: { state: unknown; questions: unknown }; response: unknown; latencyMs: number } | null = null;
  private servedModel: string | null = null;
  private serverLatencyMs: number | null = null;
  private stateTokens: number | null = null;
  private readonly recentWarnings: string[] = [];
  private warningCount = 0;
  private readonly warnedOnce = new Set<string>();

  /** 自己冒过气泡、还没收：只有这时才去收（关着时连"收气泡"都不做） */
  private bubblesUp = false;
  /** 关掉后还在走回原位的人数 */
  private returning = 0;

  /** 游戏里切的：走哪一路决策服务（null = .env.local 的缺省）、问法（null = 配置里的） */
  private backend: JevBackend | null = null;
  private modeOverride: DecisionMode | null = null;
  /** 详情面板正在看谁 */
  private inspectTarget: string | null = null;
  /** 按 E 搭话时自动切详情（缺省关：搭一句话就弹面板挡着玩） */
  private inspectOnInteractFlag = false;
  /** 发道具的职责里道具表没有的那几样（只警告一次） */
  private readonly warnedItems = new Set<string>();
  private readonly warnedSounds = new Set<string>();

  /** 旁听动作执行器 / 粒子系统 / 玩家状态串的退订；第一次打开开关时才挂（从没开过 = 什么都没挂） */
  private tapUnsubs: (() => void)[] | null = null;
  private lastRunPastAt = -1e9;
  /** "该重问"的全局标记序号（见 PendingResult.markSeqAtSend） */
  private markSeq = 0;

  private readonly listeners: [string, (p?: any) => void][] = [];
  private destroyed = false;

  constructor(private readonly deps: WorldBrainDeps) {
    const on = (ev: string, fn: (p?: any) => void) => {
      deps.eventBus.on(ev, fn);
      this.listeners.push([ev, fn]);
    };
    on('scene:beforeUnload', () => this.dropScene());
    on('save:restoring', () => this.dropScene());
    on('scene:entitiesRebuilt', () => { this.sceneDirty = true; });
    on('scene:ready', () => { this.sceneDirty = true; });
    // 玩家干的事一律走玩家状态串（setEnabled 里订），这里只接世界里的事
    on('burn:changed', (p) => this.onBurn(p));
    on('player:damaged', () => this.onPlayerDamaged());
    // 对没配对话的街坊按 E：原本什么都不发生；世界脑开着时当成"关二狗在跟他搭话"
    on('npc:interact', (p) => this.onNpcInteract(p));
    on('time:phaseChanged', (p) => this.onPhase(p));
  }

  // ───────────────────────── 开关（唯一一对入口） ─────────────────────────

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (this.destroyed || on === this.enabled) return;
    this.enabled = on;
    if (on) {
      if (!this.tapUnsubs) {
        this.tapUnsubs = [
          this.deps.addActionListener((type, params, ctx) => this.onAction(type, params, ctx?.run ?? null)),
          this.deps.addRunEndListener((end) => this.onRunEnd(end.run)),
          this.deps.addVfxListener((kind, effectId, anchor, runId) => this.onVfx(kind, effectId, anchor, runId ?? null)),
          this.deps.playerActivity.onActivity((a) => this.onPlayerActivity(a)),
        ];
      }
      this.consecutiveErrors = 0;
      this.backoffUntil = 0;
      this.lastError = null;
      this.enabledAtWall = this.deps.wallMs();
      this.costLog.length = 0;
      void this.refreshJevStatus();
      this.sceneDirty = true; // 下一帧按当前场景装配置
      this.setStatus('loading', '正在读本场景的世界脑配置');
    } else {
      this.dropRequests();
      // 包通道：推送通道关掉（在途的已随 dropRequests 撤单）
      this.deps.transport.close?.();
      this.clearOwnBubbles();
      for (const e of this.actors.values()) this.resetTalk(e);
      this.handBackAll();
    }
  }

  /**
   * 排队的、在途的、落了还没处理的一律作废（旧回包按 reqGen 认不出来，自然丢掉）；
   * 在途的同时**撤单**（这一代的请求共用一个 signal，一 abort 全撤，Hub 那边不再替没人要的题算）。
   */
  private dropRequests(): void {
    this.reqAbort.abort();
    this.reqAbort = new AbortController();
    this.reqGen++;
    this.queue.length = 0;
    this.inFlightJobs.clear();
    this.pending.length = 0;
    this.baseValues.clear();
    this.baselinePending.clear();
    for (const e of this.actors.values()) {
      e.jobQueued = false;
      e.jobInFlight = false;
      e.replyInFlight = false;
    }
  }

  /** 搭话 / 排队的话一并作废（关开关、换场景） */
  private resetTalk(e: ActorEntry): void {
    e.replyWanted = null;
    e.replyInFlight = false;
    e.queued = null;
  }

  private clearOwnBubbles(): void {
    if (!this.bubblesUp) return;
    this.bubblesUp = false;
    this.deps.clearBubbles();
    // 气泡收了，牌子上也不再显示那句（牌子上有的，画面上一定有）
    for (const e of this.actors.values()) {
      if (e.actor.lastSay && e.actor.lastSay.until > this.clock) e.actor.lastSay.until = this.clock;
    }
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  /** 调试：全街立刻重问一遍 */
  forceReplanAll(): void {
    this.markAll('调试：全街重算', 'major');
  }

  /**
   * 游戏里切换决策服务（对比 Laya / Jev）。在途的一律作废（别拿旧那一路的答案落地）、基线清掉
   * （是按模型标定的），全街按日常重想一遍——切过去马上看得到差别。null = 回到 .env.local 的缺省。
   */
  setBackend(b: JevBackend | null): void {
    if (b === this.backend) return;
    this.backend = b;
    this.deps.transport.setBackend?.(b);
    this.jevStatus = null;
    this.servedModel = null;
    this.lastError = null;
    this.consecutiveErrors = 0;
    this.backoffUntil = 0;
    void this.refreshJevStatus();
    this.dropRequests();
    this.replanAllRoutine(`换成 ${b ? backendName(b) : '缺省那一路'}`);
  }

  get currentBackend(): JevBackend | null {
    return this.backend;
  }

  /** 游戏里切换问法（逐项是非 / 选择题 / 自动）；null = 回到配置里的。全街按日常重想一遍 */
  setDecisionMode(m: DecisionMode | null): void {
    if (m === this.modeOverride) return;
    this.modeOverride = m;
    this.dropRequests();
    this.replanAllRoutine('换了问法');
  }

  get decisionModeSetting(): DecisionMode {
    return this.modeOverride ?? this.config?.tuning.decisionMode ?? 'auto';
  }

  /** 全街当成"手上的事做完了"：各档照日常间隔马上重想（刚问过的也不等） */
  private replanAllRoutine(reason: string): void {
    for (const e of this.actors.values()) {
      if (e.actor.away) continue;
      e.lastAskedAt = -1e9;
      this.markOne(e, reason, 'routine');
    }
  }

  /** 详情面板看谁（开了「按 E 开详情」时按 E 跟他说话会自动切过去；null = 收起） */
  setInspectTarget(npcId: string | null): void {
    this.inspectTarget = npcId && this.actors.has(npcId) ? npcId : null;
  }

  get inspectTargetId(): string | null {
    return this.inspectTarget;
  }

  /** 按 E 搭话时要不要自动打开这个人的详情；关掉不收起已经开着的面板 */
  setInspectOnInteract(on: boolean): void {
    this.inspectOnInteractFlag = on;
  }

  get inspectOnInteract(): boolean {
    return this.inspectOnInteractFlag;
  }

  /** 场上归世界脑管的人（名字牌用）：称呼 + 在不在街上 */
  listPeople(): { npcId: string; label: string; away: boolean; takenOver: boolean }[] {
    return [...this.actors.values()].map((e) => ({
      npcId: e.actor.npcId, label: e.actor.person.label, away: e.actor.away, takenOver: e.takenOver,
    }));
  }

  async refreshJevStatus(): Promise<JevStatus> {
    const st = await this.deps.transport.status();
    this.jevStatus = st;
    return st;
  }

  /** 最近一发的请求（调试：看它到底被问了啥） */
  getLastRequest(): { state: unknown; questions: unknown } | null {
    return this.lastExchange?.request ?? null;
  }

  /** 最近一发的请求 + 回包 + 往返耗时（调试） */
  getLastExchange(): { who: string; request: { state: unknown; questions: unknown }; response: unknown; latencyMs: number } | null {
    return this.lastExchange;
  }

  // ───────────────────────── 每帧 ─────────────────────────

  update(dt: number): void {
    if (this.destroyed) return;
    const exploring = this.deps.isExploring();
    if (this.wasExploring && !exploring) this.clearOwnBubbles();
    this.wasExploring = exploring;

    const sid = this.deps.currentSceneId();
    if (sid !== this.sceneId) {
      this.dropScene();
      this.sceneId = sid;
      this.sceneDirty = true;
    }
    // 关着时不理会场景重建：正在走回原位的人按 id 现取 NPC，接着走；再打开时重新装配
    if (this.sceneDirty && exploring && this.enabled) {
      this.sceneDirty = false;
      if (this.config && this.config.sceneId === sid) this.resetActorsForRebuild();
      else void this.loadSceneConfig(sid);
    }
    if (!this.enabled || !this.config || !exploring || this.deps.isWorldPaused()) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.clock += dt;
    const now = this.clock;

    this.applyPending(now);
    this.pollWorld(dt, now);
    const world = this.world();
    for (const e of this.actors.values()) {
      if (!e.takenOver) continue;
      e.actor.update(now, world);
    }
    this.flushQueuedLines(now);
    this.schedule(now);
    this.refreshStatus();
  }

  // ───────────────────────── 场景 ─────────────────────────

  private async loadSceneConfig(sceneId: string): Promise<void> {
    if (this.loadingScene === sceneId && this.config?.sceneId !== sceneId) return;
    this.loadingScene = sceneId;
    const gen = this.sceneGen;
    this.setStatus('loading', '正在读本场景的世界脑配置');
    let raw: unknown | null = null;
    try {
      raw = await this.deps.loadConfig(sceneId);
    } catch (e) {
      console.warn(`${ME}: 读配置失败`, e);
    }
    if (gen !== this.sceneGen || this.destroyed) return;
    this.loadingScene = null;
    if (raw === null || raw === undefined) {
      this.config = null;
      this.configErrors = [];
      this.configWarnings = [];
      this.setStatus('no_config', `场景「${sceneId}」没有世界脑配置，这里不起作用`);
      return;
    }
    const parsed = parseWorldBrainConfig(raw, sceneId);
    this.configErrors = parsed.errors;
    this.configWarnings = parsed.warnings;
    for (const w of parsed.warnings) console.warn(`${ME} 配置警告：${w}`);
    if (!parsed.config) {
      for (const e of parsed.errors) console.error(`${ME} 配置错误：${e}`);
      this.config = null;
      this.setStatus('error', `配置有错，本场景不启用：${parsed.errors[0] ?? ''}`);
      return;
    }
    this.config = parsed.config;
    // 包通道的设计值（在途包数、熔断、探针）跟本场景的 tuning 走
    const t = parsed.config.tuning;
    this.deps.transport.configure?.({
      maxPacksInFlight: t.maxPacksInFlight,
      breaker: { window: t.breakerWindow, minSamples: t.breakerMinSamples, probeIntervalMs: t.breakerProbeSec * 1000 },
      probeExpireMs: t.probeExpireMs,
    });
    this.buildActors();
    this.perception.clear();
    this.motion.reset();
    // 背景巡检从现在起算（不在第一帧就去问远处的人）
    this.lastBackgroundAt = this.clock;
    // 开关刚开：谁都还没拿过决定——近中远照日常间隔问（从没问过，马上就到），停一档的照旧走默认逻辑
    this.markAll('开关刚打开', 'routine');
    this.setStatus('idle', '准备好了');
  }

  private buildActors(): void {
    const cfg = this.config;
    if (!cfg) return;
    this.actors.clear();
    for (const person of cfg.people) {
      const authored = this.deps.npcAuthored(person.npcId);
      if (!authored) {
        console.warn(`${ME}: 场上没有 NPC "${person.npcId}"（${person.label}），跳过`);
        continue;
      }
      const actor = new StreetActor(person, () => this.deps.getNpc(person.npcId), authored.x, authored.y, authored.hasPatrol);
      this.actors.set(person.npcId, {
        actor, takenOver: false, playerNear: false, lastNearEventAt: -1e9, lastStillEventAt: -1e9,
        replyWanted: null, replySentAt: -1e9, replyInFlight: false, jobQueued: false, jobInFlight: false,
        lastAskedAt: -1e9, lastDecidedAt: -1e9, markLevel: 'none', tier: 'frozen', missedMajor: false,
        tierKnown: false, queued: null, markSeq: 0, lastGate: null, lastContagionAt: -1e9, history: [], lastAsk: null,
        dialogue: [],
      });
    }
  }

  /** 换场景 / 读档：旧场景的一切作废，不碰 NPC（它们正被销毁） */
  private dropScene(): void {
    this.sceneGen++;
    this.dropRequests();
    for (const e of this.actors.values()) e.actor.forget();
    this.actors.clear();
    this.config = null;
    this.inspectTarget = null;
    this.loadingScene = null;
    this.perception.clear();
    this.motion.reset();
    this.clearOwnBubbles();
    this.returning = 0;
    if (this.enabled) this.setStatus('loading', '换场景了');
    else if (this.status === 'returning') this.setStatus('off', '关着');
  }

  /**
   * 同一场景里实体重建了（时段换装）/ 重新 ready：旧 NPC 对象没了，actor 里记的在途位移全失效。
   * 已经装好配置的话重建 actor（新 NPC 的巡逻由场景重启，接管重新懒触发）。
   */
  private resetActorsForRebuild(): void {
    if (!this.config) return;
    this.sceneGen++;
    this.dropRequests();
    for (const e of this.actors.values()) e.actor.forget();
    this.buildActors();
    this.markAll('场上的人重新摆过', 'routine');
  }

  // ───────────────────────── 交还 ─────────────────────────

  private handBackAll(): void {
    const cfg = this.config;
    if (!cfg) {
      this.setStatus('off', '关着');
      return;
    }
    const gen = this.sceneGen;
    const world = this.world();
    for (const e of this.actors.values()) {
      if (!e.takenOver) continue;
      e.takenOver = false;
      this.returning++;
      const id = e.actor.npcId;
      void e.actor.handBack(world).then(() => {
        if (gen !== this.sceneGen) return;
        // 走回原位了：还关着，才按原样重启巡逻
        if (!this.enabled && e.actor.hadPatrol) this.deps.startNpcPatrol(id);
        this.returning = Math.max(0, this.returning - 1);
        if (!this.enabled) {
          this.setStatus(this.returning ? 'returning' : 'off', this.returning ? `关了，${this.returning} 个人正走回原位` : '关着');
        }
      });
    }
    this.setStatus(this.returning ? 'returning' : 'off', this.returning ? `关了，${this.returning} 个人正走回原位` : '关着');
  }

  // ───────────────────────── 感知 ─────────────────────────

  private placeName(x: number, y: number): string {
    const p = this.config?.graph.nearest(x, y);
    return p ? p.name : '街上';
  }

  /**
   * 记一件事。`spectacle` = 能当"看热闹 / 朝那边望 / 往反方向跑"的目标（关于玩家本人的零碎事不算）。
   * 返回 false = 与刚才同一件事合并掉了（调用方就别再重问一遍）。
   */
  private note(
    text: string,
    source: string,
    opts: {
      at?: { x: number; y: number };
      spectacle?: boolean;
      lazyText?: () => string;
      gist?: string;
      lazyGist?: () => string;
      byPlayer?: boolean;
      run?: WorldRunInfo | null;
    } = {},
  ): boolean {
    const run = opts.run ?? null;
    return this.perception.note({
      at: this.clock, text, lazyText: opts.lazyText, salience: null, spectacle: opts.spectacle === true,
      source, x: opts.at?.x, y: opts.at?.y,
      place: opts.at ? this.placeName(opts.at.x, opts.at.y) : undefined,
      gist: opts.gist, lazyGist: opts.lazyGist,
      // 谁起的头以引擎给的发起方为准；没有串（燃烧、时辰这类）再看描述自己说的
      byPlayer: opts.byPlayer === true || isPlayerInitiated(run),
      ...(run ? { runId: run.id, initiator: { kind: run.initiator.kind, ...(run.initiator.id ? { id: run.initiator.id } : {}) } } : {}),
    });
  }

  /** 世界里发生的事（不是玩家本人的零碎事）：看得见的人立刻重问；全街都感觉得到的就全街重问 */
  private noteWorld(
    text: string,
    source: string,
    at: { x: number; y: number } | undefined,
    global: boolean,
    extra: {
      lazyText?: () => string; gist?: string; lazyGist?: () => string; byPlayer?: boolean; run?: WorldRunInfo | null;
    } = {},
  ): void {
    if (!this.note(text, source, { at, spectacle: true, ...extra })) return;
    this.lastMajorAt = this.clock;
    if (global || !at) this.markAll(source, 'major');
    else this.markNear(at, this.config!.tuning.sightRange, source, 'major');
  }

  private senseHelpers(): SenseHelpers {
    return {
      entityName: (id) => this.actors.get(id)?.actor.person.label ?? this.deps.entityName(id),
      entityPos: (id) => this.deps.entityPos(id),
      isOwnActor: (id) => this.actors.has(id),
      playerLabel: this.config?.player.label ?? '玩家',
      soundWord: (id) => {
        const w = this.config?.soundWords[id] ?? null;
        // 事件说法表里缺这个音效：开发期响一次（缺了模型只听到"一阵响动"）
        if (!w && !this.warnedSounds.has(id)) {
          this.warnedSounds.add(id);
          console.warn(`${ME}: 音效 "${id}" 在世界脑数据的 soundWords 里没有说法，街上的人只听到"一阵响动"`);
        }
        return w;
      },
    };
  }

  /**
   * 旁听动作执行器：任何来源（技能 / 道具 / 过场 / 叙事 / 区域）的通用动作，按动作类型描述。
   * 记下它属于哪一串、谁起的头（粒子效果按串 id 认回来，同一串的事就是一簇）。
   */
  private onAction(type: string, params: Record<string, unknown>, run: WorldRunInfo | null): void {
    if (!this.enabled || !this.config) return;
    if (run) this.rememberRun(run);
    const s = describeAction(type, params, this.senseHelpers());
    if (!s) return;
    const at = s.at;
    const text = at && !s.global ? `${this.placeName(at.x, at.y)}那边，${s.text}` : s.text;
    this.noteWorld(text, `动作:${type}`, at, s.global, { gist: s.gist, byPlayer: s.byPlayer, run });
  }

  /** 最近见过的串（粒子效果只带串 id，发起方从这里认回来）；串结束就摘掉 */
  private readonly liveRuns = new Map<number, WorldRunInfo>();

  private rememberRun(run: WorldRunInfo): void {
    if (this.liveRuns.has(run.id)) return;
    this.liveRuns.set(run.id, run);
    // 兜底：极少数串永远不结束（作者写了永远等下去的动作）时别无限长
    if (this.liveRuns.size > 256) this.liveRuns.delete(this.liveRuns.keys().next().value as number);
  }

  /** 引擎说这一串结束了：这一簇平息（事平息不靠时间窗口去猜） */
  private onRunEnd(run: WorldRunInfo): void {
    this.liveRuns.delete(run.id);
    if (!this.enabled || !this.config) return;
    this.perception.settleRun(run.id, this.clock);
  }

  /** 旁听粒子系统：世界里冒出 / 收掉一个效果（代码里直接放的雷、火也在内），用效果自带的 label 描述 */
  private onVfx(kind: 'start' | 'stop', effectId: string, anchor: { x: number; y: number } | null, runId: number | null): void {
    if (!this.enabled || !this.config) return;
    const run = runId !== null ? (this.liveRuns.get(runId) ?? { id: runId, initiator: { kind: 'unknown' } }) : null;
    const at = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? { x: anchor.x, y: anchor.y } : undefined;
    const where = at ? this.placeName(at.x, at.y) : null;
    // 一闪而过的效果（一道雷的贴图、一次性的火星）刚冒出来就收：不报"散了"——那是噪声，不是街上发生了啥
    if (kind === 'stop') {
      const started = this.vfxStartedAt.get(effectId);
      if (started !== undefined && this.clock - started < this.config.tuning.vfxBlinkSec) return;
    } else {
      this.vfxStartedAt.set(effectId, this.clock);
    }
    // label 可能还在加载：说法现取（到出题时多半已经加载好了）。没有中文 label 就说"一样看不清的东西"，
    // 不把英文素材名塞给模型
    const spoken = () => spokenEffectName(this.deps.vfxLabel(effectId)) ?? '一样看不清的东西';
    const lazy = () => describeVfx(kind, spoken(), where);
    // 合并键用 id：同一个效果连放几次（连劈的雷换着贴图）算一件
    const key = describeVfx(kind, effectName(null, effectId), where);
    // 收掉的效果没啥好摆的（"雷云散了"）；冒出来的用它自己的名字当短名
    const lazyGist = kind === 'start' ? () => shortGist(spokenEffectName(this.deps.vfxLabel(effectId))) : undefined;
    this.noteWorld(key, `效果:${effectId}`, at, !at, { lazyText: lazy, lazyGist, run });
  }

  /** 效果最近一次冒出来的时刻（判"一闪而过"用） */
  private readonly vfxStartedAt = new Map<string, number>();

  /**
   * 玩家干了任何事（玩家状态串报来的一句话）：**一律同一种处理**，不按动作分 case——
   * 先记成一件事、惊动跟前的人（小事）；冲着谁的，那个人自己也惊动；决策服务判成吓人的，
   * 再惊动看得见的所有人（见 WorldBrainEvent.escalate，落在显著度回包里）。
   */
  private onPlayerActivity(a: PlayerActivityEntry): void {
    if (!this.enabled || !this.config) return;
    const cfg = this.config;
    const text = `${cfg.player.label}在${this.placeName(a.at.x, a.at.y)}${a.text}`;
    const noted = this.perception.note({
      at: this.clock, text, salience: null, spectacle: true, source: `玩家:${a.source}`,
      x: a.at.x, y: a.at.y, place: this.placeName(a.at.x, a.at.y),
      gist: a.gist ? shortGist(a.gist) : undefined, byPlayer: true, escalate: true,
    });
    if (!noted) return;
    // 关二狗先前干的事（每道题的 state 里都带着：他是个啥样子的人，看他干过啥）
    this.playerRecent.push({ at: this.clock, text: `在${this.placeName(a.at.x, a.at.y)}${a.text}` });
    while (this.playerRecent.length > PLAYER_RECENT_MAX) this.playerRecent.shift();
    const reason = `${cfg.player.label}${a.text}`;
    this.markNear(a.at, cfg.tuning.nearRange * 2, reason, 'minor');
    const target = a.target ? this.actors.get(a.target) : undefined;
    if (target && !target.actor.away) this.markOne(target, reason, 'minor');
  }

  private onBurn(p: unknown): void {
    if (!this.enabled || !this.config) return;
    const o = (p ?? {}) as { to?: unknown; target?: unknown };
    const target = typeof o.target === 'string' ? o.target : '';
    const name = (target && this.deps.entityName(target)) || '有样东西';
    const text = describeBurn(String(o.to ?? ''), name);
    if (!text) return;
    const pos = target ? this.deps.entityPos(target) : null;
    const where = pos ? `${this.placeName(pos.x, pos.y)}那边，` : '';
    this.noteWorld(`${where}${text}`, '燃烧', pos ?? undefined, !pos, { gist: o.to === 'out' ? undefined : '火' });
  }

  private onPlayerDamaged(): void {
    if (!this.enabled || !this.config) return;
    const pos = this.deps.playerPos();
    this.noteWorld(`${this.config.player.label}像是遭啥子东西冲到了，脸色煞白`, '受伤', pos, false);
  }

  private onNpcInteract(p: unknown): void {
    if (!this.enabled || !this.config) return;
    const id = String((p as { npc?: { def?: { id?: unknown } } } | undefined)?.npc?.def?.id ?? '');
    const e = this.actors.get(id);
    if (!e || e.actor.away) return;
    const pos = this.deps.playerPos();
    // "关二狗找他说话"这件事由玩家状态串报（同一帧）；这里只管回话与详情面板
    // 先转过来（不等网络），怎么回走单独的回话通道：不排在常规决策后头
    e.actor.faceToward(pos.x, pos.y);
    e.actor.lastReason = '玩家搭话';
    this.noteDialogue(e, `${this.config.player.label}：（走到跟前找他说话${this.holdingText() ? `，手上拿着${this.holdingText()}` : ''}）`);
    if (!e.replyInFlight) e.replyWanted = this.clock;
    if (this.inspectOnInteractFlag) this.inspectTarget = id;
  }

  private onPhase(p: unknown): void {
    if (!this.enabled || !this.config) return;
    const to = String((p as { to?: unknown } | undefined)?.to ?? '');
    this.note(`天色变了，到${to || '另一个时辰'}了`, '时辰');
    this.markAll('换时辰', 'routine');
  }

  private holdingText(): string | null {
    return this.deps.playerActivity.now().holding;
  }

  /** 关二狗最近干的几件事（"多久以前：在哪干了啥"），旧的在前 */
  private readonly playerRecent: { at: number; text: string }[] = [];

  private noteDialogue(e: ActorEntry, line: string): void {
    e.dialogue.push(line);
    if (e.dialogue.length > DIALOGUE_MAX) e.dialogue.splice(0, e.dialogue.length - DIALOGUE_MAX);
  }

  /**
   * 世界此刻的样子写成话：天色（压暗了多少）、风（比平常大多少）、此刻看得到的效果（雨、烟、火光……）。
   * 引擎只报数，怎么说是设计值（`tuning` 里的 darkWordDim / nightWordDim / gustWordRatio）。
   */
  private weatherText(): string | null {
    const look = this.deps.worldLook();
    const t = this.config!.tuning;
    const parts: string[] = [];
    if (look.dim <= t.nightWordDim) parts.push('天色黑得跟半夜一样');
    else if (look.dim <= t.darkWordDim) parts.push('天色压暗下来了');
    if (look.wind && look.wind.base > 0) {
      parts.push(look.wind.speed >= look.wind.base * t.gustWordRatio ? '刮起了大风' : '有点风');
    }
    // 只说有中文名的（没名字的说不出是啥，不如不说；也不把英文素材名塞给模型）
    const seen = [...new Set(look.effects
      .map((id) => spokenEffectName(this.deps.vfxLabel(id)))
      .filter((n): n is string => !!n)
      .map((n) => shortGist(n)))];
    if (seen.length) parts.push(`看得到：${seen.join('、')}`);
    return parts.length ? parts.join('，') : null;
  }

  /**
   * 调试 / 体检台：此刻街上每个人的**全量**快照（他问决策时 state 就从这里拼）。
   * 心头、看法、记得的事是第二版才有的，这里先空着；体检台在夹具里按场面补上。
   */
  captureSnapshots(): StateSnapshot[] {
    if (!this.config) return [];
    const cfg = this.config;
    const now = this.clock;
    const pos = this.deps.playerPos();
    const out: StateSnapshot[] = [];
    for (const snap of this.snapshotPeople(now)) {
      const e = this.actors.get(snap.person.npcId);
      const n = this.deps.getNpc(snap.person.npcId);
      if (!e || !n || e.actor.away) continue;
      out.push(personSnapshot(this.stateInputFor(snap, n, now, pos, e)));
    }
    return out;
  }

  /** 拼一个人 state 的输入（决策和体检台共用） */
  private stateInputFor(
    snap: PersonSnapshot, n: { x: number; y: number }, now: number, pos: { x: number; y: number }, e: ActorEntry,
  ): Parameters<typeof buildPersonState>[0] {
    const cfg = this.config!;
    return {
      config: cfg,
      now,
      timeOfDay: this.deps.timeOfDay(),
      weather: this.weatherText(),
      player: {
        where: `${this.placeName(pos.x, pos.y)}附近`,
        x: pos.x,
        y: pos.y,
        gait: this.motion.gait,
        stillFor: this.motion.stillFor,
        posture: this.postureText(),
        holding: this.holdingText(),
        recent: this.playerRecent.map((r) => `${describeAgo(now - r.at)}：${r.text}`),
      },
      events: this.eventsFor(n.x, n.y, now, snap.person.npcId),
      person: snap,
      dialogue: [...e.dialogue],
      budget: cfg.tuning.stateTokenBudget,
    };
  }

  /**
   * 每帧轮询没有事件的那几样：玩家的步态 / 走近谁 / 在谁旁边杵着（这几样是玩家跟某个人的相对位置，
   * 不是玩家"干了什么"；玩家干的事走玩家状态串，天色、风、雨走旁听，都不轮询）
   */
  private pollWorld(dt: number, now: number): void {
    const cfg = this.config!;
    const pos = this.deps.playerPos();
    this.motion.update(dt, pos.x, pos.y, this.deps.isRunHeld());

    // 从人旁边跑过去
    if (this.motion.gait === 'running' && now - this.lastRunPastAt > 10) {
      const near = this.labelsNear(pos, cfg.tuning.runPastRange);
      if (near.length) {
        this.lastRunPastAt = now;
        this.note(`${cfg.player.label}从${near.slice(0, 3).join('、')}旁边跑过去`, '跑过', { at: pos });
        this.markNear(pos, cfg.tuning.runPastRange, '玩家跑过');
      }
    }
    // 走到某人跟前 / 在某人旁边站半天
    for (const e of this.actors.values()) {
      if (e.actor.away) continue;
      const n = this.deps.getNpc(e.actor.npcId);
      if (!n) continue;
      const d = Math.hypot(n.x - pos.x, n.y - pos.y);
      const near = d < 140;
      if (near && !e.playerNear && now - e.lastNearEventAt > 8) {
        e.lastNearEventAt = now;
        this.note(`${cfg.player.label}走到${e.actor.person.label}跟前`, '走近', { at: pos });
        this.markOne(e, '玩家走近');
      }
      if (near && this.motion.stillFor > 6 && now - e.lastStillEventAt > 20) {
        e.lastStillEventAt = now;
        this.note(`${cfg.player.label}站在${e.actor.person.label}旁边半天不走`, '杵着', { at: pos });
        this.markOne(e, '玩家杵着');
      }
      e.playerNear = near;
    }
  }

  private labelsNear(pos: { x: number; y: number }, r: number): string[] {
    const out: string[] = [];
    for (const e of this.actors.values()) {
      if (e.actor.away) continue;
      const n = this.deps.getNpc(e.actor.npcId);
      if (n && Math.hypot(n.x - pos.x, n.y - pos.y) < r) out.push(e.actor.person.label);
    }
    return out;
  }

  /**
   * 标记"该重想了"。三级：
   * - `major` 大事（世界里出了事：天黑、炸雷、起火、有人喊……）：近 / 中立刻问、远隔一阵问、停一档记着等拉近补问
   * - `minor` 小事（玩家走近、杵着、跑过、换姿势、手上换东西）：只有近处的人问，刚做完决定的几秒内不问
   * - `routine` 日常（开关刚开、换时辰、实体重摆）：不算打断，按各档的日常间隔问
   * 标记只记下来，问不问、什么时候问，由 {@link enqueueDue} 按这个人此刻的档位定。
   */
  private markOne(e: ActorEntry, reason: string, level: MarkLevel = 'minor'): void {
    e.actor.lastReason = reason;
    if (level === 'routine') e.actor.needsDecision = true;
    else if (MARK_RANK[level] > MARK_RANK[e.markLevel]) e.markLevel = level;
    e.markSeq = ++this.markSeq;
  }

  private markAll(reason: string, level: MarkLevel): void {
    for (const e of this.actors.values()) {
      if (e.actor.away) continue;
      this.markOne(e, reason, level);
    }
  }

  /**
   * 别人干的吓人事惊动看得见的人（人传人）。**一个人被"人传人"惊动过，{@link CONTAGION_COOLDOWN_SEC} 秒内
   * 不再被别人的动静惊动**：不然甲跑惊动乙、乙跑又惊动甲，全街永远在重想（世界里的事、玩家干的事不受限）。
   */
  private markContagion(ev: WorldBrainEvent & { x: number; y: number; actor: string }): void {
    const cfg = this.config!;
    const now = this.clock;
    for (const e of this.actors.values()) {
      if (e.actor.away || e.actor.npcId === ev.actor) continue;
      if (now - e.lastContagionAt < CONTAGION_COOLDOWN_SEC) continue;
      const n = this.deps.getNpc(e.actor.npcId);
      if (!n || Math.hypot(n.x - ev.x, n.y - ev.y) >= cfg.tuning.sightRange) continue;
      e.lastContagionAt = now;
      this.markOne(e, eventText(ev), 'major');
    }
  }

  private markNear(pos: { x: number; y: number }, r: number, reason: string, level: MarkLevel = 'minor'): void {
    for (const e of this.actors.values()) {
      if (e.actor.away) continue;
      const n = this.deps.getNpc(e.actor.npcId);
      if (n && Math.hypot(n.x - pos.x, n.y - pos.y) < r) this.markOne(e, reason, level);
    }
  }

  // ───────────────────────── 请求 ─────────────────────────

  /** 逐项是非还是选择题（见 DecisionMode）；`auto` 在还不知道连的是谁时返回 null */
  private perOptionMode(): boolean | null {
    const m = this.modeOverride ?? this.config?.tuning.decisionMode ?? 'auto';
    if (m !== 'auto') return m === 'perOption';
    if (!this.jevStatus) return null;
    return this.jevStatus.provider === 'laya';
  }

  /** 这一帧：把该问的排进队，再按次序发到在途上限 */
  private schedule(now: number): void {
    const cfg = this.config!;
    const wall = this.deps.wallMs();
    // `auto` 要先知道连的是 Laya 还是 Jev 才知道怎么问（状态一般几毫秒就回来）
    if (this.perOptionMode() === null) return;
    // 看门狗：请求永不 settle 会让队列静默停摆——超时之外再兜一道（被放行的旧回包按 seq 认不出来，丢掉）
    const stuck = cfg.tuning.requestTimeoutMs + 5000;
    for (const [seq, f] of this.inFlightJobs) {
      if (wall - f.since <= stuck) continue;
      this.inFlightJobs.delete(seq);
      this.releaseJob(f.job);
      // 这一发的对照也不要了
      for (const k of [...this.baseValues.keys(), ...this.baselinePending]) {
        if (!k.startsWith(`${seq}|`)) continue;
        this.baseValues.delete(k);
        this.baselinePending.delete(k);
      }
      this.lastError = '请求一直没回（看门狗放行）';
      this.setStatus('error', this.lastError);
    }
    this.enqueueDue(now);
    if (wall < this.backoffUntil) return;
    while (this.requestTimes.length && wall - this.requestTimes[0] > 60000) this.requestTimes.shift();
    while (this.queue.length) {
      const next = this.peekNext();
      if (!next) break;
      // 回话是玩家亲手按的：多留一个在途位（常规那发卡住也挡不住回话），也不受每分钟上限
      const isReply = next.kind === 'person' && next.channel === 'reply';
      const limit = Math.max(1, cfg.tuning.maxConcurrentRequests) + (isReply ? 1 : 0);
      if (this.inFlightJobs.size >= limit) break;
      if (!isReply && this.requestTimes.length >= cfg.tuning.maxRequestsPerMinute) {
        this.setStatus('throttled', `这一分钟已经问了 ${this.requestTimes.length} 次（上限 ${cfg.tuning.maxRequestsPerMinute}）`);
        break;
      }
      this.queue.splice(this.queue.indexOf(next), 1);
      this.dispatch(next, now);
    }
  }

  /** 把该问的人、该判的事排进队（同一个人只排一发；回话顶掉他排着的常规那发） */
  /**
   * 把该问的排进队。**分层**（越远问得越少，太远不问；数字都在配置的 tuning 里）：
   *
   * | 层 | 近 | 中 | 远 | 停 |
   * |---|---|---|---|---|
   * | 回话（玩家按 E） | 立刻 | 立刻 | 立刻 | 立刻 |
   * | 大事 | 立刻 | 立刻 | 最多隔 `farEventGapSec` 一次 | 不问，记着，拉近补问 |
   * | 小事 | 刚做完决定 `commitSec` 内不问 | 不问 | 不问 | 不问 |
   * | 日常（手上的事做完了） | 隔 `routineGapNearSec` | 隔 `routineGapMidSec` | 隔 `routineGapFarSec` | 不问 |
   *
   * 另有两路**不跟距离挂钩**的：每件新事的显著度（一件一次）；背景巡检——每 `backgroundRefreshSec`
   * 从远 / 停两档挑一个等得最久的问一次（总量固定，跟远处有多少人无关）。
   * 拉近补问：从远 / 停进到近 / 中时，若这期间街上出过大事、或他很久没问过，立刻问一次（state 里带着这段时间的事）。
   */
  private enqueueDue(now: number): void {
    const cfg = this.config!;
    const t = cfg.tuning;
    for (const e of this.actors.values()) {
      if (e.actor.away) continue;
      this.updateTier(e, now);
      // 回话不等他常规那发回来（那份旧答案落地时比回话发得早，会被丢掉）
      if (e.replyWanted !== null) {
        if (e.replyInFlight) continue;
        const i = this.queue.findIndex((j) => j.kind === 'person' && j.npcId === e.actor.npcId);
        if (i >= 0) {
          const j = this.queue[i];
          if (j.kind === 'person' && j.channel === 'reply') continue;
          this.queue.splice(i, 1);
        }
        this.enqueuePerson(e, 'reply');
        continue;
      }
      if (e.jobInFlight || e.jobQueued) continue;
      const sinceAsk = now - e.lastAskedAt;
      // 大事
      if (e.markLevel === 'major') {
        if (e.tier === 'near' || e.tier === 'mid' || (e.tier === 'far' && sinceAsk >= t.farEventGapSec)) {
          this.enqueuePerson(e, 'event');
          continue;
        }
        if (e.tier === 'frozen') {
          // 太远不问：记着，拉近了补问
          e.missedMajor = true;
          e.markLevel = 'none';
        }
        // 远一档还没到间隔：留着标记，到了再问
        continue;
      }
      // 小事：只有近处的人理会，而且让他先把刚定的事做出来
      if (e.markLevel === 'minor') {
        if (e.tier !== 'near') {
          e.markLevel = 'none';
        } else if (now - e.lastDecidedAt >= t.commitSec && sinceAsk >= t.commitSec) {
          this.enqueuePerson(e, 'event');
          continue;
        } else {
          continue; // 等他做一会儿
        }
      }
      // 日常：手上的事做完了
      if (!e.actor.needsDecision) continue;
      const gap = e.tier === 'near' ? t.routineGapNearSec : e.tier === 'mid' ? t.routineGapMidSec : e.tier === 'far' ? t.routineGapFarSec : Infinity;
      if (sinceAsk >= gap) this.enqueuePerson(e, 'routine');
    }
    // 背景巡检：固定频率，跟远处有多少人无关
    if (now - this.lastBackgroundAt >= t.backgroundRefreshSec) {
      let pick: ActorEntry | null = null;
      for (const e of this.actors.values()) {
        if (e.actor.away || e.jobInFlight || e.jobQueued || e.replyWanted !== null) continue;
        if (e.tier !== 'far' && e.tier !== 'frozen') continue;
        if (!pick || e.lastAskedAt < pick.lastAskedAt) pick = e;
      }
      if (pick) {
        this.lastBackgroundAt = now;
        this.enqueuePerson(pick, 'background');
      }
    }
    for (const ev of this.perception.takeUnscored(t.maxSalienceQuestions)) {
      this.queue.push({ kind: 'salience', event: ev, priority: PRIORITY.salience, seq: ++this.jobSeq, layer: 'salience' });
    }
  }

  private enqueuePerson(e: ActorEntry, layer: Exclude<CallLayer, 'salience'>): void {
    const priority = layer === 'reply' ? PRIORITY.reply
      : layer === 'event' || layer === 'catchup' ? PRIORITY.urgent
        : PRIORITY.routine;
    this.queue.push({
      kind: 'person', channel: layer === 'reply' ? 'reply' : 'main', npcId: e.actor.npcId, priority, seq: ++this.jobSeq, layer,
    });
    e.jobQueued = true;
  }

  /**
   * 这个人此刻的决策档：按离玩家多远分，在屏幕上的至少算"中"。拉近立刻换档，拉远要多走出
   * `lodHysteresis` 才换（边界上不来回跳）。从远 / 停进到近 / 中时按需补问。
   */
  private updateTier(e: ActorEntry, now: number): void {
    const t = this.config!.tuning;
    const n = this.deps.getNpc(e.actor.npcId);
    if (!n) return;
    const pos = this.deps.playerPos();
    const d = Math.hypot(n.x - pos.x, n.y - pos.y);
    const onScreen = this.deps.onScreen(n.x, n.y);
    const tierAt = (dist: number): DecisionTier => {
      const byDist: DecisionTier = dist <= t.lodNearRange ? 'near' : dist <= t.lodMidRange ? 'mid' : dist <= t.lodFarRange ? 'far' : 'frozen';
      return onScreen && TIER_RANK[byDist] > TIER_RANK.mid ? 'mid' : byDist;
    };
    const closer = tierAt(d);
    const prev = e.tier;
    if (!e.tierKnown) {
      e.tier = closer;
      e.tierKnown = true;
      return;
    }
    if (TIER_RANK[closer] < TIER_RANK[prev]) {
      e.tier = closer;
      // 拉近补问：远处这段时间出过大事（或者一直没问过他），走到跟前的时候他得是对得上的样子
      const cameFromAfar = prev === 'far' || prev === 'frozen';
      if (cameFromAfar && (closer === 'near' || closer === 'mid')) {
        const stale = e.missedMajor || this.lastMajorAt > e.lastAskedAt || now - e.lastAskedAt > t.routineGapMidSec;
        if (stale && !e.jobQueued && !e.jobInFlight) {
          e.missedMajor = false;
          e.actor.lastReason = '拉近补问';
          this.enqueuePerson(e, 'catchup');
        }
      }
      return;
    }
    const looser = tierAt(Math.max(0, d - t.lodHysteresis));
    if (TIER_RANK[looser] > TIER_RANK[prev]) e.tier = looser;
  }

  /**
   * 下一发：优先级 → 离玩家近的 → 先来的。常规那发要是他感觉得到的新事还没判显著度（显著度题一般几十毫秒回），
   * 先让一让：照"不知道吓不吓人"想，"怕"的那几样进不了菜单、打断也问不准（回话不等）。
   */
  private peekNext(): Job | null {
    if (!this.queue.length) return null;
    const pos = this.deps.playerPos();
    const dist = (j: Job): number => {
      if (j.kind !== 'person') return 0;
      const n = this.deps.getNpc(j.npcId);
      return n ? Math.hypot(n.x - pos.x, n.y - pos.y) : 1e9;
    };
    let best: Job | null = null;
    let bestDist = 0;
    for (const j of this.queue) {
      if (j.kind === 'person' && j.channel === 'main' && this.salienceSettling(j.npcId)) continue;
      if (best && j.priority > best.priority) continue;
      const d = dist(j);
      if (!best || j.priority < best.priority || d < bestDist || (d === bestDist && j.seq < best.seq)) {
        best = j;
        bestDist = d;
      }
    }
    return best;
  }

  /** 他感觉得到的事里有刚出、还没判显著度的（最多等 {@link SALIENCE_WAIT_SEC}） */
  private salienceSettling(npcId: string): boolean {
    const n = this.deps.getNpc(npcId);
    if (!n) return false;
    const now = this.clock;
    const range = this.config!.tuning.sightRange;
    // 别人的动作一直在出（不等它们，免得人人常年让着）；等的是世界里的事与玩家干的事
    return this.perception.recent(now, SALIENCE_WAIT_SEC, 60).some((ev) =>
      !ev.actor && ev.salience === null
      && (typeof ev.x !== 'number' || typeof ev.y !== 'number' || Math.hypot(ev.x - n.x, ev.y - n.y) <= range));
  }

  /** 一发没了（发不出去 / 被看门狗放行）：这个人回到"该问"的状态，下一帧重排 */
  private releaseJob(job: Job): void {
    if (job.kind !== 'person') return;
    const e = this.actors.get(job.npcId);
    if (!e) return;
    e.jobQueued = false;
    e.jobInFlight = false;
    if (job.channel === 'reply') e.replyInFlight = false;
  }

  /** 最近值得拿来摆的那件事（被搭话、台词的 {event} 槽位） */
  private notableEvent(now: number): { text: string; gist: string; place: string | null; byPlayer: boolean } | null {
    const ev = this.perception.mostNotable(now, 75, this.config!.tuning.salienceMin);
    if (!ev) return null;
    const gist = eventGist(ev);
    if (!gist) return null;
    return { text: eventText(ev), gist, place: ev.place ?? null, byPlayer: ev.byPlayer === true };
  }

  /** 某人此刻的台词槽位值 */
  private slotsFor(e: ActorEntry, event: ReturnType<WorldBrainSystem['notableEvent']>): SlotValues {
    const dest = e.actor.headingTo();
    return {
      event: event?.gist ?? null,
      where: event?.place ?? null,
      dest: dest ? (this.config!.graph.place(dest)?.name ?? null) : null,
      held: this.deps.playerActivity.now().heldName,
    };
  }

  /** 玩家此刻显眼的样子（被搭话的人会注意到的） */
  private playerOddity(): string | null {
    const parts: string[] = [];
    const holding = this.holdingText();
    if (holding) parts.push(holding);
    const posture = this.postureText();
    if (posture) parts.push(posture);
    if (this.motion.gait === 'running') parts.push('在街上跑');
    return parts.length ? parts.join('、') : null;
  }

  private snapshotPeople(now: number): PersonSnapshot[] {
    const cfg = this.config!;
    const pos = this.deps.playerPos();
    const rows: PersonSnapshot[] = [];
    const positions = new Map<string, { x: number; y: number; label: string }>();
    for (const e of this.actors.values()) {
      if (e.actor.away) continue;
      const n = this.deps.getNpc(e.actor.npcId);
      if (n) positions.set(e.actor.npcId, { x: n.x, y: n.y, label: e.actor.person.label });
    }
    const brief = new Map<string, { where: string; doing: string; forSec: number }>();
    for (const e of this.actors.values()) {
      const a = e.actor;
      if (a.away) continue;
      const me = positions.get(a.npcId);
      if (!me) continue;
      const place = cfg.graph.nearest(me.x, me.y);
      const dest = a.destPlace ? cfg.graph.place(a.destPlace) : null;
      let where: string;
      if (place && Math.hypot(place.x - me.x, place.y - me.y) < 140) where = place.name;
      else if (dest && a.plan?.phase === 'moving') where = `去${dest.name}的路上`;
      else where = place ? `${place.name}附近` : '街上';
      const doing = e.takenOver ? a.describeDoing() : a.person.activity;
      const forSec = e.takenOver ? a.doingSince(now) : 30;
      brief.set(a.npcId, { where, doing, forSec });
      rows.push({
        person: a.person, where, doing, doingForSec: forSec,
        playerDist: Math.hypot(me.x - pos.x, me.y - pos.y),
        x: me.x, y: me.y,
        seen: [],
      });
    }
    // 看得见的人此刻在做啥（近的在前，视距内全列）：别人的状态进他的上下文。位置、在做啥、做了多久结构化交出去，
    // 写成话时再按"出事前就这样 / 出事后才换的"说（见 personSnapshot）；放几个归配方与模型容量管
    for (const row of rows) {
      const me = positions.get(row.person.npcId)!;
      row.seen = [...positions.entries()]
        .filter(([id]) => id !== row.person.npcId && brief.has(id))
        .map(([id, o]) => ({ id, o, d: Math.hypot(o.x - me.x, o.y - me.y) }))
        .filter((x) => x.d < cfg.tuning.sightRange)
        .sort((x, y) => x.d - y.d)
        .map(({ id, o }) => {
          const b = brief.get(id)!;
          return { label: o.label, x: o.x, y: o.y, where: b.where, doing: b.doing, forSec: b.forSec };
        });
    }
    return rows;
  }

  /**
   * 这个人感觉得到的事：满街都感觉得到的，加上他看得见的地方出的事（新的在后）。
   * 别人干的事 / 说的话只进被决策服务判成值得看的（≥ salienceMin）；自己干的不算"街上的事"。
   */
  private eventsFor(x: number, y: number, now: number, self: string | null): WorldBrainEvent[] {
    const t = this.config!.tuning;
    // 全量：这 90 秒里他感觉得到的事一件不少（放几件归配方与模型容量管；旧版配方仍只放最近 6 件）
    return this.perception.recent(now, 90, 60).filter((ev) => {
      if (ev.actor) {
        if (ev.actor === self) return false;
        if (ev.salience === null || ev.salience < t.salienceMin) return false;
      }
      return typeof ev.x !== 'number' || typeof ev.y !== 'number' || Math.hypot(ev.x - x, ev.y - y) <= t.sightRange;
    });
  }

  /** 轮到这一发了：照此刻的街面现做请求体，发出去 */
  private dispatch(job: Job, now: number): void {
    const cfg = this.config!;
    const built = job.kind === 'person' ? this.buildPersonJob(job, now) : this.buildSalienceJob(job);
    if (!built) {
      this.releaseJob(job);
      return;
    }
    const gen = this.reqGen;
    const wall = this.deps.wallMs();
    const e = job.kind === 'person' ? this.actors.get(job.npcId) : undefined;
    if (e && job.kind === 'person') {
      e.jobQueued = false;
      e.jobInFlight = true;
      e.lastAskedAt = now;
      e.lastAsk = { at: now, state: built.state, questions: built.questions, answers: null };
      if (job.channel === 'reply') {
        e.replyWanted = null;
        e.replyInFlight = true;
        e.replySentAt = now;
      }
    }
    this.inFlightJobs.set(job.seq, { job, since: wall });
    this.countRequest(job.layer, wall);
    const name = deciderName(this.jevStatus);
    this.setStatus('waiting', job.kind === 'person' && job.channel === 'reply'
      ? `${e?.actor.person.label ?? ''}在想咋个回${cfg.player.label}`
      : `在问 ${name}（排队 ${this.queue.length}）`);
    const request = { state: built.state, questions: built.questions };
    const base = {
      job,
      channel: (job.kind === 'person' ? job.channel : 'main') as Channel,
      sentAt: now,
      refs: built.refs,
      menu: built.menu,
      sayOpts: built.sayOpts,
      replyOpts: built.replyOpts,
      slots: built.slots,
      markSeqAtSend: e?.markSeq ?? 0,
      baseKeys: built.baseKeys,
    };
    const who = job.kind === 'person' ? (e?.actor.person.label ?? job.npcId) : `显著度：${eventText(job.event).slice(0, 20)}`;
    const land = (result: JevCallResult) => {
      // 关开关 / 换场景 / 被看门狗放行过：这份回包作废
      if (gen !== this.reqGen || !this.inFlightJobs.has(job.seq)) return;
      this.inFlightJobs.delete(job.seq);
      this.lastExchange = { who, request, response: result.ok ? result.body : result, latencyMs: result.latencyMs };
      this.pending.push({ ...base, result, landedWall: this.deps.wallMs() });
    };
    // 按档排上游优先级：玩家亲手按 E 的回话最先（推理 Hub 的 GPU 被图像 / 视频占着时它先算，熔断时也照发）；
    // 关开关 / 换场景时这一代的 signal 一 abort，在途的一起撤单
    void this.deps.transport.decide(request, cfg.tuning.requestTimeoutMs, {
      tier: this.packTierOf(job), signal: this.reqAbort.signal, name: who.slice(0, 60),
    })
      .then(land)
      .catch((err) => land({ ok: false, kind: 'network', message: String(err), latencyMs: 0 }));
  }

  /** 一发记账：总数、每分钟上限、分层计数 */
  private countRequest(layer: CallLayer, wall: number): void {
    this.requestTimes.push(wall);
    this.requests++;
    this.callLog.push({ wall, layer });
    while (this.callLog.length && wall - this.callLog[0].wall > 60000) this.callLog.shift();
  }

  /**
   * 一个人的一发：只有他自己和他感觉得到的事（多人塞一个 state 按序号问，Laya 实测全错）。
   *
   * 两种问法（见 DecisionMode）：
   * - **选择题**：走位一道 choice + 闲话 / 回话一道 choice。
   * - **逐项是非**：每个选项一道是非题，落地时跟基线比"涨了多少"再挑（见 {@link applyPerOption}）。出了事 / 被搭话 /
   *   街上有吓人的事时问"要不要放下手上的事"+ 各个反应 + 各类话；手上的事做完了（或还没拿过决定）问日常的下一件。
   *   缺的基线跟这一发**并行**去问（每人每句只问一次，缓存）。
   */
  private buildPersonJob(job: Extract<Job, { kind: 'person' }>, now: number): {
    state: Record<string, unknown>;
    questions: Record<string, JevQuestion>;
    refs: Map<string, QuestionRef>;
    menu: ActOption[];
    sayOpts: Record<string, string> | null;
    replyOpts: Record<string, string> | null;
    slots: SlotValues;
    baseKeys: Map<string, BaseRef> | null;
  } | null {
    const cfg = this.config!;
    const e = this.actors.get(job.npcId);
    const n = e ? this.deps.getNpc(job.npcId) : null;
    if (!e || !n || e.actor.away) {
      // 场上找不到这个人（被剧情藏了 / 实体没了）：不再排队，免得每帧空转
      if (e) {
        e.actor.needsDecision = false;
        e.markLevel = 'none';
        e.replyWanted = null;
      }
      return null;
    }
    const people = this.snapshotPeople(now);
    const snap = people.find((s) => s.person.npcId === job.npcId);
    if (!snap) return null;
    const pos = this.deps.playerPos();
    const here = cfg.graph.nearest(n.x, n.y);
    const atPlace = here && Math.hypot(here.x - n.x, here.y - n.y) < 140 ? here.id : null;
    const events = this.eventsFor(n.x, n.y, now, job.npcId);
    const menu = buildMenu({
      person: e.actor.person, config: cfg, atPlace, playerDist: snap.playerDist,
      hasLocatedEvent: this.perception.lastLocated(now, 40, cfg.tuning.salienceMin) !== null,
      scary: events.some((ev) => ev.salience !== null && ev.salience >= cfg.tuning.salienceMin),
      present: new Set(people.map((s) => s.person.npcId)),
    });
    // 手上的事做完了 / 还没拿过决定（清标记之前看）：逐项是非要问日常的下一件
    const planDone = e.actor.needsDecision || !e.takenOver || !e.actor.plan;
    // 问出去了：日常"该想了"和待处理的标记一并清掉（在途期间再来的标记会重新记上）
    e.actor.needsDecision = false;
    e.markLevel = 'none';
    if (menu.length === 0) {
      e.replyWanted = null;
      return null;
    }
    const notable = this.notableEvent(now);
    const sv = this.slotsFor(e, notable);
    let say: Record<string, string> | null = null;
    let reply: Record<string, string> | null = null;
    if (job.channel === 'reply') {
      const dest = e.actor.headingTo();
      const ctx: ReplyContext = {
        atOwnActivity: e.actor.atOwnActivity(e.takenOver),
        headingTo: dest ? (cfg.graph.place(dest)?.name ?? null) : null,
        eventText: notable?.text ?? null,
        eventByPlayer: notable?.byPlayer ?? false,
        playerOddity: this.playerOddity(),
        slots: sv,
        handOut: this.handOutDue(e.actor.person).map((h) => h.name),
      };
      reply = buildReplyOptions(e.actor.person, cfg, ctx);
      if (!Object.keys(reply).length) reply = null;
    } else if (e.actor.person.says.length) {
      say = buildSayOptions(e.actor.person, cfg, sv);
    }
    const stateInput: Parameters<typeof buildPersonState>[0] = { ...this.stateInputFor(snap, n, now, pos, e), events };
    const state = buildPersonState(stateInput);
    if (this.perOptionMode()) {
      // 他感觉得到的事里有世界里出的事、且没被判成平常事：做完手上的事再想下一件时，也要先问要不要应付
      const hot = events.some((ev) => ev.spectacle && (ev.salience === null || ev.salience >= cfg.tuning.salienceMin));
      // 他一件事都感觉不到（拉近补问 / 背景巡检时街上啥都没出）：没东西可应付，不问打断
      const withGate = (events.length > 0 || job.layer === 'reply')
        && (job.layer === 'event' || job.layer === 'catchup' || job.layer === 'reply' || hot);
      const withRoutine = planDone || job.layer === 'routine' || job.layer === 'background';
      // 开不开腔只在出了事 / 有人找时问；平常话（吆喝、闲聊……`ambientCategories`）Laya 判不了
      // （标定：跟没出事时比出来的涨幅对它们没有意义），不出题，落地时按编排说
      let sayOpts: Record<string, string> | null = null;
      if (withGate && job.channel !== 'reply' && say) {
        sayOpts = Object.fromEntries(Object.entries(say).filter(([c]) => !cfg.ambientCategories.includes(c)));
      }
      const { questions, refs } = buildPerOptionQuestions({
        person: e.actor.person, menu, withGate, withRoutine, say: sayOpts, reply,
      });
      if (!Object.keys(questions).length) return null;
      // 2026-09-22 制作人定：每道题都给全量上下文（身边的人一个不少），只按模型容量裁。之前为了 Laya
      // （带着"看得见的人"就全答 0.98）在问打断时把旁人拿掉的做法作废——那是 Laya 读不全，不是题不该看。
      const input = stateInput;
      const sent = state;
      const baseKeys = new Map<string, BaseRef>();
      for (const [k, ref] of refs) {
        if (ref.what !== 'po') continue;
        // 键带上对照的种类：同一句陈述（"回面摊去"）可能既是反应又是日常，两种对照的值不一样
        const kind = ref.role === 'routine' ? 'anon' : 'cf';
        baseKeys.set(k, { kind, key: `${job.seq}|${kind}|${ref.statement}` });
      }
      this.requestBaselines(e, refs, baseKeys, input, this.packTierOf(job));
      return { state: sent, questions, refs, menu, sayOpts, replyOpts: reply, slots: sv, baseKeys };
    }
    // 他上回拿主意以后街上出了值得应付的事（没判成平常事的）：题面跟着这件事问"头一个反应是啥子"，
    // 不问"接下来最可能做啥子"（那问的是他平常干啥，模型自然答接着干活）
    const hotEv = [...events].reverse().find((ev) => ev.spectacle && ev.at > e.lastDecidedAt
      && (ev.salience === null || ev.salience >= cfg.tuning.salienceMin));
    const { questions, refs } = buildPersonQuestions({
      person: e.actor.person, menu, say, reply,
      note: job.channel === 'reply' ? `（${cfg.player.label}刚刚走到跟前跟他搭话。）` : undefined,
      hot: hotEv && job.channel !== 'reply' ? (eventGist(hotEv) ?? '') : null,
    }, cfg);
    return { state, questions, refs, menu, sayOpts: say, replyOpts: reply, slots: sv, baseKeys: null };
  }

  /**
   * 逐项是非的对照：跟这一发**同时**发出去、照**同一个街面**，只改一样东西（见 BaseRef）：
   * - 去掉刚才的事（`cf`）：打断 / 反应 / 开腔 / 回话跟它比——涨的就是"那几件事"带来的；
   * - 去掉他是谁（`anon`）：日常的下一件跟它比——涨的就是"他这个人"带来的。
   * 这一发的答案落地时对照还没到，就等一等（见 {@link applyPending}）。
   */
  private requestBaselines(
    e: ActorEntry,
    refs: Map<string, QuestionRef>,
    baseKeys: Map<string, BaseRef>,
    input: Parameters<typeof buildPersonState>[0],
    tier: PackTier,
  ): void {
    const cf: { key: string; statement: string }[] = [];
    const anon: { key: string; statement: string }[] = [];
    for (const [k, b] of baseKeys) {
      const ref = refs.get(k);
      if (!ref || ref.what !== 'po') continue;
      this.baselinePending.add(b.key);
      (b.kind === 'cf' ? cf : anon).push({ key: b.key, statement: ref.statement });
    }
    const who = e.actor.person.label;
    if (cf.length) this.sendBaseline(buildPersonState({ ...input, events: [] }), cf, `${who}（去掉刚才的事）`, tier);
    if (anon.length) {
      const nobody = { ...input.person.person, identity: 'N/A', temper: 'N/A' };
      this.sendBaseline(buildPersonState({ ...input, person: { ...input.person, person: nobody } }), anon, `${who}（去掉他是谁）`, tier);
    }
  }

  /**
   * 这一发属于哪一档（包通道按它排上游优先级、判熔断）：回话最先；显著度跟近档同级；
   * 其余按这个人此刻离玩家的远近档（停档的人不会被问，保险起见当远档）。对照跟它的正题同档。
   */
  private packTierOf(job: Job): PackTier {
    if (job.kind === 'salience') return 'near';
    if (job.channel === 'reply') return 'reply';
    const t = this.actors.get(job.npcId)?.tier ?? 'far';
    return t === 'near' ? 'near' : t === 'mid' ? 'mid' : 'far';
  }

  private sendBaseline(
    state: Record<string, unknown>,
    items: { key: string; statement: string }[],
    who: string,
    tier: PackTier,
  ): void {
    const gen = this.reqGen;
    const request = buildBaselineRequest(state, items.map((i) => i.statement));
    this.countRequest('baseline', this.deps.wallMs());
    const land = (r: JevCallResult) => {
      // 关开关 / 换场景 / 换决策服务：这一发连同它等的对照一起作废
      if (gen !== this.reqGen || this.destroyed) return;
      const parsed = r.ok ? parseJevResponse(r.body) : null;
      if (parsed) this.account(parsed);
      items.forEach((it, i) => {
        this.baselinePending.delete(it.key);
        const v = parsed?.answers.get(`b${i}`)?.noul;
        // 没拿到：用到它的题当没答（打断题 / 日常题整个没法比时放回"该问"）
        if (typeof v === 'number') this.baseValues.set(it.key, v);
      });
      this.lastExchange = { who: `对照：${who}`, request, response: r.ok ? r.body : r, latencyMs: r.latencyMs };
    };
    void this.deps.transport.decide(request, this.config!.tuning.requestTimeoutMs, {
      tier, signal: this.reqAbort.signal, name: `对照：${who}`.slice(0, 60),
    })
      .then(land)
      .catch((err) => land({ ok: false, kind: 'network', message: String(err), latencyMs: 0 }));
  }

  /** 回包记账：token、花费、模型、服务端耗时、提示 */
  private account(parsed: ParsedJevResponse): void {
    this.inputTokens += parsed.inputTokens;
    let usd = parsed.cost;
    if (usd === null) {
      usd = (parsed.inputTokens / 1e6) * JEV_USD_PER_M_INPUT;
      this.costEstimated = true;
    }
    this.cost += usd;
    this.costLog.push({ wall: this.deps.wallMs(), usd, tokens: parsed.inputTokens });
    this.servedModel = parsed.model;
    this.serverLatencyMs = parsed.serverLatencyMs;
    this.stateTokens = parsed.stateTokens;
    for (const w of parsed.warnings) this.noteWarning(w);
  }

  /** 一件事的显著度：单独一发（多件事塞一个 state 按序号问，Laya 实测全错） */
  private buildSalienceJob(job: Extract<Job, { kind: 'salience' }>): {
    state: Record<string, unknown>;
    questions: Record<string, JevQuestion>;
    refs: Map<string, QuestionRef>;
    menu: ActOption[];
    sayOpts: null;
    replyOpts: null;
    slots: null;
    baseKeys: null;
  } {
    const { state, questions } = buildSalienceRequest(job.event, this.config!);
    return {
      state, questions, refs: new Map([['sal', { what: 'salience', event: job.event }]]),
      menu: [], sayOpts: null, replyOpts: null, slots: null, baseKeys: null,
    };
  }

  private postureText(): string | null {
    return this.deps.playerActivity.now().posture;
  }

  // ───────────────────────── 落地决定 ─────────────────────────

  /**
   * 落地回包。逐项是非的答案要跟基线比：用到的基线还在问（并行发出去的，一般同一批回来），这一发先留着，
   * 最多等一个请求超时；到时还没有就照落（缺基线的题当没答）。
   */
  private applyPending(now: number): void {
    if (!this.pending.length) return;
    const wall = this.deps.wallMs();
    const waitMs = this.config!.tuning.requestTimeoutMs + 1000;
    const later: PendingResult[] = [];
    for (const pr of this.pending.splice(0)) {
      if (pr.baseKeys && pr.result.ok && wall - pr.landedWall < waitMs && this.awaitingBaseline(pr.baseKeys)) {
        later.push(pr);
        continue;
      }
      this.applyResult(pr, now);
    }
    this.pending.push(...later);
  }

  private awaitingBaseline(keys: Map<string, BaseRef>): boolean {
    for (const b of keys.values()) {
      if (!this.baseValues.has(b.key) && this.baselinePending.has(b.key)) return true;
    }
    return false;
  }

  private applyResult(pr: PendingResult, now: number): void {
    const cfg = this.config!;
    const world = this.world();
    const r = pr.result;
    const name = deciderName(this.jevStatus);
    // 这一发的人不再"在途"（不管成没成）
    if (pr.job.kind === 'person') {
      const owner = this.actors.get(pr.job.npcId);
      if (owner) {
        // 常规那发落地时他的回话可能还在途：那样仍算"有一发在途"
        if (pr.job.channel === 'reply') {
          owner.replyInFlight = false;
          owner.jobInFlight = false;
        } else {
          owner.jobInFlight = owner.replyInFlight;
        }
      }
    }
    let failed: Extract<JevCallResult, { ok: false }> | null = null;
    const answers = new Map<string, JevAnswer>();
    if (!r.ok) {
      failed = r;
    } else {
      const parsed = parseJevResponse(r.body);
      if (!parsed) {
        failed = { ok: false, kind: 'bad_response', message: `${name} 返回的形状不认识`, latencyMs: r.latencyMs };
      } else {
        this.account(parsed);
        for (const [k, a] of parsed.answers) answers.set(k, a);
      }
    }
    this.lastLatencyMs = r.latencyMs;
    this.latencySum += r.latencyMs;
    this.latencyCount++;
    // 熔断开着时到点的超时也一样：那是 Hub 被别的活占着，不是决策服务坏了——退避的话 Hub 空出来还要干等一分钟
    const breakerOpen = this.deps.transport.stats?.().breakerOpen === true;
    if (failed && (failed.kind === 'breaker' || failed.kind === 'cancelled' || (failed.kind === 'timeout' && breakerOpen))) {
      // 熔断当场回的 / 自己撤掉的：不是出错，不退避（这个人照手上的事接着做，就是缺省）。
      // 熔断打开前那几发超时攒下的退避也清掉：熔断开着时通道自己当场回，不会打一堆请求出去
      if (failed.kind !== 'cancelled') {
        this.consecutiveErrors = 0;
        this.backoffUntil = 0;
        this.setStatus('waiting', failed.kind === 'breaker' ? failed.message : `熔断中：${failed.message}`);
      }
    } else if (failed) {
      this.consecutiveErrors++;
      const msg = this.describeError(failed);
      this.lastError = msg;
      const wait = failed.kind === 'no_key' || failed.kind === 'no_config' || failed.kind === 'no_server' || failed.kind === 'unreachable'
        ? 10000
        : Math.min(60000, 3000 * 2 ** Math.min(5, this.consecutiveErrors - 1));
      this.backoffUntil = this.deps.wallMs() + wait;
      this.setStatus('error', `${msg}（${Math.round(wait / 1000)} 秒后重试）`);
      // 服务连不上：顺手刷新一下状态牌上的"服务在不在"
      if (failed.kind === 'unreachable') void this.refreshJevStatus();
    } else {
      this.consecutiveErrors = 0;
      this.lastError = null;
    }
    // 显著度：判的"会不会害怕"的概率就是 0..1 的显著度
    for (const [key, ref] of pr.refs) {
      if (ref.what !== 'salience') continue;
      const ans = answers.get(key);
      if (!ans || typeof ans.noul !== 'number') continue;
      const ev = ref.event;
      ev.salience = Math.max(0, Math.min(1, ans.noul));
      // 玩家 / 街上的人干的事先只惊动了跟前（或被冲着）的人：判成吓人的，再惊动看得见的所有人
      if (ev.escalate && ev.salience >= cfg.tuning.salienceMin && typeof ev.x === 'number' && typeof ev.y === 'number') {
        ev.escalate = false;
        this.lastMajorAt = this.clock;
        if (ev.actor) this.markContagion(ev as WorldBrainEvent & { x: number; y: number; actor: string });
        else this.markNear({ x: ev.x, y: ev.y }, cfg.tuning.sightRange, eventText(ev), 'major');
      }
    }
    if (pr.job.kind !== 'person') return;
    // 逐项是非的对照：取出来、用完即删（每一发的对照只对这一发有效；人走了也要删，免得越积越多）
    const bases = new Map<string, number>();
    for (const b of pr.baseKeys?.values() ?? []) {
      const v = this.baseValues.get(b.key);
      if (v !== undefined) bases.set(b.key, v);
      this.baseValues.delete(b.key);
      this.baselinePending.delete(b.key);
    }
    const e = this.actors.get(pr.job.npcId);
    if (!e) return;
    if (e.lastAsk && e.lastAsk.at === pr.sentAt) e.lastAsk.answers = answers;
    if (e.actor.away) return;
    if (pr.baseKeys) {
      this.applyPerOption(e, pr, answers, bases, failed, now, world);
      return;
    }
    const rec: DecisionDraft = { outcome: '', gate: null, rows: [], said: null };
    const menuText = (k: string) => pr.menu.find((o) => o.key === k)?.text ?? k;
    const sv = pr.slots ?? this.slotsFor(e, null);
    const actRef = pr.refs.get('act');
    if (pr.channel === 'main' && e.replySentAt > pr.sentAt) {
      // 常规那发比回话发得早：这个人已经照更新的情形（被搭话之后）问过了，旧答案不许盖上去
      rec.outcome = '作废：被搭话后已经照新情形重问';
    } else if (actRef && actRef.what === 'act') {
      // 发出去的是短代号（省题目的 token），换回菜单里的真键
      const raw = answers.get('act');
      const ans = raw ? unmapAnswer(raw, actRef.keyMap) : undefined;
      if (!ans) {
        // 没拿到决定（出错 / 没答这题）：放回"该问"，下一帧重新排队
        e.actor.needsDecision = true;
        rec.outcome = failed ? `没拿到决定：${this.describeError(failed)}` : '没拿到决定（没答走位题）';
      } else {
        const option = this.arbitrate(e, pr.menu, ans, world);
        for (const r of rankOptions(ans, pr.menu.map((o) => o.key)).slice(0, 10)) {
          rec.rows.push({ group: '走位', text: menuText(r.key), p: r.p, base: null, score: r.p, picked: r.key === option?.key });
        }
        if (!option) {
          e.actor.needsDecision = true;
          rec.outcome = '菜单里一样都做不了';
        } else {
          const reaction = REACTION_KINDS.has(option.kind) && !ROUTINE_KINDS.has(option.kind);
          this.startOption(e, option, ans.confidence, rankOptions(ans, [option.key])[0]?.p ?? 0, pr, now, world, reaction);
          rec.outcome = `挑了：${option.text}`;
          // 闲话
          const sayAns = answers.get('say');
          if (sayAns && sayAns.choice && sayAns.choice !== 'silent' && pr.sayOpts?.[sayAns.choice]) {
            rec.rows.push({
              group: '开腔', text: pr.sayOpts[sayAns.choice], p: sayAns.probabilities[sayAns.choice] ?? null, base: null, score: null, picked: true,
            });
            const line = pickLine(sayPools(e.actor.person, cfg, sayAns.choice), sv, this.deps.random, e.actor.lastSay?.text ?? null);
            if (line) rec.said = this.sayLogged(e, line, sayAns.choice, now, false);
          }
        }
      }
    }
    // 回话（与走位分开落：就算没给走位，搭了话也要回）
    if (pr.channel === 'reply' && pr.replyOpts) {
      if (pr.replyOpts.give) {
        rec.said = this.fulfilHandOut(e, sv, now, rec);
      } else {
        const ans = answers.get('reply');
        const ranked = ans ? rankOptions(ans, Object.keys(pr.replyOpts)) : [];
        // 挑中的在前，其余按概率——挑中的那个万一一句都填不上（不该发生），退到下一个
        let spoken = false;
        for (const r of ranked) {
          const line = spoken ? null : pickLine(replyPools(e.actor.person, cfg, r.key as ReplyIntent), sv, this.deps.random, e.actor.lastSay?.text ?? null);
          rec.rows.push({ group: '回话', text: pr.replyOpts[r.key] ?? r.key, p: r.p, base: null, score: r.p, picked: !!line });
          if (!line) continue;
          spoken = true;
          e.actor.lastReply = { intent: r.key, p: r.p };
          rec.said = this.sayLogged(e, line, `回话:${r.key}`, now, true);
        }
      }
    }
    this.record(e, pr, rec);
  }

  /**
   * 开始做一件事（两种问法共用）：懒接管（第一次拿到决定才停他的巡逻——决策服务连不上时街上照旧是默认逻辑）、
   * 记下挑了啥、回搭话的人对着说话的人；在途期间又来了日常一级的标记（换时辰这类）被这件事顶掉了，补回来。
   */
  private startOption(
    e: ActorEntry,
    option: ActOption,
    conf: number | null,
    p: number,
    pr: PendingResult,
    now: number,
    world: ActorWorld,
    /** 被惊动了才做的（逐项是非：打断了；选择题：出事那一类的事） */
    reaction: boolean,
  ): void {
    if (!e.takenOver) {
      this.deps.stopNpcPatrol(e.actor.npcId);
      e.takenOver = true;
    }
    e.actor.lastPick = { key: option.key, text: option.text, p, conf };
    e.actor.start(option, now, world);
    e.lastDecidedAt = now;
    // 他干的事也是街上的一件事：别人看得见、会受影响（接着做手上的事不算新动作）。
    // 出了事的反应（被惊动了才做的）由决策服务判吓不吓人；日常的走动是平常事
    if (option.kind !== 'carry_on') {
      const target = option.kind === 'approach_person' ? option.arg ?? null : null;
      this.noteNpc(e, option.text, `人:${e.actor.npcId}`, target, !reaction);
    }
    if (pr.channel === 'reply') {
      const player = this.deps.playerPos();
      e.actor.faceToward(player.x, player.y);
    }
    if (e.markSeq > pr.markSeqAtSend && e.markLevel === 'none') e.actor.needsDecision = true;
  }

  private record(e: ActorEntry, pr: PendingResult, d: DecisionDraft): void {
    e.history.push({
      at: Math.round(this.clock * 10) / 10,
      layer: LAYER_NAME[pr.job.layer],
      decider: deciderName(this.jevStatus),
      mode: pr.baseKeys ? 'perOption' : 'choice',
      ...d,
    });
    if (e.history.length > HISTORY_MAX) e.history.shift();
  }

  /** 开腔并记下结果（详情面板："说了"/"排队等冒"/"没冒出来"） */
  private sayLogged(e: ActorEntry, line: string, category: string, now: number, reply: boolean): string {
    const r = this.speakLine(e, line, category, now, reply);
    // 回关二狗的话记进这个人跟他的对话（下回搭话时整段进 state）
    if (reply && r !== 'drop') this.noteDialogue(e, `${e.actor.person.label}：${line}`);
    return r === 'ok' ? line : r === 'queue' ? `${line}（被别的气泡挤住，排队等冒）` : `${line}（没冒出来：不在屏上 / 刚说过）`;
  }

  /** 发道具的职责此刻该给的：玩家身上不到 upTo 件的那几样（道具表里没有的跳过、只警告一次） */
  private handOutDue(p: ResolvedPerson): { item: string; count: number; name: string }[] {
    const out: { item: string; count: number; name: string }[] = [];
    for (const h of p.handOut) {
      const name = this.deps.itemName(h.item);
      if (!name) {
        if (!this.warnedItems.has(h.item)) {
          this.warnedItems.add(h.item);
          console.warn(`${ME}: "${p.label}" 要发的道具 "${h.item}" 道具表里没有，跳过`);
        }
        continue;
      }
      if (this.deps.itemCount(h.item) < h.upTo) out.push({ item: h.item, count: h.count, name });
    }
    return out;
  }

  /**
   * 履行发道具的职责（回话落地时调，决策服务出没出错都调）：照此刻玩家缺的给、说"给你"那句、
   * 记成街上的一件事（旁人看得见谁把啥塞给了谁）。返回说的那句。
   */
  private fulfilHandOut(e: ActorEntry, sv: SlotValues, now: number, rec: DecisionDraft): string | null {
    const cfg = this.config!;
    const given: string[] = [];
    for (const h of this.handOutDue(e.actor.person)) {
      if (this.deps.giveItem(h.item, h.count)) given.push(h.count > 1 ? `${h.name}×${h.count}` : h.name);
    }
    rec.rows.push({ group: '回话', text: given.length ? `把${given.map((n) => `「${n}」`).join('')}塞给${cfg.player.label}` : '（要给的玩家都有了）', p: null, base: null, score: null, picked: true });
    if (!rec.outcome) rec.outcome = given.length ? `发道具：${given.join('、')}` : '发道具：玩家都有了';
    else rec.outcome += given.length ? `；发道具：${given.join('、')}` : '';
    if (given.length) {
      const n = this.deps.getNpc(e.actor.npcId);
      this.note(`${e.actor.person.label}把${given.map((g) => `「${g}」`).join('')}塞给${cfg.player.label}`, '发道具', {
        at: n ? { x: n.x, y: n.y } : undefined,
      });
    }
    const line = pickLine(replyPools(e.actor.person, cfg, 'give'), sv, this.deps.random, e.actor.lastSay?.text ?? null);
    if (!line) return null;
    e.actor.lastReply = { intent: 'give', p: 1 };
    return this.sayLogged(e, line, '回话:give', now, true);
  }

  /**
   * 逐项是非落地。每道题的"涨了多少"= 此刻的概率 − 对照（同一个街面的反事实，见 BaseRef）：
   * 1. **要不要打断**：`放下手上的事去应付` 比"去掉刚才的事"涨够 `gateDeltaMin` → 在反应里挑涨得最多的；
   * 2. 没打断：手上的事做完了就在日常里挑（比"去掉他是谁"涨得最多的，"接着做"加 `carryOnBonus`）；
   *    没做完就**接着做手上的事**（不换）；
   * 3. 开腔：打断了（被惊动、放下了手上的事）才说——某类话比"去掉刚才的事"涨够 `sayDeltaMin` 就说涨得最多的那类；
   *    没说、又刚开始一件日常的事，
   *    按 `ambientSayChance` 从他的平常话里说一句（这类话决策服务判不了，交给编排）；
   * 4. 回话：涨得最多、且此刻说得出一句的那个意图。
   * 缺了对照的题当没答；打断题 / 日常题整个没法比时，放回"该问"，下回再问。
   */
  private applyPerOption(
    e: ActorEntry,
    pr: PendingResult,
    answers: Map<string, JevAnswer>,
    bases: Map<string, number>,
    failed: Extract<JevCallResult, { ok: false }> | null,
    now: number,
    world: ActorWorld,
  ): void {
    if (!pr.baseKeys) return;
    const cfg = this.config!;
    const t = cfg.tuning;
    const rec: DecisionDraft = { outcome: '', gate: null, rows: [], said: null };
    const rows: Record<PerOptionRole, { key: string; p: number; base: number | null; delta: number | null }[]> = {
      gate: [], react: [], routine: [], say: [], reply: [],
    };
    for (const [qk, ref] of pr.refs) {
      if (ref.what !== 'po') continue;
      const p = answers.get(qk)?.noul;
      if (typeof p !== 'number') continue;
      const b = pr.baseKeys.get(qk);
      const base = b ? bases.get(b.key) : undefined;
      rows[ref.role].push({ key: ref.key, p, base: base ?? null, delta: base === undefined ? null : p - base });
    }
    const carryBonus = (k: string) => (k === 'carry_on' ? t.carryOnBonus : 0);
    const byDelta = (list: { key: string; delta: number | null }[], bonus: (key: string) => number = () => 0) =>
      list.filter((r) => r.delta !== null)
        .map((r) => ({ key: r.key, p: r.delta! + bonus(r.key) }))
        .sort((a, b) => b.p - a.p);
    const menuText = (k: string) => pr.menu.find((o) => o.key === k)?.text ?? k;
    let picked: string | null = null;
    let saidCat: string | null = null;

    // 常规那发比回话发得早：这个人已经照更新的情形（被搭话之后）问过了，旧答案不许盖上去
    const stale = pr.channel === 'main' && e.replySentAt > pr.sentAt;
    let startedRoutine = false;
    let interrupted = false;
    if (stale) {
      rec.outcome = '作废：被搭话后已经照新情形重问';
    } else {
      const gate = rows.gate[0] ?? null;
      const gateAsked = [...pr.refs.values()].some((r) => r.what === 'po' && r.role === 'gate');
      const routineAsked = [...pr.refs.values()].some((r) => r.what === 'po' && r.role === 'routine');
      if (failed || (gateAsked && (!gate || gate.delta === null))) {
        // 没拿到决定（出错 / 打断题没法比）：放回"该问"
        e.actor.needsDecision = true;
        rec.outcome = failed ? `没拿到决定：${this.describeError(failed)}` : '没拿到决定：打断题的基线没拿到，下回再问';
      } else {
        const gateDelta = gate?.delta ?? null;
        e.lastGate = gateDelta;
        rec.gate = gateDelta;
        interrupted = gateDelta !== null && gateDelta >= t.gateDeltaMin;
        let got: { option: ActOption; p: number } | null = null;
        if (interrupted) {
          const reactions = byDelta(rows.react);
          got = this.pickFromRanked(e, pr.menu, reactions, world);
          // 要应付、反应题却一道都没法比（基线没拿到）：下回再问
          if (!reactions.length && !routineAsked) e.actor.needsDecision = true;
        }
        if (!got && routineAsked) {
          const ranked = byDelta(rows.routine, carryBonus);
          got = this.pickFromRanked(e, pr.menu, ranked, world);
          if (got) startedRoutine = true;
          else if (!ranked.length) e.actor.needsDecision = true; // 日常题一道都没法比：下回再问
        }
        if (got) {
          picked = got.option.key;
          this.startOption(e, got.option, gateDelta, got.p, pr, now, world, interrupted);
          rec.outcome = `${interrupted ? '放下手上的事，' : ''}挑了：${got.option.text}`;
        } else if (e.actor.needsDecision) {
          rec.outcome = '没拿到决定：基线没拿到，下回再问';
        } else {
          rec.outcome = gateAsked ? '没打断，接着做手上的事' : '接着做手上的事';
          if (pr.channel === 'reply') {
            const player = this.deps.playerPos();
            e.actor.faceToward(player.x, player.y);
          }
        }
        // 没打断、手上的事没做完：接着做（不换）；在途期间又被标记了日常一级的，补回来
        if (!got && e.markSeq > pr.markSeqAtSend && e.markLevel === 'none') e.actor.needsDecision = true;
      }
    }

    const sv = pr.slots ?? this.slotsFor(e, null);
    // 回话（与走位分开落：就算走位没拿到，搭了话也要回）；基线缺了就按原始概率排
    if (pr.channel === 'reply' && pr.replyOpts?.give) {
      rec.said = this.fulfilHandOut(e, sv, now, rec);
    } else if (rows.reply.length && pr.replyOpts) {
      const ranked = rows.reply.map((r) => ({ key: r.key, p: r.delta ?? r.p })).sort((a, b) => b.p - a.p);
      for (const r of ranked) {
        const line = pickLine(replyPools(e.actor.person, cfg, r.key as ReplyIntent), sv, this.deps.random, e.actor.lastSay?.text ?? null);
        if (!line) continue;
        e.actor.lastReply = { intent: r.key, p: r.p };
        saidCat = `reply:${r.key}`;
        rec.said = this.sayLogged(e, line, `回话:${r.key}`, now, true);
        break;
      }
    } else if (!stale) {
      // 开腔：比"去掉刚才的事"涨够了的那类话——只在他被惊动、放下了手上的事时说
      // （没惊动到放下手上的事，就不会为那件事惊叫 / 喊人回屋；实测不加这条，街上没事也有人喊"妈哟"）
      for (const r of interrupted ? byDelta(rows.say) : []) {
        if (r.p < t.sayDeltaMin) break;
        const line = pickLine(sayPools(e.actor.person, cfg, r.key), sv, this.deps.random, e.actor.lastSay?.text ?? null);
        if (!line) continue;
        saidCat = `say:${r.key}`;
        rec.said = this.sayLogged(e, line, r.key, now, false);
        break;
      }
      // 平常话：刚开始一件日常的事，按编排的概率说一句
      if (!saidCat && startedRoutine && !interrupted && this.deps.random() < t.ambientSayChance) {
        const cats = e.actor.person.says.filter((c) => cfg.ambientCategories.includes(c));
        const lines = cats
          .map((c) => ({ c, line: pickLine(sayPools(e.actor.person, cfg, c), sv, this.deps.random, e.actor.lastSay?.text ?? null) }))
          .filter((x): x is { c: string; line: string } => x.line !== null);
        if (lines.length) {
          const pick = lines[Math.min(lines.length - 1, Math.floor(this.deps.random() * lines.length))];
          rec.said = `${this.sayLogged(e, pick.line, pick.c, now, false)}（平常话，按编排的概率说）`;
        }
      }
    }

    // 详情面板：每道题此刻的概率、基线、涨幅（日常那组的分含"接着做"加分），挑中的打勾
    const add = (group: string, list: typeof rows.gate, text: (k: string) => string, score: (r: (typeof rows.gate)[number]) => number | null, isPicked: (k: string) => boolean) => {
      const sorted = [...list].sort((a, b) => (score(b) ?? -9) - (score(a) ?? -9));
      for (const r of sorted) rec.rows.push({ group, text: text(r.key), p: r.p, base: r.base, score: score(r), picked: isPicked(r.key) });
    };
    add('打断', rows.gate, () => '放下手上的事，去应付刚才街上的事', (r) => r.delta, () => interrupted);
    add('反应', rows.react, menuText, (r) => r.delta, (k) => k === picked && interrupted);
    add('日常', rows.routine, menuText, (r) => (r.delta === null ? null : r.delta + carryBonus(r.key)), (k) => k === picked && !interrupted);
    add('开腔', rows.say, (k) => cfg.lineCategories[k] ?? k, (r) => r.delta, (k) => saidCat === `say:${k}`);
    if (!pr.replyOpts?.give) add('回话', rows.reply, (k) => pr.replyOpts?.[k] ?? k, (r) => r.delta, (k) => saidCat === `reply:${k}`);
    this.record(e, pr, rec);
  }

  /** 按分从高到低试：地方满了 / 已经有三个人围着玩家了，就换下一个；都不行返回 null */
  private pickFromRanked(
    e: ActorEntry,
    menu: ActOption[],
    ranked: readonly { key: string; p: number }[],
    world: ActorWorld,
  ): { option: ActOption; p: number } | null {
    const approaching = [...this.actors.values()].filter(
      (x) => x !== e && x.takenOver && (x.actor.plan?.option.kind === 'approach_player' || x.actor.plan?.option.kind === 'follow_player'),
    ).length;
    for (const r of ranked) {
      const opt = menu.find((o) => o.key === r.key);
      if (!opt) continue;
      if ((opt.kind === 'go' || opt.kind === 'run_shelter') && opt.arg) {
        const place = this.config!.graph.place(opt.arg);
        if (place && world.placeLoad(opt.arg, e.actor.npcId) >= (place.capacity ?? 3)) continue;
      }
      if ((opt.kind === 'approach_player' || opt.kind === 'follow_player') && approaching >= 3) continue;
      return { option: opt, p: r.p };
    }
    return null;
  }

  /**
   * 选择题：按概率从高到低试，都不行就接着做自己的事。
   *
   * **先分"应付不应付"，再在应付里挑**（设计稿的放下题 → 反应题两步）：受惊反应（躲、跑、蹲、吓一跳、望、凑过去……）
   * 的概率**加起来**比"接着做"大，就在受惊反应里挑最高的。不这样的话选票被五六个相近的反应拆散，
   * "接着做"一个选项以少数胜出——09-22 实测洋行伙计：接着点货 0.45，跑 0.28 + 躲 0.12 + 吓一跳 0.11 + 蹲 0.04 = 0.55，
   * 模型分明判他会被吓到，按单项最高却挑了接着点货。
   */
  private arbitrate(
    e: ActorEntry,
    menu: ActOption[],
    ans: { choice: string; probabilities: Record<string, number>; confidence: number | null },
    world: ActorWorld,
  ): ActOption | null {
    const isReaction = (o: ActOption) => REACTION_KINDS.has(o.kind) && !ROUTINE_KINDS.has(o.kind);
    const pOf = (k: string) => ans.probabilities[k] ?? 0;
    const carry = menu.find((o) => o.kind === 'carry_on');
    const reactions = menu.filter(isReaction);
    const pReact = reactions.reduce((s, o) => s + pOf(o.key), 0);
    if (reactions.length && pReact > (carry ? pOf(carry.key) : 0)) {
      const ranked = reactions.map((o) => ({ key: o.key, p: pOf(o.key) })).sort((a, b) => b.p - a.p);
      const got = this.pickFromRanked(e, menu, ranked, world);
      if (got) return got.option;
    }
    const got = this.pickFromRanked(e, menu, rankOptions(ans, menu.map((o) => o.key)), world);
    return got?.option ?? carry ?? null;
  }

  /**
   * 开腔。**说了就一定冒气泡**：牌子上只记真冒出来的那句，冒不出来就不算说过。
   * - 回玩家的话（`reply`）：顶掉他头上世界脑自己的旧气泡马上冒；被别的系统的气泡占着就排队等。
   * - 闲话：人不在屏幕上就不说（气泡冒在看不见的地方等于没说）；被挤住（同屏太多 / 旁边的人
   *   气泡还挂着 / 自己头上还有）先排队，等 `lineQueueSec` 秒还冒不出来就算了。
   */
  private speakLine(e: ActorEntry, text: string, category: string, now: number, reply: boolean): 'ok' | 'queue' | 'drop' {
    const a = e.actor;
    if (!reply && now - a.lastSpokeAt < this.config!.tuning.perPersonSpeakGapSec) return 'drop';
    const r = this.tryBubble(e, text, category, now, reply);
    if (r === 'queue') {
      // 回话压过排着的闲话；闲话不顶掉排着的回话
      if (reply || !e.queued?.reply) {
        e.queued = { text, category, until: now + this.config!.tuning.lineQueueSec + (reply ? 3 : 0), reply };
      } else {
        return 'drop';
      }
    }
    return r;
  }

  private tryBubble(e: ActorEntry, text: string, category: string, now: number, reply: boolean): 'ok' | 'queue' | 'drop' {
    const cfg = this.config!;
    const a = e.actor;
    const n = this.deps.getNpc(a.npcId);
    if (!n || n.destroyed || a.away) return 'drop';
    if (!reply) {
      if (!this.deps.onScreen(n.x, n.y)) return 'drop';
      if (a.lastSay && now < a.lastSay.until) return 'queue';
      if (this.deps.bubbleCount() >= cfg.tuning.maxBubbles) return 'queue';
      // 挨得近的人气泡还挂着就先不开腔：两个气泡叠在一起谁的都看不清
      for (const o of this.actors.values()) {
        if (o === e || !o.actor.lastSay || now >= o.actor.lastSay.until) continue;
        const on = this.deps.getNpc(o.actor.npcId);
        if (on && Math.hypot(on.x - n.x, on.y - n.y) < 260) return 'queue';
      }
    }
    const ms = bubbleDurationMs(text, cfg.tuning, reply ? 1500 : 0);
    if (!this.deps.speak(a.npcId, text, ms, { reply, scale: cfg.tuning.bubbleScale })) return 'queue';
    this.bubblesUp = true;
    a.lastSpokeAt = now;
    a.lastSay = { category, text, at: now, until: now + ms / 1000, reply };
    // 说出口的话别人也听得见（惊叫、念经、喊人回屋这类由决策服务判吓不吓人，旁人跟着慌；
    // 平常话（配置的 ambientCategories）和回玩家的话是平常事）
    const ordinary = reply || cfg.ambientCategories.includes(category);
    this.noteNpc(e, `${reply ? `跟${cfg.player.label}说` : '说'}：「${text}」`, `人:${a.npcId}:说`, null, ordinary);
    return 'ok';
  }

  /**
   * 街上某个人干了 / 说了一件事：记成街上的一件事（带 actor）。**跟玩家干的事同一种处理**——
   * 冲着谁的（走到某人跟前）那个人先知道；决策服务判成吓人的，惊动看得见的人（见显著度回包里的 escalate）。
   * 平常的走动、吆喝不进别人的"刚才街上的事"（在他们的"看得见的人"里就看得到）。
   */
  private noteNpc(e: ActorEntry, what: string, source: string, target: string | null, ordinary: boolean): void {
    const n = this.deps.getNpc(e.actor.npcId);
    if (!n) return;
    const place = this.placeName(n.x, n.y);
    const label = e.actor.person.label;
    // 平常的（日常的走动、平常话、回玩家的话）直接记成平常事，不去问显著度：
    // 实测 Laya 会把"今天生意淡得很"判到 0.78，那就成了人传人的假警报
    const noted = this.perception.note({
      at: this.clock, text: `${label}在${place}${what}`, salience: ordinary ? 0 : null, spectacle: true, source,
      x: n.x, y: n.y, place, escalate: !ordinary, actor: e.actor.npcId,
    });
    if (!noted || !target) return;
    const t = this.actors.get(target);
    if (t && !t.actor.away) this.markOne(t, `${label}${what}`, 'minor');
  }

  /** 排着队的话：能冒就冒，过期就算了 */
  private flushQueuedLines(now: number): void {
    for (const e of this.actors.values()) {
      const q = e.queued;
      if (!q) continue;
      if (now > q.until) {
        e.queued = null;
        continue;
      }
      const r = this.tryBubble(e, q.text, q.category, now, q.reply);
      if (r !== 'queue') e.queued = null;
    }
  }

  private describeError(r: Extract<JevCallResult, { ok: false }>): string {
    const name = deciderName(this.jevStatus);
    switch (r.kind) {
      case 'no_key': return `${name} 的 key 还没填：${r.message}`;
      case 'no_config': return `${name} 的地址还没配：${r.message}`;
      case 'no_server': return `开发服务器上没有${name}转发（要在开发模式下跑，改过配置要重启开发服务器）`;
      case 'unreachable': return `${name} 服务连不上（可能被关了）：${r.message}`;
      case 'timeout': return `${name} 超时：${r.message}`;
      case 'network': return `连不上开发服务器：${r.message}`;
      case 'bad_response': return `${name} 回的东西不对：${r.message}`;
      case 'breaker': return r.message;
      case 'cancelled': return `撤单：${r.message}`;
      default: return `${name} 报错 ${r.status ?? ''}：${r.message}`;
    }
  }

  /** 服务端提示（Laya 截断了 state 时只在这里说）：记下来给状态牌看，同一句只在控制台警告一次 */
  private noteWarning(w: string): void {
    this.warningCount++;
    this.recentWarnings.push(w);
    if (this.recentWarnings.length > 3) this.recentWarnings.shift();
    if (this.warnedOnce.size < 50 && !this.warnedOnce.has(w)) {
      this.warnedOnce.add(w);
      console.warn(`${ME}: ${deciderName(this.jevStatus)} 提示：${w}`);
    }
  }

  // ───────────────────────── 杂项 ─────────────────────────

  private world(): ActorWorld {
    const cfg = this.config!;
    return {
      graph: cfg.graph,
      tuning: cfg.tuning,
      random: this.deps.random,
      player: this.deps.playerPos,
      eventAt: () => {
        const ev = this.perception.lastLocated(this.clock, 40, cfg.tuning.salienceMin);
        return ev && typeof ev.x === 'number' && typeof ev.y === 'number' ? { x: ev.x, y: ev.y } : null;
      },
      npcPos: (id) => {
        const e = this.actors.get(id);
        if (e?.actor.away) return null;
        const n = this.deps.getNpc(id);
        return n ? { x: n.x, y: n.y } : null;
      },
      placeLoad: (placeId, self) => {
        let c = 0;
        for (const e of this.actors.values()) {
          if (e.actor.npcId !== self && e.takenOver && e.actor.destPlace === placeId) c++;
        }
        return c;
      },
    };
  }

  private setStatus(s: WorldBrainStatus, text: string): void {
    this.status = s;
    this.statusText = text;
  }

  /** 错误 / 成本闸过了之后回到正常显示 */
  private refreshStatus(): void {
    const wall = this.deps.wallMs();
    const busy = this.inFlightJobs.size > 0;
    if (this.status === 'error' && wall >= this.backoffUntil && !busy) {
      this.setStatus('idle', this.lastError ? `上次出错：${this.lastError}` : '准备好了');
    } else if (this.status === 'throttled' && this.requestTimes.length < (this.config?.tuning.maxRequestsPerMinute ?? 20)) {
      this.setStatus('idle', '准备好了');
    } else if (this.status === 'waiting' && !busy && this.queue.length === 0) {
      this.setStatus('idle', '准备好了');
    }
  }

  /**
   * 照最近几分钟（最多 {@link RATE_WINDOW_SEC} 秒，且不超过这次打开的时长）的节奏，
   * 估一小时要花多少。开了不到 20 秒数据太少，不估。
   */
  private costRate(): { usd: number; tokens: number; requests: number; windowSec: number } | null {
    if (!this.enabled) return null;
    const wall = this.deps.wallMs();
    const openSec = (wall - this.enabledAtWall) / 1000;
    if (openSec < 20) return null;
    const windowSec = Math.min(RATE_WINDOW_SEC, openSec);
    const from = wall - windowSec * 1000;
    while (this.costLog.length && this.costLog[0].wall < wall - RATE_WINDOW_SEC * 1000) this.costLog.shift();
    let usd = 0;
    let tokens = 0;
    let requests = 0;
    for (const c of this.costLog) {
      if (c.wall < from) continue;
      usd += c.usd;
      tokens += c.tokens;
      requests++;
    }
    const k = 3600 / windowSec;
    return { usd: usd * k, tokens: tokens * k, requests: requests * k, windowSec: Math.round(windowSec) };
  }

  /** 详情面板：这个人的一切（身份、此刻在做啥 / 要去哪、感觉得到的事、最近几次怎么想的、最近一发问了啥回了啥） */
  inspect(npcId: string): WorldBrainInspection | null {
    const e = this.actors.get(npcId);
    const cfg = this.config;
    if (!e || !cfg) return null;
    const a = e.actor;
    const p = a.person;
    const now = this.clock;
    const place = (id: string) => cfg.graph.place(id)?.name ?? id;
    const label = (id: string) => cfg.people.find((x) => x.npcId === id)?.label ?? id;
    const n = this.deps.getNpc(npcId);
    const pos = this.deps.playerPos();
    const plan = e.takenOver ? a.plan : null;
    const dest = a.headingTo() ?? a.destPlace;
    const min = cfg.tuning.salienceMin;
    const perceives = n
      ? this.eventsFor(n.x, n.y, now, npcId).map((ev) => {
        const v = ev.salience === null ? '还没判' : `判会怕 ${ev.salience.toFixed(2)}${ev.salience >= min ? '，算事' : '，平常'}`;
        return `${Math.round(now - ev.at)} 秒前 · ${eventText(ev)}（${v}）`;
      })
      : [];
    let lastAsk: WorldBrainInspection['lastAsk'] = null;
    if (e.lastAsk) {
      const qs = e.lastAsk.questions;
      const ans = e.lastAsk.answers;
      lastAsk = {
        at: Math.round(e.lastAsk.at * 10) / 10,
        state: JSON.stringify(e.lastAsk.state, null, 1),
        questions: Object.entries(qs).map(([k, q]) => {
          const got = ans?.get(k);
          let answer = ans ? '没答' : '还在问…';
          if (got) {
            if (typeof got.noul === 'number') answer = `P=${got.noul.toFixed(3)}`;
            else {
              const top = Object.entries(got.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3)
                .map(([ok, pv]) => `${ok} ${pv.toFixed(2)}`).join(' / ');
              answer = `挑 ${got.choice}${top ? `（${top}）` : ''}`;
            }
          }
          const text = q.type === 'choice'
            ? `${q.instructions} ｜ ${Object.entries(q.criteria).map(([ck, cv]) => `${ck}=${cv}`).join('；')}`
            : q.instructions;
          return { key: k, text, answer };
        }),
      };
    }
    return {
      npcId,
      label: p.label,
      kind: p.kind,
      identity: p.identity,
      temper: p.temper,
      activity: p.activity,
      home: place(p.home),
      haunts: p.haunts.map(place),
      relations: p.relations.map((r) => `${label(r.npcId)}：${r.text}`),
      says: p.says.map((c) => cfg.lineCategories[c] ?? c),
      handOut: p.handOut.map((h) => `${this.deps.itemName(h.item) ?? h.item}（身上不到 ${h.upTo} 件就给 ${h.count} 件）`),
      now: {
        doing: e.takenOver ? a.describeDoing() : `默认逻辑（${p.activity}）`,
        phase: plan?.phase ?? null,
        heading: dest ? place(dest) : null,
        // 接着做自己那摊事从接管前就在做：开始时刻是 -∞，面板上按"从一开始"记 0
        forSec: e.takenOver && Number.isFinite(a.doingSince(now)) ? Math.round(a.doingSince(now)) : 0,
        leftSec: plan && Number.isFinite(plan.until) ? Math.max(0, Math.round(plan.until - now)) : null,
        takenOver: e.takenOver,
        away: a.away,
        tier: TIER_NAME[e.tier],
        playerDist: n ? Math.round(Math.hypot(n.x - pos.x, n.y - pos.y)) : null,
        lastReason: a.lastReason ?? '',
        request: e.jobInFlight || e.replyInFlight ? 'inFlight' : e.jobQueued || e.replyWanted !== null ? 'queued' : null,
        say: a.lastSay && now < a.lastSay.until ? a.lastSay.text : null,
      },
      perceives,
      history: [...e.history],
      lastAsk,
    };
  }

  getDebugState(): WorldBrainDebugState {
    const now = this.clock;
    const people: WorldBrainPersonRow[] = [];
    for (const e of this.actors.values()) {
      const a = e.actor;
      const up = a.lastSay !== null && now < a.lastSay.until;
      people.push({
        label: a.person.label,
        npcId: a.npcId,
        doing: e.takenOver ? a.describeDoing() : '默认逻辑',
        pick: a.lastPick?.key ?? null,
        p: a.lastPick?.p ?? null,
        conf: a.lastPick?.conf ?? null,
        // 只显示气泡此刻还挂在头上的那句：牌子上有的，画面上一定有
        say: up ? a.lastSay!.text : null,
        sayIsReply: up && a.lastSay!.reply,
        replyPending: e.replyWanted !== null || e.replyInFlight,
        tier: TIER_NAME[e.tier],
        gate: e.lastGate,
        away: a.away,
        takenOver: e.takenOver,
      });
    }
    const rate = this.costRate();
    const tierCounts: Record<string, number> = { 近: 0, 中: 0, 远: 0, 停: 0 };
    for (const e of this.actors.values()) if (!e.actor.away) tierCounts[TIER_NAME[e.tier]]++;
    const wallNow = this.deps.wallMs();
    const callsPerMinute = { reply: 0, event: 0, catchup: 0, routine: 0, background: 0, salience: 0, baseline: 0, total: 0 };
    const mode = this.config ? this.perOptionMode() : null;
    for (const c of this.callLog) {
      if (wallNow - c.wall > 60000) continue;
      callsPerMinute[c.layer]++;
      callsPerMinute.total++;
    }
    return {
      enabled: this.enabled,
      sceneId: this.sceneId,
      hasConfig: this.config !== null,
      status: this.enabled ? this.status : (this.status === 'returning' ? 'returning' : 'off'),
      statusText: this.enabled ? this.statusText : (this.status === 'returning' ? this.statusText : '关着（街上是默认逻辑）'),
      configErrors: this.configErrors,
      configWarnings: this.configWarnings,
      jev: this.jevStatus,
      decider: deciderName(this.jevStatus),
      decisionMode: mode === null ? null : mode ? 'perOption' : 'choice',
      decisionModeSetting: this.decisionModeSetting,
      backend: this.backend,
      inspectTarget: this.inspectTarget,
      inspectOnInteract: this.inspectOnInteractFlag,
      baselines: { pending: this.baselinePending.size },
      queueLength: this.queue.length,
      inFlight: this.inFlightJobs.size,
      channel: this.deps.transport.stats?.() ?? null,
      servedModel: this.servedModel,
      serverLatencyMs: this.serverLatencyMs,
      stateTokens: this.stateTokens,
      warnings: [...this.recentWarnings],
      warningCount: this.warningCount,
      tierCounts,
      callsPerMinute,
      requests: this.requests,
      inputTokens: this.inputTokens,
      cost: this.cost,
      costEstimated: this.costEstimated,
      costPerHourUsd: rate?.usd ?? null,
      tokensPerHour: rate?.tokens ?? null,
      requestsPerHour: rate?.requests ?? null,
      rateWindowSec: rate?.windowSec ?? 0,
      lastLatencyMs: this.lastLatencyMs,
      avgLatencyMs: this.latencyCount ? Math.round(this.latencySum / this.latencyCount) : null,
      lastError: this.lastError,
      clock: Math.round(now * 10) / 10,
      tension: Math.round(this.perception.tension(now) * 100) / 100,
      events: this.perception.recent(now, 120, 8).map((ev) => {
        const min = this.config?.tuning.salienceMin ?? 0.75;
        const verdict = ev.salience === null
          ? ''
          : `（${deciderName(this.jevStatus)} 判会怕 ${ev.salience.toFixed(2)}${ev.salience >= min ? '，算事' : '，平常'}）`;
        // 哪一串、谁起的头、平息没有（引擎的动作串：同一串的就是一簇）
        const run = ev.runId !== undefined
          ? ` ［串 ${ev.runId}·${ev.initiator?.kind ?? '?'}${ev.initiator?.id ? `:${ev.initiator.id}` : ''}${ev.settledAt !== undefined ? '·已平息' : ''}］`
          : '';
        return `${Math.round(now - ev.at)}s 前 · ${eventText(ev)}${verdict}${run}`;
      }),
      people,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [ev, fn] of this.listeners) this.deps.eventBus.off(ev, fn);
    this.listeners.length = 0;
    for (const unsub of this.tapUnsubs ?? []) unsub();
    this.tapUnsubs = null;
    this.dropRequests();
    this.deps.transport.close?.();
    this.liveRuns.clear();
    this.sceneGen++;
    for (const e of this.actors.values()) e.actor.forget();
    this.actors.clear();
    this.config = null;
    this.enabled = false;
  }
}

/** 把真 NPC 包成 {@link BrainNpc}（Game 侧用；拆出来便于测试不引 Pixi） */
export function brainNpcAdapter(npc: {
  x: number;
  y: number;
  container: { destroyed: boolean };
  moveTo: (x: number, y: number, speed: number, moveAnim?: string, face?: boolean, arrive?: string | null) => Promise<void>;
  jumpTo: (x: number, y: number, ms: number, arc: number, jumpAnim?: string, land?: string | null, face?: boolean) => Promise<void>;
  cancelActiveMove: () => void;
  playAnimation: (name: string, playback?: AnimationPlaybackParams) => void;
  setFacing: (dx: number, dy: number) => void;
  applyInitialFacing: () => void;
  setVisible: (v: boolean) => void;
  spriteEntity: {
    hasLogicalState: (s: string) => boolean;
    getFrameIndex: () => number;
    getFrameCount: () => number;
    setPlaying: (p: boolean) => void;
  } | null;
}): BrainNpc {
  return {
    get x() { return npc.x; },
    get y() { return npc.y; },
    get destroyed() { return npc.container.destroyed; },
    moveTo: (x, y, s, a, f, arr) => npc.moveTo(x, y, s, a, f, arr),
    jumpTo: (x, y, ms, arc, ja, land) => npc.jumpTo(x, y, ms, arc, ja, land, false),
    cancelActiveMove: () => npc.cancelActiveMove(),
    playAnimation: (name, pb) => npc.playAnimation(name, pb),
    setFacing: (dx, dy) => npc.setFacing(dx, dy),
    applyInitialFacing: () => npc.applyInitialFacing(),
    setVisible: (v) => npc.setVisible(v),
    hasAnim: (name) => npc.spriteEntity?.hasLogicalState(name) ?? false,
    frameIndex: () => npc.spriteEntity?.getFrameIndex() ?? 0,
    frameCount: () => npc.spriteEntity?.getFrameCount() ?? 1,
    setPlaying: (p) => npc.spriteEntity?.setPlaying(p),
  };
}
