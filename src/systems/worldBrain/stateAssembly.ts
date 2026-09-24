/**
 * state 拼装：**配方 + 快照 → state**，一个纯函数（设计稿 §12.2）。
 *
 * 游戏和体检台共用这一份代码，保证发给模型的 state 一字不差。同样的配方、同样的快照，永远拼出同一份 state
 * （不看时钟、不看随机数、不看任何外部状态）。
 *
 * - **快照**（{@link StateSnapshot}）：调用方从街面现取、已经写成话的各栏（这个人是谁、在干啥、心头、
 *   这一簇他感知到的事、看法、记得的事……）。
 * - **配方**（{@link StateRecipe}）：每类题放哪几栏、按什么次序、每栏最多几条、超了题目预算先裁哪栏——
 *   放在世界脑数据里（缺省见 {@link DEFAULT_RECIPES}，数据里可以整条覆盖）。
 * - **对照**（{@link counterfactualSnapshot}）：去掉刚才的事 / 只换新证据 / 身份换成泛称 / 关二狗只是路过 /
 *   记得的事全换成中性占位——都是对**快照**的纯变换，条数不变，拼出来的 state **结构和长度不变**
 *   （避免"写得越长、换掉以后变化越大"的长度偏差，§12.4）。
 */

/** state 的一栏 */
export type StateField =
  // 街面
  | 'brief' | 'setting' | 'time' | 'weather' | 'events'
  // 关二狗
  | 'player' | 'playerActivity' | 'playerRecent'
  // 这个人
  | 'identity' | 'temper' | 'where' | 'doing' | 'doingFor' | 'playerDistance' | 'nearby'
  | 'heart' | 'attitudeToActor' | 'attitudeToPlayer' | 'memories' | 'dialogue' | 'enteredState'
  | 'axisLevel' | 'evidence' | 'relationToSpeaker' | 'heardLine';

export const STATE_FIELDS: readonly StateField[] = [
  'brief', 'setting', 'time', 'weather', 'events', 'player', 'playerActivity', 'playerRecent',
  'identity', 'temper', 'where', 'doing', 'doingFor', 'playerDistance', 'nearby',
  'heart', 'attitudeToActor', 'attitudeToPlayer', 'memories', 'dialogue', 'enteredState',
  'axisLevel', 'evidence', 'relationToSpeaker', 'heardLine',
];

/** 可以按条数裁的栏 */
export type StateListField = 'events' | 'nearby' | 'memories' | 'evidence' | 'playerRecent' | 'dialogue';
const LIST_FIELDS = new Set<StateField>(['events', 'nearby', 'memories', 'evidence', 'playerRecent', 'dialogue']);
/** 按时间排的列表栏：超了留**最新**的（在后）；其余（近的 / 钉住的在前）留最前的 */
const NEWEST_LAST = new Set<StateListField>(['events', 'playerRecent', 'dialogue']);

