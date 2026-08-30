import { describe, expect, it } from 'vitest';

import type { SceneData } from '../data/types';
import {
  applySceneAppearance, mergeSceneLighting, resolveSceneAppearance, sameAppearance,
  transitionIsCovered,
} from './sceneAppearance';

/**
 * 「场景此刻长什么样」的解析契约。
 *
 * 模型（2026-08-30 制作人定）：原画就是最终的光照，**夜靠换一张夜原画**得到。
 * 所以这一层的职责是「顶层白天基底 ⊕ 该时段的差异」，而 `timeVariants` 在此之前
 * 只是 types.ts 里的一个声明 —— 运行时零消费者，写了也不生效。
 */

function scene(over: Partial<SceneData> = {}): SceneData {
  return {
    id: '雾津街头',
    name: '雾津街头',
    worldWidth: 4000,
    worldHeight: 2251.2,
    backgrounds: [{ image: 'background.png', x: 0, y: 0 }],
    hotspots: [],
    npcs: [],
    ...over,
  } as unknown as SceneData;
}

describe('resolveSceneAppearance：没开日夜 = 只认顶层', () => {
  it('缺 dayNight 时，配了 timeVariants 也不生效', () => {
    const s = scene({
      timeVariants: { 夜: { backgrounds: [{ image: 'night.png', x: 0, y: 0 }] } },
    });
    const r = resolveSceneAppearance(s, '夜');
    expect(r.primaryBackgroundImage).toBe('background.png');
    expect(r.phase).toBe('');
  });

  it('开了日夜但时段为空串 —— 同样回落顶层（未注入时段时的安全默认）', () => {
    const s = scene({
      dayNight: { enabled: true },
      timeVariants: { 夜: { backgrounds: [{ image: 'night.png', x: 0, y: 0 }] } },
    });
    expect(resolveSceneAppearance(s, '').primaryBackgroundImage).toBe('background.png');
  });

  it('开了日夜、但该时段没配变体 → 顶层', () => {
    const s = scene({ dayNight: { enabled: true }, timeVariants: { 夜: { bgm: 'x' } } });
    expect(resolveSceneAppearance(s, '暮').primaryBackgroundImage).toBe('background.png');
  });
});

describe('resolveSceneAppearance：换背景就是换那张图', () => {
  const s = scene({
    dayNight: { enabled: true },
    ambientSounds: ['amb_day'],
    timeVariants: {
      夜: {
        backgrounds: [{ image: 'background_relight_夜.png', x: 0, y: 0 }],
        ambientSounds: ['amb_night'],
      },
    },
  });

  it('夜时段拿到夜的图 —— 烘焙目录就是按这个名字索引的', () => {
    const r = resolveSceneAppearance(s, '夜');
    expect(r.primaryBackgroundImage).toBe('background_relight_夜.png');
    expect(r.phase).toBe('夜');
  });

  it('没写的字段沿用顶层，写了的才覆盖', () => {
    expect(resolveSceneAppearance(s, '夜').ambientSounds).toEqual(['amb_night']);
    expect(resolveSceneAppearance(s, '辰').ambientSounds).toEqual(['amb_day']);
  });

  it('变体里 backgrounds 是空数组 = 没写，不该把场景弄成无背景', () => {
    const s2 = scene({ dayNight: { enabled: true }, timeVariants: { 夜: { backgrounds: [] } } });
    expect(resolveSceneAppearance(s2, '夜').primaryBackgroundImage).toBe('background.png');
  });
});

describe('mergeSceneLighting：部分覆盖，且 lights 永不参与', () => {
  const base = {
    sky: { kelvin: 6500, intensity: 1, hemi: 0.9 },
    fog: { sigma: 0 },
    display: { ev: 0, tonemap: 'none' },
    lights: [{ id: 'lamp_1', kind: 'point', intensity: 2 }],
  } as never;

  it('只写 fog 时，sky / display 原样保留', () => {
    const m = mergeSceneLighting(base, { fog: { sigma: 0.4 } } as never)!;
    expect((m as never as Record<string, { sigma: number }>)['fog'].sigma).toBe(0.4);
    expect((m as never as Record<string, { intensity: number }>)['sky'].intensity).toBe(1);
  });

  it('**灯不许经这条路换**——它是实体，按各自 phases 过滤', () => {
    // 两条路都能改灯 = 两个真相源。这条是设计红线，不是实现细节。
    const m = mergeSceneLighting(base, { lights: [] } as never)!;
    expect((m as never as Record<string, unknown[]>)['lights']).toHaveLength(1);
  });

  it('没有基底时覆盖也无处可盖', () => {
    expect(mergeSceneLighting(undefined, { fog: { sigma: 1 } } as never)).toBeUndefined();
  });
});

