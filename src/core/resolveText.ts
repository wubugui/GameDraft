import type { FlagStore, FlagValue } from './FlagStore';

/**
 * strings 引用：分类与键与编辑器 TagCatalog / JSON 一致，允许 Unicode（不得仅限 ASCII）。
 * 第一段为 category（不含冒号），余下直至 ] 为 key（可含冒号等）。
 */
const TAG_STRING = /\[tag:string:([^:]+):([^\]]+)\]/g;
const TAG_FLAG = /\[tag:flag:([^\]]+)\]/g;
const TAG_ITEM = /\[tag:item:([^\]]+)\]/g;
const TAG_NPC = /\[tag:npc:([^\]]+)\]/g;
const TAG_PLAYER = /\[tag:player\]/g;
const TAG_QUEST = /\[tag:quest:([^\]]+)\]/g;
const TAG_RULE = /\[tag:rule:([^\]]+)\]/g;
const TAG_SCENE = /\[tag:scene:([^\]]+)\]/g;

export const MAX_RESOLVE_DEPTH = 4;

export interface ResolveContext {
  /** 仅读 strings.json 原文，不解析引用（供 [tag:string] 展开，避免递归） */
  stringsRaw: (category: string, key: string) => string;
  flagStore: FlagStore;
  itemNames?: ReadonlyMap<string, string>;
  /** 场景内优先，否则查全局 NPC 名缓存 */
  npcName: (id: string) => string | undefined;
  playerDisplayName: () => string;
  questTitle: (id: string) => string | undefined;
  ruleName: (id: string) => string | undefined;
  sceneDisplayName: (id: string) => string | undefined;
  /** 图对话 / 脚本上下文 NPC，用于 [tag:npc:@context] */
  contextNpcId?: string;
}

