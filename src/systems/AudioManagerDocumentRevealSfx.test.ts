import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { AudioManager } from './AudioManager';

/**
 * 文档揭示音效的「逐条覆盖全局」契约：
 * document_reveals.json 里配了 revealSfx 的条目自带声音（由 DocumentRevealManager
 * 与叠化同起播放），此时不得再叠一层全局 systemSfx.documentReveal。
 */
function makeAudioManager(): { audio: AudioManager; eventBus: EventBus; played: string[] } {
  const eventBus = new EventBus();
  const audio = new AudioManager(eventBus);
  audio.init({ assetManager: { loadJson: vi.fn() } } as never);
  const played: string[] = [];
  // playSystemSfx 是私有实现细节，这里只观测「有没有被要求播全局音」
  (audio as unknown as { playSystemSfx: (k: string) => void }).playSystemSfx =
    (key: string) => { played.push(key); };
  return { audio, eventBus, played };
}

describe('AudioManager 文档揭示音效', () => {
  it('条目没自带音效时播全局默认揭示音', () => {
    const { eventBus, played } = makeAudioManager();
    eventBus.emit('document:revealed', { documentId: 'doc', customSfx: false });
    expect(played).toEqual(['documentReveal']);
  });

  it('条目自带 revealSfx 时不播全局默认揭示音（避免双响）', () => {
    const { eventBus, played } = makeAudioManager();
    eventBus.emit('document:revealed', { documentId: 'doc', customSfx: true });
    expect(played).toEqual([]);
  });

  it('旧形状 payload（无 customSfx）仍按全局默认音处理', () => {
    const { eventBus, played } = makeAudioManager();
    eventBus.emit('document:revealed', { documentId: 'doc' });
    expect(played).toEqual(['documentReveal']);
  });
});
