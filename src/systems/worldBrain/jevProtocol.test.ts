import { describe, expect, it } from 'vitest';
import {
  buildMenu,
  buildPersonQuestions,
  buildPersonState,
  personSnapshot,
  buildSalienceRequest,
  buildSayOptions,
  estimateHeadTokens,
  estimateTokens,
  HEAD_TOKEN_BUDGET,
  parseJevResponse,
  rankOptions,
  SALIENCE_QUESTION,
  unmapAnswer,
} from './jevProtocol';
import { parseWorldBrainConfig } from './worldBrainConfig';

const raw = {
  sceneId: 's',
  setting: '一条街',
  player: { label: '关二狗', identity: '二流子' },
  places: [
    { id: 'home', name: '面摊', x: 0, y: 0, shelter: true },
    { id: 'b', name: '十字口', x: 300, y: 0 },
    { id: 'c', name: '洗衣台', x: 600, y: 0 },
    { id: 'exit', name: '码头路口', x: 900, y: 0, exit: true },
  ],
  links: [['home', 'b'], ['b', 'c'], ['c', 'exit']],
  lineCategories: { hawk: '吆喝', scream: '惊叫' },
  people: [
    {
      npcId: 'n1', label: '面摊老板', identity: '卖面的', temper: '胆小', activity: '煮面',
      home: 'home', haunts: ['b', 'c'], says: ['hawk', 'scream'],
      relations: [{ npcId: 'n2', text: '说闲话' }],
      lines: { hawk: ['牛肉面！'] },
    },
    { npcId: 'n2', label: '洗衣婆', identity: '洗衣裳的', temper: '凶', activity: '搓衣裳', home: 'c', haunts: [] },
  ],
};

const cfg = parseWorldBrainConfig(raw, 's').config!;
const p1 = cfg.people[0];

function menu(over: Partial<Parameters<typeof buildMenu>[0]> = {}) {
  return buildMenu({
    person: p1, config: cfg, atPlace: 'home', playerDist: 5000, hasLocatedEvent: false, scary: true,
    present: new Set(['n1', 'n2']), ...over,
  });
}

describe('buildMenu', () => {
  it('有吓人的事（决策服务判的）：躲、蹲、扑地、吓一跳都在，挑不挑由决策服务定', () => {
    const keys = menu().map((o) => o.key);
    for (const k of ['carry_on', 'go:b', 'go:c', 'cower', 'drop_flat', 'startle']) expect(keys, k).toContain(k);
  });

  it('没有吓人的事："怕"的那几样不进菜单（Laya 会拿涨幅挑中它们：玩家走近就扑地）', () => {
    const keys = menu({ scary: false, hasLocatedEvent: true, atPlace: 'b' }).map((o) => o.key);
    for (const k of ['cower', 'drop_flat', 'startle', 'flee', 'run_shelter']) expect(keys, k).not.toContain(k);
    for (const k of ['carry_on', 'watch_event', 'gawk_event', 'go_home']) expect(keys, k).toContain(k);
  });

  it('只按"做不做得到"筛：看不见玩家不给冲玩家；没有出事地点不给看热闹 / 朝那边望 / 往反方向跑；在家不给回家', () => {
    const keys = menu().map((o) => o.key);
    for (const k of ['approach_player', 'face_player', 'watch_event', 'gawk_event', 'flee', 'go_home']) {
      expect(keys, k).not.toContain(k);
    }
    const keys2 = menu({ playerDist: 300, hasLocatedEvent: true, atPlace: 'b' }).map((o) => o.key);
    for (const k of ['flee', 'approach_player', 'face_player', 'watch_event', 'gawk_event', 'go_home', 'run_shelter']) {
      expect(keys2, k).toContain(k);
    }
  });

  it('关系对象不在街上时不给"走到某人跟前"', () => {
    expect(menu().map((o) => o.key)).toContain('approach_person:n2');
    expect(menu({ present: new Set(['n1']) }).map((o) => o.key)).not.toContain('approach_person:n2');
  });

  it('说法里带上这个人的营生 / 地名', () => {
    const m = menu();
    expect(m.find((o) => o.key === 'carry_on')!.text).toContain('煮面');
    expect(m.find((o) => o.key === 'go:b')!.text).toContain('十字口');
  });
});

