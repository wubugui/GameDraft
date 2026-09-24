import { afterEach, describe, expect, it, vi } from 'vitest';
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

interface FakeHowl {
  volumeCalls: number[];
  sidVolumes: Map<number, number>;
  played: number;
  finish(sid: number): void;
}

function last<T>(arr: T[]): T { return arr[arr.length - 1]; }

function makeHowl(): FakeHowl & Record<string, unknown> {
  const listeners = new Map<string, Map<number, () => void>>();
  const emit = (event: string, sid: number) => {
    const fn = listeners.get(event)?.get(sid);
    listeners.get(event)?.delete(sid);
    fn?.();
  };
  const h = {
    volumeCalls: [] as number[],
    sidVolumes: new Map<number, number>(),
    played: 0,
    volume(v?: number, sid?: number) {
      if (v !== undefined) {
        h.volumeCalls.push(v);
        if (sid !== undefined) h.sidVolumes.set(sid, v);
        else for (const key of h.sidVolumes.keys()) h.sidVolumes.set(key, v);
      }
      return last(h.volumeCalls) ?? 1;
    },
    loop() { return true; },
    play() { const sid = ++h.played; h.sidVolumes.set(sid, 1); return sid; },
    stop(sid?: number) { for (const key of sid === undefined ? [...h.sidVolumes.keys()] : [sid]) { emit('stop', key); h.sidVolumes.delete(key); } },
    once(event: string, fn: () => void, sid: number) { if (!listeners.has(event)) listeners.set(event, new Map()); listeners.get(event)!.set(sid, fn); },
    off(event: string, fn: () => void, sid: number) { if (listeners.get(event)?.get(sid) === fn) listeners.get(event)!.delete(sid); },
    finish(sid: number) { emit('end', sid); h.sidVolumes.delete(sid); },
    fade() { /* no-op */ },
    playing() { return true; },
  };
  return h as unknown as FakeHowl & Record<string, unknown>;
}

const CONFIG = {
  bgm: { a: { src: 'a.wav' }, b: { src: 'b.wav' } },
  ambient: { wind: { src: 'wind.wav' } },
  sfx: { crack: { src: 'crack.wav' } },
  voice: { line: { src: 'crack.wav' } },
  systemSfx: {},
};

const managers: AudioManager[] = [];
afterEach(() => { for (const audio of managers.splice(0)) audio.destroy(); vi.useRealTimers(); });

