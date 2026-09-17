import { describe, it, expect } from 'vitest';
import {
  parsePropPresets,
  propPresetImages,
  resolvePropAttach,
  resolvePropStateName,
} from './propPresets';

describe('挂件预设解析', () => {
  it('状态强度原样解析，不提供挂件专属强度换算', () => {
    const table = parsePropPresets({
      torch: { light: { intensity: 1 }, states: { dim: { light: { intensity: 0.5 } } } },
    });
    expect(resolvePropAttach(table.torch, {}, 'dim').light?.intensity).toBe(0.5);
  });
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
      light: null,
      particles: [],
      firePoint: null,
      burn: 1,
      windShelter: 0,
      flame: null,
      onEnterActions: [],
      blowout: null,
      igniter: null,
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
      light: null,
      particles: [],
      firePoint: null,
      burn: 1,
      windShelter: 0,
      flame: null,
      onEnterActions: [],
      blowout: null,
      igniter: null,
    });
  });

  it('点火块：基础块写了就能点；状态写 null = 这个状态点不了；坏块当没写', () => {
    const table = parsePropPresets({
      torch: {
        image: '/t.png', igniter: { flameLength: 25 },
        states: { lit: {}, out: { igniter: null }, weird: { igniter: 'x' } },
      },
      plain: { image: '/p.png', igniter: {} },
    });
    const t = table.torch!;
    expect(resolvePropAttach(t, {}, 'lit').igniter).toEqual({ flameLength: 25 });
    expect(resolvePropAttach(t, {}, 'out').igniter).toBeNull();
    expect(resolvePropAttach(t, {}, 'weird').igniter).toEqual({ flameLength: 25 });
    expect(resolvePropAttach(table.plain!, {}).igniter).toEqual({});
    expect(resolvePropAttach(parsePropPresets({ n: { image: '/n.png' } }).n, {}).igniter).toBeNull();
  });

  it('预设与显式都没图 → 空列表（调用方据此放弃挂载）', () => {
    expect(resolvePropAttach(undefined, {}).images).toEqual([]);
  });
});

/**
 * 状态表下的贴图与摆放。⚠ 编辑器预览（`tools/editor/shared/prop_preview.py`）是这一段的
 * 跨语言镜像：`tools/editor/tests/test_prop_preview.py` 钉**同一组用例**，改一处必改两处。
 */
describe('状态：挂哪个状态、这个状态长什么样', () => {
  const raw = {
    torch: {
      image: '/base.png',
      anchorX: 0.47,
      anchorY: 0,
      rotation: -90,
      scale: 0.45,
      defaultState: 'out',
      states: {
        lit: { label: '点着' },
        out: { image: '/out.png', anchorY: 0.2, scale: 0 },
        anim: { images: ['/f0.png', '', '/f1.png'], rotation: 0, anchorX: 3 },
      },
    },
    no_default: { image: '/a.png', states: { first: {}, second: {} } },
    bad_default: { image: '/a.png', defaultState: 'ghost', states: { first: {}, second: {} } },
  };
  const t = parsePropPresets(raw);

  it('初始状态：显式 → defaultState → 第一个键；不存在的名字给空串', () => {
    expect(resolvePropStateName(t.torch)).toBe('out');
    expect(resolvePropStateName(t.torch, 'anim')).toBe('anim');
    expect(resolvePropStateName(t.torch, 'nope')).toBe('');
    expect(resolvePropStateName(t.no_default)).toBe('first');
    expect(resolvePropStateName(t.bad_default)).toBe('first');
    expect(resolvePropStateName({ image: '/a.png' })).toBe('');
  });

  it('状态给了图就整体替换；非正缩放当没填，沿用基础块', () => {
    const r = resolvePropAttach(t.torch, {}, 'out');
    expect(r.images).toEqual(['/out.png']);
    expect([r.anchorX, r.anchorY, r.rotation, r.scale]).toEqual([0.47, 0.2, -90, 0.45]);
  });

  it('状态里写 0 也算写了；支点越界夹到 0..1；空串帧滤掉', () => {
    const r = resolvePropAttach(t.torch, {}, 'anim');
    expect(r.images).toEqual(['/f0.png', '/f1.png']);
    expect([r.anchorX, r.anchorY, r.rotation, r.scale]).toEqual([1, 0, 0, 0.45]);
  });

  it('状态没给图 / 没写摆放 ⇒ 全用基础块', () => {
    const r = resolvePropAttach(t.torch, {}, 'lit');
    expect(r.images).toEqual(['/base.png']);
    expect([r.anchorX, r.anchorY, r.rotation, r.scale]).toEqual([0.47, 0, -90, 0.45]);
  });
});

/**
 * 燃烧物（起火点 / 燃烧强度 / 帧动画火苗 / 粒子挂载 / 进入动作）的黄金用例。⚠ 与
 * `tools/editor/tests/test_prop_preview.py` **同一组**（契约 v3：清洗与合并口径），改一处必改两处。
 */
