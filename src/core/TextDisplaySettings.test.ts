import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TextDisplaySettings,
  TYPEWRITER_SCALE_DEFAULT,
  TYPEWRITER_SCALE_MAX,
  TYPEWRITER_SCALE_MIN,
  sliderToTypewriterScale,
  typewriterScaleToSlider,
} from './TextDisplaySettings';
import {
  MemoryStore,
  __setPersistentStoreForTests,
  type PersistentStore,
} from './storage/persistentStore';

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key: string) { return data.has(key) ? data.get(key)! : null; },
    key(index: number) { return Array.from(data.keys())[index] ?? null; },
    removeItem(key: string) { data.delete(key); },
    setItem(key: string, value: string) { data.set(key, value); },
  };
}

function useFreshStore(): MemoryStore {
  const store = new MemoryStore();
  __setPersistentStoreForTests(store);
  vi.stubGlobal('localStorage', createMemoryStorage());
  return store;
}

/** 造一个已经水化完的实例（构造后按缺省跑，hydrate 完才是真实偏好）。 */
async function hydrated(): Promise<TextDisplaySettings> {
  const s = new TextDisplaySettings();
  await s.hydrate();
  return s;
}

describe('TextDisplaySettings', () => {
  beforeEach(() => {
    useFreshStore();
  });

  afterEach(() => {
    __setPersistentStoreForTests(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('缺省是「开着的逐字显示 + 基准速度」', async () => {
    const s = await hydrated();
    expect(s.isTypewriterEnabled()).toBe(true);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('构造后未 hydrate 也能用（按缺省跑，不抛）', () => {
    const s = new TextDisplaySettings();
    expect(s.isTypewriterEnabled()).toBe(true);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('改动落盘到文件后端，下一局（新实例）读得回来', async () => {
    const store = useFreshStore();
    const first = await hydrated();
    first.setTypewriterEnabled(false);
    first.setTypewriterSpeedScale(2);
    // persist 是即发即走，让微任务队列跑完再断言磁盘
    await Promise.resolve();
    await Promise.resolve();

    const onDisk = await store.readAll('settings');
    expect(JSON.parse(onDisk.textDisplay)).toEqual({ typewriterEnabled: false, speedScale: 2 });

    const second = await hydrated();
    expect(second.isTypewriterEnabled()).toBe(false);
    expect(second.getTypewriterSpeedScale()).toBe(2);
  });

  it('把浏览器里的旧偏好搬进文件存储，原件保留', async () => {
    const store = useFreshStore();
    localStorage.setItem(
      'gamedraft_text_display',
      JSON.stringify({ typewriterEnabled: false, speedScale: 1.5 }),
    );

    const s = await hydrated();

    expect(s.isTypewriterEnabled()).toBe(false);
    expect(s.getTypewriterSpeedScale()).toBe(1.5);
    expect(JSON.parse((await store.readAll('settings')).textDisplay).speedScale).toBe(1.5);
    expect(localStorage.getItem('gamedraft_text_display')).not.toBeNull();
  });

  it('文件侧已有偏好时不被浏览器旧值盖掉', async () => {
    const store = useFreshStore();
    await store.write('settings', 'textDisplay', JSON.stringify({ speedScale: 2 }));
    localStorage.setItem('gamedraft_text_display', JSON.stringify({ speedScale: 0.5 }));

    const s = await hydrated();
    expect(s.getTypewriterSpeedScale()).toBe(2);
  });

  it('越界与 NaN 一律夹回区间，不会把速度写成 0 或 NaN（0 = 永远打不完）', async () => {
    const s = await hydrated();
    s.setTypewriterSpeedScale(999);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_MAX);
    s.setTypewriterSpeedScale(0);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_MIN);
    s.setTypewriterSpeedScale(Number.NaN);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('偏好里的脏值 / 坏 JSON 不污染本局（退回缺省）', async () => {
    const store = useFreshStore();
    await store.write('settings', 'textDisplay', '{"typewriterEnabled":"yes","speedScale":"快"}');
    const dirty = await hydrated();
    expect(dirty.isTypewriterEnabled()).toBe(true);
    expect(dirty.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);

    const store2 = useFreshStore();
    await store2.write('settings', 'textDisplay', '{not json');
    const broken = await hydrated();
    expect(broken.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('后端读写抛错时仍然可用（本局生效、下次记不住）', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken: PersistentStore = {
      kind: 'http',
      persisted: true,
      readAll: async () => { throw new Error('ECONNREFUSED'); },
      write: async () => { throw new Error('EACCES'); },
      remove: async () => {},
    };
    __setPersistentStoreForTests(broken);
    vi.stubGlobal('localStorage', createMemoryStorage());

    const s = await hydrated();
    expect(() => s.setTypewriterEnabled(false)).not.toThrow();
    expect(s.isTypewriterEnabled()).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('localStorage 抛异常时迁移路径不炸（沙箱 / 隐私模式）', async () => {
    __setPersistentStoreForTests(new MemoryStore());
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
      clear() { throw new Error('blocked'); },
      key() { return null; },
      length: 0,
    });
    const s = await hydrated();
    expect(() => s.setTypewriterEnabled(false)).not.toThrow();
    expect(s.isTypewriterEnabled()).toBe(false);
  });

  it('滑条映射：默认 1× 正好落在轨道正中，两端对上区间端点', () => {
    expect(typewriterScaleToSlider(TYPEWRITER_SCALE_DEFAULT)).toBeCloseTo(0.5, 6);
    expect(typewriterScaleToSlider(TYPEWRITER_SCALE_MIN)).toBeCloseTo(0, 6);
    expect(typewriterScaleToSlider(TYPEWRITER_SCALE_MAX)).toBeCloseTo(1, 6);
    expect(sliderToTypewriterScale(0)).toBe(TYPEWRITER_SCALE_MIN);
    expect(sliderToTypewriterScale(1)).toBe(TYPEWRITER_SCALE_MAX);
    expect(sliderToTypewriterScale(0.5)).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('滑条取值吸附到 5% 一档（免得数值列写出 103%）', () => {
    for (let v = 0; v <= 1.0001; v += 0.017) {
      const scale = sliderToTypewriterScale(v);
      expect(Math.round(scale * 100) % 5).toBe(0);
    }
  });
});
