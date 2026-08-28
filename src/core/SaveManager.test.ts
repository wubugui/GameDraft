import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SaveManager } from './SaveManager';
import { StringsProvider } from './StringsProvider';
import {
  MemoryStore,
  __setPersistentStoreForTests,
  type PersistentStore,
} from './storage/persistentStore';

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

/** 装一个干净的文件后端 + 空的 localStorage，返回后端供断言磁盘上到底有什么。 */
function useFreshStore(): MemoryStore {
  const store = new MemoryStore();
  __setPersistentStoreForTests(store);
  vi.stubGlobal('localStorage', createMemoryStorage());
  return store;
}

async function makeManager(
  collector: () => Record<string, object>,
  distributor: (data: Record<string, object>) => void = () => {},
  reloader: (sceneId: string) => Promise<void> = async () => {},
): Promise<SaveManager> {
  const m = new SaveManager(collector, distributor, reloader, new StringsProvider(), 'fallback_scene');
  await m.hydrate();
  return m;
}

afterEach(() => {
  __setPersistentStoreForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SaveManager save/load/re-enter smoke', () => {
  beforeEach(() => {
    useFreshStore();
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
    const manager = await makeManager(
      () => savedSystems,
      (data) => {
        distributed = data;
      },
      async (sceneId) => {
        reloadedScenes.push(sceneId);
      },
    );

    expect(await manager.save(1)).toBe(true);
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
    const manager = await makeManager(
      () => ({ sceneManager: { currentSceneId: null, memory: {} } }),
      () => {},
      async (sceneId) => {
        reloadedScenes.push(sceneId);
      },
    );

    await manager.save(0);
    const loaded = await manager.load(0);

    expect(loaded).toBe(true);
    expect(reloadedScenes).toEqual(['fallback_scene']);
  });

  it('does not distribute or reload when loading a missing slot', async () => {
    const distributed = vi.fn();
    const reloader = vi.fn();
    const manager = await makeManager(
      () => ({ sceneManager: { currentSceneId: 'dock_board', memory: {} } }),
      distributed,
      reloader,
    );

    const loaded = await manager.load(2);

    expect(loaded).toBe(false);
    expect(distributed).not.toHaveBeenCalled();
    expect(reloader).not.toHaveBeenCalled();
  });

  it('exports and imports the same interoperable JSON systems envelope', async () => {
    const systems = { sceneManager: { currentSceneId: 'dock_board' }, dialogueLog: { entries: [{ text: '跨壳' }] } };
    const producer = await makeManager(() => systems);
    expect(await producer.save(0)).toBe(true);
    const payload = producer.exportSlotPayload(0);
    expect(payload).not.toBeNull();
    await producer.deleteSlot(0);
    expect(await producer.importSlotPayload(2, payload!)).toBe(true);
    expect(JSON.parse(producer.exportSlotPayload(2)!).systems).toEqual(systems);
    expect(await producer.importSlotPayload(1, '{broken')).toBe(false);
    expect(await producer.importSlotPayload(1, JSON.stringify({ version: 1 }))).toBe(false);
  });

  it('存档真的落到文件后端上，而不只是留在内存镜像里', async () => {
    const store = useFreshStore();
    const manager = await makeManager(() => ({ sceneManager: { currentSceneId: 's1' } }));
    expect(await manager.save(2)).toBe(true);

    const onDisk = await store.readAll('saves');
    expect(Object.keys(onDisk)).toContain('slot2');
    expect(JSON.parse(onDisk.slot2).systems).toEqual({ sceneManager: { currentSceneId: 's1' } });

    // 新一局（新实例）从同一个后端水化，应当看得见这个档
    const next = await makeManager(() => ({}));
    expect(next.hasSave(2)).toBe(true);
    expect(next.getSlotMeta(2)).toMatchObject({ slot: 2, sceneId: 's1' });
  });

  it('deleteSlot 同时清掉镜像与磁盘', async () => {
    const store = useFreshStore();
    const manager = await makeManager(() => ({ sceneManager: { currentSceneId: 's1' } }));
    await manager.save(0);
    expect(await manager.deleteSlot(0)).toBe(true);

    expect(manager.hasSave(0)).toBe(false);
    expect(Object.keys(await store.readAll('saves'))).not.toContain('slot0');
  });

  it('删除失败时**不动镜像** —— 否则重启后那个档会复活', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const backing = new MemoryStore();
    const flaky: PersistentStore = {
      kind: 'http',
      persisted: true,
      readAll: (ns) => backing.readAll(ns),
      write: (ns, k, v) => backing.write(ns, k, v),
      remove: async () => { throw new Error('EBUSY'); },
    };
    __setPersistentStoreForTests(flaky);
    vi.stubGlobal('localStorage', createMemoryStorage());
    const manager = await makeManager(() => ({ sceneManager: { currentSceneId: 's1' } }));
    await manager.save(0);

    expect(await manager.deleteSlot(0)).toBe(false);
    expect(manager.hasSave(0)).toBe(true); // 磁盘上还在，镜像就得跟着还在
  });

  it('连着存同一个槽：磁盘与镜像最终一致（写入按调用顺序串行）', async () => {
    const store = useFreshStore();
    let scene = 'a';
    const manager = await makeManager(() => ({ sceneManager: { currentSceneId: scene } }));

    // 不 await 地连发三次，中间换状态——没有序列化的话磁盘可能留下先发的那份
    scene = 'a'; const p1 = manager.save(0);
    scene = 'b'; const p2 = manager.save(0);
    scene = 'c'; const p3 = manager.save(0);
    await Promise.all([p1, p2, p3]);

    const onDisk = JSON.parse((await store.readAll('saves')).slot0);
    expect(manager.getSlotMeta(0)?.sceneId).toBe(onDisk.systems.sceneManager.currentSceneId);
  });
});

