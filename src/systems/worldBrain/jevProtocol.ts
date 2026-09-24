/**
 * 世界脑 ↔ 决策服务（System One 格式：局域网 Laya，或公网 Jev）的协议层：纯函数，不碰游戏对象。
 *
 * ## 一人一发、一件事一发
 * 把整条街塞进一个 state 再按"第几个人"问，实测**全错**（Laya）。所以每个人单独一发（state 只有
 * 街面要点 + 他自己 + 他感觉得到的几件事），每件事的显著度单独一发。
 * Laya 窗口 2048 token：state 最多读约 1990，超了截断、只在返回的 `warnings` 里提一句；
 * 题目（题面 + 选项，键名也算）最多约 256，超了**连 warnings 都没有**。所以 state 按预算裁剪
 * （{@link estimateTokens}），题目本地先估（{@link estimateHeadTokens}）、选项键发短代号。
 *
 * - **state**：一律给**词**（几步远 / 十来秒前），不给坐标和秒数，也不塞与判断无关的字段。
 * - **answers**：`probabilities` 恒为 map；按概率从高到低排出候选，给仲裁逐个试。返回里多出来的字段
 *   （Laya 的 `routing` / `latency_ms` / `warnings` / 每题的 `action`……）只读需要的，其余忽略。
 */
import { eventGist, eventText, type WorldBrainActKind, type WorldBrainEvent } from './types';
import type { ResolvedPerson, ResolvedWorldBrainConfig } from './worldBrainConfig';
import { describeAgo, describeDirection, describeDistance, describeDuration } from './perception';
import { assembleState, DEFAULT_RECIPES, estimateStateTokens, type StateSnapshot } from './stateAssembly';

export interface ActOption {
  /** 选项键：`kind` 或 `kind:参数`（参数是地点 id / NPC id） */
  key: string;
  kind: WorldBrainActKind;
  arg?: string;
  /** 给 Jev 的说法 */
  text: string;
}

export interface MenuContext {
  person: ResolvedPerson;
  config: ResolvedWorldBrainConfig;
  /** 此刻就站在哪个地点上（离得够近才算）；在路上为 null */
  atPlace: string | null;
  playerDist: number;
  /** 最近有值得看的、带地点的事（可以朝那边望 / 凑过去 / 往反方向跑） */
  hasLocatedEvent: boolean;
  /** 他感觉得到的事里有决策服务判成"吓人"的（≥ salienceMin）：没有就不给"怕"的那几样（见 {@link FEAR_KINDS}） */
  scary: boolean;
  /** 这会儿在街上（没离开）的人的 NPC id */
  present: ReadonlySet<string>;
}

const ACT_TEXT: Partial<Record<WorldBrainActKind, string>> = {
  carry_on: '接着{activity}',
  go_home: '回{home}去',
  run_shelter: '跑到{shelter}的屋檐底下躲起',
  face_player: '转过来盯到{player}看',
  approach_player: '走到{player}跟前去',
  avoid_player: '离{player}远点，走开',
  follow_player: '跟在{player}后头走',
  // 说法尽量短：Laya 给题目的只有约 256 token，一个人的菜单常有近 20 项
  watch_event: '站着朝出事的那边望',
  gawk_event: '凑过去看热闹',
  cower: '就地蹲下，抱到脑壳',
  drop_flat: '扑倒在地上趴起',
  startle: '吓得一跳',
  flee: '撒腿就跑，往出事的反方向跑',
  leave: '从{exit}离开勒条街',
  bark: '汪汪叫',
  peck: '低头在地上啄',
  flap: '扑腾翅膀',
  honk: '伸长颈杆嘎嘎叫',
  charge_player: '张开翅膀冲过去啄{player}',
  stretch: '伸个懒腰',
  arch: '弓起背、炸起毛',
};

/**
 * 菜单按"做不做得到"筛：看不见玩家就不能冲玩家、没有出事地点就不能凑过去看。
 *
 * "怕"的那几样（蹲下抱头、扑地、吓一跳、往反方向跑、跑去躲）只在**他感觉得到的事里有被决策服务判成吓人的**
 * 时候才给（`scary`）。吓不吓人仍是决策服务判的（显著度题），本地不猜；但没吓人的事时把它们摆出来，
 * 局域网 Laya 会拿涨幅挑中它们——实测玩家走近、蹲一下，旁边的人就扑到地上趴着。
 */
