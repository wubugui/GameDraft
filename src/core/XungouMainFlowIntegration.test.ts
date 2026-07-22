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

async function makeRuntime() {
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
  // ⚠2026-07-19 降级后：章节包=纯组织标签、不 gate 信号接收，故**无需加载任何包**——
  // 全部子图注册即恒吃信号。本测试完全不碰 setNarrativePackageLive 却能全主线走通，
  // 正是"包不承担运行时正确性"的活证明（对比降级前须一次点亮全部包才不冻结第一拍）。
  return { narrative };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('寻狗记Demo 主线编排（真实数据）', () => {
  it('从听书到出城黑屏：全信号序列推进 11 个主线里程碑（枯井/义庄已降支线，含①.5梦）', async () => {
    const { narrative } = await makeRuntime();
    const emit = async (sourceType: string, sourceId: string, signal: string) => {
      narrative.emitNarrativeSignal({ sourceType: sourceType as never, sourceId, signal });
      await flush();
      await flush();
    };
    const flowAt = (s: string) => expect(narrative.getActiveState(FLOW)).toBe(s);
    const beatAt = (g: string, s: string) => expect(narrative.getActiveState(g)).toBe(s);

    flowAt('initial');

    // 0/① 听书开场（说书cutscene→掐架）→ 被赶
    await emit('dialogue', '寻狗_听书开场', 'tingshu_kicked');
    beatAt('scenario_听书', 'kicked_out');
    flowAt('s01_tingshu');

    // ① 背尸：接活→进崖墓→两次发力→香粉→逃
    await emit('dialogue', '寻狗_庄家来人', 'beishi_hired');
    beatAt('scenario_背尸', 'hired');
    await emit('zone', '崖墓:z_崖墓进场', 'yamu_intro_entered');
    beatAt('scenario_背尸', 'at_yamu');
    await emit('minigame', 'carry_bride_corpse', 'beishi_try1');
    await emit('minigame', 'carry_bride_corpse', 'beishi_try2');
    beatAt('scenario_背尸', 'try2_face');
    await emit('dialogue', '寻狗_背尸', 'beishi_scent');
    await emit('dialogue', '寻狗_鬼打墙', 'beishi_fled');
    beatAt('scenario_背尸', 'fled');
    flowAt('s02_beishi');

    // ①.5 梦·待死之礼：背尸 fled 后 reactive 自动开梦门（躲藏昏睡）
    beatAt('scenario_梦待死之礼', 'road');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_house');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_ate');
    beatAt('scenario_梦待死之礼', 'fed');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_clothed');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_lying');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_paper_stopped');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_tune');
    beatAt('scenario_梦待死之礼', 'tune_trembled');
    await emit('dialogue', '寻狗_梦待死之礼', 'meng_woken');
    beatAt('scenario_梦待死之礼', 'woken');
    flowAt('s02b_meng');

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

    // ⑦ 枯井（已降为可选支线：信号可发、scenario 自行推进，但不再推动主线）
    await emit('dialogue', '寻狗_枯井街坊', 'kujing_hired');
    await emit('zone', '枯井土地庙:z_井边哭声', 'kujing_intro_entered');
    await emit('dialogue', '寻狗_枯井往下看', 'kujing_looked');
    await emit('dialogue', '寻狗_枯井往下看', 'kujing_stared');
    await emit('dialogue', '寻狗_枯井往下看', 'kujing_fled');
    beatAt('scenario_枯井', 'fled');
    flowAt('s06_laoxiang'); // 枯井是支线，主线仍停在码头

    // ⑧ 向导+行头
    await emit('dialogue', '寻狗_向导传闻', 'xiangdao_notice_read');
    await emit('dialogue', '寻狗_围观竞争', 'xiangdao_watched');
    await emit('dialogue', '寻狗_围观竞争', 'outfit_bought');
    beatAt('scenario_向导', 'outfitted');
    flowAt('s08_xiangdao');

    // ⑨ 送货+林中喊名（两段式：去程 X①半脚本+②③选择写账，回程按账还）
    await emit('dialogue', '寻狗_送货雇主', 'songhuo_bundle_taken');
    await emit('zone', '阎王岭山口:z_同行闲扯', 'songhuo_road_entered');
    await emit('zone', '阎王岭山口:z_X点一', 'hanming_x1_reached');
    beatAt('scenario_送货', 'x1_called'); // 半脚本必经：保底账挂上
    await emit('dialogue', '寻狗_喊名_点二', 'hanming_x2_wrong');
    await emit('dialogue', '寻狗_喊名_点二', 'hanming_x2_done');
    beatAt('wrap_喊名_点二', 'wrong');
    beatAt('scenario_送货', 'x2_resolved');
    await emit('zone', '阎王岭山口:z_越点三', 'hanming_x3_skipped');
    await emit('zone', '阎王岭山口:z_越点三', 'hanming_x3_done');
    beatAt('wrap_喊名_点三', 'skipped'); // 走过去就是答案
    await emit('dialogue', '寻狗_送包袱到棚', 'songhuo_delivered');
    await emit('dialogue', '寻狗_看进山路', 'songhuo_gazed');
    await emit('dialogue', '寻狗_看进山路', 'hanming_ret_p3');
    await emit('dialogue', '寻狗_看进山路', 'hanming_awakening');
    beatAt('wrap_喊名_恍然', 'done');
    await emit('dialogue', '寻狗_看进山路', 'hanming_ret_p2');
    await emit('dialogue', '寻狗_看进山路', 'hanming_ret_p1');
    await emit('dialogue', '寻狗_看进山路', 'hanming_climax');
    beatAt('scenario_送货', 'climax');
    await emit('minigame', 'forest_name_call', 'songhuo_survived');
    beatAt('scenario_送货', 'survived');
    await emit('dialogue', '寻狗_看进山路', 'songhuo_returned');
    beatAt('scenario_送货', 'litiangou_peril');
    await emit('scenario', '寻狗_送货', 'songhuo_litiangou_rescue');
    beatAt('scenario_送货', 'litiangou_rescue');
    await emit('scenario', '寻狗_送货', 'songhuo_returned');
    beatAt('scenario_送货', 'returned');
    flowAt('s09_songhuo');

    // ⑩ 义庄镇尸（已降为可选支线：四步可跑完，但不推主线）：进门 + 四步任意顺序
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
    flowAt('s09_songhuo'); // 义庄已降支线，主线仍在送货完成

    // ⑩尾 招募（送货回城后直接触发，不再经义庄）/ ⑪ 守夜支线 / ⑫ 终幕
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
    for (const s of ['s01_tingshu', 's02b_meng', 's04_pozi', 's12_chufa']) {
      expect(narrative.hasReachedState(FLOW, s)).toBe(true);
    }
  });

  it('乱序信号不越级：跳过中间 beat 的出口信号不推动主线', async () => {
    const { narrative } = await makeRuntime();
    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'x', signal: 'chuiniu_spread' });
    await flush();
    expect(narrative.getActiveState(FLOW)).toBe('initial');
    expect(narrative.getActiveState('scenario_吹牛')).toBe('not_started');
  });

  it('梦·待死之礼乱序保护：背尸未逃，梦门不开', async () => {
    const { narrative } = await makeRuntime();
    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'x', signal: 'meng_ate' });
    await flush();
    expect(narrative.getActiveState('scenario_梦待死之礼')).toBe('not_started');
    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'x', signal: 'meng_woken' });
    await flush();
    expect(narrative.getActiveState(FLOW)).toBe('initial');
  });
});

