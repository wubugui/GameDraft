import { describe, expect, it, beforeEach, vi } from 'vitest';
import { BubbleChatterSystem, bubbleSpeakerFromActionTarget, type BubbleChatterDeps } from './BubbleChatterSystem';
import { DeterministicRandom } from '../utils/deterministicRandom';
import { FlagStore } from '../core/FlagStore';
import { EventBus } from '../core/EventBus';
import type { GameContext, IEmoteBubbleAnchor } from '../data/types';

const anchorA: IEmoteBubbleAnchor = { getDisplayObject: () => ({}), getEmoteBubbleAnchorLocalY: () => -10 };
const anchorB: IEmoteBubbleAnchor = { getDisplayObject: () => ({}), getEmoteBubbleAnchorLocalY: () => -10 };

interface Harness {
  sys: BubbleChatterSystem;
  said: { text: string; duration: number; anchor: IEmoteBubbleAnchor }[];
  state: {
    exploring: boolean;
    scene: string;
    player: { x: number; y: number };
    positions: Record<string, { x: number; y: number }>;
    /** 角色 id → 当前场景里代表他的那个摆放（缺席=这场没他） */
    characterPlacements: Record<string, string | null>;
    activeBubbles: number;
    bubbleOn: Set<IEmoteBubbleAnchor>;
  };
  /** 推进 n 秒（按 1/60 步进，贴近真实 tick） */
  tick: (seconds: number) => void;
  /** 只推进一帧——验"说了几句"必须用它，tick(1) 是 60 帧，零冷却下会说 60 句 */
  step: () => void;
}

function makeHarness(overrides: Partial<BubbleChatterDeps> = {}): Harness {
  const said: { text: string; duration: number; anchor: IEmoteBubbleAnchor }[] = [];
  const state = {
    exploring: true,
    scene: 'teahouse',
    player: { x: 0, y: 0 },
    positions: { npc_a: { x: 10, y: 0 }, npc_b: { x: 20, y: 0 } } as Record<string, { x: number; y: number }>,
    /** 角色 id → 当前场景里代表他的那个摆放（null=这场没他） */
    characterPlacements: { clara: 'npc_a' } as Record<string, string | null>,
    activeBubbles: 0,
    bubbleOn: new Set<IEmoteBubbleAnchor>(),
  };
  const deps: BubbleChatterDeps = {
    emoteBubbleManager: {
      show: (a: IEmoteBubbleAnchor, text: string, duration: number) => { said.push({ text, duration, anchor: a }); },
      activeBubbleCount: () => state.activeBubbles,
      hasBubbleFor: (a: IEmoteBubbleAnchor) => state.bubbleOn.has(a),
    } as never,
    resolveEmoteTarget: (id) => (id === 'npc_a' ? anchorA : id === 'npc_b' ? anchorB : id === 'player' ? anchorA : null),
    isSpeakerVisible: () => true,
    resolveCharacterEntityId: (cid) => state.characterPlacements[cid] ?? null,
    resolveSpeakerPosition: (id) => (id === 'player' ? state.player : state.positions[id] ?? null),
    playerPosition: () => state.player,
    currentSceneId: () => state.scene,
    isExploring: () => state.exploring,
    resolveRichText: (raw) => raw.replace('[tag:player]', '关二狗'),
    random: new DeterministicRandom('bubble-test'),
    ...overrides,
  };
  const sys = new BubbleChatterSystem(deps);
  sys.init({} as GameContext);
  return {
    sys,
    said,
    state,
    tick: (seconds: number) => {
      const steps = Math.round(seconds * 60);
      for (let i = 0; i < steps; i++) sys.update(1 / 60);
    },
    step: () => sys.update(1 / 60),
  };
}

const ONE_SET = {
  lineSets: [{
    id: 'set_a',
    speaker: { kind: 'entity', id: 'npc_a' },
    lines: [{ text: '一句话' }],
  }],
};