const PLAYER_ACTS = new Set<WorldBrainActKind>(['face_player', 'approach_player', 'avoid_player', 'follow_player', 'charge_player']);

/** "怕"的反应：只在有吓人的事时进菜单 */
export const FEAR_KINDS: ReadonlySet<WorldBrainActKind> = new Set<WorldBrainActKind>([
  'cower', 'drop_flat', 'startle', 'flee', 'run_shelter',
]);

/** 菜单里"走到某处去"最多几项 */
const MAX_GO_OPTIONS = 4;

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/** 某人此刻的菜单（已按场上情况剔掉做不了 / 不合时宜的） */
export function buildMenu(ctx: MenuContext): ActOption[] {
  const { person, config, atPlace } = ctx;
  const g = config.graph;
  const home = g.place(person.home);
  const shelter = g.nearest(
    g.place(atPlace ?? '')?.x ?? home?.x ?? 0,
    g.place(atPlace ?? '')?.y ?? home?.y ?? 0,
    (p) => p.shelter === true && p.id !== atPlace,
  );
  const exit = g.nearest(home?.x ?? 0, home?.y ?? 0, (p) => p.exit === true);
  const vars: Record<string, string> = {
    activity: person.activity,
    home: home?.name ?? '自己屋头',
    shelter: shelter?.name ?? '',
    player: config.player.label,
    exit: exit?.name ?? '',
  };
  const out: ActOption[] = [];
  const text = (kind: WorldBrainActKind): string => person.actText[kind] ?? fill(ACT_TEXT[kind] ?? kind, vars);
  const sees = ctx.playerDist < config.tuning.sightRange;

  for (const kind of person.acts) {
    if (PLAYER_ACTS.has(kind) && !sees) continue;
    if (FEAR_KINDS.has(kind) && !ctx.scary) continue;
    switch (kind) {
      case 'go': {
        // 最多列 MAX_GO_OPTIONS 个去处，取离他此刻所在最近的（题目预算紧；远的常去处等他走近了自然进候选）
        const ref = g.place(atPlace ?? '') ?? home;
        const candidates = person.haunts
          .filter((hid) => hid !== atPlace && hid !== person.home)
          .map((hid) => g.place(hid))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .sort((a, b) => (ref ? Math.hypot(a.x - ref.x, a.y - ref.y) - Math.hypot(b.x - ref.x, b.y - ref.y) : 0))
          .slice(0, MAX_GO_OPTIONS);
        // 地点说明不进选项：题目的 token 预算很紧，地名本身就够
        for (const p of candidates) out.push({ key: `go:${p.id}`, kind, arg: p.id, text: `走到${p.name}去` });
        break;
      }
      case 'go_home':
        if (atPlace !== person.home) out.push({ key: kind, kind, text: text(kind) });
        break;
      case 'run_shelter':
        if (shelter) out.push({ key: kind, kind, arg: shelter.id, text: text(kind) });
        break;
      case 'approach_player':
        if (ctx.playerDist > 110) out.push({ key: kind, kind, text: text(kind) });
        break;
      case 'follow_player':
        if (ctx.playerDist < 520) out.push({ key: kind, kind, text: text(kind) });
        break;
      case 'watch_event':
      case 'gawk_event':
      case 'flee':
        if (ctx.hasLocatedEvent) out.push({ key: kind, kind, text: text(kind) });
        break;
      case 'leave':
        if (exit) out.push({ key: kind, kind, arg: exit.id, text: text(kind) });
        break;
      case 'approach_person':
        for (const rel of person.relations) {
          if (!ctx.present.has(rel.npcId)) continue;
          const other = config.people.find((p) => p.npcId === rel.npcId);
          if (!other) continue;
          out.push({ key: `approach_person:${rel.npcId}`, kind, arg: rel.npcId, text: `走到${other.label}跟前，${rel.text}` });
        }
        break;
      default:
        out.push({ key: kind, kind, text: text(kind) });
    }
  }
  return out;
}

// 说话选项只列"此刻至少有一句说得出来"的类别，挑句子要看槽位——都在 speech.ts
export { buildSayOptions } from './speech';

