import { UITheme } from './UITheme';
import type { UIIconName } from './UIIcons';

/**
 * 事件通道的**共用语汇**：一枚木刻剪影 + 一支语义色。
 *
 * 提示条（{@link NotificationUI} 顶中那排木条）与事件日志（{@link DialogueLogUI} 的行）
 * 必须长得一模一样——玩家要能把「刚才闪过去那条」和「日志里这条」一眼对上号，
 * 那是「提示条负责当下的一瞥、日志负责事后的复查」这套分工能成立的前提。
 * 所以这张表**只此一份**，两边都从这里取；抄第二份必漂。
 *
 * 键是**提示条的 type**（`notification:show` 的 `type` 字段）；
 * 日志通道名（`GameLogChannel`）是它的真子集（少 warning/error/info，多一个不进这张表的
 * `dialogue`——对话行左列摆的是说话人，不是图标）。
 */

/**
 * 设计稿只画了「学到规矩 = 书」「接到活计 = 毡帽」两枚，其余按同一套器物语汇补齐。
 * 素材没到位时 `createIcon` 返回 null，调用方一律走"没图标"分支（不留空框）。
 */
export const EVENT_CHANNEL_ICON: Record<string, UIIconName> = {
  quest: 'hat',
  rule: 'book',
  item: 'pouch',
  warning: 'talisman',
  error: 'talisman',
  info: 'scroll',
  /** K7 线索采集回执：线团剪影（2026-08-17 批产的民俗功能图标） */
  clue: 'thread',
  /** 进册（人物簿/见闻录/杂书匣/怪话册/歪歌册/成书全通道，系统默认绑定） */
  archive: 'book',
};

export const EVENT_CHANNEL_COLOR: Record<string, number> = {
  quest: UITheme.colors.notifQuest,
  rule: UITheme.colors.notifRule,
  item: UITheme.colors.notifItem,
  warning: UITheme.colors.notifWarning,
  error: UITheme.colors.notifError,
  info: UITheme.colors.notifInfo,
  /** 与 `[c:clue]` 词条同一支苔绿：玩家把"点的词"与"冒的条"对上号 */
  clue: UITheme.colors.ruleEffective,
  /** 册页暖纸白——与书架/册子标题同一支色，一眼归到"书"那件事上 */
  archive: UITheme.colors.bookLabel,
};

/** 认不出的 type 一律按这一档画（而不是不画） */
export const EVENT_CHANNEL_FALLBACK = 'info';

export function eventChannelIcon(type: string | undefined): UIIconName {
  return EVENT_CHANNEL_ICON[type ?? EVENT_CHANNEL_FALLBACK] ?? EVENT_CHANNEL_ICON[EVENT_CHANNEL_FALLBACK];
}

export function eventChannelColor(type: string | undefined): number {
  return EVENT_CHANNEL_COLOR[type ?? EVENT_CHANNEL_FALLBACK] ?? EVENT_CHANNEL_COLOR[EVENT_CHANNEL_FALLBACK];
}
