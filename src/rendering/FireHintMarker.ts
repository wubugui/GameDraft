import { Container, Graphics } from 'pixi.js';

/**
 * 「火要灭了」提示：玩家手上那支火旁边的一个**符号**（不是字、不在头顶——制作人 2026-09-15 定）。
 *
 * 形状是一朵火苗的轮廓，里面**装着的火 = 剩下的火势**（一格往下掉的油量表）：
 * - 火势往下掉（风压着）⇒ 一跳一跳，越见底跳得越急、颜色从琥珀往红里走；
 * - 挡住了风、火势往回长 ⇒ 不跳，稳稳地往上满，满过提示线自己淡掉；
 * - 残炭（明火没了，挡住风还能复燃）⇒ 暗红、一闪一闪。
 *
 * 挂在 entityLayer 的最前档（与气泡同一个理由：实体容器带光照 / 遮挡滤镜、会镜像）。
 * 位置每帧按起火点重摆，不平滑（要跟得上火）；显隐自己淡入淡出，所以由组装层每帧 `tick`。
 */

export interface FireHintTarget {
  /** 起火点（场景坐标 wu） */
  sceneX: number;
  sceneY: number;
  /** 符号中心相对起火点的方向（画面单位向量，y 向下；垂直于杆子、背着火舌）。小角度滑过去，大角度淡出再在新处淡入 */
  dirX: number;
  dirY: number;
  /** 宿主身高（wu，含透视系数）：符号大小与离火的距离按它比例取，远近一致 */
  bodyHeightWu: number;
  /** 剩下的火势 0..1 */
  fill: number;
  /** 危险程度 0..1 */
  danger: number;
  /** 火势正在往下掉 */
  falling: boolean;
  /** 已经是残炭 */
  ember: boolean;
  /** `vitality` 快灭了 / `igniting` 正在用火种点（fill = 点了几成）/ `failed` 刚才没点着；缺省 `vitality` */
  mode?: 'vitality' | 'igniting' | 'failed';
}

/** 符号高度 / 身高（0.075 真跑约 13 px，偏小） */
export const FIRE_HINT_HEIGHT_OF_BODY = 0.095;
/** 符号中心离起火点多远 / 身高（沿 dir）：符号半高 0.0475 + 跳动余量 + 空一点（0.085 真跑时往下摆会蹭杆子 / 火根 1–2 px） */
export const FIRE_HINT_DISTANCE_OF_BODY = 0.1;
/** 方向小角度变化滑过去的时间常数（秒） */
const DIR_TAU_S = 0.12;
/** 方向一下变了超过这么多（弧度）⇒ 不滑（滑会扫过火舌 / 杆子），淡出再在新处淡入 */
const DIR_JUMP_RAD = Math.PI / 2;
/** 换处那一下淡出淡入各多久（秒） */
const DIR_SWAP_S = 0.1;
const FADE_IN_S = 0.15;
const FADE_OUT_S = 0.35;
const WIDTH_OF_HEIGHT = 0.62;

const INK = 0x12100d;
const AMBER = 0xffb040;
const RED = 0xff4a24;
const EMBER_RED = 0xc4321c;

/**
 * 火苗轮廓（高 1、底在 y=0、尖在 y=−1，宽 {@link WIDTH_OF_HEIGHT}；y 向下为正）。
 * 下半是个圆底，两侧收成一个略往右勾的尖。
 */
export function flameGlyphOutline(segments = 10): [number, number][] {
  const r = WIDTH_OF_HEIGHT / 2;
  const pts: [number, number][] = [];
  // 圆底：右 → 底 → 左
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI;
    pts.push([r * Math.cos(t), -r + r * Math.sin(t)]);
  }
  const quad = (p0: [number, number], c: [number, number], p1: [number, number]) => {
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
      pts.push([a * p0[0] + b * c[0] + d * p1[0], a * p0[1] + b * c[1] + d * p1[1]]);
    }
  };
  const tip: [number, number] = [0.06, -1];
  quad([-r, -r], [-r * 1.05, -0.78], tip);
  quad(tip, [r * 0.85, -0.6], [r, -r]);
  pts.pop();                                  // 最后一点与起点重合
  return pts;
}

/** 多边形裁到 `y >= level` 那一侧（火苗里装着的那一截；y 向下为正，level 越小装得越多） */
export function clipPolygonBelow(poly: readonly [number, number][], level: number): [number, number][] {
  const out: [number, number][] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const ain = a[1] >= level;
    const bin = b[1] >= level;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (level - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, level]);
    }
  }
  return out;
}

function mix(c0: number, c1: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  const ch = (s: number) => {
    const x = (c0 >> s) & 0xff;
    const y = (c1 >> s) & 0xff;
    return Math.round(x + (y - x) * k) << s;
  };
  return ch(16) | ch(8) | ch(0);
}

/** 这一刻的样子：颜色、跳动（缩放倍率）、闪烁（透明度倍率）、抖（横向偏移，× 符号高度）。纯函数，测得到 */
export function fireHintLook(
  target: FireHintTarget, timeS: number,
): { color: number; scale: number; alpha: number; shake: number } {
  if (target.mode === 'igniting') {
    // 点着前一下一下地擦火：轻轻一亮一亮，不跳
    const strike = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.5 * timeS);
    return { color: AMBER, scale: 1, alpha: 0.8 + 0.2 * strike, shake: 0 };
  }
  if (target.mode === 'failed') {
    return { color: RED, scale: 1, alpha: 1, shake: 0.08 * Math.sin(2 * Math.PI * 14 * timeS) };
  }
  if (target.ember) {
    const blink = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3.2 * timeS);
    return { color: EMBER_RED, scale: 1, alpha: 0.55 + 0.45 * blink, shake: 0 };
  }
  const color = mix(AMBER, RED, target.danger);
  if (!target.falling) return { color, scale: 1, alpha: 1, shake: 0 };
  const hz = 1.6 + 2.6 * target.danger;
  const beat = Math.max(0, Math.sin(2 * Math.PI * hz * timeS));
  return { color, scale: 1 + (0.1 + 0.1 * target.danger) * beat, alpha: 1, shake: 0 };
}

