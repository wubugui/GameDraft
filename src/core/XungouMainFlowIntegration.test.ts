/**
 * 寻狗记Demo 主线编排集成测试：加载真实 narrative_graphs.json，
 * 按剧本顺序发出全部 beat 信号，断言每个 beat scenario 的状态推进与主线里程碑。
 * 状态生命周期里的演出类 Action（startCutscene 等）在本环境无 handler，仅告警跳过——
 * 这里验证的是编排逻辑本身（信号→迁移→广播→reactive 汇聚）。
 */
import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraphsFile } from './NarrativeStateManager';
import narrativeGraphsData from '../../public/assets/data/narrative_graphs.json';

const FLOW = 'flow_xungou_main';

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
  return { narrative };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('寻狗记Demo 主线编排（真实数据）', () => {
  it('从听书到出城黑屏：全信号序列推进 12 个里程碑', async () => {
    const { narrative } = makeRuntime();
    const emit = async (sourceType: string, sourceId: string, signal: string) => {
      narrative.emitNarrativeSignal({ sourceType: sourceType as never, sourceId, signal });
      await flush();
      await flush();
    };
    const flowAt = (s: string) => expect(narrative.getActiveState(FLOW)).toBe(s);
    const beatAt = (g: string, s: string) => expect(narrative.getActiveState(g)).toBe(s);

    flowAt('initial');

    // 0/① 听书 → 被赶
    await emit('dialogue', '寻狗_说书人', 'tingshu_words');
    beatAt('scenario_听书', 'words_collected');
    await emit('dialogue', '寻狗_说书人', 'face_ceng');
    beatAt('wrap_脸皮基调', 'ceng');
    await emit('dialogue', '寻狗_说书人', 'tingshu_kicked');
    beatAt('scenario_听书', 'kicked_out');
    flowAt('s01_tingshu');

    // ① 背尸：接活→进灵堂→两次发力→香粉→逃
    await emit('dialogue', '寻狗_庄家来人', 'beishi_hired');
    beatAt('scenario_背尸', 'hired');
    await emit('zone', '庄家灵堂:z_灵堂进场', 'lingtang_intro_entered');
    beatAt('scenario_背尸', 'at_lingtang');
    await emit('minigame', 'carry_bride_corpse', 'beishi_try1');
    await emit('minigame', 'carry_bride_corpse', 'beishi_try2');
    beatAt('scenario_背尸', 'try2_face');
    await emit('dialogue', '寻狗_背尸', 'beishi_scent');
    await emit('dialogue', '寻狗_背尸', 'beishi_fled');
    beatAt('scenario_背尸', 'fled');
    flowAt('s02_beishi');

    // ② 吹牛
    await emit('dialogue', '寻狗_茶馆吹牛', 'chuiniu_seed');
    await emit('dialogue', '寻狗_茶馆吹牛', 'chuiniu_spread');
    flowAt('s03_chuiniu');

    // ③ 婆子家：接单→进院→读人两个（reactiveAll 汇聚）→宣布→收钱
    await emit('dialogue', '寻狗_婆子', 'pozi_hired');
    await emit('zone', '婆子家院:z_院外扫脸色', 'pozi_intro_entered');
    beatAt('scenario_婆子家', 'at_courtyard');
    await emit('dialogue', '寻狗_读人_婆子', 'pozi_read_pozi');
    beatAt('scenario_婆子家', 'at_courtyard');
    await emit('dialogue', '寻狗_读人_儿子', 'pozi_read_son');
    beatAt('scenario_婆子家', 'read_all');
    await emit('dialogue', '寻狗_婆子家宣布', 'pozi_performed');
    await emit('dialogue', '寻狗_婆子家宣布', 'pozi_paid');
    flowAt('s04_pozi');

    // ④ 河边递纸
    await emit('dialogue', '寻狗_河边递纸', 'hebian_handed');
    await emit('dialogue', '寻狗_河边递纸', 'hebian_took');
    await emit('dialogue', '寻狗_河边递纸', 'hebian_realized');
    await emit('dialogue', '寻狗_河边递纸', 'hebian_fled');
    flowAt('s05_hebian');

    // ⑤ 码头：三选记忆 + 事了
    await emit('dialogue', '寻狗_码头选择', 'dock_chose_a');
    beatAt('wrap_码头选择', 'chose_a');
    await emit('dialogue', '寻狗_码头选择', 'dock_resolved');
    flowAt('s06_laoxiang');

    // ⑦ 枯井
    await emit('dialogue', '寻狗_枯井街坊', 'kujing_hired');
    await emit('zone', '枯井土地庙:z_井边哭声', 'kujing_intro_entered');
    await emit('dialogue', '寻狗_枯井往下看', 'kujing_looked');
    await emit('dialogue', '寻狗_枯井往下看', 'kujing_stared');
    await emit('dialogue', '寻狗_枯井往下看', 'kujing_fled');
    flowAt('s07_kujing');

    // ⑧ 向导+行头
    await emit('dialogue', '寻狗_向导传闻', 'xiangdao_notice_read');
    await emit('dialogue', '寻狗_围观竞争', 'xiangdao_watched');
    await emit('dialogue', '寻狗_围观竞争', 'outfit_bought');
    beatAt('scenario_向导', 'outfitted');
    flowAt('s08_xiangdao');

    // ⑨ 送货+夜路喊名
    await emit('dialogue', '寻狗_送货雇主', 'songhuo_bundle_taken');
    await emit('zone', '阎王岭山口:z_同行闲扯', 'songhuo_road_entered');
    await emit('dialogue', '寻狗_送包袱到棚', 'songhuo_delivered');
    await emit('dialogue', '寻狗_看进山路', 'songhuo_gazed');
    await emit('minigame', 'forest_name_call', 'songhuo_call1');
    await emit('minigame', 'forest_name_call', 'songhuo_call2');
    beatAt('scenario_送货', 'night_call2');
    await emit('minigame', 'forest_name_call', 'songhuo_survived');
    await emit('dialogue', '寻狗_看进山路', 'songhuo_returned');
    flowAt('s09_songhuo');

    // ⑩ 义庄镇尸：进门 + 四步任意顺序（reactive：动手→任2步反扑→4步齐）
    await emit('zone', '义庄:z_义庄进门', 'yizhuang_intro_entered');
    beatAt('scenario_义庄镇尸', 'entered');
    await emit('dialogue', '寻狗_镇尸_墨斗', 'zhenshi_ink_done');
    await flush();
    beatAt('scenario_义庄镇尸', 'in_progress');
    await emit('dialogue', '寻狗_镇尸_剪子', 'zhenshi_scissors_done');
    await flush();
    beatAt('scenario_义庄镇尸', 'two_done');
    await emit('dialogue', '寻狗_镇尸_撒米', 'zhenshi_rice_done');
    await flush();
    beatAt('scenario_义庄镇尸', 'two_done');
    await emit('dialogue', '寻狗_镇尸_石子', 'zhenshi_stone_done');
    await flush();
    await flush();
    beatAt('scenario_义庄镇尸', 'all_done');
    flowAt('s10_yizhuang');

    // ⑩尾 招募 / ⑪ 守夜支线 / ⑫ 终幕
    await emit('dialogue', '寻狗_克拉拉招募', 'zhaomu_recruited');
    flowAt('s11_zhaomu');

    await emit('zone', '城隍庙夜:z_守夜进庙', 'shouye_intro_entered');
    await emit('dialogue', '寻狗_守夜续油', 'shouye_oil_added');
    await emit('dialogue', '寻狗_守夜坐下', 'shouye_lamp_steady');
    await emit('dialogue', '寻狗_守夜坐下', 'shouye_sit_done');
    beatAt('wrap_守夜', 'done');

    await emit('dialogue', '寻狗_城门汇合', 'chufa_departed');
    flowAt('s12_chufa');

    // reached 历史完整（任务面板/档案门控依赖）
    for (const s of ['s01_tingshu', 's04_pozi', 's07_kujing', 's10_yizhuang', 's12_chufa']) {
      expect(narrative.hasReachedState(FLOW, s)).toBe(true);
    }
  });

  it('乱序信号不越级：跳过中间 beat 的出口信号不推动主线', async () => {
    const { narrative } = makeRuntime();
    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'x', signal: 'chuiniu_spread' });
    await flush();
    expect(narrative.getActiveState(FLOW)).toBe('initial');
    expect(narrative.getActiveState('scenario_吹牛')).toBe('not_started');
  });
});
