import { describe, expect, it } from 'vitest';
import type { HealthThreatDef } from '../data/survival';
import { HealthThreatSystem, type HealthThreatSource } from './HealthThreatSystem';

function threat(id: string, over: Partial<HealthThreatDef> = {}): HealthThreatDef {
  return { id, kind: 'yin', boundaryRadius: 300, damageRadius: 200, attackPerSecond: 3, ...over };
}

function setup(
  sources: { def: HealthThreatDef; x: number; active?: boolean }[],
  world: { night?: boolean; fire?: boolean } = {},
) {
  const state = { night: world.night ?? true, fire: world.fire ?? false };
  const system = new HealthThreatSystem();
  system.connect({
    canUpdate: () => true, isNight: () => state.night,
    playerPosition: () => ({ x: 0, y: 0 }), hasFireProtection: () => state.fire,
    damage: () => {}, signal: () => {}, setYinSources: () => {},
  });
  system.setSources(sources.map<HealthThreatSource>((s) => ({
    def: s.def,
    position: () => ({ x: s.x, y: 0 }),
    active: () => s.active !== false,
  })));
  return { system, state };
}

describe('符纸选靶（pickTarget）', () => {
  it('缺省按最凶的挑，不是按最近的', () => {
    const h = setup([
      { def: threat('近的弱鬼', { attackPerSecond: 1 }), x: 50 },
      { def: threat('远的凶鬼', { attackPerSecond: 9 }), x: 400 },
    ]);
    expect(h.system.pickTarget({ x: 0, y: 0 })?.id).toBe('远的凶鬼');
    expect(h.system.pickTarget({ x: 0, y: 0 }, { rank: 'distance' })?.id).toBe('近的弱鬼');
  });

  it('"凶" 取近身档的峰值攻击力，不是常规档', () => {
    const h = setup([
      { def: threat('常规高', { attackPerSecond: 8 }), x: 100 },
      { def: threat('近身秒杀', { attackPerSecond: 2, nearRadius: 40, nearAttackPerSecond: 1000 }), x: 200 },
    ]);
    const pick = h.system.pickTarget({ x: 0, y: 0 });
    expect(pick?.id).toBe('近身秒杀');
    expect(pick?.threatLevel).toBe(1000);
  });

  it('并列时用另一项决胜，不看作者写的先后次序', () => {
    const sameThreat = setup([
      { def: threat('远', { attackPerSecond: 5 }), x: 300 },
      { def: threat('近', { attackPerSecond: 5 }), x: 60 },
    ]);
    expect(sameThreat.system.pickTarget({ x: 0, y: 0 })?.id).toBe('近');

    const sameDistance = setup([
      { def: threat('弱', { attackPerSecond: 1 }), x: 100 },
      { def: threat('凶', { attackPerSecond: 7 }), x: -100 },
    ]);
    expect(sameDistance.system.pickTarget({ x: 0, y: 0 }, { rank: 'distance' })?.id).toBe('凶');
  });

  /**
   * 这条是这套选靶存在的理由：readings 里的 attackPerSecond 是"此刻正在造成的伤害"，
   * 玩家手上有火时普通鬼一律 repelled、那个值恒为 0。夜里举着火把用符是**最典型**的用法，
   * 按那个口径排就一个靶都挑不出来。
   */
  it('玩家举着火把（鬼被逼退）时照样挑得出靶', () => {
    const h = setup([{ def: threat('被火逼退的鬼'), x: 120 }], { fire: true });
    h.system.update(0.5);
    expect(h.system.snapshot()).toMatchObject({ sources: [{ state: 'repelled', attackPerSecond: 0 }] });
    expect(h.system.pickTarget({ x: 0, y: 0 })?.id).toBe('被火逼退的鬼');
  });

  it('不在场的、白天的夜行鬼都不是靶', () => {
    const off = setup([{ def: threat('已经收掉的'), x: 100, active: false }]);
    expect(off.system.pickTarget({ x: 0, y: 0 })).toBeNull();

    const daytime = setup([{ def: threat('夜行鬼'), x: 100 }], { night: false });
    expect(daytime.system.pickTarget({ x: 0, y: 0 })).toBeNull();

    // nightOnly: false 的鬼白天也算（雾津街头那位就是这么配的）
    const allDay = setup([{ def: threat('白天也在', { nightOnly: false }), x: 100 }], { night: false });
    expect(allDay.system.pickTarget({ x: 0, y: 0 })?.id).toBe('白天也在');
  });

  it('maxDistance 之外的挑不到', () => {
    const h = setup([{ def: threat('太远了'), x: 900 }]);
    expect(h.system.pickTarget({ x: 0, y: 0 }, { maxDistance: 500 })).toBeNull();
    expect(h.system.pickTarget({ x: 0, y: 0 }, { maxDistance: 1000 })?.id).toBe('太远了');
    expect(h.system.pickTarget({ x: 0, y: 0 })?.id).toBe('太远了');   // 不给 = 不限
  });

  it('一个鬼都没有时返回 null（由动作层决定改劈随机点还是什么都不做）', () => {
    expect(setup([]).system.pickTarget({ x: 0, y: 0 })).toBeNull();
  });

  it('返回靶子此刻的位置与距离，供雷落在它头上', () => {
    const h = setup([{ def: threat('鬼'), x: -240 }]);
    expect(h.system.pickTarget({ x: 0, y: 0 })).toMatchObject({ x: -240, y: 0, distance: 240 });
  });
});

describe('连劈时每道雷各挑各的靶', () => {
  /**
   * 2026-09-20 制作人报"几道雷都打在同一个地方"。根因是开头选一次靶、整条链复用。
   * 现在每道雷重走一遍规则，并把本链里劈过的排除掉——否则：
   *  · `removeTarget: true` 那条靠 `active()` 碰巧能排除（劈完鬼就没了）；
   *  · `removeTarget: false`（只演不收）那条会把三道雷全砸在同一个鬼头上。
   */
  it('排除掉的靶子不再被挑中，顺位让给下一个', () => {
    const h = setup([
      { def: threat('最凶', { attackPerSecond: 9 }), x: 400 },
      { def: threat('次凶', { attackPerSecond: 5 }), x: 200 },
      { def: threat('最弱', { attackPerSecond: 1 }), x: 50 },
    ]);
    const struck = new Set<string>();
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const hit = h.system.pickTarget({ x: 0, y: 0 }, { exclude: struck });
      if (!hit) break;
      picked.push(hit.id);
      struck.add(hit.id);
    }
    expect(picked).toEqual(['最凶', '次凶', '最弱']);   // 第四道挑不到，链就该停
  });

  it('不传 exclude 时行为一字不变（普通单道雷不受影响）', () => {
    const h = setup([
      { def: threat('凶', { attackPerSecond: 9 }), x: 400 },
      { def: threat('弱', { attackPerSecond: 1 }), x: 50 },
    ]);
    expect(h.system.pickTarget({ x: 0, y: 0 })?.id).toBe('凶');
    expect(h.system.pickTarget({ x: 0, y: 0 }, { exclude: new Set<string>() })?.id).toBe('凶');
  });
});
