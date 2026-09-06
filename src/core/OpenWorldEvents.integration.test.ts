import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraphsFile } from './NarrativeStateManager';
import { InventoryManager } from '../systems/InventoryManager';
import { RulesManager } from '../systems/RulesManager';
import ruleData from '../../public/assets/data/rules.json';
import { QuestManager } from '../systems/QuestManager';
import { DayManager } from '../systems/DayManager';
import { ArchiveManager } from '../systems/ArchiveManager';
import { TEXT_URLS } from './projectPaths';
import archiveCharacters from '../../public/assets/data/archive/characters.json';
import archiveLore from '../../public/assets/data/archive/lore.json';
import archiveSlang from '../../public/assets/data/archive/slang.json';
import archiveRhymes from '../../public/assets/data/archive/rhymes.json';
import archiveDocuments from '../../public/assets/data/archive/documents.json';
import archiveBooks from '../../public/assets/data/archive/books.json';
import { NpcScheduleSystem } from '../systems/NpcScheduleSystem';
import { evaluateConditionExpr } from '../systems/graphDialogue/evaluateGraphCondition';
import { QuestStatus, type ActionDef, type ConditionExpr, type ItemDef, type QuestDef } from '../data/types';
import graphs from '../../public/assets/data/narrative_graphs.json';
import items from '../../public/assets/data/items.json';
import quests from '../../public/assets/data/quests.json';
import schedules from '../../public/assets/data/npc_schedules.json';
import coatExamine from '../../public/assets/data/object_examine/ow_shore_coat.json';
import watchExamine from '../../public/assets/data/object_examine/ow_watch_bench.json';
import watchWater from '../../public/assets/data/water_minigames/ow_watch_clapper.json';
import watchNight from '../../public/assets/data/water_minigames/ow_watch_clapper_night.json';
import watchDialogue from '../../public/assets/dialogues/graphs/开放世界_巡更.json';
import paperCraft from '../../public/assets/data/paper_craft/ow_paper_remake.json';
import paperExamine from '../../public/assets/data/object_examine/ow_paper_frame.json';
import stoveExamine from '../../public/assets/data/object_examine/ow_noodle_stove.json';
import sugarWheel from '../../public/assets/data/sugar_wheel/ow_sugar.json';

// Real authored data, real economy handlers, real state transitions. This is
// causal/resource acceptance; movement and posture require separate game input QA.
const TALLY = 'flow_ow_tally';
const KNIFE = 'flow_ow_knife';
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('章节事件：糖画、孩子目击与识字', () => {
  it.each(['ticket', 'cash'])('%s 支付只在发射扣一次，未停针存读可续，实际格子定形', async method => {
    const r = await runtime();
    r.inventory.addCoins(2);
    if (method === 'ticket') {
      await r.signal('ow_ring_take'); await r.signal('ow_ring_return');
    }
    await r.signal('ow_sugar_accept');
    expect(r.inventory.getCoins()).toBe(2); // Entering and cancelling before launch is free.
    for (const action of sugarWheel.beforeChargePassActions) await r.executor.executeAwait(action);
    await flush();
    expect(r.inventory.getCoins()).toBe(method === 'ticket' ? 2 : 1);
    expect(r.inventory.hasItem('ow_sugar_ticket')).toBe(false);
    const loaded = await runtime();
    loaded.inventory.deserialize(r.inventory.serialize() as Parameters<InventoryManager['deserialize']>[0]);
    loaded.narrative.deserialize(r.narrative.serialize());
    await loaded.signal('ow_sugar_launch');
    for (const action of sugarWheel.sectors.find(s => s.id === 'butterfly')!.actionsOnSpinLanding) await loaded.executor.executeAwait(action);
    await flush();
    expect(loaded.inventory.getItemCount('ow_sugar_prize')).toBe(1);
    expect(loaded.narrative.getActiveState('flow_ow_sugar_shape')).toBe('butterfly');
    expect(loaded.narrative.getActiveState('flow_ow_sugar')).toBe('holding');
    expect(loaded.inventory.getCoins()).toBe(method === 'ticket' ? 2 : 1);
    await loaded.signal('ow_sugar_launch'); await loaded.signal('ow_sugar_land_dragon');
    expect(loaded.inventory.getItemCount('ow_sugar_prize')).toBe(1);
    expect(loaded.narrative.getActiveState('flow_ow_sugar_shape')).toBe('butterfly');
    expect(evaluateConditionExpr(sugarWheel.beforeChargeCondition as ConditionExpr, loaded.context())).toBe(false);
  });

  it('无钱、闭摊不能空领奖；吃糖留的木签实际挑闩，只耗签、不耗篾', async () => {
    const r = await runtime();
    await r.signal('ow_sugar_launch'); await r.signal('ow_sugar_land_dragon');
    expect(r.inventory.hasItem('ow_sugar_prize')).toBe(false);
    r.inventory.addCoins(1); r.flags.set('minutes_of_day', 1200);
    await r.signal('ow_sugar_launch');
    expect(r.inventory.getCoins()).toBe(1);
    r.flags.set('minutes_of_day', 660);
    await r.signal('ow_sugar_launch'); await r.signal('ow_sugar_land_carp');
    const use = r.inventory.resolveItemUse('ow_sugar_prize')!;
    expect(use.enabled).toBe(true);
    for (const action of use.actions) await r.executor.executeAwait(action);
    await flush(); await r.signal('ow_sugar_eat'); await r.signal('ow_sugar_give');
    expect(r.inventory.getItemCount('ow_sugar_stick')).toBe(1);
    expect(r.inventory.hasItem('ow_sugar_prize')).toBe(false);
    expect(r.narrative.getActiveState('flow_ow_sugar')).toBe('eaten');
    expect(r.day.minutesOfDay).toBe(665);
    await r.signal('ow_bolt_stick');
    expect(r.inventory.hasItem('ow_sugar_stick')).toBe(true);
    r.inventory.addItem('ow_bamboo'); await r.signal('ow_bolt_look');
    await r.signal('ow_bolt_stick'); await r.signal('ow_bolt_stick'); await r.signal('ow_bolt_pry');
    expect(r.inventory.getItemCount('ow_wood_wedge')).toBe(1);
    expect(r.inventory.hasItem('ow_sugar_stick')).toBe(false);
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.qm.getStatus('ow_sugar')).toBe(QuestStatus.Completed);
  });

  it.each(['hook', 'gift'])('%s 可独立获得目击；还需亲眼看补丁，且不能冒充借衣解释', async method => {
    const r = await runtime();
    await r.signal('ow_child_witness');
    expect(r.narrative.getActiveState('flow_ow_child_witness')).toBe('initial');
    if (method === 'hook') {
      await r.signal('ow_ring_take'); await r.signal('ow_ring_take');
      expect(r.inventory.getItemCount('ow_ring_hook')).toBe(1);
      await r.signal('ow_ring_return'); await r.signal('ow_ring_return');
      expect(r.inventory.getItemCount('ow_sugar_ticket')).toBe(1);
    } else {
      r.inventory.addCoins(1); await r.signal('ow_sugar_launch');
      await r.signal('ow_sugar_land_bird'); await r.signal('ow_sugar_give');
      expect(r.inventory.hasItem('ow_sugar_prize')).toBe(false);
      expect(r.narrative.getActiveState('flow_ow_ring_hook')).toBe('initial');
    }
    await r.signal('ow_child_witness'); await r.signal('ow_coat_accept'); await r.signal('ow_coat_keep');
    expect(r.inventory.hasItem('ow_work_coat')).toBe(false);
    r.inventory.addItem('ow_bucket'); r.inventory.addItem('ow_cloth'); await r.signal('ow_coat_mend');
    expect(r.inventory.hasItem('ow_shoulder_pad')).toBe(false);
    await r.signal('ow_coat_patch'); await r.signal('ow_coat_keep');
    expect(r.inventory.getItemCount('ow_work_coat')).toBe(1);
    expect(r.narrative.getActiveState('flow_ow_coat_borrower')).toBe('initial');
    expect(r.narrative.getActiveState('flow_ow_tally')).toBe('initial');
  });

  it.each(['luo', 'monk'])('%s 念残纸才有文献与炭，另一人不重复发物', async reader => {
    const r = await runtime(true);
    try {
      await r.signal('ow_notice_read_' + reader);
      expect(r.inventory.getItemCount('ow_charcoal')).toBe(0);
      await r.signal('ow_notice_take'); await r.signal('ow_notice_take');
      expect(r.inventory.getItemCount('ow_notice_scrap')).toBe(1);
      await r.signal('ow_notice_read_' + reader);
      await r.signal('ow_notice_read_' + (reader === 'luo' ? 'monk' : 'luo'));
      expect(r.inventory.hasItem('ow_notice_scrap')).toBe(false);
      expect(r.inventory.getItemCount('ow_charcoal')).toBe(1);
      expect(r.flags.get('archive_document_doc_ow_notice_' + reader)).toBe(true);
      expect(r.qm.getStatus('ow_notice')).toBe(QuestStatus.Completed);
      await r.signal('ow_water_mark');
      expect(r.inventory.getItemCount('ow_charcoal')).toBe(1); // Reading cannot stand in for inspecting the waterline.
      expect(r.narrative.getActiveState('flow_ow_water_mark')).toBe('initial');
    } finally { r.archive?.destroy(); }
  });
});