describe('BubbleChatterSystem 基本调度', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('日程隐藏的居民不会隔空说话，回来后实体档和角色档都能恢复', () => {
    let visible = false;
    for (const speaker of [{ kind: 'entity', id: 'npc_a' }, { kind: 'character', characterId: 'clara' }]) {
      visible = false;
      const world = makeHarness({ isSpeakerVisible: () => visible });
      world.sys.applyDefs({ lineSets: [{ ...ONE_SET.lineSets[0], speaker }] });
      world.tick(30);
      expect(world.said).toHaveLength(0);
      visible = true;
      world.step();
      expect(world.said).toHaveLength(1);
    }
  });

  it('Exploring 态才说话', () => {
    h.sys.applyDefs(ONE_SET);
    h.state.exploring = false;
    h.tick(30);
    expect(h.said).toHaveLength(0);
    h.state.exploring = true;
    h.tick(1);
    expect(h.said).toHaveLength(1);
  });

  it('文本经 resolveRichText（[tag:…] 与色标记同等待遇）', () => {
    h.sys.applyDefs({ lineSets: [{ ...ONE_SET.lineSets[0], lines: [{ text: '我是[tag:player]' }] }] });
    h.tick(1);
    expect(h.said[0].text).toBe('我是关二狗');
  });

  it('本组冷却期内不重复说', () => {
    // 只验"本组冷却"，所以把全局/逐人间隔关掉，免得实际生效的是别的闸
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
      lineSets: [{ ...ONE_SET.lineSets[0], cooldownMs: 10000 }],
    });
    h.step();
    expect(h.said).toHaveLength(1);
    h.tick(5);
    expect(h.said).toHaveLength(1);
    h.tick(6);
    expect(h.said).toHaveLength(2);
  });

  it('全局最小间隔挡住不同组连说', () => {
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 5000, perSpeakerMinIntervalMs: 0 },
      lineSets: [
        { id: 'a', speaker: { kind: 'entity', id: 'npc_a' }, cooldownMs: 0, lines: [{ text: 'A' }] },
        { id: 'b', speaker: { kind: 'entity', id: 'npc_b' }, cooldownMs: 0, lines: [{ text: 'B' }] },
      ],
    });
    h.tick(1);
    expect(h.said).toHaveLength(1);
    h.tick(3);
    expect(h.said).toHaveLength(1);
    h.tick(3);
    expect(h.said).toHaveLength(2);
  });

  it('同屏气泡到上限就不说', () => {
    h.sys.applyDefs({ tuning: { maxConcurrent: 1 }, lineSets: ONE_SET.lineSets });
    h.state.activeBubbles = 1;
    h.tick(30);
    expect(h.said).toHaveLength(0);
    h.state.activeBubbles = 0;
    h.tick(1);
    expect(h.said).toHaveLength(1);
  });

  it('导演式气泡占着这个头就整组跳过', () => {
    h.sys.applyDefs(ONE_SET);
    h.state.bubbleOn.add(anchorA);
    h.tick(30);
    expect(h.said).toHaveLength(0);
    h.state.bubbleOn.delete(anchorA);
    h.tick(1);
    expect(h.said).toHaveLength(1);
  });

  it('限定场景之外不说', () => {
    h.sys.applyDefs({ lineSets: [{ ...ONE_SET.lineSets[0], scenes: ['teahouse'] }] });
    h.state.scene = '雾津街头';
    h.tick(30);
    expect(h.said).toHaveLength(0);
    h.state.scene = 'teahouse';
    h.tick(1);
    expect(h.said).toHaveLength(1);
  });

  it('离玩家太远不说（audibleRange）', () => {
    h.sys.applyDefs({ tuning: { audibleRange: 100 }, lineSets: ONE_SET.lineSets });
    h.state.positions.npc_a = { x: 5000, y: 0 };
    h.tick(30);
    expect(h.said).toHaveLength(0);
    h.state.positions.npc_a = { x: 10, y: 0 };
    h.tick(1);
    expect(h.said).toHaveLength(1);
  });

  it('解析不到说话人就静默（不抛）', () => {
    h.sys.applyDefs({ lineSets: [{ id: 'x', speaker: { kind: 'entity', id: '查无此人' }, lines: [{ text: 'X' }] }] });
    expect(() => h.tick(30)).not.toThrow();
    expect(h.said).toHaveLength(0);
  });
});

