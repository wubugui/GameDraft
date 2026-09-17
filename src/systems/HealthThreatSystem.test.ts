import { describe, expect, it, vi } from 'vitest';
import type { HealthThreatDef } from '../data/survival';
import { HealthThreatSystem, validThreat } from './HealthThreatSystem';

const ghost: HealthThreatDef = { id: 'caller', kind: 'yin', boundaryRadius: 300, damageRadius: 200, attackPerSecond: 5,
  nearRadius: 40, nearAttackPerSecond: 400, enteredSignal: 'entered', repelledSignal: 'repelled', leftSignal: 'left' };
function setup(def = ghost) {
  const state = { night: true, fire: false, running: true, x: 150, enabled: true, presentation: false };
  const damage = vi.fn(), signal = vi.fn(), hud = vi.fn(), sound = vi.fn();
  const system = new HealthThreatSystem();
  system.connect({ canUpdate: () => state.running, isNight: () => state.night,
    isPresentation: () => state.presentation,
    playerPosition: () => ({ x: state.x, y: 0 }), hasFireProtection: () => state.fire,
    damage, signal, setYinSources: hud, playSound: sound });
  system.setSources([{ def, position: () => ({ x: 0, y: 0 }), active: () => state.enabled }]);
  return { system, state, damage, signal, hud, sound };
}

describe('鬼物实体侵袭', () => {
  it('跟脚声按游戏时钟在行进后方发声，停步/暂停/火光驱退不补播', () => {
    const h = setup({ ...ghost, presenceSfx: 'steps', soundOnlyMoving: true, soundBehindPlayer: 60, soundInterval: .8, soundVolume: .6 });
    h.system.update(.2);
    expect(h.sound).not.toHaveBeenCalled();
    h.state.x += 10; h.system.update(.2);
    expect(h.sound).toHaveBeenLastCalledWith('steps', { x: 100, y: 0 }, .6);
    h.state.running = false; h.system.update(100);
    h.state.running = true; h.state.fire = true; h.state.x += 10; h.system.update(1);
    expect(h.sound).toHaveBeenCalledTimes(1);
    h.state.fire = false; h.state.x -= 10; h.system.update(.2);
    expect(h.sound).toHaveBeenLastCalledWith('steps', { x: 220, y: 0 }, .6);
    h.system.clear(); h.system.update(1);
    expect(h.sound).toHaveBeenCalledTimes(2);
  });
  it('普通威胁在演出里暂停且不补发进出；显式教学来源可继续实际损耗', () => {
    const ordinary = setup();
    ordinary.system.update(1);
    ordinary.state.presentation = true;
    ordinary.system.update(30);
    expect(ordinary.damage).toHaveBeenCalledTimes(1);
    expect(ordinary.signal).toHaveBeenCalledTimes(1);
    expect(ordinary.hud).toHaveBeenLastCalledWith(['caller']);
    ordinary.state.presentation = false;
    ordinary.system.update(1);
    expect(ordinary.damage).toHaveBeenCalledTimes(2);
    expect(ordinary.signal).toHaveBeenCalledTimes(1);
    const teaching = setup({ ...ghost, duringPresentation: true });
    teaching.state.presentation = true;
    teaching.system.update(2);
    expect(teaching.damage).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 10 }));
  });
  it('黑暗本身不扣血；离开具体实体范围就不再损耗', () => {
    const h = setup(); h.state.x = 500; h.system.update(1);
    expect(h.damage).not.toHaveBeenCalled();
    h.state.x = 150; h.system.update(1);
    expect(h.damage).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 5, sourceId: 'caller' }));
    h.state.x = 500; h.system.update(1);
    expect(h.damage).toHaveBeenCalledTimes(1);
    expect(h.signal).toHaveBeenLastCalledWith('left', 'caller');
    expect(h.hud).toHaveBeenLastCalledWith([]);
  });

  it('普通鬼物被火光确定驱退；重进黑暗才重新进入，不逐帧重发', () => {
    const h = setup(); h.state.fire = true; h.system.update(1);
    expect(h.damage).not.toHaveBeenCalled(); expect(h.signal).not.toHaveBeenCalled();
    h.state.fire = false; h.system.update(1); h.system.update(1);
    expect(h.signal).toHaveBeenCalledTimes(1);
    h.state.fire = true; h.system.update(1); h.system.update(1);
    expect(h.signal).toHaveBeenLastCalledWith('repelled', 'caller');
    expect(h.damage).toHaveBeenCalledTimes(2);
    expect(h.hud).toHaveBeenLastCalledWith([]);
  });

  it('近身强化仍按每秒数值结算；暂停、白天或禁用不扣', () => {
    const h = setup(); h.state.x = 20; h.system.update(0.1);
    expect(h.damage).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 40 }));
    h.state.running = false; h.system.update(100);
    h.state.running = true; h.state.night = false; h.system.update(100);
    h.state.night = true; h.state.enabled = false; h.system.update(100);
    expect(h.damage).toHaveBeenCalledTimes(1);
  });

  it('特殊不怕火由内容显式声明；普通蝙蝠侵扰不请求阴界三火显隐', () => {
    const h = setup({ ...ghost, kind: 'fright', fireResponse: 'ignore', nightOnly: false });
    h.state.fire = true; h.state.night = false; h.system.update(1);
    expect(h.damage).toHaveBeenCalledTimes(1);
    expect(h.hud).not.toHaveBeenCalledWith(['caller']);
  });

  it('读档清空旧场景来源，不继续伤害或补发离开事件', () => {
    const h = setup(); h.system.update(1); h.damage.mockClear(); h.signal.mockClear();
    h.system.deserialize({}); h.system.update(1);
    expect(h.damage).not.toHaveBeenCalled(); expect(h.signal).not.toHaveBeenCalled();
    expect(h.hud).toHaveBeenLastCalledWith([]);
  });

  it('错误的半径关系与非有限攻击力拒绝激活', () => {
    expect(validThreat({ ...ghost, damageRadius: 301 })).toBe(false);
    expect(validThreat({ ...ghost, nearRadius: 201 })).toBe(false);
    expect(validThreat({ ...ghost, attackPerSecond: NaN })).toBe(false);
  });
});
