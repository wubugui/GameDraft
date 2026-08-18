import { describe, expect, it, vi } from 'vitest';
import { VoiceChannel, parseVoiceSpec, parseVoiceAdvanceSpec } from './VoiceChannel';
import type { AudioPlaybackHandle, TransientSfxOptions } from '../data/types';

/**
 * 配音通道：一条配音的寿命可以长于说它那一拍。
 * 三条语义各锁一组——默认跟拍停 / hold 留声 / 被后续拍接管后跟那拍停。
 */

function makePlayer() {
  const ends = new Map<string, () => void>();
  const stopped: string[] = [];
  const played: { id: string; volume?: number }[] = [];
  const player = {
    playVoice(id: string, options?: TransientSfxOptions): AudioPlaybackHandle | null {
      if (id === '__unknown__') return null;
      played.push({ id, volume: options?.volume });
      if (options?.onEnd) ends.set(id, options.onEnd);
      return { stop: () => { stopped.push(id); ends.delete(id); } };
    },
  };
  /** 模拟这条配音自然播完 */
  const finish = (id: string) => { const cb = ends.get(id); ends.delete(id); cb?.(); };
  return { player, finish, stopped, played, ends };
}

describe('parseVoiceSpec', () => {
  it('字符串即 id；对象认 id / sfxId', () => {
    expect(parseVoiceSpec('v1')).toEqual({ id: 'v1' });
    expect(parseVoiceSpec({ id: ' v2 ' })).toEqual({ id: 'v2' });
    expect(parseVoiceSpec({ sfxId: 'v3' })).toEqual({ id: 'v3' });
  });

  it('空 / 无 id / 非对象一律 null（这一拍就是没配音）', () => {
    expect(parseVoiceSpec('   ')).toBeNull();
    expect(parseVoiceSpec({ volume: 0.5 })).toBeNull();
    expect(parseVoiceSpec(42)).toBeNull();
    expect(parseVoiceSpec(null)).toBeNull();
  });

  it('volume 为 null / 空串时不当 0——Number(null)===0 会把"没写"解释成静音', () => {
    expect(parseVoiceSpec({ id: 'v', volume: null })).toEqual({ id: 'v' });
    expect(parseVoiceSpec({ id: 'v', volume: '' })).toEqual({ id: 'v' });
    expect(parseVoiceSpec({ id: 'v', volume: 0 })).toEqual({ id: 'v', volume: 0 });
  });

  it('hold 只认真布尔 true', () => {
    expect(parseVoiceSpec({ id: 'v', hold: true })).toEqual({ id: 'v', hold: true });
    expect(parseVoiceSpec({ id: 'v', hold: 'true' })).toEqual({ id: 'v' });
    expect(parseVoiceSpec({ id: 'v', hold: 1 })).toEqual({ id: 'v' });
  });
});

describe('parseVoiceAdvanceSpec', () => {
  it('"voice" / 正数 / 其余=等点击', () => {
    expect(parseVoiceAdvanceSpec('voice')).toEqual({ mode: 'voice' });
    expect(parseVoiceAdvanceSpec(3000)).toEqual({ mode: 'timer', ms: 3000 });
    expect(parseVoiceAdvanceSpec(0)).toBeNull();
    expect(parseVoiceAdvanceSpec(-1)).toBeNull();
    expect(parseVoiceAdvanceSpec('3000')).toBeNull();
    expect(parseVoiceAdvanceSpec(undefined)).toBeNull();
  });
});

