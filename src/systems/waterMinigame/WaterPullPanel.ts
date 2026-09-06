import { Container, Graphics, Text } from 'pixi.js';
import { createPanel, SKINS, WOOD_PANEL } from '../../ui/PanelSkin';
import { UITheme } from '../../ui/UITheme';
import { createProgressBar, createTitleRow } from '../../ui/components/UIDecor';
import type { FailurePolicy, PullRhythm } from './types';
import { createStyledText, getStyledRaw, setStyledText } from '../../core/styledText';

export type PullPanelResult = 'success' | 'fail_escape' | 'fail_snap' | 'fail_bite' | 'fail_slip' | 'abort';

export interface WaterPullPanelParams {
  zoneSize: number;
  sliderSpeed: number;
  rhythm: PullRhythm;
  failurePolicy: FailurePolicy;
  timeLimitSec: number;
  onResult: (r: PullPanelResult) => void;
  resolveText: (raw: string) => string;
  random?: () => number;
}

/** 内容区宽。取到 224 是为了让 `createTitleRow` 的两翼横线画得出来
 *  （标题「水边拉扯」拉字距后约 132px，两翼各需 >24px 才不被判成脏点）。 */
const INNER_W = 224;
/** 内容离面板外沿：木条厚度 + 一格呼吸，贴着木条画等于压在框上。 */
const INSET = WOOD_PANEL + UITheme.spacing.md;
/** 面板总宽。**导出**：场景要按它算提示条的避让宽度，不能各写一个"约等于"。 */
export const PULL_PANEL_WIDTH = INNER_W + INSET * 2;

const BAR_W = 64;
const BAR_H = 280;
const PROG_H = 14;
/** 槽两侧的刻度：五道暗金短线。既让读数有个"量表"的谱，也免得槽两边空成两块死黑。 */
const TICKS = 5;
const TICK_LEN = 10;
/** 状态行固定留两行高：读数在 1/2 行之间跳会让整块面板抖。 */
const STATUS_LINES = 2;

/**
 * B4 拉扯阶段：标记在竖条内上下浮，玩家通过按住输入把黄条拉回绿区。
 *
 * marker 坐标约定：0=条带顶部，1=条带底部。
 * 松手时标记被水下目标向顶部拖走；按住时玩家把标记往底部拉回。
 * 成功条件只看标记是否稳定在绿区内，控制条积满即成功。
 *
 * 观感（2026-08-04 并入全站 UI 系统）：整块走 `createPanel(SKINS.panel)` 的做旧木框 +
 * 纸纹底，标题走 `createTitleRow`，控制条走 `createProgressBar`（方正琥珀）。
 * **竖条本身是手绘的**——它是「槽 + 目标区 + 标记」三件套，公共件里没有对应形状；
 * 但配色一律取 `UITheme`：槽=progressBg，目标区=琥珀选中（selectedFill + borderSelected），
 * 标记=亮金 title。原先的荧光绿/天蓝是 Tailwind 调试色，与暖近黑画面是两套东西。
 *
 * ⚠ 面板外壳（木框/标题/槽）在构造时建**一次**；每帧只重画目标区/标记/预警三块
 * Graphics 与进度条——`createPanel` 每帧重建等于每帧新建一个九宫格 Sprite。
 */
export class WaterPullPanel extends Container {
  private progress = 0;
  private marker = 0.45;
  private markerVel = 0;
  private greenCenter = 0.5;
  /** 每帧开始由场景写入（空格 ∪ 鼠标按下） */
  private liftHeldBinding = false;
  private elapsed = 0;
  private readonly limit: number;
  private done = false;
  private burstTelegraph = 0;
  private spasmNextAt = 0;
  private spasmKick = 0;
  private wobbleSeed = 0;
  private readonly random: () => number;