describe('燃烧物：起火点、燃烧强度、挡风、进入动作', () => {
  const raw = {
    t: {
      image: '/a.png', anchorX: 0.5, anchorY: 0.9,
      firePoint: [0.5, 0.05],
      flame: { image: '/f.png', cols: 12, frames: 64, height: 30 },
      states: {
        lit: { burn: 1 },
        ember: { burn: 0.15, firePoint: [0.4, 0.1] },
        out: { burn: 0, onEnterActions: [{ type: 'playSfx', params: { id: 'x' } }] },
      },
    },
    bad: { image: '/b.png', firePoint: [2, -1], burn: 1.5, flame: { image: '', height: 10 } },
    noh: { image: '/c.png', flame: { image: '/f.png', cols: 0, fps: -3, height: 0 } },
    defaults: { image: '/d.png', flame: { image: '/f.png', cols: 4, height: 12 } },
  };
  const t = parsePropPresets(raw);
  const pick = (id: keyof typeof raw, state = '') => {
    const r = resolvePropAttach(t[id], {}, state);
    return { firePoint: r.firePoint, burn: r.burn, flame: r.flame, onEnterActions: r.onEnterActions };
  };
  const full = { image: '/f.png', cols: 12, frames: 64, fps: 24, height: 30 };

  it.each([
    ['t', '', [0.5, 0.05], 1, full, []],
    ['t', 'lit', [0.5, 0.05], 1, full, []],
    ['t', 'ember', [0.4, 0.1], 0.15, full, []],
    ['t', 'out', [0.5, 0.05], 0, full, [{ type: 'playSfx', params: { id: 'x' } }]],
    ['bad', '', [1, 0], 1, null, []],
    ['noh', '', null, 1, null, []],
    ['defaults', '', null, 1, { image: '/f.png', cols: 4, frames: 4, fps: 24, height: 12 }, []],
  ] as const)('%s / 状态「%s」', (id, state, firePoint, burn, flame, enter) => {
    expect(pick(id, state)).toEqual({ firePoint, burn, flame, onEnterActions: enter });
  });

  describe('粒子挂载：每条 = 一个效果挂在贴图上的一个点', () => {
    const tm = parsePropPresets({
      m: {
        image: '/m.png', firePoint: [0.5, 0.1],
        particles: [
          { effect: 'flame', point: [0.5, 0.05] }, { effect: 'smoke' }, { effect: '' }, 'junk',
          { effect: 'sparks', point: [3, -1] },
        ],
        states: { out: { particles: [] }, ember: { particles: [{ effect: 'coals' }] }, lit: {} },
      },
    });
    const lit = [
      { effect: 'flame', point: [0.5, 0.05] },
      { effect: 'smoke', point: null },
      { effect: 'sparks', point: [1, 0] },
    ];
    it.each([
      ['', lit],
      ['lit', lit],
      ['ember', [{ effect: 'coals', point: null }]],
      ['out', []],
    ] as const)('m / 状态「%s」', (state, particles) => {
      expect(resolvePropAttach(tm.m, {}, state).particles).toEqual(particles);
    });
  });

  it('进入动作只留 {type: 非空串}；params 缺了补空对象（执行器入参形状）', () => {
    const tb = parsePropPresets({
      p: { states: { s: { onEnterActions: [null, [], { type: '  ' }, { type: 'playSfx' }, 'x'] } } },
    });
    expect(resolvePropAttach(tb.p, {}, 's').onEnterActions).toEqual([{ type: 'playSfx', params: {} }]);
  });

  it('挡风比例：状态 → 基础块 → 0；夹到 0..1；非数当没写', () => {
    const tb = parsePropPresets({
      p: { windShelter: 0.1, states: { guard: { windShelter: 1.8 }, open: {}, junk: { windShelter: 'x' } } },
      q: { image: '/q.png' },
    });
    expect(resolvePropAttach(tb.p, {}, 'guard').windShelter).toBe(1);
    expect(resolvePropAttach(tb.p, {}, 'open').windShelter).toBe(0.1);
    expect(resolvePropAttach(tb.p, {}, 'junk').windShelter).toBe(0.1);
    expect(resolvePropAttach(tb.q, {}).windShelter).toBe(0);
  });

  it('物理闪烁：kind = flame / ember + 直径 > 0 才收；puffAmp 只给明火、夹 0..1；坏了整块丢；不认识的 kind 按老写法解析', () => {
    const tb = parsePropPresets({
      a: { light: { intensity: 1, flicker: { kind: 'flame', diameter: 0.1, puffAmp: 3, amp: 0.2, hz: 7 } } },
      b: { light: { intensity: 1, flicker: { kind: 'ember', diameter: 0.08, puffAmp: 0.5 } } },
      c: { light: { intensity: 1, flicker: { kind: 'flame', diameter: 0 } } },
      d: { light: { intensity: 1, flicker: { kind: 'flame', diameter: 'x' } } },
      e: { light: { intensity: 1, flicker: { kind: 'flames', amp: 0.2, hz: 7 } } },
      f: { light: { intensity: 1, flicker: { kind: 'flame', diameter: 0.1, puffAmp: 'x' } } },
    });
    expect(tb.a.light!.flicker).toEqual({ kind: 'flame', diameter: 0.1, puffAmp: 1 });
    expect(tb.b.light!.flicker).toEqual({ kind: 'ember', diameter: 0.08 });
    expect(tb.c.light!.flicker).toBeUndefined();
    expect(tb.d.light!.flicker).toBeUndefined();
    expect(tb.e.light!.flicker).toEqual({ amp: 0.2, hz: 7 });
    expect(tb.f.light!.flicker).toEqual({ kind: 'flame', diameter: 0.1 });
  });

  it('吹灭块：三个必填量 > 0 才收；状态 null = 这个状态吹不灭、对象整块替换、不写沿用基础块；坏块当没写', () => {
    const tb = parsePropPresets({
      t: {
        image: '/t.png',
        blowout: { windSpeed: 8, drainSeconds: 4, recoverSeconds: 3, emberBelow: 1.4, emberState: ' ', auto: 'x', fadeMs: -1,
          onOutActions: [{ type: 'emitNarrativeSignal', params: { signal: 'torch_out' } }, { type: '' }] },
        states: {
          lit: {},
          sheltered: { blowout: null },
          reed: { blowout: { windSpeed: 3, drainSeconds: 1, recoverSeconds: 2, auto: false } },
          junk: { blowout: { windSpeed: 0, drainSeconds: 1, recoverSeconds: 1 } },
        },
      },
      bad: { image: '/b.png', blowout: { windSpeed: 8, drainSeconds: 4 } },
    });
    const base = { windSpeed: 8, drainSeconds: 4, recoverSeconds: 3, emberBelow: 1,
      onOutActions: [{ type: 'emitNarrativeSignal', params: { signal: 'torch_out' } }] };
    expect(resolvePropAttach(tb.t, {}, 'lit').blowout).toEqual(base);
    expect(resolvePropAttach(tb.t, {}, 'sheltered').blowout).toBeNull();
    expect(resolvePropAttach(tb.t, {}, 'reed').blowout).toEqual({ windSpeed: 3, drainSeconds: 1, recoverSeconds: 2, auto: false });
    expect(resolvePropAttach(tb.t, {}, 'junk').blowout).toEqual(base);
    expect(resolvePropAttach(tb.bad, {}).blowout).toBeNull();
  });

  it('没写这些键的老挂件（灯笼）：解析结果里一个新键都不冒出来', () => {
    const tb = parsePropPresets({ lantern: { image: '/l.png', light: { intensity: 0.15 }, states: { lit: { label: '点着' } } } });
    expect(Object.keys(tb.lantern).sort()).toEqual(['image', 'light', 'states']);
    expect(Object.keys(tb.lantern.states!.lit)).toEqual(['label']);
  });
});

