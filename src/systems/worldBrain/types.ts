/**
 * 世界脑（Jev 驱动的街面群体行为）的数据形状。
 *
 * 一张场景一份配置：`public/assets/data/world_brain/<sceneId>.json`。**没有这份文件的场景，
 * 世界脑整条不参与**——这是"不影响正常游戏"的第一道闸（第二道是运行时开关，缺省关）。
 *
 * 配置只描述"街上有哪些地方、住着哪些人、每个人能做哪些事、会说哪些话"；
 * **做哪件事由 Jev 挑**（开关打开时），执行（走路 / 动作 / 气泡）由本地逐帧完成。
 */

/** 街上一个有名字的地方（站位点）。坐标是场景世界坐标（与 NPC x/y 同尺）。 */
export interface WorldBrainPlaceDef {
  id: string;
  /** 给 Jev 与调试面板看的地名（面摊、赌坊门口……） */
  name: string;
  /** 一句话描述（有啥子、干啥子的地方），进选项文案 */
  desc?: string;
  x: number;
  y: number;
  /** 同时最多几个人把这里当目的地；缺省 3 */
  capacity?: number;
  /** 有屋檐 / 门洞，能躲雨躲雷 */
  shelter?: boolean;
  /** 街口：走到这里可以"离开这条街" */
  exit?: boolean;
}

/** 一个人（或一只动物）能被 Jev 挑的事。带 `:参数` 的在运行时按地点 / 人展开。 */
export type WorldBrainActKind =
  | 'carry_on'
  | 'go'
  | 'go_home'
  | 'run_shelter'
  | 'face_player'
  | 'approach_player'
  | 'avoid_player'
  | 'follow_player'
  | 'watch_event'
  | 'gawk_event'
  | 'cower'
  | 'drop_flat'
  | 'startle'
  | 'flee'
  | 'leave'
  | 'approach_person'
  // 动物
  | 'bark'
  | 'peck'
  | 'flap'
  | 'honk'
  | 'charge_player'
  | 'stretch'
  | 'arch';

/** 动作片段的语义角色 → 动画包里的状态名 */
export type WorldBrainAnimRole =
  | 'idle' | 'walk' | 'run' | 'jump' | 'crouch' | 'lie'
  | 'bark' | 'peck' | 'flap' | 'honk' | 'charge' | 'stretch' | 'arch';

export interface WorldBrainRelationDef {
  /** 对方的 NPC id（必须也在 people 里） */
  npcId: string;
  /** 走到对方跟前去干啥子（进选项文案） */
  text: string;
}

export interface WorldBrainPersonDef {
  /** 场景里的 NPC id */
  npcId: string;
  /** 给 Jev 与调试面板看的称呼（面摊老板、刀差……），同一份配置里不许重名 */
  label: string;
  /** 是啥子人（身份 / 营生 / 家境） */
  identity: string;
  /** 脾气、怕啥子、信啥子 */
  temper: string;
  /** 平时在做的事（"接着做自己的事"那一项的具体说法） */
  activity: string;
  /** 缺省 human */
  kind?: 'human' | 'animal';
  /** 自己的窝 / 摊子（地点 id） */
  home: string;
  /** 平时会去的几个地方（地点 id）；"走到某处去"只在这些里挑 */
  haunts: string[];
  /** 菜单：这个人能被挑的事；缺省按 kind 取整套 */
  acts?: WorldBrainActKind[];
  /** 某件事对这个人的具体说法（覆盖通用文案） */
  actText?: Partial<Record<WorldBrainActKind, string>>;
  relations?: WorldBrainRelationDef[];
  /** 动画状态名覆盖（缺省按 kind 取通用名） */
  anims?: Partial<Record<WorldBrainAnimRole, string>>;
  /** 走 / 跑速度（世界单位每秒） */
  walkSpeed?: number;
  runSpeed?: number;
  /** 会说哪几类话（lineCategories 的键）；动物不说话 */
  says?: string[];
  /**
   * 这个人自己的台词：类别 → 句子。句子里可以带槽位（见 {@link LINE_SLOTS}）：带了槽位的句子
   * 只在那个槽位此刻填得上时才用得上（没出事就说不出"刚才那{event}"），从不硬编码某一种事。
   */
  lines?: Record<string, string[]>;
  /**
   * 被玩家按 E 搭话时的回话：回话意图（{@link HUMAN_REPLY_INTENTS} / {@link ANIMAL_REPLY_INTENTS}）→ 句子，
   * 同样可带槽位。人没写的意图用配置的 `genericReplies`；动物没有通用回话，要自己写。
   */
  replies?: Record<string, string[]>;
  /**
   * 发道具的职责：玩家找他说话时，把这几样（道具表里的 id）塞给玩家——玩家身上某样不到 `upTo` 件，就给 `count` 件
   * （缺省都是 1）。给的时候回话只有"把东西塞给他"一种（`give`，句子写在 `replies.give` 或通用回话里），
   * 决策服务没回话 / 出错也照给——职责不看它挑不挑。走背包的正式加物品入口（进存档，与剧情给的东西无异）。
   */
  handOut?: WorldBrainHandOutDef[];
}

