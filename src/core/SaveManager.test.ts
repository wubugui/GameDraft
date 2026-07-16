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

    expect(manager.save(1)).toBe(true);
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

  it('exports and imports the same interoperable JSON systems envelope', () => {
    const systems = { sceneManager: { currentSceneId: 'dock_board' }, dialogueLog: { entries: [{ text: '跨壳' }] } };
    const producer = new SaveManager(() => systems, () => {}, async () => {}, new StringsProvider(), 'fallback_scene');
    expect(producer.save(0)).toBe(true);
    const payload = producer.exportSlotPayload(0);
    expect(payload).not.toBeNull();
    producer.deleteSlot(0);
    expect(producer.importSlotPayload(2, payload!)).toBe(true);
    expect(JSON.parse(producer.exportSlotPayload(2)!).systems).toEqual(systems);
    expect(producer.importSlotPayload(1, '{broken')).toBe(false);
    expect(producer.importSlotPayload(1, JSON.stringify({ version: 1 }))).toBe(false);
  });
});

describe('SaveManager save failure reporting', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns false when the storage write throws (quota / sandbox)', () => {
    (localStorage as unknown as { setItem: () => void }).setItem = () => {
      throw new Error('QuotaExceededError');
    };
    const manager = new SaveManager(
      () => ({ sceneManager: { currentSceneId: 's1' } }),
      () => {},
      async () => {},
      new StringsProvider(),
      'fallback_scene',
    );

    expect(manager.save(0)).toBe(false);
  });

  it('returns false when the canSave predicate rejects', () => {
    const collector = vi.fn(() => ({}));
    const manager = new SaveManager(collector, () => {}, async () => {}, new StringsProvider(), 'fallback_scene');
    manager.setCanSavePredicate(() => false);

    expect(manager.save(0)).toBe(false);
    expect(collector).not.toHaveBeenCalled();
    expect(manager.hasSave(0)).toBe(false);
  });

  it('returns false for an out-of-range slot', () => {
    const manager = new SaveManager(() => ({}), () => {}, async () => {}, new StringsProvider(), 'fallback_scene');
    expect(manager.save(-1)).toBe(false);
    expect(manager.save(3)).toBe(false);
  });
});

describe('SaveManager load atomicity', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rolls back distributed state and reloads the original scene when scene reload fails', async () => {
    const savedState = {
      sceneManager: { currentSceneId: 'dock_board' },
      flagStore: { flags: { saved: true } },
    };
    const liveState = {
      sceneManager: { currentSceneId: 'street' },
      flagStore: { flags: { live: true } },
    };
    let collectorState: Record<string, object> = savedState;
    const distributed: Record<string, object>[] = [];
    const reloaded: string[] = [];
    let failReloadOfSavedScene = false;
    const manager = new SaveManager(
      () => collectorState,
      (data) => {
        distributed.push(data);
      },
      async (sceneId) => {
        reloaded.push(sceneId);
        if (failReloadOfSavedScene && sceneId === 'dock_board') {
          throw new Error('scene load failed');
        }
      },
      new StringsProvider(),
      'fallback_scene',
    );

    expect(manager.save(0)).toBe(true);
    // 存档之后运行时推进到了另一状态：读档失败必须回滚到这份状态而非半读档混合态
    collectorState = liveState;
    failReloadOfSavedScene = true;

    const loaded = await manager.load(0);

    expect(loaded).toBe(false);
    expect(distributed).toEqual([savedState, liveState]);
    expect(reloaded).toEqual(['dock_board', 'street']);
  });

  it('rolls back and returns false when distribute itself throws', async () => {
    const liveState = { sceneManager: { currentSceneId: 'street' } };
    const distributed: Record<string, object>[] = [];
    const reloaded: string[] = [];
    let distributeCalls = 0;
    const manager = new SaveManager(
      () => liveState,
      (data) => {
        distributeCalls += 1;
        if (distributeCalls === 1) throw new Error('distribute failed');
        distributed.push(data);
      },
      async (sceneId) => {
        reloaded.push(sceneId);
      },
      new StringsProvider(),
      'fallback_scene',
    );

    localStorage.setItem(
      'gamedraft_save_0',
      JSON.stringify({ version: 1, timestamp: 1, systems: { sceneManager: { currentSceneId: 'dock_board' } } }),
    );

    const loaded = await manager.load(0);

    expect(loaded).toBe(false);
    // 第一次 distribute 抛错后只回滚快照 + 重载当前场景，不会再去载存档场景
    expect(distributed).toEqual([liveState]);
    expect(reloaded).toEqual(['street']);
  });

  it('rejects a corrupted save without touching system state', async () => {
    const distributor = vi.fn();
    const reloader = vi.fn();
    const manager = new SaveManager(
      () => ({ sceneManager: { currentSceneId: 'street' } }),
      distributor,
      reloader,
      new StringsProvider(),
      'fallback_scene',
    );

    localStorage.setItem('gamedraft_save_0', '{not valid json');
    expect(await manager.load(0)).toBe(false);

    localStorage.setItem('gamedraft_save_1', JSON.stringify({ version: 1, timestamp: 1 }));
    expect(await manager.load(1)).toBe(false);

    expect(distributor).not.toHaveBeenCalled();
    expect(reloader).not.toHaveBeenCalled();
  });
});

describe('SaveManager storage access hardening', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('hasSave/getSlotMeta/deleteSlot/load survive a throwing localStorage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    });
    const manager = new SaveManager(() => ({}), () => {}, async () => {}, new StringsProvider(), 'fallback_scene');

    expect(manager.hasSave(0)).toBe(false);
    expect(manager.hasAnySave()).toBe(false);
    expect(manager.getSlotMeta(0)).toBeNull();
    expect(() => manager.deleteSlot(0)).not.toThrow();
    expect(manager.save(0)).toBe(false);
    await expect(manager.load(0)).resolves.toBe(false);
  });
});
