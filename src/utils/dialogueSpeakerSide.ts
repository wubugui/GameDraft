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

/**
 * 对白的版式档。**不设 = `'bottom'` = 现行行为，逐像素不变。**
 *
 * - `bottom` 框在屏底（立绘贴下沿、名牌骑框上沿）
 * - `top`    框在屏顶（整套上下镜像：立绘贴上沿、名牌骑框下沿）；功能与 bottom 完全一致
 * - `bubble` 说话人头顶气泡（无立绘、无名牌，只有正文与继续记号）；
 *            旁白等解析不出在场实体的行 → 落到屏幕正中
 * - `firstPerson` 第一人称（2026-09-22）：铺满窗口的叠图 = 眼睛看到的画面，图是主角——
 *            不要木框、名牌、立绘，字幕式压在图上（底部渐变托字）；别人开口名字写在句首，
 *            主角自己说的不写名字。**选项也跟着这一档**：一排字横在屏底，不要木钮。
 *            画法与几何见 rendering/firstPersonDialogue.ts（常规对话框 / 过场对白框 / 动作选项条共用）
 *
 * 前三档共用同一套推进（全局点击 / Space / Enter）与同一个**固定**选项位置
 * （见 DialogueUI 的 CHOICES_BOTTOM_INSET）——选项不随版式移动，也不跟着气泡飘。
 * 第一人称档推进不变，只有选项换成屏底横排。
 */
export type DialogueLayoutStyle = 'bottom' | 'top' | 'bubble' | 'firstPerson';

export const DEFAULT_DIALOGUE_LAYOUT: DialogueLayoutStyle = 'bottom';

/** 宽松解析：认四个合法值，其余（含 undefined / 拼错）一律落默认档。 */
export function resolveDialogueLayout(raw: unknown): DialogueLayoutStyle {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v === 'top' || v === 'bubble' || v === 'bottom' || v === 'firstPerson' ? v : DEFAULT_DIALOGUE_LAYOUT;
}

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
