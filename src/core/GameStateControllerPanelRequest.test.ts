import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameState } from '../data/types';
import { InputManager } from './InputManager';
import { GameStateController } from './GameStateController';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';

/**
 * 回归：动作链里替玩家开面板（openMap）。执行器的探索锁把状态压成 ActionSequence，
 * 而 togglePanel 只认 Exploring——直接开会被静默丢掉（无头真跑实测：地图没弹、零报错）。
 */

function stubDom() {
  const target = { addEventListener: () => {}, removeEventListener: () => {} };
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { ...target, visibilityState: 'visible' });
}

function makePanel() {
  return {
    isOpen: false,
    open() { this.isOpen = true; },
    close() { this.isOpen = false; },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestPanelOpen', () => {
  let sc: GameStateController;
  let panel: ReturnType<typeof makePanel>;
  let guardOk: boolean;

  beforeEach(() => {
    stubDom();
    sc = new GameStateController(new InputManager());
    panel = makePanel();
    guardOk = true;
    sc.registerPanel('map', panel, 'KeyM', { openGuard: () => guardOk });
  });

  it('探索态当场开', () => {
    sc.requestPanelOpen('map');
    expect(panel.isOpen).toBe(true);
    expect(sc.currentState).toBe(GameState.UIOverlay);
  });

  it('死亡后的旧演出收尾不能恢复探索，读档恢复生命后才可还权', () => {
    let depleted = true;
    sc.setDepletionGuard(() => depleted);
    sc.setState(GameState.Dead);
    sc.setState(GameState.Exploring);
    expect(sc.currentState).toBe(GameState.Dead);
    sc.setState(GameState.UIOverlay);
    expect(sc.currentState).toBe(GameState.UIOverlay);
    sc.restorePreviousState();
    expect(sc.currentState).toBe(GameState.Dead);
    depleted = false;
    sc.setState(GameState.Exploring);
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it('动作序列态挂起，回到探索态那一刻开；关掉后回探索态', () => {
    sc.setState(GameState.ActionSequence);
    sc.requestPanelOpen('map');
    expect(panel.isOpen).toBe(false);

    sc.setState(GameState.Exploring);
    expect(panel.isOpen).toBe(true);
    expect(sc.currentState).toBe(GameState.UIOverlay);

    sc.closePanel('map');
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it('放锁那一刻 openGuard 拒绝 = 作废，之后再回探索态也不开', () => {
    sc.setState(GameState.ActionSequence);
    sc.requestPanelOpen('map');
    guardOk = false;
    sc.setState(GameState.Exploring);
    expect(panel.isOpen).toBe(false);

    guardOk = true;
    sc.setState(GameState.Dialogue);
    sc.setState(GameState.Exploring);
    expect(panel.isOpen).toBe(false);
  });

  it('closeAllPanels 清掉挂起的请求', () => {
    sc.setState(GameState.ActionSequence);
    sc.requestPanelOpen('map');
    sc.closeAllPanels();
    sc.setState(GameState.Exploring);
    expect(panel.isOpen).toBe(false);
  });

  it('经执行器的探索锁跑一条开面板动作，动作跑完后面板是开的', async () => {
    const bus = new EventBus();
    const executor = new ActionExecutor(bus, new FlagStore(bus), sc);
    executor.register('openMapProbe', () => {
      expect(sc.currentState).toBe(GameState.ActionSequence);
      sc.requestPanelOpen('map');
    }, []);

    await executor.executeAwait({ type: 'openMapProbe', params: {} });

    expect(panel.isOpen).toBe(true);
    expect(sc.currentState).toBe(GameState.UIOverlay);
    sc.closePanel('map');
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it.each([GameState.Exploring, GameState.Dialogue, GameState.Cutscene, GameState.ActionSequence, GameState.Encounter, GameState.Minigame])(
    '从 %s 加载，旧收尾不改加载或续接态，仅当前请求可交还', (origin) => {
      sc.setState(origin);
      sc.beginLoading('first');
      expect(sc.currentState).toBe(GameState.Loading);
      expect(sc.loadingResumeState).toBe(origin);
      sc.setState(GameState.Exploring);
      sc.setState(GameState.Cutscene);
      sc.restorePreviousState();
      expect(sc.currentState).toBe(GameState.Loading);
      expect(sc.loadingResumeState).toBe(origin);
      expect(sc.finishLoading('first')).toBe(true);
      expect(sc.currentState).toBe(origin);
    },
  );

  it('新请求承接底层状态，旧完成与旧交接没有写入权', () => {
    sc.setState(GameState.Cutscene);
    sc.beginLoading('old');
    sc.beginLoading('new');
    expect(sc.loadingId).toBe('new');
    expect(sc.setLoadingResumeState('old', GameState.Exploring)).toBe(false);
    expect(sc.finishLoading('old')).toBe(false);
    expect(sc.currentState).toBe(GameState.Loading);
    expect(sc.setLoadingResumeState('new', GameState.Dialogue)).toBe(true);
    expect(sc.finishLoading('new')).toBe(true);
    expect(sc.currentState).toBe(GameState.Dialogue);
  });

  it('加载先关 UI 且清返回栈，旧 close/常开面板/挂起面板不会穿透', () => {
    sc.setState(GameState.Dialogue);
    sc.registerPanel('menu', panel, 'Escape', { alwaysOpenable: true });
    sc.togglePanel('menu');
    expect(sc.currentState).toBe(GameState.UIOverlay);
    panel.close = function () {
      this.isOpen = false;
      sc.restorePreviousState();
      sc.setState(GameState.Exploring);
    };
    sc.beginLoading('scene');
    expect(panel.isOpen).toBe(false);
    expect(sc.currentState).toBe(GameState.Loading);
    expect(sc.getDebugState().overlayReturnStack).toEqual([]);
    sc.togglePanel('menu');
    sc.switchToPanel('menu');
    sc.requestPanelOpen('map');
    sc.triggerEscapeFromTouch();
    expect(panel.isOpen).toBe(false);
    sc.finishLoading('scene');
    expect(sc.currentState).toBe(GameState.Dialogue);
    expect(panel.isOpen).toBe(false);
    sc.setState(GameState.Exploring);
    expect(panel.isOpen).toBe(false);
  });

  it('耗尽仍可进入 Loading，加载中旧死亡收尾不得夺权，出口按恢复生命决定', () => {
    let depleted = true;
    sc.setDepletionGuard(() => depleted);
    sc.setState(GameState.Dead);
    sc.beginLoading('retry', GameState.Exploring);
    sc.setState(GameState.Dead);
    expect(sc.currentState).toBe(GameState.Loading);
    sc.finishLoading('retry');
    expect(sc.currentState).toBe(GameState.Dead);
    sc.beginLoading('restore', GameState.Exploring);
    depleted = false;
    sc.finishLoading('restore');
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it('Loading 初态持输入锁；非法续接态不解锁，销毁使旧完成失效', () => {
    const input = new InputManager();
    const initial = new GameStateController(input, undefined, GameState.Loading);
    input.injectKeyJustPressed('KeyE');
    expect(input.wasKeyJustPressed('KeyE')).toBe(false);
    initial.beginLoading('boot', GameState.Exploring);
    expect(initial.finishLoading('boot', GameState.Loading)).toBe(false);
    expect(initial.setLoadingResumeState('boot', GameState.UIOverlay)).toBe(false);
    expect(initial.currentState).toBe(GameState.Loading);
    initial.destroy();
    expect(initial.finishLoading('boot')).toBe(false);
    input.injectKeyJustPressed('KeyE');
    expect(input.wasKeyJustPressed('KeyE')).toBe(true);
    input.destroy();
  });

  it('诊断入口须显式调用，玩家常开快捷面板没有加载通行权', () => {
    const diagnostic = makePanel();
    sc.registerPanel('tools', diagnostic, 'F2', { alwaysOpenable: true, overlaysGameState: false });
    sc.beginLoading('scene');
    sc.togglePanel('tools');
    expect(diagnostic.isOpen).toBe(false);
    sc.toggleDiagnosticPanel('map');
    expect(panel.isOpen).toBe(false);
    sc.toggleDiagnosticPanel('tools');
    expect(diagnostic.isOpen).toBe(true);
    expect(sc.currentState).toBe(GameState.Loading);
    sc.toggleDiagnosticPanel('tools');
    expect(diagnostic.isOpen).toBe(false);
    expect(sc.currentState).toBe(GameState.Loading);
  });
});
