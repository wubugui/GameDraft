import { Container } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createRule } from './components/UIDecor';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText } from '../core/styledText';

/**
 * 新任务的**醒目横幅**（玩法文档 D9）：屏幕中上方一块木牌，写「新任务 / 任务名 / 首条目标」。
 *
 * 与右上角木条提示（{@link NotificationUI}）是**两条独立通道**：木条继续承载"获得物件/学到规矩"
 * 这类流水回执，横幅只给"接到一件新活"这种任务级大事。档位由 `QuestDef.announce` 逐任务配，
 * 决策在 `QuestManager` 做完，本类只负责把已经决定要横幅的那条画出来。
 *
 * 并发规则（同批多条任务一起激活时）：QuestManager 已在**同一批里只放一条**走横幅、其余
 * 降级成木条；本类再守两道——队列串行（一次只显示一条）+ 同 questId 去重，
 * 免得跨批的两条挤在一起。
 */

// ---------------------------------------------------------------------------
// 时序：进场 → 停留 → 退场。停留 2.2s 是"抬头看一眼就够"的量，
// 再长就变成挡视野的弹窗；再短则玩家还没从场景里把眼睛挪过来。
// ---------------------------------------------------------------------------
const FADE_IN_MS = UITheme.motion.slow;
const HOLD_MS = 2200;
const FADE_OUT_MS = 400;
/** 两条横幅之间的空档：连着播会让人以为是同一条在闪 */
const GAP_MS = 300;
/**
 * 排队超时降级：被压制（对话/过场里）压太久的横幅**不再补播**，改走木条。
 * 「半小时前接的任务突然弹一条横幅」比不提示更糟——玩家已经在做别的事了。
 */
const STALE_MS = 60_000;

/** 进场时从上方落下这么多像素（配 easeOut 收得住），比纯淡入更容易被余光抓到 */
const DROP_PX = 14;
/** 横幅顶边：顶中车道表的 banner 车道（避开场景名/引导条；toast 车道在其下方） */
const TOP_MARGIN = UITheme.topLanes.banner;
const PAD_X = UITheme.spacing.xl;
const PAD_Y = UITheme.spacing.md;
/** 木牌最大宽度：再宽就横穿整个画面，读起来反而费劲 */
const MAX_W = 560;
const MIN_W = 260;

interface BannerRequest {
  questId: string;
  title: string;
  objective: string;
  /** 头行文案（新任务 / 新活计 / 当前任务） */
  heading: string;
  /** 入队时刻（performance.now）：判"排太久了"用 */
  queuedAt: number;
}

type Phase = 'in' | 'hold' | 'out' | 'gap';