/** 他看得见的一个人：在哪、在做啥、这样多久了（写成话时再说"出事前就这样 / 出事后才换的"） */
export interface SeenPerson {
  label: string;
  x: number;
  y: number;
  where: string;
  doing: string;
  forSec: number;
}

export interface PersonSnapshot {
  person: ResolvedPerson;
  /** 在哪（"面摊" / "去赌坊门口的路上"） */
  where: string;
  /** 在做啥子（选项说法或本地描述） */
  doing: string;
  doingForSec: number;
  playerDist: number;
  /** 他站在哪（世界坐标）：事、人、关二狗离他多远、在他哪边，都从这算 */
  x: number;
  y: number;
  /**
   * 他看得见的人（近的在前）——街上别人的状态进他的上下文，人与人之间才会相互影响。
   */
  seen: SeenPerson[];
}

/**
 * state 的 token 估算（偏保守）。实测 Laya 的中文模型：2583 个字符的 JSON state = 1937 token（0.75/字符）。
 * 只用来裁剪、不用来计费；真实数以返回的 `usage.state_tokens` 为准。
 */
export function estimateTokens(obj: unknown): number {
  return estimateStateTokens(obj);
}


function clip(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : `${chars.slice(0, n).join('')}…`;
}

export interface PersonStateInput {
  config: ResolvedWorldBrainConfig;
  now: number;
  timeOfDay: string;
  /** 世界此刻的样子写成话（天色、风、看得到的效果）；没有就不写 */
  weather?: string | null;
  player: {
    where: string;
    /** 关二狗站在哪（世界坐标）：离这个人多远、在他哪边 */
    x?: number;
    y?: number;
    gait: 'still' | 'walking' | 'running';
    stillFor: number;
    posture: string | null;
    holding: string | null;
    /** 关二狗先前干的几件事（"多久以前：在哪干了啥"），旧的在前 */
    recent?: string[];
  };
  /** 这个人跟关二狗说过的话，旧的在前 */
  dialogue?: string[];
  /** 这个人感觉得到的事（看得见的带地点的事 + 满街都感觉得到的事），新的在后 */
  events: readonly WorldBrainEvent[];
  person: PersonSnapshot;
  /** state 的 token 预算（Laya 能读的约 1800~1990，要给题目留地方） */
  budget: number;
}

/**
 * 这一刻这个人的快照（各栏写成话）：街面要点 + 关二狗 + 他感觉得到的几件事 + 他自己。
 * 怎么放、放几条、超预算怎么裁归配方管（`stateAssembly.ts`）。
 *
 * **时间和物理上的关系一律写明**（2026-09-22 制作人定；少了它模型只能照字面瞎猜）：
 * - 每件事：多久以前、离他多远、在他哪边（满街都感觉得到的写明）、还没完还是已经过去了、看得见是谁弄出来的；
 * - 他自己和他看得见的每个人：在做啥、离他多远在哪边、**是出事前就这样还是出事后才换的**——不写这一句，
 *   "雷劈下来，他在茶馆门口叉腰看街"读起来就是雷劈过了他还在看街、全街没一个人动（09-22 实测 Jev 因此答"接着做"）；
 * - 关二狗：离他多远、在他哪边、在做啥、手上拿的、先前干的事。
 */