describe('buildPersonQuestions（一发只问一个人）', () => {
  it('走位 + 闲话两道题，键是固定的 act / say；题面点名这个人；选项说法是菜单原样，键换成短代号并能换回', () => {
    const m = menu();
    const { questions, refs } = buildPersonQuestions({ person: p1, menu: m, say: buildSayOptions(p1, cfg) }, cfg);
    expect(Object.keys(questions).sort()).toEqual(['act', 'say']);
    const q = questions.act;
    expect(q.type).toBe('choice');
    if (q.type === 'choice') {
      expect(q.instructions).toContain('面摊老板');
      expect(Object.values(q.criteria)).toEqual(m.map((o) => o.text));
      expect(Object.keys(q.criteria).slice(0, 3)).toEqual(['a', 'b', 'c']);
    }
    const ref = refs.get('act') as { keyMap: Record<string, string> };
    expect(Object.values(ref.keyMap)).toEqual(m.map((o) => o.key));
    const back = unmapAnswer({ choice: 'b', probabilities: { a: 0.2, b: 0.8 }, confidence: 0.5 }, ref.keyMap);
    expect(back.choice).toBe(m[1].key);
    expect(back.probabilities).toEqual({ [m[0].key]: 0.2, [m[1].key]: 0.8 });
    expect(refs.get('say')).toEqual({ npcId: 'n1', what: 'say' });
  });

  it('题目超了预算（Laya 静默截断）：按次序去掉次要选项兜底，"接着做"永远留着', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ key: `go:p${i}`, kind: 'go' as const, text: `走到很远很远的第${i}个地方去` }));
    const m = [{ key: 'carry_on', kind: 'carry_on' as const, text: '接着煮面' }, ...many];
    const { questions } = buildPersonQuestions({ person: p1, menu: m, say: null }, cfg);
    expect(estimateHeadTokens(questions.act)).toBeLessThanOrEqual(HEAD_TOKEN_BUDGET);
    if (questions.act.type === 'choice') expect(Object.values(questions.act.criteria)[0]).toBe('接着煮面');
  });

  it('被搭话：出回话题、不出闲话题', () => {
    const { questions, refs } = buildPersonQuestions(
      { person: p1, menu: menu(), say: buildSayOptions(p1, cfg), reply: { greet: '招呼他' } }, cfg,
    );
    expect(Object.keys(questions).sort()).toEqual(['act', 'reply']);
    expect(refs.get('reply')).toEqual({ npcId: 'n1', what: 'reply' });
  });

  it('街上刚出了值得应付的事：题面跟着这件事问"头一个反应"，不问"接下来最可能做啥子"', () => {
    const hot = buildPersonQuestions({ person: p1, menu: menu(), say: buildSayOptions(p1, cfg), hot: '炸雷' }, cfg);
    expect(hot.questions.act.instructions).toBe('刚才街上炸雷那一下，「面摊老板」头一个反应是啥子？');
    expect(hot.questions.say.instructions).toContain('刚才街上炸雷那一下');
    const noName = buildPersonQuestions({ person: p1, menu: menu(), say: null, hot: '' }, cfg);
    expect(noName.questions.act.instructions).toBe('刚才街上这一下，「面摊老板」头一个反应是啥子？');
    const calm = buildPersonQuestions({ person: p1, menu: menu(), say: null }, cfg);
    expect(calm.questions.act.instructions).toBe('「面摊老板」接下来最可能做啥子？');
  });

  it('选项说法短：走到某处去不带地点说明（题目的 token 预算紧）', () => {
    expect(menu().find((o) => o.key === 'go:b')!.text).toBe('走到十字口去');
  });
});