describe('SaveManager 旧档迁移（localStorage → 文件）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  function legacyPayload(sceneId: string): string {
    return JSON.stringify({ version: 1, timestamp: 7, systems: { sceneManager: { currentSceneId: sceneId } } });
  }

  it('把浏览器里的旧档搬进文件存储，原件保留', async () => {
    const store = useFreshStore();
    localStorage.setItem('gamedraft_save_0', legacyPayload('old_scene'));

    const manager = await makeManager(() => ({}));

    expect(manager.hasSave(0)).toBe(true);
    expect(manager.getSlotMeta(0)).toMatchObject({ sceneId: 'old_scene' });
    expect(Object.keys(await store.readAll('saves'))).toContain('slot0');
    // 搬运是复制：原件必须还在，新体系出问题时还能回去拿
    expect(localStorage.getItem('gamedraft_save_0')).not.toBeNull();
  });

  it('文件侧已有档时绝不被旧档盖掉', async () => {
    const store = useFreshStore();
    await store.write('saves', 'slot0', legacyPayload('file_scene'));
    localStorage.setItem('gamedraft_save_0', legacyPayload('browser_scene'));

    const manager = await makeManager(() => ({}));

    expect(manager.getSlotMeta(0)).toMatchObject({ sceneId: 'file_scene' });
  });

  it('迁移标记写在 localStorage 一侧 —— 换 worktree / 清 local/ 都不会让旧档复活', async () => {
    const store = useFreshStore();
    localStorage.setItem('gamedraft_save_1', legacyPayload('old_scene'));

    await makeManager(() => ({}));
    // 标记不在文件侧：那儿是 gitignore 的每机状态，清一次就丢，旧档会每次都被灌回来
    expect(Object.keys(await store.readAll('saves'))).not.toContain('migrated_from_localstorage');
    expect(localStorage.getItem('gamedraft_saves_migrated_to_files')).not.toBeNull();

    // 模拟「换了个 worktree / 把 local/ 清了」：文件侧全空，但来源侧标记还在
    const wiped = new MemoryStore();
    __setPersistentStoreForTests(wiped);
    const second = await makeManager(() => ({}));
    expect(second.hasSave(1)).toBe(false);
  });

  it('迁移中途失败不打标记，下次启动还会再试', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing: PersistentStore = {
      kind: 'http',
      persisted: true,
      readAll: async () => ({}),
      write: async () => { throw new Error('EACCES'); },
      remove: async () => {},
    };
    __setPersistentStoreForTests(failing);
    vi.stubGlobal('localStorage', createMemoryStorage());
    localStorage.setItem('gamedraft_save_0', legacyPayload('old'));

    await makeManager(() => ({}));
    expect(localStorage.getItem('gamedraft_saves_migrated_to_files')).toBeNull();
  });

  it('坏掉的旧档跳过，不阻断其它槽的迁移', async () => {
    useFreshStore();
    localStorage.setItem('gamedraft_save_0', '{not json');
    localStorage.setItem('gamedraft_save_1', legacyPayload('good'));

    const manager = await makeManager(() => ({}));

    expect(manager.hasSave(0)).toBe(false);
    expect(manager.hasSave(1)).toBe(true);
  });
});

