import { describe, expect, it, vi } from 'vitest';
import { DialogueVoiceDirector } from './DialogueVoiceDirector';
import { VoiceChannel } from './VoiceChannel';
import { EventBus } from '../core/EventBus';
import type { AudioPlaybackHandle, DialogueLine, TransientSfxOptions } from '../data/types';

/**
 * 世界对话（脚本台词 + 图对话）的配音：两条通道都只发 dialogue:line，
 * 故配音语义天然等价，且与过场字幕同一套（默认跟行停 / hold 跨行留声 / 接管者收尾）。
 */

function makeRig() {
  const ends = new Map<string, () => void>();
  const stopped: string[] = [];
  const played: string[] = [];
  const audio = {
    playVoice(id: string, options?: TransientSfxOptions): AudioPlaybackHandle | null {
      played.push(id);
      if (options?.onEnd) ends.set(id, options.onEnd);
      return { stop: () => { stopped.push(id); ends.delete(id); } };
    },
  };
  const finish = (id: string) => { const cb = ends.get(id); ends.delete(id); cb?.(); };
  const bus = new EventBus();
  const channel = new VoiceChannel();
  channel.setAudioPlayer(audio);
  const director = new DialogueVoiceDirector(bus, channel);
  director.init();
  const autoAdvances = vi.fn();
  bus.on('dialogue:autoAdvance', autoAdvances);
  return { bus, channel, director, finish, stopped, played, autoAdvances };
}

const LINE = (text: string, extra: Partial<DialogueLine> = {}): DialogueLine =>
  ({ speaker: '旁白', text, tags: [], ...extra });

describe('DialogueVoiceDirector', () => {
  it('抓帧冻结保留当前台词计时剩余量，嵌套 lease 最后释放后才继续', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    const rig = makeRig();
    try {
      rig.bus.emit('dialogue:line', LINE('这句停 2 秒', { autoAdvance: 2000 }));
      vi.advanceTimersByTime(500);
      const release = rig.director.suspendForCapture();
      const releaseNested = rig.director.suspendForCapture();
      vi.advanceTimersByTime(120_000);
      release(); release();
      vi.advanceTimersByTime(120_000);
      expect(rig.autoAdvances).not.toHaveBeenCalled();
      releaseNested();
      vi.advanceTimersByTime(1499);
      expect(rig.autoAdvances).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(rig.autoAdvances).toHaveBeenCalledTimes(1);
    } finally { rig.director.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('抓帧冻结暂存自然配音结束；换行/销毁时丢弃过期的推进', () => {
    const rig = makeRig();
    rig.bus.emit('dialogue:line', LINE('第一句', { voice: 'a', autoAdvance: 'voice' }));
    const release = rig.director.suspendForCapture();
    rig.finish('a');
    expect(rig.autoAdvances).not.toHaveBeenCalled();
    rig.bus.emit('dialogue:line', LINE('第二句', { voice: 'b', autoAdvance: 'voice' }));
    release();
    expect(rig.autoAdvances).not.toHaveBeenCalled();
    const releaseNext = rig.director.suspendForCapture();
    rig.finish('b');
    expect(rig.autoAdvances).not.toHaveBeenCalled();
    releaseNext(); releaseNext();
    expect(rig.autoAdvances).toHaveBeenCalledTimes(1);
    rig.bus.emit('dialogue:line', LINE('第三句', { voice: 'c', autoAdvance: 'voice' }));
    const releaseDestroyed = rig.director.suspendForCapture();
    rig.finish('c');
    rig.director.destroy();
    releaseDestroyed();
    expect(rig.autoAdvances).toHaveBeenCalledTimes(1);
  });

  it('每行配音跟本行一起结束（换行即停）', () => {
    const rig = makeRig();
    rig.bus.emit('dialogue:line', LINE('第一句', { voice: 'a' }));
    rig.bus.emit('dialogue:line', LINE('第二句'));
    expect(rig.played).toEqual(['a']);
    expect(rig.stopped).toEqual(['a']);
  });

  it('对话结束也停（没勾 hold 的一律不留尾音）', () => {
    const rig = makeRig();
    rig.bus.emit('dialogue:line', LINE('唯一一句', { voice: 'a' }));
    rig.bus.emit('dialogue:end', { source: 'scripted' });
    expect(rig.stopped).toEqual(['a']);
  });

  it('hold 的配音跨行留声，由后面声明「跟随配音」的那行接管并收尾', () => {
    const rig = makeRig();
    rig.bus.emit('dialogue:line', LINE('起头这句短', { voice: { id: 'long', hold: true } }));
    rig.bus.emit('dialogue:line', LINE('这句跟着配音走', { autoAdvance: 'voice' }));
    expect(rig.played).toEqual(['long']);   // 没重播
    expect(rig.stopped).toEqual([]);
    rig.finish('long');
    expect(rig.autoAdvances).toHaveBeenCalledTimes(1);
  });

  it('autoAdvance:"voice" 在配音自然播完时发 dialogue:autoAdvance', () => {
    const rig = makeRig();
    rig.bus.emit('dialogue:line', LINE('有配音', { voice: 'a', autoAdvance: 'voice' }));
    expect(rig.autoAdvances).not.toHaveBeenCalled();
    rig.finish('a');
    expect(rig.autoAdvances).toHaveBeenCalledTimes(1);
  });

  it('玩家抢先点走后，晚到的配音结束不再补推进', () => {
    const rig = makeRig();
    rig.bus.emit('dialogue:line', LINE('第一句', { voice: 'a', autoAdvance: 'voice' }));
    rig.bus.emit('dialogue:line', LINE('第二句'));   // 玩家点了，换行
    rig.finish('a');
    expect(rig.autoAdvances).not.toHaveBeenCalled();
  });

  it('autoAdvance 为毫秒数时到点推进；换行会撤掉未到点的定时器', () => {
    vi.useFakeTimers();
    try {
      const rig = makeRig();
      rig.bus.emit('dialogue:line', LINE('这句停 2 秒', { autoAdvance: 2000 }));
      vi.advanceTimersByTime(1999);
      expect(rig.autoAdvances).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(rig.autoAdvances).toHaveBeenCalledTimes(1);

      rig.bus.emit('dialogue:line', LINE('这句也停 2 秒', { autoAdvance: 2000 }));
      rig.bus.emit('dialogue:line', LINE('但被点走了'));
      vi.advanceTimersByTime(5000);
      expect(rig.autoAdvances).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('读档：任何在播人声（含留声）立即闭嘴', () => {
    const rig = makeRig();
    rig.bus.emit('dialogue:line', LINE('起头', { voice: { id: 'long', hold: true } }));
    rig.bus.emit('save:restoring', {});
    expect(rig.stopped).toEqual(['long']);
  });

  it('destroy 后不再响应任何对话事件（生命周期对称）', () => {
    const rig = makeRig();
    rig.director.destroy();
    rig.bus.emit('dialogue:line', LINE('还有声吗', { voice: 'a' }));
    expect(rig.played).toEqual([]);
  });
});
