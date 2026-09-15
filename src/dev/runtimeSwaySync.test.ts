import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_SWAY_API, RuntimeSwaySync, isFreshSwayPush, shouldReloadSway, swayPreviewDirUrl, type SwaySyncDoc,
} from './runtimeSwaySync';

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

  it('第一次看到槽：本局启动**之后**才推的那行算新推送（推送 → 拉起游戏 → 补发 这条路）', () => {
    const boot = 1000;
    expect(shouldReloadSway({ rev: 5, sceneId: '跑马梁', ts: 1500 }, '跑马梁', -1, boot)).toBe(true);
    expect(isFreshSwayPush({ rev: 5, sceneId: '跑马梁', ts: 1500 }, -1, boot)).toBe(true);
  });

  it('🔴 第一次看到槽：启动之前就留在盘上的那行（刷新 / 昨天推的）照旧不算', () => {
    expect(shouldReloadSway({ rev: 5, sceneId: '跑马梁', ts: 900 }, '跑马梁', -1, 1000)).toBe(false);
    expect(shouldReloadSway({ rev: 5, sceneId: '跑马梁' }, '跑马梁', -1, 1000)).toBe(false);   // 没 ts 的老行
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

  it('🔴 #13 场景还没装完：照样心跳（loading=1、场景空），工作台才不会当"没有游戏页"去再开一个窗口', async () => {
    sceneId = null;
    const s = make();
    reply({ rev: 9, sceneId: '跑马梁' });
    await tick(s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const qs = new URLSearchParams(String(fetchMock.mock.calls[0][0]).split('?')[1]);
    expect(qs.get('loading')).toBe('1');
    expect(qs.get('scene')).toBe('');
    expect(qs.get('boot')).toBeTruthy();
    expect(qs.get('preview')).toBe('0');
    expect(qs.get('applied')).toBe('0');
    expect(reload).not.toHaveBeenCalled();
  });

  it('🔴 #13 装场景期间槽里那行不看；装完第一拍照常认这次推送并原地换上', async () => {
    sceneId = null;
    const s = make();
    // 游戏起来之后、场景装完之前推的（工作台在游戏装场景时按了 P）
    reply({ rev: 6, sceneId: '跑马梁', source: 'preview', ts: Date.now() + 60_000 });
    await tick(s);
    await tick(s);
    expect(reload).not.toHaveBeenCalled();
    expect(s.previewFor('跑马梁')).toBeNull();            // 没装好的场景上不记、不换
    expect(s.bustFor('跑马梁')).toBeUndefined();
    sceneId = '跑马梁';                                   // scene:ready
    await tick(s);
    expect(reload).toHaveBeenCalledWith('6');
    expect(s.previewFor('跑马梁')).toEqual({ rev: 6 });
    const qs = new URLSearchParams(String(fetchMock.mock.calls[2][0]).split('?')[1]);
    expect(qs.get('loading')).toBeNull();                  // 装好了就不带 loading
    expect(qs.get('scene')).toBe('跑马梁');
  });

  it('🔴 #13 原地重装还在等：心跳不断（带 loading=1 与当前场景），这期间来的更新推送等装完再换', async () => {
    const s = make();
    let finish: (ok: boolean) => void = () => {};
    reload.mockImplementation(() => new Promise<boolean>((r) => { finish = r; }));
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick(s);
    reply({ rev: 2, sceneId: '跑马梁', source: 'preview' });
    const first = tick(s);                                 // 开始重装、挂在那儿
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    reply({ rev: 3, sceneId: '跑马梁', source: 'preview' });
    await tick(s);                                         // 定时器照常敲：只发心跳
    await tick(s);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const hb = new URLSearchParams(String(fetchMock.mock.calls[3][0]).split('?')[1]);
    expect(hb.get('loading')).toBe('1');
    expect(hb.get('scene')).toBe('跑马梁');
    expect(hb.get('applied')).toBe('0');
    expect(reload).toHaveBeenCalledTimes(1);               // rev 3 没叠着再装
    finish(true);
    await first;
    expect(s.statusLine()).toMatch(/重装 1 次/);
    reload.mockImplementation(async () => true);
    await tick(s);                                         // 装完之后第一拍：认 rev 3
    expect(reload).toHaveBeenLastCalledWith('3');
    const after = new URLSearchParams(String(fetchMock.mock.calls[4][0]).split('?')[1]);
    expect(after.get('loading')).toBeNull();
    expect(after.get('applied')).toBe('2');
  });

  it('原地重装抛错：不卡死在"重装中"，之后的推送照常换', async () => {
    const s = make();
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick(s);
    reload.mockImplementationOnce(async () => { throw new Error('boom'); });
    reply({ rev: 2, sceneId: '跑马梁' });
    await tick(s);
    expect(s.statusLine()).toContain('boom');
    reply({ rev: 3, sceneId: '跑马梁' });
    await tick(s);
    expect(reload).toHaveBeenLastCalledWith('3');
    const qs = new URLSearchParams(String(fetchMock.mock.calls[2][0]).split('?')[1]);
    expect(qs.get('loading')).toBeNull();
  });

  it('换场景（resetSeen）不丢见过的 rev：同一行不重装，之后更新的推送照常重装', async () => {
    const s = make();
    reply({ rev: 7, sceneId: '跑马梁', ts: Date.now() + 60_000 });   // 本局启动之后推的
    await tick(s);                                       // 第一次看到、而且是新推送：装一次
    expect(reload).toHaveBeenCalledTimes(1);
    s.resetSeen();
    await tick(s);                                       // 换完场景同一行：不再重装（原来清成 -1 会被当新推送再装一遍）
    expect(reload).toHaveBeenCalledTimes(1);
    reply({ rev: 8, sceneId: '跑马梁' });
    await tick(s);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('槽被清掉重来（rev 变小）：按第一次看到处理，不会从此认不出新推送', async () => {
    const s = make();
    reply({ rev: 40, sceneId: '跑马梁' });
    await tick(s);
    reply({ rev: 1, sceneId: '跑马梁' });                // dev server 的槽文件被删了、从 1 数起
    await tick(s);
    expect(reload).not.toHaveBeenCalled();
    reply({ rev: 2, sceneId: '跑马梁' });
    await tick(s);
    expect(reload).toHaveBeenCalledWith('2');
  });

  it('轮询带心跳：场景 / 本局 id / 这个场景用没用预览（工作台据此说真话）', async () => {
    const s = make();
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick(s);
    reply({ rev: 2, sceneId: '跑马梁', source: 'preview' });
    await tick(s);
    await tick(s);
    const url = String(fetchMock.mock.calls[2][0]);
    const qs = new URLSearchParams(url.split('?')[1]);
    expect(qs.get('scene')).toBe('跑马梁');
    expect(qs.get('boot')).toBeTruthy();
    expect(qs.get('preview')).toBe('2');
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
    expect(String(fetchMock.mock.calls[0][0]).split('?')[0]).toBe(RUNTIME_SWAY_API);
  });
});

/**
 * 🔴 推给游戏 ≠ 导出到游戏（制作人 2026-09-14："推给游戏是指立即推送给运行时的游戏！资源写游戏应该叫做导出到游戏"）。
 * 原先的"推给游戏"只让游戏重装盘上已经烘好的那份：涂了、存了、按多少次，游戏里都是上一次烘的样子。
 */
describe('推给游戏的预览 / 导出到游戏', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn<(cacheBust: string) => Promise<boolean>>>;
  let sceneId: string | null;
  let seenAtReload: ({ rev: number } | null)[];
  let s: RuntimeSwaySync;

  const reply = (doc: SwaySyncDoc | null) => {
    fetchMock.mockResolvedValue({ json: async () => ({ doc }) } as unknown as Response);
  };
  const tick = async () => { await (s as unknown as { tick: () => Promise<void> }).tick(); };

  beforeEach(() => {
    sceneId = '跑马梁';
    seenAtReload = [];
    reload = vi.fn<(cacheBust: string) => Promise<boolean>>(async () => {
      seenAtReload.push(s.previewFor('跑马梁'));
      return true;
    });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    });
    vi.stubGlobal('AbortController', class { signal = {}; abort() { /* 测试里不真中断 */ } });
    s = new RuntimeSwaySync({ currentSceneId: () => sceneId, reload });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('推来预览：这个场景记成"用预览"，而且重装的那一刻已经记上了（重装读的就是预览）', async () => {
    reply({ rev: 3, sceneId: '跑马梁', source: 'export' });
    await tick();
    reply({ rev: 4, sceneId: '跑马梁', source: 'preview' });
    await tick();
    expect(reload).toHaveBeenCalledWith('4');
    expect(seenAtReload).toEqual([{ rev: 4 }]);
    expect(s.previewFor('跑马梁')).toEqual({ rev: 4 });
  });

  it('导出之后忘掉预览、换回资源', async () => {
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick();
    reply({ rev: 2, sceneId: '跑马梁', source: 'preview' });
    await tick();
    reply({ rev: 3, sceneId: '跑马梁', source: 'export' });
    await tick();
    expect(s.previewFor('跑马梁')).toBeNull();
    expect(seenAtReload).toEqual([{ rev: 2 }, null]);
  });

  it('玩家在别的场景：预览照样记下（进那个场景时用），但不去重装眼前这个场景', async () => {
    sceneId = '雾津街头';
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick();
    reply({ rev: 2, sceneId: '跑马梁', source: 'preview' });
    await tick();
    expect(reload).not.toHaveBeenCalled();
    expect(s.previewFor('跑马梁')).toEqual({ rev: 2 });
    expect(s.previewFor('雾津街头')).toBeNull();
  });

  it('🔴 刷新后第一眼看到的预览不算：槽文件跨重启留在盘上，那可能是昨天推的、从没导出过的东西', async () => {
    reply({ rev: 9, sceneId: '跑马梁', source: 'preview', ts: 1 });
    await tick();
    expect(s.previewFor('跑马梁')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('游戏刚被拉起、第一眼看到的是它启动之后补发的预览：记上并装上（原来补发永远落空）', async () => {
    reply({ rev: 9, sceneId: '跑马梁', source: 'preview', ts: Date.now() + 60_000 });
    await tick();
    expect(s.previewFor('跑马梁')).toEqual({ rev: 9 });
    expect(reload).toHaveBeenCalledWith('9');
  });

  it('🔴 #28 导出之后进场景也带缓存戳：推过（预览或导出）的场景一律拿最近那次 rev，没推过的不带', async () => {
    expect(s.bustFor('跑马梁')).toBeUndefined();          // 这一局没推过：照常装资源、不搅缓存
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick();                                          // 第一眼看到、启动之前的老行：不算推送
    expect(s.bustFor('跑马梁')).toBeUndefined();
    reply({ rev: 2, sceneId: '跑马梁', source: 'preview' });
    await tick();
    expect(s.bustFor('跑马梁')).toBe('2');
    reply({ rev: 8, sceneId: '跑马梁', source: 'export' });
    await tick();
    // 导出忘掉了预览，但缓存戳留着：走出去再进来请求的是 sway.json?v=8，不是 JSON 桶里导出前那份
    expect(s.previewFor('跑马梁')).toBeNull();
    expect(s.bustFor('跑马梁')).toBe('8');
    // 玩家在别的场景时导出的：进那个场景照样带戳
    sceneId = '雾津街头';
    reply({ rev: 9, sceneId: '崖墓前段', source: 'export' });
    await tick();
    expect(s.bustFor('崖墓前段')).toBe('9');
    expect(s.bustFor('雾津街头')).toBeUndefined();
  });

  it('心跳带 applied：只有真换上的推送才涨（原地重装装不上时不涨，工作台据此不打勾）', async () => {
    reply({ rev: 1, sceneId: '跑马梁' });
    await tick();
    reply({ rev: 2, sceneId: '跑马梁', source: 'preview' });
    await tick();                                          // 装上了
    reload.mockImplementation(async () => false);
    reply({ rev: 3, sceneId: '跑马梁', source: 'preview' });
    await tick();                                          // 装不上
    await tick();                                          // 这一拍的心跳
    const last = new URLSearchParams(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]).split('?')[1]);
    expect(last.get('applied')).toBe('2');
    s.noteApplied('跑马梁', 3);                            // 进场景时按 ?v=3 装上的（Game.buildSway 记）
    await tick();
    const after = new URLSearchParams(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]).split('?')[1]);
    expect(after.get('applied')).toBe('3');
  });

  it('预览目录 URL：场景 id 与烘焙目录名都编码（中文 / 全角符号）', () => {
    expect(swayPreviewDirUrl('跑马梁', '跑马梁－深夜')).toBe(
      `${RUNTIME_SWAY_API}/preview/${encodeURIComponent('跑马梁')}/${encodeURIComponent('跑马梁－深夜')}`);
  });
});
