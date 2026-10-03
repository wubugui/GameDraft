import { afterEach, describe, it, expect, vi } from 'vitest';
import { Container } from '../engine2d';
import { UI_LAYER_Z } from '../rendering/uiLayerOrder';
import { UITheme } from './UITheme';
import { UIWindow } from './components/UIWindow';
import { GuidanceLayerUI } from './GuidanceLayerUI';
import { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import type { Camera } from '../rendering/Camera';
import { LoadingSurface } from './LoadingSurface';

/**
 * 面板皮肤要在 Graphics 上画径向渐变，`FillGradient` 当场去 `document` 要一张 canvas——
 * 本仓库 vitest 跑在 node 环境、没有 document。层序与皮肤无关，把画底框那一层换成空容器即可。
 */
vi.mock('./PanelSkin', async () => {
  const { Container } = await import('../engine2d');
  return {
    createPanel: (): unknown => new Container(),
    SKINS: { panel: {}, chip: {}, toast: {} },
  };
});

/** DOM loading curtain semantics, independent of canvas/GPU paint. */
class LoadingElementStub {
  id = ''; className = ''; textContent = ''; innerHTML = ''; hidden = false; inert = false; tabIndex = 0;
  type = ''; dataset: Record<string, string> = {};
  style = {
    opacity: '',
    properties: new Map<string, { value: string; priority: string }>(),
    setProperty(name: string, value: string, priority = ''): void { this.properties.set(name, { value, priority }); },
    removeProperty(name: string): string { const old = this.getPropertyValue(name); this.properties.delete(name); return old; },
    getPropertyValue(name: string): string { return this.properties.get(name)?.value ?? ''; },
    getPropertyPriority(name: string): string { return this.properties.get(name)?.priority ?? ''; },
  };
  ownerDocument = { defaultView: { getComputedStyle: (element: LoadingElementStub) => ({ filter: element.style.getPropertyValue('filter') || 'none' }) } };
  parentElement: LoadingElementStub | null = null;
  children: LoadingElementStub[] = [];
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = { add: (...names: string[]) => names.forEach(n => this.classes.add(n)), remove: (...names: string[]) => names.forEach(n => this.classes.delete(n)) };
  listeners = new Map<string, ((event: Event) => void)[]>();
  append(...children: LoadingElementStub[]): void { for (const c of children) { c.parentElement = this; this.children.push(c); } }
  replaceChildren(): void { this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  hasAttribute(name: string): boolean { return name === 'data-loading-action' ? 'loadingAction' in this.dataset : this.attributes.has(name); }
  contains(el: LoadingElementStub): boolean { return this === el || this.children.some(c => c.contains(el)); }
  closest(_selector: string): LoadingElementStub | null { return this.hasAttribute('data-loading-action') ? this : this.parentElement?.closest(_selector) ?? null; }
  querySelector(_selector: string): LoadingElementStub | undefined { return this.children.find(c => c.type === 'button') ?? this.children.flatMap(c => c.querySelector(_selector) ?? [])[0]; }
  addEventListener(name: string, fn: (event: Event) => void): void { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); }
  removeEventListener(name: string, fn: (event: Event) => void): void { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== fn)); }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn({} as Event); }
  focus(): void { (document as unknown as { activeElement: LoadingElementStub }).activeElement = this; }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); }
  getBoundingClientRect(): DOMRect { return { x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 } as DOMRect; }
}

function loadingHarness() {
  const body = new LoadingElementStub();
  const root = new LoadingElementStub(); root.id = 'game-loading';
  const game = new LoadingElementStub();
  body.append(root, game);
  const listeners = new Map<string, ((event: Event) => void)[]>();
  vi.stubGlobal('Element', LoadingElementStub);
  vi.stubGlobal('HTMLElement', LoadingElementStub);
  vi.stubGlobal('HTMLButtonElement', LoadingElementStub);
  vi.stubGlobal('document', { body, activeElement: game, getElementById: () => root, createElement: () => new LoadingElementStub() });
  vi.stubGlobal('window', {
    addEventListener: (name: string, fn: (event: Event) => void) => listeners.set(name, [...listeners.get(name) ?? [], fn]),
    removeEventListener: (name: string, fn: (event: Event) => void) => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)),
    location: { reload: vi.fn() },
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const surface = new LoadingSurface();
  return { surface, root, game, listeners };
}

