import { describe, it, expect } from 'vitest';
import {
  parsePropPresets,
  propPresetImages,
  resolvePropAttach,
} from './propPresets';

describe('挂件预设解析', () => {
  it('读出全部字段', () => {
    const t = parsePropPresets({
      taomu_jian: {
        label: '桃木剑',
        image: '/a.png',
        anchorX: 0.79,
        anchorY: 0.16,
        rotation: -90,
        scale: 0.5,
        lit: false,
      },
    });
    expect(t.taomu_jian).toEqual({
      label: '桃木剑',
      image: '/a.png',
      anchorX: 0.79,
      anchorY: 0.16,
      rotation: -90,
      scale: 0.5,
      lit: false,
    });
  });

  it('缺省字段不凭空补', () => {
    const t = parsePropPresets({ x: { image: '/a.png' } });
    expect(t.x).toEqual({ image: '/a.png' });
    expect(t.x.anchorX).toBeUndefined();
  });

  it('支点夹到 0..1（越界是标注失误，不该把挂件甩出画面）', () => {
    const t = parsePropPresets({ x: { anchorX: 5, anchorY: -3 } });
    expect(t.x.anchorX).toBe(1);
    expect(t.x.anchorY).toBe(0);
  });

  it('非正缩放当没填——0 会让挂件消失且看不出原因', () => {
    expect(parsePropPresets({ x: { scale: 0 } }).x.scale).toBeUndefined();
    expect(parsePropPresets({ x: { scale: -2 } }).x.scale).toBeUndefined();
  });

  it('坏条目逐条丢弃，不牵连别的挂件', () => {
    const t = parsePropPresets({
      good: { image: '/a.png' },
      bad_array: [],
      bad_str: 'nope',
      '': { image: '/b.png' },
    });
    expect(Object.keys(t)).toEqual(['good']);
  });

  it('整份不是对象时返回空表而不是抛', () => {
    expect(parsePropPresets(null)).toEqual({});
    expect(parsePropPresets([1, 2])).toEqual({});
    expect(parsePropPresets('x')).toEqual({});
  });

  it('半成品条目（一张图都没有）保留——编辑器里正在建的就是这形状', () => {
    const t = parsePropPresets({ wip: { label: '还没配图' } });
    expect(t.wip).toEqual({ label: '还没配图' });
  });

  it('images 过滤空串并保序（顺序即帧号）', () => {
    const t = parsePropPresets({ x: { images: ['/a.png', '', '  ', '/b.png'] } });
    expect(t.x.images).toEqual(['/a.png', '/b.png']);
  });
});

describe('预设贴图取用', () => {
  it('image 排在 images 前（与动作参数同序）', () => {
    expect(propPresetImages({ image: '/a.png', images: ['/b.png'] }))
      .toEqual(['/a.png', '/b.png']);
  });

  it('没有预设时为空', () => {
    expect(propPresetImages(undefined)).toEqual([]);
  });
});

describe('预设与显式覆盖的合并', () => {
  const preset = {
    image: '/sword.png',
    anchorX: 0.79,
    anchorY: 0.16,
    rotation: -90,
    scale: 0.5,
    lit: true,
  };

  it('什么都不覆盖时全用预设', () => {
    expect(resolvePropAttach(preset, {})).toEqual({
      images: ['/sword.png'],
      anchorX: 0.79,
      anchorY: 0.16,
      rotation: -90,
      scale: 0.5,
      lit: true,
      mirror: undefined,
    });
  });

  it('显式给了就用显式的', () => {
    const r = resolvePropAttach(preset, { anchorY: 0.9, scale: 2, lit: false });
    expect([r.anchorY, r.scale, r.lit]).toEqual([0.9, 2, false]);
    expect(r.anchorX).toBe(0.79); // 没覆盖的仍走预设
  });

  it('覆盖成 0 也算显式覆盖（?? 而不是 ||，否则支点 0 会被吃掉）', () => {
    const r = resolvePropAttach(preset, { anchorX: 0, rotation: 0 });
    expect(r.anchorX).toBe(0);
    expect(r.rotation).toBe(0);
  });

  it('给了图就整体替换而不是拼接——拼起来只会拼出谁也没想要的序列', () => {
    expect(resolvePropAttach(preset, { images: ['/x.png', '/y.png'] }).images)
      .toEqual(['/x.png', '/y.png']);
  });

  it('没有预设时只剩显式值', () => {
    expect(resolvePropAttach(undefined, { images: ['/x.png'], scale: 3 })).toEqual({
      images: ['/x.png'],
      anchorX: undefined,
      anchorY: undefined,
      rotation: undefined,
      scale: 3,
      lit: undefined,
      mirror: undefined,
    });
  });

  it('预设与显式都没图 → 空列表（调用方据此放弃挂载）', () => {
    expect(resolvePropAttach(undefined, {}).images).toEqual([]);
  });
});
