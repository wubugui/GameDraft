import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { AudioManager } from './AudioManager';

/**
 * 演出闪避（ducking）的契约。
 *
 * 制作人 2026-09-19 的要求是两句话：放技能时把别的背景声压到最小，**放完严格恢复到之前**。
 * "严格"这两个字决定了实现方式：闪避是**独立的一层倍率**，玩家在设置页调的那四个档
 * 从头到尾没被碰过——所以还原是把倍率放回 1，而不是靠记一份快照再写回去
 * （快照那条路上，演出期间玩家自己去改了音量就会被演出结束时覆盖掉）。
 */

interface FakeHowl { volumeCalls: number[] }

function last<T>(arr: T[]): T { return arr[arr.length - 1]; }

function makeHowl(): FakeHowl & Record<string, unknown> {
  const h = {
    volumeCalls: [] as number[],
    volume(v?: number) { if (v !== undefined) h.volumeCalls.push(v); return last(h.volumeCalls) ?? 1; },
    loop() { return true; },
    play() { return 1; },
    stop() { /* no-op */ },
    fade() { /* no-op */ },
    playing() { return true; },
  };
  return h as unknown as FakeHowl & Record<string, unknown>;
}

const CONFIG = {
  bgm: {},
  ambient: {},
  sfx: { crack: { src: 'crack.wav' } },
  voice: {},
  systemSfx: {},
};

function makeAudioManager() {
  const audio = new AudioManager(new EventBus());
  const howls = new Map<string, FakeHowl & Record<string, unknown>>();
  const getAudio = (src: string) => {
    if (!howls.has(src)) howls.set(src, makeHowl());
    return howls.get(src);
  };
  audio.init({ assetManager: { loadJson: vi.fn() } } as never);
  (audio as unknown as { config: unknown }).config = CONFIG;
  (audio as unknown as { assetManager: unknown }).assetManager = {
    getAudio: (src: string) => getAudio(src),
    loadAudio: (src: string) => Promise.resolve(getAudio(src)),
  };
  (audio as unknown as { audioUnblocked: boolean }).audioUnblocked = true;
  (audio as unknown as { runWhenAudioAllowed: (f: () => void) => void }).runWhenAudioAllowed =
    (f: () => void) => { void f(); };
  return { audio, howls };
}

describe('演出闪避', () => {
  it('压下去再抬起来，回到的是压之前那个数（不是某个写死的缺省）', () => {
    const { audio } = makeAudioManager();
    audio.setVolume('bgm', 0.33);          // 玩家自己调过
    expect(audio.getAudioDuck('bgm')).toBe(1);

    audio.pushAudioDuck('leifu', { bgm: 0.05 }, 5000);
    expect(audio.getAudioDuck('bgm')).toBeCloseTo(0.05);
    expect(audio.getVolume('bgm')).toBe(0.33); // 玩家偏好没被碰

    audio.releaseAudioDuck('leifu');
    expect(audio.getAudioDuck('bgm')).toBe(1);
    expect(audio.getVolume('bgm')).toBe(0.33);
  });

  it('闪避不进存档——序列化出去的永远是玩家偏好', () => {
    const { audio } = makeAudioManager();
    audio.setVolume('bgm', 0.7);
    audio.pushAudioDuck('leifu', { bgm: 0.02 }, 5000);
    expect((audio.serialize() as { bgmVolume: number }).bgmVolume).toBe(0.7);
  });

  it('同名叠两层：先放的那次还原，不会把后放的那次一起抬掉', () => {
    const { audio } = makeAudioManager();
    audio.pushAudioDuck('leifu', { ambient: 0.2 }, 5000);
    audio.pushAudioDuck('leifu', { ambient: 0.1 }, 5000);
    expect(audio.getAudioDuck('ambient')).toBeCloseTo(0.1); // 取最狠的那档

    audio.releaseAudioDuck('leifu');                        // 抬掉最早那层
    expect(audio.getAudioDuck('ambient')).toBeCloseTo(0.1); // 后放的那次还压着
    audio.releaseAudioDuck('leifu');
    expect(audio.getAudioDuck('ambient')).toBe(1);
  });

  it('演出被打断也不会让世界一直闷着：到期自己抬', () => {
    vi.useFakeTimers();
    try {
      const { audio } = makeAudioManager();
      audio.pushAudioDuck('leifu', { bgm: 0.05 }, 1200);
      expect(audio.getAudioDuck('bgm')).toBeCloseTo(0.05);
      vi.advanceTimersByTime(1300);
      expect(audio.getAudioDuck('bgm')).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('一次性音效在 play 那一刻就乘过闪避', () => {
    const { audio, howls } = makeAudioManager();
    audio.setVolume('sfx', 1);
    audio.pushAudioDuck('x', { sfx: 0.25 }, 5000);
    audio.playSfx('crack');
    expect(last(howls.get('crack.wav')!.volumeCalls)).toBeCloseTo(0.25);
  });

  it('切场景 / 拆除一律全抬', () => {
    const { audio } = makeAudioManager();
    audio.pushAudioDuck('a', { bgm: 0.1 }, 5000);
    audio.pushAudioDuck('b', { ambient: 0.1 }, 5000);
    audio.clearAudioDucks();
    expect(audio.getAudioDuck('bgm')).toBe(1);
    expect(audio.getAudioDuck('ambient')).toBe(1);
  });

  it('抬一个没压过的名字是安静的 no-op（演出被打断后补一句还原不该炸）', () => {
    const { audio } = makeAudioManager();
    expect(() => audio.releaseAudioDuck('从没压过')).not.toThrow();
    expect(audio.getAudioDuck('bgm')).toBe(1);
  });
});

describe('按 id 掐掉在响的音效', () => {
  it('有位置的那条也要掐得掉——它根本不经 Howler', () => {
    const { audio } = makeAudioManager();
    const stops: number[] = [];
    // 空间音总线的替身：只记有没有被 stop
    (audio as unknown as { spatialBus: unknown }).spatialBus = {
      playAt: () => ({ stop: () => { stops.push(1); } }),
      destroy: () => { /* no-op */ },
    };
    (audio as unknown as { ensureSpatialBus: () => unknown }).ensureSpatialBus =
      () => (audio as unknown as { spatialBus: unknown }).spatialBus;

    audio.playSfxAt('crack', { x: 0, y: 0, z: 0 });
    audio.stopSfxById('crack');
    expect(stops.length).toBe(1);
  });

  it('掐一条没在响的是安静的 no-op', () => {
    const { audio } = makeAudioManager();
    expect(() => audio.stopSfxById('crack')).not.toThrow();
  });
});
