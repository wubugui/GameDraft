import { Container, Graphics } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';

/**
 * HUD 元素「首次出场仪式」（玩法清单 G.5 / G.6 的 `debut` 档）：
 * 压暗世界 → 元素在屏心大起（这一帧回调 onPop 给音效表）→ 停一拍 → 缩着飞回常态位 → 亮回来。
 *
 * 三把火与气味指示器共用这一件：元素本身怎么画归各自的层（逐帧由 `onFrame` 推进），
 * 本类只管把那一层**暂住**到 uiLayer 顶层的仪式 root 里做位移/缩放/罩层，结束搬回常态父级。
 * 状态机由宿主的时钟推进（`step(dt)`），rAF / 固定步两种时钟走同一条路。
 *
 * Promise 必然封口：正常结束、中途被改显隐、销毁都走 `finish()`。
 */
export interface HudDebutOptions {
  renderer: Renderer;
  /** 要出场的那一层（仪式期间被搬到仪式 root，结束搬回 homeParent） */
  layer: Container;
  /** 常态父级与常态局部坐标 */
  homeParent: Container;
  homePos: { x: number; y: number };
  /** 常态父级的当前缩放（仪式期间可能 resize，飞回时现取） */
  homeScale: () => number;
  /** 缩放/位移的支点（layer 局部坐标，通常是元素几何中心） */
  pivot: { x: number; y: number };
  /** 元素在 layer 局部坐标下的宽度（限制屏心放大不超过屏宽的一部分） */
  clusterWidth: number;
  /** 屏心放大倍数（相对常态尺寸） */
  scaleMult: number;
  /** 屏心最大占屏宽比例（缺省 0.35） */
  maxWidthFrac?: number;
  /** 每帧回调（元素自己的逐帧绘制） */
  onFrame?: () => void;
  /** 元素在屏心真出现的那一帧（发音效事件） */
  onPop?: () => void;
  /** 仪式收尾（含中途打断）：宿主在这里把自己的显隐状态钉到"已显" */
  onFinish?: () => void;
}

/** 各段时长（秒） */
export const DEBUT_DIM_IN = 0.35;
export const DEBUT_POP = 0.3;
export const DEBUT_HOLD = 0.9;
export const DEBUT_TRAVEL = 0.75;
export const DEBUT_DIM_OUT = 0.3;

function easeInOutQuad(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

export class HudDebut {
  readonly promise: Promise<void>;
  private resolve!: () => void;
  private readonly opts: HudDebutOptions;
  private readonly root: Container;
  private readonly scrim: Graphics;
  private t = 0;
  private readonly bigScale: number;
  private readonly center: { x: number; y: number };
  private home: { x: number; y: number; scale: number } | null = null;
  private popSent = false;
  private done = false;

  constructor(opts: HudDebutOptions) {
    this.opts = opts;
    const sw = opts.renderer.screenWidth;
    const sh = opts.renderer.screenHeight;
    this.promise = new Promise<void>((resolve) => { this.resolve = resolve; });

    this.root = new Container();
    this.root.zIndex = UITheme.z.toast;
    this.scrim = new Graphics();
    this.scrim.rect(0, 0, sw, sh);
    this.scrim.fill({ color: UITheme.colors.overlay, alpha: 1 });
    this.scrim.alpha = 0;
    this.root.addChild(this.scrim);

    const L = opts.layer;
    this.root.addChild(L);
    L.pivot.set(opts.pivot.x, opts.pivot.y);
    L.alpha = 0;
    L.visible = false;
    const maxFrac = opts.maxWidthFrac ?? 0.35;
    this.bigScale = Math.min(opts.homeScale() * opts.scaleMult, (sw * maxFrac) / Math.max(1, opts.clusterWidth));
    this.center = { x: sw / 2, y: sh / 2 };
    L.position.set(this.center.x, this.center.y);
    L.scale.set(this.bigScale);
    opts.renderer.uiLayer.addChild(this.root);
  }

  get active(): boolean {
    return !this.done;
  }

  /** 推进一帧；返回 true = 本帧收尾（宿主置空引用） */
  step(dt: number): boolean {
    if (this.done) return true;
    this.t += dt;
    const L = this.opts.layer;
    const dim = UITheme.alpha.overlayDark;
    const ease = UITheme.motion.easeOut;
    const t = this.t;
    if (t < DEBUT_DIM_IN) {
      this.scrim.alpha = dim * ease(t / DEBUT_DIM_IN);
      L.visible = false;
      L.alpha = 0;
      return false;
    }
    this.scrim.alpha = dim;
    if (!this.popSent) {
      this.popSent = true;
      this.opts.onPop?.();
    }
    const t1 = t - DEBUT_DIM_IN;
    if (t1 < DEBUT_POP) {
      const p = ease(t1 / DEBUT_POP);
      L.visible = true;
      L.alpha = p;
      L.scale.set(this.bigScale * (1.35 - 0.35 * p));
      L.position.set(this.center.x, this.center.y);
      this.opts.onFrame?.();
      return false;
    }
    L.visible = true;
    L.alpha = 1;
    const t2 = t1 - DEBUT_POP;
    if (t2 < DEBUT_HOLD) {
      L.scale.set(this.bigScale);
      L.position.set(this.center.x, this.center.y);
      this.opts.onFrame?.();
      return false;
    }
    const t3 = t2 - DEBUT_HOLD;
    if (!this.home) {
      // 常态位现算（仪式期间可能 resize）：常态父级里的 homePos 折到 uiLayer 坐标，再加支点偏移
      const g = this.opts.homeParent.toGlobal({ x: this.opts.homePos.x, y: this.opts.homePos.y });
      const local = this.opts.renderer.uiLayer.toLocal(g);
      const s = this.opts.homeScale();
      this.home = { x: local.x + this.opts.pivot.x * s, y: local.y + this.opts.pivot.y * s, scale: s };
    }
    if (t3 < DEBUT_TRAVEL) {
      const p = easeInOutQuad(t3 / DEBUT_TRAVEL);
      L.position.set(this.center.x + (this.home.x - this.center.x) * p, this.center.y + (this.home.y - this.center.y) * p);
      L.scale.set(this.bigScale + (this.home.scale - this.bigScale) * p);
      this.scrim.alpha = dim * (1 - 0.5 * p);
      this.opts.onFrame?.();
      return false;
    }
    const t4 = t3 - DEBUT_TRAVEL;
    L.position.set(this.home.x, this.home.y);
    L.scale.set(this.home.scale);
    if (t4 < DEBUT_DIM_OUT) {
      this.scrim.alpha = dim * 0.5 * (1 - t4 / DEBUT_DIM_OUT);
      this.opts.onFrame?.();
      return false;
    }
    this.finish();
    return true;
  }

  /** 收尾（正常结束 / 中途被改显隐 / destroy）：元素搬回常态位，罩层销毁，Promise 封口 */
  finish(): void {
    if (this.done) return;
    this.done = true;
    const L = this.opts.layer;
    this.opts.homeParent.addChild(L);
    L.pivot.set(0, 0);
    L.position.set(this.opts.homePos.x, this.opts.homePos.y);
    L.scale.set(1);
    L.alpha = 1;
    L.visible = true;
    if (this.root.parent) this.root.parent.removeChild(this.root);
    this.root.destroy({ children: true });
    this.opts.onFinish?.();
    this.resolve();
  }
}
