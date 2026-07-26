import { describe, expect, it, beforeEach } from 'vitest';
import { EventBus } from '../core/EventBus';
import { RulesManager, type RuleNarrativeReader } from './RulesManager';
import { RULE_LAYER_ENTRY_STATE, ruleLayerGraphId } from '../data/ruleGraphNaming';
import type { GameContext } from '../data/types';

/**
 * RulesManager = 叙事状态的只读投影。
 *
 * 本组测试锁住迁移最核心的三件事：
 * 1) 掌握 = 层图 reached 入口版本；可信 = 当前 active 版本没被推翻（两根轴互不干扰）
 * 2) `serialize()` 恒 `{}` —— 规矩状态在叙事存档里，这里没有第二份（否则就是两个真相源）
 * 3) 事件契约不变：叙事状态一变，仍发既有的 rule:layer / rule:acquired
 *    （AudioManager 与 NotificationUI 靠它，换后端不该让它们静默）
 */

/** 可编程的假叙事读取面：记录每张层图 reached 过哪些状态、当前 active 是哪个。 */
class FakeNarrative implements RuleNarrativeReader {
  private active = new Map<string, string>();
  private reached = new Map<string, Set<string>>();

  advance(ruleId: string, layer: string, to: string): void {
    const gid = ruleLayerGraphId(ruleId, layer);
    this.active.set(gid, to);
    const set = this.reached.get(gid) ?? new Set<string>();
    set.add(to);
    this.reached.set(gid, set);
  }

  getActiveState(graphId: string): string | undefined {
    return this.active.get(graphId);
  }

  hasReachedState(graphId: string, stateId: string): boolean {
    return this.reached.get(graphId)?.has(stateId) === true;
  }
}

const RULES_JSON = {
  categories: { ward: '避祸' },
  verifiedLabels: { unverified: '未验证', effective: '有效', questionable: '存疑' },
  rules: [
    {
      id: 'rule_dry',
      name: '干尸才走',
      incompleteName: '关于尸身干湿的某个说法',
      category: 'ward',
      layers: {
        xiang: { text: '干的硬，湿的沉。', verified: 'unverified' },
        li: { text: '白毛是霉，跟凶不搭界。', verified: 'effective' },
      },
      versions: {
        li: [
          { id: '验成', text: '亲眼见了：灭火泼水，它躺回去了。', verified: 'effective' },
          {
            id: '推翻',
            text: '这条从根上就是错的。',
            verified: 'questionable',
            refuted: true,
            supersededText: '白毛是霉，跟凶不搭界。',
          },
        ],
      },
    },
  ],
};

function makeManager(): { rules: RulesManager; narrative: FakeNarrative; events: unknown[] } {
  const eventBus = new EventBus();
  const events: unknown[] = [];
  eventBus.on('rule:layer', (p) => events.push({ type: 'rule:layer', ...(p as object) }));
  eventBus.on('rule:acquired', (p) => events.push({ type: 'rule:acquired', ...(p as object) }));

  const rules = new RulesManager(eventBus);
  rules.init({
    strings: { get: (_c: string, k: string) => k },
    assetManager: { loadJson: async () => RULES_JSON },
  } as unknown as GameContext);
  const narrative = new FakeNarrative();
  return { rules, narrative, events };
}