export function personSnapshot(input: PersonStateInput): StateSnapshot {
  const { config, now, person: s } = input;
  const sight = config.tuning.sightRange;
  const pl = input.player;
  let doing: string;
  if (pl.posture) doing = pl.posture;
  else if (pl.gait === 'running') doing = '在街上跑';
  else if (pl.gait === 'walking') doing = '在街上走';
  else doing = pl.stillFor > 8 ? '站在那点好一阵没动了' : '站着';

  // 全量：他感觉得到的事一件不少（放几件归配方与模型容量管）
  const events = [...input.events];
  // 这场动静的头一件：旁人和他自己的样子都跟它对时间（出事前就这样 / 出事后才换的）。
  // 一串（同一个串 id）从头一件算起——雷符的天黑、闷雷、白光、落雷是一场，不能拿最后那道雷去对
  const latest = events.length ? events[events.length - 1]! : null;
  const start = latest && latest.runId !== undefined
    ? events.find((e) => e.runId === latest.runId) ?? latest
    : latest;
  // 没有短名的事（关二狗走过来这种平常事）只说"刚才那一下"——说成"出事"就是替模型定性成出了事
  const lead = start ? (eventGist(start) || '刚才那一下') : null;
  const sinceStart = start ? now - start.at : Infinity;
  /** 旁人的样子跟这场动静的先后：动静之前就这样、到这会儿还没动 / 动静以后才换成这样（旁人动没动是真信息） */
  const timing = (forSec: number): string => {
    if (!start) return describeDuration(forSec);
    return forSec > sinceStart
      ? `${lead}之前就这样，到这会儿还没动`
      : `${describeAgo(forSec)}才换成这样，是${lead}以后的事`;
  };
  /**
   * 他**自己**的样子：只说那一下的时候他正在做啥，**不说"到这会儿还没动"**——问的就是他会不会动，
   * 先写"他没动"等于替模型答了（09-22 Jev 实测：写"还没动"时雷劈下来 22 人没一个放下手上的事，
   * 改成"那会儿正在做"后 5~8 人放下、平静时照样 0 人）。
   */
  const selfTiming = (forSec: number): string => {
    if (!start) return describeDuration(forSec);
    return forSec > sinceStart
      ? (eventGist(start) ? `${lead}那会儿正在做这个` : '刚才那一下的时候正在做这个')
      : `${describeAgo(forSec)}才换成这样，是${lead}以后的事`;
  };
  const where = (x: number | undefined, y: number | undefined): string | null => {
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    const d = Math.hypot(x - s.x, y - s.y);
    const dir = describeDirection(s.x, s.y, x, y);
    return `离他${describeDistance(d, sight)}${dir ? `，在他${dir}` : ''}`;
  };
  const playerSeen = typeof pl.x === 'number' && typeof pl.y === 'number' && Math.hypot(pl.x - s.x, pl.y - s.y) < sight;

  return {
    setting: config.setting,
    brief: config.brief,
    time: input.timeOfDay,
    ...(input.weather ? { weather: input.weather } : {}),
    // 天色、风、雨、雷不单列：它们是"刚才街上发生的事"里的事件（通用旁听来的），不在这里写死几样天气
    events: events.map((e) => {
      const at = where(e.x, e.y) ?? '满街都感觉得到';
      const state = e.settledAt !== undefined ? '，已经过去了' : e.runId !== undefined ? '，还没完' : '';
      // 谁弄的：关二狗自己干的那一下，说法里本来就有他的名字；跟着那一下来的一串（天黑、起风、白光……）
      // 只说"跟着他那一下来的"，而且只有看得见关二狗的人才晓得——不能说成"看得到是他弄出来的"
      const own = typeof e.source === 'string' && e.source.startsWith('玩家');
      const who = !own && e.byPlayer && e.runId !== undefined && playerSeen ? `，跟着${config.player.label}那一下来的` : '';
      return `${describeAgo(now - e.at)}（${at}${state}${who}）：${clip(eventText(e), 80)}`;
    }),
    player: {
      label: config.player.label,
      identity: config.player.identity,
      where: pl.where,
      doing,
      holding: pl.holding,
      ...(pl.recent?.length ? { recent: pl.recent } : {}),
    },
    person: {
      label: s.person.label,
      identity: s.person.kind === 'animal' ? `（牲口）${s.person.identity}` : s.person.identity,
      temper: s.person.temper,
      where: s.where,
      doing: latest ? `${s.doing}（${selfTiming(s.doingForSec)}）` : s.doing,
      doingFor: describeDuration(s.doingForSec),
      playerDistance: (typeof pl.x === 'number' && typeof pl.y === 'number' ? where(pl.x, pl.y)?.replace(/^离他/, '') : null)
        ?? describeDistance(s.playerDist, sight),
      nearby: s.seen.map((o) => {
        const w = where(o.x, o.y)!.replace(/^离他/, '');
        return `${o.label}（${w}，在${o.where}）：${o.doing}（${timing(o.forSec)}）`;
      }),
      ...(input.dialogue?.length ? { dialogue: input.dialogue } : {}),
    },
  };
}