  private readonly barW = BAR_W;
  private readonly barH = BAR_H;
  /** 竖条在面板内的左上角 */
  private readonly barX: number;
  private readonly barY: number;
  private readonly progY: number;
  /** 面板总高（含木框），场景据此垂直居中 */
  readonly panelHeight: number;
  readonly panelWidth = PULL_PANEL_WIDTH;

  private warningG: Graphics;
  private markerG: Graphics;
  private zoneG: Graphics;
  /** 进度条宿主：`createProgressBar` 每次返回新 Graphics，换孩子而不是原地重画 */
  private progHost: Container;
  private progBar: Graphics | null = null;
  private lastProgPx = -1;
  private hint: Text;
  /** 标题从 `pullStatus` 的「[水边拉扯]」前缀里取；剩下的才是状态行 */
  private readonly statusPrefix: string;

  constructor(private params: WaterPullPanelParams) {
    super();
    this.random = params.random ?? Math.random;
    this.wobbleSeed = this.random() * Math.PI * 2;
    this.limit = Math.max(2, params.timeLimitSec);
    this.resetMarkerForRhythm();

    // ── 文案拆分：策划写的是一整句「[水边拉扯] 剩余 {sec}s  {state}」。
    // 方括号那截是这块面板的名字，抬成标题；抬不出来（策划改了格式）就整句当状态行，
    // 不硬依赖文案形状。
    const template = params.resolveText('[tag:string:waterMinigame:pullStatus]');
    const m = /^\s*[[［]([^\]］]{1,16})[\]］]\s*/.exec(template);
    const titleText = m ? m[1] : '';
    this.statusPrefix = m ? m[0] : '';

    // ── 内容纵向排布（先量标题高，再反推面板总高）
    let y = UITheme.spacing.xl;
    const title = titleText
      ? createTitleRow(titleText, { width: INNER_W, fontSize: UITheme.fontSize.title })
      : null;
    if (title) {
      title.position.set(INSET, y);
      y += title.rowHeight + UITheme.spacing.md;
    }
    this.barX = Math.round((PULL_PANEL_WIDTH - BAR_W) / 2);
    this.barY = y;
    y += BAR_H + UITheme.spacing.md;
    this.progY = y;
    y += PROG_H + UITheme.spacing.sm;

