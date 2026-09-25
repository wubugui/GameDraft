import { describe, it, expect } from 'vitest';
import { Container } from '../engine2d';
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