/** 快照：各栏已经写成话（调用方负责措辞；这里只管放不放、放几条、怎么裁） */
export interface StateSnapshot {
  /** 一句话街面（短，带上街坊怕啥信啥：显著度题用它） */
  brief?: string;
  /** 长一点的街面说明 */
  setting?: string;
  time?: string;
  /** 世界此刻的样子：天色、风、雨……（引擎现报，写成话） */
  weather?: string;
  /** 这一簇他感知到的事，旧的在前、新的在后（已经带上"多久以前"） */
  events?: string[];
  player?: {
    /** 关二狗在 state 里的称呼（也是一栏的键名） */
    label: string;
    identity?: string;
    where?: string;
    doing?: string;
    holding?: string | null;
    /** 玩家状态串：他刚才干了啥 */
    activity?: string | null;
    /** 他最近干的几件事（玩家状态串的记录），旧的在前 */
    recent?: string[];
  };
  person?: {
    /** 这个人在 state 里的称呼（他那一节的键名） */
    label: string;
    identity?: string;
    /** 乙对照用的同类泛称（"街上一个摆面摊的"） */
    genericIdentity?: string;
    temper?: string;
    where?: string;
    doing?: string;
    doingFor?: string;
    playerDistance?: string;
    /** 看得见的人，近的在前 */
    nearby?: string[];
    heart?: string;
    /** 对这件事起头的人的看法说法（`{actor}` 是那人的称呼，作键名） */
    attitudeToActor?: { actor: string; text: string };
    attitudeToPlayer?: string;
    /** 记得的事，钉住的在前 */
    memories?: string[];
    /** 这回跟关二狗说过的话（一句一条，"谁：说了啥"），旧的在前 */
    dialogue?: string[];
    /** 进的这个状态（开腔题） */
    enteredState?: string;
    /** 这一轴当前档的说法（看法题） */
    axisLevel?: string;
    /** 依据记忆（看法题）；`fresh` 标这次新进的证据（甲′ 对照只换它们） */
    evidence?: { text: string; fresh: boolean }[];
    /**
     * 跟传话那个人的关系（信不信题）。键名带上那人的称呼（"跟跑腿伙计"）：只写"跟说话的人"时模型认不出是谁，
     * 关系好坏对信不信几乎没影响（2026-09-22 Jev 实测）。
     */
    relationToSpeaker?: { speaker: string; text: string };
    /** 听到的那句（信不信题） */
    heardLine?: string;
  };
}

/** 超了预算时的一步裁剪：列表栏依次裁到 `keep` 里的条数（0 = 整栏去掉）；文字栏截到 `clip` 个字 */
export type TrimStep = { field: StateListField; keep: number[] } | { field: StateField; clip: number };

export interface StateRecipe {
  /** 放哪几栏；同一节里按这里的次序排 */
  fields: StateField[];
  /** 列表栏最多几条（events 取最新的，其余取最前的） */
  limits?: Partial<Record<StateListField, number>>;
  /** 超了 token 预算时按这个次序裁，裁到预算内为止（裁完还超就照发，服务端会截断并在 warnings 里说） */
  trim?: TrimStep[];
}

/** 配方的名字：显著度 / 放下 / 反应 / 日常 / 走近 / 开腔 / 回话 / 看法 / 信不信，外加旧版一人一发的整份 */
export type RecipeId =
  | 'salience' | 'gate' | 'react' | 'routine' | 'approach' | 'voice' | 'reply' | 'attitude' | 'belief' | 'legacy';

/**
 * 每类题**绝不放**的栏：只剩结构上说不通的——显著度题问的是"街上的人会不会怕"，没有"这个人"，放人的栏没意义。
 *
 * ⚠ 2026-09-22 制作人定：**每道题都给全量上下文**（性格、此刻在做啥、在哪、天气、离关二狗多远、身边有谁在干啥、
 * 关二狗的样子和刚才干的事、看法、心头、记得的事、这回说过的话……），只按模型的容量裁。之前按 Laya 的毛病
 * （窗口 2048、写满了就全答 0.9+）定的"放下 / 反应不放看得见的人"之类的禁令作废——那是 Laya 读不全，
 * 不是这道题不该看；Laya 读不全、判得差，就是低配。
 */
export const RECIPE_FORBIDDEN: Partial<Record<RecipeId, readonly StateField[]>> = {
  salience: [
    'identity', 'temper', 'where', 'doing', 'doingFor', 'playerDistance', 'nearby', 'heart',
    'attitudeToActor', 'attitudeToPlayer', 'memories', 'dialogue', 'enteredState', 'axisLevel', 'evidence',
    'relationToSpeaker', 'heardLine',
  ],
};

/** 一个人的全量上下文：街面 + 天气 + 关二狗（样子、刚才干的几件事）+ 这一簇的事 + 这个人的一切 */
const PERSON_FULL: StateField[] = [
  'setting', 'time', 'weather', 'player', 'playerActivity', 'playerRecent', 'events',
  'identity', 'temper', 'where', 'doing', 'doingFor', 'playerDistance', 'nearby', 'heart',
  'attitudeToPlayer', 'attitudeToActor', 'memories', 'dialogue',
];

