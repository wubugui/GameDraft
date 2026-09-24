import { describe, expect, it } from 'vitest';
import {
  assembleState, counterfactualSnapshot, DEFAULT_RECIPES, DEFAULT_STATE_TEXTS, estimateStateTokens, resolveRecipes,
  type StateSnapshot,
} from './stateAssembly';

/**
 * 2026-09-22 之前 `buildPersonState` 的逐字拷贝（只把输入换成已经写成话的各栏）——
 * 抽成"配方 + 快照"之后，`legacy` 配方必须跟它一字不差。
 */
function legacyBuild(i: {
  setting: string; time: string; playerLabel: string; playerIdentity: string; playerWhere: string; playerDoing: string;
  holding: string | null; events: string[]; label: string; identity: string; temper: string; where: string; doing: string;
  doingFor: string; dist: string; nearby: string[]; budget: number;
}): Record<string, unknown> {
  const clip = (s: string, n: number) => ([...s].length <= n ? s : `${[...s].slice(0, n).join('')}…`);
  const playerDesc: Record<string, unknown> = { 是啥子人: i.playerIdentity, 在哪: i.playerWhere, 在做啥子: i.playerDoing };
  if (i.holding) playerDesc['手上'] = i.holding;
  const me: Record<string, unknown> = {
    是啥子: i.identity, 脾气: i.temper, 在哪: i.where, 在做啥子: i.doing, 做了多久: i.doingFor, [`离${i.playerLabel}`]: i.dist,
  };
  if (i.nearby.length) me['看得见的人'] = i.nearby.slice(0, 4);
  let events = i.events.slice(-6);
  let setting = i.setting;
  const make = (): Record<string, unknown> => ({
    地方: setting, 时辰: i.time, [i.playerLabel]: playerDesc,
    刚才街上发生的事: events.length ? events : ['没得啥子特别的事'], [i.label]: me,
  });
  let st = make();
  const cuts: (() => boolean)[] = [
    () => {
      const seen = me['看得见的人'] as string[] | undefined;
      if (!seen || seen.length <= 2) return false;
      me['看得见的人'] = seen.slice(0, 2);
      return true;
    },
    () => ('看得见的人' in me ? (delete me['看得见的人'], true) : false),
    () => (events.length > 4 ? ((events = events.slice(-4)), true) : false),
    () => (events.length > 2 ? ((events = events.slice(-2)), true) : false),
    () => (events.length > 1 ? ((events = events.slice(-1)), true) : false),
    () => {
      const id = String(me['是啥子']);
      if ([...id].length <= 40) return false;
      me['是啥子'] = clip(id, 40);
      return true;
    },
    () => ([...setting].length > 40 ? ((setting = clip(setting, 40)), true) : false),
  ];
  for (const cut of cuts) {
    if (estimateStateTokens(st) <= i.budget) break;
    if (cut()) st = make();
  }
  return st;
}

const LONG = '民国川江边小城的一条老街，青石板路，两边是吊脚楼和铺子，街坊都信菩萨、怕鬼神，天一黑就关门闭户';