export class QuestBannerUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private resolveDisplay: ((s: string) => string) | null = null;
  /** 由组装层注入的「此刻别弹」判据；未注入 = 从不压制 */
  private isSuppressed?: () => boolean;

  private queue: BannerRequest[] = [];
  private current: Container | null = null;
  /** 当前横幅的木牌宽度：**记下来而不是回读 `container.width`**——后者是内容包围盒，
   *  会被子节点与缩放影响，居中位算歪了没人看得出是这儿的问题 */
  private currentWidth = 0;
  private phase: Phase = 'gap';
  private phaseElapsed = 0;
  private announceCb: (p: {
    questId?: string; title?: string; objective?: string;
    mode?: string; kind?: string;
  }) => void;
  private restoringCb: () => void;
  private unsubscribeResize: () => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

    this.announceCb = (p) => this.enqueue(p);
    // 读档：上一局排着的横幅全部作废（QuestManager 恢复期本来也不发 announce，这里是兜底）
    this.restoringCb = () => this.reset();
    this.eventBus.on('quest:announce', this.announceCb);
    this.eventBus.on('save:restoring', this.restoringCb);
    // 画布尺寸变化（调试侧栏挤压 #game-mount 走 Renderer 的 ResizeObserver，不发 window resize）
    this.unsubscribeResize = this.renderer.subscribeAfterResize(() => this.relayout());
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  /** 注入「此刻别弹」判据（组装层给：只在探索态出，对话/过场/小游戏里压住） */
  setSuppressed(fn: (() => boolean) | null): void {
    this.isSuppressed = fn ?? undefined;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  private headingFor(mode: string | undefined, kind: string | undefined): string {
    if (mode === 'focus') return this.strings.get('quest', 'bannerFocus');
    return this.strings.get('quest', kind === 'job' ? 'bannerNewJob' : 'bannerNewQuest');
  }

  private enqueue(p: {
    questId?: string; title?: string; objective?: string; mode?: string; kind?: string;
  }): void {
    const questId = String(p.questId ?? '').trim();
    const title = String(p.title ?? '').trim();
    if (!questId || !title) return;
    // 同一条任务只排一条：后到的覆盖（目标可能已经推进到下一条了）
    const dup = this.queue.findIndex((q) => q.questId === questId);
    const req: BannerRequest = {
      questId,
      title,
      objective: String(p.objective ?? ''),
      heading: this.headingFor(p.mode, p.kind),
      queuedAt: performance.now(),
    };
    if (dup >= 0) this.queue[dup] = req;
    else this.queue.push(req);
  }

  /**
   * 由 Game 主循环驱动（不自转 rAF：与游戏同一时钟，也才拿得到"此刻能不能弹"的判据）。
   *
   * 时序：排队 → 只在探索态出场 → 进场 → 停留 → 退场 → 空档。
   * 中途被压住（开面板/进对话）就地退场，排队太久的直接降级成木条。
   */
  update(dtSeconds: number): void {
    const dt = dtSeconds * 1000;
    if (this.current) {
      // 正显示时被压住（玩家开了面板 / 进了对话）：立刻转入退场。
      // 木牌的 z 序在面板之上（与 toast 同层），挂在那儿不动就是一块糊住面板的补丁；
      // 而 update 是随主循环恒跑的，不会因为"暂停"自己停下。
      if (this.phase !== 'out' && this.isSuppressed?.() === true) {
        this.phase = 'out';
        this.phaseElapsed = 0;
      }
      this.phaseElapsed += dt;
      if (this.phase === 'in') {
        const t = Math.min(1, this.phaseElapsed / FADE_IN_MS);
        const k = UITheme.motion.easeOut(t);
        this.current.alpha = k;
        this.current.y = this.baseY() - DROP_PX * (1 - k);
        if (t >= 1) { this.phase = 'hold'; this.phaseElapsed = 0; }
        return;
      }
      if (this.phase === 'hold') {
        if (this.phaseElapsed >= HOLD_MS) { this.phase = 'out'; this.phaseElapsed = 0; }
        return;
      }
      // out
      const t = Math.min(1, this.phaseElapsed / FADE_OUT_MS);
      this.current.alpha = 1 - t;
      if (t >= 1) {
        this.disposeCurrent();
        this.phase = 'gap';
        this.phaseElapsed = 0;
      }
      return;
    }

    // 空档计时（两条之间留一口气）
    if (this.phase === 'gap') {
      this.phaseElapsed += dt;
      if (this.phaseElapsed < GAP_MS) return;
    }
    if (this.queue.length === 0) return;

    // 排太久的直接降级成木条：木条自带压制与堆叠，不会糊在玩家脸上
    const now = performance.now();
    while (this.queue.length > 0 && now - this.queue[0].queuedAt > STALE_MS) {
      const stale = this.queue.shift()!;
      this.eventBus.emit('notification:show', {
        text: this.strings.get('notifications', 'questAccepted', { title: this.r(stale.title) }),
        type: 'quest',
      });
    }
    if (this.queue.length === 0) return;
    if (this.isSuppressed?.()) return;

    this.show(this.queue.shift()!);
  }

  private baseY(): number {
    return Math.min(TOP_MARGIN, Math.round(this.renderer.screenHeight * 0.16));
  }

  private show(req: BannerRequest): void {
    const c = new Container();

    const heading = createStyledText({
      text: req.heading,
      style: {
        // 头行是**标签**不是内容：停在 small 并拉开字距，让下面的任务名独占重量
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui,
        letterSpacing: UITheme.letterSpacing.title,
      },
    });
    const titleText = createStyledText({
      text: this.r(req.title),
      style: {
        // 任务名是这块木牌的主角：楷体 + title 档 + 字距，与面板大标题同一套语汇
        fontSize: UITheme.fontSize.title,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
        wordWrap: true, breakWords: true, wordWrapWidth: MAX_W - PAD_X * 2,
      },
    });
    const objText = req.objective
      ? createStyledText({
        text: this.strings.get('hud', 'objective', { text: this.r(req.objective) }),
        style: {
          fontSize: UITheme.fontSize.body,
          fill: UITheme.colors.descText,
          fontFamily: UITheme.fonts.ui,
          lineHeight: 26,
          wordWrap: true, breakWords: true, wordWrapWidth: MAX_W - PAD_X * 2,
        },
      })
      : null;

    const contentW = Math.max(heading.width, titleText.width, objText?.width ?? 0);
    const w = Math.round(Math.min(MAX_W, Math.max(MIN_W, contentW + PAD_X * 2)));
    let h = PAD_Y * 2 + heading.height + UITheme.spacing.xs + titleText.height;
    if (objText) h += UITheme.spacing.sm + 1 + UITheme.spacing.sm + objText.height;
    h = Math.round(h);

    // 面板级（要木框）走 createPanel——拿带 wood 的皮肤调 drawPanelBase 木框会静默消失
    c.addChild(createPanel(0, 0, w, h, SKINS.panel));

    let cy = PAD_Y;
    heading.position.set(Math.round((w - heading.width) / 2), cy);
    c.addChild(heading);
    cy += heading.height + UITheme.spacing.xs;
    titleText.position.set(Math.round((w - titleText.width) / 2), cy);
    c.addChild(titleText);
    cy += titleText.height;
    if (objText) {
      cy += UITheme.spacing.sm;
      const rule = createRule(w - PAD_X * 2);
      rule.position.set(PAD_X, cy);
      c.addChild(rule);
      cy += 1 + UITheme.spacing.sm;
      objText.position.set(Math.round((w - objText.width) / 2), cy);
      c.addChild(objText);
    }

    // 纯展示件，绝不吃指针：横幅飘在画面中上部，可命中就会把它底下的场景点击全挡掉
    c.eventMode = 'none';
    // banner 档：与 toast 同带不同车道，真撞上时「新任务」这类大事压过流水播报（审查 P1 档内无优先级）
    c.zIndex = UITheme.z.banner;
    c.alpha = 0;
    c.x = Math.round((this.renderer.screenWidth - w) / 2);
    c.y = this.baseY() - DROP_PX;
    this.renderer.uiLayer.addChild(c);

    this.current = c;
    this.currentWidth = w;
    this.phase = 'in';
    this.phaseElapsed = 0;
  }

  private relayout(): void {
    if (!this.current) return;
    this.current.x = Math.round((this.renderer.screenWidth - this.currentWidth) / 2);
    if (this.phase !== 'in') this.current.y = this.baseY();
  }

  private disposeCurrent(): void {
    if (!this.current) return;
    this.renderer.uiLayer.removeChild(this.current);
    this.current.destroy({ children: true });
    this.current = null;
    this.currentWidth = 0;
  }

  /** 清当前 + 队列（读档 / 销毁） */
  private reset(): void {
    this.disposeCurrent();
    this.queue = [];
    this.phase = 'gap';
    this.phaseElapsed = GAP_MS;
  }

  destroy(): void {
    this.eventBus.off('quest:announce', this.announceCb);
    this.eventBus.off('save:restoring', this.restoringCb);
    this.unsubscribeResize();
    this.reset();
  }
}
