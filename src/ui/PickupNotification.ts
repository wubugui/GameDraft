import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import type { EventBus } from '../core/EventBus';

/** 物品入袋事件适配器；显示、居中布局与排队统一交给 NotificationUI。 */
export class PickupNotification {
  private strings: StringsProvider;
  /**
   * 电影化静默（审查 P1：本类原是全桶唯一零压制通道，过场里回执照样砸脸）：
   * 过场期间暂存，cutscene:end 交回统一队列依次呈现。监听自订自摘（生命周期对称）。
   */
  private suppressed = false;
  private pending: { itemName: string; count: number; playItemSound: boolean }[] = [];
  private eventBus: EventBus | null;
  private itemAcquiredCb = (p: { itemName: string; count: number }): void => {
    this.show(p.itemName, p.count, true);
  };
  private cutsceneStartCb = (): void => { this.suppressed = true; };
  private cutsceneEndCb = (): void => {
    this.suppressed = false;
    const queued = this.pending;
    this.pending = [];
    for (const q of queued) this.show(q.itemName, q.count, q.playItemSound);
  };

  // 保留现有组装签名；实际渲染与 resize 由 NotificationUI 统一负责。
  constructor(_renderer: Renderer, strings: StringsProvider, eventBus?: EventBus) {
    this.strings = strings;
    this.eventBus = eventBus ?? null;
    this.eventBus?.on('item:acquired', this.itemAcquiredCb);
    this.eventBus?.on('cutscene:start', this.cutsceneStartCb);
    this.eventBus?.on('cutscene:end', this.cutsceneEndCb);
  }

  show(itemName: string, count: number, playItemSound = false): void {
    // 入袋回执只报实际增加量；已达堆叠上限时 acquired 的 count 会是 0。
    if (!Number.isFinite(count) || count <= 0) return;
    if (this.suppressed) {
      this.pending.push({ itemName, count, playItemSound });
      return;
    }
    const label = this.strings.get('pickup', 'acquired', { name: itemName, count });

    // 只管呈现，避免叠播 notification:show 的通用音效。
    // 铜钱拾取也用此回执，但已有 coinGain，不能再叠物品获得音。
    this.eventBus?.emit('notification:pickup', { text: label, playItemSound });
  }

  forceCleanup(): void {
    this.eventBus?.emit('notification:pickup:clear');
  }

  destroy(): void {
    this.eventBus?.emit('notification:pickup:clear', { includePending: true });
    this.eventBus?.off('item:acquired', this.itemAcquiredCb);
    this.eventBus?.off('cutscene:start', this.cutsceneStartCb);
    this.eventBus?.off('cutscene:end', this.cutsceneEndCb);
    this.pending = [];
  }
}