describe('LoadingSurface 全屏遮幕与生命周期', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('采纳boot遮幕，主菜单reveal后仍挡输入，仅finish释放底层DOM', async () => {
    const h = loadingHarness();
    h.surface.configure({ revealMs: 0 });
    expect(h.surface.activeId).toBe('boot');
    expect(h.game.inert).toBe(true);
    await h.surface.reveal('boot');
    expect(h.root.children[0].style.opacity).toBe('0');
    expect(h.root.style.opacity).toBe(''); // The hit shield remains present and opaque to events.
    expect(h.root.hidden).toBe(false);
    expect(h.game.inert).toBe(true);
    h.surface.finish('stale');
    expect(h.surface.activeId).toBe('boot');
    h.surface.finish('boot');
    expect(h.root.hidden).toBe(true);
    expect(h.game.inert).toBe(false);
    h.surface.destroy();
  });

  it('失败发生在cover的两个await之间，旧动画reject而不覆盖失败界面', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = loadingHarness();
    const waiting = h.surface.cover('boot', undefined, true).catch(e => e);
    h.surface.fail('boot', new Error('internal stack\n' + 'file.ts:123 '.repeat(1000)));
    expect(await waiting).toMatchObject({ name: 'AbortError' });
    expect(h.root.children[0].style.opacity).toBe('1');
    expect(h.root.children[1].children[0].textContent).toBe('加载未完成，请重试或重新启动。');
    expect(vi.getTimerCount()).toBe(0);
    h.surface.destroy();
  });

  it('就绪前不显示100%，追加请求不倒退进度且重新显示加载文案', async () => {
    vi.useFakeTimers();
    const h = loadingHarness();
    h.surface.configure({ revealMs: 0, fadeOutMs: 0 });
    h.surface.progress('boot', 0.6, 'assets');
    h.surface.progress('boot', 0.2, 'assets');
    expect(h.root.dataset.progress).toBe('0.6');
    h.surface.progress('boot', 1, 'prepared');
    expect(Number(h.root.dataset.progress)).toBeLessThan(1);
    await h.surface.reveal('boot');
    const next = h.surface.cover('next');
    await vi.runAllTimersAsync();
    await next;
    expect(h.root.classes.has('game-loading-indeterminate')).toBe(true);
    expect(h.root.children[1].children[0].textContent).toBe('正在加载…');
    expect(h.game.inert).toBe(true);
    h.surface.destroy();
  });

  it('取消/替换/销毁都settle，即使后台没有rAF也以定时器收口', async () => {
    vi.useFakeTimers();
    const h = loadingHarness();
    const controller = new AbortController();
    h.game.style.setProperty('filter', 'contrast(0.9)', 'important');
    h.game.style.setProperty('will-change', 'transform', 'important');
    const cancelled = h.surface.reveal('boot', controller.signal,
      { transition: 'focus', target: h.game as unknown as HTMLElement }).catch(e => e);
    expect(h.game.style.getPropertyValue('filter')).toContain('blur(16px)');
    controller.abort();
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    expect(h.game.style.getPropertyValue('filter')).toBe('contrast(0.9)');
    expect(h.game.style.getPropertyPriority('filter')).toBe('important');
    expect(h.game.style.getPropertyValue('will-change')).toBe('transform');
    const old = h.surface.reveal('boot').catch(e => e);
    const latest = h.surface.reveal('boot');
    expect(await old).toMatchObject({ name: 'AbortError' });
    await vi.runAllTimersAsync();
    await latest;
    const destroyed = h.surface.reveal('boot').catch(e => e);
    h.surface.destroy();
    expect(await destroyed).toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
    expect(h.game.inert).toBe(false);
    expect([...h.listeners.values()].flat()).toHaveLength(0);
  });

  it('capture屏蔽旧canvas/窗口事件，失败按钮仍可点或用Enter触发', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = loadingHarness();
    const event = { target: h.game, cancelable: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    h.listeners.get('pointerup')![0](event as unknown as Event);
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const retry = vi.fn();
    h.surface.fail('boot', new Error('bad'), retry);
    const button = h.root.querySelector('button')!;
    const action = { ...event, target: button, stopImmediatePropagation: vi.fn(), preventDefault: vi.fn() };
    h.listeners.get('pointerdown')![0](action as unknown as Event);
    expect(action.stopImmediatePropagation).not.toHaveBeenCalled();
    button.click();
    h.surface.handleKey({ code: 'Enter' } as KeyboardEvent);
    expect(retry).toHaveBeenCalledTimes(2);
    h.surface.destroy();
  });
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
