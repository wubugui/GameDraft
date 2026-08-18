import type { ConditionExpr, GameContext, IEmoteBubbleAnchor, IGameSystem } from '../data/types';
import type { EmoteBubbleManager } from './EmoteBubbleManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExpr } from './graphDialogue/evaluateGraphCondition';
import type { AssetManager } from '../core/AssetManager';
import { TEXT_URLS } from '../core/projectPaths';
import type { DeterministicRandom } from '../utils/deterministicRandom';

/**
 * 头顶闲聊台词本（`bubble_lines.json`）。
 *
 * 与「导演式」气泡（action `showEmote` / `showSpeechBubble`）的分工：
 * - **导演式**＝剧本里某一拍必须说的那句，仍走 action，时序上永远优先；
 * - **本系统**＝这个人平时会念叨的那几句，声明式配置、按条件与冷却自己冒出来。
 *
 * 三条铁律（改这个文件先看这里）：
 * 1. **只在 Exploring 态说话**。对话/演出/小游戏期间头顶蹦闲聊会盖住演出，是纯 bug 观感。
 * 2. **不与导演式抢同一个头**。`hasBubbleFor` 命中就整组跳过，绝不叠气泡。
 * 3. **时钟走 tick 累加，不走 wall clock**。非 Exploring 态自然不推进——切出去看了半天背包
 *    回来不该立刻被一堆"攒够冷却"的闲聊淹没。
 */

/**
 * 谁在说，三档：
 *
 * - `player`    —— 当前受控的那个人（跟他具体是谁无关）；
 * - `character` —— 角色注册表里的某个角色（`character_registry.json` 的 id）。角色跨场景漫游，
 *                  运行时按**当前场景里哪个摆放引用了这个角色**解析；场上没有该角色则本组不说话。
 *                  想收窄到某几个场景靠 `scenes`。
 * - `entity`    —— 某一个摆放（NPC / 热点 / 过场演员，与 showEmote 的 target 同口径）。
 *                  ⚠ 实体 id 是**场景相对**的（`resolveEmoteTarget` 按当前场景解析，且工程里确有
 *                  跨场景重名的实体），所以这一档必须靠 `scenes` 把场景钉死，否则同名的另一个
 *                  摆放也会跟着说。编辑器的选点弹窗会自动把 `scenes` 填成选中的那个场景。
 */
export type BubbleSpeakerRef =
  | { kind: 'player' }
  | { kind: 'character'; characterId: string }
  | { kind: 'entity'; id: string };

/** ambient=常驻氛围（冷却到了就可能说）；approach=玩家走近时说一次（进入半径的那一下才触发）。 */
export type BubbleTrigger = 'ambient' | 'approach';

export interface BubbleLine {
  text: string;
  /** 随机挑选时的权重，缺省 1；<=0 视为 1 */
  weight?: number;
  /** true=整局只说一次（随存档持久化） */
  once?: boolean;
}

export interface BubbleLineSetDef {
  id: string;
  /** 策划备注，运行时不读 */
  description?: string;
  speaker: BubbleSpeakerRef;
  /** 限定场景；留空=不限 */
  scenes?: string[];
  /** 说这组话的前置条件；留空=恒真 */
  when?: ConditionExpr;
  /** 缺省 ambient */
  trigger?: BubbleTrigger;
  /** 同时可说时大者先说；缺省 0 */
  priority?: number;
  /** 本组自身冷却（ms），缺省 20000 */
  cooldownMs?: number;
  /** trigger=approach 的触发半径（世界单位），缺省 140 */
  approachRange?: number;
  /** 缺省 random */
  pickMode?: 'random' | 'sequence';
  /** 气泡停留时长（ms），缺省 2600 */
  durationMs?: number;
  /** 单组气泡缩放覆盖（不写=用 game_config.emoteBubbleScale） */
  bubbleScale?: number;
  lines: BubbleLine[];
}

