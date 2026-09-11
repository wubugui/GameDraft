import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { AudioManager } from './AudioManager';

/**
 * 逐处音量（`{ id, volume }`）的运行时契约。口径见 `src/data/audioCue.ts`：
 * **本处音量替换素材级**，再乘通道音量，最后 clamp 到满幅。
 *
 * 这些判据全都只在真机听得出来（数值错了声音还是响的，只是不对），所以必须钉死在这里。
 */

interface FakeHowl {
  id: string;
  volumeCalls: number[];
  loopCalls: boolean[];
  played: number;
  stopped: number;
  fades: Array<[number, number, number]>;
}

/** 取末元素。`Array.prototype.at` 不在本工程的 lib 目标里（tsc 会报 TS2550）。 */
function last<T>(arr: T[]): T {
  return arr[arr.length - 1];
}

function makeHowl(id: string): FakeHowl & Record<string, unknown> {
  const h = {
    id,
    volumeCalls: [] as number[],
    loopCalls: [] as boolean[],
    played: 0,
    stopped: 0,
    fades: [] as Array<[number, number, number]>,
    volume(v?: number) { if (v !== undefined) h.volumeCalls.push(v); return last(h.volumeCalls) ?? 1; },
    loop(v?: boolean) { if (v !== undefined) h.loopCalls.push(v); return true; },
    play() { h.played += 1; return 1; },
    stop() { h.stopped += 1; },
    fade(from: number, to: number, ms: number) { h.fades.push([from, to, ms]); },
    playing() { return h.played > 0; },
  };
  return h as unknown as FakeHowl & Record<string, unknown>;
}

function makeAudioManager(config: Record<string, unknown>) {
  const eventBus = new EventBus();
  const audio = new AudioManager(eventBus);
  const howls = new Map<string, FakeHowl & Record<string, unknown>>();
  const getAudio = (src: string) => {
    if (!howls.has(src)) howls.set(src, makeHowl(src));
    return howls.get(src);
  };
  audio.init({ assetManager: { loadJson: vi.fn() } } as never);
  (audio as unknown as { config: unknown }).config = config;
  (audio as unknown as { assetManager: unknown }).assetManager = {
    getAudio: (src: string) => getAudio(src),
    loadAudio: (src: string) => Promise.resolve(getAudio(src)),
  };
  (audio as unknown as { audioUnblocked: boolean }).audioUnblocked = true;
  // 同步执行：本套测试只关心音量算得对不对，不测手势门与在途代次
  (audio as unknown as { runWhenAudioAllowed: (f: () => void) => void }).runWhenAudioAllowed =
    (f: () => void) => { void f(); };
  return { audio, eventBus, howls };
}

const CONFIG = {
  bgm: { theme: { src: 'theme.mp3', volume: 0.8 }, plain: { src: 'plain.mp3' } },
  ambient: { wind: { src: 'wind.wav', volume: 0.5 }, rain: { src: 'rain.wav' } },
  sfx: { door: { src: 'door.wav', volume: 0.6 }, tick: { src: 'tick.wav' } },
  voice: {},
  systemSfx: {},
};

describe('AudioManager：BGM 的本处音量', () => {
  it('本处音量替换素材级，再乘 bgm 通道音量', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.playBgm('theme', 0, 0.25);
    await Promise.resolve();
    // 0.25（本处） × 0.6（bgm 通道出厂）= 0.15；**不是** 0.8 × 0.25 × 0.6
    expect(last(howls.get('theme.mp3')!.fades)[1]).toBeCloseTo(0.15, 6);
  });

  it('不给本处音量时沿用素材级', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.playBgm('theme', 0);
    await Promise.resolve();
    expect(last(howls.get('theme.mp3')!.fades)[1]).toBeCloseTo(0.8 * 0.6, 6);
  });

  it('🔴 同一首曲子换个音量必须真的重播——幂等守卫不能只比 id', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.playBgm('theme', 0, 1);
    await Promise.resolve();
    const first = last(howls.get('theme.mp3')!.fades)[1];
    audio.playBgm('theme', 0, 0.2);
    await Promise.resolve();
    const second = last(howls.get('theme.mp3')!.fades)[1];
    expect(first).not.toBeCloseTo(second, 6);
    expect(second).toBeCloseTo(0.2 * 0.6, 6);
  });

  it('同 id 同音量重复请求仍是 no-op（不重播、不爆音）', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.playBgm('theme', 0, 0.3);
    await Promise.resolve();
    const plays = howls.get('theme.mp3')!.played;
    audio.playBgm('theme', 0, 0.3);
    await Promise.resolve();
    expect(howls.get('theme.mp3')!.played).toBe(plays);
  });

  it('>1 只能顶到满幅（clamp），不会溢出', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.playBgm('theme', 0, 4);
    await Promise.resolve();
    expect(last(howls.get('theme.mp3')!.fades)[1]).toBe(1);
  });
});

