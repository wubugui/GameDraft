import { describe, expect, it, vi } from 'vitest';

import { hasExplicitBoot, resolveBootParams } from './bootParams';

const get = (p: URLSearchParams) => Object.fromEntries(p.entries());

describe('启动参数合并', () => {
  it('没有烘进来的缺省时，地址栏原样通过 —— dev server 上行为一个字节不变', () => {
    expect(get(resolveBootParams('', undefined))).toEqual({});
    expect(get(resolveBootParams('?mode=dev', undefined))).toEqual({ mode: 'dev' });
    expect(get(resolveBootParams('', ''))).toEqual({});
  });

  it('地址栏干净时套用缺省 —— 双击 exe 走的就是这条', () => {
    expect(get(resolveBootParams('', 'screen_title=1'))).toEqual({ screen_title: '1' });
    expect(get(resolveBootParams('', 'mode=dev&devScene=dev_room')))
      .toEqual({ mode: 'dev', devScene: 'dev_room' });
  });

  it('前导问号写不写都认', () => {
    expect(get(resolveBootParams('', '?screen_title=1'))).toEqual({ screen_title: '1' });
  });

  describe('显式引导参数让缺省整体让位', () => {
    it('「新游戏」带的标记要能压过"停标题"的缺省 —— 否则点新游戏会被送回标题，死循环', () => {
      const p = resolveBootParams('?new_game=1', 'screen_title=1');
      expect(p.has('screen_title')).toBe(false);
      expect(p.get('new_game')).toBe('1');
    });

    it('「继续」带的读档标记同样压过缺省', () => {
      const p = resolveBootParams('?load_slot=2', 'screen_title=1');
      expect(p.has('screen_title')).toBe(false);
      expect(p.get('load_slot')).toBe('2');
    });

    it('已经在标题态时不重复叠加', () => {
      expect(get(resolveBootParams('?screen_title=1', 'screen_title=1')))
        .toEqual({ screen_title: '1' });
    });

    it('dev 直达族任意一个出现，都算调用方明确知道要去哪', () => {
      for (const q of [
        '?mode=dev', '?devScene=x', '?dev_scene=x', '?narrativeWarp=x', '?narrative_warp=x',
        '?play_cutscene=x', '?waterPreview=x', '?sugarWheelPreview=x', '?paperCraftPreview=x',
      ]) {
        const p = resolveBootParams(q, 'screen_title=1');
        expect(p.has('screen_title'), q).toBe(false);
      }
    });
  });

  it('非引导参数不构成"显式引导"，缺省照样补上', () => {
    // 排障时随手加的参数不该把发行版的标题页顶掉
    const p = resolveBootParams('?debugFoo=1', 'screen_title=1');
    expect(p.get('screen_title')).toBe('1');
    expect(p.get('debugFoo')).toBe('1');
  });

  it('缺省只补不覆盖', () => {
    const p = resolveBootParams('?devScene=other', 'mode=dev&devScene=dev_room');
    // devScene 已经有显式值 —— 而且它本身就是显式引导，整份缺省都不该进来
    expect(p.get('devScene')).toBe('other');
    expect(p.has('mode')).toBe(false);
  });

  it('缺省不是字符串时忽略，不炸', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [null, 42, {}, [], undefined]) {
      expect(get(resolveBootParams('?a=1', bad))).toEqual({ a: '1' });
    }
    vi.restoreAllMocks();
  });
});

describe('hasExplicitBoot', () => {
  it('干净地址栏 = 首次启动', () => {
    expect(hasExplicitBoot(new URLSearchParams(''))).toBe(false);
    expect(hasExplicitBoot(new URLSearchParams('?foo=1'))).toBe(false);
  });

  it('三个引导标记都认', () => {
    for (const q of ['screen_title=1', 'load_slot=0', 'new_game=1']) {
      expect(hasExplicitBoot(new URLSearchParams(q)), q).toBe(true);
    }
  });
});