/**
 * 一个人的 state（一人一发的整份）：**只写这一个人**（Laya 的实测：把多个人塞进一个 state 再按"第几个人"问，
 * 结果全错）。走通用的"配方 + 快照"纯函数（`legacy` 配方）：超预算时按"看得见的人（先留两个再全去）→
 * 较早的事 → 身份说明 → 街面说明"的顺序往下裁。
 */
export function buildPersonState(input: PersonStateInput): Record<string, unknown> {
  return assembleState(DEFAULT_RECIPES.legacy, personSnapshot(input), { budget: input.budget });
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** 有序档位题（Jev 的 Score）：criteria 从低到高 */
export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

/** 是非题（Noul）：答案是陈述为真的概率 */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
}

export type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

/** 逐项是非里一道题的角色：要不要打断 / 出事的反应 / 日常的下一件 / 开不开腔 / 怎么回关二狗 */
export type PerOptionRole = 'gate' | 'react' | 'routine' | 'say' | 'reply';

export type QuestionRef =
  /** `keyMap`：发出去的短代号 → 菜单里的真键（走位题的键换成 a / b / c 省 token） */
  | { npcId: string; what: 'act' | 'say' | 'reply'; keyMap?: Record<string, string> }
  | { what: 'salience'; event: WorldBrainEvent }
  /** 逐项是非的一道题：`key` = 菜单键 / 说话类别 / 回话意图；`statement` = 发出去的那句陈述（基线按它缓存） */
  | { npcId: string; what: 'po'; role: PerOptionRole; key: string; statement: string };

/**
 * 题目（题面 + 全部选项，**键名也算**）的 token 估算。实测 laya-multilingual：
 * 20 个选项、单字母键、16 字题面 = 232 token；键名写成 `approach_person:jev_paoge` 这种要贵得多。
 * Laya 给题目的只有约 256 token，**超了静默截断、不给 warnings**——所以出题时本地先卡。
 */
export function estimateHeadTokens(q: JevQuestion): number {
  const chars = (s: string) => [...s].length;
  // 系数按实测拟合：20 个选项、240 个汉字、单字母键 → 实测 232，估 235
  if (q.type === 'choice') {
    const values = Object.values(q.criteria);
    const keys = Object.keys(q.criteria).reduce((n, k) => n + k.length, 0);
    return Math.ceil(0.78 * (chars(q.instructions) + values.reduce((n, v) => n + chars(v), 0)) + 2 * values.length + 0.4 * keys);
  }
  if (q.type === 'score') return Math.ceil(0.78 * (chars(q.instructions) + q.criteria.reduce((n, v) => n + chars(v), 0)) + 2 * q.criteria.length);
  return Math.ceil(0.78 * chars(q.instructions) + 10);
}

/** 题目的 token 上限（Laya 约 256，留一点余量） */
export const HEAD_TOKEN_BUDGET = 240;

/** 走位题超了题目预算时，按这个次序去掉次要的选项（"接着做"永远留着）——只是兜底，菜单本该设计在预算内 */
const MENU_TRIM_ORDER: WorldBrainActKind[] = ['follow_player', 'drop_flat', 'startle', 'face_player', 'leave', 'go'];

/** 第 i 个选项的短代号：a…z，再 za…zz */
function shortKey(i: number): string {
  return i < 26 ? String.fromCharCode(97 + i) : `z${String.fromCharCode(97 + (i - 26) % 26)}`;
}

/**
 * 显著度题：**是非题**"街上的人看到会不会害怕"，答案 P(真) 就是 0..1 的显著度。
 *
 * 2026-09-22 在局域网 Laya（laya-multilingual）上试过四种问法，只有这一种分得开：
 * 平常事（走到狗跟前、起风、蹦一下、有人喊一句）0.14~0.64，吓人事（天黑、炸雷、白光、地震、
 * 起火、狂风）0.86~0.93。五档分档题反而是反的（平常事平均分比吓人事高）——那是题出坏了，改题不改数。
 * 门槛 `tuning.salienceMin` 是**设计值**，两个模型共用：模型答多少就是多少，不按模型调。
 */
export const SALIENCE_QUESTION = '街上的人看到刚才发生的事会害怕。';