describe('林中喊名 两段式分支（真实数据）', () => {
  type Pick = 'right' | 'wrong' | 'skipped';

  async function driveToClimax(x2: Pick, x3: Pick) {
    const { narrative } = await makeRuntime();
    const emit = async (sourceType: string, sourceId: string, signal: string) => {
      narrative.emitNarrativeSignal({ sourceType: sourceType as never, sourceId, signal });
      await flush();
      await flush();
    };
    await emit('dialogue', '寻狗_送货雇主', 'songhuo_bundle_taken');
    await emit('zone', '阎王岭山口:z_同行闲扯', 'songhuo_road_entered');
    await emit('zone', '阎王岭山口:z_X点一', 'hanming_x1_reached');
    await emit('dialogue', '寻狗_喊名_点二', `hanming_x2_${x2}`);
    await emit('dialogue', '寻狗_喊名_点二', 'hanming_x2_done');
    await emit('dialogue', '寻狗_喊名_点三', `hanming_x3_${x3}`);
    await emit('dialogue', '寻狗_喊名_点三', 'hanming_x3_done');
    await emit('dialogue', '寻狗_送包袱到棚', 'songhuo_delivered');
    await emit('dialogue', '寻狗_看进山路', 'songhuo_gazed');
    await emit('dialogue', '寻狗_看进山路', 'hanming_ret_p3');
    await emit('dialogue', '寻狗_看进山路', 'hanming_ret_p2');
    await emit('dialogue', '寻狗_看进山路', 'hanming_ret_p1');
    await emit('dialogue', '寻狗_看进山路', 'hanming_climax');
    return { narrative, emit };
  }

  it('②③选择九宫格：全部组合都汇入认不准关口，点①保底账必经', async () => {
    const picks: Pick[] = ['right', 'wrong', 'skipped'];
    for (const x2 of picks) {
      for (const x3 of picks) {
        const { narrative } = await driveToClimax(x2, x3);
        expect(narrative.getActiveState('scenario_送货')).toBe('climax');
        expect(narrative.getActiveState('wrap_喊名_点二')).toBe(x2);
        expect(narrative.getActiveState('wrap_喊名_点三')).toBe(x3);
        // 半脚本保底：无论怎么选，点①必经（回程那一声必兑现的图结构前提）
        expect(narrative.hasReachedState('scenario_送货', 'x1_called')).toBe(true);
      }
    }
  });

  it('忍住分支：撑过认不准 → 散开 → 回城收束', async () => {
    const { narrative, emit } = await driveToClimax('right', 'right');
    await emit('minigame', 'forest_name_call', 'songhuo_survived');
    expect(narrative.getActiveState('scenario_送货')).toBe('survived');
    await emit('dialogue', '寻狗_看进山路', 'songhuo_returned');
    expect(narrative.getActiveState('scenario_送货')).toBe('litiangou_peril');
    await emit('scenario', '寻狗_送货', 'songhuo_litiangou_rescue');
    expect(narrative.getActiveState('scenario_送货')).toBe('litiangou_rescue');
    await emit('scenario', '寻狗_送货', 'songhuo_returned');
    expect(narrative.getActiveState('scenario_送货')).toBe('returned');
    expect(narrative.hasReachedState('scenario_送货', 'answered')).toBe(false);
  });

  it('应声分支：失败不卡关，逃出后照样回城收束（创伤留痕）', async () => {
    const { narrative, emit } = await driveToClimax('skipped', 'skipped');
    await emit('minigame', 'forest_name_call', 'hanming_answered');
    expect(narrative.getActiveState('scenario_送货')).toBe('answered');
    await emit('minigame', 'forest_escape_run', 'hanming_escaped');
    expect(narrative.getActiveState('scenario_送货')).toBe('escaped');
    await emit('dialogue', '寻狗_看进山路', 'songhuo_returned');
    expect(narrative.getActiveState('scenario_送货')).toBe('litiangou_peril');
    await emit('scenario', '寻狗_送货', 'songhuo_litiangou_rescue');
    expect(narrative.getActiveState('scenario_送货')).toBe('litiangou_rescue');
    await emit('scenario', '寻狗_送货', 'songhuo_returned');
    expect(narrative.getActiveState('scenario_送货')).toBe('returned');
    // 创伤留痕：reached 历史可供 ⑫ 终幕回放/外围文本取变体
    expect(narrative.hasReachedState('scenario_送货', 'answered')).toBe(true);
    expect(narrative.hasReachedState('scenario_送货', 'survived')).toBe(false);
  });

  it('越点线即不喊：zone 越线信号与热点选择互斥收敛', async () => {
    const { narrative } = await makeRuntime();
    const emit = async (sourceType: string, sourceId: string, signal: string) => {
      narrative.emitNarrativeSignal({ sourceType: sourceType as never, sourceId, signal });
      await flush();
      await flush();
    };
    await emit('dialogue', '寻狗_送货雇主', 'songhuo_bundle_taken');
    await emit('zone', '阎王岭山口:z_同行闲扯', 'songhuo_road_entered');
    await emit('zone', '阎王岭山口:z_X点一', 'hanming_x1_reached');
    // 玩家没去林边，直接越线：wrap 记 skipped，scenario 照常推进
    await emit('zone', '阎王岭山口:z_越点二', 'hanming_x2_skipped');
    await emit('zone', '阎王岭山口:z_越点二', 'hanming_x2_done');
    expect(narrative.getActiveState('wrap_喊名_点二')).toBe('skipped');
    expect(narrative.getActiveState('scenario_送货')).toBe('x2_resolved');
    // 越线后补喊不算数：wrap 已收敛，迟到的选择信号不再改写
    await emit('dialogue', '寻狗_喊名_点二', 'hanming_x2_right');
    expect(narrative.getActiveState('wrap_喊名_点二')).toBe('skipped');
  });
});