describe('buildPersonState（只写这一个人）', () => {
  const base = {
    config: cfg, now: 30, timeOfDay: '午',
    player: { where: '面摊附近', x: 150, y: 0, gait: 'running' as const, stillFor: 0, posture: null, holding: '提着点燃的灯笼' },
    person: {
      person: p1, where: '面摊', doing: '煮面', doingForSec: 40, playerDist: 150, x: 0, y: 0,
      seen: [{ label: '洗衣婆', x: 0, y: 200, where: '洗衣台', doing: '搓衣裳', forSec: 60 }],
    },
    budget: 700,
  };

  it('给词不给数：距离 / 时间都是口语；只有他一个人', () => {
    const st = buildPersonState({
      ...base,
      events: [
        { at: 22, text: '十字口那边出现了天雷', salience: null, spectacle: true, source: 't' },
        { at: 25, text: 'x', lazyText: () => '出现了雷云', salience: null, spectacle: true, source: 't' },
      ],
    });
    const json = JSON.stringify(st);
    expect(json).toContain('几秒前（满街都感觉得到）：十字口那边出现了天雷');
    expect(json).toContain('几秒前（满街都感觉得到）：出现了雷云'); // 资产名晚到：说法现取
    expect(json).toContain('几步远');
    expect(json).toContain('在街上跑');
    expect(json).not.toContain('天色'); // 不写死几样天气，天气就是事件
    expect(st['面摊老板']).toBeTruthy();
    expect(st['洗衣婆']).toBeUndefined(); // 别人只出现在"旁边有"里
  });

  it('时间和物理上的关系写明：事离他多远在哪边、还没完 / 已过去、看得到是谁弄的；他和旁人是出事前就这样还是出事后才换的', () => {
    const snap = personSnapshot({
      ...base,
      now: 31,
      events: [
        {
          at: 30, text: '头顶一声炸雷', gist: '炸雷', salience: null, spectacle: true, source: 't',
          x: 0, y: -150, runId: 7, byPlayer: true,
        },
      ],
      person: {
        ...base.person,
        doingForSec: 40,
        seen: [
          { label: '洗衣婆', x: 0, y: 200, where: '洗衣台', doing: '搓衣裳', forSec: 60 },
          { label: '袍哥', x: 300, y: 0, where: '茶馆门口', doing: '撒腿往后街跑', forSec: 0.5 },
        ],
      },
    });
    // 跟着关二狗那一下来的（他看得见关二狗）；不说成"看得到是他弄出来的"
    expect(snap.events![0]).toBe('刚刚（离他几步远，在他北边，还没完，跟着关二狗那一下来的）：头顶一声炸雷');
    // 他自己：只说那会儿正在做啥，不替模型答"他没动"
    expect(snap.person!.doing).toBe('煮面（炸雷那会儿正在做这个）');
    expect(snap.person!.nearby).toEqual([
      '洗衣婆（几步远，在他南边，在洗衣台）：搓衣裳（炸雷之前就这样，到这会儿还没动）',
      '袍哥（隔了一段，在他东边，在茶馆门口）：撒腿往后街跑（刚刚才换成这样，是炸雷以后的事）',
    ]);
    expect(snap.person!.playerDistance).toBe('几步远，在他东边');
    // 平静时不跟"出事"对时间，只说做了多久
    const calm = personSnapshot({ ...base, events: [] });
    expect(calm.person!.doing).toBe('煮面');
    expect(calm.person!.nearby![0]).toBe('洗衣婆（几步远，在他南边，在洗衣台）：搓衣裳（好一阵了）');
  });

  it('超预算按"旁边有谁 → 较早的事 → 身份说明 → 街面说明"往下裁，裁到预算以内', () => {
    const events = Array.from({ length: 8 }, (_, i) => ({
      at: 20 + i, text: `第${i}件事`.padEnd(50, '长'), salience: null, spectacle: true, source: 't',
    }));
    const full = buildPersonState({ ...base, events, budget: 100000 });
    const tight = buildPersonState({ ...base, events, budget: 160 });
    expect(estimateTokens(tight)).toBeLessThan(estimateTokens(full));
    expect((tight['面摊老板'] as Record<string, unknown>)['旁边有']).toBeUndefined();
    expect((tight['刚才街上发生的事'] as string[]).length).toBeLessThanOrEqual(2);
    expect((full['刚才街上发生的事'] as string[]).length).toBe(6); // 最多 6 件（最新的）
  });
});

