import { describe, expect, it } from 'vitest';
import {
  bubbleDurationMs,
  buildReplyOptions,
  buildSayOptions,
  fillLine,
  NO_SLOTS,
  pickLine,
  type ReplyContext,
} from './speech';
import { parseWorldBrainConfig } from './worldBrainConfig';

const raw = {
  sceneId: 's',
  setting: '街',
  player: { label: '关二狗', identity: '二流子' },
  places: [
    { id: 'home', name: '面摊', x: 0, y: 0 },
    { id: 'b', name: '十字口', x: 300, y: 0 },
  ],
  links: [['home', 'b']],
  lineCategories: { hawk: '吆喝', omen: '说兆头' },
  genericLines: { omen: ['刚才那{event}，要出事哟。'] },
  genericReplies: {
    greet: ['二狗，来了索。'],
    about_event: ['刚才{where}那{event}，你看到没得？', '刚才那{event}，吓死个人。'],
    blame: ['刚才那{event}，是不是你搞的？'],
    busy: ['等哈，忙起的。'],
    leaving: ['我要去{dest}，莫拦到我。'],
    ask_player: ['你手头那个{held}是啥子？'],
    shoo: ['爬远点。'],
    scared: ['莫过来……'],
    gossip: ['听说没得……'],
  },
  people: [
    {
      npcId: 'n1', label: '面摊老板', identity: '卖面的', temper: '胆小', activity: '煮面',
      home: 'home', haunts: ['b'], says: ['hawk', 'omen'], lines: { hawk: ['牛肉面！'] },
      replies: { trade: ['来碗面撒？'], busy: ['锅要糊了，等哈！'] },
    },
    {
      npcId: 'dog', label: '土狗', kind: 'animal', identity: '狗', temper: '怕响动', activity: '趴着',
      home: 'home', haunts: [], replies: { friendly: ['汪！'], hostile: ['汪汪汪！'] },
    },
  ],
};
const cfg = parseWorldBrainConfig(raw, 's').config!;
const noodle = cfg.people[0];
const dog = cfg.people[1];

const quiet: ReplyContext = {
  atOwnActivity: true, headingTo: null, eventText: null, eventByPlayer: false, playerOddity: null, slots: NO_SLOTS,
};

describe('台词槽位', () => {
  it('填得上才说得出来：没出事，"刚才那{event}"就不能说', () => {
    expect(fillLine('刚才那{event}，吓死个人。', NO_SLOTS)).toBeNull();
    expect(fillLine('刚才那{event}，吓死个人。', { ...NO_SLOTS, event: '白光' })).toBe('刚才那白光，吓死个人。');
    // 地点也是必填：满街都感觉得到的事没有地点，这句就不说（另有不带地点的说法）
    expect(fillLine('刚才{where}那{event}', { ...NO_SLOTS, event: '白光' })).toBeNull();
    expect(fillLine('刚才{where}那{event}', { ...NO_SLOTS, event: '雷符', where: '十字口' })).toBe('刚才十字口那边那雷符');
    expect(fillLine('牛肉面！', NO_SLOTS)).toBe('牛肉面！');
  });

  it('挑句子：自己的在前、通用的在后，自己的一句都说不出来才用通用的；尽量不重样', () => {
    const pools = [['刚才那{event}！'], ['二狗。']];
    expect(pickLine(pools, NO_SLOTS, () => 0, null)).toBe('二狗。');
    expect(pickLine(pools, { ...NO_SLOTS, event: '火' }, () => 0, null)).toBe('刚才那火！');
    expect(pickLine([['甲', '乙']], NO_SLOTS, () => 0, '甲')).toBe('乙');
    expect(pickLine([['刚才那{event}']], NO_SLOTS, () => 0, null)).toBeNull();
  });

  it('闲话类别只列此刻至少有一句说得出来的（候选 = 说得出来的）', () => {
    expect(Object.keys(buildSayOptions(noodle, cfg, NO_SLOTS)).sort()).toEqual(['hawk', 'silent']);
    expect(Object.keys(buildSayOptions(noodle, cfg, { ...NO_SLOTS, event: '白光' })).sort()).toEqual(['hawk', 'omen', 'silent']);
  });

  it('气泡按字数加长、有下限有封顶', () => {
    const t = { bubbleMs: 3000, bubbleMsPerChar: 190, bubbleMaxMs: 8000 };
    expect(bubbleDurationMs('哦豁！', t)).toBe(3000);
    expect(bubbleDurationMs('刚才十字口那边那白光，你看到没得？', t)).toBeGreaterThan(4000);
    expect(bubbleDurationMs('字'.repeat(200), t)).toBe(8000);
    expect(bubbleDurationMs('哦豁！', t, 1500)).toBe(4500);
  });
});

describe('被搭话时的回话选项（照此刻的情形出，不含不开腔）', () => {
  it('平常时：没有"摆刚才那件事 / 怀疑是你"，没在赶路就没有"要去哪"；不开腔不在里头', () => {
    const o = buildReplyOptions(noodle, cfg, quiet);
    expect(o.silent).toBeUndefined();
    expect(o.about_event).toBeUndefined();
    expect(o.blame).toBeUndefined();
    expect(o.leaving).toBeUndefined();
    expect(o.busy).toContain('煮面');
    expect(o.trade).toBeDefined(); // 他自己写了做生意的句子
  });

  it('刚出了事：能摆那件事、能怀疑是你；说法里带着那件事的原话', () => {
    const o = buildReplyOptions(noodle, cfg, {
      ...quiet, eventText: '关二狗在十字口拿出「雷符」用了', eventByPlayer: true,
      slots: { ...NO_SLOTS, event: '雷符', where: '十字口' },
    });
    expect(o.about_event).toContain('雷符');
    expect(o.blame).toContain('就是关二狗搞出来的');
  });

  it('在赶路：能说要去哪；没在做自己的事就不说忙', () => {
    const o = buildReplyOptions(noodle, cfg, {
      ...quiet, atOwnActivity: false, headingTo: '十字口', slots: { ...NO_SLOTS, dest: '十字口' },
    });
    expect(o.leaving).toContain('十字口');
    expect(o.busy).toBeUndefined();
  });

  it('玩家手上拿着东西：问他在搞啥子名堂时带上；{held} 的句子才说得出来', () => {
    const o = buildReplyOptions(noodle, cfg, {
      ...quiet, playerOddity: '提着点燃的火把', slots: { ...NO_SLOTS, held: '火把' },
    });
    expect(o.ask_player).toContain('提着点燃的火把');
    expect(buildReplyOptions(noodle, cfg, quiet).ask_player).toBeUndefined(); // 通用那句要 {held}
  });

  it('牲口：只有它自己写了叫声的反应（牲口没有通用回话）', () => {
    expect(Object.keys(buildReplyOptions(dog, cfg, quiet)).sort()).toEqual(['friendly', 'hostile']);
  });
});
