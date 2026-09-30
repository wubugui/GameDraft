import { describe, it, expect, vi } from 'vitest';
import { Container, Texture } from '../engine2d';
import { CutsceneRenderer } from './CutsceneRenderer';
import { CanvasStage } from './CanvasStage';
import RENDERER_SRC from './Renderer.ts?raw';

/**
 * 世界渐黑（`fadeWorldToBlack`）必须在**画布之下**。
 *
 * 2026-09-21 画布落地时它还留在 `cutsceneOverlay`（画布之上），结果梦段 D 的
 * 「先渐黑 2 秒 → 再出盖脸纸」整张被黑场吞掉——**不报错，玩家只看到一片黑**。
 * 迁移前渐黑与叠图同在 `cutsceneOverlay`、谁在上面取决于谁先加进去；现有内容里
 * 唯一重叠的用法要的正是"图画在黑场上"，所以渐黑只能黑掉世界、不能盖画布。
 */

function fakeRenderer() {
  return {
    worldContainer: new Container(),
    worldFadeLayer: new Container(),
    canvasStage: new CanvasStage(),
    cutsceneOverlay: new Container(),
    uiLayer: new Container(),
    screenWidth: 1024,
    screenHeight: 768,
    subscribeAfterResize: () => () => {},
  };
}

describe('世界渐黑的分层', () => {
  it.each(['image', 'percent', 'breathing', 'animation'] as const)(
    '抓帧期间 %s 异步素材可返回，但只在解冻后提交画布；取消后不复活', async kind => {
      vi.stubGlobal('requestAnimationFrame', () => 1);
      vi.stubGlobal('cancelAnimationFrame', () => {});
      try {
        for (const phase of ['resume', 'cancelPaused', 'cancelBeforeLoad']) {
          let resolveTexture!: (texture: Texture) => void;
          const loaded = new Promise<Texture>(resolve => { resolveTexture = resolve; });
          const r = fakeRenderer();
          const assets = {
            loadTexture: () => loaded,
            loadJson: async () => ({ spritesheet: 'atlas.png', cols: 1, rows: 1,
              states: { idle: { frames: [0], frameRate: 1, loop: true } } }),
          };
          const cr = new CutsceneRenderer(r as never, {} as never, assets as never);
          const done = kind === 'image' ? cr.showImg('image.png', 'capture')
            : kind === 'percent' ? cr.showPercentImg('image.png', 'capture', 50, 50, 100)
              : kind === 'animation' ? cr.showAnimLayer('anim.json', 'capture')
                : cr.showBreathingLayer('capture', 1, 1, 50, 50, 100, undefined,
                  async () => { await loaded; return () => ({ node: new Container(), disposeGpu: () => {} }); });
          const release = cr.suspendForCapture();
          if (phase === 'cancelBeforeLoad') cr.abortCutsceneOps();
          resolveTexture(Texture.WHITE);
          await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
          expect(r.canvasStage.layer.children).toHaveLength(0);
          if (phase === 'cancelPaused') cr.abortCutsceneOps();
          // A stale load must settle even while its capture lease remains held.
          if (phase === 'cancelBeforeLoad') await done;
          release(); release();
          await done;
          expect(r.canvasStage.layer.children).toHaveLength(phase === 'resume' ? 1 : 0);
          cr.destroy();
        }
      } finally { vi.unstubAllGlobals(); }
    },
  );
  it('抓帧保持独立 RAF 动画的相位，受控一帧只走一次固定步，恢复不跳过写盘时间', async () => {
    let now = 0, nextRaf = 0;
    const raf = new Map<number, FrameRequestCallback>();
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { raf.set(++nextRaf, fn); return nextRaf; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => raf.delete(id));
    const pump = () => { const pending = [...raf.values()]; raf.clear(); for (const fn of pending) fn(now); };
    const cr = new CutsceneRenderer(fakeRenderer() as never, {} as never, {} as never);
    try {
      const target = { alpha: 0 };
      const done = cr.animateAlpha(target, 0, 1, 1000);
      now = 100; pump();
      expect(target.alpha).toBeCloseTo(0.1);
      const release = cr.suspendForCapture();
      now = 120_100; pump();
      expect(target.alpha).toBeCloseTo(0.1);
      const finishFrame = cr.beginCaptureFrame(1 / 60);
      finishFrame();
      expect(target.alpha).toBeCloseTo(0.1 + 1 / 60);
      now += 120_000; pump();
      expect(target.alpha).toBeCloseTo(0.1 + 1 / 60);
      release(); release();
      expect(target.alpha).toBeCloseTo(0.1 + 1 / 60);
      now += 200; pump();
      expect(target.alpha).toBeCloseTo(0.3 + 1 / 60);
      cr.abortCutsceneOps();
      await done;
    } finally { cr.destroy(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
  it('渐黑挂在 worldFadeLayer，不在 cutsceneOverlay（否则会盖住画布上的叠图 / 文档揭示）', () => {
    const r = fakeRenderer();
    const cr = new CutsceneRenderer(r as never, {} as never, {} as never);
    cr.setDebugWorldFadeAlpha(1);
    const fade = (cr as unknown as { worldFadeOverlay: Container | null }).worldFadeOverlay;

    expect(fade).not.toBeNull();
    expect(fade!.parent).toBe(r.worldFadeLayer);
    expect(r.cutsceneOverlay.children).not.toContain(fade);
    expect(r.canvasStage.layer.children).not.toContain(fade);
  });

  it('舞台先后：世界 → 世界渐黑 → 画布 → 过场覆盖层 → UI', () => {
    // Renderer.init 要真 WebGL，这里按源码钉 addChild 的先后（与 dialogueGeometryParity 同一范式）
    const order = [...RENDERER_SRC.matchAll(/this\.app\.stage\.addChild\(this\.([\w.]+)\)/g)]
      .map((m) => m[1]);
    expect(order).toEqual([
      'worldContainer',
      'worldFadeLayer',
      'canvasStage.layer',
      'cutsceneOverlay',
      'uiLayer',
    ]);
  });
});