/**
 * 超了模型容量时才裁（Jev 一发上万 token 照常回，基本不裁；Laya 只能读约 2000，裁到读得下为止）：
 * 先裁久远的——老话、次要的记忆、远处的人、关二狗更早干的事、较早的事——最后才截身份和街面说明。
 */
const FULL_TRIM: TrimStep[] = [
  { field: 'dialogue', keep: [8, 4, 2] },
  { field: 'memories', keep: [4, 2, 1] },
  { field: 'nearby', keep: [4, 2, 1] },
  { field: 'playerRecent', keep: [3, 1, 0] },
  { field: 'events', keep: [4, 2, 1] },
  { field: 'evidence', keep: [2, 1] },
  { field: 'identity', clip: 60 },
  { field: 'setting', clip: 60 },
];

/** 缺省配方（数据里没写就用它；数据里写了整条覆盖） */
export const DEFAULT_RECIPES: Record<RecipeId, StateRecipe> = {
  salience: { fields: ['brief', 'time', 'weather', 'events'], limits: { events: 1 } },
  gate: { fields: PERSON_FULL, trim: FULL_TRIM },
  react: { fields: PERSON_FULL, trim: FULL_TRIM },
  routine: { fields: PERSON_FULL, trim: FULL_TRIM },
  approach: { fields: PERSON_FULL, trim: FULL_TRIM },
  voice: { fields: [...PERSON_FULL, 'enteredState'], trim: FULL_TRIM },
  reply: { fields: PERSON_FULL, trim: FULL_TRIM },
  attitude: { fields: [...PERSON_FULL, 'axisLevel', 'evidence'], trim: FULL_TRIM },
  belief: { fields: [...PERSON_FULL, 'relationToSpeaker', 'heardLine'], trim: FULL_TRIM },
  // 旧版（选择题 / 逐项是非第一版）一人一发的整份 state，与 2026-09-22 之前的 buildPersonState 逐字相同
  legacy: {
    fields: ['setting', 'time', 'player', 'events', 'identity', 'temper', 'where', 'doing', 'doingFor', 'playerDistance', 'nearby'],
    limits: { events: 6, nearby: 4 },
    trim: [
      { field: 'nearby', keep: [2, 0] },
      { field: 'events', keep: [4, 2, 1] },
      { field: 'identity', clip: 40 },
      { field: 'setting', clip: 40 },
    ],
  },
};

/** state 里各栏的键名（发给模型的就是这些字）；`{player}` / `{actor}` 换成称呼 */
const KEYS = {
  place: '地方',
  time: '时辰',
  events: '刚才街上发生的事',
  playerIdentity: '是啥子人',
  where: '在哪',
  doing: '在做啥子',
  holding: '手上',
  activity: '刚才',
  identity: '是啥子',
  temper: '脾气',
  doingFor: '做了多久',
  playerDistance: '离{player}',
  nearby: '看得见的人',
  heart: '心头',
  attitudeToActor: '对{actor}的看法',
  attitudeToPlayer: '对{player}的看法',
  memories: '记得的事',
  enteredState: '这会儿',
  axisLevel: '看法',
  evidence: '依据',
  relationToSpeaker: '跟{speaker}',
  heardLine: '听到有人说',
  weather: '天气',
  playerRecent: '先前干的事',
  dialogue: '这回跟{player}说的话',
} as const;

/** 中性占位与空栏的说法（数据里可以改；§12.4 的对照都用这几句） */
export interface StateTexts {
  /** 一件事都没有时"刚才街上发生的事"那一栏 */
  noEvents: string;
  /** 甲对照：每件事换成这一句（条数不变） */
  neutralEvent: string;
  /** 丁对照：每条记得的事换成这一句 */
  neutralMemory: string;
  /** 甲′对照：每条新证据换成这一句 */
  neutralEvidence: string;
  /** 乙对照：脾气换成这一句 */
  neutralTemper: string;
  /** 乙对照：没写同类泛称时身份换成这一句 */
  genericIdentity: string;
  /** 丙对照：关二狗在做啥子换成这一句 */
  passerby: string;
  /** 甲对照（信不信题）：听到的那句换成这一句 */
  neutralHeard: string;
}