export interface WorldBrainHandOutDef {
  /** 道具表里的 id */
  item: string;
  /** 一次给几件；缺省 1 */
  count?: number;
  /** 玩家身上不到这么多件才给；缺省 = count */
  upTo?: number;
}

/**
 * 台词槽位。**任何一个填不上这句此刻就不用**（要不带地点的说法就另写一句，别指望槽位可空）。
 * - `event`：最近一件值得一说的事的短名（"白光"、"怪风"、道具名、粒子效果名……），句子写成"那{event}"
 * - `where`：那件事出在哪（填成"十字口那边"；满街都感觉得到的事没有地点）
 * - `dest`：他这会儿正要去的地方
 * - `held`：玩家手上拿的东西
 */
export const LINE_SLOTS = ['event', 'where', 'dest', 'held'] as const;
export type LineSlot = (typeof LINE_SLOTS)[number];

/**
 * 人被搭话时能怎么回（通用，不认人也不认事）。能不能选按"此刻做不做得到"筛：
 * `busy` 要他正在做自己那摊事、`leaving` 要他正在赶路、`about_event` / `blame` 要最近真出过事、
 * `trade` 要他自己写了做生意的句子；其余一直在。**挑哪个由 Jev 判**。
 * `give` 只给有发道具职责（`handOut`）、且此刻有东西该给的人——那时回话只有它一种。
 */
export const HUMAN_REPLY_INTENTS = [
  'greet', 'gossip', 'busy', 'trade', 'leaving', 'ask_player', 'about_event', 'blame', 'shoo', 'scared', 'give',
] as const;
/** 牲口被凑上去时的反应（气泡里是叫声 / 动静） */
export const ANIMAL_REPLY_INTENTS = ['friendly', 'wary', 'hostile', 'ignore'] as const;
export type ReplyIntent = (typeof HUMAN_REPLY_INTENTS)[number] | (typeof ANIMAL_REPLY_INTENTS)[number];

/**
 * 决策分档（离玩家多远）：越远问得越少，太远不问。在屏幕上的人至少算"中"。
 * - `near` 近：日常决策勤、小事（走近 / 杵着 / 跑过）也问、大事立刻问
 * - `mid` 中：日常决策疏一些、小事不问、大事立刻问
 * - `far` 远：日常决策很疏、大事最多隔一阵问一次
 * - `frozen` 停：一概不问（接着做手上的事 / 原地待着），拉近了再补问；只有固定频率的背景巡检会轮到他
 */
export type DecisionTier = 'near' | 'mid' | 'far' | 'frozen';

/**
 * 怎么问决策服务：
 * - `choice`：一道选择题从菜单里挑（Jev 这样问没问题）
 * - `perOption`：**逐项是非**——每个选项一道是非题，跟同一街面的反事实对照比涨了多少再挑（Laya 的基础模型
 *   选择题只看措辞、不看情况，是非题却跟得上；2026-09-22 标定）
 * - `auto`：Laya 用 perOption，其余用 choice
 */
export type DecisionMode = 'auto' | 'choice' | 'perOption';

