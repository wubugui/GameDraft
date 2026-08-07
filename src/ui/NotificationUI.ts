import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createIcon } from './components/UIDecor';
import type { UIIconName } from './UIIcons';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import { createStyledText } from '../core/styledText';

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
 * toast 条宽：**按内容收，不是固定通栏**。
 * 旧实现恒宽 240——短句（「获得 桃木剑」）右半条全是空木板，长句又被逼在 12 字上换行、
 * 撇下一个孤字在第二行。改成「上限内贴合内容」：一行放得下就收窄，放不下才在上限处换行。
 */
const TOAST_MAX_W = 320;
/** 条宽下限：再短的提示也占住一块，免得连着几条提示时宽度上蹿下跳 */
const TOAST_MIN_W = 180;
/** 条高下限：木边 5px + 圆形图标徽章（直径 20）还要留得下呼吸；长文换行时按正文撑高 */
const TOAST_MIN_H = UITheme.spacing.xxl + UITheme.spacing.xs;
/** 堆叠时两条之间的缝 */
const SLOT_GAP = UITheme.spacing.xs;
const PAD_X = UITheme.spacing.md;
/**
 * 正文行高 1.3 倍：换行的长提示两行之间要有缝。
 * ⚠ 用 `lineHeight` 不用 `leading`——Pixi v8 的 leading 量高比实际绘制矮半档，末行会被
 * 文字贴图裁掉（详见 InspectBox 里那条注释）。行高自带上下各半档留白，所以
 * {@link PAD_Y} 相应收窄，单行条高仍是 {@link TOAST_MIN_H}。
 */
const LINE_H = Math.round(UITheme.fontSize.body * 1.3);
const PAD_Y = UITheme.spacing.xs;
/** 圆形图标徽章：设计稿 01 第 3 块，左边一枚圆章 + 右边一行短字 */
const BADGE_R = 10;
const BADGE_ICON = 12;
/** 顶部锚点：留给 HUD 的净空，属屏幕锚定值而非节奏间距，保持原值 */
const TOP_MARGIN = 50;

/**
 * 提示类型 → 圆章里的木刻剪影。设计稿只画了「学到规矩 = 书」「接到活计 = 毡帽」两枚，
 * 其余按同一套器物语汇补齐；素材没到位时 `createIcon` 返回 null，整枚圆章一起不画。
 */
const TYPE_ICONS: Record<string, UIIconName> = {
  quest: 'hat',
  rule: 'book',
  item: 'pouch',
  warning: 'talisman',
  error: 'talisman',
  info: 'scroll',
};

export class NotificationUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private listContainer: Container;
  private entries: NotificationEntry[] = [];

  private showCb: (p: { text: string; type?: string }) => void;
  private queue: { text: string; type?: string }[] = [];
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

    this.showCb = (p) => this.enqueue(p.text, p.type);
    this.eventBus.on('notification:show', this.showCb);
  }

  private enqueue(text: string, type?: string): void {
    this.queue.push({ text, type });
  }

  /**
   * 注入「现在该不该压住提示条」。由组装层给（通常是"有全屏面板开着"）。
   * **压的是出队不是入队**——面板一关，攒下的提示会照常一条条冒出来，不丢。
   */
  setSuppressed(fn: (() => boolean) | null): void {
    this.isSuppressed = fn ?? undefined;
  }

  private addNotification(text: string, type?: string): void {
    const typeColors: Record<string, number> = {
      quest: UITheme.colors.notifQuest,
      rule: UITheme.colors.notifRule,
      item: UITheme.colors.notifItem,
      warning: UITheme.colors.notifWarning,
      error: UITheme.colors.notifError,
      info: UITheme.colors.notifInfo,
    };
    const color = typeColors[type ?? 'info'] ?? UITheme.colors.notifInfo;

    const entry = new Container();

    // 圆形图标徽章：暗底圆 + 一圈暗金细线 + 里面塞木刻剪影。
    // 素材没到位（createIcon → null）时连圆章一起省掉，文字左移贴回内边距，不留空洞。
    // ⚠ tint 走赋值不走入参：`createIcon` 的默认参数把 tint 推断成了字面量类型，传变量不过编译
    const icon = createIcon(TYPE_ICONS[type ?? 'info'] ?? TYPE_ICONS.info, BADGE_ICON);
    if (icon) icon.tint = color;
    const textX = icon ? PAD_X + BADGE_R * 2 + UITheme.spacing.sm : PAD_X;

    const label = createStyledText({
      text,
      style: {
        // toast 是**一句话的事件播报**，玩家眼角一扫要能认出「接到活计 / 学到规矩」。
        // 原先的 small 是列表小字的档，挂在屏幕正上方读着发虚；正文档（body）才是它的位置。
        fontSize: UITheme.fontSize.body,
        fill: color,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        lineHeight: LINE_H,
        wordWrapWidth: TOAST_MAX_W - textX - PAD_X,
      },
    });

    // 先量正文再定条宽/条高：一行放得下就按内容收窄，放不下才在上限处换行并把木条撑高
    const boxW = Math.min(TOAST_MAX_W, Math.max(TOAST_MIN_W, Math.ceil(textX + label.width + PAD_X)));
    const boxH = Math.max(TOAST_MIN_H, Math.ceil(label.height + PAD_Y * 2));
    // 撞到条宽下限时（极短的提示），圆章 + 文字整体居中，免得右半条空出一截
    const shiftX = Math.max(0, Math.round((boxW - (textX + label.width + PAD_X)) / 2));
    entry.addChild(createPanel(0, 0, boxW, boxH, SKINS.toast));

    if (icon) {
      const cx = shiftX + PAD_X + BADGE_R;
      const cy = Math.round(boxH / 2);
      const badge = new Graphics();
      badge.circle(cx, cy, BADGE_R);
      badge.fill({ color: UITheme.colors.rowBgInactive, alpha: 0.9 });
      badge.circle(cx, cy, BADGE_R);
      badge.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline * 2 });
      badge.eventMode = 'none';
      entry.addChild(badge);

      icon.position.set(cx - BADGE_ICON / 2, cy - BADGE_ICON / 2);
      entry.addChild(icon);
    }

    label.x = shiftX + textX;
    label.y = Math.round((boxH - label.height) / 2);
    entry.addChild(label);

    // 进场从全透明起，由 update() 按 easeOut 推到 1
    entry.alpha = 0;

    const record: NotificationEntry = {
      container: entry,
      createdAt: performance.now(),
      fadingOut: false,
      slotHeight: boxH + SLOT_GAP,
      slotWidth: boxW,
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

    // 全屏面板开着时**只压队不丢**：提示条挂在最上层，一叠四条正好糊住面板标题与右栏
    // （审查在书架与规矩本两处都实拍到了）。玩家在翻面板，通知等他出来再说。
    if (this.queue.length > 0 && !this.isSuppressed?.() && now - this.lastAddTime >= STAGGER_DELAY) {
      const item = this.queue.shift()!;
      this.addNotification(item.text, item.type);
      this.lastAddTime = now;
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
