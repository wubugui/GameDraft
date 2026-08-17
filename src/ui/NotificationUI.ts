import { Container } from 'pixi.js';
import { UITheme } from './UITheme';
import { buildToastChip } from './components/UIToast';
import { eventChannelColor, eventChannelIcon } from './eventChannelStyle';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';

interface NotificationEntry {
  container: Container;
  createdAt: number;
  fadingOut: boolean;
  /** 本条实际占的高度（条高 + 缝）：文字换行会把木条撑高，堆叠必须按真高走 */
  slotHeight: number;
  /** 本条实际条宽：条宽按内容收，居中要按各自的宽算 */
  slotWidth: number;
}

// ---------------------------------------------------------------------------
// 时序常量：**语义不可改**（停留 4s → 淡出 0.8s → 移除；同批消息间隔 400ms 依次入场）。
// 下面只把「怎么画/怎么缓动」接到令牌层，何时开始、何时结束一律保持原值。
// ---------------------------------------------------------------------------
const DISPLAY_DURATION = 4000;
const FADE_DURATION = 800;
const MAX_VISIBLE = 5;
const STAGGER_DELAY = 400;

/** 进场淡入：motion 的「提示进出」档（150ms），配 easeOut 收得住 */
const FADE_IN_DURATION = UITheme.motion.normal;

/**
 * toast 条宽：**按内容收，不是固定通栏**（视觉细节全在 components/UIToast 一处）。
 * 宽上限 320 / 下限 180：下限让连着几条提示时宽度不上蹿下跳。
 */
const TOAST_MAX_W = 320;
const TOAST_MIN_W = 180;
/** 堆叠时两条之间的缝 */
const SLOT_GAP = UITheme.spacing.xs;
/** 顶部锚点：从顶中车道表取（toast 车道排在任务横幅之下，堆叠向下延伸永不上侵） */
const TOP_MARGIN = UITheme.topLanes.toast;

/**
 * 提示类型 → 剪影与语义色的映射已收敛到 {@link eventChannelStyle}——
 * 事件日志的行必须与这里的木条**长得一模一样**（玩家要把"刚才闪过去那条"
 * 和"日志里这条"对上号），两处各存一份必漂。
 */

