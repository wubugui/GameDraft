import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { SystemNoteManager } from './SystemNoteManager';
import type { SystemNoteDef } from '../data/types';

const NOTE: SystemNoteDef = { id: 'three_fires', title: '三把火', body: 'x', loreEntryId: 'lore_three_fires' };

function make(): { m: SystemNoteManager; flags: FlagStore; bus: EventBus } {
  const bus = new EventBus();
  const flags = new FlagStore(bus);
  const m = new SystemNoteManager(bus, flags);
  const assetManager = { loadJson: vi.fn(async () => ({ notes: [NOTE] })) };
  m.init({ eventBus: bus, flagStore: flags, strings: { get: (_c: string, k: string) => k } as never, assetManager: assetManager as never });
  return { m, flags, bus };
}

describe('SystemNoteManager（K4 系统说明卡）', () => {
  it('关卡即落 flag sysnote_<id>，每档只自动弹一次；force 重弹', async () => {
    const { m, flags } = make();
    await m.loadDefs();
    const opener = vi.fn(async () => {});
    m.setOpener(opener);

    await m.show('three_fires');
    expect(opener).toHaveBeenCalledTimes(1);
    expect(flags.get('sysnote_three_fires')).toBe(true);
    expect(m.hasShown('three_fires')).toBe(true);

    await m.show('three_fires');
    expect(opener).toHaveBeenCalledTimes(1);

    await m.show('three_fires', true);
    expect(opener).toHaveBeenCalledTimes(2);
  });

  it('未知 id / 未注入开卡函数：warn 并立即 resolve，不落 flag', async () => {
    const { m, flags } = make();
    await m.loadDefs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await m.show('nope');
    await m.show('three_fires');
    expect(flags.get('sysnote_three_fires')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('卡开着时读档 / 销毁：旧时间线不写 flag', async () => {
    const { m, flags } = make();
    await m.loadDefs();
    let release: () => void = () => {};
    m.setOpener(() => new Promise<void>((r) => { release = r; }));
    const p = m.show('three_fires');
    m.deserialize({});
    release();
    await p;
    expect(flags.get('sysnote_three_fires')).toBeUndefined();

    const p2 = m.show('three_fires');
    m.destroy();
    release();
    await p2;
    expect(flags.get('sysnote_three_fires')).toBeUndefined();
  });

  it('同屏只许一张：在场时再次 show 直接返回', async () => {
    const { m } = make();
    await m.loadDefs();
    let release: () => void = () => {};
    const opener = vi.fn(() => new Promise<void>((r) => { release = r; }));
    m.setOpener(opener);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = m.show('three_fires');
    await m.show('three_fires', true);
    expect(opener).toHaveBeenCalledTimes(1);
    release();
    await p;
    warn.mockRestore();
  });
});
