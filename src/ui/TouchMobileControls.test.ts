import { afterEach, describe, expect, it, vi } from 'vitest';

import { decideTouchUi, TouchMobileControls, type TouchUiSignals } from './TouchMobileControls';
import { InputManager } from '../core/InputManager';
import { GameStateController } from '../core/GameStateController';
import { GameState } from '../data/types';

const base: TouchUiSignals = {
  shortSide: 1080,
  anyPointerFine: true,
  pointerCoarse: false,
  hasTouch: false,
  uaMobile: false,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0',
};

describe('decideTouchUi：触屏 HUD 还是桌面 HUD', () => {
  it('普通桌面（鼠标、无触摸）→ 桌面', () => {
    expect(decideTouchUi(base)).toBe(false);
  });

  it('真手机：主指针 coarse → 触屏（快车道，不看别的）', () => {
    expect(decideTouchUi({ ...base, shortSide: 390, anyPointerFine: false, pointerCoarse: true, hasTouch: true })).toBe(true);
  });

  it('硬否决：桌面尺寸屏 + 系统里有精确指针，即使主指针被报成 coarse 也按桌面', () => {
    expect(decideTouchUi({ ...base, shortSide: 1080, anyPointerFine: true, pointerCoarse: true, hasTouch: true })).toBe(false);
  });

  it('QtWebEngine（编辑器预览 / 打包验收扫描）一律桌面——它在触屏 PC 上把 coarse=true、any-pointer:fine=false，硬否决够不着', () => {
    const qt = { ...base, shortSide: 540, anyPointerFine: false, pointerCoarse: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/6.11.2 Chrome/140.0.7339.225 Safari/537.36' };
    expect(decideTouchUi(qt)).toBe(false);
    // 同样的信号换成 WebView2/Chrome 的 UA 仍走原判据（coarse 快车道 → 触屏）
    expect(decideTouchUi({ ...qt, userAgent: base.userAgent })).toBe(true);
  });

  it('WebView2 桌面工具宿主（tools/qt_webgpu.WebGpuView 在 UA 末尾追加 GameDraftQtHost/）一律桌面', () => {
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0';
    // 2026-09-27 本机实测的 WebView2 信号：短边 581、有精确指针、maxTouchPoints=10 → 原判据走兜底支出触屏
    const host = { ...base, shortSide: 581, anyPointerFine: true, pointerCoarse: false, hasTouch: true, userAgent: edge };
    expect(decideTouchUi(host)).toBe(true);
    expect(decideTouchUi({ ...host, userAgent: `${edge} GameDraftQtHost/1` })).toBe(false);
    expect(decideTouchUi({ ...host, pointerCoarse: true, anyPointerFine: false, userAgent: `${edge} GameDraftQtHost/1` })).toBe(false);
  });

  it('coarse 漏报的真手机：有触摸 + UA 说是手机 → 触屏', () => {
    expect(decideTouchUi({ ...base, shortSide: 412, anyPointerFine: false, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/140' })).toBe(true);
    expect(decideTouchUi({ ...base, shortSide: 412, anyPointerFine: false, hasTouch: true, uaMobile: true })).toBe(true);
  });

  it('触屏显示器 / 数位板：有触摸但屏幕是桌面尺寸、UA 是桌面 → 桌面', () => {
    expect(decideTouchUi({ ...base, shortSide: 1440, anyPointerFine: false, hasTouch: true })).toBe(false);
  });

  it('coarse 漏报 + 屏幕短边在门限内 → 触屏（兜底支的最后一条）', () => {
    expect(decideTouchUi({ ...base, shortSide: 768, anyPointerFine: false, hasTouch: true })).toBe(true);
  });
});

/** 仅模拟本组件使用的 DOM 语义：hidden/inert、类、指针 capture 与事件。 */
class TouchElementStub {
  id = '';
  className = '';
  textContent = '';
  hidden = false;
  inert = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: TouchElementStub[] = [];
  attributes: Record<string, string> = {};
  captures = new Set<number>();
  classes = new Set<string>();
  classList = {
    toggle: (name: string, enabled: boolean) => { if (enabled) this.classes.add(name); else this.classes.delete(name); },
    remove: (name: string) => { this.classes.delete(name); },
  };
  listeners = new Map<string, ((event: unknown) => void)[]>();
  appendChild(el: TouchElementStub): void { this.children.push(el); }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  addEventListener(name: string, fn: (event: unknown) => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]);
  }
  emit(name: string, pointerId = 1): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ pointerId, preventDefault() {} });
  }
  setPointerCapture(id: number): void { this.captures.add(id); }
  hasPointerCapture(id: number): boolean { return this.captures.has(id); }
  releasePointerCapture(id: number): void { this.captures.delete(id); this.emit('lostpointercapture', id); }
  remove(): void {}
  descendants(): TouchElementStub[] { return this.children.flatMap((el) => [el, ...el.descendants()]); }
}