export interface BubbleChatterTuning {
  /** 全局最小间隔（ms）：任意两句闲聊之间至少隔这么久，防满屏刷屏。缺省 4000 */
  globalMinIntervalMs: number;
  /** 同一个实体两句之间的最小间隔（ms）。缺省 12000 */
  perSpeakerMinIntervalMs: number;
  /** 同屏最多几个气泡（含 action 发的）。达到上限就不再自动说。缺省 2 */
  maxConcurrent: number;
  /** 离玩家超过这个距离就不说（世界单位）；ambient 也吃这条。缺省 900 */
  audibleRange: number;
}

const DEFAULT_TUNING: BubbleChatterTuning = {
  globalMinIntervalMs: 4000,
  perSpeakerMinIntervalMs: 12000,
  maxConcurrent: 2,
  audibleRange: 900,
};

const DEFAULT_COOLDOWN_MS = 20000;
const DEFAULT_DURATION_MS = 2600;
const DEFAULT_APPROACH_RANGE = 140;
/** 本系统发出的气泡的归属标记；离开探索态时按它整批撤掉 */
const CHATTER_OWNER = 'chatter';

interface BubbleChatterFile {
  tuning?: Partial<BubbleChatterTuning>;
  lineSets: BubbleLineSetDef[];
}

export interface BubbleChatterDeps {
  emoteBubbleManager: EmoteBubbleManager;
  /** 与 showEmote 同口径的目标解析（NPC / 玩家 / 热点 / 过场演员） */
  resolveEmoteTarget: (id: string) => IEmoteBubbleAnchor | null;
  /**
   * 角色档说话人 → 当前场景里引用了该角色的那个摆放的实体 id；场上没有该角色返回 null。
   * 同场景多个摆放引用同一角色时优先取可见的那个，其余按场景声明序（确定性；
   * 校验器对多摆放另报 warning）。
   */
  resolveCharacterEntityId: (characterId: string) => string | null;
  /**
   * 目标实体的世界坐标；解析不到返回 null（则跳过距离过滤，一律可说）。
   *
   * ⚠ 入参是**已解析的目标 id**（与 `resolveEmoteTarget` 同一个串），不是说话人本身——
   * 「角色档落到哪个摆放」只在 {@link BubbleChatterSystem.resolveTargetId} 判一次，
   * 免得位置与锚点两条路各判各的、判出两个不同的人。
   */
  resolveSpeakerPosition: (targetId: string) => { x: number; y: number } | null;
  playerPosition: () => { x: number; y: number };
  currentSceneId: () => string;
  /** 是否处于玩家自由探索态；false 时本系统完全静默 */
  isExploring: () => boolean;
  /** 保留 `[c:…]` 样式标记的解析（气泡文本与对白同等待遇） */
  resolveRichText: (raw: string) => string;
  /** 与全局同一条确定性随机（读档可复现）；不要用 Math.random */
  random: DeterministicRandom;
}

/** FNV-1a：给台词正文算一个稳定短键 */
function textKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * once 记录的键。**按正文内容而不是行下标**——用下标的话策划在台词本中间插一句，
 * 老存档里"这句已经说过"就整体错位到别的句子上（听过的重新可说、没听过的永远听不到）。
 */
function onceKey(lineSetId: string, text: string): string {
  return `${lineSetId}#${textKey(text)}`;
}

/** 「谁在说」的稳定键：用于逐实体冷却与运行时覆盖 */
function speakerKey(ref: BubbleSpeakerRef): string {
  if (ref.kind === 'player') return 'player';
  if (ref.kind === 'character') return `character:${ref.characterId}`;
  return `entity:${ref.id}`;
}

/** 动作 target 的角色档前缀（编辑器与校验器同口径引用它，别各写各的字面量） */
export const CHARACTER_TARGET_PREFIX = 'character:';

/**
 * 动作参数里的 `target` 串 → 说话人（`setBubbleLineSet` / `clearBubbleLineSet` 共用）。
 *
 * - `player`            → 主角档；
 * - `character:<角色id>` → 角色档（前缀是构造性的：实体 id 不含冒号，见校验器的 id 规则）；
 * - 其余                 → 实体档（裸 id，与 showEmote 的 target 同口径）。
 *
 * ⚠ 必须与 {@link speakerKey} 配套：动作侧解析出的说话人要能与台词本自带的 speaker
 * 算出同一个键，否则 `setLineSetFor` 会以"speaker 对不上"拒绝套用。
 */
