import { describe, expect, it } from 'vitest';

import { mergeGameConfig, __SIDE_EFFECT_KEYS } from './gameConfigMerge';
import type { GameConfig } from '../data/types';

/** 与 Game.ts 里那份运行时缺省同形（只取本测试关心的部分）。 */
function defaults(): GameConfig {
  return {
    initialScene: '',
    initialQuest: '',
    fallbackScene: '',
    playerAvatar: {
      animManifest: '/resources/runtime/animation/player_anim/anim.json',
      stateMap: {},
    },
  };
}

/**
 * 一份**每个可选键都写满**的配置。
 *
 * 这是本文件最重要的东西：`GameConfig` 加了新字段时，
 * 「字段覆盖度」那条用例会因为这里没写而漏掉它——所以加字段的人必须来这里补一行，
 * 补的时候就会顺带发现"我的字段能不能被合并进去"。
 */
function fullConfig(): Required<Omit<GameConfig, 'startupFlags'>> & Pick<GameConfig, 'startupFlags'> {
  return {
    initialScene: 'scene_a',
    initialQuest: 'quest_a',
    fallbackScene: 'scene_b',
    initialCutscene: 'cs_a',
    initialCutsceneDoneFlag: 'flag.cs_done',
    startupFlags: { 'a.b': true },
    viewport: { width: 1280, height: 720 },
    windowSize: { width: 1600, height: 900 },
    playerAvatar: { animManifest: '/x/anim.json', stateMap: { idle: 'i' }, portraitSlug: 'hero' },
    initialControlledCharacter: 'char_a',
    initialParty: ['char_a', 'char_b'],
    playerActs: { crouch: { enabled: false } } as GameConfig['playerActs'] & object,
    entityPixelDensityMatch: false,
    entityPixelDensityMatchBlurScale: 0.5,
    entityLighting: { shadowMode: 'planar' } as GameConfig['entityLighting'] & object,
    emoteBubbleScale: 1.5,
    health: { maxHealth: 7 },
    textPalette: [{ id: 'warn', label: '警', color: '#f00' }],
    dayNight: { startAt: '09:00' } as GameConfig['dayNight'] & object,
  };
}

describe('game_config 合并：字段覆盖度（防"漏拷"再犯）', () => {
  it('GameConfig 声明的每一个键都能被合并进来', () => {
    const target = defaults();
    const incoming = fullConfig();
    mergeGameConfig(target, incoming);

    const skipped = new Set(__SIDE_EFFECT_KEYS);
    const missed: string[] = [];
    for (const key of Object.keys(incoming)) {
      if (skipped.has(key)) continue;
      if ((target as unknown as Record<string, unknown>)[key] === undefined) missed.push(key);
    }
    expect(
      missed,
      `这些键没被合并进运行时配置——消费端会恒收 undefined、配了等于没配：${missed.join(', ')}`,
    ).toEqual([]);
  });

  it('值也要对得上，不只是"有个东西在"', () => {
    const target = defaults();
    mergeGameConfig(target, fullConfig());

    expect(target.initialScene).toBe('scene_a');
    expect(target.initialCutscene).toBe('cs_a');
    expect(target.viewport).toEqual({ width: 1280, height: 720 });
    expect(target.emoteBubbleScale).toBe(1.5);
    expect(target.entityPixelDensityMatch).toBe(false);
    expect(target.entityPixelDensityMatchBlurScale).toBe(0.5);
    expect(target.health).toEqual({ maxHealth: 7 });
    expect(target.textPalette).toEqual([{ id: 'warn', label: '警', color: '#f00' }]);
    expect(target.playerAvatar?.portraitSlug).toBe('hero');
    // 这两个历史上是死字段（白名单没登记）；合并后至少配置层不再是原因
    expect(target.initialControlledCharacter).toBe('char_a');
    expect(target.initialParty).toEqual(['char_a', 'char_b']);
  });

  it('startupFlags 不由合并处理 —— 它是副作用，语义在 Game.loadGameConfig', () => {
    const target = defaults();
    mergeGameConfig(target, { startupFlags: { 'a.b': true } });
    expect(target.startupFlags).toBeUndefined();
  });

  it('未来新增的键不用登记也能生效 —— 这就是不再用白名单的意义', () => {
    const target = defaults();
    mergeGameConfig(target, { someBrandNewKey: 'v' } as unknown as Partial<GameConfig>);
    expect((target as unknown as Record<string, unknown>).someBrandNewKey).toBe('v');
  });
});

