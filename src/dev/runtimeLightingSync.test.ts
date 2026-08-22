import { describe, expect, it } from 'vitest';

import {
  RuntimeLightingSync,
  isDocStale,
  shouldApplyDoc,
  type LightingSyncDoc,
} from './runtimeLightingSync';

/**
 * 同步的判定规则**两侧各实现一份**（这里 TS、编辑器那边 Python）。
 * 规则分家不会报错，只表现为"某一边偶尔不跟"——极难查。所以两边各锁一份同口径的测试：
 * 本文件与 `tools/editor/editors/tests/test_scene_lights.py::TestLightingSyncRules`。
 */

const DOC: LightingSyncDoc = {
  rev: 5,
  writer: 'editor:1',
  sceneId: 'wujin',
  lighting: {
    sky: { intensity: 1, hemi: 0.7 },
    day: { sunIntensity: 0, sunElevationDeg: 50, sunAzimuthDeg: 180 },
    lights: [],
    display: { ev: 0, tonemap: 'filmic', whiteKelvin: 7000, contrast: 1, saturation: 1, lift: 0, liftKelvin: 10000 },
  },
};

describe('要不要应用对面来的这份光照', () => {
  it('别人写的、比见过的新、同一个场景 → 应用', () => {
    expect(shouldApplyDoc(DOC, 'game:a', 4, 'wujin')).toBe(true);
  });

  it('自己写的不读回来（否则自己写自己读，回声写循环）', () => {
    expect(shouldApplyDoc(DOC, 'editor:1', 4, 'wujin')).toBe(false);
  });

  it('rev 不比见过的新就不动（重复轮询到同一份不该反复套用）', () => {
    expect(shouldApplyDoc(DOC, 'game:a', 5, 'wujin')).toBe(false);
    expect(shouldApplyDoc(DOC, 'game:a', 6, 'wujin')).toBe(false);
  });

  it('跨场景一律不套用——套上去就是把灯摆进错的场景，且当场看不出来', () => {
    expect(shouldApplyDoc(DOC, 'game:a', 4, 'teahouse')).toBe(false);
    expect(shouldApplyDoc(DOC, 'game:a', 4, null)).toBe(false);
  });

  it('空文档 / 缺 lights 的残缺文档不套用', () => {
    expect(shouldApplyDoc(null, 'game:a', 0, 'wujin')).toBe(false);
    expect(shouldApplyDoc(undefined, 'game:a', 0, 'wujin')).toBe(false);
    const broken = { ...DOC, lighting: { ...DOC.lighting, lights: undefined } };
    expect(shouldApplyDoc(broken as unknown as LightingSyncDoc, 'game:a', 0, 'wujin')).toBe(false);
  });
});

describe('陈年残留不复活', () => {
  it('超过新鲜期（5 分钟）的不自动套用', () => {
    // 槽是“当前会话的对讲机”，不是状态存档：没这道闸，昨天调灯的残留
    // 会在今天游戏一开就被当成“对面刚改的”套回来。
    expect(isDocStale(6 * 60 * 1000)).toBe(true);
    expect(isDocStale(60 * 1000)).toBe(false);
  });

  it('拿不到岁数就当新鲜——宁可同步，也别假装没有对面', () => {
    expect(isDocStale(null)).toBe(false);
    expect(isDocStale(undefined)).toBe(false);
  });
});

describe('不许「连着连着就没了」', () => {
  const mk = (): RuntimeLightingSync => new RuntimeLightingSync({
    getSceneId: () => 'wujin',
    getParams: () => DOC.lighting,
    applyParams: () => {},
    isBusy: () => false,
    exportFixup: (d) => d,
    getSelectedId: () => null,
    setSelectedId: () => {},
    log: () => {},
  }, 'game:test');

  it('连不上时指数退避到 3s，一成功立刻回到 400ms', () => {
    // 失败后仍按 400ms 猛发会刷屏日志、也占着别的调试通道的带宽；
    // 但退避绝不能"退了就回不来"——恢复必须是立刻的。
    const s = mk();
    expect(s.status().pollMs).toBe(400);
    (s as unknown as { failStreak: number }).failStreak = 1;
    expect(s.status().pollMs).toBe(800);
    (s as unknown as { failStreak: number }).failStreak = 9;
    expect(s.status().pollMs).toBe(3000);
    (s as unknown as { failStreak: number }).failStreak = 0;
    expect(s.status().pollMs).toBe(400);
  });

  it('状态对外可见：没连过 / 连着但空转 / 真在同步 / 断了，四态都有话说', () => {
    const s = mk();
    const poke = (k: string, v: unknown): void => {
      (s as unknown as Record<string, unknown>)[k] = v;
    };

    expect(s.status().connected).toBe(false);
    expect(s.statusLine()).toContain('等待连接');

    // ★ 连着**但一次都没收发过** —— 2026-08-22 事故的样子。
    //   那次两边的状态行都只报"连没连上"，于是"编辑器半边一次都没跑"完全看不出来，
    //   排查花了一整轮。这一态必须自己喊出来，且要带 ⚠（HUD 靠它标红）。
    poke('lastOkAt', performance.now());
    expect(s.status().connected).toBe(true);
    expect(s.statusLine()).toContain('一次都没收发过');
    expect(s.statusLine().startsWith('⚠')).toBe(true);

    // 真的收发过了才叫"同步中"
    poke('publishedCount', 3);
    poke('appliedCount', 2);
    expect(s.statusLine()).toContain('同步中');
    expect(s.statusLine()).toContain('发3 收2');

    poke('failStreak', 3);
    poke('lastError', 'HTTP 500');
    expect(s.status().connected).toBe(false);
    expect(s.statusLine()).toContain('已断');
    expect(s.statusLine()).toContain('HTTP 500');
    expect(s.statusLine()).toContain('发3 收2');   // 断了也要看得见计数
  });

  it('状态里带得出「最后是谁写的」与「此刻被什么闸挡着」', () => {
    // 这两项是另外两个"静默失败"的照妖镜：
    // · 最后写入者一直是自己 ⇒ 对面根本没在写（那次 59 次全是 game）
    // · 被闸挡住 ⇒ "以为在收、其实只发不收"（独奏/拖灯/场景不匹配都会静默跳过）
    const s = mk();
    const poke = (k: string, v: unknown): void => {
      (s as unknown as Record<string, unknown>)[k] = v;
    };
    poke('lastOkAt', performance.now());
    poke('publishedCount', 1);
    poke('lastWriter', 'game:abc');
    poke('lastDocAgeMs', 12_000);
    expect(s.statusLine()).toContain('最后写入:游戏');
    expect(s.statusLine()).toContain('12s前');

    poke('lastWriter', 'editor:xyz');
    expect(s.statusLine()).toContain('最后写入:编辑器');

    poke('suppressed', '本侧忙（拖灯中／独奏中）只发不收');
    expect(s.statusLine()).toContain('⏸');
    expect(s.statusLine()).toContain('只发不收');

    const st = s.status();
    expect(st.applied).toBe(0);
    expect(st.published).toBe(1);
    expect(st.lastWriter).toBe('editor:xyz');
    expect(st.suppressed).toContain('只发不收');
  });

  it('stop() 之后不再排下一拍（销毁后还在跑 = 泄漏 + 幽灵写）', () => {
    const s = mk();
    s.start();
    expect((s as unknown as { running: boolean }).running).toBe(true);
    s.stop();
    expect((s as unknown as { running: boolean }).running).toBe(false);
    expect((s as unknown as { timer: unknown }).timer).toBeNull();
  });
});

