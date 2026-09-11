import { describe, expect, it } from 'vitest';
import {
  audioCueId,
  audioCueIds,
  audioCueVolume,
  cueFromLegacyPair,
  normalizeAudioCue,
  normalizeAudioCues,
  sameAudioCue,
  sameAudioCueList,
} from './audioCue';

describe('音频引用：裸 id 与带本处音量的对象', () => {
  it('两种形态都取得出 id', () => {
    expect(audioCueId('sfx_door')).toBe('sfx_door');
    expect(audioCueId({ id: 'sfx_door', volume: 0.5 })).toBe('sfx_door');
    expect(audioCueId('  sfx_door  ')).toBe('sfx_door');
  });

  it('没配 / 结构不合法一律空串（调用方按"没配"处理，不猜）', () => {
    expect(audioCueId(undefined)).toBe('');
    expect(audioCueId(null)).toBe('');
    expect(audioCueId('   ')).toBe('');
    expect(audioCueId({} as never)).toBe('');
    expect(audioCueId(42 as never)).toBe('');
  });

  it('🔴 volume 为 0 是合法的静音，绝不能与"没配"合并', () => {
    expect(audioCueVolume({ id: 'a', volume: 0 })).toBe(0);
    expect(audioCueVolume({ id: 'a' })).toBeUndefined();
    expect(audioCueVolume('a')).toBeUndefined();
  });

  it('非有限数 / 负数当没配（宁可用素材原音，也不拿 NaN 去乘）', () => {
    expect(audioCueVolume({ id: 'a', volume: NaN })).toBeUndefined();
    expect(audioCueVolume({ id: 'a', volume: Infinity })).toBeUndefined();
    expect(audioCueVolume({ id: 'a', volume: -0.5 })).toBeUndefined();
    expect(audioCueVolume({ id: 'a', volume: '0.5' as never })).toBeUndefined();
  });

  it('>1 是合法的（比素材原音更响），解析层不截断', () => {
    expect(audioCueVolume({ id: 'a', volume: 2 })).toBe(2);
  });

  it('列表取 id：跳过空引用，保持顺序', () => {
    expect(audioCueIds(['a', { id: 'b', volume: 0.3 }, '', { id: '  ' }, 'c'])).toEqual(
      ['a', 'b', 'c'],
    );
    expect(audioCueIds(undefined)).toEqual([]);
  });

  it('规整成 {id, volume}；id 为空返回 null 供调用方跳过', () => {
    expect(normalizeAudioCue('a')).toEqual({ id: 'a', volume: undefined });
    expect(normalizeAudioCue({ id: 'a', volume: 0 })).toEqual({ id: 'a', volume: 0 });
    expect(normalizeAudioCue('')).toBeNull();
    expect(normalizeAudioCues(['a', '', { id: 'b', volume: 0.2 }])).toEqual([
      { id: 'a', volume: undefined },
      { id: 'b', volume: 0.2 },
    ]);
  });

  it('历史兄弟键形态转引用：没有有效音量就退回裸 id', () => {
    expect(cueFromLegacyPair('sfx_a', 0.4)).toEqual({ id: 'sfx_a', volume: 0.4 });
    expect(cueFromLegacyPair('sfx_a', undefined)).toBe('sfx_a');
    expect(cueFromLegacyPair('sfx_a', 0)).toEqual({ id: 'sfx_a', volume: 0 });
    expect(cueFromLegacyPair('', 0.4)).toBeNull();
  });

  it('🔴 判等不能用 ===：对象形态每次解析都是新对象', () => {
    // 这条正是 sameAppearance 的坑：引用比会让每次时段推进都白赔一次全场景重载
    const a = { id: 'a', volume: 0.5 };
    const b = { id: 'a', volume: 0.5 };
    expect(a === b).toBe(false);          // 值相同、引用不同 —— 引用比会判成"变了"
    expect(sameAudioCue(a, b)).toBe(true);
    expect(sameAudioCue('a', { id: 'a' })).toBe(true);
    expect(sameAudioCue('a', { id: 'a', volume: 1 })).toBe(false);
    expect(sameAudioCue('a', 'b')).toBe(false);
    expect(sameAudioCue(undefined, undefined)).toBe(true);
  });

  it('列表判等顺序敏感（环境层顺序就是作者的编排顺序）', () => {
    expect(sameAudioCueList(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameAudioCueList(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameAudioCueList(['a'], ['a', 'b'])).toBe(false);
    expect(sameAudioCueList(undefined, [])).toBe(true);
    expect(sameAudioCueList([{ id: 'a', volume: 0.3 }], [{ id: 'a', volume: 0.3 }])).toBe(true);
    expect(sameAudioCueList([{ id: 'a', volume: 0.3 }], ['a'])).toBe(false);
  });
});