describe('章节事件：街灶、共用浆炉与饭包', () => {
  it.each([['ash', 'foot'], ['foot', 'ash']])('检视换序 %s/%s，第一份修料锁定修灶，试火才结算', async (first, second) => {
    const r = await runtime();
    await r.signal('ow_stove_accept');
    await r.signal('ow_stove_fire');
    expect(r.narrative.getActiveState('flow_ow_stove')).toBe('accepted');
    r.inventory.addItem('ow_bamboo', 2); r.inventory.addItem('ow_wood_wedge'); r.inventory.addItem('ow_charcoal', 2);
    const use = async (id: string) => {
      for (const a of stoveExamine.hotspots.find(h => h.id === id)!.itemUses![0].actions) await r.executor.executeAwait(a);
      await flush();
    };
    await use(first); await r.signal('ow_stove_borrow');
    expect(r.inventory.hasItem('ow_cold_rice_pot')).toBe(false);
    expect(r.qm.getCurrentObjective('ow_stove')?.id).toBe('stove_repair_obj');
    await use(second); await use(first); await use(second);
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.inventory.getItemCount('ow_wood_wedge')).toBe(0);
    expect(r.inventory.getCoins()).toBe(0);
    expect(r.qm.getCurrentObjective('ow_stove')?.id).toBe('stove_fire_obj');
    await r.signal('ow_stove_fire'); await r.signal('ow_stove_fire');
    expect(r.inventory.getItemCount('ow_charcoal')).toBe(1);
    expect(r.inventory.getItemCount('ow_meal_voucher')).toBe(1);
    expect(r.inventory.getCoins()).toBe(6);
    expect(r.day.minutesOfDay).toBe(690);
    expect(r.qm.getStatus('ow_stove')).toBe(QuestStatus.Completed);
  });

  it('冷锅可原路取消；未备桶不空扣，煮熟后不能回退或修两遍', async () => {
    const r = await runtime();
    await r.signal('ow_stove_borrow'); await r.signal('ow_stove_borrow');
    expect(r.inventory.getItemCount('ow_cold_rice_pot')).toBe(1);
    await r.signal('ow_stove_cook');
    expect(r.inventory.getItemCount('ow_cold_rice_pot')).toBe(1);
    expect(r.day.minutesOfDay).toBe(660);
    await r.signal('ow_stove_cancel');
    expect(r.inventory.hasItem('ow_cold_rice_pot')).toBe(false);
    expect(r.narrative.getActiveState('flow_ow_stove')).toBe('accepted');
    await r.signal('ow_stove_borrow'); r.inventory.addItem('ow_bucket');
    await r.signal('ow_stove_cook'); await r.signal('ow_stove_cancel');
    r.inventory.addItem('ow_bamboo'); r.inventory.addItem('ow_wood_wedge');
    await r.signal('ow_stove_clear'); await r.signal('ow_stove_wedge');
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.inventory.getItemCount('ow_wood_wedge')).toBe(1);
    expect(r.narrative.getActiveState('flow_ow_stove')).toBe('cooking');
    await r.signal('ow_stove_collect'); await r.signal('ow_stove_collect');
    expect(r.inventory.getItemCount('ow_hot_rice_pot')).toBe(1);
    await r.signal('ow_stove_deliver'); await r.signal('ow_stove_deliver');
    expect(r.inventory.hasItem('ow_hot_rice_pot')).toBe(false);
    expect(r.inventory.getItemCount('ow_bucket')).toBe(1);
    expect(r.inventory.getItemCount('ow_meal_voucher')).toBe(1);
    expect(r.inventory.getCoins()).toBe(0);
    expect(r.day.minutesOfDay).toBe(685);
  });

  it('真实饭锅占用阻止 S11，存读仍阻止，提锅后熬浆恢复且桶保留', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_bucket'); r.inventory.addItem('nuomi', 2);
    await r.signal('ow_stove_borrow'); await r.signal('ow_stove_cook');
    const loaded = await runtime();
    loaded.inventory.deserialize(r.inventory.serialize() as Parameters<InventoryManager['deserialize']>[0]);
    loaded.narrative.deserialize(r.narrative.serialize());
    loaded.day.deserialize(r.day.serialize() as Parameters<DayManager['deserialize']>[0]);
    await loaded.signal('ow_paste_cook');
    expect(loaded.inventory.getItemCount('nuomi')).toBe(2);
    expect(loaded.inventory.hasItem('ow_paste')).toBe(false);
    expect(loaded.qm.getCurrentObjective('ow_stove')?.id).toBe('stove_collect_obj');
    await loaded.signal('ow_stove_collect'); await loaded.signal('ow_paste_cook');
    expect(loaded.inventory.getItemCount('nuomi')).toBe(1);
    expect(loaded.inventory.getItemCount('ow_paste')).toBe(1);
    expect(loaded.inventory.getItemCount('ow_bucket')).toBe(1);
    expect(loaded.inventory.getItemCount('ow_hot_rice_pot')).toBe(1);
    expect(loaded.day.minutesOfDay).toBe(695);
  });

  it.each(['cash', 'voucher'])('饭包用 %s 取得再通过真实物品 use 吃掉，满包不掉进度、不重复扣付', async method => {
    const r = await runtime();
    r.inventory.addCoins(3); r.inventory.addItem('ow_meal_voucher');
    // Fill ordinary slots; authored critical output must still arrive.
    for (const i of items) r.inventory.addItem(i.id);
    r.inventory.removeItem('ow_travel_meal', 99); r.inventory.removeItem('ow_clean_wrapper', 99);
    await r.signal(method === 'cash' ? 'ow_meal_buy' : 'ow_meal_redeem');
    await r.signal('ow_meal_buy'); await r.signal('ow_meal_redeem');
    expect(r.inventory.getItemCount('ow_travel_meal')).toBe(1);
    expect(r.inventory.getCoins()).toBe(method === 'cash' ? 0 : 3);
    const use = r.inventory.resolveItemUse('ow_travel_meal')!;
    expect(use.enabled).toBe(true); expect(use.consume).toBe(false);
    for (const a of use.actions) await r.executor.executeAwait(a);
    await flush(); await r.signal('ow_meal_eat');
    expect(r.inventory.hasItem('ow_travel_meal')).toBe(false);
    expect(r.inventory.getItemCount('ow_clean_wrapper')).toBe(1);
    expect(r.day.minutesOfDay).toBe(670);
    expect(r.qm.getStatus('ow_meal')).toBe(QuestStatus.Completed);
    expect(r.inventory.resolveItemUse('ow_travel_meal')!.enabled).toBe(false);
  });

  it('缺钱、收摊不取饭；修灶后 21 点营业而借炉结局已歇', async () => {
    const r = await runtime();
    await r.signal('ow_meal_buy');
    expect(r.inventory.hasItem('ow_travel_meal')).toBe(false);
    r.inventory.addCoins(3); r.flags.set('minutes_of_day', 1260);
    await r.signal('ow_meal_buy');
    expect(r.inventory.getCoins()).toBe(3);
    expect(r.inventory.hasItem('ow_travel_meal')).toBe(false);
    for (const outcome of ['repaired', 'borrowed']) {
      const x = await runtime();
      if (outcome === 'repaired') {
        x.inventory.addItem('ow_bamboo'); x.inventory.addItem('ow_wood_wedge'); x.inventory.addItem('ow_charcoal');
        for (const sig of ['ow_stove_accept','ow_stove_clear','ow_stove_wedge','ow_stove_fire']) await x.signal(sig);
      } else {
        x.inventory.addItem('ow_bucket');
        for (const sig of ['ow_stove_borrow','ow_stove_cook','ow_stove_collect','ow_stove_deliver']) await x.signal(sig);
      }
      x.flags.set('minutes_of_day', 1260);
      await x.signal('ow_meal_redeem');
      expect(x.inventory.hasItem('ow_travel_meal')).toBe(outcome === 'repaired');
      expect(x.inventory.hasItem('ow_meal_voucher')).toBe(outcome !== 'repaired');
    }
  });

  it.each(['repaired', 'borrowed', 'initial'])('%s 结果的还碗、买饭、买油地点与杨嫂跨日作息一致', async outcome => {
    const r = await runtime();
    if (outcome === 'repaired') {
      r.inventory.addItem('ow_bamboo'); r.inventory.addItem('ow_wood_wedge'); r.inventory.addItem('ow_charcoal');
      for (const sig of ['ow_stove_accept', 'ow_stove_clear', 'ow_stove_wedge', 'ow_stove_fire']) await r.signal(sig);
    } else if (outcome === 'borrowed') {
      r.inventory.addItem('ow_bucket');
      for (const sig of ['ow_stove_borrow','ow_stove_cook','ow_stove_collect','ow_stove_deliver']) await r.signal(sig);
    }
    const scheduler = new NpcScheduleSystem(r.bus);
    scheduler.registerDefs(schedules.schedules as never);
    scheduler.bindRuntime({ evalConditions: (cs: ConditionExpr[] | undefined) => (cs ?? []).every(c => evaluateConditionExpr(c, r.context())) } as never);
    const objectives = (quests as QuestDef[]).flatMap(q => q.objectives ?? []).filter(o => o.guidance?.some(g => g.entityId === 'ow_yang'));
    expect(objectives.length).toBeGreaterThanOrEqual(3);
    for (const hour of [8, 14, 19, 21, 23, 3]) {
      r.flags.set('minutes_of_day', hour * 60);
      const expected = hour >= 22 || hour < 7 ? null : outcome === 'repaired' ? '雾津街头' : hour >= 20 ? null : hour >= (outcome === 'borrowed' ? 13 : 18) ? 'test_room_b' : '雾津街头';
      expect(scheduler.resolvePlacement('ow_yang', hour*60)?.scene).toBe(expected);
      for (const o of objectives) {
        const live = o.guidance!.filter(g => g.kind==='worldMarker' && (g.conditions??[]).every(c => evaluateConditionExpr(c,r.context())));
        expect(live.map(g => g.sceneId)).toEqual([expected ?? '雾津街头']);
        expect(live.map(g => g.entityId)).toEqual([expected ? 'ow_yang' : 'ow_rest']);
      }
    }
  });
});