describe('可燃挂件（A3.8：可燃物是模板，挂件引用它 = 实例化一次）', () => {
  it('burnable 块读进来；坏块（没 template）当没写', () => {
    const t = parsePropPresets({
      xiang: { label: '线香', persistent: true, scale: 1.5, burnable: { template: 'incense_stick', initial: 'burning', signals: { ignited: 's_on', bogus: 1 } } },
      bad: { image: '/a.png', burnable: { initial: 'burning' } },
    });
    expect(t.xiang.burnable).toEqual({ template: 'incense_stick', initial: 'burning', signals: { ignited: 's_on' } });
    expect(t.bad.burnable).toBeUndefined();
  });

  it('解析挂载：渲染由模板接管——贴图空、灯 / 粒子 / 火苗 / 起火点 / 吹熄 / 点火能力全空，缩放 / 自转照留', () => {
    const t = parsePropPresets({
      xiang: {
        image: '/should_not_draw.png', anchorX: 0.1, rotation: 30, scale: 2,
        light: { intensity: 1 }, particles: [{ effect: 'fx' }], firePoint: [0.5, 0.1],
        blowout: { windSpeed: 1, drainSeconds: 1, recoverSeconds: 1 }, igniter: { flameLength: 5 },
        states: { lit: { light: { intensity: 2 } } },
        burnable: { template: 'incense_stick' },
      },
    });
    const r = resolvePropAttach(t.xiang, {}, 'lit');
    expect(r.images).toEqual([]);
    expect(r.anchorX).toBeUndefined();
    expect(r.light).toBeNull();
    expect(r.particles).toEqual([]);
    expect(r.firePoint).toBeNull();
    expect(r.flame).toBeNull();
    expect(r.blowout).toBeNull();
    expect(r.igniter).toBeNull();
    expect(r.rotation).toBe(30);
    expect(r.scale).toBe(2);
    expect(r.burnable).toEqual({ template: 'incense_stick' });
  });
});
