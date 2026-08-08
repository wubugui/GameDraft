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
    for (const cb of [...(listeners.get(type) ?? [])]) cb(event);
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
});