describe('章节事件：庙前两种处置、借物与夜班', () => {
  it('挡缝必须先辨风，缺料不吞纸；现场复查才结算，搬盘结局互斥', async () => {
    const r = await runtime();
    await r.signal('ow_incense_accept');
    r.inventory.addItem('ow_dry_paper', 2);
    await r.signal('ow_incense_seal');
    expect(r.inventory.getItemCount('ow_dry_paper')).toBe(2);
    r.inventory.addItem('ow_paste', 2);
    await r.signal('ow_incense_seal');
    expect(r.narrative.getActiveState('flow_ow_incense')).toBe('accepted');
    await r.signal('ow_incense_wind'); await r.signal('ow_incense_seal'); await r.signal('ow_incense_seal');
    expect(r.inventory.getItemCount('ow_dry_paper')).toBe(1);
    expect(r.inventory.getItemCount('ow_paste')).toBe(1);
    expect(r.inventory.getCoins()).toBe(0);
    expect(r.day.minutesOfDay).toBe(680);
    expect(r.qm.getCurrentObjective('ow_incense')?.id).toBe('incense_verify_obj');
    await r.signal('ow_incense_verify'); await r.signal('ow_incense_verify');
    r.inventory.addItem('ow_bucket'); r.inventory.addItem('ow_bamboo');
    await r.signal('ow_bolt_look'); await r.signal('ow_bolt_pry'); await r.signal('ow_incense_lift');
    expect(r.narrative.getActiveState('flow_ow_incense')).toBe('sheltered');
    expect(r.inventory.hasItem('ow_ash_pan')).toBe(false);
    expect(r.inventory.getCoins()).toBe(6);
    expect(r.qm.getStatus('ow_incense')).toBe(QuestStatus.Completed);
  });

  it('先解闩可直接搬盘，无须风口打卡；桶保留、抱盘存读不丢、不重复计时', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_bucket');
    await r.signal('ow_incense_lift');
    expect(r.inventory.hasItem('ow_ash_pan')).toBe(false);
    r.inventory.addItem('ow_old_clapper');
    await r.signal('ow_bolt_tap');
    expect(r.narrative.getActiveState('flow_ow_bolt')).toBe('initial');
    await r.signal('ow_bolt_look'); await r.signal('ow_bolt_tap'); await r.signal('ow_bolt_tap');
    expect(r.inventory.getItemCount('ow_old_clapper')).toBe(1);
    expect(r.inventory.getItemCount('ow_wood_wedge')).toBe(1);
    await r.signal('ow_incense_lift'); await r.signal('ow_incense_lift');
    expect(r.inventory.getItemCount('ow_ash_pan')).toBe(1);
    expect(r.day.minutesOfDay).toBe(670);
    expect(r.qm.getCurrentObjective('ow_incense')?.id).toBe('incense_place_obj');
    const loaded = await runtime();
    loaded.inventory.deserialize(r.inventory.serialize() as Parameters<InventoryManager['deserialize']>[0]);
    loaded.narrative.deserialize(r.narrative.serialize());
    loaded.day.deserialize(r.day.serialize() as Parameters<DayManager['deserialize']>[0]);
    loaded.inventory.addItem('ow_dry_paper'); loaded.inventory.addItem('ow_paste');
    await loaded.signal('ow_incense_wind'); await loaded.signal('ow_incense_seal');
    expect(loaded.inventory.getItemCount('ow_dry_paper')).toBe(1);
    await loaded.signal('ow_incense_place'); await loaded.signal('ow_incense_place');
    expect(loaded.narrative.getActiveState('flow_ow_incense')).toBe('moved');
    expect(loaded.inventory.hasItem('ow_ash_pan')).toBe(false);
    expect(loaded.inventory.getItemCount('ow_bucket')).toBe(1);
    expect(loaded.day.minutesOfDay).toBe(680);
    expect(loaded.inventory.getCoins()).toBe(0);
  });

  it('挑闩薄篾只耗一片，先用木梆则不扣篾，不重复给楔木', async () => {
    for (const tool of ['ow_bolt_pry', 'ow_bolt_tap']) {
      const r = await runtime();
      r.inventory.addItem('ow_bamboo', 2); r.inventory.addItem('ow_patched_clapper');
      await r.signal('ow_bolt_look'); await r.signal(tool);
      await r.signal('ow_bolt_pry'); await r.signal('ow_bolt_tap');
      expect(r.inventory.getItemCount('ow_bamboo')).toBe(tool === 'ow_bolt_pry' ? 1 : 2);
      expect(r.inventory.getItemCount('ow_patched_clapper')).toBe(1);
      expect(r.inventory.getItemCount('ow_wood_wedge')).toBe(1);
      expect(r.day.minutesOfDay).toBe(665);
      expect(r.qm.getStatus('ow_bolt')).toBe(QuestStatus.Completed);
    }
  });

  it('拿账不等于读懂；归还后文献真实入册、灯油只给一次', async () => {
    const r = await runtime(true);
    try {
      expect(r.flags.get('archive_document_doc_ow_temple_accounts')).not.toBe(true);
      await r.signal('ow_ledger_read');
      expect(r.inventory.hasItem('ow_lamp_oil')).toBe(false);
      await r.signal('ow_ledger_take'); await r.signal('ow_ledger_take');
      expect(r.inventory.getItemCount('ow_temple_ledger')).toBe(1);
      expect(r.flags.get('archive_document_doc_ow_temple_accounts')).not.toBe(true);
      await r.signal('ow_ledger_read'); await r.signal('ow_ledger_read'); await r.signal('ow_ledger_take');
      expect(r.inventory.hasItem('ow_temple_ledger')).toBe(false);
      expect(r.inventory.getItemCount('ow_lamp_oil')).toBe(1);
      expect(r.flags.get('archive_document_doc_ow_temple_accounts')).toBe(true);
      expect(r.qm.getStatus('ow_ledger')).toBe(QuestStatus.Completed);
    } finally { r.archive?.destroy(); }
  });

  it.each(['sheltered', 'moved', 'initial'])('%s 时找扫院僧的标记与完整跨日日程一致', async outcome => {
    const r = await runtime();
    if (outcome === 'sheltered') {
      r.inventory.addItem('ow_dry_paper'); r.inventory.addItem('ow_paste');
      await r.signal('ow_incense_wind'); await r.signal('ow_incense_seal'); await r.signal('ow_incense_verify');
    } else if (outcome === 'moved') {
      r.inventory.addItem('ow_bamboo'); r.inventory.addItem('ow_bucket');
      await r.signal('ow_bolt_look'); await r.signal('ow_bolt_pry'); await r.signal('ow_incense_lift'); await r.signal('ow_incense_place');
    }
    const scheduler = new NpcScheduleSystem(r.bus);
    scheduler.registerDefs(schedules.schedules as never);
    scheduler.bindRuntime({ evalConditions: (cs: ConditionExpr[] | undefined) => (cs ?? []).every(c => evaluateConditionExpr(c, r.context())) } as never);
    const guidance = (quests as QuestDef[]).find(q => q.id === 'ow_ledger')!.objectives!.find(o => o.id === 'ledger_read_obj')!.guidance!;
    for (const hour of [8, 12, 21, 23, 2]) {
      r.flags.set('minutes_of_day', hour * 60);
      const expected = hour === 8 ? 'temple_exterior' : hour === 12 ? 'temple' : hour === 21 && outcome !== 'initial' ? outcome === 'sheltered' ? 'temple_exterior' : 'temple' : null;
      expect(scheduler.resolvePlacement('ow_monk', hour * 60)?.scene).toBe(expected);
      const live = guidance.filter(g => g.kind === 'worldMarker' && (g.conditions ?? []).every(c => evaluateConditionExpr(c, r.context())));
      expect(live.map(g => g.sceneId)).toEqual([expected ?? 'temple_exterior']);
      expect(live.map(g => g.entityId)).toEqual([expected ? 'ow_monk' : 'ow_rest']);
    }
  });
});