describe('AudioManager：环境层的本处音量', () => {
  it('本处音量替换素材级，再乘 ambient 通道音量', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.addAmbient('wind', 0.25);
    await Promise.resolve();
    expect(last(howls.get('wind.wav')!.volumeCalls)).toBeCloseTo(0.25 * 0.4, 6);
  });

  it('🔴 已在播的层换音量：不重播，但要认新音量', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.addAmbient('wind', 0.5);
    await Promise.resolve();
    const plays = howls.get('wind.wav')!.played;
    audio.addAmbient('wind', 0.1);
    await Promise.resolve();
    expect(howls.get('wind.wav')!.played).toBe(plays);            // 没重播（不爆音）
    expect(last(howls.get('wind.wav')!.volumeCalls)).toBeCloseTo(0.1 * 0.4, 6);
  });

  it('volume 0 是"这里就是要哑"，不能退回素材原音', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.addAmbient('wind', 0);
    await Promise.resolve();
    expect(last(howls.get('wind.wav')!.volumeCalls)).toBe(0);
  });
});

describe('AudioManager：场景音频套用带本处音量', () => {
  it('bgm 与逐层 ambient 的引用都认对象形态', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.applySceneAudio({ id: 'theme', volume: 0.5 }, ['rain', { id: 'wind', volume: 0.2 }]);
    await Promise.resolve();
    expect(last(howls.get('theme.mp3')!.fades)[1]).toBeCloseTo(0.5 * 0.6, 6);
    expect(last(howls.get('rain.wav')!.volumeCalls)).toBeCloseTo(1 * 0.4, 6);
    expect(last(howls.get('wind.wav')!.volumeCalls)).toBeCloseTo(0.2 * 0.4, 6);
  });

  it('资源清单对两种形态都取得出 src', () => {
    const { audio } = makeAudioManager(structuredClone(CONFIG));
    const refs = audio.getSceneAudioRefs({ id: 'theme', volume: 0.5 }, [{ id: 'wind' }, 'rain']);
    expect(refs.map((r) => r.path)).toEqual(['theme.mp3', 'wind.wav', 'rain.wav']);
  });
});

describe('AudioManager：过场音频基线连音量一起快照', () => {
  it('🔴 快照带音量：过场停掉的那层还原时不会变响', async () => {
    const { audio, howls } = makeAudioManager(structuredClone(CONFIG));
    audio.applySceneAudio({ id: 'theme', volume: 0.5 }, [{ id: 'wind', volume: 0.2 }]);
    await Promise.resolve();

    const bgmCue = audio.getCurrentBgmCue();
    const ambientCues = audio.getActiveAmbientCues();
    expect(bgmCue).toEqual({ id: 'theme', volume: 0.5 });
    expect(ambientCues).toEqual([{ id: 'wind', volume: 0.2 }]);

    // 过场把环境层停了
    audio.clearAmbient(0);
    await Promise.resolve();
    // 过场收尾还原
    audio.restoreAudioBaseline(bgmCue, ambientCues);
    await Promise.resolve();
    expect(last(howls.get('wind.wav')!.volumeCalls)).toBeCloseTo(0.2 * 0.4, 6);
  });

  it('没配本处音量的层，快照就是裸 id（不凭空注入音量）', async () => {
    const { audio } = makeAudioManager(structuredClone(CONFIG));
    audio.playBgm('plain', 0);
    audio.addAmbient('rain');
    await Promise.resolve();
    expect(audio.getCurrentBgmCue()).toBe('plain');
    // rain 没有素材级 volume，基线记的是解析出的基准值 1（还原时等价）
    expect(audio.getActiveAmbientCues()).toEqual([{ id: 'rain', volume: 1 }]);
  });
});

describe('AudioManager：系统音效表的本处音量', () => {
  it('表里写 { id, volume } 时按本处音量播', async () => {
    const config = structuredClone(CONFIG);
    config.systemSfx = { uiHover: { id: 'tick', volume: 0.15 }, uiConfirm: 'door' } as never;
    const { audio, howls } = makeAudioManager(config);
    (audio as unknown as { playSystemSfx: (k: string) => void }).playSystemSfx.call(
      audio, 'uiHover',
    );
    await Promise.resolve();
    expect(last(howls.get('tick.wav')!.volumeCalls)).toBeCloseTo(0.15 * 0.8, 6);
  });

  it('裸 id 形态沿用素材级音量（旧数据一字不改照旧工作）', async () => {
    const config = structuredClone(CONFIG);
    config.systemSfx = { uiConfirm: 'door' } as never;
    const { audio, howls } = makeAudioManager(config);
    (audio as unknown as { playSystemSfx: (k: string) => void }).playSystemSfx.call(
      audio, 'uiConfirm',
    );
    await Promise.resolve();
    expect(last(howls.get('door.wav')!.volumeCalls)).toBeCloseTo(0.6 * 0.8, 6);
  });
});