describe('显著度题（一件事一发，是非题，由决策服务判）', () => {
  it('state 只有街面一句话 + 这件事；问"街上的人看到会不会害怕"', () => {
    const ev = { at: 1, text: '天上打起炸雷来', salience: null, spectacle: true, source: 't' };
    const { state, questions } = buildSalienceRequest(ev, cfg);
    expect(state['刚才街上发生的事']).toEqual(['天上打起炸雷来']);
    expect(questions.sal).toEqual({ type: 'noul', instructions: SALIENCE_QUESTION });
  });

  it('街面用配置的 brief（带上街坊怕啥信啥）；没写就取 setting 前 40 字', () => {
    const ev = { at: 1, text: '天上打起炸雷来', salience: null, spectacle: true, source: 't' };
    const withBrief = parseWorldBrainConfig({ ...raw, brief: '一条老街，街坊都怕鬼神' }, 's').config!;
    expect(buildSalienceRequest(ev, withBrief).state['地方']).toBe('一条老街，街坊都怕鬼神');
    expect(buildSalienceRequest(ev, cfg).state['地方']).toBe([...cfg.setting].slice(0, 40).join(''));
  });

  it('解析 Noul 的概率、Score 的期望档位', () => {
    const r = parseJevResponse({
      answers: {
        sal: { type: 'noul', noul: 0.93, confidence: 0.93, action: { act_probability: 1 } },
        lv: { type: 'score', score: 3.2, confidence: 0.6, probabilities: { 3: 0.8, 4: 0.2 } },
      },
    })!;
    expect(r.answers.get('sal')!.noul).toBeCloseTo(0.93);
    expect(r.answers.get('lv')!.score).toBeCloseTo(3.2);
  });
});

describe('parseJevResponse / rankOptions', () => {
  it('官方形状', () => {
    const r = parseJevResponse({
      model: 'jev-1.13.0',
      answers: { act_0: { type: 'choice', choice: 'go:b', confidence: 0.7, probabilities: { 'go:b': 0.8, carry_on: 0.2 } } },
      usage: { input_tokens: 1200, output_tokens: 10 },
    })!;
    expect(r.inputTokens).toBe(1200);
    expect(r.cost).toBeNull();
    expect(r.answers.get('act_0')!.choice).toBe('go:b');
  });

  it('Vercel 网关形状（带花费）', () => {
    const r = parseJevResponse({
      answers: { say_0: { type: 'choice', choice: 'silent', probabilities: { silent: 1 } } },
      usage: { input_tokens: 10 },
      provider_metadata: { gateway: { cost: '0.0000042' } },
    })!;
    expect(r.cost).toBeCloseTo(0.0000042);
  });

  it('Laya 形状：花费恒 0、实际模型、state token、服务端耗时、截断提示；多出来的字段忽略', () => {
    const r = parseJevResponse({
      model: 'laya-multilingual',
      answers: { act: { type: 'choice', choice: 'carry_on', probabilities: { carry_on: 0.7 }, confidence: 0.2, action: { act_probability: 1 } } },
      usage: { input_tokens: 575, output_tokens: 0, cost: 0.0, state_tokens: 139 },
      routing: { checkpoint: 'laya-multilingual', reason: 'non-Latin script' },
      latency_ms: 508.9,
      warnings: ['state truncated: 1937 tokens, laya-multilingual only reads the first 967'],
    })!;
    expect(r.cost).toBe(0);
    expect(r.model).toBe('laya-multilingual');
    expect(r.stateTokens).toBe(139);
    expect(r.serverLatencyMs).toBeCloseTo(508.9);
    expect(r.warnings).toEqual(['state truncated: 1937 tokens, laya-multilingual only reads the first 967']);
    expect(r.answers.get('act')!.choice).toBe('carry_on');
  });

  it('形状不对返回 null', () => {
    expect(parseJevResponse(null)).toBeNull();
    expect(parseJevResponse({ detail: 'x' })).toBeNull();
  });

  it('候选按概率排，Jev 选中的恒在第一，菜单外的键丢掉', () => {
    const ranked = rankOptions(
      { choice: 'b', probabilities: { a: 0.5, b: 0.3, c: 0.2, zzz: 0.9 }, confidence: 0.4 },
      ['a', 'b', 'c'],
    );
    expect(ranked.map((r) => r.key)).toEqual(['b', 'a', 'c']);
  });
});