describe('章节事件：纸扎的材料、真实结果与晚班', () => {
  it('只试摆失败不耗纸浆，成功才耗料耗时，交付不重复领钱', async () => {
    const r = await runtime();
    const order = paperCraft.orders[0];
    await r.signal('ow_paper_accept');
    r.inventory.addItem('ow_dry_paper', 2); r.inventory.addItem('ow_paste', 2);
    const perform = async (actions: ActionDef[]) => {
      for (const action of actions) await r.executor.executeAwait(action);
      await flush();
    };
    await perform(order.onWarnActions); await perform(order.onBadActions);
    expect(r.inventory.getItemCount('ow_dry_paper')).toBe(2);
    expect(r.inventory.getItemCount('ow_paste')).toBe(2);
    expect(r.day.minutesOfDay).toBe(660);
    expect(r.qm.getCurrentObjective('ow_paper')?.id).toBe('paper_choose_obj');
    await perform(order.onSuccessActions); await perform(order.onSuccessActions);
    expect(r.inventory.getItemCount('ow_dry_paper')).toBe(1);
    expect(r.inventory.getItemCount('ow_paste')).toBe(1);
    expect(r.day.minutesOfDay).toBe(705);
    expect(r.inventory.getItemCount('ow_new_servant')).toBe(1);
    expect(r.qm.getCurrentObjective('ow_paper')?.id).toBe('paper_return_obj');
    await r.signal('ow_paper_deliver'); await r.signal('ow_paper_deliver');
    expect(r.inventory.hasItem('ow_new_servant')).toBe(false);
    expect(r.inventory.getCoins()).toBe(16);
    expect(r.qm.getStatus('ow_paper')).toBe(QuestStatus.Completed);
  });

  it('先糊缝再衬篾可以修旧；已补一处不能重做或重复扣料', async () => {
    const r = await runtime();
    const use = async (id: string) => {
      for (const action of paperExamine.hotspots.find(h => h.id === id)!.itemUses![0].actions) await r.executor.executeAwait(action);
      await flush();
    };
    await use('right_foot');
    expect(r.narrative.getActiveState('flow_ow_paper_seam')).toBe('initial');
    r.inventory.addItem('ow_paste', 2); r.inventory.addItem('ow_bamboo', 2); r.inventory.addItem('ow_dry_paper');
    await use('right_foot'); await use('right_foot');
    await r.signal('ow_paper_success');
    expect(r.inventory.getItemCount('ow_paste')).toBe(1);
    expect(r.inventory.getItemCount('ow_dry_paper')).toBe(1);
    expect(r.inventory.hasItem('ow_new_servant')).toBe(false);
    await use('left_ankle'); await use('left_ankle');
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.inventory.getItemCount('ow_braced_servant')).toBe(1);
    expect(r.day.minutesOfDay).toBe(675);
    await r.signal('ow_paper_deliver'); await use('right_foot');
    expect(r.inventory.getCoins()).toBe(8);
    expect(r.inventory.hasItem('ow_braced_servant')).toBe(false);
    expect(r.inventory.getItemCount('ow_paste')).toBe(1);
    expect(r.narrative.getActiveState('flow_ow_paper')).toBe('braced');
  });

  it('先抱潮纸，入夜保留，次日能晒；一叠只换一次纸和钱', async () => {
    const r = await runtime();
    await r.signal('ow_dry_take');
    expect(r.inventory.hasItem('ow_damp_paper')).toBe(true);
    await r.day.advanceTime(540);
    await r.signal('ow_dry_spread');
    expect(r.narrative.getActiveState('flow_ow_dry_paper')).toBe('carrying');
    expect(r.inventory.hasItem('ow_dry_paper')).toBe(false);
    await r.day.advanceTime(660);
    expect(r.day.currentDay).toBe(2);
    await r.signal('ow_dry_spread'); await r.signal('ow_dry_spread'); await r.signal('ow_dry_take');
    expect(r.inventory.hasItem('ow_damp_paper')).toBe(false);
    expect(r.inventory.getItemCount('ow_dry_paper')).toBe(1);
    expect(r.inventory.getCoins()).toBe(3);
    expect(r.day.minutesOfDay).toBe(450);
    expect(r.qm.getStatus('ow_dry_paper')).toBe(QuestStatus.Completed);
  });

  it('熬浆缺桶不吞米，已有浆不浪费；用完可再熬且支线不重复结算', async () => {
    const r = await runtime();
    r.inventory.addItem('nuomi', 3);
    await r.signal('ow_paste_accept'); await r.signal('ow_paste_cook');
    expect(r.inventory.getItemCount('nuomi')).toBe(3);
    r.inventory.addItem('ow_bucket');
    await r.signal('ow_paste_cook'); await r.signal('ow_paste_cook');
    expect(r.inventory.getItemCount('nuomi')).toBe(2);
    expect(r.inventory.getItemCount('ow_paste')).toBe(1);
    expect(r.day.minutesOfDay).toBe(675);
    expect(r.qm.getStatus('ow_paste')).toBe(QuestStatus.Completed);
    await r.signal('ow_paper_seam');
    expect(r.inventory.hasItem('ow_paste')).toBe(false);
    await r.signal('ow_paste_cook');
    expect(r.inventory.getItemCount('nuomi')).toBe(1);
    expect(r.inventory.getItemCount('ow_paste')).toBe(1);
    expect(r.inventory.getItemCount('ow_bucket')).toBe(1);
    expect(r.day.minutesOfDay).toBe(690);
    expect(r.inventory.getCoins()).toBe(0);
  });

  it('修脚中途存读保持用料；重做结果改变罗伯晚班和篾刀归还指路', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_bamboo', 2); await r.signal('ow_paper_splint');
    const saved = await runtime();
    saved.inventory.deserialize(r.inventory.serialize() as Parameters<InventoryManager['deserialize']>[0]);
    saved.narrative.deserialize(r.narrative.serialize());
    await saved.signal('ow_paper_splint');
    expect(saved.inventory.getItemCount('ow_bamboo')).toBe(1);
    saved.inventory.addItem('ow_paste'); await saved.signal('ow_paper_seam');
    expect(saved.inventory.getItemCount('ow_braced_servant')).toBe(1);
    const fresh = await runtime();
    fresh.inventory.addItem('ow_paste'); fresh.inventory.addItem('ow_dry_paper');
    await fresh.signal('ow_paper_accept'); await fresh.signal('ow_paper_success'); await fresh.signal('ow_paper_deliver');
    const scheduler = new NpcScheduleSystem(fresh.bus);
    scheduler.registerDefs(schedules.schedules as never);
    scheduler.bindRuntime({ evalConditions: (cs: ConditionExpr[] | undefined) => (cs ?? []).every(c => evaluateConditionExpr(c, fresh.context())) } as never);
    fresh.flags.set('minutes_of_day', 1140);
    expect(scheduler.resolvePlacement('ow_luo', 1140)?.scene).toBe('test_room_b');
    const q = (quests as QuestDef[]).find(q => q.id === 'ow_knife')!;
    const markers = q.objectives!.flatMap(o => o.guidance ?? []).filter(g => g.kind === 'worldMarker' && g.entityId === 'ow_luo' && (g.conditions ?? []).every(c => evaluateConditionExpr(c, fresh.context())));
    expect(markers.map(g => g.sceneId)).toEqual(['test_room_b']);
  });
});