export class NotificationUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private listContainer: Container;
  private entries: NotificationEntry[] = [];

  private showCb: (p: { text: string; type?: string; priority?: string }) => void;
  private queue: { text: string; type?: string; priority?: string }[] = [];
  /** 由组装层注入的「压住出队」判据；未注入＝从不压（与历史行为一致） */
  private isSuppressed?: () => boolean;
  private lastAddTime: number = 0;
  private unsubscribeResize: () => void;

  constructor(renderer: Renderer, eventBus: EventBus) {
    this.renderer = renderer;
    this.eventBus = eventBus;

    this.listContainer = new Container();
    this.renderer.uiLayer.addChild(this.listContainer);
    // toast 须恒在最上层：改用 z 令牌显式排序，替代此前「每来一条就把 listContainer
    // 重新 addChild 到 uiLayer 末尾」的插入序 hack（那个写法挡不住 toast 之后才打开的面板）。
    // Pixi v8 里给子节点写 zIndex 会自动把父容器的 sortableChildren 打开，
    // 其余 uiLayer 子节点 zIndex 均为 0，稳定排序下相对顺序不变。
    this.listContainer.zIndex = UITheme.z.toast;

    // 画布尺寸变化（侧栏挤压 #game-mount 走 ResizeObserver，不发 window resize）后重排水平居中
    this.unsubscribeResize = this.renderer.subscribeAfterResize(() => this.layoutEntries());

    this.showCb = (p) => this.enqueue(p.text, p.type, p.priority);
    this.eventBus.on('notification:show', this.showCb);
  }

  private enqueue(text: string, type?: string, priority?: string): void {
    this.queue.push({ text, type, priority });
  }

  /**
   * 注入「现在该不该压住提示条」。由组装层给（通常是"有全屏面板开着"）。
   * **压的是出队不是入队**——面板一关，攒下的提示会照常一条条冒出来，不丢。
   */
  setSuppressed(fn: (() => boolean) | null): void {
    this.isSuppressed = fn ?? undefined;
  }

  private addNotification(text: string, type?: string): void {
    // 视觉件收敛到 components/UIToast（与右上入袋回执同一份实现，审查 P2 双实现漂移）；
    // 剪影与语义色收敛到 eventChannelStyle（与事件日志同一份，见本文件顶部说明）
    const chip = buildToastChip({
      text,
      color: eventChannelColor(type),
      icon: eventChannelIcon(type),
      maxWidth: TOAST_MAX_W,
      minWidth: TOAST_MIN_W,
    });
    const entry = chip.container;

    // 进场从全透明起，由 update() 按 easeOut 推到 1
    entry.alpha = 0;

    const record: NotificationEntry = {
      container: entry,
      createdAt: performance.now(),
      fadingOut: false,
      slotHeight: chip.height + SLOT_GAP,
      slotWidth: chip.width,
    };

    this.entries.push(record);
    this.listContainer.addChild(entry);

    if (this.entries.length > MAX_VISIBLE) {
      const oldest = this.entries.shift();
      if (oldest) {
        this.listContainer.removeChild(oldest.container);
        oldest.container.destroy({ children: true });
      }
    }

    this.layoutEntries();
  }

  private layoutEntries(): void {
    // 最新一条在最上；逐条按各自真高往下累加，换行撑高的条不会被下一条压住。
    // 条宽按内容收之后每条宽度不同，水平居中也得逐条算。
    let y = TOP_MARGIN;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      e.container.x = Math.round((this.renderer.screenWidth - e.slotWidth) / 2);
      e.container.y = y;
      y += e.slotHeight;
    }
  }

  update(_dt: number): void {
    const now = performance.now();

    // 全屏面板/过场里**只压队不丢**：提示条挂在最上层，一叠四条正好糊住面板标题，
    // 过场里则是砸在电影化镜头脸上（审查 P1「电影化静默」）。玩家出来再一条条冒。
    // 例外：priority === 'system' 的条（过场跳过确认这类**只在被压场景里才有意义**的
    // 系统提示）越过静默立即出——它压根就是给静默场景配的。
    if (this.queue.length > 0 && now - this.lastAddTime >= STAGGER_DELAY) {
      const suppressed = this.isSuppressed?.() ?? false;
      const idx = suppressed ? this.queue.findIndex((q) => q.priority === 'system') : 0;
      if (idx >= 0) {
        const item = this.queue.splice(idx, 1)[0];
        this.addNotification(item.text, item.type);
        this.lastAddTime = now;
      }
    }

    const toRemove: number[] = [];

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const elapsed = now - entry.createdAt;

      if (elapsed > DISPLAY_DURATION && !entry.fadingOut) {
        entry.fadingOut = true;
      }

      if (entry.fadingOut) {
        const fadeElapsed = elapsed - DISPLAY_DURATION;
        // 出场与进场同一条 easeOut 曲线；起止时刻仍是 DISPLAY_DURATION → +FADE_DURATION
        const t = Math.min(1, Math.max(0, fadeElapsed / FADE_DURATION));
        entry.container.alpha = 1 - UITheme.motion.easeOut(t);
        if (fadeElapsed >= FADE_DURATION) {
          toRemove.push(i);
        }
      } else if (elapsed < FADE_IN_DURATION) {
        // elapsed 可能微负：本帧 now 取在 update 顶部，而队列出队新建的条目 createdAt
        // 晚于它（文字排版耗时可达数十毫秒），不夹会算出负 alpha 闪一帧
        const t = Math.min(1, Math.max(0, elapsed / FADE_IN_DURATION));
        entry.container.alpha = UITheme.motion.easeOut(t);
      } else {
        entry.container.alpha = 1;
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      const idx = toRemove[i];
      const entry = this.entries[idx];
      this.listContainer.removeChild(entry.container);
      entry.container.destroy({ children: true });
      this.entries.splice(idx, 1);
    }

    if (toRemove.length > 0) {
      this.layoutEntries();
    }
  }

  destroy(): void {
    this.eventBus.off('notification:show', this.showCb);
    this.unsubscribeResize();
    for (const entry of this.entries) {
      entry.container.destroy({ children: true });
    }
    this.entries = [];
    if (this.listContainer.parent) {
      this.listContainer.parent.removeChild(this.listContainer);
    }
    this.listContainer.destroy({ children: true });
  }
}
