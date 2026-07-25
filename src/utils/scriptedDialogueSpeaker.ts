import type { FlagStore } from '../core/FlagStore';
import type { StringsProvider } from '../core/StringsProvider';
import type { SceneManager } from '../systems/SceneManager';

export type ScriptedSpeakerResolveCtx = {
  strings: StringsProvider;
  flagStore: FlagStore;
  sceneManager: SceneManager;
  /** 图对话 startDialogueGraph 传入的 npcId（仅图对话激活时有值） */
  graphDialogueNpcId: string;
  /** playScriptedDialogue.params.scriptedNpcId（过场/热区等写入） */
  fallbackNpcId: string;
};

/**
 * 保留实体 id：`player` 恒指主角，不是场景 NPC（与 `Game.resolveActor` 的保留 id 同口径）。
 * 说话人下拉（scriptedNpcId / `{{npc:player}}`）填它即表示「这句是主角说的」。
 */
export const PLAYER_ENTITY_ID = 'player';

/** `{{player}}` 与 `{{npc:player}}` 共用的玩家显示名。 */
function playerDisplayName(ctx: Pick<ScriptedSpeakerResolveCtx, 'strings' | 'flagStore'>): string {
  const v = ctx.flagStore.get('player_display_name');
  if (typeof v === 'string' && v.trim()) return v.trim();
  const fb = ctx.strings.get('dialogue', 'defaultProtagonistName');
  return fb && fb !== 'defaultProtagonistName' ? fb : '你';
}

/**
 * 解析 playScriptedDialogue 的 speaker 字段中的占位：
 * - `{{player}}`：玩家显示名（与图对话 resolveSpeaker player 一致）
 * - `{{npc}}` 或 `{{npc:@context}}`：当前上下文 NPC（优先图对话 npcId，其次 params.scriptedNpcId）
 * - `{{npc:some_id}}`：场景内 NPC id 的显示名；id 为保留的 `player` 时同 `{{player}}`
 * 其余文本原样拼接；未知 `{{...}}` 原样保留。
 */
export function resolveScriptedSpeakerDisplay(raw: string, ctx: ScriptedSpeakerResolveCtx): string {
  const s = raw ?? '';
  if (!s.includes('{{')) return s;

  const graphId = ctx.graphDialogueNpcId.trim();
  const fbId = ctx.fallbackNpcId.trim();

  let out = '';
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('{{', i);
    if (start < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, start);
    const end = s.indexOf('}}', start + 2);
    if (end < 0) {
      out += s.slice(start);
      break;
    }
    const inner = s.slice(start + 2, end).trim();
    i = end + 2;
    const parts = inner.split(':').map((p) => p.trim()).filter((p) => p.length > 0);
    const kind = (parts[0] ?? '').toLowerCase();

    if (kind === 'player') {
      out += playerDisplayName(ctx);
    } else if (kind === 'npc') {
      const idPart = parts[1] ?? '';
      const useContext = !idPart || idPart === '@context';
      const pick = useContext ? (graphId || fbId) : idPart;
      if (!pick) {
        console.warn(
          'playScriptedDialogue: {{npc}} 无可用上下文（图对话 npcId 与 scriptedNpcId 均为空），'
          + '请写 {{npc:npcId}} 或在动作参数中填写 scriptedNpcId',
        );
        out += '…';
      } else if (pick === PLAYER_ENTITY_ID) {
        // 说话人下拉选了保留 id `player`：{{npc}} 即主角，取玩家显示名而非字面 "player"。
        out += playerDisplayName(ctx);
      } else {
        const npc = ctx.sceneManager.getNpcById(pick);
        out += npc?.def.name ?? pick;
      }
    } else {
      out += `{{${inner}}}`;
    }
  }
  return out;
}

/** speaker 字段对应的世界实体（说话中「…」气泡定位 + 头像跟随说话人用）。 */
export type ScriptedSpeakerEntity = { kind: 'npc'; npcId: string } | { kind: 'player' };

/**
 * 从 `playScriptedDialogue` 的 speaker 字段解析说话实体（与 {@link resolveScriptedSpeakerDisplay} 同占位语义）：
 * - `{{player}}` → 玩家；
 * - `{{npc}}` / `{{npc:@context}}` → 上下文 NPC（优先图对话 npcId，其次 scriptedNpcId）；
 * - `{{npc:some_id}}` → 指定场景 NPC；
 * 只认**首个** `{{…}}` 占位；字面名/旁白/无可用 id → undefined（不显气泡、头像无从跟随）。
 */
export function resolveScriptedSpeakerEntity(
  raw: string,
  ctx: Pick<ScriptedSpeakerResolveCtx, 'graphDialogueNpcId' | 'fallbackNpcId'>,
): ScriptedSpeakerEntity | undefined {
  const s = raw ?? '';
  const start = s.indexOf('{{');
  if (start < 0) return undefined;
  const end = s.indexOf('}}', start + 2);
  if (end < 0) return undefined;
  const parts = s.slice(start + 2, end).split(':').map((p) => p.trim()).filter((p) => p.length > 0);
  const kind = (parts[0] ?? '').toLowerCase();
  if (kind === 'player') return { kind: 'player' };
  if (kind === 'npc') {
    const idPart = parts[1] ?? '';
    const useContext = !idPart || idPart === '@context';
    const pick = (useContext ? (ctx.graphDialogueNpcId.trim() || ctx.fallbackNpcId.trim()) : idPart).trim();
    return scriptedSpeakerEntityFromId(pick);
  }
  return undefined;
}

/**
 * 由裸实体 id（编辑器「说话 NPC」下拉写下的 `scriptedNpcId`、图对话 `npcId`）得到说话实体。
 * 保留 id `player` 映射为主角；空 id → undefined。
 */
export function scriptedSpeakerEntityFromId(rawId: string): ScriptedSpeakerEntity | undefined {
  const id = (rawId ?? '').trim();
  if (!id) return undefined;
  return id === PLAYER_ENTITY_ID ? { kind: 'player' } : { kind: 'npc', npcId: id };
}