describe('state 拼装：配方 + 快照 → state', () => {
  it('legacy 配方跟抽出来之前的拼法一字不差（各种预算 × 条数 × 长短）', () => {
    let cases = 0;
    for (const budget of [4000, 500, 380, 300, 250, 200, 150, 60]) {
      for (const nEvents of [0, 1, 3, 7]) {
        for (const nNearby of [0, 2, 5]) {
          for (const holding of [null, '一张雷符']) {
            for (const identity of ['面摊老板', `面摊老板，${LONG}`]) {
              const i = {
                setting: nEvents % 2 ? LONG : '老街', time: '下午', playerLabel: '关二狗', playerIdentity: '外乡来的年轻人',
                playerWhere: '面摊跟前', playerDoing: '站着', holding,
                events: Array.from({ length: nEvents }, (_, k) => `${k + 1} 秒前：面摊那边，事情${k}`),
                label: '面摊老板', identity, temper: '爱摆龙门阵', where: '面摊', doing: '煮面', doingFor: '一阵子', dist: '几步远',
                nearby: Array.from({ length: nNearby }, (_, k) => `人${k}（几步远）：在做事`), budget,
              };
              const snap: StateSnapshot = {
                setting: i.setting, time: i.time, events: i.events,
                player: { label: i.playerLabel, identity: i.playerIdentity, where: i.playerWhere, doing: i.playerDoing, holding },
                person: {
                  label: i.label, identity, temper: i.temper, where: i.where, doing: i.doing, doingFor: i.doingFor,
                  playerDistance: i.dist, nearby: i.nearby,
                },
              };
              expect(JSON.stringify(assembleState(DEFAULT_RECIPES.legacy, snap, { budget }))).toBe(JSON.stringify(legacyBuild(i)));
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBe(8 * 4 * 3 * 2 * 2);
  });

  it('纯函数：同样的输入拼出同样的 state，也不改动快照', () => {
    const snap: StateSnapshot = {
      setting: LONG, events: ['a', 'b', 'c', 'd', 'e'],
      person: { label: '甲', identity: '挑夫', nearby: ['x', 'y', 'z'] },
    };
    const frozen = JSON.stringify(snap);
    const a = assembleState(DEFAULT_RECIPES.legacy, snap, { budget: 50 });
    const b = assembleState(DEFAULT_RECIPES.legacy, snap, { budget: 50 });
    expect(a).toEqual(b);
    expect(JSON.stringify(snap)).toBe(frozen);
  });

  it('全量上下文：街面、天气、关二狗（样子 / 刚才 / 先前干的事）、这一簇的事、这个人的一切都进；没有事时写"没得啥子特别的事"', () => {
    const snap: StateSnapshot = {
      brief: '老街，街坊怕鬼神', setting: LONG, time: '夜里', weather: '天色压得黑沉沉的，起风了', events: [],
      player: { label: '关二狗', identity: '外乡人', doing: '站着', activity: '掷出一张雷符', recent: ['走到面摊跟前', '掏出一张符'] },
      person: {
        label: '甲', identity: '挑夫', temper: '胆小', heart: '心慌', nearby: ['乙（几步远）：在煮面'],
        playerDistance: '几步远', attitudeToPlayer: '有点防着他', memories: ['昨天那道雷'],
        dialogue: ['关二狗：老板，来碗面', '甲：要得'],
      },
    };
    expect(assembleState(DEFAULT_RECIPES.gate, snap)).toEqual({
      地方: LONG, 时辰: '夜里', 天气: '天色压得黑沉沉的，起风了',
      关二狗: { 是啥子人: '外乡人', 在做啥子: '站着', 刚才: '掷出一张雷符', 先前干的事: ['走到面摊跟前', '掏出一张符'] },
      刚才街上发生的事: ['没得啥子特别的事'],
      甲: {
        是啥子: '挑夫', 脾气: '胆小', 离关二狗: '几步远', 看得见的人: ['乙（几步远）：在煮面'], 心头: '心慌',
        对关二狗的看法: '有点防着他', 记得的事: ['昨天那道雷'], 这回跟关二狗说的话: ['关二狗：老板，来碗面', '甲：要得'],
      },
    });
    // 显著度问的是"街上的人会不会怕"：只放街面、时辰、天气和这件事
    expect(assembleState(DEFAULT_RECIPES.salience, { ...snap, events: ['天黑了', '炸雷'] })).toEqual({
      地方: '老街，街坊怕鬼神', 时辰: '夜里', 天气: '天色压得黑沉沉的，起风了', 刚才街上发生的事: ['炸雷'],
    });
  });

  it('超了模型容量才裁：先裁老话、次要记忆、远处的人，最新的话留着', () => {
    const snap: StateSnapshot = {
      setting: LONG, time: '下午',
      player: { label: '关二狗', identity: '外乡人' },
      person: {
        label: '甲', identity: '挑夫',
        dialogue: Array.from({ length: 12 }, (_, i) => `第${i + 1}句：${'说了好些话'.repeat(3)}`),
        memories: Array.from({ length: 6 }, (_, i) => `记忆${i + 1}：${'好久以前的事'.repeat(3)}`),
      },
    };
    const full = assembleState(DEFAULT_RECIPES.reply, snap) as Record<string, Record<string, string[]>>;
    expect(full['甲']!['这回跟关二狗说的话']).toHaveLength(12);
    const tight = assembleState(DEFAULT_RECIPES.reply, snap, { budget: 400 }) as Record<string, Record<string, string[]>>;
    const talk = tight['甲']!['这回跟关二狗说的话']!;
    expect(talk.length).toBeLessThan(12);
    expect(talk[talk.length - 1]).toContain('第12句');
    expect(estimateStateTokens(tight)).toBeLessThan(estimateStateTokens(full));
  });

  it('看法 / 事主：键名带上称呼', () => {
    const st = assembleState(DEFAULT_RECIPES.react, {
      person: { label: '甲', identity: '挑夫', attitudeToActor: { actor: '关二狗', text: '有点防着他' } },
    }) as Record<string, Record<string, unknown>>;
    expect(st['甲']).toEqual({ 是啥子: '挑夫', 对关二狗的看法: '有点防着他' });
  });
});

describe('对照（§12.4）：只改一样，结构和条数不变', () => {
  const snap: StateSnapshot = {
    setting: '老街', time: '下午', events: ['刚才：炸雷', '刚才：天黑了'],
    player: { label: '关二狗', identity: '外乡人', where: '面摊', doing: '掏出一张符', holding: '雷符', activity: '掷出雷符' },
    person: {
      label: '甲', identity: '面摊老板', genericIdentity: '街上一个摆面摊的', temper: '爱摆龙门阵', doing: '煮面',
      memories: ['上回关二狗赊了一碗面', '昨晚打雷'], evidence: [{ text: '赊面', fresh: false }, { text: '掷雷符', fresh: true }],
    },
  };
  const shape = (st: Record<string, unknown>): unknown => JSON.parse(JSON.stringify(st, (_k, v) => (typeof v === 'string' ? '' : v)));

  it('甲：每件事换成中性占位，条数不变；信不信题里听到的那句也换成中性的', () => {
    const cf = counterfactualSnapshot(snap, 'noEvents');
    expect(cf.events).toEqual([DEFAULT_STATE_TEXTS.neutralEvent, DEFAULT_STATE_TEXTS.neutralEvent]);
    expect(shape(assembleState(DEFAULT_RECIPES.react, cf))).toEqual(shape(assembleState(DEFAULT_RECIPES.react, snap)));
    const heard: StateSnapshot = {
      person: { label: '甲', identity: '挑夫', heardLine: '跑腿伙计说：那张符招雷', relationToSpeaker: { speaker: '跑腿伙计', text: '不熟' } },
    };
    const hcf = counterfactualSnapshot(heard, 'noEvents');
    expect(hcf.person!.heardLine).toBe(DEFAULT_STATE_TEXTS.neutralHeard);
    expect(hcf.person!.relationToSpeaker).toEqual({ speaker: '跑腿伙计', text: '不熟' });
    // 关系那一栏的键名带上传话那人的称呼
    expect((assembleState(DEFAULT_RECIPES.belief, heard) as Record<string, Record<string, unknown>>)['甲']).toMatchObject({ 跟跑腿伙计: '不熟' });
  });

  it('甲′：只换新进的证据，钉住的不动', () => {
    const cf = counterfactualSnapshot(snap, 'noFreshEvidence');
    expect(cf.person!.evidence).toEqual([{ text: '赊面', fresh: false }, { text: DEFAULT_STATE_TEXTS.neutralEvidence, fresh: true }]);
  });

  it('乙：身份换成同类泛称、脾气换成中性说法', () => {
    const cf = counterfactualSnapshot(snap, 'anon');
    expect(cf.person!.identity).toBe('街上一个摆面摊的');
    expect(cf.person!.temper).toBe(DEFAULT_STATE_TEXTS.neutralTemper);
    expect(shape(assembleState(DEFAULT_RECIPES.routine, cf))).toEqual(shape(assembleState(DEFAULT_RECIPES.routine, snap)));
  });

  it('丙：关二狗只是路过；丁：记得的事全换成中性占位', () => {
    const pb = counterfactualSnapshot(snap, 'passerby');
    expect(pb.player).toMatchObject({ doing: DEFAULT_STATE_TEXTS.passerby, holding: null, activity: null });
    const nm = counterfactualSnapshot(snap, 'noMemories');
    expect(nm.person!.memories).toEqual([DEFAULT_STATE_TEXTS.neutralMemory, DEFAULT_STATE_TEXTS.neutralMemory]);
    expect(snap.person!.memories![0]).toBe('上回关二狗赊了一碗面');   // 原快照不动
  });
});

describe('配方表（数据里写的覆盖缺省）', () => {
  it('整条覆盖；不认识的配方 / 栏报错；"绝不放"的栏报错', () => {
    const { recipes, errors } = resolveRecipes({
      routine: { fields: ['identity', 'doing', 'weird'] },
      salience: { fields: ['brief', 'events', 'identity'] },
      nope: { fields: [] },
    });
    expect(recipes.routine.fields).toEqual(['identity', 'doing']);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('不认识的栏：weird'),
      expect.stringContaining('配方「nope」不认识'),
      // 显著度问的是"街上的人会不会怕"，放"这个人"的栏没意义
      expect.stringContaining('配方「salience」不许放：identity'),
    ]));
    // 放下 / 反应放"看得见的人"不再报错（09-22 定：全量上下文，只按模型容量裁）
    expect(resolveRecipes({ react: { fields: ['identity', 'nearby'] } }).errors).toEqual([]);
  });

  it('缺省配方本身守"绝不放"', () => {
    expect(resolveRecipes(undefined).errors).toEqual([]);
  });
});