export const DEFAULT_STATE_TEXTS: StateTexts = {
  noEvents: '没得啥子特别的事',
  neutralEvent: '街上没得啥子事',
  neutralMemory: '记不起啥子',
  neutralEvidence: '没得啥子新鲜事',
  neutralTemper: '说不上来',
  genericIdentity: '街上的一个人',
  passerby: '只是从街上路过',
  neutralHeard: '有人说了句家常话',
};

/**
 * state 的 token 估算（偏保守）。实测 Laya 的中文模型：2583 个字符的 JSON state = 1937 token（0.75/字符）。
 * 只用来裁剪、不用来计费；真实数以返回的 `usage.state_tokens` 为准。
 */
export function estimateStateTokens(obj: unknown): number {
  return Math.ceil(JSON.stringify(obj ?? '').length * 0.8);
}

function clipText(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : `${chars.slice(0, n).join('')}…`;
}

/** 列表栏按上限取：按时间排的（事、关二狗先前干的、说过的话）取最新的（在后），其余取最前的（近的 / 钉住的在前） */
function takeList(field: StateListField, list: readonly string[], n: number): string[] {
  if (n <= 0) return [];
  return NEWEST_LAST.has(field) ? list.slice(-n) : list.slice(0, n);
}

/** 列表栏在快照里的原始内容 */
function listSource(snap: StateSnapshot, field: StateListField): readonly string[] | undefined {
  switch (field) {
    case 'events': return snap.events;
    case 'playerRecent': return snap.player?.recent;
    case 'evidence': return snap.person?.evidence?.map((e) => e.text);
    default: return snap.person?.[field];
  }
}

function present(s: string | null | undefined): s is string {
  return typeof s === 'string' && s.length > 0;
}

/**
 * **配方 + 快照 → state**（纯函数）。
 *
 * 版面固定：`地方` → `时辰` → `天气` → 关二狗那一节 → `刚才街上发生的事` → 这个人那一节；每节里按配方的次序。
 * 快照里没有的栏不出现（`刚才街上发生的事` 例外：配方里有它就一定出现，没事写 `noEvents`）。
 * 超了 `budget`（估算 token）按配方的 `trim` 依次裁，裁到预算内为止。
 */
