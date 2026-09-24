import { describe, expect, it } from 'vitest';
import {
  describeAction,
  describeBurn,
  describeVfx,
  effectName,
  humanizeId,
  shortGist,
  spokenEffectName,
  spokenName,
  type SenseHelpers,
} from './worldSenses';

const h: SenseHelpers = {
  entityName: (id) => ({ ghost: '白衣女人', stall: '纸扎摊' } as Record<string, string>)[id] ?? null,
  entityPos: (id) => (id === 'ghost' ? { x: 10, y: 20 } : null),
  isOwnActor: (id) => id.startsWith('jev_'),
  playerLabel: '关二狗',
  soundWord: (id) => (id === 'sfx_thunder_near' ? '头顶上炸开一声响雷' : null),
};

describe('音效与没有中文名的效果：不把英文素材名塞给模型', () => {
  it('音效按事件说法表说；表里没有的只说"一阵响动"', () => {
    expect(describeAction('playSfx', { id: 'sfx_thunder_near' }, h)?.text).toBe('头顶上炸开一声响雷');
    expect(describeAction('playSfx', { id: 'sfx_storm_brew' }, h)?.text).toBe('传来一阵响动');
    expect(describeAction('playSfx', { id: 'sfx_storm_brew' }, h)?.text).not.toMatch(/[a-z]/i);
  });

  it('效果没有中文 label：给模型看的名字为 null（不退回英文 id）', () => {
    expect(spokenEffectName(null)).toBeNull();
    expect(spokenEffectName('雷云：压在头顶的一片厚云')).toBe('雷云');
  });
});

describe('describeAction（按引擎动作类型描述，不认技能）', () => {
  it('天色 / 闪光 / 震动 / 风 / 雷：全街都感觉得到', () => {
    expect(describeAction('setSceneDim', { scale: 0.3 }, h)).toMatchObject({ global: true, text: expect.stringContaining('黑') });
    expect(describeAction('setSceneDim', { scale: 1 }, h)?.text).toContain('亮开');
    expect(describeAction('screenFlash', {}, h)?.global).toBe(true);
    expect(describeAction('cameraShake', { amplitude: 8 }, h)?.text).toContain('震');
    expect(describeAction('cameraShake', { amplitude: 0 }, h)).toBeNull();
    expect(describeAction('sceneWindGust', { speedMultiplier: 3.4 }, h)?.text).toContain('狂风');
    expect(describeAction('strikeThreat', {}, h)?.text).toContain('雷');
  });

  it('有人喊话 / 实体出现消失：带名字与位置；世界脑自己的人不算', () => {
    expect(describeAction('showSpeechBubble', { target: 'ghost', text: '还我命来' }, h))
      .toMatchObject({ text: '白衣女人喊了一句：「还我命来」', at: { x: 10, y: 20 }, global: false });
    expect(describeAction('showSpeechBubble', { target: 'jev_noodle', text: '牛肉面' }, h)).toBeNull();
    expect(describeAction('setEntityEnabled', { target: 'stall', enabled: false }, h)?.text).toBe('纸扎摊不见了');
  });

  it('街上看不见的动作（存档 / 叙事 / 数值）一律不报', () => {
    for (const t of ['setFlag', 'giveItem', 'emitSignal', 'addArchiveEntry', 'runActionsDetached']) {
      expect(describeAction(t, {}, h), t).toBeNull();
    }
  });
});

describe('资产名 → 说法', () => {
  it('粒子效果取 label 冒号前的名字、去掉编号；没 label 用 id 兜底', () => {
    expect(effectName('天雷 01：介质击穿模型离线烘成贴图', 'lightning_bolt_01')).toBe('天雷');
    expect(effectName('雷云：压在头顶的一片厚云（符纸雷击 / 变天）', 'storm_clouds')).toBe('雷云');
    expect(effectName(null, 'storm_rain')).toBe('storm rain');
    expect(humanizeId('sfx_thunder_crack')).toBe('thunder crack');
    expect(describeVfx('start', '天雷', '十字口')).toBe('十字口那边出现了天雷');
    expect(describeVfx('stop', '雨', null)).toBe('雨散了');
  });

  it('街上的人嘴里的短名：按动作类型 / 资产名给，作者备注的括号不念出来，太长的退成"动静"', () => {
    expect(describeAction('screenFlash', {}, h)?.gist).toBe('白光');
    expect(describeAction('showSpeechBubble', { target: 'player', text: '哈' }, h)).toMatchObject({ gist: '一嗓子', byPlayer: true });
    expect(describeAction('setEntityEnabled', { target: 'stall', enabled: true }, h)?.gist).toBe('纸扎摊');
    expect(spokenName('桃木剑（占位图标美术）')).toBe('桃木剑');
    expect(shortGist('雷符')).toBe('雷符');
    expect(shortGist('一张很长很长的说明文字当名字')).toBe('动静');
  });

  it('燃烧三态', () => {
    expect(describeBurn('burning', '纸扎摊')).toContain('烧起来');
    expect(describeBurn('burnt', '纸扎摊')).toContain('灰');
    expect(describeBurn('unburnt', '纸扎摊')).toBeNull();
  });
});