    this.hint = createStyledText({
      text: '',
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        wordWrapWidth: INNER_W,
        align: 'center',
      },
    });
    this.hint.eventMode = 'none';
    const statusH = Math.round(UITheme.fontSize.small * 1.4) * STATUS_LINES;
    this.hint.y = y;
    y += statusH + UITheme.spacing.xl;
    this.panelHeight = y;

    // ── 组装：木框底 → 标题 → 槽 → 动态三件套 → 进度条 → 状态行
    this.addChild(createPanel(0, 0, PULL_PANEL_WIDTH, this.panelHeight, SKINS.panel));

    if (title) this.addChild(title);

    const trough = new Graphics();
    trough.rect(this.barX, this.barY, BAR_W, BAR_H);
    trough.fill({ color: UITheme.colors.progressBg, alpha: 0.9 });
    for (let i = 0; i < TICKS; i++) {
      const ty = Math.round(this.barY + (BAR_H * i) / (TICKS - 1)) + 0.5;
      trough.moveTo(this.barX - UITheme.spacing.sm - TICK_LEN, ty);
      trough.lineTo(this.barX - UITheme.spacing.sm, ty);
      trough.moveTo(this.barX + BAR_W + UITheme.spacing.sm, ty);
      trough.lineTo(this.barX + BAR_W + UITheme.spacing.sm + TICK_LEN, ty);
    }
    trough.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline });
    // 槽口一圈内金细线：不描的话这根柱子在近黑面板上没有边界，读起来像一块脏
    trough.rect(this.barX, this.barY, BAR_W, BAR_H);
    trough.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline });
    trough.eventMode = 'none';
    this.addChild(trough);

    this.warningG = new Graphics();
    this.zoneG = new Graphics();
    this.markerG = new Graphics();
    for (const g of [this.warningG, this.zoneG, this.markerG]) {
      g.eventMode = 'none';
      this.addChild(g);
    }

    this.progHost = new Container();
    this.progHost.position.set(INSET, this.progY);
    this.progHost.eventMode = 'none';
    this.addChild(this.progHost);

    this.addChild(this.hint);

    this.refreshGeometry();
    this.refreshProgressBar();
  }

  /** 由 WaterMinigameScene.update 在每帧 physics 之前调用 */
  setLiftHeld(down: boolean): void {
    this.liftHeldBinding = down;
  }

  private liftHeld(): boolean {
    return this.liftHeldBinding;
  }

  private resetMarkerForRhythm(): void {
    if (this.params.rhythm === 'heavy_sink') {
      this.greenCenter = 0.72;
      this.marker = 0.7;
    } else if (this.params.rhythm === 'burst') {
      this.greenCenter = 0.35;
      this.marker = 0.38;
    } else {
      this.greenCenter = 0.5;
      this.marker = 0.5;
    }
    this.markerVel = 0;
    this.spasmNextAt = 0.65 + this.random() * 0.85;
  }

  private refreshGeometry(): void {
    const halfZ = Math.max(0.04, Math.min(0.45, this.params.zoneSize));

    // 预警（burst 前摇）：琥珀暖光扫过即将到位的那一段，不再是 Tailwind 橙
    this.warningG.clear();
    if (this.burstTelegraph > 0.001) {
      const wy = this.barY + (0.78 - halfZ) * this.barH;
      const wh = halfZ * 2 * this.barH;
      this.warningG.rect(this.barX - 6, wy - 4, this.barW + 12, wh + 8);
      this.warningG.fill({ color: UITheme.colors.title, alpha: 0.1 + this.burstTelegraph * 0.16 });
      this.warningG.rect(this.barX - 6, wy - 4, this.barW + 12, wh + 8);
      this.warningG.stroke({
        color: UITheme.colors.borderSelected,
        width: 1.5,
        alpha: 0.35 + this.burstTelegraph * 0.45,
      });
    }

    // 目标区：设计稿里「选中」= 点亮一档 + 一圈金描边（`drawSelectedRow` 的做法）。
    // 这里没走那个函数是因为它每次调用都新建 FillGradient，而这块每帧都要重画。
    const gy0 = this.barY + (this.greenCenter - halfZ) * this.barH;
    const gh = halfZ * 2 * this.barH;
    this.zoneG.clear();
    this.zoneG.rect(this.barX, gy0, this.barW, gh);
    this.zoneG.fill(UITheme.colors.selectedFill);
    // 上下沿各压一条实金线：目标区的**边界**才是玩家真正要盯的东西，
    // 只靠"底色亮一档"在这块暖近黑上读不出来（首轮实拍就是这个毛病）。
    this.zoneG.moveTo(this.barX, Math.round(gy0) + 0.5);
    this.zoneG.lineTo(this.barX + this.barW, Math.round(gy0) + 0.5);
    this.zoneG.moveTo(this.barX, Math.round(gy0 + gh) + 0.5);
    this.zoneG.lineTo(this.barX + this.barW, Math.round(gy0 + gh) + 0.5);
    this.zoneG.stroke({ color: UITheme.colors.borderSelected, width: 2 });
    this.zoneG.rect(this.barX, gy0, this.barW, gh);
    this.zoneG.stroke({ color: UITheme.colors.borderSelected, width: 1, alpha: 0.55 });

    // 标记：亮金实心横条，方正无圆角（与 createProgressBar 同一套语言）
    const my = this.barY + this.marker * this.barH;
    const wobble = this.markerWobble();
    this.markerG.clear();
    this.markerG.rect(this.barX - 5 + wobble, my - 6, this.barW + 10, 12);
    this.markerG.fill(UITheme.colors.title);
    this.markerG.rect(this.barX - 5 + wobble, my - 6, this.barW + 10, 12);
    this.markerG.stroke({ color: UITheme.colors.borderSelected, width: 1.5 });
  }

  /** 控制条：只在填充像素真的变了才换孩子，免得每帧新建一个 Graphics。 */
  private refreshProgressBar(): void {
    const px = Math.round(Math.max(0, Math.min(1, this.progress)) * INNER_W);
    if (px === this.lastProgPx) return;
    this.lastProgPx = px;
    this.progBar?.destroy();
    this.progBar = createProgressBar(INNER_W, PROG_H, this.progress);
    this.progHost.addChild(this.progBar);
  }

  private markerWobble(): number {
    if (this.params.rhythm === 'heavy_sink') return 0;
    if (this.params.rhythm === 'spasm') {
      return Math.sin(this.elapsed * 19 + this.wobbleSeed) * (1.2 + this.spasmKick * 9);
    }
    if (this.params.rhythm === 'burst') {
      return Math.sin(this.elapsed * 10 + this.wobbleSeed) * (0.6 + this.burstTelegraph * 3.4);
    }
    return Math.sin(this.elapsed * 3.2 + this.wobbleSeed) * 0.8;
  }

  private smooth01(t: number): number {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - x * 2);
  }

  private lerp(a: number, b: number, t: number): number {
    return a + (b - a) * this.smooth01(t);
  }

  private driveGreen(dt: number): void {
    const t = this.elapsed;
    const { rhythm } = this.params;
    const halfZ = Math.max(0.04, Math.min(0.45, this.params.zoneSize));
    this.burstTelegraph = 0;
    this.spasmKick = Math.max(0, this.spasmKick - dt * 2.8);

    if (rhythm === 'stable') {
      this.greenCenter = 0.5 + Math.sin(t * 2.2) * (0.42 - halfZ);
    } else if (rhythm === 'burst') {
      const cycle = t % 4.2;
      if (cycle < 2.45) {
        this.greenCenter = 0.35 + Math.sin(t * 3.2) * 0.035;
      } else if (cycle < 3.15) {
        this.burstTelegraph = (cycle - 2.45) / 0.7;
        this.greenCenter = this.lerp(0.35, 0.56, this.burstTelegraph);
      } else if (cycle < 3.55) {
        this.burstTelegraph = 1;
        this.greenCenter = 0.78 + Math.sin(t * 8.0) * 0.025;
      } else {
        this.greenCenter = this.lerp(0.78, 0.35, (cycle - 3.55) / 0.65);
      }
    } else if (rhythm === 'spasm') {
      if (t >= this.spasmNextAt) {
        this.greenCenter = 0.18 + this.random() * 0.64;
        this.markerVel -= (0.16 + this.random() * 0.22) * Math.max(0.2, this.params.sliderSpeed);
        this.spasmKick = 1;
        this.spasmNextAt = t + 0.45 + this.random() * 1.35;
      }
      this.greenCenter += Math.sin(t * 11 + (this.marker * 7)) * dt * 0.28;
    } else {
      /* heavy_sink：几乎没有横向/节奏扰动，只在偏底部缓慢呼吸 */
      this.greenCenter = 0.72 + Math.sin(t * 0.45) * 0.025;
    }
    this.greenCenter = Math.max(halfZ + 0.02, Math.min(1 - halfZ - 0.02, this.greenCenter));
  }

  private driveMarker(dt: number): void {
    const base = Math.max(0.2, this.params.sliderSpeed);
    const held = this.liftHeld();

    // marker 的 0 在顶部、1 在底部。按住下拉，松手让水下目标往上拽。
    let accel = (held ? 1.12 : -0.62) * base;
    if (this.params.rhythm === 'heavy_sink') accel = (held ? 1.38 : -0.9) * base;
    else if (this.params.rhythm === 'burst') accel *= this.burstTelegraph > 0.8 ? 1.25 : 1.0;
    else if (this.params.rhythm === 'spasm') accel *= 1 + this.spasmKick * 0.25;

    this.markerVel += accel * dt * 2.4;
    this.markerVel *= Math.exp(-dt * (held ? 2.1 : 2.8));

    const maxVel = (this.params.rhythm === 'heavy_sink' ? 0.78 : 0.95) * base;
    this.markerVel = Math.max(-maxVel, Math.min(maxVel, this.markerVel));
    this.marker += this.markerVel * dt * 1.1;
    if (this.marker < 0.02) {
      this.marker = 0.02;
      this.markerVel = Math.max(0, this.markerVel * -0.15);
    }
    if (this.marker > 0.98) {
      this.marker = 0.98;
      this.markerVel = Math.min(0, this.markerVel * -0.15);
    }
  }

  private inZone(): boolean {
    const halfZ = Math.max(0.04, Math.min(0.45, this.params.zoneSize));
    return Math.abs(this.marker - this.greenCenter) <= halfZ;
  }

  update(dt: number): void {
    if (this.done) return;
    const step = Math.min(Math.max(dt, 0), 0.084);
    this.elapsed += step;
    this.driveGreen(step);
    this.driveMarker(step);

    const overlap = this.inZone();
    if (overlap) {
      let rate = 0.34;
      if (this.params.rhythm === 'heavy_sink') rate = 0.22;
      if (this.params.rhythm === 'burst') rate = 0.36;
      if (this.params.rhythm === 'spasm') rate = 0.28;
      this.progress = Math.min(1, this.progress + rate * step);
    } else {
      let drain = 0.07;
      if (this.params.rhythm === 'heavy_sink') drain = this.liftHeld() ? 0.18 : 0.13;
      else if (this.params.rhythm === 'spasm') drain = 0.11 + this.spasmKick * 0.08;
      else if (this.params.rhythm === 'burst') drain = 0.09 + this.burstTelegraph * 0.06;
      this.progress = Math.max(0, this.progress - drain * step);
    }

    const rem = Math.max(0, this.limit - this.elapsed);
    const t = (key: string) => this.params.resolveText(`[tag:string:waterMinigame:${key}]`);
    const stateHint =
      this.params.rhythm === 'burst' && this.burstTelegraph > 0.01
        ? t('pullStateForeshadow')
        : this.params.rhythm === 'spasm' && this.spasmKick > 0.01
          ? t('pullStateYank')
          : overlap
            ? t('pullStateInZone')
            : this.marker < this.greenCenter
              ? t('pullStateHold')
              : t('pullStateRelease');
    const status = t('pullStatus')
      .replace('{sec}', rem.toFixed(1))
      .replace('{state}', stateHint);
    this.setStatusText(status);
    this.refreshGeometry();
    this.refreshProgressBar();

    if (this.progress >= 0.995) {
      this.finish('success');
      return;
    }
    if (this.elapsed >= this.limit) {
      if (this.params.failurePolicy === 'escape') this.finish('fail_escape');
      else if (this.params.failurePolicy === 'snap') this.finish('fail_snap');
      else if (this.params.failurePolicy === 'slip') this.finish('fail_slip');
      else this.finish('fail_bite');
    }
  }

  /** 去掉已抬成标题的那截前缀，再按内容区居中（wordWrap 下 Text 宽度是最长行宽，不是折行宽）。 */
  private setStatusText(raw: string): void {
    const line = this.statusPrefix && raw.startsWith(this.statusPrefix)
      ? raw.slice(this.statusPrefix.length)
      : raw;
    if (getStyledRaw(this.hint) !== line) setStyledText(this.hint, line);
    this.hint.x = INSET + Math.round((INNER_W - this.hint.width) / 2);
  }

  abort(): void {
    this.finish('abort');
  }

  private finish(r: PullPanelResult): void {
    if (this.done) return;
    this.done = true;
    this.params.onResult(r);
  }
}
