import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createProgressBar } from './components/UIDecor';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import { HoldProgress } from '../systems/pressureHold/holdProgress';
import { createStyledText } from '../core/styledText';

export interface PressureHoldSegmentRequest {
  /** 引导文案（已完成 [tag:…] 解析） */
  prompt: string;
  /** 松手瞬间闪现的提示（已解析），可选 */
  releaseHint?: string;
  /** 进度条主色 */
  barColor?: number;
  startRatio: number;
  stopRatio: number;
  fillSeconds: number;
  decayPerSecond: number;
  /** 进度 ≥ 此值后松手即整段以 'released' 收场（「不容松手」关口） */
  abortOnReleaseFromRatio?: number;
}

export type PressureHoldSegmentOutcome = 'reached' | 'released';

/** 木框小面板的最大宽度（进度条宽 = 面板宽 - 内边距×2） */
const PANEL_MAX_W = 560;
/** 面板与屏幕左右边缘的最小留白 */
const MARGIN = UITheme.spacing.xxl;
/**
 * 面板内边距。木条厚 15px、内金线又在 10px 处，旧的 20 只给字留了 5px 净空——
 * 引导文案顶头贴着木框。给到 xxl 才是「字在框里」而不是「字压在框上」。
 */
const PAD = UITheme.spacing.xxl;
/**
 * 条高。这块小面板的主角是**条**不是字：字只说一次"按住"，条要一直被盯着看。
 * 18 在 body 档文案旁边偏细，抬到 22 让视觉重心落回条上。
 */
const BAR_HEIGHT = 22;
const HINT_FLASH_MS = 900;
/** 进度条底边距屏底的高度（纯几何位置，不走间距阶梯） */
const BAR_BOTTOM_OFFSET = 120;
/** 进度填充不透明度：略透一点，能看出底下的槽 */
const FILL_ALPHA = 0.92;
/**
 * 数据没给 barColor 时的默认条色。取 `progressFill`（方正琥珀条那一档），
 * 与 `createProgressBar` 同源——旧默认是 `borderActive` 那种发闷的木色，
 * 在暖木面板上几乎看不出条走到哪了。
 */
const DEFAULT_BAR_COLOR = UITheme.colors.progressFill;

/**
 * 临场长按交互的表现层：底部一块做旧木框小面板，内含引导文案 + 方正进度条 + 键位提示。
 *
 * 观感与遭遇框同一套语汇（tmp/ui_mockups_2026-08-03）：木框 + 纸纹底 + 内金细线，
 * 进度条方正无圆角、槽与描边直接取 {@link createProgressBar}，填充按 `barColor`
 * （数据没给就用琥珀 `progressFill`）。
 *
 * 输入：按住空格或在画面任意处按住指针。
 *
 * **键盘 / 手柄焦点导航（`UIFocus`）刻意不接**：这块面板里一个可交互元素都没有——
 * 引导文案、进度条、键位提示三件全是非交互显示件（`eventMode` 皆非 static），
 * 玩法本身就是"按住"这一个动作，没有"上一项 / 下一项"可挪。硬塞一个焦点项等于
 * 凭空造一个按了没反应的高亮。可达性上它本来就是键盘驱动的：Space 按住即充能，
 * 与指针按住完全等价，不存在"只能用鼠标"的死角。
 * 每次 runSegment 返回时进度已到达 stopRatio（'reached'）；中途松手默认只回落不失败，
 * 但配置了 abortOnReleaseFromRatio 且松手时进度 ≥ 该值，则整段以 'released' 收场。
 * 自带 rAF 驱动（长按常发生在对话/演出间隙，游戏主循环可能未在更新该系统）。
 */
export class PressureHoldUI {
  private renderer: Renderer;
  private strings: StringsProvider;
  private container: Container | null = null;
  private fillBar: Graphics | null = null;
  private hintText: Text | null = null;
  /** 当前段的条宽（随屏宽而定，redrawFill 要用） */
  private barWidth = 0;
  private rafId = 0;
  private holding = false;
  private hintShownAt = 0;
  private detachInput: (() => void) | null = null;
  private resolveSegment: ((outcome: PressureHoldSegmentOutcome) => void) | null = null;
  private currentRatio = 0;
  private abortOnReleaseFromRatio: number | undefined;
  private currentRequest: PressureHoldSegmentRequest | null = null;

