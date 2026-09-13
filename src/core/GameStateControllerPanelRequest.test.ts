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
});