export function assembleState(
  recipe: StateRecipe,
  snap: StateSnapshot,
  opts: { budget?: number; texts?: StateTexts } = {},
): Record<string, unknown> {
  const texts = opts.texts ?? DEFAULT_STATE_TEXTS;
  const want = new Set(recipe.fields);
  const order = (f: StateField) => recipe.fields.indexOf(f);
  // 裁剪状态：列表栏此刻最多几条、文字栏此刻最多几个字
  const listCap = new Map<StateListField, number>();
  for (const f of LIST_FIELDS) {
    const lim = recipe.limits?.[f as StateListField];
    listCap.set(f as StateListField, typeof lim === 'number' ? lim : Infinity);
  }
  const clipCap = new Map<StateField, number>();

  const text = (f: StateField, v: string | null | undefined): string | null => {
    if (!present(v)) return null;
    const c = clipCap.get(f);
    return c === undefined ? v : clipText(v, c);
  };
  const list = (f: StateListField, v: readonly string[] | undefined): string[] => takeList(f, v ?? [], listCap.get(f) ?? Infinity);

  const make = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    // 街面
    if (want.has('brief') && present(snap.brief)) out[KEYS.place] = text('brief', snap.brief);
    else if (want.has('setting') && present(snap.setting)) out[KEYS.place] = text('setting', snap.setting);
    if (want.has('time') && present(snap.time)) out[KEYS.time] = snap.time;
    if (want.has('weather') && present(snap.weather)) out[KEYS.weather] = snap.weather;
    // 关二狗
    const pl = snap.player;
    if (pl && (want.has('player') || want.has('playerActivity') || want.has('playerRecent'))) {
      const p: Record<string, unknown> = {};
      if (want.has('player')) {
        if (present(pl.identity)) p[KEYS.playerIdentity] = pl.identity;
        if (present(pl.where)) p[KEYS.where] = pl.where;
        if (present(pl.doing)) p[KEYS.doing] = pl.doing;
        if (present(pl.holding)) p[KEYS.holding] = pl.holding;
      }
      if (want.has('playerActivity') && present(pl.activity)) p[KEYS.activity] = pl.activity;
      if (want.has('playerRecent')) {
        const recent = list('playerRecent', pl.recent);
        if (recent.length) p[KEYS.playerRecent] = recent;
      }
      if (Object.keys(p).length) out[pl.label] = p;
    }
    // 这一簇他感知到的事
    if (want.has('events')) {
      const ev = list('events', snap.events);
      out[KEYS.events] = ev.length ? ev : [texts.noEvents];
    }
    // 这个人
    const me = snap.person;
    if (me) {
      const m: Array<[number, string, unknown]> = [];
      const put = (f: StateField, key: string, v: unknown): void => {
        if (!want.has(f)) return;
        if (v === null || v === undefined || v === '') return;
        if (Array.isArray(v) && v.length === 0) return;
        m.push([order(f), key, v]);
      };
      put('identity', KEYS.identity, text('identity', me.identity));
      put('temper', KEYS.temper, text('temper', me.temper));
      put('where', KEYS.where, me.where);
      put('doing', KEYS.doing, me.doing);
      put('doingFor', KEYS.doingFor, me.doingFor);
      if (pl) put('playerDistance', KEYS.playerDistance.replace('{player}', pl.label), me.playerDistance);
      put('nearby', KEYS.nearby, list('nearby', me.nearby));
      put('heart', KEYS.heart, me.heart);
      if (me.attitudeToActor) put('attitudeToActor', KEYS.attitudeToActor.replace('{actor}', me.attitudeToActor.actor), me.attitudeToActor.text);
      if (pl) put('attitudeToPlayer', KEYS.attitudeToPlayer.replace('{player}', pl.label), me.attitudeToPlayer);
      put('memories', KEYS.memories, list('memories', me.memories));
      if (pl) put('dialogue', KEYS.dialogue.replace('{player}', pl.label), list('dialogue', me.dialogue));
      put('enteredState', KEYS.enteredState, me.enteredState);
      put('axisLevel', KEYS.axisLevel, me.axisLevel);
      put('evidence', KEYS.evidence, list('evidence', (me.evidence ?? []).map((e) => e.text)));
      if (me.relationToSpeaker) {
        put('relationToSpeaker', KEYS.relationToSpeaker.replace('{speaker}', me.relationToSpeaker.speaker), me.relationToSpeaker.text);
      }
      put('heardLine', KEYS.heardLine, me.heardLine);
      m.sort((a, b) => a[0] - b[0]);
      if (m.length) out[me.label] = Object.fromEntries(m.map(([, k, v]) => [k, v]));
    }
    return out;
  };

  let st = make();
  if (opts.budget === undefined) return st;
  for (const step of recipe.trim ?? []) {
    if ('keep' in step) {
      const lengthNow = (): number => list(step.field, listSource(snap, step.field)).length;
      for (const k of step.keep) {
        if (estimateStateTokens(st) <= opts.budget) return st;
        if (lengthNow() <= k) continue;
        listCap.set(step.field, k);
        st = make();
      }
    } else {
      if (estimateStateTokens(st) <= opts.budget) return st;
      const src = step.field === 'setting' ? snap.setting : step.field === 'brief' ? snap.brief
        : (snap.person as Record<string, unknown> | undefined)?.[step.field];
      if (typeof src !== 'string' || [...src].length <= step.clip) continue;
      clipCap.set(step.field, step.clip);
      st = make();
    }
  }
  return st;
}

