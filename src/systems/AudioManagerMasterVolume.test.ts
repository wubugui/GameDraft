import { afterEach, describe, expect, it, vi } from 'vitest';
import { Howler } from 'howler';
import { EventBus } from '../core/EventBus';
import { MemoryStore, __setPersistentStoreForTests } from '../core/storage/persistentStore';
import { AUDIO_MIX_DEFAULTS, parseAudioMixPreferences, serializeAudioMixPreferences } from '../audio/audioMixPreferences';
import { AudioManager } from './AudioManager';

/**
 * 总音量 + 玩家混音偏好（2026-09-23 制作人："音量要有一个全局音量控制所有声音，要做到声音底层系统里"）。
 *
 * 锁住三件事：
 * 1. 总音量**只**写在出口上（Howler 主增益），不进任何一条混音公式——否则就又回到
 *    "这儿乘一点那儿乘一点"，而且每条新播放路径都得记得乘它；
 * 2. 五个数全是玩家偏好：落 `settings/audio.json`，读得回来；
 * 3. 不随存档走：老档里躺着的四条通道音量一律不读（读了就是"读档把设置页改了"）。
 */

const managers: AudioManager[] = [];
afterEach(() => {
  for (const audio of managers.splice(0)) audio.destroy();
  __setPersistentStoreForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeAudioManager(): AudioManager {
  const audio = new AudioManager(new EventBus());
  managers.push(audio);
  return audio;
}

function spyOutput(): ReturnType<typeof vi.fn> {
  const spy = vi.fn((v?: number) => (v === undefined ? 1 : Howler));
  (Howler as unknown as { volume: unknown }).volume = spy;
  (Howler as unknown as { noAudio: boolean }).noAudio = false;
  return spy;
}

describe('总音量写在出口上', () => {
  it('setMasterVolume 钳到 0..1 并写进 Howler 主增益', () => {
    const out = spyOutput();
    const audio = makeAudioManager();
    audio.setMasterVolume(0.35);
    expect(audio.getMasterVolume()).toBe(0.35);
    expect(out).toHaveBeenLastCalledWith(0.35);
    audio.setMasterVolume(7);
    expect(audio.getMasterVolume()).toBe(1);
    audio.setMasterVolume(Number.NaN);
    expect(audio.getMasterVolume()).toBe(0);
  });

  it('不进通道公式：改总音量，通道读数与各自偏好一个不动', () => {
    spyOutput();
    const audio = makeAudioManager();
    audio.setVolume('sfx', 0.5);
    audio.setMasterVolume(0.2);
    expect(audio.getVolume('sfx')).toBe(0.5);
    expect(audio.getMixPreferences()).toMatchObject({ master: 0.2, sfx: 0.5 });
  });

  it('出厂值：总音量满档，四条通道与改动前逐字一致', () => {
    const audio = makeAudioManager();
    expect(audio.getMixPreferences()).toEqual({ master: 1, bgm: 0.6, sfx: 0.8, ambient: 0.4, voice: 1 });
    expect(AUDIO_MIX_DEFAULTS).toEqual(audio.getMixPreferences());
  });
});

describe('混音偏好落 settings/audio.json、不进存档', () => {
  it('hydrate 读回偏好并立即生效（含总音量写到出口）', async () => {
    const store = new MemoryStore();
    await store.write('settings', 'audio', JSON.stringify({ master: 0.4, bgm: 0.1, sfx: 0.2, ambient: 0.3, voice: 0.9 }));
    __setPersistentStoreForTests(store);
    const out = spyOutput();
    const audio = makeAudioManager();
    await audio.hydrateMixPreferences();
    expect(audio.getMixPreferences()).toEqual({ master: 0.4, bgm: 0.1, sfx: 0.2, ambient: 0.3, voice: 0.9 });
    expect(out).toHaveBeenLastCalledWith(0.4);
  });

  it('拖滑条停手后才落一次盘（节流），写的是完整五个数', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    __setPersistentStoreForTests(store);
    spyOutput();
    const audio = makeAudioManager();
    await audio.hydrateMixPreferences();
    const write = vi.spyOn(store, 'write');
    for (let i = 1; i <= 10; i++) audio.setVolume('bgm', i / 20);
    audio.setMasterVolume(0.7);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(write).toHaveBeenCalledTimes(1);
    const saved = JSON.parse((await store.readAll('settings')).audio);
    expect(saved).toEqual({ master: 0.7, bgm: 0.5, sfx: 0.8, ambient: 0.4, voice: 1 });
  });

  it('destroy 时节流中的那次写立刻兑现，不丢最后一下', async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    __setPersistentStoreForTests(store);
    spyOutput();
    const audio = new AudioManager(new EventBus());
    await audio.hydrateMixPreferences();
    audio.setMasterVolume(0.25);
    audio.destroy();
    await Promise.resolve();
    expect(JSON.parse((await store.readAll('settings')).audio).master).toBe(0.25);
  });

  it('存档里不再带音量；读老档（带四条通道音量）不改玩家偏好', () => {
    spyOutput();
    const audio = makeAudioManager();
    audio.setVolume('bgm', 0.15);
    expect(audio.serialize()).toEqual({});
    audio.deserialize({ bgmVolume: 0.9, sfxVolume: 0, ambientVolume: 1, voiceVolume: 0 });
    expect(audio.getMixPreferences()).toMatchObject({ bgm: 0.15, sfx: 0.8, ambient: 0.4, voice: 1 });
  });
});

describe('偏好文件解析', () => {
  it('只认类型对得上的键；坏值落回出厂、越界钳住；整份坏掉返回 null', () => {
    expect(parseAudioMixPreferences('{"master":"loud","bgm":2,"sfx":-1,"voice":0.5}')).toEqual({
      master: 1, bgm: 1, sfx: 0, ambient: 0.4, voice: 0.5,
    });
    expect(parseAudioMixPreferences('not json')).toBeNull();
    expect(parseAudioMixPreferences('[1,2]')).toBeNull();
  });

  it('序列化键序固定、收 3 位小数', () => {
    expect(serializeAudioMixPreferences({ master: 0.123456, bgm: 0.6, sfx: 0.8, ambient: 0.4, voice: 1 }))
      .toBe('{"master":0.123,"bgm":0.6,"sfx":0.8,"ambient":0.4,"voice":1}');
  });
});