function makeAudioManager() {
  const audio = new AudioManager(new EventBus());
  managers.push(audio);
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
  it('演出预备让出任务后静默填两套缓存，同一引用合并且音频偏好不变', async () => {
    vi.useFakeTimers();
    const { audio } = makeAudioManager();
    const bus = { prepareMix: vi.fn(), preload: vi.fn(async () => ({})), releaseMix: vi.fn(), refreshMixGains: vi.fn(), destroy: vi.fn() };
    const howl = makeHowl();
    const loadAudio = vi.fn(async () => howl);
    Object.assign(audio, { spatialBus: bus, ensureSpatialBus: () => bus, assetManager: { getAudio: () => null, loadAudio } });
    const owner = {};
    const done = audio.prepareSfx([{ id: 'crack' }, { id: 'crack', positional: true }, { id: 'unknown' }], owner);
    expect(bus.prepareMix).not.toHaveBeenCalled();
    expect(loadAudio).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await done;
    expect(bus.prepareMix).toHaveBeenCalledOnce();
    expect(bus.preload).toHaveBeenCalledExactlyOnceWith('crack.wav');
    expect(loadAudio).toHaveBeenCalledExactlyOnceWith('crack.wav', { loop: false });
    expect(howl.played).toBe(0);
    expect(audio.getVolume('sfx')).toBe(0.8);
    audio.releaseAudioOwner(owner);
    expect(bus.releaseMix).toHaveBeenCalledOnce();
    await audio.prepareSfx([{ id: 'crack', positional: true }], owner);
    expect(bus.prepareMix).toHaveBeenCalledOnce();
  });

  it('预备中断/换空间/destroy可同步取消等待，迟到解码不会再建route或起播', async () => {
    vi.useFakeTimers();
    for (const end of ['owner', 'space', 'destroy'] as const) {
      const { audio } = makeAudioManager();
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const bus = {
        prepareMix: vi.fn(), preload: vi.fn(() => pending), releaseMix: vi.fn(),
        destroy: vi.fn(), setSpace: vi.fn(), refreshMixGains: vi.fn(),
      };
      const loadAudio = vi.fn(() => pending);
      Object.assign(audio, { spatialBus: bus, ensureSpatialBus: () => bus, assetManager: { getAudio: () => null, loadAudio } });
      const owner = {};
      const done = audio.prepareSfx([{ id: 'crack', positional: true }], owner);
      await vi.runAllTimersAsync();
      expect(loadAudio).toHaveBeenCalledOnce();
      if (end === 'owner') audio.releaseAudioOwner(owner);
      else if (end === 'space') audio.setAcousticSpace(null);
      else audio.destroy();
      await done; // must settle even though fetch/decode never completed
      const routesBefore = bus.prepareMix.mock.calls.length;
      finish();
      await vi.runAllTimersAsync();
      expect(bus.prepareMix).toHaveBeenCalledTimes(routesBefore);
      expect((audio as unknown as { audioPreparations: Map<object, unknown> }).audioPreparations.size).toBe(0);
    }
  });

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

  it('闪避不进偏好也不进存档——落盘的永远是玩家偏好', () => {
    const { audio } = makeAudioManager();
    audio.setVolume('bgm', 0.7);
    audio.pushAudioDuck('leifu', { bgm: 0.02 }, 5000);
    expect(audio.getMixPreferences().bgm).toBe(0.7);
    // 音量是玩家偏好（settings/audio.json），2026-09-23 起整个不随存档走
    expect(audio.serialize()).toEqual({});
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
  it('音效与配音区同名id不串停，带owner时仍只停止该会话的音效', () => {
    const { audio, howls } = makeAudioManager();
    (audio as unknown as { config: unknown }).config = {
      ...CONFIG, voice: { crack: { src: 'voice.wav' } },
    };
    const owner = {};
    audio.playSfx('crack', .5, owner);
    audio.playSfx('crack', .3);
    audio.playVoice('crack', { mixOwner: owner });
    audio.stopSfxById('crack', owner);
    expect(howls.get('crack.wav')!.sidVolumes.size).toBe(1);
    expect(howls.get('voice.wav')!.sidVolumes.size).toBe(1);
    audio.stopSfxById('crack');
    expect(howls.get('crack.wav')!.sidVolumes.size).toBe(0);
    expect(howls.get('voice.wav')!.sidVolumes.size).toBe(1);
  });

  it('有位置的那条也要掐得掉——它根本不经 Howler', () => {
    const { audio } = makeAudioManager();
    const stops: number[] = [];
    // 空间音总线的替身：只记有没有被 stop
    (audio as unknown as { spatialBus: unknown }).spatialBus = {
      playAt: () => ({ stop: () => { stops.push(1); } }),
      refreshMixGains: () => {},
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

describe('持续混音状态与声音归属', () => {
  it('压的是原响度：超过1的素材补偿仍保留，满幅声也必须被压低', () => {
    const { audio, howls } = makeAudioManager();
    audio.setVolume('sfx', .5);
    audio.pushAudioDuck('state', { sfx: .08 }, 5000);
    audio.playSfx('crack', 4);
    expect([...howls.get('crack.wav')!.sidVolumes.values()]).toEqual([expect.closeTo(.08)]);
    audio.releaseAudioDuck('state');
    expect([...howls.get('crack.wav')!.sidVolumes.values()]).toEqual([1]);
  });

  it('空间声拆开源增益与持续路由倍率，解码后跟随新状态，失败也回收登记', () => {
    const { audio } = makeAudioManager();
    type Play = { volume: number; mix: { gain: number }; onDispose(): void };
    const plays: Play[] = [];
    const bus = {
      playAt: (_src: string, _at: unknown, opts: Play) => {
        plays.push(opts);
        return { stop: () => opts.onDispose(), setVolume: (v: number) => { opts.volume = v; } };
      },
      refreshMixGains() {}, releaseMix() {}, destroy() {},
    };
    (audio as unknown as { spatialBus: unknown }).spatialBus = bus;
    (audio as unknown as { ensureSpatialBus: () => unknown }).ensureSpatialBus = () => bus;
    audio.setVolume('sfx', .5);
    const owner = {};
    audio.playSfxAt('crack', null, { volume: 2 });
    audio.playSfxAt('crack', null, { volume: 2, mixOwner: owner });
    audio.pushAudioDuck('skill', { sfx: .08 }, 5000, 0, true, owner);
    expect(plays.map(p => p.volume * p.mix.gain)).toEqual([expect.closeTo(.08), 1]);
    audio.setVolume('sfx', .2);
    expect(plays.map(p => p.volume * p.mix.gain)).toEqual([expect.closeTo(.032), .4]);
    plays[0].onDispose(); plays[1].onDispose();
    expect((audio as unknown as { liveMixSounds: Map<unknown, unknown> }).liveMixSounds.size).toBe(0);
  });

  it('先响和渐变中起播的短音、voice、循环都持续跟随状态，偏好修改不会被恢复覆盖', () => {
    vi.useFakeTimers();
    const { audio, howls } = makeAudioManager();
    audio.setVolume('sfx', 1);
    audio.setVolume('voice', 1);
    audio.playSfx('crack', .8);
    audio.playVoice('line', { volume: .6 });
    audio.pushAudioDuck('state', { sfx: .1, voice: .2 }, 5000, 800);
    vi.advanceTimersByTime(350);
    audio.playTransientSfx('crack', { volume: .4, loop: true });
    audio.playSfx('crack', .2);
    vi.advanceTimersByTime(500);
    const h = howls.get('crack.wav')!;
    expect([...h.sidVolumes.values()]).toEqual([expect.closeTo(.08), expect.closeTo(.12), expect.closeTo(.04), expect.closeTo(.02)]);
    audio.setVolume('sfx', .5);
    audio.releaseAudioDuck('state');
    expect([...h.sidVolumes.values()]).toEqual([expect.closeTo(.4), expect.closeTo(.6), expect.closeTo(.2), expect.closeTo(.1)]);
    expect(audio.getVolume('sfx')).toBe(.5);
  });

  it('同素材的技能音与普通音分实例；只豁免自己的状态，仍服从别的状态', () => {
    const { audio, howls } = makeAudioManager();
    audio.setVolume('sfx', 1);
    const skill = {}, other = {};
    audio.pushAudioDuck('same', { sfx: .08 }, 1000, 0, true, skill);
    audio.playSfx('crack', .9, skill);
    audio.playSfx('crack', .5);
    expect([...howls.get('crack.wav')!.sidVolumes.values()]).toEqual([.9, expect.closeTo(.04)]);
    const releaseOther = audio.pushAudioDuck('same', { sfx: .3 }, 1000, 0, true, other);
    expect([...howls.get('crack.wav')!.sidVolumes.values()]).toEqual([expect.closeTo(.27), expect.closeTo(.04)]);
    audio.releaseAudioDuck('same', 0, skill);
    audio.releaseAudioOwner(skill);
    expect([...howls.get('crack.wav')!.sidVolumes.values()]).toEqual([expect.closeTo(.15)]);
    releaseOther();
    expect([...howls.get('crack.wav')!.sidVolumes.values()]).toEqual([.5]);
  });

  it('按实例释放幂等，作者已发起的缓慢恢复不被自然收尾抢断，中断可立刻归位', () => {
    vi.useFakeTimers();
    const { audio } = makeAudioManager();
    const a = {}, b = {};
    const releaseA = audio.pushAudioDuck('same', { sfx: .1 }, 1000, 0, true, a);
    const releaseB = audio.pushAudioDuck('same', { sfx: .4 }, 1000, 0, true, b);
    audio.releaseAudioDuck('same', 1000, a);
    releaseA();
    expect(audio.getAudioDuck('sfx')).toBeLessThan(.4);
    releaseA(0);
    releaseA(0);
    expect(audio.getAudioDuck('sfx')).toBeCloseTo(.4);
    vi.advanceTimersByTime(2000);
    expect(audio.getAudioDuck('sfx')).toBeCloseTo(.4); // managed state never expires on wall clock
    releaseB();
    expect(audio.getAudioDuck('sfx')).toBe(1);
  });

  it('解码期间进入状态，实际起播读取新值；会话结束后旧加载不能复活', async () => {
    const { audio } = makeAudioManager();
    const h = makeHowl();
    let resolve!: (h: unknown) => void;
    (audio as unknown as { assetManager: unknown }).assetManager = {
      getAudio: () => null,
      loadAudio: () => new Promise(r => { resolve = r; }),
    };
    audio.setVolume('sfx', 1);
    audio.playSfx('crack');
    audio.pushAudioDuck('state', { sfx: .1 }, 5000);
    resolve(h); await Promise.resolve();
    expect([...h.sidVolumes.values()]).toEqual([expect.closeTo(.1)]);
    const owner = {};
    audio.playTransientSfx('crack', { mixOwner: owner });
    audio.releaseAudioOwner(owner);
    resolve(h); await Promise.resolve();
    expect(h.played).toBe(1);
    expect(audio.playTransientSfx('crack', { mixOwner: owner })).toBeNull();
  });

  it('自然结束、stop和destroy都回收持续混音登记', () => {
    const { audio, howls } = makeAudioManager();
    const first = audio.playTransientSfx('crack')!;
    audio.playVoice('line');
    const h = howls.get('crack.wav')!;
    first.stop(); h.finish(2);
    const callCount = h.volumeCalls.length;
    audio.pushAudioDuck('state', { sfx: .2, voice: .2 }, 5000);
    expect(h.volumeCalls.length).toBe(callCount);
    expect((audio as unknown as { liveMixSounds: Map<unknown, unknown> }).liveMixSounds.size).toBe(0);
    audio.playTransientSfx('crack', { loop: true });
    audio.destroy();
    expect(h.sidVolumes.size).toBe(0);
  });

  it('已移出场景基线但仍在淡出的BGM和环境声也服从当前状态', () => {
    vi.useFakeTimers();
    const { audio, howls } = makeAudioManager();
    audio.setVolume('bgm', 1); audio.setVolume('ambient', 1);
    audio.playBgm('a', 0);
    audio.addAmbient('wind');
    audio.playBgm('b', 1000);
    audio.removeAmbient('wind', 1000);
    vi.advanceTimersByTime(400);
    const beforeA = last(howls.get('a.wav')!.volumeCalls);
    const beforeWind = last(howls.get('wind.wav')!.volumeCalls);
    audio.pushAudioDuck('state', { bgm: .1, ambient: .2 }, 5000);
    expect(last(howls.get('a.wav')!.volumeCalls)).toBeCloseTo(beforeA * .1);
    expect(last(howls.get('wind.wav')!.volumeCalls)).toBeCloseTo(beforeWind * .2);
    vi.advanceTimersByTime(650);
    expect(howls.get('a.wav')!.sidVolumes.size).toBe(0);
    expect(howls.get('wind.wav')!.sidVolumes.size).toBe(0);
    expect(last(howls.get('b.wav')!.volumeCalls)).toBeCloseTo(.1);
  });
});