export interface WorldBrainTuning {
  /** 怎么问（见 {@link DecisionMode}） */
  decisionMode: DecisionMode;
  /**
   * 逐项是非："会放下手上的事去应付"的概率比"去掉刚才的事"的同一街面高出这么多，才打断手上的事
   * （laya-multilingual 标定：雷劈在跟前时多数人涨 0.24~0.61；街上啥都没出时恒为 0）
   */
  gateDeltaMin: number;
  /** 逐项是非：某一类话"会开腔说"的概率比"去掉刚才的事"高出这么多，才开口（标定：惊叫 / 念经 / 卖香涨 0.3~0.6） */
  sayDeltaMin: number;
  /**
   * 逐项是非：日常选下一件事时，"接着做自己的事"额外加的分（别东一下西一下）。跟"去掉他是谁"比的涨幅上加：
   * 2026-09-22 jev_街巷 实测 21 人，加 0.1 → 9 人留、0.2 → 16 人、0.3 → 18 人、0.4 → 全留。
   */
  carryOnBonus: number;
  /** 逐项是非：开始一件日常的事时说一句平常话（吆喝 / 闲聊……，见配置的 `ambientCategories`）的概率——这类话 Laya 判不了，交给编排 */
  ambientSayChance: number;
  /** 决策分档的距离（世界单位，离玩家）；出档时多留 `lodHysteresis` 的回差，免得在边界上来回跳 */
  lodNearRange: number;
  lodMidRange: number;
  lodFarRange: number;
  lodHysteresis: number;
  /** 同一个人两次**日常**决策（手上的事做完了）之间最少隔几秒：近 / 中 / 远（停一档不问） */
  routineGapNearSec: number;
  routineGapMidSec: number;
  routineGapFarSec: number;
  /** 刚做完一个决定，这几秒里小事不打断他（让他把动作做出来）；大事、被搭话不受限 */
  commitSec: number;
  /** 远处的人被大事惊动，最多隔几秒问一次 */
  farEventGapSec: number;
  /** 背景巡检：每隔几秒从远处 / 太远的人里挑一个等得最久的问一次（总量固定，跟远处有多少人无关） */
  backgroundRefreshSec: number;
  /** 每分钟最多发几发（一人一发 / 一件事一发都算一发） */
  maxRequestsPerMinute: number;
  /**
   * 同时在途几发。局域网 Laya 2026-09-22 起跑在 GPU 上、并发请求合批：单发约 30~60 ms，
   * 同时 16 发约 0.3 秒全回。超过这个数的活在本地排队（回话先问、出了事的人先问、离玩家近的先问）。
   */
  maxConcurrentRequests: number;
  /** 单发超时（毫秒）。GPU 上单发几十毫秒，十秒没回就当卡死 */
  requestTimeoutMs: number;
  /**
   * 一拍一包：同时在途几个包（设计稿 §13.2「在途上限按包计」）。一帧里要问的题攒成一个包，
   * 包满了下一帧的题等腾出包位再交；回话不等。
   */
  maxPacksInFlight: number;
  /** 熔断（§13.4）：近档延迟看最近多少单、至少攒够几单才按 P95 判 */
  breakerWindow: number;
  breakerMinSamples: number;
  /** 熔断开着时多久发一次探针（设计值：Hub 回来以后十秒内恢复正常问答） */
  breakerProbeSec: number;
  /** 探针的保质期（= 近档保质期）：探针在这个时间内回来才算 Hub 回来了 */
  probeExpireMs: number;
  /**
   * 世界此刻的样子怎么说（设计值：这个读数算什么说法）：天色压暗倍率到这个数以下说"天色压暗下来了"、
   * 再往下到 nightWordDim 说"黑得跟半夜一样"；此刻风速到平常风速的 gustWordRatio 倍说"刮起了大风"，不到说"有点风"。
   */
  darkWordDim: number;
  nightWordDim: number;
  gustWordRatio: number;
  /** 效果冒出来不到这么多秒就收了 = 一闪而过（一道雷的贴图），不报"散了"（设计值） */
  vfxBlinkSec: number;
  /**
   * 一个人一发的 state 的 token 预算（估算，见 `estimateTokens`，比实测偏大约一成）。
   * Laya 窗口 2048：state 最多读约 1990（题目越长留给 state 越少，题目最多约 256），
   * 超了服务端截断，只在 `warnings` 里提一句。
   */
  stateTokenBudget: number;
  /**
   * 显著度门槛（**设计值**，两个模型共用，不按模型调——2026-09-22 制作人定）：决策服务判的
   * "街上的人看到会害怕"的读数到这个数，就算吓人的事。模型答多少就是多少：同一道雷 Laya 判 0.9、
   * Jev 判 0.45，那 Jev 那条街就不怕这道雷。
   */
  salienceMin: number;
  /** 看得见玩家的距离（世界单位） */
  sightRange: number;
  /** "旁边有谁"的距离 */
  nearRange: number;
  /** 同屏最多几个世界脑的气泡 */
  maxBubbles: number;
  /** 同一个人两句话最少隔几秒 */
  perPersonSpeakGapSec: number;
  /** 气泡停留毫秒（最短）；实际按字数加长，见 `bubbleMsPerChar` / `bubbleMaxMs` */
  bubbleMs: number;
  /** 每个字多挂几毫秒 */
  bubbleMsPerChar: number;
  /** 气泡最长挂几毫秒 */
  bubbleMaxMs: number;
  /** 气泡放大倍数（相对引擎气泡的 1 倍基准，按新字号重排不拉伸） */
  bubbleScale: number;
  /** 被别的气泡挡住的话最多等几秒，等不到就不说了 */
  lineQueueSec: number;
  /** "接着做自己的事"持续几秒（区间） */
  carryOnSec: [number, number];
  /** 到了地方歇几秒（区间） */
  dwellSec: [number, number];
  /** 离开街面后多久回来（区间） */
  awaySec: [number, number];
  /** 玩家在跑、离人多近才算"从旁边跑过去" */
  runPastRange: number;
  /** 一发请求里最多顺带问几件新事的显著度 */
  maxSalienceQuestions: number;
}

