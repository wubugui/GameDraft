/**
 * 对白立绘 / 名牌的左右分边口径（**唯一定义处**）。
 *
 * 判据只有一条：说话实体是不是当前受控主角（`entity.kind === 'player'`）。
 * 刻意不认显示名、立绘 slug、npcId 白名单——"谁是主角"由运行时保留实体 id
 * `player` 决定（见 {@link ../utils/scriptedDialogueSpeaker.PLAYER_ENTITY_ID}），
 * 立绘也走主角**当前装扮**立绘集。因此换成任何角色扮演主角，此处零改动。
 *
 * `override` 给数据显式指定用：分边不限于 player/npc 二元，两个 NPC 对谈也能各占一边。
 */
export type SpeakerSide = 'left' | 'right';

/** 无实体（旁白）与一切 NPC 的默认边——保持历史构图不变。 */
export const DEFAULT_SPEAKER_SIDE: SpeakerSide = 'left';

export function isSpeakerSide(v: unknown): v is SpeakerSide {
  return v === 'left' || v === 'right';
}

/** 说话实体（+ 可选数据覆盖）→ 立绘所在边。override 非法值一律当没写。 */
export function resolveSpeakerSide(
  entity: { kind: 'npc'; npcId: string } | { kind: 'player' } | undefined,
  override?: unknown,
): SpeakerSide {
  if (isSpeakerSide(override)) return override;
  return entity?.kind === 'player' ? 'right' : DEFAULT_SPEAKER_SIDE;
}