export function bubbleSpeakerFromActionTarget(target: string): BubbleSpeakerRef {
  const raw = String(target ?? '').trim();
  if (raw === 'player') return { kind: 'player' };
  if (raw.startsWith(CHARACTER_TARGET_PREFIX)) {
    const cid = raw.slice(CHARACTER_TARGET_PREFIX.length).trim();
    if (cid) return { kind: 'character', characterId: cid };
  }
  return { kind: 'entity', id: raw };
}

/**
 * JSON 里的 speaker → 规范化说话人；形状不合法返回 null（调用方整组跳过）。
 *
 * 未知 kind 但带 `id` 时仍按实体读——保持历史宽容读法，避免手写数据一改就整组哑掉。
 */
function normalizeSpeaker(raw: unknown): BubbleSpeakerRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { kind?: unknown; id?: unknown; characterId?: unknown };
  const kind = String(obj.kind ?? '').trim();
  if (kind === 'player') return { kind: 'player' };
  if (kind === 'character') {
    const cid = String(obj.characterId ?? '').trim();
    return cid ? { kind: 'character', characterId: cid } : null;
  }
  const id = String(obj.id ?? '').trim();
  return id ? { kind: 'entity', id } : null;
}

export class BubbleChatterSystem implements IGameSystem {
  private deps: BubbleChatterDeps;
  private assetManager!: AssetManager;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  private defs: Map<string, BubbleLineSetDef> = new Map();
  private tuning: BubbleChatterTuning = { ...DEFAULT_TUNING };

  /** 游戏内累计毫秒（只在 Exploring 态推进），所有冷却都以它为准 */
  private clockMs = 0;
  private globalNextAt = 0;
  private groupNextAt: Map<string, number> = new Map();
  private speakerNextAt: Map<string, number> = new Map();
  private seqIndex: Map<string, number> = new Map();
  /** `${lineSetId}#${lineIndex}`，once 行说过就记；随存档持久化 */
  private usedOnce: Set<string> = new Set();
  /**
   * `setBubbleLineSet` 的运行时覆盖：说话人键 → 台词本 id（`null`＝这人闭嘴）。
   * **只存 id，不存文本**——文本永远来自 JSON，这样存档不会把台词冻成旧版本。
   */
  private overrides: Map<string, string | null> = new Map();
  /** approach 的边沿检测：上一帧是否已在半径内 */
  private wasInRange: Map<string, boolean> = new Map();
  /**
   * 已经"踏进半径"但还没说出口的组（**闩住**，不是脉冲）。
   *
   * 只用边沿脉冲的话，玩家走近的那一帧若恰好撞上全局最小间隔/并发上限（很常见——
   * 场上别人刚念叨过就有 4 秒窗口），这一下就被吃掉，之后站着不动永远不再触发。
   * 闩到"说出去"或"走出半径"为止才是策划期望的语义。
   */
  private pendingApproach: Set<string> = new Set();
  /** 上一帧是否处于探索态——用来抓「刚离开探索态」那条边 */
  private wasExploring = false;
  /**
   * 下一次采样只**播种**边沿、不闩存。
   *
   * 读档/切场景/换台词本之后，玩家很可能本来就站在某个说话人的半径里。若把 `wasInRange`
   * 清空，下一帧就等于给这些组伪造了一条"刚踏进来"的边——而闩存又会扛过全局冷却窗口，
   * 于是玩家一步没动就凭空冒一句 approach 台词（文件头的契约明写"进入半径的那一下才触发"）。
   */
  private reseedEdges = true;
  /** 上一帧的场景 id：换了就要重新播种边沿 */
  private lastSceneId = '';
  private destroyed = false;

  constructor(deps: BubbleChatterDeps) {
    this.deps = deps;
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.clockMs = 0;
    this.globalNextAt = 0;
    this.groupNextAt.clear();
    this.speakerNextAt.clear();
    this.seqIndex.clear();
    this.usedOnce.clear();
    this.overrides.clear();
    this.wasInRange.clear();
    this.pendingApproach.clear();
    this.reseedEdges = true;
    this.lastSceneId = '';
    this.wasExploring = false;
    this.destroyed = false;
  }

