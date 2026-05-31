import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SaveManager } from './SaveManager';
import { StringsProvider } from './StringsProvider';

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe('SaveManager save/load/re-enter smoke', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('roundtrips system state and reloads the saved scene on load', async () => {
    const savedSystems = {
      sceneManager: {
        currentSceneId: 'dock_board',
        memory: {
          dock_board: {
            inspected: ['poster'],
            pickedUp: ['coin'],
            entityOverrides: {
              npcs: {
                npc_ringboy: { x: 120, y: 220, patrolDisabled: true },
              },
              hotspots: {
                poster: { enabled: false },
              },
              zones: {
                dock_gate: { enabled: false },
              },
            },
          },
        },
      },
      flagStore: {
        flags: {
          'ringboy.met': true,
          'dock.warningCount': 2,
        },
      },
      narrativeState: {
        activeStates: {
          ringboy_flow: 'done',
        },
      },
      questManager: {
        quests: {
          bridge_find_source: 1,
        },
      },
    };
    let distributed: Record<string, object> | null = null;
    const reloadedScenes: string[] = [];
    const manager = new SaveManager(
      () => savedSystems,
      (data) => {
        distributed = data;
      },
      async (sceneId) => {
        reloadedScenes.push(sceneId);
      },
      new StringsProvider(),
      'fallback_scene',
    );

    manager.save(1);
    const loaded = await manager.load(1);

    expect(loaded).toBe(true);
    expect(distributed).toEqual(savedSystems);
    expect(reloadedScenes).toEqual(['dock_board']);
    expect(manager.getSlotMeta(1)).toMatchObject({
      slot: 1,
      sceneId: 'dock_board',
      sceneName: 'dock_board',
    });
  });

  it('uses fallback scene when the save lacks a current scene id', async () => {
    const reloadedScenes: string[] = [];
    const manager = new SaveManager(
      () => ({ sceneManager: { currentSceneId: null, memory: {} } }),
      () => {},
      async (sceneId) => {
        reloadedScenes.push(sceneId);
      },
      new StringsProvider(),
      'fallback_scene',
    );

    manager.save(0);
    const loaded = await manager.load(0);

    expect(loaded).toBe(true);
    expect(reloadedScenes).toEqual(['fallback_scene']);
  });

  it('does not distribute or reload when loading a missing slot', async () => {
    const distributed = vi.fn();
    const reloader = vi.fn();
    const manager = new SaveManager(
      () => ({ sceneManager: { currentSceneId: 'dock_board', memory: {} } }),
      distributed,
      reloader,
      new StringsProvider(),
      'fallback_scene',
    );

    const loaded = await manager.load(2);

    expect(loaded).toBe(false);
    expect(distributed).not.toHaveBeenCalled();
    expect(reloader).not.toHaveBeenCalled();
  });
});