/** 一件事一发：state 只有街面一句话 + 这件事（多件事塞一个 state 再按第几件问，实测全错） */
export function buildSalienceRequest(
  ev: WorldBrainEvent,
  config: ResolvedWorldBrainConfig,
): { state: Record<string, unknown>; questions: Record<string, JevNoulQuestion> } {
  return {
    // 地方用配置的 brief（短、带上街坊怕啥信啥）：判的是"这里的人会不会怕"，底色决定一切
    state: assembleState(DEFAULT_RECIPES.salience, { brief: config.brief, events: [clip(eventText(ev), 80)] }),
    questions: { sal: { type: 'noul', instructions: SALIENCE_QUESTION } },
  };
}

export interface AskItem {
  person: ResolvedPerson;
  menu: ActOption[];
  say: Record<string, string> | null;
  /** 玩家刚跟他搭话：怎么回（不含"不开腔"）。有它就不出闲话题 */
  reply?: Record<string, string> | null;
  /** 只关这个人的一句提示（"关二狗刚刚在跟他搭话"），接在几道题的题面后面 */
  note?: string;
  /**
   * 他此刻感觉到街上刚出了值得应付的事（没判成平常事的）：题面跟着这件事问——
   * "刚才街上{短名}那一下，X 头一个反应是啥子"。不带的话题面是"X 接下来最可能做啥子"，
   * 问的是他平常接下来干啥，模型自然答"接着做手上的事"（09-22 Jev 实测：雷劈下来全街照常干活）。
   * 值是这件事的短名（没有短名传空串，说成"这一下"）。
   */
  hot?: string | null;
}

/**
 * 给一个人出题（配 {@link buildPersonState}）：走位一道，外加闲话或回话一道。键是固定的
 * `act` / `say` / `reply`——一发只问一个人，不用靠序号对人。题面短：Laya 给题的只有约 256 token。
 */
export function buildPersonQuestions(
  it: AskItem,
  config: ResolvedWorldBrainConfig,
): { questions: Record<string, JevQuestion>; refs: Map<string, QuestionRef> } {
  const refs = new Map<string, QuestionRef>();
  const questions: Record<string, JevQuestion> = {};
  const player = config.player.label;
  const label = it.person.label;
  const note = it.note ?? '';
  const hot = typeof it.hot === 'string' ? `刚才街上${it.hot ? `${it.hot}那一下` : '这一下'}` : null;
  const instructions = hot
    ? `${hot}，「${label}」头一个反应是啥子？${note}`
    : `「${label}」接下来最可能做啥子？${note}`;
  // 键换成 a / b / c（键名也吃题目预算）；超预算按次序去掉次要选项
  const menu = it.menu.slice();
  const make = (): { q: JevChoiceQuestion; keyMap: Record<string, string> } => {
    const criteria: Record<string, string> = {};
    const keyMap: Record<string, string> = {};
    menu.forEach((o, i) => {
      criteria[shortKey(i)] = o.text;
      keyMap[shortKey(i)] = o.key;
    });
    return { q: { type: 'choice', instructions, criteria }, keyMap };
  };
  let act = make();
  for (const kind of MENU_TRIM_ORDER) {
    while (estimateHeadTokens(act.q) > HEAD_TOKEN_BUDGET) {
      const i = menu.map((o) => o.kind).lastIndexOf(kind);
      if (i < 0) break;
      menu.splice(i, 1);
      act = make();
    }
  }
  questions.act = act.q;
  refs.set('act', { npcId: it.person.npcId, what: 'act', keyMap: act.keyMap });
  if (it.reply && Object.keys(it.reply).length) {
    questions.reply = {
      type: 'choice',
      instructions: `${player}走到「${label}」跟前跟他搭话，照「${label}」这会儿的样子，他最可能咋个回？`,
      criteria: it.reply,
    };
    refs.set('reply', { npcId: it.person.npcId, what: 'reply' });
  } else if (it.say) {
    questions.say = {
      type: 'choice',
      instructions: hot
        ? `${hot}，「${label}」会不会开腔、说啥子样的话？${note}`
        : `「${label}」这哈会不会开腔、说啥子样的话？大多数时候街上的人不开腔。${note}`,
      criteria: it.say,
    };
    refs.set('say', { npcId: it.person.npcId, what: 'say' });
  }
  return { questions, refs };
}

export interface JevAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
  /** Score 题：期望档位（Σ 档位 × 概率） */
  score?: number;
  /** Noul 题：陈述为真的概率 */
  noul?: number;
}