describe('SaveManager save failure reporting', () => {
  beforeEach(() => {
    useFreshStore();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('returns false when the storage write throws (磁盘满 / 无权限)', async () => {
    const throwing: PersistentStore = {
      kind: 'http',
      persisted: true,
      readAll: async () => ({}),
      write: async () => {
        throw new Error('EACCES');
      },
      remove: async () => {},
    };
    __setPersistentStoreForTests(throwing);
    const manager = await makeManager(() => ({ sceneManager: { currentSceneId: 's1' } }));

    expect(await manager.save(0)).toBe(false);
    // 写失败绝不能污染镜像：菜单不该显示一个磁盘上并不存在的档
    expect(manager.hasSave(0)).toBe(false);
  });

  it('returns false when the canSave predicate rejects', async () => {
    const collector = vi.fn(() => ({}));
    const manager = await makeManager(collector);
    manager.setCanSavePredicate(() => false);

    expect(await manager.save(0)).toBe(false);
    expect(collector).not.toHaveBeenCalled();
    expect(manager.hasSave(0)).toBe(false);
  });

  it('returns false for an out-of-range slot', async () => {
    const manager = await makeManager(() => ({}));
    expect(await manager.save(-1)).toBe(false);
    expect(await manager.save(3)).toBe(false);
  });

  it('没 hydrate 就存档 = 拒绝并报错，而不是假装成功', async () => {
    __setPersistentStoreForTests(null);
    const manager = new SaveManager(
      () => ({}), () => {}, async () => {}, new StringsProvider(), 'fallback_scene',
    );
    expect(await manager.save(0)).toBe(false);
  });
});

describe('SaveManager 降级诚实性', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('内存后端下 isPersistent() 为 false —— UI 据此告诉玩家进度不会留下', async () => {
    __setPersistentStoreForTests(new MemoryStore());
    vi.stubGlobal('localStorage', createMemoryStorage());
    const manager = await makeManager(() => ({ sceneManager: { currentSceneId: 's1' } }));

    expect(manager.isPersistent()).toBe(false);
    expect(manager.storeKind()).toBe('memory');
    // 仍然能存能读，只是关掉就没了
    expect(await manager.save(0)).toBe(true);
  });

  it('后端 readAll 抛错时降级成"无档"，不炸开局', async () => {
    const broken: PersistentStore = {
      kind: 'http',
      persisted: true,
      readAll: async () => {
        throw new Error('ECONNREFUSED');
      },
      write: async () => {},
      remove: async () => {},
    };
    __setPersistentStoreForTests(broken);
    vi.stubGlobal('localStorage', createMemoryStorage());

    const manager = await makeManager(() => ({}));
    expect(manager.hasAnySave()).toBe(false);
    expect(manager.getSlotMeta(0)).toBeNull();
    await expect(manager.load(0)).resolves.toBe(false);
  });
});

describe('SaveManager load atomicity', () => {
  beforeEach(() => {
    useFreshStore();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    const manager = await makeManager(
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
    );

    expect(await manager.save(0)).toBe(true);
    // 存档之后运行时推进到了另一状态：读档失败必须回滚到这份状态而非半读档混合态
    collectorState = liveState;
    failReloadOfSavedScene = true;

    const loaded = await manager.load(0);

    expect(loaded).toBe(false);
    expect(distributed).toEqual([savedState, liveState]);
    expect(reloaded).toEqual(['dock_board', 'street']);
  });

  it('rolls back and returns false when distribute itself throws', async () => {
    const store = useFreshStore();
    const liveState = { sceneManager: { currentSceneId: 'street' } };
    const distributed: Record<string, object>[] = [];
    const reloaded: string[] = [];
    let distributeCalls = 0;
    await store.write(
      'saves',
      'slot0',
      JSON.stringify({ version: 1, timestamp: 1, systems: { sceneManager: { currentSceneId: 'dock_board' } } }),
    );
    const manager = await makeManager(
      () => liveState,
      (data) => {
        distributeCalls += 1;
        if (distributeCalls === 1) throw new Error('distribute failed');
        distributed.push(data);
      },
      async (sceneId) => {
        reloaded.push(sceneId);
      },
    );

    const loaded = await manager.load(0);

    expect(loaded).toBe(false);
    // 第一次 distribute 抛错后只回滚快照 + 重载当前场景，不会再去载存档场景
    expect(distributed).toEqual([liveState]);
    expect(reloaded).toEqual(['street']);
  });

  it('rejects a corrupted save without touching system state', async () => {
    const store = useFreshStore();
    const distributor = vi.fn();
    const reloader = vi.fn();
    await store.write('saves', 'slot0', '{not valid json');
    await store.write('saves', 'slot1', JSON.stringify({ version: 1, timestamp: 1 }));
    const manager = await makeManager(
      () => ({ sceneManager: { currentSceneId: 'street' } }),
      distributor,
      reloader,
    );

    expect(await manager.load(0)).toBe(false);
    expect(await manager.load(1)).toBe(false);

    expect(distributor).not.toHaveBeenCalled();
    expect(reloader).not.toHaveBeenCalled();
  });
});

describe('SaveManager storage access hardening', () => {
  it('localStorage 抛 SecurityError 时，迁移路径不炸，查询照常返回空', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setPersistentStoreForTests(new MemoryStore());
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
    const manager = await makeManager(() => ({}));

    expect(manager.hasSave(0)).toBe(false);
    expect(manager.hasAnySave()).toBe(false);
    expect(manager.getSlotMeta(0)).toBeNull();
    await expect(manager.deleteSlot(0)).resolves.toBe(true);
    await expect(manager.load(0)).resolves.toBe(false);
  });
});
