/**
 * 呼吸图实例的持有者:显示(备料 → 按布局造 Mesh → 起呼吸声)、表演(wait 等渐弱走完)、实时改参数、
 * 层被收掉时实例退役(声音停、等它的剧情步骤放行)、工作台推来的工作态换到正在显示的同一张图上、探针。
 * Pixi Mesh 与位移场纹理打桩(这里只验持有者的生命周期与接线)。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../rendering/breathingOverlayMesh', () => ({
  createBreathingFieldTextures: () => ({ field1: { destroy: vi.fn() }, field2: { destroy: vi.fn() } }),
  createBreathingOverlayMesh: () => ({ mesh: { label: '' }, apply: vi.fn(), disposeGpu: vi.fn() }),
}));

import { BreathingOverlaySystem, type BreathingOverlayDeps } from './BreathingOverlaySystem';

const DOC = {
  id: 'paper', size: [100, 50],
  layers: { base: '/resources/b.png', sheet: '/resources/s.png' },
  fields: { file: '/resources/f.bin', width: 10, height: 5 },
  rig: { pxPerMm: 1, root: [1, 2], rootDisp: [0, -1], flapLengthPx: 10, flapNormal: [1, 0], lampDir: [1, 0], shade: 0.1,
    limits: { sheetMm: 15, ventMm: 24, cranMm: 12 } },
  params: { jitter: 0, stillHold: 1, apnea: 0 },
};

function make() {
  const layers = new Map<string, () => void>();
  const sound = { stop: vi.fn(), setFlow: vi.fn() };
  const deps: BreathingOverlayDeps = {
    loadDefJson: vi.fn(async () => JSON.parse(JSON.stringify(DOC))),
    loadTexture: vi.fn(async () => ({}) as never),
    fetchBytes: vi.fn(async () => new ArrayBuffer(10 * 5 * 4 * 4)),
    showLayer: vi.fn(async (id, _w, _h, _x, _y, _wp, _o, prepare) => {
      const build = await prepare();
      const prev = layers.get(id);
      const { disposeGpu } = build(50, 25, 80, 40);
      prev?.();
      layers.set(id, disposeGpu);
      return true;
    }),
    hideLayer: vi.fn((id: string) => { const d = layers.get(id); layers.delete(id); d?.(); }),
    startBreathSound: vi.fn(() => sound),
  };
  return { sys: new BreathingOverlaySystem(deps), deps, sound, layers };
}

describe('BreathingOverlaySystem', () => {
  it('显示:备料、造层、起呼吸声;每帧推进喂声音', async () => {
    const h = make();
    await h.sys.show('h1', 'paper', 50, 48, 82);
    expect(h.sys.has('h1')).toBe(true);
    expect(h.deps.loadTexture).toHaveBeenCalledTimes(2);
    expect(h.deps.startBreathSound).toHaveBeenCalledTimes(1);
    h.sys.update(0.5);
    expect(h.sound.setFlow).toHaveBeenCalled();
    expect(h.sys.debugSnapshot()[0]).toMatchObject({ handle: 'h1', asset: 'paper', mode: 'breathing' });
  });

  it('渐弱 wait:停住 + 真停后多久出字之后才兑现', async () => {
    const h = make();
    await h.sys.show('h1', 'paper', 50, 48, 82);
    let done = false;
    const p = h.sys.perform('h1', 'fadeOut', true).then(() => { done = true; });
    for (let i = 0; i < 60 * 80 && !done; i++) { h.sys.update(1 / 60); await Promise.resolve(); }
    await p;
    expect(done).toBe(true);
    expect(h.sys.debugSnapshot()[0].mode).toBe('stopped');
  });

  it('实时改参数:未知键报出来', async () => {
    const h = make();
    await h.sys.show('h1', 'paper', 50, 48, 82);
    expect(h.sys.setParams('h1', { lag: 0.5, nope: 1 }, 0)).toEqual(['nope']);
    expect(h.sys.setParams('missing', { lag: 1 })).toEqual([]);
  });

  it('层被收掉(hideOverlayImage / 过场 cleanup)→ 实例退役:声音停、等它的步骤放行', async () => {
    const h = make();
    await h.sys.show('h1', 'paper', 50, 48, 82);
    let released = false;
    void h.sys.perform('h1', 'fadeOut', true).then(() => { released = true; });
    h.deps.hideLayer('h1');
    await Promise.resolve();
    expect(h.sys.has('h1')).toBe(false);
    expect(h.sound.stop).toHaveBeenCalled();
    expect(released).toBe(true);
  });

  it('同句柄再显示:旧实例退役、新实例接上', async () => {
    const h = make();
    await h.sys.show('h1', 'paper', 50, 48, 82);
    await h.sys.show('h1', 'paper', 50, 48, 60);
    expect(h.sys.debugSnapshot()).toHaveLength(1);
    expect(h.sound.stop).toHaveBeenCalledTimes(1);
  });

  it('工作台推来的工作态:正在显示的同一张图立刻换参数;之后新显示的也用它;探针', async () => {
    const h = make();
    await h.sys.show('h1', 'paper', 50, 48, 82);
    const doc = JSON.parse(JSON.stringify(DOC));
    doc.params.lag = 1.25;
    h.sys.applyPreview({ paper: doc });
    expect(h.sys.probe('gasp', 'paper')).toBe(true);
    h.sys.update(0.1);
    expect(h.sys.debugSnapshot()[0].phase).toBe('猛抽一口气');
    expect(h.sys.probe('gasp', 'other')).toBe(false);
    expect(h.sys.probe('hide', 'paper')).toBe(true);
    expect(h.sys.has('h1')).toBe(false);
    (h.deps.loadDefJson as ReturnType<typeof vi.fn>).mockClear();
    await h.sys.show('h2', 'paper', 50, 48, 82);
    expect(h.deps.loadDefJson).not.toHaveBeenCalled();
  });

  it('坏资产:说清缺什么,不显示', async () => {
    const h = make();
    (h.deps.loadDefJson as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'paper', size: [1, 1], layers: {} });
    await expect(h.sys.show('h1', 'paper', 50, 48, 82)).rejects.toThrow(/layers.base/);
    expect(h.sys.has('h1')).toBe(false);
  });
});
