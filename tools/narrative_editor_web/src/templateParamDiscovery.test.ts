import { describe, expect, it } from 'vitest';
import { discoverParamCandidates, effectiveOverMatches } from './templateParamDiscovery';
import type { AuthoringCatalogDef, NarrativeCompositionDef } from './types';

function makeCatalog(overrides: Partial<AuthoringCatalogDef> = {}): AuthoringCatalogDef {
  return {
    dialogueGraphIds: [],
    scenarioIds: [],
    questIds: [],
    sceneIds: [],
    sceneEntityRefs: [],
    sceneNpcRefs: [],
    sceneHotspotRefs: [],
    zoneRefs: [],
    sceneGroupRefs: [],
    minigameIds: [],
    cutsceneIds: [],
    graphIds: [],
    actionTypes: [],
    actionParamSchemas: {},
    actionPersistence: {},
    ...overrides,
  };
}

/** 可拾取物 wrapper 形状：wrap_藏钱点A + 藏钱点A__已取，owner 是热点。 */
function makeWrapperComposition(): NarrativeCompositionDef {
  return {
    id: 'wrap_藏钱点A',
    label: '藏钱点A',
    mainGraph: {
      id: 'wrap_藏钱点A',
      ownerType: 'hotspot',
      ownerId: '藏钱点A',
      initialState: 'inactive',
      states: {
        inactive: { id: 'inactive' },
        active: { id: 'active' },
        taken: { id: 'taken' },
      },
      transitions: [
        { id: 't1', from: 'inactive', to: 'active', signal: '第三章开始' },
        { id: 't2', from: 'active', to: 'taken', signal: '藏钱点A__已取' },
      ],
    },
    elements: [],
  };
}

