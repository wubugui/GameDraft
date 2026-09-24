/**
 * 世界脑的"五官"：把世界里**实际发生**的东西翻成街上的人看得见、听得见的一句话。
 *
 * 通用，不认技能：雷符、将来的任何技能 / 道具 / 过场 / 叙事演出，只要落到引擎的通用动作
 * （压暗天色、闪屏、震屏、起风、落雷、放声音、实体出现消失、有人喊话……）或者在世界里
 * 冒出一个粒子效果，就会被看见——说法来自**动作类型**与**资产自带的名字**
 * （粒子效果的 `label`、道具的名字与说明、挂件预设的 `label`），不来自任何逐技能配置。
 *
 * 这里只管"发生了啥、在哪"；**这事吓不吓人、值不值得看，由 Jev 判断**（见 jevProtocol 的显著度题），
 * 本地不写死任何分数。不认识的动作类型一律不报（绝大多数是存档 / 叙事 / UI 这类街上看不见的事）。
 */

export interface SenseHelpers {
  /** 场上某实体（NPC / 热点 / 演员）的显示名 */
  entityName: (id: string) => string | null;
  /** 场上某实体的位置 */
  entityPos: (id: string) => { x: number; y: number } | null;
  /** 世界脑自己接管的人（他们自己的动作不算"街上发生的事"） */
  isOwnActor: (id: string) => boolean;
  playerLabel: string;
  /**
   * 音效在街上的人听来是啥（世界脑数据的事件说法表 `soundWords`；音效资产本身没有中文名）。
   * 没写的返回 null——说成"一阵响动"，**绝不把英文素材名塞给模型**（09-22 实测 state 里出现过"（thunder near）"）。
   */
  soundWord: (sfxId: string) => string | null;
}

export interface Sensed {
  text: string;
  at?: { x: number; y: number };
  /** true = 全街都感觉得到（天色、闪光、震动）；false = 离得近的才注意到 */
  global: boolean;
  /** 街上的人嘴里怎么叫它（台词写成"那{event}"）；没有 = 没法拿来摆 */
  gist?: string;
  /** 是玩家自己搞出来的 */
  byPlayer?: boolean;
}