/** Jev 官方价：输入每百万 token 0.042 美元，输出不收钱。直连官方时回包里没有花费，按这个估 */
export const JEV_USD_PER_M_INPUT = 0.042;

export interface ParsedJevResponse {
  answers: Map<string, JevAnswer>;
  inputTokens: number;
  /** 回包里的花费（美元；网关的 `provider_metadata.gateway.cost` 或 `usage.cost`，Laya 恒为 0）；没有为 null */
  cost: number | null;
  /** 实际用到的模型（Laya 回 laya-*） */
  model: string | null;
  /** state 的 token 数（Laya 才有） */
  stateTokens: number | null;
  /** 服务端推理耗时（Laya 才有） */
  serverLatencyMs: number | null;
  /** 服务端的提示——Laya 截断了超长 state 时只在这里说，不报错 */
  warnings: string[];
}

/** 解析 Jev 响应；形状不对返回 null（调用方按"坏响应"处理，不猜） */
export function parseJevResponse(raw: unknown): ParsedJevResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ans = r.answers;
  if (!ans || typeof ans !== 'object') return null;
  const answers = new Map<string, JevAnswer>();
  for (const [k, v] of Object.entries(ans as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const a = v as Record<string, unknown>;
    const choice = typeof a.choice === 'string' ? a.choice : '';
    const probs: Record<string, number> = {};
    if (a.probabilities && typeof a.probabilities === 'object') {
      for (const [ok, p] of Object.entries(a.probabilities as Record<string, unknown>)) {
        if (typeof p === 'number' && Number.isFinite(p)) probs[ok] = p;
      }
    }
    const score = typeof a.score === 'number' && Number.isFinite(a.score) ? a.score : undefined;
    const noul = typeof a.noul === 'number' && Number.isFinite(a.noul) ? a.noul : undefined;
    if (!choice && Object.keys(probs).length === 0 && score === undefined && noul === undefined) continue;
    answers.set(k, {
      choice,
      probabilities: probs,
      confidence: typeof a.confidence === 'number' && Number.isFinite(a.confidence) ? a.confidence : null,
      ...(score !== undefined ? { score } : {}),
      ...(noul !== undefined ? { noul } : {}),
    });
  }
  const usage = (r.usage ?? {}) as Record<string, unknown>;
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  let cost: number | null = null;
  const pm = (r.provider_metadata ?? {}) as Record<string, unknown>;
  const gw = (pm.gateway ?? {}) as Record<string, unknown>;
  const c = gw.cost ?? usage.cost;
  if (typeof c === 'number' && Number.isFinite(c)) cost = c;
  else if (typeof c === 'string' && Number.isFinite(Number(c))) cost = Number(c);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    answers,
    inputTokens,
    cost,
    model: typeof r.model === 'string' ? r.model : null,
    stateTokens: num(usage.state_tokens),
    serverLatencyMs: num(r.latency_ms),
    warnings: Array.isArray(r.warnings) ? r.warnings.map(String) : [],
  };
}

// ───────────────────────── 逐项是非（Laya） ─────────────────────────

/**
 * 出了事时"反应"那一类的事（其余是日常的下一件；`go_home` 两边都算——吓着了也会回屋）。
 * 逐项是非模式下：先问要不要打断，打断了才在这一类里挑。
 */
export const REACTION_KINDS: ReadonlySet<WorldBrainActKind> = new Set<WorldBrainActKind>([
  'face_player', 'approach_player', 'avoid_player', 'follow_player', 'watch_event', 'gawk_event', 'cower',
  'drop_flat', 'startle', 'flee', 'run_shelter', 'leave', 'go_home', 'charge_player', 'bark', 'honk', 'flap', 'arch',
]);
export const ROUTINE_KINDS: ReadonlySet<WorldBrainActKind> = new Set<WorldBrainActKind>([
  'carry_on', 'go', 'go_home', 'approach_person', 'peck', 'stretch',
]);

/** 逐项是非的几种陈述（**措辞是标定过的**：换措辞要重新标定门槛） */
export const PO_STATEMENT = {
  gate: (label: string) => `「${label}」会放下手上的事，去应付刚才街上的事。`,
  option: (label: string, text: string) => `「${label}」接下来会${text}。`,
  say: (label: string, desc: string) => `「${label}」这会儿会开腔${desc}。`,
  reply: (label: string, text: string) => `「${label}」会${text}。`,
};