describe('VoiceChannel', () => {
  it('默认跟本拍结束即停', () => {
    const { player, stopped } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    const t = ch.play({ id: 'v1' })!;
    expect(t).not.toBeNull();
    t.endBeat();
    expect(stopped).toEqual(['v1']);
  });

  it('hold 的配音本拍结束不停，可被后续拍接管，并跟接管那拍一起停', () => {
    const { player, stopped } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    const first = ch.play({ id: 'long', hold: true })!;
    first.endBeat();
    expect(stopped).toEqual([]);          // 短字幕过去了，配音还在念
    expect(ch.hasSustainedVoice()).toBe(true);

    const taken = ch.takeSustained()!;
    expect(taken).not.toBeNull();
    expect(ch.hasSustainedVoice()).toBe(false);  // 已有主人
    taken.endBeat();
    expect(stopped).toEqual(['long']);    // 跟接管它的那一拍一起结束
  });

  it('没有留声可接管时 takeSustained 返回 null（调用方退化为等点击）', () => {
    const { player } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    expect(ch.takeSustained()).toBeNull();
    const t = ch.play({ id: 'v1' })!;     // 跟拍的那条不算留声
    expect(ch.takeSustained()).toBeNull();
    t.endBeat();
  });

  it('留声的配音自然播完后不再可接管', () => {
    const { player, finish } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    ch.play({ id: 'long', hold: true })!.endBeat();
    finish('long');
    expect(ch.hasSustainedVoice()).toBe(false);
    expect(ch.takeSustained()).toBeNull();
  });

  it('单声道：起新配音先停掉在播的那条（含留声的）', () => {
    const { player, stopped } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    ch.play({ id: 'a', hold: true })!.endBeat();
    ch.play({ id: 'b' });
    expect(stopped).toEqual(['a']);
  });

  it('onEnd 只在自然播完时回调；手动停不触发（"跟随配音推进"据此退化为等点击）', () => {
    const { player, finish } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    const onEnd = vi.fn();
    const t = ch.play({ id: 'v' })!;
    t.onEnd(onEnd);
    t.endBeat();
    expect(onEnd).not.toHaveBeenCalled();
    finish('v');                          // 已被停掉：不该再有回调
    expect(onEnd).not.toHaveBeenCalled();

    const t2 = ch.play({ id: 'w' })!;
    t2.onEnd(onEnd);
    finish('w');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('已播完再订阅 onEnd 立即同步回调（arming 窗口里播完的情况）', () => {
    const { player, finish } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    const t = ch.play({ id: 'v' })!;
    finish('v');
    const onEnd = vi.fn();
    t.onEnd(onEnd);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('onSettled 在任何收场都恰好回调一次（等待方据此封口，绝不悬挂）', () => {
    const { player, finish } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);

    const settledA = vi.fn();
    ch.play({ id: 'a' })!.onSettled(settledA);
    ch.play({ id: 'b' });                 // 被顶掉也算收场
    expect(settledA).toHaveBeenCalledTimes(1);

    const settledB = vi.fn();
    const tb = ch.play({ id: 'c' })!;
    tb.onSettled(settledB);
    finish('c');
    expect(settledB).toHaveBeenCalledTimes(1);

    const settledC = vi.fn();
    const tc = ch.play({ id: 'd' })!;
    tc.onSettled(settledC);
    ch.stopAll();
    expect(settledC).toHaveBeenCalledTimes(1);
  });

  it('未知 id / 没有音频系统 → play 返回 null，调用方安全退化', () => {
    const { player } = makePlayer();
    const bare = new VoiceChannel();
    expect(bare.play({ id: 'v' })).toBeNull();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    expect(ch.play({ id: '__unknown__' })).toBeNull();
  });

  it('volume 原样传给音频系统；不写则不传', () => {
    const { player, played } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    ch.play({ id: 'a', volume: 0.5 });
    ch.play({ id: 'b' });
    expect(played).toEqual([{ id: 'a', volume: 0.5 }, { id: 'b', volume: undefined }]);
  });

  it('被新配音顶掉后，旧票据的 endBeat 不误停新配音', () => {
    const { player, stopped } = makePlayer();
    const ch = new VoiceChannel();
    ch.setAudioPlayer(player);
    const old = ch.play({ id: 'a' })!;
    ch.play({ id: 'b' });
    stopped.length = 0;
    old.endBeat();
    expect(stopped).toEqual([]);
  });
});