/** 资产 id → 人话兜底（`sfx_thunder_crack` → `thunder crack`）。Jev 读得懂英文词。 */
export function humanizeId(id: string): string {
  return id
    .replace(/^(sfx|vfx|fx|bgm|amb)_/i, '')
    .replace(/_\d+$/g, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

/**
 * 粒子效果的 `label`（作者写的中文说明，常见形如"雷云：压在头顶的一片厚云（…）"、
 * "天雷 01：介质击穿模型…"）→ 取冒号前的名字、去掉编号；没有 label 用 id 兜底。
 */
export function effectName(label: string | null, effectId: string): string {
  const raw = (label ?? '').trim();
  if (!raw) return humanizeId(effectId);
  const head = raw.split(/[：:]/)[0].trim();
  return head.replace(/\s*\d+$/, '').trim() || humanizeId(effectId);
}

/**
 * 给模型看的粒子效果名：只认作者写的中文 label；没有 label 返回 null（调用方说成"一样看不清的东西"），
 * **不退回英文 id**——`effectName` 的 id 兜底只给内部合并键用。
 */
export function spokenEffectName(label: string | null): string | null {
  const raw = (label ?? '').trim();
  if (!raw) return null;
  return effectName(raw, '') || null;
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 动作参数里的位置（`x`/`y`，或 `target` 指向的实体） */
function paramPos(p: Record<string, unknown>, h: SenseHelpers): { x: number; y: number } | undefined {
  const x = Number(p.x);
  const y = Number(p.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  const t = str(p.target);
  if (t && t !== 'player') return h.entityPos(t) ?? undefined;
  return undefined;
}

/**
 * 引擎动作 → 街上的人感知到的一句话。按**动作类型**（引擎词汇）写，不按技能写。
 * 粒子效果与放声音由各自系统的旁听另外报（代码里直接放的雷、火也要看得见），这里不重复。
 */
export function describeAction(type: string, p: Record<string, unknown>, h: SenseHelpers): Sensed | null {
  switch (type) {
    case 'setSceneDim': {
      const s = num(p.scale, 1);
      if (s >= 0.98) return { text: '天色又亮开了', global: true };
      if (s < 0.45) return { text: '天一下黑得像锅底，伸手快看不清人', global: true, gist: '黑天' };
      return { text: '天色一下暗了下来', global: true, gist: '黑天' };
    }
    case 'screenFlash':
      return { text: '一道刺眼的白光闪过，照得满街雪亮', global: true, gist: '白光' };
    case 'cameraShake':
      return num(p.amplitude, 0) > 0 ? { text: '地面猛地震了一下', global: true, gist: '一震' } : null;
    case 'sceneWindGust': {
      const k = num(p.speedMultiplier, 1);
      return k >= 2.5
        ? { text: '平地起了一阵狂风，吹得东西满街乱飞', global: true, gist: '怪风' }
        : { text: '起了一阵风', global: true, gist: '阵风' };
    }
    case 'strikeThreat':
      return { text: '天上打起炸雷来，雷往下劈', global: true, gist: '炸雷' };
    case 'playSfx': {
      const id = str(p.id);
      if (!id) return null;
      const word = h.soundWord(id);
      return { text: word ?? '传来一阵响动', global: true, gist: '响动' };
    }
    case 'showSpeechBubble':
    case 'showSpeechBubbleAndWait': {
      const t = str(p.target);
      const text = str(p.text);
      if (!t || !text || h.isOwnActor(t)) return null;
      const who = t === 'player' ? h.playerLabel : h.entityName(t) ?? '有人';
      return {
        text: `${who}喊了一句：「${text.slice(0, 40)}」`, at: paramPos(p, h), global: false,
        gist: '一嗓子', byPlayer: t === 'player',
      };
    }
    case 'setEntityEnabled': {
      const t = str(p.target);
      if (!t || h.isOwnActor(t)) return null;
      const name = h.entityName(t);
      if (!name) return null;
      const on = p.enabled === true || p.enabled === 'true';
      return { text: on ? `${name}冒了出来` : `${name}不见了`, at: paramPos(p, h), global: false, gist: shortGist(name) };
    }
    case 'cutsceneSpawnActor': {
      const name = str(p.name) || h.entityName(str(p.id)) || '一个人';
      return { text: `${name}冒了出来`, at: paramPos(p, h), global: false, gist: shortGist(name) };
    }
    default:
      return null;
  }
}

/** 世界里冒出 / 收掉了一个粒子效果 */
export function describeVfx(kind: 'start' | 'stop', name: string, where: string | null): Sensed['text'] {
  if (kind === 'stop') return `${name}散了`;
  return where ? `${where}那边出现了${name}` : `出现了${name}`;
}

/** 资产 label 里作者自己的备注（"桃木剑（占位图标美术）"的括号）不是东西的名字，街上的人嘴里不带它 */
export function spokenName(label: string | null | undefined): string {
  return (label ?? '').replace(/[（(][^）)]*[）)]/g, '').trim();
}

/**
 * 名字当短名用：太长的（作者写成一句话的 label）说出来不像人话，退成"动静"。
 * 句子写成"那{event}"，所以短名是名词（"白光"、"雷符"、"一嗓子"）。
 */
export function shortGist(name: string | null | undefined): string {
  const n = spokenName(name);
  return n && [...n].length <= 6 ? n : '动静';
}

// 玩家干的事（身体动词、用道具、找人说话……）不在这里：一律走引擎的玩家状态串（src/systems/PlayerActivity.ts）

/** 燃烧状态（BurnSystem 的 burnState）→ 说法 */
export function describeBurn(to: string, name: string): string | null {
  if (to === 'burning') return `${name}烧起来了，冒起火苗`;
  if (to === 'out') return `${name}上的火灭了`;
  if (to === 'burnt') return `${name}烧成了一堆灰`;
  return null;
}