describe('BubbleChatterSystem approach 触发', () => {
  it('只在踏进半径那一下触发，站着不动不会一直念', () => {
    const h = makeHarness();
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
      lineSets: [{
        id: 'near', speaker: { kind: 'entity', id: 'npc_a' },
        trigger: 'approach', approachRange: 50, cooldownMs: 0,
        lines: [{ text: '走近了' }],
      }],
    });
    h.state.positions.npc_a = { x: 500, y: 0 };
    h.tick(2);
    expect(h.said).toHaveLength(0);

    h.state.positions.npc_a = { x: 10, y: 0 };   // 踏进半径
    h.tick(0.1);
    expect(h.said).toHaveLength(1);
    h.tick(5);                                   // 站着不动
    expect(h.said).toHaveLength(1);

    h.state.positions.npc_a = { x: 500, y: 0 };  // 走远
    h.tick(0.5);
    h.state.positions.npc_a = { x: 10, y: 0 };   // 再走近 → 再触发
    h.tick(0.1);
    expect(h.said).toHaveLength(2);
  });
});

describe('BubbleChatterSystem approach 边沿闩存（复审 P2-5）', () => {
  it('走近那一下撞上全局冷却窗口，冷却过后仍会说（不是被吃掉）', () => {
    const h = makeHarness();
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 4000, perSpeakerMinIntervalMs: 0 },
      lineSets: [
        { id: 'amb', speaker: { kind: 'entity', id: 'npc_b' }, cooldownMs: 100000, lines: [{ text: '别人先念叨' }] },
        { id: 'near', speaker: { kind: 'entity', id: 'npc_a' }, trigger: 'approach',
          approachRange: 50, cooldownMs: 0, lines: [{ text: '走近了' }] },
      ],
    });
    h.state.positions.npc_a = { x: 500, y: 0 };
    h.step();                                  // 别人先说一句，globalNextAt 推到 +4s
    expect(h.said.map((s) => s.text)).toEqual(['别人先念叨']);

    h.state.positions.npc_a = { x: 10, y: 0 }; // 冷却窗口里走近
    h.tick(1);
    expect(h.said).toHaveLength(1);            // 这会儿确实还不能说
    h.tick(3.5);                               // 全局冷却过去
    expect(h.said.map((s) => s.text)).toEqual(['别人先念叨', '走近了']);
  });

  it('走近后又走出去，那次「走近」作废（不会隔半天补一句）', () => {
    const h = makeHarness();
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 4000, perSpeakerMinIntervalMs: 0 },
      lineSets: [
        { id: 'amb', speaker: { kind: 'entity', id: 'npc_b' }, cooldownMs: 100000, lines: [{ text: 'A' }] },
        { id: 'near', speaker: { kind: 'entity', id: 'npc_a' }, trigger: 'approach',
          approachRange: 50, cooldownMs: 0, lines: [{ text: '走近了' }] },
      ],
    });
    h.state.positions.npc_a = { x: 500, y: 0 };
    h.step();
    h.state.positions.npc_a = { x: 10, y: 0 };
    h.tick(0.5);
    h.state.positions.npc_a = { x: 500, y: 0 };   // 冷却还没过就走开了
    h.tick(4);
    expect(h.said.map((s) => s.text)).toEqual(['A']);
  });
});