describe('章节事件：巡更、灯油与口信（真实内容）', () => {
  it('刚接巡更就有总目标；实际进入修补办法即跟踪工位，修好后自动转交付', async () => {
    const r = await runtime();
    await r.signal('ow_watch_accept');
    expect(r.qm.getCurrentObjective('ow_watch')?.id).toBe('watch_choose_obj');
    for (const action of watchDialogue.nodes.bench_focus.actions) await r.executor.executeAwait(action);
    await flush();
    expect(r.qm.getCurrentObjective('ow_watch')?.id).toBe('watch_bench_obj');
    expect(r.qm.getActiveGuidance().find(g => g.kind === 'worldMarker')?.entityId).toBe('ow_watch_bench');
    expect(r.narrative.getActiveState('flow_ow_watch_splint')).toBe('initial');
    r.inventory.addItem('ow_bamboo'); r.inventory.addItem('ow_cloth');
    await r.signal('ow_watch_splint'); await r.signal('ow_watch_tie');
    expect(r.qm.getCurrentObjective('ow_watch')?.id).toBe('watch_return_obj');
    expect(r.qm.getStatus('ow_watch')).toBe(QuestStatus.Active);
  });
  it('捞取须有绳或修岸；日夜两入口共用一次实物，交原梆后排除备用梆结算', async () => {
    const r = await runtime();
    const perform = async (data: typeof watchWater) => {
      for (const action of data.entities.find(e => e.id === 'watch_clapper')!.onPullSuccess!) {
        await r.executor.executeAwait(action);
      }
      await flush();
    };
    await perform(watchWater);
    expect(r.inventory.hasItem('ow_old_clapper')).toBe(false);
    r.inventory.addItem('ow_rope');
    await perform(watchWater);
    await perform(watchNight);
    expect(r.inventory.getItemCount('ow_old_clapper')).toBe(1);
    await r.signal('ow_watch_return_original');
    await r.signal('ow_watch_return_original');
    r.inventory.addItem('ow_patched_clapper');
    await r.signal('ow_watch_return_patched');
    expect(r.narrative.getActiveState('flow_ow_watch')).toBe('original');
    expect(r.inventory.hasItem('ow_old_clapper')).toBe(false);
    expect(r.inventory.getCoins()).toBe(8);
    expect(r.inventory.hasItem('ow_rope')).toBe(true);
  });

  it('备用梆两处可换序处理；只看、缺材料或重复用物都不能伪造修好', async () => {
    const r = await runtime();
    const use = async (id: string) => {
      for (const action of watchExamine.hotspots.find(h => h.id === id)!.itemUses![0].actions) await r.executor.executeAwait(action);
      await flush();
    };
    await use('split');
    expect(r.narrative.getActiveState('flow_ow_watch_splint')).toBe('initial');
    r.inventory.addItem('ow_cloth', 2);
    r.inventory.addItem('ow_bamboo', 2);
    await use('cord');
    await use('cord');
    expect(r.inventory.getItemCount('ow_cloth')).toBe(1);
    expect(r.inventory.hasItem('ow_patched_clapper')).toBe(false);
    await use('split');
    await use('split');
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.inventory.getItemCount('ow_patched_clapper')).toBe(1);
    await r.signal('ow_watch_return_patched');
    await use('split');
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.inventory.getCoins()).toBe(4);
    expect(r.inventory.hasItem('ow_patched_clapper')).toBe(false);
    expect(r.qm.getStatus('ow_watch')).toBe(QuestStatus.Completed);
    expect(r.narrative.getActiveState('flow_ow_watch_found')).toBe('initial');
  });

  it('先取零货后找失主，油可直接添灯；重复交付不加油、不加钱', async () => {
    const r = await runtime();
    await r.signal('ow_lamp_accept');
    await r.signal('ow_lamp_fill');
    expect(r.narrative.getActiveState('flow_ow_lamp')).toBe('accepted');
    await r.signal('ow_cargo_take');
    await r.signal('ow_cargo_return');
    await r.signal('ow_cargo_return');
    expect(r.inventory.getItemCount('ow_lamp_oil')).toBe(1);
    expect(r.inventory.getItemCount('ow_charcoal')).toBe(2);
    expect(r.inventory.hasItem('ow_small_cargo')).toBe(false);
    await r.signal('ow_lamp_fill');
    await r.signal('ow_lamp_fill');
    expect(r.inventory.hasItem('ow_lamp_oil')).toBe(false);
    expect(r.inventory.getCoins()).toBe(2);
    expect(r.qm.getStatus('ow_lamp')).toBe(QuestStatus.Completed);
    expect(r.qm.getStatus('ow_cargo')).toBe(QuestStatus.Completed);
  });

  it('旧口信在修岸之后失效，重问后才能回报；跨任务改变归还指路', async () => {
    const r = await runtime();
    await r.signal('ow_message_accept');
    await r.signal('ow_message_qian');
    expect(r.narrative.getActiveState('flow_ow_message')).toBe('bridge_reply');
    r.inventory.addItem('ow_rope'); r.inventory.addItem('ow_bamboo');
    await r.signal('ow_water_rig'); await r.signal('ow_water_pull_success'); await r.signal('ow_water_repair');
    await r.signal('ow_message_report');
    expect(r.narrative.getActiveState('flow_ow_message')).toBe('bridge_reply');
    const q = (quests as QuestDef[]).find(q => q.id === 'ow_message')!;
    const visible = () => q.objectives!.filter(o => (o.availableWhen ?? []).every(c => evaluateConditionExpr(c, r.context()))).map(o => o.id);
    expect(visible()).toEqual(['message_ask_obj']);
    await r.signal('ow_message_qian');
    expect(visible()).toEqual(['message_report_obj']);
    await r.signal('ow_message_report'); await r.signal('ow_message_report');
    expect(r.narrative.getActiveState('flow_ow_message')).toBe('dock_agreed');
    expect(r.inventory.getCoins()).toBe(15);
  });

  it('原梆结局在存读后保持丁四二十一点守桥，任务指路跟随他', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_rope');
    await r.signal('ow_watch_found'); await r.signal('ow_watch_return_original');
    const loaded = await runtime();
    loaded.inventory.deserialize(r.inventory.serialize() as Parameters<InventoryManager['deserialize']>[0]);
    loaded.narrative.deserialize(r.narrative.serialize());
    loaded.flags.set('minutes_of_day', 21 * 60);
    const schedule = new NpcScheduleSystem(loaded.bus);
    schedule.registerDefs(schedules.schedules as never);
    schedule.bindRuntime({ evalConditions: (cs: ConditionExpr[] | undefined) => (cs ?? []).every(c => evaluateConditionExpr(c, loaded.context())) } as never);
    expect(schedule.resolvePlacement('ow_ding', 21 * 60)?.scene).toBe('bridge_underpass');
    const guidance = (quests as QuestDef[]).find(q => q.id === 'ow_message')!.objectives!.find(o => o.id === 'message_report_obj')!.guidance!;
    expect(guidance.filter(g => g.kind === 'worldMarker' && (g.conditions ?? []).every(c => evaluateConditionExpr(c, loaded.context()))).map(g => g.sceneId)).toEqual(['bridge_underpass']);
    await loaded.signal('ow_watch_return_original');
    expect(loaded.inventory.getCoins()).toBe(8);
  });
});

