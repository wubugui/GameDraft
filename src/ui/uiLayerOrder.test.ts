import { describe, it, expect, vi } from 'vitest';
import { Container } from 'pixi.js';
import { UI_LAYER_Z } from '../rendering/uiLayerOrder';
import { UITheme } from './UITheme';
import { UIWindow } from './components/UIWindow';
import { GuidanceLayerUI } from './GuidanceLayerUI';
import { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';

/**
 * 面板皮肤要在 Graphics 上画径向渐变，`FillGradient` 当场去 `document` 要一张 canvas——
 * 本仓库 vitest 跑在 node 环境、没有 document。层序与皮肤无关，把画底框那一层换成空容器即可。
 */
vi.mock('./PanelSkin', async () => {
  const { Container } = await import('pixi.js');
  return {
    createPanel: (): unknown => new Container(),
    SKINS: { panel: {}, chip: {}, toast: {} },
  };
});

/**
 * uiLayer 层序的护栏（2026-09-23）。
 *
 * 起因是制作人的两张截图：暂停菜单的**存档页**与**设置页**上挂着一枚任务引导菱形浮标
 * 和「打更的 235」。两条根因各钉一组：
 *
 * 1. **层序**：面板（`UIWindow`）一直没设 zIndex（0 带），而浮标写了 `z`，于是浮标恒在
 *    所有面板之上——"面板挂得晚所以压得住"只对同为 0 带的元素成立。
 * 2. **可见性停摆**：浮标的「收起来」判据只在 `GuidanceLayerUI.update` 里写 `visible`，
 *    而 `update` 被收进了主循环的「世界没暂停」闸——一开面板它就冻在上一帧的可见性上。
 *
 * 这里不测画法（vitest 跑在 node、无画布），只测这两条性质。
 */

function rendererStub(): Renderer {
  return {
    uiLayer: new Container(),
    screenWidth: 1280,
    screenHeight: 720,
    subscribeAfterResize: () => () => {},
  } as unknown as Renderer;
}

describe('uiLayer 层序表', () => {
  it('从下往上：世界浮标 < 面板 < 遮幕 < toast/横幅 < 说明卡类 < 调试', () => {
    const z = UI_LAYER_Z;
    // 0 带（HUD / 对话框 / 过场字幕 …）不在表里，是最底下那一档
    expect(z.worldMarker).toBeGreaterThan(0);
    expect(z.worldMarker).toBeLessThan(z.panel);
    expect(z.panel).toBeLessThan(z.curtain);
    expect(z.curtain).toBeLessThan(z.toast);
    expect(z.toast).toBeLessThanOrEqual(z.banner);
    expect(z.banner).toBeLessThan(z.tooltip);
    expect(z.tooltip).toBeLessThan(z.debug);
  });

  it('UITheme.z 就是这张表（UI 侧不许另起一套值）', () => {
    expect(UITheme.z).toBe(UI_LAYER_Z);
  });
});

describe('UIWindow', () => {
  it('窗体恒在面板带：压得过世界浮标，压不过遮幕/toast/确认框', () => {
    const win = new UIWindow(rendererStub(), { size: 'sm', onClose: () => {} });
    expect(win.container.zIndex).toBe(UI_LAYER_Z.panel);
    expect(win.container.zIndex).toBeGreaterThan(UI_LAYER_Z.worldMarker);
    expect(win.container.zIndex).toBeLessThan(UI_LAYER_Z.curtain);
    expect(win.container.zIndex).toBeLessThan(UI_LAYER_Z.tooltip);
    win.destroy();
  });

  it('挂到 uiLayer 后排在世界浮标之上（同一父容器里真排一次）', () => {
    const renderer = rendererStub();
    const guidance = new GuidanceLayerUI(renderer, {} as unknown as Camera, new EventBus());
    const win = new UIWindow(renderer, { size: 'sm', onClose: () => {} });
    win.attach();

    const layer = renderer.uiLayer;
    // Pixi v8：子节点写过 zIndex 就自动开了父容器的 sortableChildren
    expect(layer.sortableChildren).toBe(true);
    layer.sortChildren();
    const guidanceLayer = layer.children.find((c) => c.zIndex === UI_LAYER_Z.worldMarker);
    expect(guidanceLayer).toBeDefined();
    expect(layer.getChildIndex(win.container)).toBeGreaterThan(layer.getChildIndex(guidanceLayer!));

    win.destroy();
    guidance.destroy();
  });
});

describe('GuidanceLayerUI 的收起判据', () => {
  it('不走 update 也能收起来：applyVisibility 单独可调（主循环 early-return 那条路）', () => {
    const renderer = rendererStub();
    const bus = new EventBus();
    const guidance = new GuidanceLayerUI(renderer, {} as unknown as Camera, bus);
    const layer = renderer.uiLayer.children[0]!;

    let hidden = false;
    guidance.setHidden(() => hidden);

    guidance.applyVisibility();
    expect(layer.visible).toBe(true);

    // 开面板 / 弹说明卡 / 死亡：世界暂停，主循环这一帧不会跑 update
    hidden = true;
    guidance.applyVisibility();
    expect(layer.visible).toBe(false);

    hidden = false;
    guidance.applyVisibility();
    expect(layer.visible).toBe(true);

    guidance.destroy();
  });

  it('update 仍然自己现算一次可见性，收起时不再往下算位置', () => {
    const renderer = rendererStub();
    const guidance = new GuidanceLayerUI(renderer, {} as unknown as Camera, new EventBus());
    const layer = renderer.uiLayer.children[0]!;
    const worldToScreen = vi.fn(() => ({ x: 0, y: 0 }));
    // 相机只在"没收起来"的分支里被碰；收起时连一次换算都不该发生
    (guidance as unknown as { camera: Camera }).camera = { worldToScreen } as unknown as Camera;

    guidance.setHidden(() => true);
    guidance.update(0.016);
    expect(layer.visible).toBe(false);
    expect(worldToScreen).not.toHaveBeenCalled();

    guidance.setHidden(() => false);
    guidance.update(0.016);
    expect(layer.visible).toBe(true);

    guidance.destroy();
  });
});