describe('RulesManager · 叙事状态投影', () => {
  let rules: RulesManager;
  let narrative: FakeNarrative;
  let events: unknown[];

  beforeEach(async () => {
    ({ rules, narrative, events } = makeManager());
    await rules.loadDefs();
    rules.setNarrativeReader(narrative);
  });

  it('没接叙事读取面 / 什么都没推进时，一层都不算掌握', () => {
    expect(rules.isLayerKnown('rule_dry', 'xiang')).toBe(false);
    expect(rules.isRuleDiscovered('rule_dry')).toBe(false);
    expect(rules.isRuleAcquired('rule_dry')).toBe(false);
  });

  it('掌握 = 层图 reached 入口版本', () => {
    narrative.advance('rule_dry', 'xiang', RULE_LAYER_ENTRY_STATE);
    expect(rules.isLayerKnown('rule_dry', 'xiang')).toBe(true);
    expect(rules.isLayerKnown('rule_dry', 'li')).toBe(false);
    expect(rules.isRuleDiscovered('rule_dry')).toBe(true);
    // 两层里只掌握一层 → 还不算完整掌握
    expect(rules.isRuleAcquired('rule_dry')).toBe(false);
    expect(rules.getRuleDepth('rule_dry')).toEqual({ unlocked: 1, total: 2 });
  });

  it('越级授予：直接推到「验成」（跳过未验）也必须算掌握', () => {
    // ⑤ 码头古籍可以先给「理」且直接给到验成，「象」要到 ⑨ 才补——
    // 只看 reached('未验') 会把这一层判成没掌握，那正是阶梯模型被否掉的原因。
    narrative.advance('rule_dry', 'li', '验成');
    expect(rules.isLayerKnown('rule_dry', 'li')).toBe(true);
    expect(rules.isLayerUsable('rule_dry', 'li')).toBe(true);
    expect(rules.getLayerVersion('rule_dry', 'li')).toBe('验成');
    expect(rules.getUnlockedLayerTexts('rule_dry').li).toBe('亲眼见了：灭火泼水，它躺回去了。');
    expect(rules.isRuleDiscovered('rule_dry')).toBe(true);
  });

  it('可信度是另一根轴：推翻不影响掌握，但 usable 会拦住', () => {
    narrative.advance('rule_dry', 'li', RULE_LAYER_ENTRY_STATE);
    expect(rules.isLayerUsable('rule_dry', 'li')).toBe(true);

    narrative.advance('rule_dry', 'li', '推翻');
    // 掌握是单调的——学过就学过了，不会因为被推翻而"忘掉"
    expect(rules.isLayerKnown('rule_dry', 'li')).toBe(true);
    // 但可用性没了
    expect(rules.isLayerUsable('rule_dry', 'li')).toBe(false);
    expect(rules.isLayerRefuted('rule_dry', 'li')).toBe(true);
  });

  it('正文取当前版本，验证态跟着版本走，旧说法可回看', () => {
    narrative.advance('rule_dry', 'li', RULE_LAYER_ENTRY_STATE);
    expect(rules.getUnlockedLayerTexts('rule_dry').li).toBe('白毛是霉，跟凶不搭界。');
    expect(rules.getLayerVerified('rule_dry', 'li')).toBe('effective');

    narrative.advance('rule_dry', 'li', '推翻');
    expect(rules.getUnlockedLayerTexts('rule_dry').li).toBe('这条从根上就是错的。');
    expect(rules.getLayerVerified('rule_dry', 'li')).toBe('questionable');
    expect(rules.getLayerSupersededText('rule_dry', 'li')).toBe('白毛是霉，跟凶不搭界。');
  });

  it('版本没写 text 时回落层定义正文（细化只换写了新说法的那些版本）', () => {
    narrative.advance('rule_dry', 'xiang', RULE_LAYER_ENTRY_STATE);
    expect(rules.getUnlockedLayerTexts('rule_dry').xiang).toBe('干的硬，湿的沉。');
  });

  it('serialize 恒为空 —— 规矩状态只有叙事存档一份', () => {
    narrative.advance('rule_dry', 'xiang', RULE_LAYER_ENTRY_STATE);
    narrative.advance('rule_dry', 'li', '验成');
    expect(rules.serialize()).toEqual({});
  });

  it('叙事状态一变仍发既有事件：逐层 rule:layer + 集齐时 rule:acquired', () => {
    events.length = 0;
    narrative.advance('rule_dry', 'xiang', RULE_LAYER_ENTRY_STATE);
    rules['reprojectAndEmit']();
    expect(events).toEqual([{ type: 'rule:layer', ruleId: 'rule_dry', layer: 'xiang', source: 'grant' }]);

    events.length = 0;
    narrative.advance('rule_dry', 'li', RULE_LAYER_ENTRY_STATE);
    rules['reprojectAndEmit']();
    expect(events).toEqual([
      { type: 'rule:layer', ruleId: 'rule_dry', layer: 'li', source: 'grant' },
      { type: 'rule:acquired', ruleId: 'rule_dry', name: '干尸才走' },
    ]);
  });

  it('同一状态重复投影不重复发事件（读档后不该再弹一次通知）', () => {
    narrative.advance('rule_dry', 'xiang', RULE_LAYER_ENTRY_STATE);
    rules['reprojectAndEmit']();
    events.length = 0;
    rules['reprojectAndEmit']();
    expect(events).toEqual([]);
  });

  it('deserialize 只重建基线：恢复的层不会被当成刚学到再弹一次', () => {
    narrative.advance('rule_dry', 'xiang', RULE_LAYER_ENTRY_STATE);
    narrative.advance('rule_dry', 'li', RULE_LAYER_ENTRY_STATE);
    rules.deserialize({});
    events.length = 0;
    rules['reprojectAndEmit']();
    expect(events).toEqual([]);
  });
});
