import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { AudioManager } from '../systems/AudioManager';
import { MenuUI } from './MenuUI';
import config from '../../public/assets/data/audio_config.json';

afterEach(() => vi.restoreAllMocks());

function setup(persistent = true, promptResult: string | null = '上跑马梁之前') {
  const eventBus = new EventBus();
  const audio = new AudioManager(eventBus);
  const internalAudio = audio as any;
  internalAudio.config = config;
  internalAudio.installSystemSfxListeners();
  const played = vi.spyOn(audio, 'playSfx').mockImplementation(() => {});
  let finish!: (ok: boolean) => void;
  const pending = new Promise<boolean>((resolve) => { finish = resolve; });
  // 保留真实的菜单提交逻辑、事件总线和音效映射，只替换写盘与绘制边界。
  const menu = Object.assign(Object.create(MenuUI.prototype), {
    eventBus,
    saveData: {
      save: vi.fn(() => pending),
      isPersistent: () => persistent,
      hasSave: () => false,
    },
    strings: { get: (_section: string, key: string) => key },
    build: vi.fn(),
    // 起名输入框是 DOM 模态：这里只替换它的结果（确定 = 名字，取消 = null）
    promptSaveName: vi.fn(() => Promise.resolve(promptResult)),
  });
  const notifications: any[] = [];
  eventBus.on('notification:show', (p) => notifications.push(p));
  return { menu, audio, played, eventBus, notifications, finish };
}

describe('存档完成音效接线', () => {
  it('写盘完成前不发声，成功后仅播放 save_done', async () => {
    const { menu, played, notifications, finish } = setup();
    menu.commitSlot('save', 0);
    await Promise.resolve();
    // 起的名字跟着这一次存档一起写
    expect(menu.saveData.save).toHaveBeenCalledWith(0, { name: '上跑马梁之前' });
    expect(played).not.toHaveBeenCalled();
    finish(true);
    await Promise.resolve();
    expect(played.mock.calls).toEqual([['save_done', undefined]]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('info');
  });

  it.each([{ ok: false, persistent: true }, { ok: true, persistent: false }])(
    '失败或临时内存存档不播放成功音：%j', async ({ ok, persistent }) => {
      const { menu, played, notifications, finish } = setup(persistent);
      menu.commitSlot('save', 0);
      await Promise.resolve();
      finish(ok);
      await Promise.resolve();
      expect(played.mock.calls).toEqual([['ui_notification', undefined]]);
      expect(notifications[0].type).toBe('error');
    },
  );

  it('起名输入框里点取消 = 这次不存：不写盘、不发声、不提示', async () => {
    const { menu, played, notifications } = setup(true, null);
    menu.commitSlot('save', 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(menu.saveData.save).not.toHaveBeenCalled();
    expect(played).not.toHaveBeenCalled();
    expect(notifications).toHaveLength(0);
  });

  it('普通通知仍保留通知音，销毁后不残留存档监听', () => {
    const { audio, played, eventBus } = setup();
    eventBus.emit('notification:show', { text: '普通提示', type: 'info' });
    expect(played.mock.calls).toEqual([['ui_notification', undefined]]);
    played.mockClear();
    audio.destroy();
    eventBus.emit('save:completed', { slot: 0 });
    expect(played).not.toHaveBeenCalled();
  });
});