export interface PerOptionInput {
  person: ResolvedPerson;
  menu: ActOption[];
  /** 出了事 / 被搭话：问要不要打断 + 各个反应 */
  withGate: boolean;
  /** 手上的事做完了（或还没拿过决定）：问日常的下一件 */
  withRoutine: boolean;
  /** 说话类别 → 说明（出事时问开不开腔；不含"不开腔"） */
  say: Record<string, string> | null;
  /** 回话意图 → 说法（被搭话时） */
  reply: Record<string, string> | null;
}

/**
 * 逐项是非出题：每个选项一道 Noul。键是短的（g / r0 / o0 / s0 / y0），`refs` 带着角色、真键与陈述原文。
 * 一发最多几十道——Laya 在 GPU 上每 32 道一批，照样几十毫秒。
 */
export function buildPerOptionQuestions(it: PerOptionInput): {
  questions: Record<string, JevNoulQuestion>;
  refs: Map<string, QuestionRef>;
} {
  const questions: Record<string, JevNoulQuestion> = {};
  const refs = new Map<string, QuestionRef>();
  const label = it.person.label;
  const npcId = it.person.npcId;
  const add = (key: string, role: PerOptionRole, realKey: string, statement: string) => {
    questions[key] = { type: 'noul', instructions: statement };
    refs.set(key, { npcId, what: 'po', role, key: realKey, statement });
  };
  if (it.withGate) {
    add('g', 'gate', 'gate', PO_STATEMENT.gate(label));
    it.menu.filter((o) => REACTION_KINDS.has(o.kind)).forEach((o, i) => add(`r${i}`, 'react', o.key, PO_STATEMENT.option(label, o.text)));
  }
  if (it.withRoutine) {
    it.menu.filter((o) => ROUTINE_KINDS.has(o.kind)).forEach((o, i) => add(`o${i}`, 'routine', o.key, PO_STATEMENT.option(label, o.text)));
  }
  Object.entries(it.say ?? {}).forEach(([cat, desc], i) => {
    if (cat !== 'silent') add(`s${i}`, 'say', cat, PO_STATEMENT.say(label, desc));
  });
  Object.entries(it.reply ?? {}).forEach(([intent, text], i) => add(`y${i}`, 'reply', intent, PO_STATEMENT.reply(label, text)));
  return { questions, refs };
}

/** 对照请求：给一组陈述问一遍（state 是同一个街面改掉一样东西的反事实 state，见 WorldBrainSystem 的 BaseRef） */
export function buildBaselineRequest(
  state: Record<string, unknown>,
  statements: readonly string[],
): { state: Record<string, unknown>; questions: Record<string, JevNoulQuestion> } {
  const questions: Record<string, JevNoulQuestion> = {};
  statements.forEach((s, i) => { questions[`b${i}`] = { type: 'noul', instructions: s }; });
  return { state, questions };
}

/** 把答案里的短代号换回真键（没有映射表就原样） */
export function unmapAnswer(ans: JevAnswer, keyMap: Record<string, string> | undefined): JevAnswer {
  if (!keyMap) return ans;
  const probabilities: Record<string, number> = {};
  for (const [k, p] of Object.entries(ans.probabilities)) probabilities[keyMap[k] ?? k] = p;
  return { ...ans, choice: keyMap[ans.choice] ?? ans.choice, probabilities };
}

/** 候选按概率从高到低；Jev 选中的那个恒排第一（概率并列 / 缺失时也不丢） */
export function rankOptions(answer: JevAnswer, allowed: readonly string[]): { key: string; p: number }[] {
  const allowedSet = new Set(allowed);
  const rows = Object.entries(answer.probabilities)
    .filter(([k]) => allowedSet.has(k))
    .map(([key, p]) => ({ key, p }));
  if (answer.choice && allowedSet.has(answer.choice) && !rows.some((r) => r.key === answer.choice)) {
    rows.push({ key: answer.choice, p: 1 });
  }
  rows.sort((a, b) => {
    if (a.key === answer.choice) return -1;
    if (b.key === answer.choice) return 1;
    return b.p - a.p;
  });
  return rows;
}
