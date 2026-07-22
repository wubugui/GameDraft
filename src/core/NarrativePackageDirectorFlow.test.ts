/**
 * 导演 + 真实 narrative_graphs.json + 真实 narrative_packages.json，按剧本驱动主线信号。
 * ⚠2026-07-19 降级后：章节包=纯组织标签、不 gate 行为。故本测试验两件正交的事：
 *  ① 导演按里程碑维护对的"当前活跃章节"标记集（getLivePackages，组织/工具用）；
 *  ② 主线信号照常推进（与标记无关——背尸→梦握手成立是因为图恒吃信号，不是因为梦被标活跃）。
 * 换言之 live()/getActiveState 两组断言测的是"导演跟踪对不对"和"信号流通不通"两条独立链。
 */
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraphsFile } from './NarrativeStateManager';
import { NarrativePackageDirector } from '../systems/NarrativePackageDirector';
import narrativeGraphsData from '../../public/assets/data/narrative_graphs.json';
import narrativePackagesData from '../../public/assets/data/narrative_packages.json';

const FLOW = 'flow_xungou_main';

async function makeWorld() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
  const ctxFactory = () => ({
    flagStore,
    questManager: { getStatus: () => 0 } as never,
    scenarioState: {} as never,
    narrativeState: narrative,
  });
  narrative.setConditionEvalContextFactory(ctxFactory);
  narrative.registerGraphs(compileNarrativeGraphs(narrativeGraphsData as unknown as NarrativeGraphsFile));

  const director = new NarrativePackageDirector(eventBus);
  director.setConditionEvalContextFactory(ctxFactory);
  director.setControl({
    setNarrativePackageLive: (pkg, live) => narrative.setNarrativePackageLive(pkg, live),
    isNarrativePackageLive: (pkg) => narrative.isNarrativePackageLive(pkg),
  });
  director.init({
    eventBus, flagStore,
    strings: { get: (_c: string, k: string) => k },
    assetManager: { loadJson: async () => narrativePackagesData },
  } as never);
  await director.loadDefs();
  return { eventBus, narrative, director };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('C4 导演驱动全主线拆包（真实数据）', () => {
  it('每拍章节包由导演按里程碑 load/unload；背尸→梦握手成立；dormant 后状态永存', async () => {
    const { eventBus, narrative, director } = await makeWorld();
    const emit = async (sourceType: string, sourceId: string, signal: string) => {
      narrative.emitNarrativeSignal({ sourceType: sourceType as never, sourceId, signal });
      await flush(); await flush(); await flush();
    };
    const live = () => narrative.getLivePackages();

    // 开局：无章节被标活跃（导演还没评估）；里程碑 initial
    expect(narrative.getActiveState(FLOW)).toBe('initial');
    expect(live()).toEqual([]);

    // 听书：进茶馆点亮章节_听书（scene 行），演完 kicked_out→里程碑 s01
    eventBus.emit('scene:revealed', { sceneId: 'teahouse' });
    await flush(); await flush();
    expect(live()).toContain('章节_听书');
    await emit('dialogue', '寻狗_听书开场', 'tingshu_kicked');
    expect(narrative.getActiveState('scenario_听书')).toBe('kicked_out');
    expect(narrative.getActiveState(FLOW)).toBe('s01_tingshu');
    // 里程碑到 s01 → 导演卸听书、载背尸+梦（梦 when=s01 与背尸重叠）
    expect(live()).not.toContain('章节_听书');
    expect(live()).toContain('章节_背尸');
    expect(live()).toContain('章节_梦');

    // 背尸：跑到 fled。梦接住 state:scenario_背尸:fled 握手（图恒吃信号，与梦是否被标活跃无关）
    await emit('dialogue', '寻狗_庄家来人', 'beishi_hired');
    await emit('zone', '崖墓:z_崖墓进场', 'yamu_intro_entered');
    await emit('minigame', 'carry_bride_corpse', 'beishi_try1');
    await emit('minigame', 'carry_bride_corpse', 'beishi_try2');
    await emit('dialogue', '寻狗_背尸', 'beishi_scent');
    await emit('dialogue', '寻狗_鬼打墙', 'beishi_fled');
    expect(narrative.getActiveState('scenario_背尸')).toBe('fled');
    expect(narrative.getActiveState(FLOW)).toBe('s02_beishi');
    // 梦接住 fled → 梦子图开到 road（不是停在 not_started）——包不 gate，故必然接住
    expect(narrative.getActiveState('scenario_梦待死之礼')).toBe('road');
    // 里程碑越过 s02 → 导演把章节_背尸标非活跃；梦仍标活跃（未到 s02b）——纯跟踪，不影响状态
    expect(live()).not.toContain('章节_背尸');
    expect(live()).toContain('章节_梦');

    // 梦：跑到 woken → 里程碑 s02b → 卸梦、载吹牛
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_house');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_ate');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_clothed');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_lying');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_paper_stopped');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_tune');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_woken');
    expect(narrative.getActiveState(FLOW)).toBe('s02b_meng');
    expect(live()).not.toContain('章节_梦');
    expect(live()).toContain('章节_吹牛');
    // 状态永存（本就与标记无关）：早已标非活跃的背尸/听书状态照样查得到
    expect(narrative.getActiveState('scenario_背尸')).toBe('fled');
    expect(narrative.hasReachedState('scenario_听书', 'kicked_out')).toBe(true);

    director.destroy();
  });
});
