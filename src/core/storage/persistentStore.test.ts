import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MemoryStore,
  STORE_API_PREFIX,
  __setPersistentStoreForTests,
  resolvePersistentStore,
} from './persistentStore';

afterEach(() => {
  __setPersistentStoreForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MemoryStore', () => {
  it('按命名空间隔离，且诚实地说自己不持久', async () => {
    const s = new MemoryStore();
    expect(s.persisted).toBe(false);
    await s.write('saves', 'slot0', '{"a":1}');
    await s.write('settings', 'slot0', '{"b":2}');

    expect(await s.readAll('saves')).toEqual({ slot0: '{"a":1}' });
    expect(await s.readAll('settings')).toEqual({ slot0: '{"b":2}' });
  });

  it('删掉之后读不到', async () => {
    const s = new MemoryStore();
    await s.write('saves', 'slot0', '{}');
    await s.remove('saves', 'slot0');
    expect(await s.readAll('saves')).toEqual({});
  });

  it('非法名字当场抛，而不是拼进路径', async () => {
    const s = new MemoryStore();
    await expect(s.write('saves', '../evil', '{}')).rejects.toThrow(/非法/);
    await expect(s.write('sa/ves', 'slot0', '{}')).rejects.toThrow(/非法/);
    await expect(s.write('saves', 'a.json', '{}')).rejects.toThrow(/非法/);
  });
});

describe('后端挑选', () => {
  it('Tauri 在就用 Tauri', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'gamedata_read_all' ? {} : undefined));
    vi.stubGlobal('__TAURI__', { core: { invoke } });
    const store = await resolvePersistentStore();
    expect(store.kind).toBe('tauri');
    expect(store.persisted).toBe(true);
  });

  it('Tauri v1 的 __TAURI__.invoke 形状也认', async () => {
    const invoke = vi.fn(async () => ({}));
    vi.stubGlobal('__TAURI__', { invoke });
    expect((await resolvePersistentStore()).kind).toBe('tauri');
  });

  it('没有 Tauri 就试 dev server', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toContain(STORE_API_PREFIX);
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }));
    expect((await resolvePersistentStore()).kind).toBe('http');
  });

  it('两个都没有就降级到内存，并且降级是**说出来**的', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const store = await resolvePersistentStore();
    expect(store.kind).toBe('memory');
    expect(store.persisted).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('Tauri 存在但用不了时继续往下探，不是直接死', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('__TAURI__', {
      core: {
        invoke: vi.fn(async () => {
          throw new Error('command not found');
        }),
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) } as unknown as Response)));
    expect((await resolvePersistentStore()).kind).toBe('http');
  });

  it('并发调用只探测一次 —— 入口卫兵与两个 hydrate 会同时进来', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({}) } as unknown as Response));
    vi.stubGlobal('fetch', fetchSpy);

    const [a, b, c] = await Promise.all([
      resolvePersistentStore(),
      resolvePersistentStore(),
      resolvePersistentStore(),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('HttpFileStore 线协议', () => {
  it('readAll 只收字符串值，脏值被丢掉而不是塞进存档', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ slot0: '{"a":1}', slot1: 42, slot2: null }),
    } as unknown as Response)));
    const store = await resolvePersistentStore();
    expect(await store.readAll('saves')).toEqual({ slot0: '{"a":1}' });
  });

  it('写失败要抛 —— 调用方必须能看见"没写上"', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (!init?.method) return { ok: true, json: async () => ({}) } as unknown as Response;
      return { ok: false, status: 507 } as unknown as Response;
    }));
    const store = await resolvePersistentStore();
    await expect(store.write('saves', 'slot0', '{}')).rejects.toThrow(/507/);
  });

  it('删一个本来就没有的键算成功（404 不是错误）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      if (!init?.method) return { ok: true, json: async () => ({}) } as unknown as Response;
      return { ok: false, status: 404 } as unknown as Response;
    }));
    const store = await resolvePersistentStore();
    await expect(store.remove('saves', 'slot0')).resolves.toBeUndefined();
  });
});