/** §12.4 的对照 */
export type Counterfactual =
  /** 甲：去掉"刚才这一下"——每件事换成中性占位（条数不变）；信不信题里听到的那句也换成中性的 */
  | 'noEvents'
  /** 甲′：只把这次新进的证据换成中性占位，钉住的不动 */
  | 'noFreshEvidence'
  /** 乙：身份换成同类泛称、脾气换成中性说法 */
  | 'anon'
  /** 丙：关二狗只是路过 */
  | 'passerby'
  /** 丁：记得的事全换成中性占位（只用来单独量记性有没有用） */
  | 'noMemories';

/** 对照 = 对快照的纯变换：只改那一样，条数、结构不变 */
export function counterfactualSnapshot(snap: StateSnapshot, kind: Counterfactual, texts: StateTexts = DEFAULT_STATE_TEXTS): StateSnapshot {
  switch (kind) {
    case 'noEvents': {
      const out: StateSnapshot = { ...snap, events: (snap.events ?? []).map(() => texts.neutralEvent) };
      if (snap.person && present(snap.person.heardLine)) out.person = { ...snap.person, heardLine: texts.neutralHeard };
      return out;
    }
    case 'noFreshEvidence':
      return snap.person
        ? { ...snap, person: { ...snap.person, evidence: (snap.person.evidence ?? []).map((e) => (e.fresh ? { text: texts.neutralEvidence, fresh: true } : e)) } }
        : snap;
    case 'anon':
      return snap.person
        ? {
          ...snap,
          person: {
            ...snap.person,
            identity: snap.person.genericIdentity ?? texts.genericIdentity,
            temper: present(snap.person.temper) ? texts.neutralTemper : snap.person.temper,
          },
        }
        : snap;
    case 'passerby':
      return snap.player
        ? {
          ...snap,
          player: {
            ...snap.player, doing: texts.passerby, holding: null, activity: null,
            ...(snap.player.recent ? { recent: snap.player.recent.map(() => texts.passerby) } : {}),
          },
        }
        : snap;
    case 'noMemories':
      return snap.person
        ? { ...snap, person: { ...snap.person, memories: (snap.person.memories ?? []).map(() => texts.neutralMemory) } }
        : snap;
  }
}

/** 配方表：数据里写了的整条覆盖缺省；另查"绝不放"的栏与不认识的栏（给配置校验用） */
export function resolveRecipes(raw: unknown): { recipes: Record<RecipeId, StateRecipe>; errors: string[] } {
  const recipes: Record<RecipeId, StateRecipe> = { ...DEFAULT_RECIPES };
  const errors: string[] = [];
  if (raw && typeof raw === 'object') {
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!(id in DEFAULT_RECIPES)) {
        errors.push(`配方「${id}」不认识（认：${Object.keys(DEFAULT_RECIPES).join(' / ')}）`);
        continue;
      }
      const r = v as Partial<StateRecipe> | null;
      if (!r || !Array.isArray(r.fields)) {
        errors.push(`配方「${id}」缺 fields`);
        continue;
      }
      const bad = r.fields.filter((f) => !STATE_FIELDS.includes(f as StateField));
      if (bad.length) errors.push(`配方「${id}」有不认识的栏：${bad.join('、')}`);
      recipes[id as RecipeId] = {
        fields: r.fields.filter((f): f is StateField => STATE_FIELDS.includes(f as StateField)),
        ...(r.limits ? { limits: r.limits } : {}),
        ...(Array.isArray(r.trim) ? { trim: r.trim } : {}),
      };
    }
  }
  for (const [id, forbidden] of Object.entries(RECIPE_FORBIDDEN) as [RecipeId, readonly StateField[]][]) {
    const hit = recipes[id].fields.filter((f) => forbidden.includes(f));
    if (hit.length) errors.push(`配方「${id}」不许放：${hit.join('、')}（§12.2）`);
  }
  return { recipes, errors };
}
