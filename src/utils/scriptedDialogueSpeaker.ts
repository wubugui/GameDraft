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
 * 解析 playScriptedDialogue 的 speaker 字段中的占位：
 * - `{{player}}`：玩家显示名（与图对话 resolveSpeaker player 一致）
 * - `{{npc}}` 或 `{{npc:@context}}`：当前上下文 NPC（优先图对话 npcId，其次 params.scriptedNpcId）
 * - `{{npc:some_id}}`：场景内 NPC id 的显示名
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
      const v = ctx.flagStore.get('player_display_name');
      if (typeof v === 'string' && v.trim()) {
        out += v.trim();
      } else {
        const fb = ctx.strings.get('dialogue', 'defaultProtagonistName');
        out += fb && fb !== 'defaultProtagonistName' ? fb : '你';
      }
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