describe('BubbleChatterSystem 边沿播种（复审 P3-1）', () => {
  const NEAR = {
    tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
    lineSets: [{
      id: 'near', speaker: { kind: 'entity', id: 'npc_a' }, trigger: 'approach',
      approachRange: 100, cooldownMs: 0, lines: [{ text: '走近了' }],
    }],
  };

  it('玩家本来就站在半径里：读档后一步没动，不许凭空冒一句', () => {
    const h = makeHarness();
    h.state.positions.npc_a = { x: 40, y: 0 };   // 已经在半径内
    h.sys.applyDefs(NEAR);
    h.sys.deserialize({});
    h.tick(20);
    expect(h.said).toHaveLength(0);
  });

  it('播种之后再真的走出去、走回来，照常触发', () => {
    const h = makeHarness();
    h.state.positions.npc_a = { x: 40, y: 0 };
    h.sys.applyDefs(NEAR);
    h.sys.deserialize({});
    h.tick(1);
    expect(h.said).toHaveLength(0);
    h.state.positions.npc_a = { x: 500, y: 0 };
    h.tick(0.5);
    h.state.positions.npc_a = { x: 40, y: 0 };
    h.tick(0.5);
    expect(h.said.map((s) => s.text)).toEqual(['走近了']);
  });

  it('切场景后同样先播种（新场景出生点就在某人半径里也不冒）', () => {
    const h = makeHarness();
    h.state.positions.npc_a = { x: 500, y: 0 };
    h.sys.applyDefs(NEAR);
    h.tick(1);
    h.state.scene = '雾津街头';                    // 换场景
    h.state.positions.npc_a = { x: 40, y: 0 };     // 新场景里同 id 的人就在身边
    h.tick(20);
    expect(h.said).toHaveLength(0);
  });
});

describe('BubbleChatterSystem 条件与挑句', () => {
  it('没接条件上下文时带条件的组一律不说（fail-safe）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    h.sys.applyDefs({ lineSets: [{ ...ONE_SET.lineSets[0], when: { flag: 'x' } }] });
    h.tick(30);
    expect(h.said).toHaveLength(0);
    warn.mockRestore();
  });

  it('条件为假不说、为真说', () => {
    const h = makeHarness();
    const flagStore = new FlagStore(new EventBus());
    h.sys.setConditionEvalContextFactory(() => ({
      flagStore,
      questManager: { getStatus: () => 0 } as never,
      scenarioState: {} as never,
    }));
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
      lineSets: [{ ...ONE_SET.lineSets[0], when: { flag: '门开了' } }],
    });
    h.tick(10);
    expect(h.said).toHaveLength(0);
    flagStore.set('门开了', true);
    h.step();
    expect(h.said).toHaveLength(1);
  });

  it('sequence 按顺序循环', () => {
    const h = makeHarness();
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
      lineSets: [{
        id: 'seq', speaker: { kind: 'entity', id: 'npc_a' }, pickMode: 'sequence', cooldownMs: 0,
        lines: [{ text: '甲' }, { text: '乙' }, { text: '丙' }],
      }],
    });
    h.step();
    h.step();
    h.step();
    h.step();
    expect(h.said.map((s) => s.text)).toEqual(['甲', '乙', '丙', '甲']);
  });

  it('once 行说过就不再说；整组没得说时不再参选', () => {
    const h = makeHarness();
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
      lineSets: [{
        id: 'one', speaker: { kind: 'entity', id: 'npc_a' }, cooldownMs: 0,
        lines: [{ text: '只此一次', once: true }],
      }],
    });
    h.tick(1);
    expect(h.said).toHaveLength(1);
    h.tick(30);
    expect(h.said).toHaveLength(1);
  });
});

