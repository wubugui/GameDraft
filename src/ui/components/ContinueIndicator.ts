import { Container, Graphics } from 'pixi.js';
import { UITheme } from '../UITheme';

/**
 * 「继续」指示符（VN 的 advance indicator）：对话框右下角那枚等你点的小记号。
 *
 * 全站唯一实现——常规对话框、过场对白框、遭遇框、屏底点击提示都用它，
 * 免得四处各画一个三角、动效各调一套。
 *
 * ## 形状不是几何三角
 *
 * 画成**毛笔点捺**：顶边略拱（笔肚）、两侧收锋、下端聚成尖。纯等腰三角在这套
 * 楷体 + 做旧木框的皮里一眼就是"程序画的"；点捺跟标题字与木纹是一路。
 *
 * ## 动效
 *
 * **轻微上下浮动**（±{@link FLOAT_PX}px、周期 {@link PERIOD_MS}ms、两头缓的 easeInOut）
 * 外加一点点明灭。幅度刻意小——它是"在等你"的提示，不是动画表演。
 * **只在等待推进时出现**：打字机还在打字、或正在选项里，一律不显示。
 */

/** 点捺的外接尺寸 */
const MARK_W = 22;
const MARK_H = 15;
/** 上下浮动的振幅与周期 */
const FLOAT_PX = 3;
const PERIOD_MS = 1400;
/** 明灭区间：不压到很暗，否则读起来像要熄灭而不是在等待 */
const ALPHA_MIN = 0.72;
const ALPHA_MAX = 1;

/** 画一枚毛笔点捺（原点＝记号的水平中心、顶边高度）。 */
function drawBrushMark(g: Graphics, w: number, h: number, color: number): void {
  const hw = w / 2;
  g.moveTo(-hw, 0);
  // 顶边略拱：笔尖落纸那一下的笔肚
  g.bezierCurveTo(-w * 0.18, -h * 0.20, w * 0.18, -h * 0.20, hw, 0);
  // 右缘收锋 → 下端聚尖
  g.bezierCurveTo(w * 0.34, h * 0.34, w * 0.14, h * 0.72, 0, h);
  // 左缘收锋回起点
  g.bezierCurveTo(-w * 0.14, h * 0.72, -w * 0.34, h * 0.34, -hw, 0);
  g.fill(color);
}

export class ContinueIndicator {
  /** 挂进调用方容器的根；位置由调用方设（指的是记号的水平中心 + 顶边） */
  readonly container: Container;
  private mark: Graphics;
  private baseY = 0;
  private elapsed = 0;
  private shown = false;

  constructor(color: number = UITheme.colors.gold) {
    this.container = new Container();
    this.container.eventMode = 'none';
    this.container.visible = false;
    this.mark = new Graphics();
    drawBrushMark(this.mark, MARK_W, MARK_H, color);
    this.container.addChild(this.mark);
  }

  /** 记号顶边落在哪（x 是水平中心）。浮动以此为基准上下摆。 */
  setPosition(x: number, y: number): void {
    this.container.x = x;
    this.baseY = y;
    this.container.y = y;
  }

  /**
   * 显示/隐藏。**由调用方按"是否在等推进"驱动**——
   * 打字机进行中、选项展开时一律传 false。
   */
  setVisible(visible: boolean): void {
    if (this.shown === visible) return;
    this.shown = visible;
    this.container.visible = visible;
    // 每次重新出现都从静止相位起摆，免得接着上一句的相位突然跳一下
    if (visible) this.elapsed = 0;
  }

  /** 由调用方的每帧驱动传入秒级 dt（与项目其余 update 同口径）。 */
  update(dt: number): void {
    if (!this.shown || this.container.destroyed) return;
    this.elapsed += dt;
    const t = (this.elapsed * 1000) % PERIOD_MS / PERIOD_MS;
    // 0→1→0 的三角波过 easeInOut，得到两头缓、中间快的上下浮动
    const tri = t < 0.5 ? t * 2 : (1 - t) * 2;
    const e = UITheme.motion.easeInOut(tri);
    this.container.y = this.baseY + (e - 0.5) * 2 * FLOAT_PX;
    this.container.alpha = ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * e;
  }

  destroy(): void {
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}

/** 记号的外接尺寸，供调用方留边距用。 */
export const CONTINUE_MARK_SIZE = { width: MARK_W, height: MARK_H, float: FLOAT_PX };