describe('章节事件：认衣与布料（真实内容）', () => {
  it('先辨油也接入认衣；实物用布只扣一次，不要求先看补丁或见借衣人', async () => {
    const r = await runtime();
    const actions = coatExamine.hotspots.find(h => h.id === 'cuff')!.itemUses![0].actions;
    for (const action of actions) await r.executor.executeAwait(action);
    expect(r.narrative.getActiveState('flow_ow_coat_oil')).toBe('initial');
    r.inventory.addItem('ow_cloth', 2);
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const action of actions) await r.executor.executeAwait(action);
      await flush();
    }
    expect(r.inventory.getItemCount('ow_cloth')).toBe(1);
    expect(r.qm.getStatus('ow_coat')).toBe(QuestStatus.Active);
    expect(r.narrative.getActiveState('flow_ow_coat_patch')).toBe('initial');
    expect(r.narrative.getActiveState('flow_ow_coat_borrower')).toBe('initial');
    await r.signal('ow_coat_keep');
    expect(r.inventory.getItemCount('ow_work_coat')).toBe(1);
    await r.signal('ow_coat_return');
    await r.signal('ow_coat_return');
    expect(r.inventory.hasItem('ow_work_coat')).toBe(false);
    expect(r.inventory.getItemCount('ow_coat_record')).toBe(1);
    expect(r.inventory.getCoins()).toBe(6);
  });

  it('洗补须先听来路并备齐水桶与布；永久排除原状交回，不复制肩垫', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_cloth');
    r.inventory.addItem('ow_bucket');
    await r.signal('ow_coat_accept');
    await r.signal('ow_coat_mend');
    expect(r.narrative.getActiveState('flow_ow_coat')).toBe('accepted');
    await r.signal('ow_coat_borrower');
    await r.signal('ow_coat_mend');
    await r.signal('ow_coat_keep');
    await r.signal('ow_coat_return');
    await r.signal('ow_coat_mend');
    expect(r.narrative.getActiveState('flow_ow_coat')).toBe('mended');
    expect(r.inventory.getItemCount('ow_bucket')).toBe(1);
    expect(r.inventory.getItemCount('ow_cloth')).toBe(0);
    expect(r.inventory.getItemCount('ow_shoulder_pad')).toBe(1);
    expect(r.inventory.hasItem('ow_coat_record')).toBe(false);
    expect(r.inventory.getCoins()).toBe(0);
    expect(r.qm.getStatus('ow_coat')).toBe(QuestStatus.Completed);
  });

  it('材料不足不会空洗；已取走的工衣不能再被检视动作扣布', async () => {
    const r = await runtime();
    await r.signal('ow_coat_borrower');
    await r.signal('ow_coat_mend');
    expect(r.narrative.getActiveState('flow_ow_coat')).toBe('accepted');
    await r.signal('ow_coat_keep');
    r.inventory.addItem('ow_cloth', 2);
    await r.signal('ow_coat_oil');
    expect(r.inventory.getItemCount('ow_cloth')).toBe(2);
    expect(r.narrative.getActiveState('flow_ow_coat_oil')).toBe('initial');
  });

  it('还针取得的布可立刻用来包药篓；不强迫捞桶且不能重复发艾草', async () => {
    const r = await runtime();
    await r.signal('ow_needle_take');
    await r.signal('ow_needle_return');
    await r.signal('ow_needle_return');
    expect(r.inventory.getItemCount('ow_cloth')).toBe(1);
    expect(r.inventory.hasItem('ow_needle')).toBe(false);
    await r.signal('ow_binding_accept');
    await r.signal('ow_binding_wrap');
    await r.signal('ow_binding_wrap');
    expect(r.inventory.getItemCount('ow_cloth')).toBe(0);
    expect(r.inventory.getItemCount('mugwort')).toBe(3);
    expect(r.narrative.getActiveState('flow_ow_bucket')).toBe('initial');
    expect(r.qm.getStatus('ow_needle')).toBe(QuestStatus.Completed);
    expect(r.qm.getStatus('ow_binding')).toBe(QuestStatus.Completed);
  });

  it('认衣结果改变邓幺的晚班，工票旧任务的目击引导随同变化', async () => {
    const r = await runtime();
    const schedule = new NpcScheduleSystem(r.bus);
    schedule.registerDefs(schedules.schedules as never);
    schedule.bindRuntime({ evalConditions: (cs: ConditionExpr[] | undefined) => (cs ?? []).every(c => evaluateConditionExpr(c, r.context())) } as never);
    const guide = (quests as QuestDef[]).find(q => q.id === 'ow_tally')!.objectives!.find(o => o.id === 'tally_witness_obj')!.guidance!;
    r.flags.set('minutes_of_day', 19 * 60);
    const target = () => guide.filter(g => g.kind === 'worldMarker' && (g.conditions ?? []).every(c => evaluateConditionExpr(c, r.context()))).map(g => g.sceneId);
    expect(target()).toEqual(['test_room_b']);
    await r.signal('ow_coat_borrower');
    await r.signal('ow_coat_keep');
    await r.signal('ow_coat_return');
    expect(schedule.resolvePlacement('ow_deng', 19 * 60)?.scene).toBe('码头白天');
    expect(target()).toEqual(['码头白天']);
    const loaded = await runtime();
    loaded.inventory.deserialize(r.inventory.serialize() as Parameters<InventoryManager['deserialize']>[0]);
    loaded.narrative.deserialize(r.narrative.serialize());
    await loaded.signal('ow_coat_return');
    expect(loaded.inventory.getCoins()).toBe(6);
    expect(loaded.inventory.getItemCount('ow_coat_record')).toBe(1);
  });
});

describe('规矩是行动结果的投影', () => {
  const id = 'ow_air_path';
  it('未知时不露条目；察看风缝才出现方法，未验证不装作有效', async () => {
    const r = await runtime();
    expect(r.rules.getRuleDef(id)?.layers).toEqual({});
    expect(r.rules.isDiscovered(id)).toBe(false);
    await r.signal('ow_incense_accept');
    expect(Object.keys(r.rules.getRuleDef(id)!.layers)).toEqual(['xiang']);
    expect(r.rules.hasLayer(id, 'shu')).toBe(false);
    await r.signal('ow_incense_wind');
    expect(r.rules.hasLayer(id, 'shu')).toBe(true);
    expect(r.rules.getRuleDef(id)!.layers.li?.verified).toBe('unverified');
    expect(JSON.stringify(r.flags.serialize())).not.toContain('rule_ow_air_path');
    expect(r.rules.serialize()).toEqual({ acquiredFragments: [], grantedLayers: {} });
  });

  it('用过纸浆不等于验收；回灰盘复查后正文才变为有效', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_dry_paper'); r.inventory.addItem('ow_paste');
    await r.signal('ow_incense_wind'); await r.signal('ow_incense_seal');
    expect(r.rules.getRuleDef(id)!.layers.li?.verified).toBe('unverified');
    await r.signal('ow_incense_verify');
    expect(r.narrative.getActiveState('flow_ow_rule_air')).toBe('sheltered');
    expect(r.rules.getRuleDef(id)!.layers.li?.verified).toBe('effective');
  });

  it('选择搬盘后收回未证实的理；存读投影一致，不重发新知通知', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_bamboo'); r.inventory.addItem('ow_bucket');
    await r.signal('ow_incense_wind'); await r.signal('ow_bolt_look'); await r.signal('ow_bolt_pry');
    await r.signal('ow_incense_lift'); await r.signal('ow_incense_place');
    expect(r.rules.hasLayer(id, 'li')).toBe(false);
    expect(r.rules.getRuleDef(id)!.layers.shu?.verified).toBe('questionable');
    const loaded = await runtime();
    const notifications: unknown[] = [];
    loaded.bus.on('notification:show', p => notifications.push(p));
    loaded.rules.deserialize(r.rules.serialize());
    loaded.narrative.deserialize(r.narrative.serialize());
    await flush();
    expect(loaded.rules.getRuleDef(id)?.layers).toEqual(r.rules.getRuleDef(id)?.layers);
    expect(notifications).toEqual([]);
  });

  it('冷灶与风缝可换序印证；旧授予存档不能绕过未知状态', async () => {
    for (const firstWind of [false, true]) {
      const r = await runtime();
      r.rules.deserialize({ grantedLayers: { [id]: ['xiang', 'li', 'shu'] }, acquiredRules: [id] });
      expect(r.rules.hasRule(id)).toBe(false);
      r.inventory.addItem('ow_bamboo'); r.inventory.addItem('ow_wood_wedge'); r.inventory.addItem('ow_charcoal');
      if (firstWind) await r.signal('ow_incense_wind');
      await r.signal('ow_stove_accept');
      await r.signal('ow_stove_clear'); await r.signal('ow_stove_wedge'); await r.signal('ow_stove_fire');
      if (!firstWind) {
        expect(r.rules.hasLayer(id, 'li')).toBe(false);
        await r.signal('ow_incense_wind');
      }
      expect(r.narrative.getActiveState('flow_ow_rule_air')).toBe('compared');
      expect(r.rules.getRuleDef(id)?.layers.li?.verified).toBe('effective');
    }
  });
});