  constructor(renderer: Renderer, strings: StringsProvider) {
    this.renderer = renderer;
    this.strings = strings;
  }

  /** 跑一段长按充能；进度到达 stopRatio resolve 'reached'，不容松手关口松手 resolve 'released'。 */
  runSegment(req: PressureHoldSegmentRequest): Promise<PressureHoldSegmentOutcome> {
    this.cancel();
    return new Promise<PressureHoldSegmentOutcome>((resolve) => {
      this.resolveSegment = resolve;
      this.holding = false;
      this.currentRatio = req.startRatio;
      this.abortOnReleaseFromRatio = req.abortOnReleaseFromRatio;
      this.currentRequest = { ...req };
      // 先构造 HoldProgress（坏参数会 throw），再挂 UI 与全屏输入监听，构造失败不留残留。
      const progress = new HoldProgress({
        startRatio: req.startRatio,
        stopRatio: req.stopRatio,
        fillSeconds: req.fillSeconds,
        decayPerSecond: req.decayPerSecond,
      });
      this.buildView(req);
      this.attachInput();

      let lastTs = performance.now();
      const step = (ts: number) => {
        const dt = Math.min(0.1, Math.max(0, (ts - lastTs) / 1000));
        lastTs = ts;
        progress.tick(dt, this.holding);
        this.currentRatio = progress.current;
        this.redrawFill(progress.current, req.barColor ?? DEFAULT_BAR_COLOR);
        this.updateHintVisibility(ts);
        if (progress.reachedStop) {
          this.finishSegment('reached');
          return;
        }
        this.rafId = requestAnimationFrame(step);
      };
      this.rafId = requestAnimationFrame(step);
    });
  }

  /** 强制结束当前段（场景销毁等）；进行中的 Promise 以 'reached' resolve，避免悬挂调用链。 */
  cancel(): void {
    this.finishSegment('reached');
  }

  destroy(): void {
    this.cancel();
  }

  /** Deterministic visual-capture entry: builds the real view without attaching input or rAF. */
  showDebugPreview(req: PressureHoldSegmentRequest, ratio = 0.42): void {
    this.cancel();
    this.holding = false;
    this.currentRequest = { ...req };
    this.currentRatio = Math.max(req.startRatio, Math.min(req.stopRatio, ratio));
    this.abortOnReleaseFromRatio = req.abortOnReleaseFromRatio;
    this.buildView(req);
    this.redrawFill(this.currentRatio, req.barColor ?? DEFAULT_BAR_COLOR);
  }

  isActive(): boolean {
    return this.container !== null;
  }

  getDebugVisualState(): Record<string, unknown> | null {
    const req = this.currentRequest;
    if (!req || !this.container) return null;
    return {
      active: true,
      prompt: req.prompt,
      releaseHint: req.releaseHint ?? '',
      barColor: req.barColor ?? DEFAULT_BAR_COLOR,
      startRatio: req.startRatio,
      stopRatio: req.stopRatio,
      fillSeconds: req.fillSeconds,
      decayPerSecond: req.decayPerSecond,
      abortOnReleaseFromRatio: req.abortOnReleaseFromRatio ?? null,
      currentRatio: this.currentRatio,
      holding: this.holding,
      hintVisible: this.hintText?.visible ?? false,
    };
  }