describe('discoverParamCandidates', () => {
  it('wrapper 形状：ownerId 公共 token 排第一，建议绑定 entity.id，样值预填', () => {
    const cands = discoverParamCandidates(makeWrapperComposition(), makeCatalog());
    const top = cands[0];
    expect(top.kind).toBe('token');
    expect(top.sample).toBe('藏钱点A');
    // ownerType=hotspot ⇒ 盖章时出热点选择器，不是裸输入框
    expect(top.type).toBe('hotspotRef');
    expect(top.suggestedFrom).toBe('entity.id');
    expect(top.suggestedName).toBe('ownerId');
    // 出现次数 = 整份 JSON 里的子串数（id、图id、ownerId、label、信号）
    expect(top.occurrences).toBeGreaterThanOrEqual(5);
  });

  it('实体 ownerType 给出 entity.kind 绑定候选', () => {
    const cands = discoverParamCandidates(makeWrapperComposition(), makeCatalog());
    const ownerType = cands.find((c) => c.sample === 'hotspot');
    expect(ownerType).toBeDefined();
    expect(ownerType!.suggestedFrom).toBe('entity.kind');
    expect(ownerType!.suggestedName).toBe('ownerType');
  });

  it('图显示名给出 entity.label 绑定候选（否则 N 个实例画布上全同名）', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.label = '藏钱窝点';
    const cands = discoverParamCandidates(comp, makeCatalog());
    const label = cands.find((c) => c.sample === '藏钱窝点');
    expect(label?.suggestedFrom).toBe('entity.label');
    expect(label?.suggestedName).toBe('label');
  });

  it('显示名恰好等于 ownerId 时不抢走 entity.id 绑定', () => {
    // makeWrapperComposition 的 label 就是 '藏钱点A' = ownerId
    const cands = discoverParamCandidates(makeWrapperComposition(), makeCatalog());
    const owner = cands.find((c) => c.sample === '藏钱点A');
    expect(owner?.suggestedFrom).toBe('entity.id');
    expect(cands.filter((c) => c.sample === '藏钱点A')).toHaveLength(1);
  });

  it('样值嵌在别的已登记 id 里 = 误伤名单（箱子1 之于 箱子11）', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.ownerId = '箱子1';
    comp.mainGraph.id = 'wrap_箱子1';
    comp.mainGraph.label = '箱子';
    comp.mainGraph.transitions[1].signal = '箱子1__已取';
    comp.elements = [
      { id: 'e1', kind: 'dialogueBlackbox', refId: '主线_箱子11_对话' },
    ];
    const cands = discoverParamCandidates(comp, makeCatalog({
      sceneHotspotRefs: ['箱子1', '箱子11'],
      dialogueGraphIds: ['主线_箱子11_对话'],
    }));
    const owner = cands.find((c) => c.sample === '箱子1');
    expect(owner?.overMatches).toContain('箱子11');
    expect(owner?.overMatches).toContain('主线_箱子11_对话');
  });

  it('无误伤时不带 overMatches 字段', () => {
    const cands = discoverParamCandidates(makeWrapperComposition(), makeCatalog({
      sceneHotspotRefs: ['藏钱点A'],
    }));
    expect(cands.find((c) => c.sample === '藏钱点A')?.overMatches).toBeUndefined();
  });

  it('dialogueBlackbox refId → dialogueRef；activePlane → planeRef', () => {
    const comp = makeWrapperComposition();
    comp.elements = [
      { id: 'e1', kind: 'dialogueBlackbox', label: '拾取对话', refId: '主线_藏钱' },
    ];
    comp.mainGraph.states.active.activePlane = '背尸';
    const cands = discoverParamCandidates(comp, makeCatalog());
    const dlg = cands.find((c) => c.sample === '主线_藏钱');
    expect(dlg?.type).toBe('dialogueRef');
    const plane = cands.find((c) => c.sample === '背尸');
    expect(plane?.type).toBe('planeRef');
  });

  it('动作参数字符串按 catalog 清单反查类型', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.states.taken.onEnterActions = [
      { type: 'warpToScene', params: { targetScene: '雾津街头' } },
    ];
    const cands = discoverParamCandidates(comp, makeCatalog({ sceneIds: ['雾津街头'] }));
    const scene = cands.find((c) => c.sample === '雾津街头');
    expect(scene?.type).toBe('sceneRef');
  });

  it('共用私有信号名不进命名源（N 实例共名是机制本体）', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.transitions[0].signal = 'cangqian_activate';
    comp.mainGraph.transitions[1].signal = 'cangqian_taken';
    const withPrivate = discoverParamCandidates(comp, makeCatalog(), [
      { id: 'cangqian_taken', scope: 'private' },
    ]);
    expect(withPrivate.some((c) => c.sample === 'cangqian')).toBe(false);
    // 对照：不标 private 时 cangqian 出现在两条不同信号里 → 应成候选
    const control = discoverParamCandidates(comp, makeCatalog(), [{ id: 'cangqian_taken' }]);
    expect(control.some((c) => c.sample === 'cangqian')).toBe(true);
  });

  it('reactive 转移的 signal 字段与 __draft__ 不当命名源；停用词不成候选', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.transitions.push(
      { id: 't3', from: 'active', to: 'taken', signal: '藏钱点A_旧名残留', trigger: 'reactive' },
      { id: 't4', from: 'inactive', to: 'taken', signal: '__draft__' },
    );
    const cands = discoverParamCandidates(comp, makeCatalog());
    expect(cands.some((c) => c.sample === '旧名残留')).toBe(false);
    expect(cands.some((c) => c.sample === 'wrap')).toBe(false);
    expect(cands.some((c) => c.sample === 'draft')).toBe(false);
  });

  it('真实事故形状：flow 主图 + 内嵌 wrapper（画布自动名），ownerId 仍恒出候选', () => {
    // 复刻 composition_3：主图是 flow，藏钱机器整个在 wrapperGraph 元素的内嵌图里，
    // 图 id 全是画布自动名（composition_3 / wrapper_graph_2），信号一全局一私有。
    const comp: NarrativeCompositionDef = {
      id: 'composition_3',
      mainGraph: {
        id: '主线_交互点',
        ownerType: 'flow',
        initialState: 'initial',
        states: { initial: { id: 'initial' } },
        transitions: [],
      },
      elements: [
        {
          id: 'wrapper_1',
          kind: 'wrapperGraph',
          label: '藏钱',
          ownerType: 'hotspot',
          ownerId: '主线s1藏钱点A',
          graph: {
            id: 'wrapper_graph_2',
            ownerType: 'hotspot',
            ownerId: '主线s1藏钱点A',
            initialState: 'initial',
            states: {
              initial: { id: 'initial' },
              state_1: { id: 'state_1' },
              state_2: { id: 'state_2' },
            },
            transitions: [
              { id: 't_1', from: 'initial', to: 'state_1', signal: '崖墓任务_发布完成' },
              { id: 't_2', from: 'state_1', to: 'state_2', signal: '私有事件完结' },
            ],
          },
        },
      ],
    };
    const cands = discoverParamCandidates(comp, makeCatalog(), [
      { id: '私有事件完结', scope: 'private' },
    ]);
    const owner = cands.find((c) => c.sample === '主线s1藏钱点A');
    expect(owner).toBeDefined();
    expect(owner!.suggestedFrom).toBe('entity.id');
    expect(owner!.kind).toBe('token');
    expect(owner!.type).toBe('hotspotRef');
    // 画布自动名碎片不成候选
    expect(cands.some((c) => c.sample === 'wrapper')).toBe(false);
    expect(cands.some((c) => c.sample === 'composition')).toBe(false);
    // 私有信号名不成候选
    expect(cands.some((c) => c.sample === '私有事件完结')).toBe(false);
  });

  it('同一个来源只出一条候选源（母图上两个 wrapper 都绑 entity.id 时，采用侧要能去重）', () => {
    // 真实形状：母图挂两张各绑不同实体的 wrapper。发现器会给出两条 entity.id 候选，
    // 表单必须按来源去重——两条都采 = 批量盖章填成同一个实体、一个实体挂两张图。
    const comp: NarrativeCompositionDef = {
      id: 'composition_3',
      mainGraph: {
        id: '主线_交互点', ownerType: 'flow', initialState: 'i',
        states: { i: { id: 'i' } }, transitions: [],
      },
      elements: [
        { id: 'w1', kind: 'wrapperGraph', label: '藏钱', ownerType: 'hotspot', ownerId: '藏钱点A',
          graph: { id: 'g1', ownerType: 'hotspot', ownerId: '藏钱点A', initialState: 'a',
            states: { a: { id: 'a' } }, transitions: [] } },
        { id: 'w2', kind: 'wrapperGraph', label: '门卫', ownerType: 'npc', ownerId: '门卫乙',
          graph: { id: 'g2', ownerType: 'npc', ownerId: '门卫乙', initialState: 'a',
            states: { a: { id: 'a' } }, transitions: [] } },
      ],
    };
    const cands = discoverParamCandidates(comp, makeCatalog());
    const entityIdCands = cands.filter((c) => c.suggestedFrom === 'entity.id');
    expect(entityIdCands.length).toBeGreaterThanOrEqual(2); // 发现器如实报两条
    // 去重口径（表单按 suggestedFrom 取第一条）：同来源只留一个
    const bySource = new Set(entityIdCands.map((c) => c.suggestedFrom));
    expect(bySource.size).toBe(1);
  });

  it('effectiveOverMatches：被更长样值罩住的命中是假阳性，要剔掉', () => {
    // 藏钱 看似伤 主线s1藏钱点A，但后者本身就是更长的样值、先被替换 → 假阳性
    expect(effectiveOverMatches('藏钱', ['主线s1藏钱点A', '主线_藏钱'], ['主线s1藏钱点A', '藏钱']))
      .toEqual(['主线_藏钱']);
    // 没有更长样值罩着 → 真会被改坏，留着
    expect(effectiveOverMatches('箱子1', ['箱子11'], ['箱子1', 'hotspot'])).toEqual(['箱子11']);
    // 自己不算罩自己
    expect(effectiveOverMatches('箱子1', ['箱子11'], ['箱子1'])).toEqual(['箱子11']);
  });

  it('effectiveOverMatches：等长样值不互相保护（替换顺序未定，宁可报也不漏）', () => {
    // 等长两条互不包含（等长且互相包含只能是同一个串），所以谁也罩不住谁
    expect(effectiveOverMatches('箱子1', ['箱子11'], ['箱子1', '箱子2'])).toEqual(['箱子11']);
  });

  it('effectiveOverMatches：entity.id 样值反而最短时照样报（由「恒采用+挡创建」兜）', () => {
    // ownerId='A'、显示名更长：A 嵌在别的实体 id 里 → 必须报，不能因为它是必需参数就放行
    expect(effectiveOverMatches('A', ['箱A', '藏钱点A2'], ['A', '藏钱点A的钱']))
      .toEqual(['箱A', '藏钱点A2']);
  });

  it('effectiveOverMatches：命中被任一更长样值罩住就免报，没罩住的照报', () => {
    // 样值 箱 ；另外两条更长样值：箱子1（ownerId）、箱子仓库（显示名）
    const hits = ['箱子1号位', '箱子仓库门', '箱笼'];
    expect(effectiveOverMatches('箱', hits, ['箱', '箱子1', '箱子仓库'])).toEqual([
      '箱笼', // 没有任何更长样值嵌在里面 → 真会被改坏
    ]);
    // 去掉那两条更长样值后，三条全都要报
    expect(effectiveOverMatches('箱', hits, ['箱'])).toEqual(hits);
  });

  it('显示名嵌在信号名里 = 误伤（信号被改名后没人发，那一跳永远不走，且校验器查不出）', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.label = '藏钱';
    comp.mainGraph.transitions[1].signal = '藏钱_取走'; // 作者信号，不在任何目录清单里
    const cands = discoverParamCandidates(comp, makeCatalog({ sceneHotspotRefs: ['藏钱点A'] }));
    const label = cands.find((c) => c.sample === '藏钱');
    expect(label?.suggestedFrom).toBe('entity.label');
    expect(label?.overMatches).toContain('藏钱_取走');
  });

  it('实例 id 嵌在信号名里**不算**误伤（逐实例信号名是正当模式，本就该被 ownerId 挖洞）', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.transitions[1].signal = '藏钱点A__已取';
    const cands = discoverParamCandidates(comp, makeCatalog({ sceneHotspotRefs: ['藏钱点A'] }));
    const owner = cands.find((c) => c.sample === '藏钱点A');
    expect(owner?.suggestedFrom).toBe('entity.id');
    expect(owner?.overMatches ?? []).not.toContain('藏钱点A__已取');
  });

  it('短实例 id 撞进无关信号的字中间**算**误伤（门 之于 开门_完成 → 幽灵信号）', () => {
    const comp = makeWrapperComposition();
    comp.mainGraph.ownerId = '门';
    comp.mainGraph.id = 'wrap_门';
    comp.mainGraph.label = '侧门';
    comp.mainGraph.transitions[0].signal = '开门_完成'; // 与这个热点无关的信号
    comp.mainGraph.transitions[1].signal = '门__已取';   // 正当的逐实例命名
    const cands = discoverParamCandidates(comp, makeCatalog({ sceneHotspotRefs: ['门'] }));
    const owner = cands.find((c) => c.sample === '门');
    expect(owner?.suggestedFrom).toBe('entity.id');
    // 撞在「开」和「_」之间 = 撞的，要报
    expect(owner?.overMatches).toContain('开门_完成');
    // 串首 + 后接分隔符 = 正当逐实例命名，不报
    expect(owner?.overMatches ?? []).not.toContain('门__已取');
  });

  it('无可发现结构时返回空，不硬造候选', () => {
    const comp: NarrativeCompositionDef = {
      id: 'flow_solo',
      mainGraph: {
        id: 'graph_one',
        ownerType: 'flow',
        initialState: 's1',
        states: { s1: { id: 's1' } },
        transitions: [],
      },
    };
    expect(discoverParamCandidates(comp, makeCatalog())).toEqual([]);
  });
});