function applyVars(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

function formatFlagValue(
  v: FlagValue | undefined,
  ctx: ResolveContext,
): string {
  const raw = (key: string, vars?: Record<string, string | number>) =>
    applyVars(ctx.stringsRaw('gameTags', key), vars);
  if (v === undefined) return raw('flagUnset');
  if (typeof v === 'boolean') {
    return v ? raw('flagTrue') : raw('flagFalse');
  }
  if (typeof v === 'string') return v;
  return String(v);
}

function warnUnknownTag(kind: string, detail: string): void {
  console.warn(`resolveText: unknown or invalid [tag:${kind}] ${detail}`);
}

/** 将全角括号规范为 ASCII，避免整段 tag 无法被正则识别 */
function normalizeEmbeddedTagsSyntax(s: string): string {
  return s.replace(/［/g, '[').replace(/］/g, ']');
}

/** 解引用完成后的「说话人：正文」里，第一个分隔符的字面量类型（仅 `:` / `：`）。 */
export type SpeakerColonSeparator = ':' | '：';

export interface SplitSpeakerBodyResult {
  speaker: string;
  /** 第一个冒号之后的全文；其中可含更多 `:` / `：`，不再切分 */
  body: string;
  /** 原串中命中的第一个分隔符，便于拼回时保持风格 */
  separator: SpeakerColonSeparator;
}

/**
 * 在 **已完整解引用** 的展示串上，从左到右找 **第一个** ASCII `:` 或全角 `：` 并切一刀：
 * 前半为说话人、后半为正文；正文内其余冒号全部保留。
 *
 * 两半经 trim 后若任一侧为空，返回 null（不把「以冒号开头/结尾」的串当成说话人格式）。
 */
export function splitSpeakerBodyAfterResolve(resolved: string): SplitSpeakerBodyResult | null {
  if (!resolved) return null;
  let sepAt = -1;
  let separator: SpeakerColonSeparator = '：';
  for (let i = 0; i < resolved.length; i++) {
    const c = resolved[i];
    if (c === ':' || c === '：') {
      sepAt = i;
      separator = c;
      break;
    }
  }
  if (sepAt < 0) return null;
  const speaker = resolved.slice(0, sepAt).trim();
  const body = resolved.slice(sepAt + 1).trim();
  if (!speaker || !body) return null;
  return { speaker, body, separator };
}

/**
 * 剧本 playScriptedDialogue：合并「显式 speaker」与正文首冒号说话人。
 * 仅当 resolvedExplicitSpeaker 与 narratorBaselineResolved 相同（JSON 未写 speaker、当前为旁白占位）时，
 * 才对正文做首冒号切分并采用切出的说话人；否则保留显式 speaker，正文不切分。
 */
export function applyDialogueColonSpeakerFromResolvedText(
  resolvedExplicitSpeaker: string,
  textResolvedDisplay: string,
  narratorBaselineResolved: string,
): { speaker: string; text: string } {
  const split = splitSpeakerBodyAfterResolve(textResolvedDisplay);
  if (split && resolvedExplicitSpeaker === narratorBaselineResolved) {
    return { speaker: split.speaker, text: split.body };
  }
  return { speaker: resolvedExplicitSpeaker, text: textResolvedDisplay };
}

/**
 * 统一解析玩家可见字符串中的项目级引用（just-in-time）。
 * 多轮替换直至无变化或达到 MAX_RESOLVE_DEPTH。
 */
export function resolveText(raw: string | undefined, ctx: ResolveContext): string {
  if (raw === undefined || raw === '') return '';
  let out = normalizeEmbeddedTagsSyntax(raw);
  for (let pass = 0; pass < MAX_RESOLVE_DEPTH; pass++) {
    const prev = out;

    out = out.replace(TAG_STRING, (_m, cat: string, key: string) => {
      return ctx.stringsRaw(String(cat), String(key));
    });

    out = out.replace(TAG_FLAG, (_m, flagKey: string) => {
      const k = String(flagKey).trim();
      if (!k) {
        warnUnknownTag('flag', '(empty)');
        return _m;
      }
      return formatFlagValue(ctx.flagStore.get(k), ctx);
    });

    out = out.replace(TAG_ITEM, (_m, itemId: string) => {
      const id = String(itemId).trim();
      if (!id) {
        warnUnknownTag('item', '(empty)');
        return _m;
      }
      const name = ctx.itemNames?.get(id);
      if (name !== undefined && name !== '') return name;
      return applyVars(ctx.stringsRaw('gameTags', 'unknownItem'), { id });
    });

    out = out.replace(TAG_NPC, (_m, idPart: string) => {
      let id = String(idPart).trim();
      if (!id || id === '@context') {
        id = (ctx.contextNpcId ?? '').trim();
      }
      if (!id) {
        warnUnknownTag('npc', 'no id and no context');
        return '…';
      }
      const n = ctx.npcName(id);
      if (n !== undefined && n !== '') return n;
      return id;
    });

    out = out.replace(TAG_PLAYER, () => ctx.playerDisplayName());

    out = out.replace(TAG_QUEST, (_m, qid: string) => {
      const id = String(qid).trim();
      if (!id) {
        warnUnknownTag('quest', '(empty)');
        return _m;
      }
      const t = ctx.questTitle(id);
      return t !== undefined && t !== '' ? t : id;
    });

    out = out.replace(TAG_RULE, (_m, rid: string) => {
      const id = String(rid).trim();
      if (!id) {
        warnUnknownTag('rule', '(empty)');
        return _m;
      }
      const n = ctx.ruleName(id);
      return n !== undefined && n !== '' ? n : id;
    });

    out = out.replace(TAG_SCENE, (_m, sid: string) => {
      const id = String(sid).trim();
      if (!id) {
        warnUnknownTag('scene', '(empty)');
        return _m;
      }
      const n = ctx.sceneDisplayName(id);
      return n !== undefined && n !== '' ? n : id;
    });

    if (out === prev) break;
  }
  return out;
}

/** @deprecated 使用 resolveText；保留给尚未注入 ResolveContext 的过渡代码 */
export type StringLookup = (
  category: string,
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface ExpandGameTagsOptions {
  strings: StringLookup;
  flagStore: FlagStore;
  itemNames?: ReadonlyMap<string, string>;
}

/**
 * @deprecated 使用 resolveText + Game.buildResolveContext
 */
export function expandGameTags(raw: string, opts: ExpandGameTagsOptions): string {
  const playerDisplayName = (): string => {
    const v = opts.flagStore.get('player_display_name');
    if (typeof v === 'string' && v.trim()) return v.trim();
    const fb = opts.strings('dialogue', 'defaultProtagonistName');
    return fb && fb !== 'defaultProtagonistName' ? fb : '你';
  };
  return resolveText(raw, {
    stringsRaw: (c, k) => opts.strings(c, k),
    flagStore: opts.flagStore,
    itemNames: opts.itemNames,
    npcName: () => undefined,
    playerDisplayName,
    questTitle: () => undefined,
    ruleName: () => undefined,
    sceneDisplayName: () => undefined,
    contextNpcId: '',
  });
}
