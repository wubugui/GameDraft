import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { AudioManager } from './AudioManager';

/**
 * `playSfxAt(..., {spatialized:false})` 的契约：**整条空间音通道被绕开**。
 *
 * 判据必须是「总线没被调用」而不是「听起来干」——空间总线里 `dry` 可以调到 1、
 * 反射面可以一个都没有，那时"走了总线"和"没走总线"听感一样，但前者仍在建
 * BufferSource / 卷积器 / 延迟节点。作者关这个闸是为了把脚步素材本身听清楚，
 * 半开的通道等于没关。
 *
 * 同时锁住音量口径：关闸走的是 `playTransientSfx`，与「没有 AudioContext」那条退路
 * **同一条**，所以两边都是 `volume × sfxVolume`。另起一条播放路径就会出现
 * 「关了空间化顺便变响了」——那种偏差在听感上正好会被误读成"空间化本来在压音量"。
 */
function makeAudioManager() {
  const eventBus = new EventBus();
  const audio = new AudioManager(eventBus);
  audio.init({ assetManager: { loadJson: vi.fn() } } as never);
  (audio as unknown as { config: unknown }).config = {
    sfx: { step: { src: 'step.ogg', volume: 0.8 } },
    bgm: {},
  };

  const busPlayed: Array<{ url: string; at: unknown }> = [];
  const transient: Array<{ id: string; volume?: number }> = [];
  const inner = { stop: () => {} };
  (audio as unknown as { ensureSpatialBus: () => unknown }).ensureSpatialBus = () => ({
    playAt: (url: string, at: unknown) => { busPlayed.push({ url, at }); return inner; },
  });
  (audio as unknown as { audioUnblocked: boolean }).audioUnblocked = true;
  (audio as unknown as { runWhenAudioAllowed: (f: () => void) => void }).runWhenAudioAllowed =
    (f: () => void) => { f(); };
  (audio as unknown as {
    playTransientSfx: (id: string, o: { volume?: number }) => unknown;
  }).playTransientSfx = (id, o) => { transient.push({ id, volume: o?.volume }); return inner; };

  return { audio, busPlayed, transient };
}

const AT = { x: 100, y: 0, z: 200 };

describe('AudioManager.playSfxAt：空间化总闸', () => {
  it('缺省（不给 spatialized）走空间总线', () => {
    const { audio, busPlayed, transient } = makeAudioManager();
    audio.playSfxAt('step', AT, { volume: 0.5 });
    expect(busPlayed).toHaveLength(1);
    expect(transient).toHaveLength(0);
  });

  it('spatialized:true 与不给等价', () => {
    const { audio, busPlayed, transient } = makeAudioManager();
    audio.playSfxAt('step', AT, { volume: 0.5, spatialized: true });
    expect(busPlayed).toHaveLength(1);
    expect(transient).toHaveLength(0);
  });

  it('🔴 spatialized:false ⇒ 总线一次都没被调用，就播一个声音', () => {
    const { audio, busPlayed, transient } = makeAudioManager();
    audio.playSfxAt('step', AT, { volume: 0.5, spatialized: false });
    expect(busPlayed).toHaveLength(0);
    expect(transient).toEqual([{ id: 'step', volume: 0.5 }]);
  });

  it('音量原样交给 transient 路径 —— 关空间化不该顺便改响度', () => {
    const { audio, transient } = makeAudioManager();
    audio.playSfxAt('step', AT, { volume: 0.25, spatialized: false });
    expect(transient[0].volume).toBe(0.25);
  });

  it('id 查不到仍然当场 warn + 返回 null，不因为关了空间化就静默', () => {
    const { audio, busPlayed, transient } = makeAudioManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = audio.playSfxAt('没这个key', AT, { spatialized: false });
    expect(h).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(busPlayed).toHaveLength(0);
    expect(transient).toHaveLength(0);
    warn.mockRestore();
  });
});