  private finishSegment(outcome: PressureHoldSegmentOutcome): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.detachInput?.();
    this.detachInput = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
      this.fillBar = null;
      this.hintText = null;
    }
    this.currentRequest = null;
    const resolve = this.resolveSegment;
    this.resolveSegment = null;
    resolve?.(outcome);
  }

  private buildView(req: PressureHoldSegmentRequest): void {
    this.container = new Container();
    this.renderer.uiLayer.addChild(this.container);

    const sw = this.renderer.screenWidth;
    const cx = sw / 2;
    const panelW = Math.min(sw - MARGIN * 2, PANEL_MAX_W);
    const panelX = Math.round(cx - panelW / 2);
    const barW = panelW - PAD * 2;
    const barX = Math.round(cx - barW / 2);
    // 条的纵向位置与旧实现一字不差，面板围着它长出来（长按常插在演出里，位置一动就出戏）
    const barY = this.renderer.screenHeight - BAR_BOTTOM_OFFSET;
    this.barWidth = barW;

    // 引导文案：读一次就去盯条了，是这块小面板的**说明**不是它的标题——
    // 给到 bodyLarge 会在 520 宽的小牌子上喊起来，压过真正的主角（条）。
    const prompt = createStyledText({
      text: req.prompt,
      style: {
        fontSize: UITheme.fontSize.body,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: barW,
        align: 'center',
        lineHeight: UITheme.fontSize.body + UITheme.spacing.sm,
      },
    });
    prompt.anchor.set(0.5, 1);
    prompt.x = cx;
    prompt.y = barY - UITheme.spacing.lg;

    // 键位提示：配角，但**第一次遇到必须读得懂**——micro(14) 是给角标/页码的，
    // 一句「按住 [空格] 或按住鼠标」缩到那一档就成了看不清的脚注。
    const keyHint = createStyledText({
      text: this.strings.get('pressureHold', 'holdHint'),
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui,
      },
    });
    keyHint.anchor.set(0.5, 0);
    keyHint.x = cx;
    keyHint.y = barY + BAR_HEIGHT + UITheme.spacing.md;

    // 面板包住「文案 + 条 + 键位提示」三件，边界由量好的文字高度反推
    const panelTop = Math.round(prompt.y - prompt.height - PAD);
    const panelBottom = Math.round(keyHint.y + keyHint.height + PAD);
    this.container.addChild(createPanel(panelX, panelTop, panelW, panelBottom - panelTop, SKINS.panelAlt));

    this.container.addChild(prompt);

    // 槽 + 方正描边直接取公共进度条（ratio 0 只出底与边），填充另画一层压在上面
    const track = createProgressBar(barW, BAR_HEIGHT, 0);
    track.position.set(barX, barY);
    this.container.addChild(track);

    this.fillBar = new Graphics();
    this.fillBar.x = barX;
    this.fillBar.y = barY;
    this.container.addChild(this.fillBar);

    // 填充会盖住槽的描边，补一圈同色边把「方正」这层意思守住
    const rim = new Graphics();
    rim.rect(barX, barY, barW, BAR_HEIGHT);
    rim.stroke({ color: UITheme.colors.borderSubtle, width: 1 });
    rim.eventMode = 'none';
    this.container.addChild(rim);

    this.container.addChild(keyHint);

    if (req.releaseHint) {
      this.hintText = createStyledText({
        text: req.releaseHint,
        style: {
          fontSize: UITheme.fontSize.body,
          fill: UITheme.colors.title,
          fontFamily: UITheme.fonts.ui,
        },
      });
      this.hintText.anchor.set(0.5, 1);
      this.hintText.x = cx;
      // 松手提示闪在面板上方，别压着引导文案（也别贴在木框上沿）
      this.hintText.y = panelTop - UITheme.spacing.md;
      this.hintText.visible = false;
      this.container.addChild(this.hintText);
    }
  }

  private redrawFill(ratio: number, color: number): void {
    if (!this.fillBar) return;
    this.fillBar.clear();
    const w = Math.max(0, Math.min(1, ratio)) * this.barWidth;
    if (w <= 0) return;
    // 进度填充刻意**不**走面板皮肤：皮肤只管面板「底+边」，进度条不归它管；
    // 方正无圆角是对齐 createProgressBar 的观感
    this.fillBar.rect(0, 0, w, BAR_HEIGHT);
    this.fillBar.fill({ color, alpha: FILL_ALPHA });
  }

  private updateHintVisibility(nowTs: number): void {
    if (!this.hintText) return;
    this.hintText.visible = this.hintShownAt > 0 && nowTs - this.hintShownAt < HINT_FLASH_MS;
  }

  private attachInput(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.holding = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this.markRelease();
      }
    };
    const onPointerDown = () => {
      this.holding = true;
    };
    const onPointerUp = () => {
      this.markRelease();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onPointerUp);
    this.detachInput = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
    };
  }

  private markRelease(): void {
    const wasHolding = this.holding;
    if (wasHolding && this.hintText) {
      this.hintShownAt = performance.now();
    }
    this.holding = false;
    if (
      wasHolding &&
      this.abortOnReleaseFromRatio !== undefined &&
      this.currentRatio >= this.abortOnReleaseFromRatio
    ) {
      this.finishSegment('released');
    }
  }
}