export interface WorldBrainConfig {
  sceneId: string;
  /** 给 Jev 的地方描述 */
  setting: string;
  /**
   * 显著度题（"街上的人看到会不会害怕"）用的一句话街面：**短，且要带上街坊怕啥、信啥**。
   * 2026-09-22 在 laya-multilingual 上实测：同一件炸雷，配"……街坊都信菩萨、怕鬼神"是 0.87~0.93，
   * 配截断的 `setting`（没有这半句）只有 0.2——判的是"这里的人会不会怕"，地方给的底色决定一切。
   * 缺省取 `setting` 的前 40 字（多半不带这半句，要写）。
   */
  brief?: string;
  player: { label: string; identity: string };
  places: WorldBrainPlaceDef[];
  /** 哪两个地方之间有路（无向） */
  links: [string, string][];
  people: WorldBrainPersonDef[];
  /** 说话类别 → 给 Jev 的说明 */
  lineCategories: Record<string, string>;
  /** 某人自己没写这一类时的通用句子 */
  genericLines?: Record<string, string[]>;
  /** 人没写某个回话意图时的通用回话（只给人用；动物的叫声各不相同，要自己写） */
  genericReplies?: Record<string, string[]>;
  /**
   * 平常话的类别（吆喝、闲聊、抱怨……不用出事也会说的）：逐项是非模式下，开始一件日常的事时
   * 按 `ambientSayChance` 从他会说的这几类里说一句（这类话决策服务判不了，交给编排）
   */
  ambientCategories?: string[];
  /**
   * 事件说法表里的"音效"那一部分：音效 id → 街上的人听来是啥（音效资产本身没有中文名）。
   * 没写的音效只说"传来一阵响动"——别指望模型读懂英文素材名。
   */
  soundWords?: Record<string, string>;
  tuning?: Partial<WorldBrainTuning>;
}

