import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import { HoldProgress } from '../systems/pressureHold/holdProgress';

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

const BAR_WIDTH = 420;
const BAR_HEIGHT = 18;
const HINT_FLASH_MS = 900;

/**
 * 临场长按交互的表现层：底部进度条 + 引导文案。
 * 输入：按住空格或在画面任意处按住指针。
 * 每次 runSegment 返回时进度已到达 stopRatio（'reached'）；中途松手默认只回落不失败，
 * 但配置了 abortOnReleaseFromRatio 且松手时进度 ≥ 该值，则整段以 'released' 收场。
 * 自带 rAF 驱动（长按常发生在对话/演出间隙，游戏主循环可能未在更新该系统）。
 */
export class PressureHoldUI {
  private renderer: Renderer;
  private container: Container | null = null;
  private fillBar: Graphics | null = null;
  private hintText: Text | null = null;
  private rafId = 0;
  private holding = false;
  private hintShownAt = 0;
  private detachInput: (() => void) | null = null;
  private resolveSegment: ((outcome: PressureHoldSegmentOutcome) => void) | null = null;
  private currentRatio = 0;
  private abortOnReleaseFromRatio: number | undefined;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  /** 跑一段长按充能；进度到达 stopRatio resolve 'reached'，不容松手关口松手 resolve 'released'。 */
  runSegment(req: PressureHoldSegmentRequest): Promise<PressureHoldSegmentOutcome> {
    this.cancel();
    return new Promise<PressureHoldSegmentOutcome>((resolve) => {
      this.resolveSegment = resolve;
      this.holding = false;
      this.currentRatio = req.startRatio;
      this.abortOnReleaseFromRatio = req.abortOnReleaseFromRatio;
      this.buildView(req);
      this.attachInput();

      const progress = new HoldProgress({
        startRatio: req.startRatio,
        stopRatio: req.stopRatio,
        fillSeconds: req.fillSeconds,
        decayPerSecond: req.decayPerSecond,
      });

      let lastTs = performance.now();
      const step = (ts: number) => {
        const dt = Math.min(0.1, Math.max(0, (ts - lastTs) / 1000));
        lastTs = ts;
        progress.tick(dt, this.holding);
        this.currentRatio = progress.current;
        this.redrawFill(progress.current, req.barColor ?? UITheme.colors.borderActive);
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
    const resolve = this.resolveSegment;
    this.resolveSegment = null;
    resolve?.(outcome);
  }

  private buildView(req: PressureHoldSegmentRequest): void {
    this.container = new Container();
    this.renderer.uiLayer.addChild(this.container);

    const cx = this.renderer.screenWidth / 2;
    const barX = cx - BAR_WIDTH / 2;
    const barY = this.renderer.screenHeight - 120;

    const prompt = new Text({
      text: req.prompt,
      style: {
        fontSize: 16,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: BAR_WIDTH + 120,
        align: 'center',
      },
    });
    prompt.anchor.set(0.5, 1);
    prompt.x = cx;
    prompt.y = barY - 34;
    this.container.addChild(prompt);

    const frame = new Graphics();
    frame.roundRect(barX - 3, barY - 3, BAR_WIDTH + 6, BAR_HEIGHT + 6, 6);
    frame.fill({ color: UITheme.colors.panelBgAlt, alpha: 0.85 });
    frame.roundRect(barX - 3, barY - 3, BAR_WIDTH + 6, BAR_HEIGHT + 6, 6);
    frame.stroke({ color: UITheme.colors.borderActive, width: 1 });
    this.container.addChild(frame);

    this.fillBar = new Graphics();
    this.fillBar.x = barX;
    this.fillBar.y = barY;
    this.container.addChild(this.fillBar);

    const keyHint = new Text({
      text: '按住 [空格] 或按住鼠标',
      style: { fontSize: 11, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui },
    });
    keyHint.anchor.set(0.5, 0);
    keyHint.x = cx;
    keyHint.y = barY + BAR_HEIGHT + 10;
    this.container.addChild(keyHint);

    if (req.releaseHint) {
      this.hintText = new Text({
        text: req.releaseHint,
        style: { fontSize: 14, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui },
      });
      this.hintText.anchor.set(0.5, 1);
      this.hintText.x = cx;
      this.hintText.y = barY - 10;
      this.hintText.visible = false;
      this.container.addChild(this.hintText);
    }
  }

  private redrawFill(ratio: number, color: number): void {
    if (!this.fillBar) return;
    this.fillBar.clear();
    const w = Math.max(0, Math.min(1, ratio)) * BAR_WIDTH;
    if (w <= 0) return;
    this.fillBar.roundRect(0, 0, w, BAR_HEIGHT, 4);
    this.fillBar.fill({ color, alpha: 0.92 });
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