describe('sameAppearance：决定要不要换装', () => {
  const s = scene({
    dayNight: { enabled: true },
    timeVariants: {
      // 两个时段配了**同一张图、同一份环境** —— 只是时段名不同
      暮: { bgm: 'b' },
      夜: { bgm: 'b' },
    },
  });

  it('时段名变了但画面没变 ⇒ 不重载（省掉一次背景纹理 + 烘焙载荷的白加载）', () => {
    const a = resolveSceneAppearance(s, '暮');
    const b = resolveSceneAppearance(s, '夜');
    expect(a.phase).not.toBe(b.phase);
    expect(sameAppearance(a, b)).toBe(true);
  });

  it('换了背景就必须重载', () => {
    const s2 = scene({
      dayNight: { enabled: true },
      timeVariants: { 夜: { backgrounds: [{ image: 'n.png', x: 0, y: 0 }] } },
    });
    expect(sameAppearance(resolveSceneAppearance(s2, '辰'), resolveSceneAppearance(s2, '夜')))
      .toBe(false);
  });
});

describe('applySceneAppearance：就地写回，且只在真命中时动', () => {
  it('没开日夜时一个字段都不动（旧场景零影响）', () => {
    const s = scene({
      timeVariants: { 夜: { backgrounds: [{ image: 'n.png', x: 0, y: 0 }], filterId: 'f' } },
    });
    const before = JSON.stringify(s);
    expect(applySceneAppearance(s, '夜')).toBe('');
    expect(JSON.stringify(s)).toBe(before);
  });

  it('命中时把背景与环境写回场景对象', () => {
    const s = scene({
      dayNight: { enabled: true },
      timeVariants: {
        夜: { backgrounds: [{ image: 'n.png', x: 0, y: 0 }], ambientSounds: ['amb_n'] },
      },
    });
    expect(applySceneAppearance(s, '夜')).toBe('夜');
    expect(s.backgrounds[0].image).toBe('n.png');
    expect(s.ambientSounds).toEqual(['amb_n']);
  });

  it('变体没写的字段不许被清空', () => {
    // 曾经的坑形状：写回时无脑赋值 undefined，把顶层配好的深度/滤镜抹掉。
    const s = scene({
      dayNight: { enabled: true },
      filterId: 'day_filter',
      timeVariants: { 夜: { backgrounds: [{ image: 'n.png', x: 0, y: 0 }] } },
    });
    applySceneAppearance(s, '夜');
    expect(s.filterId).toBe('day_filter');
  });
});

describe('bgm：参与判等就必须写回（否则是死数据 + 白重载）', () => {
  it('基底取场景自己的 bgm，不是 undefined', () => {
    const s = scene({ bgm: 'day_theme' } as never);
    expect(resolveSceneAppearance(s, '').bgm).toBe('day_theme');
  });

  it('变体的 bgm 会被写回场景对象', () => {
    const s = scene({
      dayNight: { enabled: true },
      bgm: 'day_theme',
      timeVariants: { 夜: { bgm: 'night_theme' } },
    } as never);
    applySceneAppearance(s, '夜');
    expect((s as unknown as { bgm?: string }).bgm).toBe('night_theme');
  });

  it('变体没写 bgm 时不覆盖白天的', () => {
    const s = scene({
      dayNight: { enabled: true },
      bgm: 'day_theme',
      timeVariants: { 夜: { backgrounds: [{ image: 'n.png', x: 0, y: 0 }] } },
    } as never);
    applySceneAppearance(s, '夜');
    expect((s as unknown as { bgm?: string }).bgm).toBe('day_theme');
  });
});

// ---------------------------------------------------------------------------
// 表现档 → 遮不遮幕
// ---------------------------------------------------------------------------

describe('transitionIsCovered', () => {
  it('timelapse / fade 声明了遮挡', () => {
    expect(transitionIsCovered('timelapse')).toBe(true);
    expect(transitionIsCovered('fade')).toBe(true);
  });

  it('seamless 不遮 —— 它的整个卖点就是玩家看得见换班走位', () => {
    expect(transitionIsCovered('seamless')).toBe(false);
  });

  it('cut 不遮 —— 调试与演出内部用，硬切是它的定义', () => {
    expect(transitionIsCovered('cut')).toBe(false);
  });

  it('缺省不遮：拿不到档位时宁可硬切，也不要把玩家关进一块没人揭的黑幕', () => {
    expect(transitionIsCovered(undefined)).toBe(false);
  });
});