export const DEFAULT_TUNING: WorldBrainTuning = {
  decisionMode: 'auto',
  gateDeltaMin: 0.2,
  sayDeltaMin: 0.2,
  carryOnBonus: 0.1,
  ambientSayChance: 0.35,
  lodNearRange: 500,
  lodMidRange: 1200,
  lodFarRange: 2400,
  lodHysteresis: 120,
  routineGapNearSec: 4,
  routineGapMidSec: 12,
  routineGapFarSec: 40,
  commitSec: 3,
  farEventGapSec: 10,
  backgroundRefreshSec: 15,
  maxRequestsPerMinute: 1200,
  maxConcurrentRequests: 16,
  requestTimeoutMs: 10000,
  maxPacksInFlight: 4,
  breakerWindow: 20,
  breakerMinSamples: 6,
  breakerProbeSec: 5,
  probeExpireMs: 1500,
  darkWordDim: 0.75,
  nightWordDim: 0.35,
  gustWordRatio: 1.6,
  vfxBlinkSec: 2,
  stateTokenBudget: 1500,
  salienceMin: 0.75,
  sightRange: 900,
  nearRange: 220,
  maxBubbles: 4,
  perPersonSpeakGapSec: 7,
  bubbleMs: 3000,
  bubbleMsPerChar: 190,
  bubbleMaxMs: 8000,
  bubbleScale: 2.2,
  lineQueueSec: 5,
  // 一个决定做出来要时间：日常"接着做"、到了地方歇着都给足，别刚做两下又想别的
  carryOnSec: [15, 30],
  dwellSec: [10, 20],
  awaySec: [18, 35],
  runPastRange: 320,
  maxSalienceQuestions: 3,
};

/** 感知到的一件事（进"刚才街上发生的事"） */
export interface WorldBrainEvent {
  /** 世界脑时钟（秒，只在探索态且未暂停时走） */
  at: number;
  text: string;
  /** 说法要等资产名加载完才准（粒子效果的 label）：有就优先用它现取 */
  lazyText?: () => string;
  /**
   * 显著度 0..1——**由决策服务判**（"街上的人看到会不会害怕"的概率），本地不写死分数。
   * null = 还没问到（按值得看算：刚出的事不能因为题还在排队就没人理）。
   */
  salience: number | null;
  /** 已经出过显著度题了（不管答没答上），不再重复问 */
  asked?: boolean;
  /**
   * 能不能当"凑过去看热闹 / 朝那边望 / 往反方向跑"的目标。玩家走近某人、在谁旁边杵着这类
   * "关于玩家本人"的事不算（要冲玩家有专门的"走到关二狗跟前 / 盯着关二狗看"）。
   */
  spectacle: boolean;
  /** 出事地点（可无） */
  x?: number;
  y?: number;
  /** 出事地点的地名（台词 `{where}` 槽位用） */
  place?: string;
  /**
   * 街上的人嘴里怎么叫这件事：一个短名词，句子里写成"那{event}"（"白光"、"怪风"、"雷符"、"一嗓子"）。
   * 没有 = 这件事没法拿来摆（或者只能说"那动静"）。粒子效果的名字要等资产加载，所以也可以现取。
   */
  gist?: string;
  lazyGist?: () => string;
  /** 是玩家自己搞出来的（用了道具、自己的身体动作）——"是不是你搞的"这类话才有着落 */
  byPlayer?: boolean;
  /**
   * 引擎的动作串（`core/actionRun.ts`）：同一件事引出的动作、效果共用一个串 id——一簇 = 同一串的全部事件。
   * 玩家状态串、燃烧、时辰这类不经动作执行器的事没有。
   */
  runId?: number;
  /** 这一串是谁起的头（引擎给的：item / hotspot / cutscene / zone / 叙事 owner…） */
  initiator?: { kind: string; id?: string };
  /** 这一串结束了（引擎的"串结束"通知到的那一刻，世界脑时钟）：事平息，不靠时间窗口去猜 */
  settledAt?: number;
  /**
   * 先只惊动跟前的人，决策服务判成"吓人"（≥ salienceMin）后再惊动看得见的所有人（玩家状态串报来的事：
   * 玩家干了啥，本地不猜吓不吓人）。已经惊动过的清掉。
   */
  escalate?: boolean;
  /**
   * 街上某个人自己干的事 / 说的话（NPC id）：别人看得见、会受影响（人与人之间相互影响，不只是冲玩家）。
   * 他自己的 state 里不再当成"刚才街上的事"；别人那里只有被决策服务判成值得看的才进（平常走动在"看得见的人"里）。
   */
  actor?: string;
  /** 调试用：谁报的 */
  source: string;
}

/** 一件事在街上的人嘴里的短名；没有返回 null */
export function eventGist(e: WorldBrainEvent): string | null {
  const g = (e.lazyGist ? e.lazyGist() : e.gist) ?? '';
  return g.trim() || null;
}

/** 一件事此刻的说法 */
export function eventText(e: WorldBrainEvent): string {
  return e.lazyText ? e.lazyText() : e.text;
}
