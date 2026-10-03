import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameState } from '../data/types';
import { InputManager } from './InputManager';
import { GameStateController } from './GameStateController';
import { PlayerActionSystem } from '../systems/PlayerActionSystem';

/**
 * 回归：**一次按键只属于按下它那一刻的游戏状态**。
 *
 * 用户报的表现：对话里按空格「继续」，对话结束后主角原地起跳。
 * 链路——InputManager 先记下 Space 的「刚按下」沿 → DialogueUI 的 window 监听随后推进并同步
 * 结束对话（dialogue:end → setState(Exploring)）→ 这条沿要等到本 tick 末尾 endFrame() 才清，
 * 于是下一 tick 的 PlayerActionSystem 在探索态里又把它当成一次跳跃输入。
 *
 * 收口在 GameStateController：状态真的变了就丢掉未消费的输入沿。
 */

/** 极简 EventTarget 替身：node 环境没有 window/document，InputManager 构造即要用。 */
function createDomStub() {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const target = {
    addEventListener(type: string, cb: (e: unknown) => void): void {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    removeEventListener(type: string, cb: (e: unknown) => void): void {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
  };
  /** 与浏览器一致：按登记顺序派发（InputManager 先登记，UI 后登记） */
  const dispatch = (type: string, event: unknown): void => {
    let stopped = false;
    const source = event as { stopImmediatePropagation?: () => void };
    const emitted = type === 'keydown' ? {
      ...source,
      stopImmediatePropagation: () => { stopped = true; source.stopImmediatePropagation?.(); },
    } : event;
    for (const cb of [...(listeners.get(type) ?? [])]) {
      cb(emitted);
      if (stopped) break;
    }
  };
  return { target, dispatch };
}

function makeFakePlayer() {
  return {
    x: 0,
    y: 0,
    hasAnimationState: vi.fn(() => true),
    hasActiveMotion: vi.fn(() => false),
    playAnimation: vi.fn(),
    getCurrentClipTiming: vi.fn(() => ({ frameCount: 8, durationSec: 1 })),
    jumpTo: vi.fn(async () => undefined),
    cancelMotion: vi.fn(),
    cancelJump: vi.fn(),
    setPostureMovement: vi.fn(),
    setAnimationOwnedByAction: vi.fn(),
    setInputLocked: vi.fn(),
    setFacing: vi.fn(),
  };
}

function makeHarness() {
  const dom = createDomStub();
  vi.stubGlobal('window', dom.target);
  vi.stubGlobal('document', { ...dom.target, visibilityState: 'visible' });

  const inputManager = new InputManager();
  const stateController = new GameStateController(inputManager);
  const player = makeFakePlayer();
  const actionSystem = new PlayerActionSystem(
    { emit: vi.fn() } as never,
    inputManager,
    { executeBatchAwait: vi.fn(async () => undefined) } as never,
    player as never,
  );
  actionSystem.setBinding({
    findVerbGraphTarget: () => null,
    startGraphAtEntry: vi.fn(),
    findActSpot: () => null,
    dispatchZoneAct: () => false,
    canAcceptInput: () => stateController.currentState === GameState.Exploring,
    setActSpotPrompt: vi.fn(),
  });
  return { dom, inputManager, stateController, actionSystem, player };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('状态切换时丢弃未消费的输入沿', () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  it('抓帧期间丢弃键盘、指针、触屏及注入输入，保留 F2，嵌套释放不会留下 held 或沿', () => {
    const anyInput = vi.fn(), pointer = vi.fn(), key = vi.fn();
    h.inputManager.subscribeAnyInput(anyInput);
    h.inputManager.subscribePointerDown(pointer);
    h.inputManager.subscribeKeyDown(key);
    h.dom.dispatch('keydown', { code: 'KeyW', repeat: false });
    h.inputManager.setTouchKeyHeld('KeyC', true);
    h.inputManager.setTouchMoveAxes(1, 0);
    const release = h.inputManager.suspendForCapture();
    const nested = h.inputManager.suspendForCapture();
    anyInput.mockClear(); key.mockClear();
    h.dom.dispatch('keydown', { code: 'Space', repeat: false });
    h.dom.dispatch('pointerdown', {});
    h.inputManager.injectKeyJustPressed('KeyE');
    h.inputManager.injectPointerDown();
    h.inputManager.setTouchKeyHeld('KeyC', true);
    h.inputManager.setTouchMoveAxes(1, 0);
    h.dom.dispatch('keydown', { code: 'F2', repeat: false });
    expect(key).toHaveBeenCalledOnce();
    expect(anyInput).not.toHaveBeenCalled();
    expect(pointer).not.toHaveBeenCalled();
    expect(h.inputManager.getMovementDirection()).toEqual({ x: 0, y: 0 });
    expect(h.inputManager.wasMouseJustClicked()).toBe(false);
    release(); release();
    h.dom.dispatch('keydown', { code: 'KeyD', repeat: false });
    expect(h.inputManager.isKeyDown('KeyD')).toBe(false);
    nested();
    expect(h.inputManager.isTouchKeyHeld('KeyC')).toBe(false);
    expect(h.inputManager.wasKeyJustPressed('KeyE')).toBe(false);
    h.dom.dispatch('keydown', { code: 'KeyD', repeat: false });
    expect(h.inputManager.isKeyDown('KeyD')).toBe(true);
  });

  it('对话里按空格推进并结束对话，下一帧不触发跳跃', () => {
    h.stateController.setState(GameState.Dialogue);
    // DialogueUI 替身：与真实实现同款——window 监听，登记在 InputManager 之后，
    // 收到 Space 就同步把状态推回探索态（dialogue:end → EventBridge → setState）
    h.dom.target.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).code !== 'Space') return;
      h.stateController.setState(GameState.Exploring);
    });

    h.dom.dispatch('keydown', { code: 'Space', repeat: false });

    expect(h.stateController.currentState).toBe(GameState.Exploring);
    h.actionSystem.update(1 / 60);
    expect(h.player.jumpTo).not.toHaveBeenCalled();
  });

  it('对照组：探索态里按空格照常起跳（清沿没把正常输入也吃掉）', () => {
    h.dom.dispatch('keydown', { code: 'Space', repeat: false });

    h.actionSystem.update(1 / 60);
    expect(h.player.jumpTo).toHaveBeenCalledTimes(1);
  });

  it('状态没变（重复 setState 同一状态）不丢沿', () => {
    h.dom.dispatch('keydown', { code: 'KeyE', repeat: false });
    h.stateController.setState(GameState.Exploring);
    expect(h.inputManager.wasKeyJustPressed('KeyE')).toBe(true);
  });

  it('面板关闭弹栈恢复状态时同样丢沿（Space 激活焦点按钮关面板 → 不该起跳）', () => {
    const panel = { isOpen: false, open() { this.isOpen = true; }, close() { this.isOpen = false; } };
    h.stateController.registerPanel('menu', panel, 'KeyM');
    h.stateController.togglePanel('menu');
    expect(h.stateController.currentState).toBe(GameState.UIOverlay);

    h.dom.dispatch('keydown', { code: 'Space', repeat: false });
    h.stateController.closePanel('menu');

    expect(h.stateController.currentState).toBe(GameState.Exploring);
    expect(h.inputManager.wasKeyJustPressed('Space')).toBe(false);
  });

  it('restorePreviousState 走同一个出口（暂停菜单「继续」路径）', () => {
    h.stateController.setState(GameState.Dialogue);
    h.stateController.setState(GameState.UIOverlay);
    h.dom.dispatch('keydown', { code: 'Space', repeat: false });
    h.stateController.restorePreviousState();

    expect(h.stateController.currentState).toBe(GameState.Dialogue);
    expect(h.inputManager.wasKeyJustPressed('Space')).toBe(false);
  });

  it('加载前/加载中按住的物理键与触屏键不会在揭幕后续走，必须松开重新按', () => {
    h.dom.dispatch('keydown', { code: 'KeyW', repeat: false });
    h.inputManager.setTouchMoveAxes(1, 0);
    h.inputManager.setTouchKeyHeld('KeyC', true);
    h.stateController.beginLoading('scene');
    const key = vi.fn(), any = vi.fn(), pointer = vi.fn();
    h.inputManager.subscribeKeyDown(key);
    h.inputManager.subscribeAnyInput(any);
    h.inputManager.subscribePointerDown(pointer);
    h.dom.dispatch('keydown', { code: 'KeyD', repeat: false });
    h.dom.dispatch('keydown', { code: 'F2', repeat: false });
    h.dom.dispatch('pointerdown', {});
    h.inputManager.injectPointerDown();
    h.inputManager.injectKeyJustPressed('Space');
    h.inputManager.setTouchMoveAxes(-1, 0);
    h.inputManager.setTouchRunHeld(true);
    h.inputManager.setTouchKeyHeld('KeyC', true);
    expect(key).not.toHaveBeenCalled();
    expect(any).not.toHaveBeenCalled();
    expect(pointer).not.toHaveBeenCalled();
    expect(h.inputManager.getMovementDirection()).toEqual({ x: 0, y: 0 });
    h.stateController.finishLoading('scene');
    h.dom.dispatch('keydown', { code: 'KeyW', repeat: true });
    h.dom.dispatch('keydown', { code: 'KeyD', repeat: true });
    expect(h.inputManager.getMovementDirection()).toEqual({ x: 0, y: 0 });
    expect(h.inputManager.isTouchKeyHeld('KeyC')).toBe(false);
    expect(h.inputManager.isRunning()).toBe(false);
    expect(h.inputManager.wasKeyJustPressed('Space')).toBe(false);
    h.dom.dispatch('keyup', { code: 'KeyD' });
    h.dom.dispatch('keydown', { code: 'KeyD', repeat: false });
    expect(h.inputManager.getMovementDirection()).toEqual({ x: 1, y: 0 });
  });

  it('加载中先松开可在退出后重新按，失焦后的 repeat 不能伪造新按下', () => {
    h.dom.dispatch('keydown', { code: 'KeyW', repeat: false });
    h.stateController.beginLoading('scene');
    h.dom.dispatch('keyup', { code: 'KeyW' });
    h.stateController.finishLoading('scene');
    h.dom.dispatch('keydown', { code: 'KeyW', repeat: false });
    expect(h.inputManager.isKeyDown('KeyW')).toBe(true);
    h.dom.dispatch('blur', {});
    h.dom.dispatch('keydown', { code: 'KeyW', repeat: true });
    expect(h.inputManager.isKeyDown('KeyW')).toBe(false);
    h.dom.dispatch('keyup', { code: 'KeyW' });
    h.dom.dispatch('keydown', { code: 'KeyW', repeat: false });
    expect(h.inputManager.isKeyDown('KeyW')).toBe(true);
  });

  it('同一次输入的首个订阅者启动加载，后续游戏订阅者不能再消费', () => {
    const laterAny = vi.fn(), laterKey = vi.fn(), laterPointer = vi.fn();
    h.inputManager.subscribeAnyInput(() => h.stateController.beginLoading('from-input'));
    h.inputManager.subscribeAnyInput(laterAny);
    h.inputManager.subscribeKeyDown(laterKey);
    h.inputManager.subscribePointerDown(laterPointer);
    h.dom.dispatch('keydown', { code: 'Space', repeat: false });
    expect(h.stateController.currentState).toBe(GameState.Loading);
    expect(laterAny).not.toHaveBeenCalled();
    expect(laterKey).not.toHaveBeenCalled();
    expect(laterPointer).not.toHaveBeenCalled();
    expect(h.inputManager.wasKeyJustPressed('Space')).toBe(false);
  });

  it('加载捕获阶段吞按键，直接挂 window 的旧对话/UI 不会收到，keyup 仍可解除隔离', () => {
    const directUI = vi.fn();
    h.dom.target.addEventListener('keydown', directUI);
    h.stateController.beginLoading('scene');
    const keyboard = { code: 'Space', repeat: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    h.dom.dispatch('keydown', keyboard);
    expect(keyboard.preventDefault).toHaveBeenCalledOnce();
    expect(keyboard.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(directUI).not.toHaveBeenCalled();
    h.dom.dispatch('keyup', { code: 'Space' });
    h.stateController.finishLoading('scene');
    h.dom.dispatch('keydown', { code: 'Space', repeat: false });
    expect(directUI).toHaveBeenCalledOnce();
    expect(h.inputManager.wasKeyJustPressed('Space')).toBe(true);
  });

  it('加载故障的专用键盘入口独立于玩法，Tab和宿主刷新保留默认行为', () => {
    const handler = vi.fn(), gameplay = vi.fn();
    h.inputManager.setLoadingKeyHandler(handler);
    h.inputManager.subscribeAnyInput(gameplay);
    h.stateController.beginLoading('failed');
    for (const code of ['Tab', 'F5', 'KeyR']) {
      const e = { code, repeat: false, ctrlKey: code === 'KeyR', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
      h.dom.dispatch('keydown', e);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(e.stopImmediatePropagation).toHaveBeenCalledOnce();
    }
    const enter = { code: 'Enter', repeat: false, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    h.dom.dispatch('keydown', enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledTimes(4);
    expect(gameplay).not.toHaveBeenCalled();
    expect(h.inputManager.wasKeyJustPressed('Enter')).toBe(false);
    h.dom.dispatch('keydown', { code: 'Enter', repeat: true });
    expect(handler).toHaveBeenCalledTimes(4);
  });
});
