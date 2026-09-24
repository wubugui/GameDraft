/**
 * 街上的人开腔：台词槽位、挑句子、被搭话时的回话选项。纯函数，不碰游戏对象。
 *
 * ## 句子跟着此刻的情形走
 * 句子可以带槽位（`{event}` `{where}` `{dest}` `{held}`，见 `LINE_SLOTS`）。**填不上槽位的句子这会儿就不用**：
 * 街上没出过事，"刚才那{event}吓死个人"就说不出来——所以台词里从不硬写某一种事（雷、火……），
 * 出了啥事由感知层给一个短名填进去。
 *
 * ## 候选 = 说得出来的
 * 给 Jev 的说话类别 / 回话意图，只列**此刻至少有一句填得上**的——Jev 挑中了却一句都说不出来，
 * 玩家看到的就是"按了 E 没反应"，而且不报错。
 */
import {
  ANIMAL_REPLY_INTENTS,
  HUMAN_REPLY_INTENTS,
  type ReplyIntent,
} from './types';
import type { ResolvedPerson, ResolvedWorldBrainConfig } from './worldBrainConfig';

/** 一句话此刻能填的槽位值；null = 填不上 */
export interface SlotValues {
  event: string | null;
  where: string | null;
  dest: string | null;
  held: string | null;
}

export const NO_SLOTS: SlotValues = { event: null, where: null, dest: null, held: null };

/**
 * 填槽位；有一个填不上就返回 null（这句此刻不能说）。`{where}` 填成"十字口那边"。
 * 没有可空槽位：可空的话"{where}出事了！"在啥都没发生时会变成"出事了！"——要不带地点的说法就另写一句。
 */
export function fillLine(line: string, v: SlotValues): string | null {
  let ok = true;
  const out = line.replace(/\{(\w+)\}/g, (_, k: string) => {
    const val = (v as unknown as Record<string, string | null | undefined>)[k];
    if (!val) {
      ok = false;
      return '';
    }
    return k === 'where' ? `${val}那边` : val;
  });
  return ok ? out : null;
}

/** 一组句子里此刻说得出来的（已填好） */
export function usableLines(pool: readonly string[] | undefined, v: SlotValues): string[] {
  const out: string[] = [];
  for (const l of pool ?? []) {
    const f = fillLine(l, v);
    if (f) out.push(f);
  }
  return out;
}

/**
 * 从几组句子里挑一句：先用排在前面、此刻说得出来的那组（自己的在前、通用的在后），
 * 尽量不跟上一句重样。一句都说不出来返回 null。
 */
export function pickLine(
  pools: readonly (readonly string[] | undefined)[],
  v: SlotValues,
  random: () => number,
  avoid: string | null,
): string | null {
  for (const pool of pools) {
    const lines = usableLines(pool, v);
    if (lines.length === 0) continue;
    const fresh = lines.filter((l) => l !== avoid);
    const list = fresh.length ? fresh : lines;
    return list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  }
  return null;
}

/** 某人某类闲话的句子来源：自己的在前、通用的在后 */
export function sayPools(person: ResolvedPerson, config: ResolvedWorldBrainConfig, category: string): (string[] | undefined)[] {
  return [person.lines[category], config.genericLines[category]];
}

/** 某人的说话选项（`silent` 恒在）：只列此刻至少有一句说得出来的类别 */
export function buildSayOptions(
  person: ResolvedPerson,
  config: ResolvedWorldBrainConfig,
  slots: SlotValues = NO_SLOTS,
): Record<string, string> {
  const out: Record<string, string> = { silent: '不开腔' };
  for (const cat of person.says) {
    const d = config.lineCategories[cat];
    if (!d) continue;
    if (sayPools(person, config, cat).some((p) => usableLines(p, slots).length > 0)) out[cat] = d;
  }
  return out;
}

// ───────────────────────── 被搭话 ─────────────────────────

/** 被搭话那一刻这个人的情形（出题时算好，回包落地时照这份填句子——Jev 是照这份想的） */
export interface ReplyContext {
  /** 他手上正做着自己那摊事（没被挪去干别的） */
  atOwnActivity: boolean;
  /** 正往哪去（地名）；没在赶路为 null */
  headingTo: string | null;
  /** 最近一件值得一说的事（给 Jev 的完整说法）；没有为 null */
  eventText: string | null;
  /** 那件事是不是玩家自己搞出来的 */
  eventByPlayer: boolean;
  /** 玩家此刻显眼的样子（"手上提着点燃的火把、蹲下去了"）；没有为 null */
  playerOddity: string | null;
  slots: SlotValues;
  /** 发道具的职责此刻该给的东西（道具名）；没有职责 / 玩家都有了为 null */
  handOut?: string[] | null;
}

