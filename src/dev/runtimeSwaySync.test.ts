import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_SWAY_API, RuntimeSwaySync, shouldReloadSway, type SwaySyncDoc } from './runtimeSwaySync';

const DOC: SwaySyncDoc = { rev: 5, sceneId: '跑马梁', ts: 1 };

describe('要不要按这份推送重装拆层', () => {
  it('比见过的新、场景对得上 ⇒ 重装', () => {
    expect(shouldReloadSway(DOC, '跑马梁', 4)).toBe(true);
  });

  it('🔴 第一次看到槽只记 rev 不重装', () => {
    // 否则每刷新一次页面，都会把上一次的推送重放一遍（声学那条踩过）
    expect(shouldReloadSway(DOC, '跑马梁', -1)).toBe(false);
  });

  it('场景对不上不动：作者在别的场景烘的，别把这边换掉', () => {
    expect(shouldReloadSway(DOC, '雾津街头', 4)).toBe(false);
  });

  it('rev 不比见过的新就不动（同一份不重复干活）', () => {
    expect(shouldReloadSway(DOC, '跑马梁', 5)).toBe(false);
    expect(shouldReloadSway(DOC, '跑马梁', 9)).toBe(false);
  });

  it('残缺 / 没进场景 ⇒ 不动', () => {
    expect(shouldReloadSway(null, '跑马梁', 1)).toBe(false);
    expect(shouldReloadSway({ sceneId: '跑马梁' }, '跑马梁', 1)).toBe(false);
    expect(shouldReloadSway(DOC, null, 1)).toBe(false);
  });
});

describe('RuntimeSwaySync 的轮询', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn<(cacheBust: string) => Promise<boolean>>>;
  let sceneId: string | null;

  const reply = (doc: SwaySyncDoc | null) => {
    fetchMock.mockResolvedValue({ json: async () => ({ doc }) } as unknown as Response);
  };
  const make = () => new RuntimeSwaySync({ currentSceneId: () => sceneId, reload });
  /** 直接敲一拍（不等真定时器） */
  const tick = async (s: RuntimeSwaySync) => {
    await (s as unknown as { tick: () => Promise<void> }).tick();
  };

  beforeEach(() => {
    sceneId = '跑马梁';
    reload = vi.fn<(cacheBust: string) => Promise<boolean>>(async () => true);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    });
    vi.stubGlobal('AbortController', class { signal = {}; abort() { /* 测试里不真中断 */ } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('第一拍只认 rev，第二拍才重装；重装带的是 rev 当缓存戳', async () => {
    const s = make();
    reply({ rev: 3, sceneId: '跑马梁' });
    await tick(s);
    expect(reload).not.toHaveBeenCalled();

    reply({ rev: 4, sceneId: '跑马梁' });
    await tick(s);
    expect(reload).toHaveBeenCalledWith('4');           // ?v=4 才绕得开纹理缓存
  });

  it('同一个 rev 敲两次只重装一次', async () => {
    const s = make();
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick(s);
    reply({ rev: 2, sceneId: '跑马梁' });
    await tick(s);
    await tick(s);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('没进场景时连问都不问（省得空转）', async () => {
    sceneId = null;
    const s = make();
    reply({ rev: 9, sceneId: '跑马梁' });
    await tick(s);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('换场景后 resetSeen：新场景的拆层刚装过，别拿旧 rev 去比', async () => {
    const s = make();
    reply({ rev: 7, sceneId: '跑马梁' });
    await tick(s);
    await tick(s);                                       // 认下 7，不重装
    s.resetSeen();
    await tick(s);                                       // 又是"第一次看到"，仍不重装
    expect(reload).not.toHaveBeenCalled();
  });

  it('连不上：不抛出去、退避、statusLine 说得出断了', async () => {
    const s = make();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(tick(s)).resolves.toBeUndefined();
    expect(s.statusLine()).toContain('ECONNREFUSED');
    // 退避期内不再敲
    const calls = fetchMock.mock.calls.length;
    await tick(s);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('statusLine 带收发计数（"以为在同步、其实早断了"是最贵的一种坏）', async () => {
    const s = make();
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick(s);
    reply({ rev: 2, sceneId: '跑马梁' });
    await tick(s);
    expect(s.statusLine()).toMatch(/轮询 2 次 \/ 重装 1 次/);
  });

  it('打的是约定的那条路径', async () => {
    const s = make();
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick(s);
    expect(fetchMock.mock.calls[0][0]).toBe(RUNTIME_SWAY_API);
  });
});