export class FireHintMarker {
  readonly root: Container;
  private readonly g = new Graphics();
  private readonly outline = flameGlyphOutline();
  private target: FireHintTarget | null = null;
  /** 淡出期间还要画的最后一份 */
  private last: FireHintTarget | null = null;
  private shown = 0;
  private time = 0;
  /** 此刻摆的方向角（弧度，画面：atan2(dirY, dirX)） */
  private angle = 0;
  /** 换处淡出淡入的进度：<0 正在淡出（到 0 换位置），0..1 正在淡入，1 = 没在换 */
  private swap = 1;
  private swapTo = 0;

  constructor(private readonly getLayer: () => Container | null) {
    this.root = new Container();
    (this.root as Container & { entitySortBand?: 'front' }).entitySortBand = 'front';
    this.root.addChild(this.g);
    this.root.visible = false;
    this.root.eventMode = 'none';
  }

  /** 这一刻该提示什么；null = 不提示（淡掉） */
  setTarget(target: FireHintTarget | null): void {
    this.target = target;
    if (target) this.last = target;
  }

  /** 马上收掉（卸下火把 / 切场景）：不淡 */
  hideNow(): void {
    this.target = null;
    this.last = null;
    this.shown = 0;
    this.root.visible = false;
  }

  tick(dtS: number): void {
    const dt = Number.isFinite(dtS) && dtS > 0 ? dtS : 0;
    this.time += dt;
    const want = this.target ? 1 : 0;
    if (this.target) this.stepAngle(Math.atan2(this.target.dirY, this.target.dirX), dt);
    const step = dt / (want > this.shown ? FADE_IN_S : FADE_OUT_S);
    this.shown = want > this.shown ? Math.min(want, this.shown + step) : Math.max(want, this.shown - step);
    const t = this.target ?? this.last;
    if (!t || this.shown <= 0) {
      this.root.visible = false;
      if (!this.target) this.last = null;
      return;
    }
    const layer = this.getLayer();
    if (!layer) {
      this.root.visible = false;
      return;
    }
    if (this.root.parent !== layer) {
      layer.addChild(this.root);
      if (layer.sortableChildren) layer.sortChildren();
    }
    this.draw(t);
    this.root.visible = true;
  }

  /** 方向角一帧：刚出来直接到位；小角度指数滑过去；大角度淡出 → 换位置 → 淡入 */
  private stepAngle(want: number, dt: number): void {
    if (this.shown <= 0) {
      this.angle = want;
      this.swap = 1;
      return;
    }
    if (this.swap < 0) {
      this.swapTo = want;
      this.swap = Math.min(0, this.swap + dt / DIR_SWAP_S);
      if (this.swap >= 0) this.angle = this.swapTo;
      return;
    }
    const diff = Math.atan2(Math.sin(want - this.angle), Math.cos(want - this.angle));
    if (Math.abs(diff) > DIR_JUMP_RAD) {
      this.swapTo = want;
      this.swap = -1 + (this.swap < 1 ? 1 - this.swap : 0);
      return;
    }
    if (this.swap < 1) this.swap = Math.min(1, this.swap + dt / DIR_SWAP_S);
    this.angle += diff * (1 - Math.exp(-dt / DIR_TAU_S));
  }

  private draw(t: FireHintTarget): void {
    const look = fireHintLook(t, this.time);
    const body = Math.max(1, t.bodyHeightWu);
    const h = body * FIRE_HINT_HEIGHT_OF_BODY;
    const r = body * FIRE_HINT_DISTANCE_OF_BODY;
    this.root.position.set(t.sceneX + Math.cos(this.angle) * r + look.shake * h, t.sceneY + Math.sin(this.angle) * r);
    this.root.alpha = this.shown * look.alpha * Math.abs(this.swap);
    const s = h * look.scale;
    // 局部：符号中心在原点（底 +s/2、尖 −s/2）
    const shape = this.outline.map(([x, y]) => [x * s, (y + 0.5) * s] as [number, number]);
    const flat = (p: readonly [number, number][]) => p.flatMap(([x, y]) => [x, y]);
    const line = Math.max(0.6, s * 0.09);
    const g = this.g;
    g.clear();
    g.poly(flat(shape)).fill({ color: INK, alpha: 0.6 });
    const fill = Math.min(1, Math.max(0, t.fill));
    if (fill > 0.001) {
      const level = s / 2 - fill * s;
      const part = clipPolygonBelow(shape, level);
      if (part.length >= 3) g.poly(flat(part)).fill({ color: look.color, alpha: 0.95 });
    }
    g.poly(flat(shape)).stroke({ color: INK, width: line * 2.2, alpha: 0.85, join: 'round' });
    g.poly(flat(shape)).stroke({ color: look.color, width: line, alpha: 1, join: 'round' });
  }

  destroy(): void {
    this.root.parent?.removeChild(this.root);
    this.root.destroy({ children: true });
  }
}
