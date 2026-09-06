import { describe, expect, it, vi } from 'vitest';
import { EventBridge, type EventBridgeDeps } from './EventBridge';
import { EventBus } from './EventBus';
import { GameStateController } from './GameStateController';
import { ActionExecutor } from './ActionExecutor';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import { FlagStore } from './FlagStore';
import { GameState, type ActionDef } from '../data/types';
import type { InputManager } from './InputManager';
import clothDialogue from '../../public/assets/dialogues/graphs/开放世界_认衣.json';

function fixture() {
  const bus = new EventBus();
  let keyDown: (e: KeyboardEvent) => void = () => {};
  const input = {
    subscribeKeyDown: (fn: typeof keyDown) => { keyDown = fn; return () => {}; },
    clearInputEdges: vi.fn(),
  } as unknown as InputManager;
  const state = new GameStateController(input, bus);
  const dialogue = { isActive: false };
  const graph = { isActive: false };
  const executor = new ActionExecutor(bus, new FlagStore(bus));
  const bridge = new EventBridge(bus, {
    dialogueManager: dialogue, graphDialogueManager: graph,
    encounterManager: {}, stateController: state, actionExecutor: executor,
    mapUI: {}, menuUI: {}, inspectBox: {}, consumeItem: () => false, guardMapTravel: () => true,
  } as unknown as EventBridgeDeps);
  bridge.init();
  return { bus, state, dialogue, graph, executor, bridge, key: (code: string) =>
    keyDown({ code, preventDefault() {} } as KeyboardEvent) };
}

describe('dialogue:end control handoff', () => {
  it('the authored cloth shop retains its modal state until Escape closes it', async () => {
    const r = fixture();
    const shop = {
      isOpen: false, id: '', open() {},
      openShop(id: string) { this.id = id; this.isOpen = true; },
      close() { this.isOpen = false; r.bus.emit('shop:closed'); },
    };
    r.state.registerPanel('shop', shop);
    registerActionHandlers(r.executor, { stateController: r.state, shopUI: shop } as unknown as ActionRegistryDeps);
    r.state.setState(GameState.Dialogue);
    await r.executor.executeBatchAwait(clothDialogue.nodes.he_shop.actions as ActionDef[]);
    r.bus.emit('dialogue:end', { source: 'graph', willContinue: false });
    expect(shop.id).toBe('ow_he_cloth');
    expect(shop.isOpen).toBe(true);
    expect(r.state.currentState).toBe(GameState.UIOverlay);
    r.key('Escape');
    expect(shop.isOpen).toBe(false);
    expect(r.state.currentState).toBe(GameState.Exploring);
    expect(r.state.getDebugState().overlayReturnStack).toEqual([]);
  });

  it.each([GameState.Minigame, GameState.Cutscene, GameState.SceneTransition])(
    'does not reclaim control already handed to %s', state => {
      const r = fixture();
      r.state.setState(GameState.Dialogue);
      r.state.setState(state);
      r.bus.emit('dialogue:end', { source: 'graph', willContinue: false });
      expect(r.state.currentState).toBe(state);
    },
  );

  it('waits for the final, outermost end; ordinary completion still restores exploration', () => {
    const r = fixture();
    r.state.setState(GameState.Dialogue);
    r.bus.emit('dialogue:end', { source: 'graph', willContinue: true });
    expect(r.state.currentState).toBe(GameState.Dialogue);
    r.bus.emit('dialogue:end', { source: 'scripted', nestedInGraph: true });
    expect(r.state.currentState).toBe(GameState.Dialogue);
    r.graph.isActive = true;
    r.bus.emit('dialogue:end', { source: 'scripted' });
    expect(r.state.currentState).toBe(GameState.Dialogue);
    r.graph.isActive = false;
    r.bus.emit('dialogue:end', { source: 'graph', willContinue: false });
    expect(r.state.currentState).toBe(GameState.Exploring);
  });
});