async function runtime(withArchive = false) {
  const bus = new EventBus();
  const flags = new FlagStore(bus);
  const executor = new ActionExecutor(bus, flags);
  const narrative = new NarrativeStateManager(bus, flags, executor);
  const inventory = new InventoryManager(bus, flags);
  const rules = new RulesManager(bus, flags);
  const qm = new QuestManager(bus, flags, executor);
  const day = new DayManager(bus, flags, executor);
  day.configure({ startAt: '11:00' });
  day.init({} as never);
  const strings = { get: (_category: string, key: string) => key };
  inventory.init({ strings, assetManager: { loadJson: async () => items as ItemDef[] } } as never);
  await inventory.loadDefs();
  rules.init({ strings, assetManager: { loadJson: async () => ruleData } } as never);
  await rules.loadDefs();
  rules.bindNarrative({
    getState: id => narrative.getPrimaryActiveStateByOwner('rule', id),
    getRuleId: id => { const g = narrative.getGraph(id); return g?.ownerType === 'rule' ? g.ownerId : undefined; },
  });
  qm.init({ strings, assetManager: { loadJson: async () => (quests as QuestDef[]).filter(q => q.id.startsWith('ow_')) } } as never);
  const context = () => ({ flagStore: flags, questManager: qm, narrativeState: narrative, scenarioState: {} as never });
  const archive = withArchive ? new ArchiveManager(bus, flags) : null;
  if (archive) {
    const archiveData: Record<string, unknown> = {
      [TEXT_URLS.archiveDir + '/characters.json']: archiveCharacters, [TEXT_URLS.archiveDir + '/lore.json']: archiveLore,
      [TEXT_URLS.archiveDir + '/slang.json']: archiveSlang, [TEXT_URLS.archiveDir + '/rhymes.json']: archiveRhymes,
      [TEXT_URLS.archiveDir + '/documents.json']: archiveDocuments, [TEXT_URLS.archiveDir + '/books.json']: archiveBooks,
      [TEXT_URLS.items]: items,
    };
    archive.init({ strings, assetManager: { loadJson: async (url: string) => archiveData[url] } } as never);
    archive.setConditionEvalContextFactory(context);
  }
  narrative.setConditionEvalContextFactory(context);
  inventory.setConditionEvalContextFactory(context);
  qm.setConditionEvalContextFactory(context);
  registerActionHandlers(executor, {
    inventoryManager: inventory, rulesManager: rules, narrativeStateManager: narrative, questManager: qm, dayManager: day, archiveManager: archive,
    resolveDisplayText: (s: string) => s,
  } as ActionRegistryDeps);
  const selected = { ...graphs, compositions: graphs.compositions.filter(c => c.mainGraph.id.startsWith('flow_ow_')) };
  narrative.registerGraphs(compileNarrativeGraphs(selected as unknown as NarrativeGraphsFile));
  rules.validateNarrativeBindings(narrative.getGraphs());
  if (archive) await archive.loadDefs();
  await qm.loadDefs();
  await flush();
  const signal = async (signal: string) => {
    await narrative.emitNarrativeSignal({ signal });
    await flush();
  };
  const useTicket = async () => {
    const use = inventory.resolveItemUse('ow_tally');
    if (!use?.enabled) return false;
    for (const action of use.actions) await executor.executeAwait(action);
    await flush();
    return true;
  };
  return { bus, flags, narrative, inventory, rules, qm, executor, day, archive, signal, useTicket, context };
}

describe('章节事件：工票 / 篾刀（真实内容）', () => {
  it('先拾票也接取任务；无需先找周三，不重复领票', async () => {
    const r = await runtime();
    expect(r.qm.getStatus('ow_tally')).toBe(QuestStatus.Inactive);
    await r.signal('ow_tally_find');
    expect(r.narrative.getActiveState(TALLY)).toBe('found');
    expect(r.qm.getStatus('ow_tally')).toBe(QuestStatus.Active);
    await r.signal('ow_tally_accept');
    await r.signal('ow_tally_find');
    expect(r.narrative.getActiveState(TALLY)).toBe('found');
    expect(r.inventory.getItemCount('ow_tally')).toBe(1);
  });

  it('先调查货堆、核实目击，再拾票也能结清；不强制拓票或篾刀支线', async () => {
    const r = await runtime();
    await r.signal('ow_tally_witness');
    expect(r.narrative.getActiveState('flow_ow_tally_witness')).toBe('initial');
    await r.signal('ow_tally_count');
    expect(r.qm.getStatus('ow_tally')).toBe(QuestStatus.Active);
    await r.signal('ow_tally_witness');
    await r.signal('ow_tally_find');
    await r.signal('ow_tally_witness_settle');
    expect(r.narrative.getActiveState(TALLY)).toBe('witness');
    expect(r.qm.getStatus('ow_tally')).toBe(QuestStatus.Completed);
    expect(r.narrative.getActiveState(KNIFE)).toBe('initial');
    expect(r.inventory.getCoins()).toBe(10);
    expect(r.inventory.getItemCount('ow_rope')).toBe(1);
    expect(r.inventory.hasItem('ow_tally')).toBe(false);
  });

  it('背包材料不足不伪成功；补足后只耗一支炭，反复使用/发信号不重复耗材', async () => {
    const r = await runtime();
    await r.signal('ow_tally_find');
    expect(await r.useTicket()).toBe(false);
    await r.signal('ow_tally_rub');
    expect(r.narrative.getActiveState('flow_ow_tally_trace')).toBe('initial');
    r.inventory.addItem('ow_charcoal', 3);
    expect(await r.useTicket()).toBe(true);
    expect(r.inventory.getItemCount('ow_charcoal')).toBe(2);
    expect(await r.useTicket()).toBe(false);
    await r.signal('ow_tally_rub');
    expect(r.inventory.getItemCount('ow_charcoal')).toBe(2);
    await r.signal('ow_tally_fair');
    expect(r.inventory.getCoins()).toBe(12);
    expect(r.inventory.getItemCount('ow_rope')).toBe(1);
    expect(r.qm.getStatus('ow_tally')).toBe(QuestStatus.Completed);
  });

  it('折中是真正终局：五文、没有缆绳，后补证据不能改判或重复发钱', async () => {
    const r = await runtime();
    await r.signal('ow_tally_find');
    await r.signal('ow_tally_compromise');
    await r.signal('ow_tally_count');
    await r.signal('ow_tally_witness');
    await r.signal('ow_tally_witness_settle');
    await r.signal('ow_tally_fair');
    await r.signal('ow_rope_loan');
    await r.signal('ow_tally_compromise');
    expect(r.narrative.getActiveState(TALLY)).toBe('compromise');
    expect(r.inventory.getCoins()).toBe(5);
    expect(r.inventory.hasItem('ow_rope')).toBe(false);
    expect(r.qm.getStatus('ow_tally')).toBe(QuestStatus.Completed);
  });

  it('篾刀先取后问仍能交还，满包保留关键领取；多次归还不刷材料', async () => {
    const r = await runtime();
    for (const item of (items as ItemDef[]).filter(i => !i.id.startsWith('ow_')).slice(0, 12)) r.inventory.addItem(item.id);
    await r.signal('ow_knife_take');
    expect(r.inventory.hasItem('ow_knife')).toBe(true);
    expect(r.qm.getStatus('ow_knife')).toBe(QuestStatus.Active);
    await r.signal('ow_knife_return');
    await r.signal('ow_knife_return');
    expect(r.inventory.hasItem('ow_knife')).toBe(false);
    expect(r.inventory.getItemCount('ow_charcoal')).toBe(3);
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(2);
    expect(r.qm.getStatus('ow_knife')).toBe(QuestStatus.Completed);
  });

  it('调查途中存读档，保留目击与手中工票，恢复后只结一次账', async () => {
    const r = await runtime();
    await r.signal('ow_tally_count');
    await r.signal('ow_tally_witness');
    await r.signal('ow_tally_find');
    const saved = { narrative: r.narrative.serialize(), inventory: r.inventory.serialize() };
    const loaded = await runtime();
    loaded.inventory.deserialize(saved.inventory as Parameters<InventoryManager['deserialize']>[0]);
    loaded.narrative.deserialize(saved.narrative);
    await flush();
    expect(loaded.narrative.getActiveState('flow_ow_tally_witness')).toBe('seen');
    expect(loaded.inventory.getItemCount('ow_tally')).toBe(1);
    await loaded.signal('ow_tally_witness_settle');
    await loaded.signal('ow_tally_witness_settle');
    await loaded.signal('ow_rope_loan');
    expect(loaded.inventory.getCoins()).toBe(10);
    expect(loaded.inventory.getItemCount('ow_rope')).toBe(1);
  });

  it('折中让周三傍晚留在码头补工，借碗引导也随结果改道', async () => {
    const r = await runtime();
    const schedule = new NpcScheduleSystem(r.bus);
    schedule.registerDefs(schedules.schedules as never);
    schedule.bindRuntime({ evalConditions: (conditions: ConditionExpr[] | undefined) => (conditions ?? []).every(c => evaluateConditionExpr(c, r.context())) } as never);
    const bowl = (quests as QuestDef[]).find(q => q.id === 'ow_bowl')!;
    const guidance = bowl.objectives!.find(o => o.id === 'bowl_collect_obj')!.guidance!;
    const shownTargets = () => guidance.filter(g => g.kind === 'worldMarker' && (g.conditions ?? []).every(c => evaluateConditionExpr(c, r.context()))).map(g => g.sceneId);
    r.flags.set('minutes_of_day', 19 * 60);
    expect(schedule.resolvePlacement('ow_zhou', 19 * 60)?.scene).toBe('雾津街头');
    expect(shownTargets()).toEqual(['雾津街头']);
    await r.signal('ow_tally_find');
    await r.signal('ow_tally_compromise');
    expect(schedule.resolvePlacement('ow_zhou', 19 * 60)?.scene).toBe('码头白天');
    expect(shownTargets()).toEqual(['码头白天']);
    r.flags.set('minutes_of_day', 20 * 60);
    expect(schedule.resolvePlacement('ow_zhou', 20 * 60)?.scene).toBeNull();
    expect(shownTargets()).toEqual(['码头白天']); // Points to the rest spot, never a missing NPC.
    expect(guidance.filter(g => g.kind === 'worldMarker' && (g.conditions ?? []).every(c => evaluateConditionExpr(c, r.context()))).every(g => g.entityId === 'ow_rest')).toBe(true);
  });
});