describe('BubbleChatterSystem 运行时换本子与存档', () => {
  const TWO = {
    tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
    lineSets: [
      { id: 'normal', speaker: { kind: 'entity', id: 'npc_a' }, cooldownMs: 0, lines: [{ text: '平时' }] },
      { id: 'after', speaker: { kind: 'entity', id: 'npc_a' }, cooldownMs: 0, lines: [{ text: '出事之后' }] },
      { id: 'other', speaker: { kind: 'entity', id: 'npc_b' }, cooldownMs: 0, lines: [{ text: '别人' }] },
    ],
  };

  it('setBubbleLineSet 把这人切到指定本子，其它本子不再参选', () => {
    const h = makeHarness();
    h.sys.applyDefs(TWO);
    expect(h.sys.setLineSetFor({ kind: 'entity', id: 'npc_a' }, 'after')).toBe(true);
    h.step();
    expect(h.said.map((s) => s.text)).toEqual(['出事之后']);
  });

  it('本子的 speaker 与目标对不上时拒绝套用（不让台词从错的人嘴里冒出来）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    h.sys.applyDefs(TWO);
    expect(h.sys.setLineSetFor({ kind: 'entity', id: 'npc_a' }, 'other')).toBe(false);
    warn.mockRestore();
  });

  it('clearLineSetFor(silence) 让这人彻底闭嘴，普通 clear 回落原状', () => {
    const h = makeHarness();
    h.sys.applyDefs(TWO);
    h.sys.clearLineSetFor({ kind: 'entity', id: 'npc_a' }, true);
    h.tick(5);
    expect(h.said.some((s) => s.text === '平时')).toBe(false);
    h.sys.clearLineSetFor({ kind: 'entity', id: 'npc_a' });
    h.step();
    expect(h.said.some((s) => s.text === '平时')).toBe(true);
  });

  it('存档只存 id 与进度，不存文本；读档后覆盖与 once 记录仍在', () => {
    const h = makeHarness();
    h.sys.applyDefs(TWO);
    h.sys.setLineSetFor({ kind: 'entity', id: 'npc_a' }, 'after');
    const saved = h.sys.serialize() as Record<string, unknown>;
    expect(JSON.stringify(saved)).not.toContain('出事之后');
    expect(saved.overrides).toEqual({ 'entity:npc_a': 'after' });

    const h2 = makeHarness();
    h2.sys.applyDefs(TWO);
    h2.sys.deserialize(saved);
    h2.tick(5);          // 读档后要等过全局最小间隔
    expect(h2.said[0].text).toBe('出事之后');
  });

  it('读档时台词本已被删：丢弃这条覆盖，回落到 JSON 匹配（不是整个人哑掉）', () => {
    const h = makeHarness();
    h.sys.applyDefs({ ...TWO, lineSets: TWO.lineSets.filter((s) => s.id !== 'after') });
    h.sys.deserialize({ overrides: { 'entity:npc_a': 'after' } });
    h.step();
    expect(h.said.map((s) => s.text)).toEqual(['平时']);
  });

  it('读档后不会立刻喷一串气泡（冷却按全局最小间隔重来）', () => {
    const h = makeHarness();
    h.sys.applyDefs({ tuning: { globalMinIntervalMs: 4000 }, lineSets: TWO.lineSets });
    h.sys.deserialize({});
    h.tick(1);
    expect(h.said).toHaveLength(0);
    h.tick(4);
    expect(h.said).toHaveLength(1);
  });
});

describe('BubbleChatterSystem 数据容错', () => {
  it('缺 id / 缺 speaker / 无台词的组被跳过，不影响其余', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    h.sys.applyDefs({
      lineSets: [
        { speaker: { kind: 'entity', id: 'npc_a' }, lines: [{ text: 'x' }] },        // 无 id
        { id: 'no_speaker', lines: [{ text: 'x' }] },                                 // 无 speaker
        { id: 'empty', speaker: { kind: 'entity', id: 'npc_a' }, lines: [] },          // 无台词
        { id: 'ok', speaker: { kind: 'entity', id: 'npc_a' }, lines: [{ text: '好的' }] },
      ] as never,
    });
    h.tick(1);
    expect(h.said.map((s) => s.text)).toEqual(['好的']);
    warn.mockRestore();
  });

  it('文件不存在（null）时整个特性静默关闭', () => {
    const h = makeHarness();
    h.sys.applyDefs(null);
    expect(() => h.tick(60)).not.toThrow();
    expect(h.said).toHaveLength(0);
  });

  it('destroy 后不再说话', () => {
    const h = makeHarness();
    h.sys.applyDefs(ONE_SET);
    h.sys.destroy();
    h.tick(60);
    expect(h.said).toHaveLength(0);
  });
});