describe('game_config 合并：校验与缺省保护', () => {
  it('三个必填项的空串不许顶掉缺省', () => {
    const target = defaults();
    target.initialScene = 'good';
    const { rejected } = mergeGameConfig(target, { initialScene: '', fallbackScene: '   ' });
    expect(target.initialScene).toBe('good');
    expect(rejected).toContain('initialScene');
    expect(rejected).toContain('fallbackScene');
  });

  it('initialCutscene 允许显式空串 —— "配了但就是不播"与"没配"是两回事', () => {
    const target = defaults();
    mergeGameConfig(target, { initialCutscene: '' });
    expect(target.initialCutscene).toBe('');
  });

  it('形状不对的值被挡下并**报出来**，不再静默忽略', () => {
    const target = defaults();
    const { rejected } = mergeGameConfig(target, {
      emoteBubbleScale: '大' as unknown as number,
      entityPixelDensityMatch: 1 as unknown as boolean,
      entityPixelDensityMatchBlurScale: 0,
      viewport: { width: 100 } as unknown as GameConfig['viewport'],
      textPalette: 'nope' as unknown as GameConfig['textPalette'],
    });
    expect(target.emoteBubbleScale).toBeUndefined();
    expect(target.entityPixelDensityMatch).toBeUndefined();
    expect(target.entityPixelDensityMatchBlurScale).toBeUndefined();
    expect(target.viewport).toBeUndefined();
    expect(target.textPalette).toBeUndefined();
    expect(rejected.sort()).toEqual([
      'emoteBubbleScale', 'entityPixelDensityMatch',
      'entityPixelDensityMatchBlurScale', 'textPalette', 'viewport',
    ].sort());
  });

  it('NaN / Infinity 不算数字', () => {
    const target = defaults();
    mergeGameConfig(target, { emoteBubbleScale: Number.NaN });
    expect(target.emoteBubbleScale).toBeUndefined();
    mergeGameConfig(target, { emoteBubbleScale: Number.POSITIVE_INFINITY });
    expect(target.emoteBubbleScale).toBeUndefined();
  });

  it('playerAvatar 逐子字段合并，只写 portraitSlug 不会把动画包冲掉', () => {
    const target = defaults();
    const before = target.playerAvatar?.animManifest;
    mergeGameConfig(target, { playerAvatar: { portraitSlug: 'hero' } });
    expect(target.playerAvatar?.animManifest).toBe(before);
    expect(target.playerAvatar?.portraitSlug).toBe('hero');
  });

  it('合并出来的对象不与源 JSON 共享引用', () => {
    const target = defaults();
    const src = { health: { maxHealth: 5 } };
    mergeGameConfig(target, src);
    src.health.maxHealth = 999;
    expect(target.health?.maxHealth).toBe(5);
  });

  it('null / 非对象的整包输入不炸', () => {
    const target = defaults();
    expect(() => mergeGameConfig(target, null)).not.toThrow();
    expect(() => mergeGameConfig(target, undefined)).not.toThrow();
    expect(mergeGameConfig(target, {} as Partial<GameConfig>).rejected).toEqual([]);
  });

  it('值为 undefined 的键跳过，不会把已有值抹成 undefined', () => {
    const target = defaults();
    target.emoteBubbleScale = 2;
    mergeGameConfig(target, { emoteBubbleScale: undefined });
    expect(target.emoteBubbleScale).toBe(2);
  });
});