describe('章节事件：水路与工具（真实内容）', () => {
  it.each(['post', 'reed', 'stone'])('先看 %s 就能跟进，不要求三处打卡', async (clue) => {
    const r = await runtime();
    await r.signal(`ow_water_${clue}`);
    expect(r.qm.getStatus('ow_water')).toBe(QuestStatus.Active);
    expect(r.narrative.getActiveState('flow_ow_water')).toBe('ready');
    expect(r.narrative.getActiveState(`flow_ow_water_${clue}`)).toBe('seen');
    const untouched = ['post', 'reed', 'stone'].filter(c => c !== clue);
    for (const c of untouched) expect(r.narrative.getActiveState(`flow_ow_water_${c}`)).toBe('initial');
  });

  it('不做工票也能蹲取短绳、修扣换绳；重复领取不复制工具', async () => {
    const r = await runtime();
    await r.signal('ow_rope_tail_take');
    expect(r.inventory.hasItem('ow_rope_tail')).toBe(true);
    expect(r.qm.getStatus('ow_mooring')).toBe(QuestStatus.Active);
    await r.signal('ow_mooring_fix');
    expect(r.inventory.hasItem('ow_rope_tail')).toBe(false);
    await r.signal('ow_mooring_return');
    await r.signal('ow_mooring_return');
    await r.signal('ow_rope_tail_take');
    expect(r.inventory.getItemCount('ow_rope')).toBe(1);
    expect(r.qm.getStatus('ow_mooring')).toBe(QuestStatus.Completed);
    expect(r.narrative.getActiveState(TALLY)).toBe('initial');
  });

  it('未系绳不能空发捞箱成功；实际成功后修岸才扣薄篾，重复信号不重结', async () => {
    const r = await runtime();
    await r.signal('ow_water_post');
    await r.signal('ow_water_pull_success');
    expect(r.narrative.getActiveState('flow_ow_water_clear')).toBe('initial');
    r.inventory.addItem('ow_rope');
    r.inventory.addItem('ow_bamboo', 2);
    await r.signal('ow_water_rig');
    expect(r.inventory.hasItem('ow_rope')).toBe(true);
    await r.signal('ow_water_repair');
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(2);
    await r.signal('ow_water_pull_success');
    await r.signal('ow_water_repair');
    await r.signal('ow_water_repair');
    await r.signal('ow_water_divert');
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.inventory.getItemCount('ow_rope')).toBe(1);
    expect(r.inventory.getCoins()).toBe(12);
    expect(r.narrative.getActiveState('flow_ow_water')).toBe('repaired');
    expect(r.qm.getStatus('ow_water')).toBe(QuestStatus.Completed);
  });

  it('标记高路不需要绳或捞箱，炭只耗一支；终局保持改道结果', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_charcoal', 3);
    await r.signal('ow_water_mark');
    expect(r.inventory.getItemCount('ow_charcoal')).toBe(3);
    await r.signal('ow_water_stone');
    await r.signal('ow_water_mark');
    await r.signal('ow_water_mark');
    expect(r.inventory.getItemCount('ow_charcoal')).toBe(2);
    await r.signal('ow_water_divert');
    r.inventory.addItem('ow_rope');
    r.inventory.addItem('ow_bamboo');
    await r.signal('ow_water_rig');
    await r.signal('ow_water_pull_success');
    await r.signal('ow_water_repair');
    expect(r.narrative.getActiveState('flow_ow_water')).toBe('diverted');
    expect(r.narrative.getActiveState('flow_ow_water_clear')).toBe('initial');
    expect(r.inventory.getCoins()).toBe(5);
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
  });

  it('捞桶可先于问人，木桶在清苔后保留，材料和布条均只结一次', async () => {
    const r = await runtime();
    await r.signal('ow_bucket_pull_success');
    expect(r.inventory.getItemCount('ow_bucket')).toBe(1);
    await r.signal('ow_steps_inspect');
    await r.signal('ow_steps_clean');
    expect(r.narrative.getActiveState('flow_ow_steps')).toBe('accepted');
    r.inventory.addItem('ow_bamboo', 2);
    await r.signal('ow_steps_clean');
    await r.signal('ow_steps_clean');
    expect(r.inventory.getItemCount('ow_bamboo')).toBe(1);
    expect(r.inventory.getItemCount('ow_bucket')).toBe(1);
    await r.signal('ow_bucket_return');
    await r.signal('ow_bucket_return');
    expect(r.inventory.getItemCount('ow_cloth')).toBe(2);
    expect(r.qm.getStatus('ow_bucket')).toBe(QuestStatus.Completed);
    expect(r.qm.getStatus('ow_steps')).toBe(QuestStatus.Completed);
  });

  it.each(['repaired', 'diverted'])('%s 结果同步钱叔的位置与找人引导', async (outcome) => {
    const r = await runtime();
    const scheduler = new NpcScheduleSystem(r.bus);
    scheduler.registerDefs(schedules.schedules as never);
    scheduler.bindRuntime({ evalConditions: (cs: ConditionExpr[] | undefined) => (cs ?? []).every(c => evaluateConditionExpr(c, r.context())) } as never);
    if (outcome === 'repaired') {
      r.inventory.addItem('ow_rope'); r.inventory.addItem('ow_bamboo');
      await r.signal('ow_water_post'); await r.signal('ow_water_rig');
      await r.signal('ow_water_pull_success'); await r.signal('ow_water_repair');
    } else {
      r.inventory.addItem('ow_charcoal'); await r.signal('ow_water_stone');
      await r.signal('ow_water_mark'); await r.signal('ow_water_divert');
    }
    const guidance = (quests as QuestDef[]).find(q => q.id === 'ow_mooring')!.objectives!.find(o => o.id === 'mooring_return_obj')!.guidance!;
    for (const hour of [10, 19, 21, 2]) {
      r.flags.set('minutes_of_day', hour * 60);
      const place = outcome === 'diverted' && hour === 19 ? 'bridge_underpass' : '码头白天';
      expect(scheduler.resolvePlacement('ow_qian', hour * 60)?.scene).toBe(place);
      expect(guidance.filter(g => g.kind === 'worldMarker' && (g.conditions ?? []).every(c => evaluateConditionExpr(c, r.context()))).map(g => g.sceneId)).toEqual([place]);
    }
  });

  it('系绳且已标路的中途存读档，保留两种选择，不重复扣炭', async () => {
    const r = await runtime();
    r.inventory.addItem('ow_rope'); r.inventory.addItem('ow_charcoal', 2);
    await r.signal('ow_water_rig'); await r.signal('ow_water_stone'); await r.signal('ow_water_mark');
    const loaded = await runtime();
    loaded.inventory.deserialize(r.inventory.serialize() as Parameters<InventoryManager['deserialize']>[0]);
    loaded.narrative.deserialize(r.narrative.serialize());
    await loaded.signal('ow_water_mark');
    expect(loaded.inventory.getItemCount('ow_charcoal')).toBe(1);
    expect(loaded.narrative.getActiveState('flow_ow_water_rig')).toBe('ready');
    await loaded.signal('ow_water_divert');
    expect(loaded.qm.getStatus('ow_water')).toBe(QuestStatus.Completed);
    expect(loaded.inventory.getCoins()).toBe(5);
  });
});