export function replyIntentsFor(person: ResolvedPerson): readonly ReplyIntent[] {
  return person.kind === 'animal' ? ANIMAL_REPLY_INTENTS : HUMAN_REPLY_INTENTS;
}

/** 某人某个回话意图的句子来源：自己的在前、通用的在后（通用回话只给人） */
export function replyPools(
  person: ResolvedPerson,
  config: ResolvedWorldBrainConfig,
  intent: ReplyIntent,
): (string[] | undefined)[] {
  return person.kind === 'animal'
    ? [person.replies[intent]]
    : [person.replies[intent], config.genericReplies[intent]];
}

/**
 * 回话意图 → 给 Jev 的说法（带上此刻的具体情形）。返回 null = 此刻做不到（没出过事就没法"摆那件事"）。
 */
export function replyIntentText(
  intent: ReplyIntent,
  person: ResolvedPerson,
  player: string,
  ctx: ReplyContext,
): string | null {
  switch (intent) {
    case 'greet': return `客客气气招呼${player}，寒暄两句`;
    case 'gossip': return `拉到${player}摆街坊邻居的闲话`;
    case 'busy': return ctx.atOwnActivity ? `说自己正忙着${person.activity}，叫${player}莫打岔` : null;
    case 'trade': return `趁机做${player}的生意`;
    case 'leaving': return ctx.headingTo ? `说自己正要去${ctx.headingTo}，没工夫跟他扯` : null;
    case 'ask_player':
      return ctx.playerOddity
        ? `问${player}（他这会儿${ctx.playerOddity}）在搞啥子名堂`
        : `问${player}找他做啥子`;
    case 'about_event':
      return ctx.eventText ? `跟${player}摆刚才那件事：「${ctx.eventText}」` : null;
    case 'blame':
      return ctx.eventText
        ? `怀疑刚才那件事（「${ctx.eventText}」）${ctx.eventByPlayer ? '就是' : '跟'}${player}${ctx.eventByPlayer ? '搞出来的' : '有关'}，盘问他`
        : null;
    case 'shoo': return `不耐烦，撵${player}走、骂他`;
    case 'scared': return `吓得话都说不伸展，叫${player}莫挨过来`;
    case 'friendly': return `凑过去亲近${player}（摇尾巴、蹭他）`;
    case 'wary': return `往后缩，警惕地盯到${player}`;
    case 'hostile': return `冲${player}龇牙、叫唤，要咬要啄`;
    case 'ignore': return `理都不理${player}，接着${person.activity}`;
    case 'give': return ctx.handOut?.length ? `把${ctx.handOut.map((n) => `「${n}」`).join('')}塞给${player}` : null;
    default: return null;
  }
}

/**
 * 被搭话时的回话选项：此刻做得到、且至少有一句说得出来的意图（不含"不开腔"——搭了话总要有个回应）。
 * 有发道具的职责、此刻有东西该给：只有"把东西塞给他"一种（职责，不让决策服务挑掉）。
 */
export function buildReplyOptions(
  person: ResolvedPerson,
  config: ResolvedWorldBrainConfig,
  ctx: ReplyContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.handOut?.length) {
    const text = replyIntentText('give', person, config.player.label, ctx);
    if (text && replyPools(person, config, 'give').some((p) => usableLines(p, ctx.slots).length > 0)) return { give: text };
  }
  for (const intent of replyIntentsFor(person)) {
    if (intent === 'give') continue;
    const text = replyIntentText(intent, person, config.player.label, ctx);
    if (!text) continue;
    if (!replyPools(person, config, intent).some((p) => usableLines(p, ctx.slots).length > 0)) continue;
    out[intent] = text;
  }
  return out;
}

/** 气泡挂多久：按字数加长，封顶 */
export function bubbleDurationMs(
  text: string,
  t: { bubbleMs: number; bubbleMsPerChar: number; bubbleMaxMs: number },
  bonusMs = 0,
): number {
  const chars = [...text.replace(/\s/g, '')].length;
  return Math.min(t.bubbleMaxMs, Math.max(t.bubbleMs, t.bubbleMs * 0.5 + chars * t.bubbleMsPerChar) + bonusMs);
}
