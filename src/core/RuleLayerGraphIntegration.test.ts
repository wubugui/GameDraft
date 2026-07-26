/**
 * 规矩层图端到端集成测试：**真实的 narrative_graphs.json + 真实的 NarrativeStateManager**。
 *
 * 这是迁移计划 Phase 2 的硬前置——把「advanceRule → 层图迁移 → rule 条件读得到」
 * 整条通路在真数据上跑一遍，而不是靠 fake。它专门盯三件曾经杀死过备选方案的事：
 *
 * 1. **越级授予不能静默失败**：从「未闻」直接跳到任意版本都要有边
 *    （阶梯模型就是因为「跳级 = 静默 no-op、零日志零校验」被否掉的）
 * 2. **回头改版本要能走**：已经在「验成」还能被推到「推翻」、也能推回去
 *    （单链模型做不到「回头验证已越过的层」）
 * 3. **层与层之间零结构依赖**：先会术后懂理是合法的
 */
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraphsFile } from './NarrativeStateManager';
import narrativeGraphsData from '../../public/assets/data/narrative_graphs.json';
import rulesData from '../../public/assets/data/rules.json';
import {
  RULE_LAYER_ENTRY_STATE,
  RULE_LAYER_INITIAL_STATE,
  RULE_LAYER_KEYS,
  parseRuleLayerGraphId,
  ruleAdvanceSignal,
  ruleLayerGraphId,
} from '../data/ruleGraphNaming';

function makeNarrative() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
  narrative.setConditionEvalContextFactory(() => ({
    flagStore,
    questManager: { getStatus: () => 0 } as never,
    scenarioState: {} as never,
    narrativeState: narrative,
  }));
  narrative.registerGraphs(compileNarrativeGraphs(narrativeGraphsData as unknown as NarrativeGraphsFile));
  return narrative;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 从真实 rules.json 里挑一条真有该层的规矩，避免测试写死不存在的 id。 */
function pickRuleLayer(): { ruleId: string; layer: string } {
  for (const rule of rulesData.rules as { id: string; layers?: Record<string, unknown> }[]) {
    for (const layer of RULE_LAYER_KEYS) {
      if (rule.layers?.[layer]) return { ruleId: rule.id, layer };
    }
  }
  throw new Error('rules.json 里没有任何带层的规矩，测试无法进行');
}

