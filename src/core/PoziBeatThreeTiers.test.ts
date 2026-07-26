/**
 * 婆子家第一单（③）三档结局 —— 真实 narrative_graphs.json + 真实 NarrativeStateManager。
 *
 * 这一拍是象/理/术玩法的第一个落地样本，本测试盯的是「三档必须真的不同，且都走得通」：
 *
 * - **硬上**（没读人，直接开腔）：也能办成，但口碑落到「糊弄过去」——
 *   不能因为玩家没掌握规矩就把这一拍锁死（那是把玩法变成门禁）
 * - **半档**（认出正主，话说破了）：口碑「半吊子」
 * - **上档**（认对人 + 话留口子）：口碑「办漂亮」
 *
 * 三档都必须把主线推到 s04_pozi —— 准备度换的是**结果品质**，不是通关与否。
 */
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraphsFile } from './NarrativeStateManager';
import narrativeGraphsData from '../../public/assets/data/narrative_graphs.json';

const FLOW = 'flow_xungou_main';
const SCENARIO = 'scenario_婆子家';
const REPUTATION = 'wrap_婆子家口碑';

function makeRuntime() {
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

async function emit(narrative: NarrativeStateManager, signal: string): Promise<void> {
  narrative.emitNarrativeSignal({ signal });
  await flush();
}

/** 把主线推到婆子家这一拍的前一格（吹牛完成）。 */
async function advanceToPozi(narrative: NarrativeStateManager): Promise<void> {
  for (const s of [
    'tingshu_kicked', 'beishi_hired', 'yamu_intro_entered', 'beishi_try1', 'beishi_try2',
    'beishi_scent', 'beishi_fled',
    'meng_road', 'meng_house', 'meng_ate', 'meng_clothed', 'meng_lying',
    'meng_paper_stopped', 'meng_tune', 'meng_woken',
    'chuiniu_seed', 'chuiniu_spread',
  ]) {
    await emit(narrative, s);
  }
}

describe('婆子家第一单 · 三档结局（真实数据）', () => {
  it('硬上：不读人也能办成，但口碑落到「糊弄过去」，主线照样推进', async () => {
    const narrative = makeRuntime();
    await advanceToPozi(narrative);

    await emit(narrative, 'pozi_hired');
    await emit(narrative, 'pozi_intro_entered');
    expect(narrative.getActiveState(SCENARIO)).toBe('at_courtyard');

    // 关键：at_courtyard 直接接 performed —— 没读人也有路可走
    await emit(narrative, 'pozi_performed');
    expect(narrative.getActiveState(SCENARIO)).toBe('performed');

    await emit(narrative, 'pozi_paid_blind');
    await emit(narrative, 'pozi_paid');

    expect(narrative.getActiveState(REPUTATION)).toBe('糊弄过去');
    expect(narrative.getActiveState(FLOW)).toBe('s04_pozi');
  });

  it('半档：读了人再开腔，口碑「半吊子」', async () => {
    const narrative = makeRuntime();
    await advanceToPozi(narrative);

    await emit(narrative, 'pozi_hired');
    await emit(narrative, 'pozi_intro_entered');
    await emit(narrative, 'pozi_read_pozi');
    await emit(narrative, 'pozi_read_son');
    await flush();
    // 两个都读了 → reactiveAll 自动汇到 read_all
    expect(narrative.getActiveState(SCENARIO)).toBe('read_all');

    await emit(narrative, 'pozi_performed');
    await emit(narrative, 'pozi_paid_half');
    await emit(narrative, 'pozi_paid');

    expect(narrative.getActiveState(REPUTATION)).toBe('半吊子');
    expect(narrative.getActiveState(FLOW)).toBe('s04_pozi');
  });

  it('上档：口碑「办漂亮」，主线同样到 s04_pozi', async () => {
    const narrative = makeRuntime();
    await advanceToPozi(narrative);

    await emit(narrative, 'pozi_hired');
    await emit(narrative, 'pozi_intro_entered');
    await emit(narrative, 'pozi_read_pozi');
    await emit(narrative, 'pozi_read_son');
    await flush();
    await emit(narrative, 'pozi_performed');
    await emit(narrative, 'pozi_paid_clean');
    await emit(narrative, 'pozi_paid');

    expect(narrative.getActiveState(REPUTATION)).toBe('办漂亮');
    expect(narrative.getActiveState(FLOW)).toBe('s04_pozi');
  });

  it('口碑图初态是「未办」，三档互斥、只落一个', async () => {
    const narrative = makeRuntime();
    expect(narrative.getActiveState(REPUTATION)).toBe('未办');

    await advanceToPozi(narrative);
    await emit(narrative, 'pozi_hired');
    await emit(narrative, 'pozi_intro_entered');
    await emit(narrative, 'pozi_performed');
    await emit(narrative, 'pozi_paid_clean');
    expect(narrative.getActiveState(REPUTATION)).toBe('办漂亮');
    // 后到的另一档不该再改口碑（三条边都只从「未办」出发）
    await emit(narrative, 'pozi_paid_blind');
    expect(narrative.getActiveState(REPUTATION)).toBe('办漂亮');
  });

  it('规矩「一屋子人先看谁看谁」的象由街巷斗嘴给出，不是这一拍白送', async () => {
    const narrative = makeRuntime();
    // 层图存在且初态未闻——没跟叫花子斗过嘴，就读不出院里的门道
    expect(narrative.getActiveState('rule_read_the_room__xiang')).toBe('未闻');
    await emit(narrative, 'rule:rule_read_the_room:xiang:未验');
    expect(narrative.getActiveState('rule_read_the_room__xiang')).toBe('未验');
  });
});

describe('婆子家 · 没学过规矩也进得去（象挡的是门道，不是门）', () => {
  it('无象时另有一条进院通路，事件不会卡死在 hired', async () => {
    const narrative = makeRuntime();
    await advanceToPozi(narrative);
    await emit(narrative, 'pozi_hired');
    expect(narrative.getActiveState(SCENARIO)).toBe('hired');

    // 「看不出门道」那个 zone 发的是同一个信号——照样进得了院坝
    await emit(narrative, 'pozi_intro_entered');
    expect(narrative.getActiveState(SCENARIO)).toBe('at_courtyard');
  });
});
