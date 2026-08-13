import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TextDisplaySettings,
  TYPEWRITER_SCALE_DEFAULT,
  TYPEWRITER_SCALE_MAX,
  TYPEWRITER_SCALE_MIN,
  sliderToTypewriterScale,
  typewriterScaleToSlider,
} from './TextDisplaySettings';

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear() { data.clear(); },
    getItem(key: string) { return data.has(key) ? data.get(key)! : null; },
    key(index: number) { return Array.from(data.keys())[index] ?? null; },
    removeItem(key: string) { data.delete(key); },
    setItem(key: string, value: string) { data.set(key, value); },
  };
}

describe('TextDisplaySettings', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('缺省是「开着的逐字显示 + 基准速度」', () => {
    const s = new TextDisplaySettings();
    expect(s.isTypewriterEnabled()).toBe(true);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('改动落盘，下一局（新实例）读得回来', () => {
    const first = new TextDisplaySettings();
    first.setTypewriterEnabled(false);
    first.setTypewriterSpeedScale(2);

    const second = new TextDisplaySettings();
    expect(second.isTypewriterEnabled()).toBe(false);
    expect(second.getTypewriterSpeedScale()).toBe(2);
  });

  it('越界与 NaN 一律夹回区间，不会把速度写成 0 或 NaN（0 = 永远打不完）', () => {
    const s = new TextDisplaySettings();
    s.setTypewriterSpeedScale(999);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_MAX);
    s.setTypewriterSpeedScale(0);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_MIN);
    s.setTypewriterSpeedScale(Number.NaN);
    expect(s.getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('存档里的脏值 / 坏 JSON 不污染本局（退回缺省）', () => {
    localStorage.setItem('gamedraft_text_display', '{"typewriterEnabled":"yes","speedScale":"快"}');
    expect(new TextDisplaySettings().isTypewriterEnabled()).toBe(true);
    expect(new TextDisplaySettings().getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);

    localStorage.setItem('gamedraft_text_display', '{not json');
    expect(new TextDisplaySettings().getTypewriterSpeedScale()).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('localStorage 抛异常时仍然可用（沙箱 / 隐私模式）', () => {
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
      clear() { throw new Error('blocked'); },
      key() { return null; },
      length: 0,
    });
    const s = new TextDisplaySettings();
    expect(() => s.setTypewriterEnabled(false)).not.toThrow();
    expect(s.isTypewriterEnabled()).toBe(false);
  });

  it('滑条映射：默认 1× 正好落在轨道正中，两端对上区间端点', () => {
    expect(typewriterScaleToSlider(TYPEWRITER_SCALE_DEFAULT)).toBeCloseTo(0.5, 6);
    expect(typewriterScaleToSlider(TYPEWRITER_SCALE_MIN)).toBeCloseTo(0, 6);
    expect(typewriterScaleToSlider(TYPEWRITER_SCALE_MAX)).toBeCloseTo(1, 6);
    expect(sliderToTypewriterScale(0)).toBe(TYPEWRITER_SCALE_MIN);
    expect(sliderToTypewriterScale(1)).toBe(TYPEWRITER_SCALE_MAX);
    expect(sliderToTypewriterScale(0.5)).toBe(TYPEWRITER_SCALE_DEFAULT);
  });

  it('滑条取值吸附到 5% 一档（免得数值列写出 103%）', () => {
    for (let v = 0; v <= 1.0001; v += 0.017) {
      const scale = sliderToTypewriterScale(v);
      expect(Math.round(scale * 100) % 5).toBe(0);
    }
  });
});