  setConditionEvalContextFactory(fn: () => ConditionEvalContext): void {
    this.conditionCtxFactory = fn;
  }

  async loadDefs(): Promise<void> {
    try {
      const raw = await this.assetManager.loadOptionalJson<unknown>(TEXT_URLS.bubbleLines);
      this.applyDefs(raw);
    } catch {
      console.warn('BubbleChatterSystem: bubble_lines.json 读取失败，头顶闲聊本次不启用');
    }
  }

  /** 供测试与热重载：把一份已解析的 JSON 应用为当前台词本。 */
  applyDefs(raw: unknown): void {
    this.reseedEdges = true;
    this.pendingApproach.clear();
    this.defs.clear();
    this.tuning = { ...DEFAULT_TUNING };
    if (raw === null || raw === undefined) return;
    // 允许两种形状：裸数组（只有台词本）或 {tuning, lineSets}
    const file: BubbleChatterFile = Array.isArray(raw)
      ? { lineSets: raw as BubbleLineSetDef[] }
      : (raw as BubbleChatterFile);
    if (file.tuning && typeof file.tuning === 'object') {
      for (const k of Object.keys(DEFAULT_TUNING) as (keyof BubbleChatterTuning)[]) {
        const v = file.tuning[k];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) this.tuning[k] = v;
      }
    }
    for (const def of file.lineSets ?? []) {
      const id = String(def?.id ?? '').trim();
      if (!id) {
        console.warn('BubbleChatterSystem: 台词本缺 id，已跳过', def);
        continue;
      }
      const speaker = normalizeSpeaker(def.speaker);
      if (!speaker) {
        console.warn(`BubbleChatterSystem: 台词本 "${id}" 的 speaker 非法，已跳过`);
        continue;
      }
      const lines = (def.lines ?? []).filter((l) => l && String(l.text ?? '').trim());
      if (lines.length === 0) {
        console.warn(`BubbleChatterSystem: 台词本 "${id}" 一句有效台词都没有，已跳过`);
        continue;
      }
      if (this.defs.has(id)) {
        console.warn(`BubbleChatterSystem: 台词本 id 重复 "${id}"，后者覆盖前者`);
      }
      this.defs.set(id, { ...def, id, speaker, lines });
    }
  }

  /** 同屏气泡上限（待机系统共用同一个口径，免得两边各判各的）。 */
  getMaxConcurrent(): number {
    return this.tuning.maxConcurrent;
  }

  /** 运行时把某个说话人切到另一本台词（只换引用，不改文本）。 */
  setLineSetFor(speaker: BubbleSpeakerRef, lineSetId: string): boolean {
    const id = String(lineSetId ?? '').trim();
    if (!id) return false;
    if (!this.defs.has(id)) {
      console.warn(`setBubbleLineSet: 未知台词本 "${id}"`);
      return false;
    }
    const def = this.defs.get(id)!;
    if (speakerKey(def.speaker) !== speakerKey(speaker)) {
      console.warn(
        `setBubbleLineSet: 台词本 "${id}" 的 speaker 是 ${speakerKey(def.speaker)}，` +
          `与目标 ${speakerKey(speaker)} 不一致——拒绝套用（否则台词会从错的人嘴里冒出来）`,
      );
      return false;
    }
    this.overrides.set(speakerKey(speaker), id);
    return true;
  }

  /** 清掉覆盖：`silence=true` 时这人彻底闭嘴，否则回落到 JSON 里本来匹配的那些组。 */
  clearLineSetFor(speaker: BubbleSpeakerRef, silence = false): void {
    if (silence) this.overrides.set(speakerKey(speaker), null);
    else this.overrides.delete(speakerKey(speaker));
  }

  update(dt: number): void {
    if (this.destroyed) return;
    // ⚠ 本方法必须**无条件**每帧调用（不能只挂 Exploring 分支）：进对话/演出的那一下
    // 要靠这条边把在飞的闲聊气泡撤掉，否则它会和对白的「……」气泡在同一个头上像素级重叠。
    const exploring = this.deps.isExploring();
    if (this.wasExploring && !exploring) {
      this.deps.emoteBubbleManager.cleanupByOwner(CHATTER_OWNER);
    }
    this.wasExploring = exploring;
    if (!exploring || this.defs.size === 0) return;
    // 换场景＝换了一批实体，边沿要重新播种（新场景的出生点可能就在某人半径里）
    const scene = this.deps.currentSceneId();
    if (scene !== this.lastSceneId) {
      this.lastSceneId = scene;
      this.reseedEdges = true;
    }
    this.clockMs += Math.max(0, dt) * 1000;
    // ⚠ 边沿采样必须在下面两条 early return **之前**：它们一 return 这一帧就不采样，
    // 玩家在冷却窗口里的进进出出全被吃掉，边沿冻在 true，之后再也触发不了。
    this.sampleApproachEdges();
    if (this.clockMs < this.globalNextAt) return;
    if (this.deps.emoteBubbleManager.activeBubbleCount() >= this.tuning.maxConcurrent) return;

    const candidates = this.collectCandidates();
    if (candidates.length === 0) return;

    // 优先级高者先说；同级随机取一个（否则同一组永远压着别人）
    let best = candidates[0].def.priority ?? 0;
    for (const c of candidates) best = Math.max(best, c.def.priority ?? 0);
    const top = candidates.filter((c) => (c.def.priority ?? 0) === best);
    const chosen = top[Math.min(top.length - 1, Math.floor(this.deps.random.next() * top.length))];
    this.speak(chosen.def, chosen.anchor);
  }

  /** 每帧采样 approach 的进/出半径，把"刚踏进来"闩进 pendingApproach。 */
  private sampleApproachEdges(): void {
    const player = this.deps.playerPosition();
    const seeding = this.reseedEdges;
    this.reseedEdges = false;
    for (const def of this.defs.values()) {
      if (def.trigger !== 'approach') continue;
      const pos = this.speakerPosition(def.speaker);
      const inRange = pos !== null
        && Math.hypot(pos.x - player.x, pos.y - player.y) <= (def.approachRange ?? DEFAULT_APPROACH_RANGE);
      const wasIn = this.wasInRange.get(def.id) === true;
      this.wasInRange.set(def.id, inRange);
      if (seeding) {
        // 播种帧：只记下"现在在不在里面"，一律不算作走近
        this.pendingApproach.delete(def.id);
        continue;
      }
      if (inRange && !wasIn) this.pendingApproach.add(def.id);
      else if (!inRange) this.pendingApproach.delete(def.id);   // 走出去就作废，回来再算一次
    }
  }

  private collectCandidates(): { def: BubbleLineSetDef; anchor: IEmoteBubbleAnchor }[] {
    const scene = this.deps.currentSceneId();
    const player = this.deps.playerPosition();
    const out: { def: BubbleLineSetDef; anchor: IEmoteBubbleAnchor }[] = [];

    for (const def of this.defs.values()) {
      const key = speakerKey(def.speaker);
      const trigger: BubbleTrigger = def.trigger === 'approach' ? 'approach' : 'ambient';
      const pos = this.speakerPosition(def.speaker);
      const dist = pos ? Math.hypot(pos.x - player.x, pos.y - player.y) : 0;

      // 该说话人被显式切到了别的本子（或被闭嘴）：本组不参选
      const override = this.overrides.get(key);
      if (override !== undefined && override !== def.id) continue;
      if (def.scenes && def.scenes.length > 0 && !def.scenes.includes(scene)) continue;
      if ((this.groupNextAt.get(def.id) ?? 0) > this.clockMs) continue;
      if ((this.speakerNextAt.get(key) ?? 0) > this.clockMs) continue;
      if (pos && dist > this.tuning.audibleRange) continue;
      // 走近型：要有一次没兑现的「踏进半径」才参选（闩在 sampleApproachEdges 里）
      if (trigger === 'approach' && !this.pendingApproach.has(def.id)) continue;

      const anchor = this.resolveAnchor(def.speaker);
      if (!anchor) continue;
      // 导演式气泡占着这个头 → 整组跳过（铁律 2）
      if (this.deps.emoteBubbleManager.hasBubbleFor(anchor)) continue;

      if (!this.conditionPasses(def.when)) continue;
      if (!this.hasUsableLine(def)) continue;   // once 行全用完的组不再参选
      out.push({ def, anchor });
    }
    return out;
  }

  /**
   * 说话人 → 与 `showEmote` 同口径的目标 id。角色档要先落到当前场景的那个摆放上；
   * 场上没有该角色时返回 null（本组不参选，不是报错——角色本来就可能不在这场）。
   */
  private resolveTargetId(ref: BubbleSpeakerRef): string | null {
    if (ref.kind === 'player') return 'player';
    if (ref.kind === 'character') return this.deps.resolveCharacterEntityId(ref.characterId);
    return ref.id;
  }

  private resolveAnchor(ref: BubbleSpeakerRef): IEmoteBubbleAnchor | null {
    const id = this.resolveTargetId(ref);
    return id ? this.deps.resolveEmoteTarget(id) : null;
  }

  private speakerPosition(ref: BubbleSpeakerRef): { x: number; y: number } | null {
    const id = this.resolveTargetId(ref);
    return id ? this.deps.resolveSpeakerPosition(id) : null;
  }

  private conditionPasses(when: ConditionExpr | undefined): boolean {
    if (when === undefined || when === null) return true;
    const factory = this.conditionCtxFactory;
    if (!factory) {
      // fail-safe：条件求值上下文没接上时**不说话**，而不是当成恒真——
      // 把「还没解锁的剧透台词」放出去比少说几句糟得多。
      console.warn('BubbleChatterSystem: 条件求值上下文未注入，带条件的台词本一律不说');
      return false;
    }
    try {
      return evaluateConditionExpr(when, factory());
    } catch (e) {
      console.warn('BubbleChatterSystem: 条件求值异常，本组跳过', e);
      return false;
    }
  }

  private lineUsable(def: BubbleLineSetDef, line: BubbleLine): boolean {
    return !(line.once === true && this.usedOnce.has(onceKey(def.id, line.text)));
  }

  /** 这组还有没有可说的（**不掷骰**——候选筛选阶段掷骰会白白消耗随机序列） */
  private hasUsableLine(def: BubbleLineSetDef): boolean {
    return def.lines.some((line) => this.lineUsable(def, line));
  }

  /** 挑一句；返回 null=这组没有可说的了（once 行用完） */
  private pickLine(def: BubbleLineSetDef): { line: BubbleLine; index: number } | null {
    if (def.pickMode === 'sequence') {
      /**
       * 游标走的是 **def.lines 的下标**，不是"过滤后数组"的下标——按过滤后数组取模的话，
       * once 行一被消耗数组就缩短，游标落到别的句子上，`[A(once),B,C]` 会走成 A C B C B…（跳掉 B）。
       */
      const n = def.lines.length;
      if (n === 0) return null;
      const start = (this.seqIndex.get(def.id) ?? 0) % n;
      for (let k = 0; k < n; k++) {
        const index = (start + k) % n;
        const line = def.lines[index];
        if (this.lineUsable(def, line)) return { line, index };
      }
      return null;
    }
    const usable = def.lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => this.lineUsable(def, line));
    if (usable.length === 0) return null;
    const weightOf = (l: BubbleLine) => Math.max(0.0001, l.weight ?? 1);
    const total = usable.reduce((s, u) => s + weightOf(u.line), 0);
    let roll = this.deps.random.next() * total;
    for (const u of usable) {
      roll -= weightOf(u.line);
      if (roll <= 0) return u;
    }
    return usable[usable.length - 1];
  }

  private speak(def: BubbleLineSetDef, anchor: IEmoteBubbleAnchor): void {
    const picked = this.pickLine(def);
    if (!picked) return;
    const text = this.deps.resolveRichText(picked.line.text).trim();
    if (!text) {
      console.warn(`BubbleChatterSystem: 台词本 "${def.id}" 第 ${picked.index} 句解析后为空，跳过`);
      // 空句也要吃冷却并推进游标，否则 sequence 组会永远卡在这一句上、整组哑掉
      if (def.pickMode === 'sequence') this.seqIndex.set(def.id, picked.index + 1);
      this.pendingApproach.delete(def.id);
      this.applyCooldowns(def);
      return;
    }
    const duration = def.durationMs ?? DEFAULT_DURATION_MS;
    this.deps.emoteBubbleManager.show(
      anchor,
      text,
      duration,
      // 巡场碎嘴走弱一档皮肤（chatter 分型）：环境音不与剧情话同权重
      { variant: 'chatter', ...(def.bubbleScale !== undefined ? { scale: def.bubbleScale } : {}) },
      CHATTER_OWNER,
    );
    this.pendingApproach.delete(def.id);   // 这一次「走近」已经兑现
    if (picked.line.once === true) this.usedOnce.add(onceKey(def.id, picked.line.text));
    if (def.pickMode === 'sequence') this.seqIndex.set(def.id, picked.index + 1);
    this.applyCooldowns(def);
  }

  private applyCooldowns(def: BubbleLineSetDef): void {
    const key = speakerKey(def.speaker);
    this.groupNextAt.set(def.id, this.clockMs + (def.cooldownMs ?? DEFAULT_COOLDOWN_MS));
    this.speakerNextAt.set(key, this.clockMs + this.tuning.perSpeakerMinIntervalMs);
    this.globalNextAt = this.clockMs + this.tuning.globalMinIntervalMs;
  }

  serialize(): object {
    return {
      usedOnce: [...this.usedOnce].sort(),
      seqIndex: Object.fromEntries([...this.seqIndex.entries()].sort(([a], [b]) => a.localeCompare(b))),
      overrides: Object.fromEntries([...this.overrides.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
  }

  deserialize(data: object): void {
    const d = (data ?? {}) as {
      usedOnce?: unknown;
      seqIndex?: unknown;
      overrides?: unknown;
    };
    this.usedOnce = new Set(Array.isArray(d.usedOnce) ? d.usedOnce.map((s) => String(s)) : []);
    this.seqIndex.clear();
    if (d.seqIndex && typeof d.seqIndex === 'object') {
      for (const [k, v] of Object.entries(d.seqIndex as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) this.seqIndex.set(k, Math.floor(v));
      }
    }
    this.overrides.clear();
    if (d.overrides && typeof d.overrides === 'object') {
      for (const [k, v] of Object.entries(d.overrides as Record<string, unknown>)) {
        if (v === null) this.overrides.set(k, null);
        // 存档里的台词本 id 在当前数据中已不存在 → 丢弃这条覆盖，回落到 JSON 匹配
        else if (typeof v === 'string' && this.defs.has(v)) this.overrides.set(k, v);
      }
    }
    // 冷却/边沿是纯运行时节奏，读档后重来一遍即可（存进档反而会让读档瞬间冒一串气泡）
    this.clockMs = 0;
    this.globalNextAt = this.tuning.globalMinIntervalMs;
    this.groupNextAt.clear();
    this.speakerNextAt.clear();
    this.wasInRange.clear();
    this.pendingApproach.clear();
    this.reseedEdges = true;
    this.lastSceneId = '';
    this.wasExploring = false;
  }

  destroy(): void {
    this.destroyed = true;
    this.defs.clear();
    this.groupNextAt.clear();
    this.speakerNextAt.clear();
    this.seqIndex.clear();
    this.usedOnce.clear();
    this.overrides.clear();
    this.wasInRange.clear();
    this.pendingApproach.clear();
    this.wasExploring = false;
    this.conditionCtxFactory = null;
  }

  /** 调试快照（F2 / 运行时命令通道读） */
  getDebugState(): object {
    return {
      lineSets: this.defs.size,
      clockMs: Math.round(this.clockMs),
      globalNextAt: Math.round(this.globalNextAt),
      overrides: Object.fromEntries(this.overrides),
      usedOnce: this.usedOnce.size,
      tuning: this.tuning,
    };
  }
}