function makeTouchHarness(initialState = GameState.Exploring) {
  const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', {
    ...target, screen: { width: 390, height: 844 },
    matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
  });
  vi.stubGlobal('document', { ...target, visibilityState: 'visible', createElement: () => new TouchElementStub() });
  vi.stubGlobal('navigator', { userAgent: 'Mobile', maxTouchPoints: 1 });
  const input = new InputManager();
  const sc = new GameStateController(input, undefined, initialState);
  const mount = new TouchElementStub();
  const controls = new TouchMobileControls(input, sc, () => sc.currentState, mount as never, {
    get: (_category: string, key: string) => key,
  } as never);
  const root = mount.children[0];
  const findButton = (label: string) => root.descendants().find((el) => el.textContent === label)!;
  return { input, sc, controls, root, findButton };
}

afterEach(() => vi.unstubAllGlobals());

describe('加载期间触屏入口', () => {
  it('加载态首帧即 hidden/inert，所有动作及菜单 handler 拒绝输入', () => {
    const h = makeTouchHarness(GameState.Loading);
    expect(h.root.hidden).toBe(true);
    expect(h.root.inert).toBe(true);
    expect(h.root.classes.has('is-loading')).toBe(true);
    const panel = { isOpen: false, open() { this.isOpen = true; }, close() { this.isOpen = false; } };
    h.sc.registerPanel('menu', panel, undefined, { alwaysOpenable: true });
    for (const label of ['up', 'run', 'interact', 'crouch', 'jump', 'menu', 'back']) h.findButton(label).emit('pointerdown');
    expect(h.input.getMovementDirection()).toEqual({ x: 0, y: 0 });
    expect(h.input.isTouchKeyHeld('KeyC')).toBe(false);
    expect(h.input.wasKeyJustPressed('KeyE')).toBe(false);
    expect(panel.isOpen).toBe(false);
    h.controls.destroy(); h.sc.destroy(); h.input.destroy();
  });

  it('开始加载立即释放旧 capture，揭幕后旧手指不续走，重新按恢复', () => {
    const h = makeTouchHarness();
    const dir = h.findButton('up');
    dir.emit('pointerdown', 9);
    h.findButton('run').emit('pointerdown', 10);
    h.findButton('crouch').emit('pointerdown', 11);
    expect(h.input.getMovementDirection()).toEqual({ x: 0, y: -1 });
    expect(dir.hasPointerCapture(9)).toBe(true);
    h.sc.beginLoading('scene');
    h.controls.syncState();
    expect(h.root.hidden).toBe(true);
    expect(dir.hasPointerCapture(9)).toBe(false);
    h.sc.finishLoading('scene');
    h.controls.syncState();
    expect(h.root.hidden).toBe(false);
    expect(h.root.inert).toBe(false);
    expect(h.input.getMovementDirection()).toEqual({ x: 0, y: 0 });
    expect(h.input.isRunning()).toBe(false);
    expect(h.input.isTouchKeyHeld('KeyC')).toBe(false);
    dir.emit('pointerup', 9);
    expect(h.input.getMovementDirection()).toEqual({ x: 0, y: 0 });
    dir.emit('pointerdown', 12);
    expect(h.input.getMovementDirection()).toEqual({ x: 0, y: -1 });
    h.controls.destroy(); h.sc.destroy(); h.input.destroy();
  });
});
