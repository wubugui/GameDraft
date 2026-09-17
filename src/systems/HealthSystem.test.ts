import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { GameContext } from '../data/types';
import type { HealthProtection } from '../data/survival';
import { HealthSystem } from './HealthSystem';

function setup() {
  const events = new EventBus();
  const flags = new FlagStore(events);
  const execute = vi.fn(async () => {});
  const health = new HealthSystem(events, flags, { executeBatchAwait: execute } as unknown as ActionExecutor);
  health.init({} as GameContext);
  return { health, events, flags, execute };
}
const hit = (amount: number) => ({ amount, kind: 'yin' as const, sourceId: 'ghost' });

describe('三把火统一伤害与成长', () => {
  it('普通耗尽只发一次死亡，不自动播放阿秀系绳', async () => {
    const { health, events, execute } = setup();
    const dead = vi.fn(); events.on('player:depleted', dead);
    await Promise.all([health.applyDamage(hit(120)), health.applyDamage(hit(120))]);
    expect(health.getHealth()).toBe(0);
    expect(health.isDepleted()).toBe(true);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('成长提高上限但不隐含回血；相同鬼物强者可承受', async () => {
    const { health } = setup();
    health.setBaseMaxHealth(500);
    expect(health.getHealth()).toBe(100);
    health.heal(400);
    await health.applyDamage(hit(120));
    expect(health.getHealth()).toBe(380);
    expect(health.isDepleted()).toBe(false);
  });

  it('防护按类别和来源匹配，重复同一物品不叠加，多来源乘剩余伤害', async () => {
    const { health } = setup();
    health.setProtectionProvider(() => [
      { id: 'amulet', reduction: 0.5, kinds: ['yin'] },
      { id: 'amulet', reduction: 0.5 },
      { id: 'specific', reduction: 0.5, threatIds: ['ghost'] },
      { id: 'wrong-source', reduction: 1, threatIds: ['another-ghost'] },
      { id: 'animal', reduction: 1, kinds: ['fright'] },
    ]);
    const result = await health.applyDamage(hit(40));
    expect(result.protectionIds).toEqual(['amulet', 'specific']);
    expect(result.applied).toBe(10);
    expect(health.getHealth()).toBe(90);
  });

  it('小额连续损耗与一次同总量结算一致，不逐帧取整', async () => {
    const a = setup().health, b = setup().health;
    for (const h of [a, b]) h.setProtectionProvider(() => [{ id: 'charm', reduction: 0.3 }]);
    await a.applyDamage(hit(10));
    for (let i = 0; i < 600; i++) await b.applyDamage(hit(10 / 600));
    expect(b.getHealth()).toBeCloseTo(a.getHealth(), 8);
  });

  it('获得／失去上限物品不凭空回血，卸下后不超过上限', () => {
    const { health } = setup();
    let protections: HealthProtection[] = [{ id: 'belt', maxHealthBonus: 50 }];
    health.setProtectionProvider(() => protections);
    expect(health.getMaxHealth()).toBe(150);
    expect(health.getHealth()).toBe(100);
    health.heal(50);
    protections = []; health.refreshProtection();
    expect(health.getHealth()).toBe(100);
    expect(health.getBaseMaxHealth()).toBe(100);
  });
});

describe('编排上下限与时间线', () => {
  it('显式系绳也必须满足剧情资格；没有帕子包时不能提前冒出冷信号', async () => {
    const { health, execute } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await health.tether();
      expect(execute).not.toHaveBeenCalled();
      expect(health.getHealth()).toBe(100);
      health.setTetherAllowed(() => true);
      await health.tether();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(health.getHealth()).toBe(60);
    } finally { warn.mockRestore(); }
  });
  it('主动防护按游戏时间到期；同名刷新不叠乘，读档不重置剩余时间', async () => {
    const { health } = setup();
    health.applyProtection({ id: 'charm', reduction: 0.5, kinds: ['yin'] }, 10);
    health.update(4);
    const saved = health.serialize();
    health.deserialize(saved);
    await health.applyDamage(hit(20));
    expect(health.getHealth()).toBe(90);
    health.applyProtection({ id: 'charm', reduction: 0.5 }, 5);
    await health.applyDamage(hit(20));
    expect(health.getHealth()).toBe(80);
    health.update(5);
    await health.applyDamage(hit(20));
    expect(health.getHealth()).toBe(60);
  });

  it('教学最低保护承受致死攻击，释放后能正常死亡', async () => {
    const { health } = setup();
    expect(health.setBounds({ id: 'tutorial', min: 25 })).toBe(true);
    await health.applyDamage(hit(10000));
    expect(health.getHealth()).toBe(25);
    expect(health.isDepleted()).toBe(false);
    health.clearBounds('tutorial');
    await health.applyDamage(hit(10000));
    expect(health.isDepleted()).toBe(true);
  });

  it('限制取交集、冲突拒绝；同句柄可替换；永久上限不变', () => {
    const { health } = setup();
    expect(health.setBounds({ id: 'a', min: 30 })).toBe(true);
    expect(health.setBounds({ id: 'b', max: 60 })).toBe(true);
    expect(health.setBounds({ id: 'bad', max: 20 })).toBe(false);
    health.setHealth(10); expect(health.getHealth()).toBe(30);
    health.setHealth(90); expect(health.getHealth()).toBe(60);
    expect(health.setBounds({ id: 'a', min: 40, max: 40 })).toBe(true);
    expect(health.getHealth()).toBe(40);
    expect(health.getMaxHealth()).toBe(100);
  });

  it('场景限制清除不误清显式持久限制；存档往返不重播伤害', () => {
    const { health, events } = setup();
    health.setBounds({ id: 'scene', min: 20 });
    health.setBounds({ id: 'persistent', max: 80, scope: 'persistent' });
    const save = health.serialize();
    const damage = vi.fn(); events.on('player:damaged', damage);
    health.deserialize(save);
    expect(health.serialize()).toEqual(save);
    health.clearSceneBounds();
    health.setHealth(5); expect(health.getHealth()).toBe(5);
    health.setHealth(100); expect(health.getHealth()).toBe(80);
    expect(damage).not.toHaveBeenCalled();
  });

  it('拒绝非有限值，旧档没有新字段也能恢复', async () => {
    const { health } = setup();
    health.deserialize({ currentHealth: 45, maxHealth: 120 });
    expect(health.getBaseMaxHealth()).toBe(120);
    expect(health.getHealth()).toBe(45);
    expect(health.setBounds({ id: 'bad', min: NaN })).toBe(false);
    await health.applyDamage(hit(Infinity));
    health.heal(NaN);
    expect(health.getHealth()).toBe(45);
    health.deserialize({ currentHealth: NaN, maxHealth: -2 });
    expect(health.getHealth()).toBe(100);
  });

  it('系绳必须获准；执行中读档后不能把旧时间线的回血写回', async () => {
    const { health, execute } = setup();
    let finish!: () => void;
    execute.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    health.setTetherAllowed(() => true);
    const inFlight = health.applyDamage(hit(200));
    expect(execute).toHaveBeenCalledTimes(1);
    health.deserialize({ currentHealth: 33, maxHealth: 100 });
    finish(); await inFlight;
    expect(health.getHealth()).toBe(33);
    expect(health.isDepleted()).toBe(false);
  });
});