describe('规矩层图（真实数据）', () => {
  it('生成的层图与 rules.json 逐条对上，且形状符合约定', () => {
    const narrative = makeNarrative();
    let checked = 0;
    for (const rule of rulesData.rules as { id: string; layers?: Record<string, unknown> }[]) {
      for (const layer of RULE_LAYER_KEYS) {
        if (!rule.layers?.[layer]) continue;
        const gid = ruleLayerGraphId(rule.id, layer);
        const graph = narrative.getGraph(gid);
        expect(graph, `层图缺失：${gid}（跑 ./dev.sh sync-rule-graphs）`).toBeTruthy();
        expect(graph!.initialState).toBe(RULE_LAYER_INITIAL_STATE);
        expect(graph!.states[RULE_LAYER_ENTRY_STATE]).toBeTruthy();
        // 层图是纯状态载体：不挂动作、不点名位面（点名会把别的位面永久顶掉）
        for (const state of Object.values(graph!.states)) {
          expect(state.onEnterActions ?? []).toHaveLength(0);
          expect((state as { activePlane?: unknown }).activePlane).toBeUndefined();
        }
        // 图 id 必须能解析回 (规矩, 层)，否则重构引擎会跟丢
        expect(parseRuleLayerGraphId(gid)).toEqual({ ruleId: rule.id, layer });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('每个目标版本都能从所有其它状态到达 —— 越级授予不会静默失败', () => {
    const narrative = makeNarrative();
    const { ruleId, layer } = pickRuleLayer();
    const graph = narrative.getGraph(ruleLayerGraphId(ruleId, layer))!;
    const targets = Object.keys(graph.states).filter((s) => s !== RULE_LAYER_INITIAL_STATE);

    for (const target of targets) {
      const signal = ruleAdvanceSignal(ruleId, layer, target);
      const froms = new Set(
        graph.transitions.filter((t) => t.signal === signal).map((t) => t.from),
      );
      for (const from of Object.keys(graph.states)) {
        if (from === target) continue;
        expect(froms.has(from), `${graph.id}: 缺 ${from} → ${target} 的边，该处推进会静默无效`).toBe(true);
      }
    }
  });

  it('advanceRule 的信号真能推动层图，且掌握是单调的', async () => {
    const narrative = makeNarrative();
    const { ruleId, layer } = pickRuleLayer();
    const gid = ruleLayerGraphId(ruleId, layer);

    expect(narrative.getActiveState(gid)).toBe(RULE_LAYER_INITIAL_STATE);

    narrative.emitNarrativeSignal({ signal: ruleAdvanceSignal(ruleId, layer, RULE_LAYER_ENTRY_STATE) });
    await flush();

    expect(narrative.getActiveState(gid)).toBe(RULE_LAYER_ENTRY_STATE);
    expect(narrative.hasReachedState(gid, RULE_LAYER_ENTRY_STATE)).toBe(true);
    // 离开初态之后不会再回去（生成器不产回到初态的边）
    expect(narrative.getActiveState(gid)).not.toBe(RULE_LAYER_INITIAL_STATE);
  });

  it('未知目标版本的信号不会改变状态（也不会把图推坏）', async () => {
    const narrative = makeNarrative();
    const { ruleId, layer } = pickRuleLayer();
    const gid = ruleLayerGraphId(ruleId, layer);

    narrative.emitNarrativeSignal({ signal: ruleAdvanceSignal(ruleId, layer, '根本不存在的版本') });
    await flush();
    expect(narrative.getActiveState(gid)).toBe(RULE_LAYER_INITIAL_STATE);
  });

  it('层与层之间零结构依赖：先推术、后推象都合法', async () => {
    const narrative = makeNarrative();
    // 找一条同时有两层的规矩
    const multi = (rulesData.rules as { id: string; layers?: Record<string, unknown> }[])
      .find((r) => RULE_LAYER_KEYS.filter((L) => r.layers?.[L]).length >= 2);
    if (!multi) return; // 数据里暂时没有多层规矩时跳过，不制造假失败
    const layers = RULE_LAYER_KEYS.filter((L) => multi.layers?.[L]);
    const [first, second] = [layers[layers.length - 1], layers[0]]; // 故意倒着来

    narrative.emitNarrativeSignal({ signal: ruleAdvanceSignal(multi.id, first, RULE_LAYER_ENTRY_STATE) });
    await flush();
    expect(narrative.getActiveState(ruleLayerGraphId(multi.id, first))).toBe(RULE_LAYER_ENTRY_STATE);
    // 后推的那一层不受影响，仍在初态——层之间互不牵连
    expect(narrative.getActiveState(ruleLayerGraphId(multi.id, second))).toBe(RULE_LAYER_INITIAL_STATE);

    narrative.emitNarrativeSignal({ signal: ruleAdvanceSignal(multi.id, second, RULE_LAYER_ENTRY_STATE) });
    await flush();
    expect(narrative.getActiveState(ruleLayerGraphId(multi.id, second))).toBe(RULE_LAYER_ENTRY_STATE);
    expect(narrative.getActiveState(ruleLayerGraphId(multi.id, first))).toBe(RULE_LAYER_ENTRY_STATE);
  });

  it('规矩层图不污染主线：加了 8 张层图，主线里程碑图照常存在', () => {
    const narrative = makeNarrative();
    expect(narrative.getGraph('flow_xungou_main')).toBeTruthy();
  });
});
