import { describe, it, expect } from 'vitest';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { SmellSystem } from './SmellSystem';

function make(): { s: SmellSystem; flags: FlagStore; bus: EventBus; player: { x: number; y: number }; scene: { id: string } } {
  const bus = new EventBus();
  const flags = new FlagStore(bus);
  const s = new SmellSystem(bus, flags);
  const player = { x: 0, y: 0 };
  const scene = { id: '街' };
  s.setPlayerPositionGetter(() => player);
  s.setSceneIdGetter(() => scene.id);
  s.init({ eventBus: bus, flagStore: flags, strings: { get: (_c: string, k: string) => k } as never, assetManager: {} as never });
  return { s, flags, bus, player, scene };
}

describe('SmellSystem 飘向 = 气味源的反方向（G.6）', () => {
  it('没放源就是直的；放了源后源在左 → 往右飘、源在右 → 往左飘、到跟前归零', () => {
    const { s, player } = make();
    s.setSmell('baozi', 60);
    s.update(0.016);
    expect(s.getDir()).toBe(0);
    s.setSource(100, 0);
    player.x = 260; // 源在左 160px
    s.update(0.016);
    expect(s.getDir()).toBeCloseTo(0.5, 2);
    player.x = -220; // 源在右 320px → 歪到底
    s.update(0.016);
    expect(s.getDir()).toBe(-1);
    player.x = 100;
    s.update(0.016);
    expect(s.getDir()).toBe(0);
  });

  it('追踪关了一直直的；开回来立刻恢复；flag 同步', () => {
    const { s, flags, player } = make();
    s.setSmell('yin', 60);
    s.setSource(0, 0);
    player.x = 320;
    s.update(0.016);
    expect(s.getDir()).toBe(1);
    s.setTracking(false);
    expect(s.getDir()).toBe(0);
    expect(flags.get('smell_tracking')).toBe(false);
    expect(flags.get('current_smell_dir')).toBe(0);
    s.setTracking(true);
    expect(s.getDir()).toBe(1);
  });

  it('动作源只在它所属场景生效；无味时也不歪', () => {
    const { s, player, scene } = make();
    s.setSmell('yin', 60);
    s.setSource(0, 0, '崖墓');
    player.x = 320;
    s.update(0.016);
    expect(s.getDir()).toBe(0);
    scene.id = '崖墓';
    s.update(0.016);
    expect(s.getDir()).toBe(1);
    s.clearSmell();
    expect(s.getDir()).toBe(0);
  });

  it('zone 气味自带源：进区带上、出区撤回；动作源压过 zone 源', () => {
    const { s, bus, player } = make();
    player.x = 500;
    bus.emit('zone:enter', { zoneId: 'z1', zone: { id: 'z1', smell: { scent: 'baozi', intensity: 50, source: { x: 300, y: 0 } } } });
    s.update(0.016);
    expect(s.getScent()).toBe('baozi');
    expect(s.getDir()).toBeCloseTo(0.625, 3);
    s.setSource(900, 0); // 动作源在右边 400px → 往左歪到底
    s.update(0.016);
    expect(s.getDir()).toBe(-1);
    s.clearSource();
    s.update(0.016);
    expect(s.getDir()).toBeCloseTo(0.625, 3);
    bus.emit('zone:exit', { zoneId: 'z1' });
    s.update(0.016);
    expect(s.getScent()).toBe('');
    expect(s.getDir()).toBe(0);
  });

  it('序列化带上源与追踪开关；旧档无字段按缺省（无源、追踪开）', () => {
    const { s } = make();
    s.setSmell('corpse', 70);
    s.setSource(10, 20, '义庄');
    s.setTracking(false);
    const data = s.serialize() as { source: { scene: string; x: number; y: number } | null; tracking: boolean };
    expect(data.source).toEqual({ scene: '义庄', x: 10, y: 20 });
    expect(data.tracking).toBe(false);
    const t = make();
    t.s.deserialize(data);
    expect(t.s.getActionSource()).toEqual({ scene: '义庄', x: 10, y: 20 });
    expect(t.s.isTracking()).toBe(false);
    const u = make();
    u.s.deserialize({ action: { scent: 'yin', intensity: 30, dir: 0.5, flicker: false } });
    expect(u.s.getActionSource()).toBeNull();
    expect(u.s.isTracking()).toBe(true);
    expect(u.s.getScent()).toBe('yin');
  });
});