describe('说话人三档（player / character / entity）', () => {
  it('角色档：落到当前场景里代表该角色的那个摆放', () => {
    const h = makeHarness();
    h.state.characterPlacements = { clara: 'npc_b' };
    h.sys.applyDefs({
      lineSets: [{
        id: 'set_clara',
        speaker: { kind: 'character', characterId: 'clara' },
        lines: [{ text: '克拉拉的口头禅' }],
      }],
    });
    h.tick(1);
    expect(h.said.map((s) => s.text)).toEqual(['克拉拉的口头禅']);
  });

  it('角色档：这场没有他的摆放就整组不说话（不是报错）', () => {
    const h = makeHarness();
    h.state.characterPlacements = {};
    h.sys.applyDefs({
      lineSets: [{
        id: 'set_clara',
        speaker: { kind: 'character', characterId: 'clara' },
        lines: [{ text: '不该出现' }],
      }],
    });
    h.tick(60);
    expect(h.said).toHaveLength(0);
  });

  it('角色档：换场景后同一组台词落到另一个摆放头上', () => {
    const h = makeHarness();
    h.state.characterPlacements = { clara: 'npc_a' };
    h.sys.applyDefs({
      tuning: { globalMinIntervalMs: 0, perSpeakerMinIntervalMs: 0 },
      lineSets: [{
        id: 'set_clara',
        speaker: { kind: 'character', characterId: 'clara' },
        cooldownMs: 0,
        lines: [{ text: '同一句' }],
      }],
    });
    h.step();
    expect(h.said.map((s) => s.anchor)).toEqual([anchorA]);

    // 换场景：同一个角色由另一个摆放代表 → 气泡跟着换头，台词本一个字没改
    h.state.scene = 'street';
    h.state.characterPlacements = { clara: 'npc_b' };
    h.step();
    expect(h.said.map((s) => s.anchor)).toEqual([anchorA, anchorB]);
  });

  it('角色档与实体档的逐人冷却互不串台（说话人键不同）', () => {
    const h = makeHarness();
    h.state.characterPlacements = { clara: 'npc_a' };
    h.sys.applyDefs({
      lineSets: [
        {
          id: 'as_character', priority: 1, cooldownMs: 0,
          speaker: { kind: 'character', characterId: 'clara' }, lines: [{ text: '角色档' }],
        },
        {
          id: 'as_entity', priority: 0, cooldownMs: 0,
          speaker: { kind: 'entity', id: 'npc_a' }, lines: [{ text: '实体档' }],
        },
      ],
    });
    // 两组指向同一个人，但说话人键不同：实体档不会被角色档的 perSpeaker 冷却压住
    h.step();
    expect(h.said.map((s) => s.text)).toEqual(['角色档']);
    h.tick(5);
    expect(h.said.map((s) => s.text)).toEqual(['角色档', '实体档']);
  });

  it('character 缺 characterId 的条目被跳过；未知 kind 但有 id 仍按实体读（宽容读法）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    h.sys.applyDefs({
      lineSets: [
        { id: 'bad_char', speaker: { kind: 'character' }, lines: [{ text: '不该出现' }] },
        { id: 'legacy', speaker: { id: 'npc_a' }, lines: [{ text: '老写法仍然读得出' }] },
      ] as never,
    });
    h.tick(1);
    expect(h.said.map((s) => s.text)).toEqual(['老写法仍然读得出']);
    warn.mockRestore();
  });
});

describe('bubbleSpeakerFromActionTarget（动作 target 串 → 说话人）', () => {
  it('三种形状各归各档', () => {
    expect(bubbleSpeakerFromActionTarget('player')).toEqual({ kind: 'player' });
    expect(bubbleSpeakerFromActionTarget('character:clara'))
      .toEqual({ kind: 'character', characterId: 'clara' });
    expect(bubbleSpeakerFromActionTarget('npc_a')).toEqual({ kind: 'entity', id: 'npc_a' });
  });

  it('前缀后面是空的时候不当角色档（否则会静默变成"谁都不是"）', () => {
    expect(bubbleSpeakerFromActionTarget('character:')).toEqual({ kind: 'entity', id: 'character:' });
  });

  it('setBubbleLineSet 能套用到角色档台词本（speaker 键两侧算得一致）', () => {
    const h = makeHarness();
    h.state.characterPlacements = { clara: 'npc_a' };
    h.sys.applyDefs({
      lineSets: [{
        id: 'clara_alt',
        speaker: { kind: 'character', characterId: 'clara' },
        lines: [{ text: '换过的词' }],
      }],
    });
    expect(h.sys.setLineSetFor(bubbleSpeakerFromActionTarget('character:clara'), 'clara_alt')).toBe(true);
    h.tick(1);
    expect(h.said.map((s) => s.text)).toEqual(['换过的词']);
  });
});
