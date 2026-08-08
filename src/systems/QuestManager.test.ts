import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { QuestManager } from './QuestManager';
import { QuestStatus } from '../data/types';
import type { NarrativeRunPanelInfo, QuestDef } from '../data/types';

const DEFS: QuestDef[] = [
  {
    id: 'normal_quest', group: 'g', type: 'side', title: '普通任务', description: '',
    preconditions: [{ flag: 'pre_ok' } as never], completionConditions: [{ flag: 'done_ok' } as never], rewards: [],
  },
  {
    id: 'job_quest', group: 'g', type: 'repeatable', runArchetype: 'flow_job', title: '零活任务', description: '',
    preconditions: [], completionConditions: [], rewards: [],
  },
];

function runInfo(over: Partial<NarrativeRunPanelInfo> = {}): NarrativeRunPanelInfo {
  return { graphId: 'flow_job', active: undefined, activeLabel: undefined, ordinal: 0, activated: false, suspended: false, settled: [], ...over };
}

/** 提示决策攒在微任务里（同批合流，见玩法文档 D9）：断言提示前必须让出一次 */
const flushAnnounce = () => Promise.resolve();

async function makeQuestManager(defs: QuestDef[] = DEFS) {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const qm = new QuestManager(eventBus, flagStore, actionExecutor);
  const ctx = {
    strings: { get: (cat: string, key: string, vars?: Record<string, string | number>) => `${cat}.${key}:${vars?.title ?? ''}` },
    assetManager: { loadJson: async () => JSON.parse(JSON.stringify(defs)) },
  };
  qm.init(ctx as never);
  await qm.loadDefs();
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  for (const name of ['quest:accepted', 'quest:completed', 'quest:untracked', 'notification:show', 'quest:changed', 'quest:announce']) {
    eventBus.on(name, (p: Record<string, unknown>) => events.push({ name, payload: p }));
  }
  return { eventBus, flagStore, qm, events };
}

describe('QuestManager repeatable（活计镜像任务 S2批2）', () => {
  it('repeatable 不进状态机：不种状态、evaluate/列表/主线全部排除', async () => {
    const { qm, flagStore } = await makeQuestManager();
    // 满足普通任务的自动接取，顺带确认 evaluate 不碰 repeatable
    flagStore.set('pre_ok', true);
    expect(qm.getStatus('normal_quest')).toBe(QuestStatus.Active);
    expect(qm.getStatus('job_quest')).toBe(QuestStatus.Inactive); // 从未种入
    expect(qm.getActiveQuests().map((q) => q.def.id)).toEqual(['normal_quest']);
    expect(qm.getCompletedQuests()).toEqual([]);
    // 序列化里没有 repeatable 条目
    const saved = qm.serialize() as { statuses: Record<string, number> };
    expect(Object.keys(saved.statuses)).toEqual(['normal_quest']);
  });

  it('accept/complete/debugSet 对 repeatable 拒绝（无状态机可驱动）', async () => {
    const { qm, flagStore } = await makeQuestManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    qm.acceptQuest('job_quest');
    qm.debugSetQuestStatus('job_quest', 'completed');
    warn.mockRestore();
    expect(qm.getStatus('job_quest')).toBe(QuestStatus.Inactive);
    expect(flagStore.get('quest_job_quest_status')).toBeUndefined();
  });

  it('runStarted → quest:accepted+通知；runSettled → quest:completed+通知（不落 Completed 状态）', async () => {
    const { eventBus, qm, events } = await makeQuestManager();
    eventBus.emit('narrative:runStarted', { archetypeId: 'flow_job', ordinal: 1 });
    expect(events).toContainEqual({ name: 'quest:accepted', payload: { questId: 'job_quest', title: '零活任务', repeatable: true } });
    await flushAnnounce();
    expect(events).toContainEqual({ name: 'notification:show', payload: { text: 'notifications.questAccepted:零活任务', type: 'quest' } });
    events.length = 0;
    eventBus.emit('narrative:runSettled', { archetypeId: 'flow_job', exitStateId: 'delivered' });
    expect(events).toContainEqual({ name: 'quest:completed', payload: { questId: 'job_quest', title: '零活任务', repeatable: true } });
    expect(events).toContainEqual({ name: 'notification:show', payload: { text: 'notifications.questCompleted:零活任务', type: 'quest' } });
    expect(qm.getCompletedQuests()).toEqual([]); // 结算≠Completed 状态
    // 未注册的活计不镜像
    events.length = 0;
    eventBus.emit('narrative:runStarted', { archetypeId: 'flow_unknown', ordinal: 1 });
    await flushAnnounce();
    expect(events).toEqual([]);
  });

  it('runActivated：切走 untrack、切入即接管当前任务槽；弃置带 jobDiscarded 通知、结算不带', async () => {
    const { eventBus, qm, events } = await makeQuestManager();
    eventBus.emit('narrative:runActivated', { archetypeId: null, previous: 'flow_job' });
    expect(events).toContainEqual({ name: 'quest:untracked', payload: { questId: 'job_quest' } });
    events.length = 0;
    eventBus.emit('narrative:runActivated', { archetypeId: 'flow_job', previous: null });
    // 活计被激活 = 强追踪意图：当前任务槽跟随（旧实现靠补发 quest:accepted{restored} 让 HUD 记住，已废）
    expect(qm.getFocusedQuestId()).toBe('job_quest');
    expect(events.some((e) => e.name === 'quest:changed')).toBe(true);
    events.length = 0;
    eventBus.emit('narrative:stateChanged', { graphId: 'flow_job', from: 'doing', to: '', cause: 'discard', triggerKey: 'discard:flow_job' });
    expect(events).toContainEqual({ name: 'notification:show', payload: { text: 'notifications.jobDiscarded:零活任务', type: 'quest' } });
    events.length = 0;
    eventBus.emit('narrative:stateChanged', { graphId: 'flow_job', from: 'delivered', to: '', cause: 'settle', triggerKey: 'settle:flow_job' });
    expect(events.filter((e) => e.name === 'notification:show')).toEqual([]);
  });

  it('deserialize 丢弃 repeatable 陈旧状态（旧档迁移）且不同步其 flag', async () => {
    const { qm, flagStore } = await makeQuestManager();
    qm.deserialize({ normal_quest: 1, job_quest: 2 });
    expect(qm.getStatus('normal_quest')).toBe(QuestStatus.Active);
    expect(qm.getStatus('job_quest')).toBe(QuestStatus.Inactive);
    expect(qm.getCompletedQuests()).toEqual([]);
    expect(flagStore.get('quest_job_quest_status')).toBeUndefined();
    expect(flagStore.get('quest_normal_quest_status')).toBe(1);
  });

  it('setRestoring(false) 按激活槽重建 HUD 追踪（restore 静默不发 runActivated 的补偿）', async () => {
    const { qm, events } = await makeQuestManager();
    qm.setRunInfoProvider((gid) => (gid === 'flow_job' ? runInfo({ active: 'doing', ordinal: 2, activated: true }) : null));
    qm.setRestoring(true);
    expect(events).toEqual([]);
    qm.setRestoring(false);
    expect(events).toContainEqual({
      name: 'quest:accepted',
      payload: { questId: 'job_quest', title: '零活任务', repeatable: true, restored: true },
    });
    // 恢复完成点必须广播一次「任务态变了」：展示层全靠它重建（不再逐条补发事件）
    expect(events.some((e) => e.name === 'quest:changed')).toBe(true);
    // 无激活实例时不补发 quest:accepted
    events.length = 0;
    qm.setRunInfoProvider(() => runInfo({ active: 'doing', activated: false, suspended: true }));
    qm.setRestoring(false);
    expect(events.filter((e) => e.name === 'quest:accepted')).toEqual([]);
  });

  it('getRepeatableQuestEntries：无实例无历史隐藏；有实例/有归档露出', async () => {
    const { qm } = await makeQuestManager();
    expect(qm.getRepeatableQuestEntries()).toEqual([]); // provider 未注入
    qm.setRunInfoProvider(() => runInfo());
    expect(qm.getRepeatableQuestEntries()).toEqual([]); // 蛰伏隐藏
    qm.setRunInfoProvider(() => runInfo({ active: 'doing', activeLabel: '干着', ordinal: 1, activated: true }));
    expect(qm.getRepeatableQuestEntries()).toMatchObject([{ def: { id: 'job_quest' }, run: { active: 'doing', ordinal: 1 } }]);
    qm.setRunInfoProvider(() => runInfo({ settled: [{ exitId: 'delivered', label: '已交付', count: 3 }] }));
    expect(qm.getRepeatableQuestEntries()).toMatchObject([{ def: { id: 'job_quest' }, run: { active: undefined } }]);
  });

  it('destroy 后生命周期事件不再镜像（监听清理完整）', async () => {
    const { eventBus, qm, events } = await makeQuestManager();
    qm.destroy();
    eventBus.emit('narrative:runStarted', { archetypeId: 'flow_job', ordinal: 1 });
    eventBus.emit('narrative:runSettled', { archetypeId: 'flow_job', exitStateId: 'delivered' });
    await flushAnnounce();
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 当前任务槽 / 目标 / 引导 / 提示（玩法文档 D6–D9）
// ---------------------------------------------------------------------------

const FOCUS_DEFS: QuestDef[] = [
  {
    id: 'main_a', group: 'g', type: 'main', title: '主线甲', description: '',
    preconditions: [{ flag: 'a_ok' } as never], completionConditions: [{ flag: 'a_done' } as never], rewards: [],
    objectives: [
      { id: 'o1', text: '先去码头', completeWhen: [{ flag: 'at_dock' } as never] },
      { id: 'o2', text: '再找老乡', completeWhen: [{ flag: 'met' } as never], guidance: [{ kind: 'mapMarker', sceneId: 'dock' }] },
    ],
    guidance: [{ kind: 'sceneHint', sceneId: 'teahouse', text: '先出门' }],
  },
  {
    id: 'main_b', group: 'g', type: 'main', title: '主线乙', description: '',
    preconditions: [{ flag: 'b_ok' } as never], completionConditions: [{ flag: 'b_done' } as never], rewards: [],
  },
  {
    id: 'side_c', group: 'g', type: 'side', title: '支线丙', description: '',
    preconditions: [{ flag: 'c_ok' } as never], completionConditions: [], rewards: [],
    announce: 'none',
  },
  {
    id: 'side_grab', group: 'g', type: 'side', title: '抢焦点的支线', description: '',
    preconditions: [{ flag: 'grab_ok' } as never], completionConditions: [], rewards: [],
    autoFocus: true, announce: 'toast',
  },
  {
    id: 'side_never', group: 'g', type: 'side', title: '从不抢焦点', description: '',
    preconditions: [{ flag: 'never_ok' } as never], completionConditions: [], rewards: [],
    autoFocus: false,
  },
];

describe('QuestManager 当前任务槽（D6）', () => {
  it('接取时空槽自动占位；已有当前任务则不抢', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    expect(qm.getFocusedQuestId()).toBeNull();
    flagStore.set('a_ok', true);
    expect(qm.getFocusedQuestId()).toBe('main_a');
    flagStore.set('b_ok', true);
    expect(qm.getFocusedQuestId()).toBe('main_a'); // 槽非空，不抢
  });

  it('autoFocus:true 接取即抢占；autoFocus:false 连空槽也不占', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('a_ok', true);
    flagStore.set('grab_ok', true);
    expect(qm.getFocusedQuestId()).toBe('side_grab');

    const fresh = await makeQuestManager(FOCUS_DEFS);
    fresh.flagStore.set('never_ok', true);
    expect(fresh.qm.getStatus('side_never')).toBe(QuestStatus.Active);
    expect(fresh.qm.getFocusedQuestId()).toBeNull();
  });

  it('当前任务完成后自动改选（主线优先，同级取最近接取）', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('c_ok', true);      // 支线先接，占住空槽
    expect(qm.getFocusedQuestId()).toBe('side_c');
    flagStore.set('a_ok', true);      // 主线后接，不抢
    expect(qm.getFocusedQuestId()).toBe('side_c');
    flagStore.set('b_ok', true);
    // 手动把当前任务切到 main_a，再让它完成 → 应改选到另一条主线而不是支线
    await qm.requestFocusQuest('main_a');
    expect(qm.getFocusedQuestId()).toBe('main_a');
    flagStore.set('a_done', true);
    expect(qm.getStatus('main_a')).toBe(QuestStatus.Completed);
    expect(qm.getFocusedQuestId()).toBe('main_b');
  });

  it('当前任务完成时槽顺着 nextQuests 交给链上的下一条，不被旁边的支线截胡', async () => {
    const defs: QuestDef[] = [
      {
        id: 'chain_a', group: 'g', type: 'main', title: '链甲', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [{ flag: 'a_done' } as never],
        rewards: [], nextQuests: [{ questId: 'chain_b', conditions: [] }],
      },
      {
        id: 'chain_b', group: 'g', type: 'main', title: '链乙', description: '',
        preconditions: [], completionConditions: [], rewards: [],
      },
      {
        id: 'noise_side', group: 'g', type: 'side', title: '碍事的支线', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [],
      },
    ];
    const { qm, flagStore } = await makeQuestManager(defs);
    flagStore.set('go', true);
    expect(qm.getFocusedQuestId()).toBe('chain_a');
    flagStore.set('a_done', true);
    // 旧写法在这里会先按"优先级最高的另一条 Active"改选 → 落到 noise_side
    expect(qm.getStatus('chain_b')).toBe(QuestStatus.Active);
    expect(qm.getFocusedQuestId()).toBe('chain_b');
  });

  it('链断了（末章 / 后继被条件挡住）才轮到自动改选兜底', async () => {
    const defs: QuestDef[] = [
      {
        id: 'last_main', group: 'g', type: 'main', title: '末章', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [{ flag: 'done' } as never],
        rewards: [],
      },
      {
        id: 'other_side', group: 'g', type: 'side', title: '支线', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [],
      },
    ];
    const { qm, flagStore } = await makeQuestManager(defs);
    flagStore.set('go', true);
    expect(qm.getFocusedQuestId()).toBe('last_main');
    flagStore.set('done', true);
    expect(qm.getFocusedQuestId()).toBe('other_side');
  });

  it('奖励批异步时，槽不会挂着一条已完成的任务（HUD 不显示错信息）', async () => {
    let release: (() => void) | null = null;
    const defs: QuestDef[] = [
      {
        id: 'slow_main', group: 'g', type: 'main', title: '慢主线', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [{ flag: 'done' } as never],
        rewards: [{ type: 'slowReward', params: {} } as never],
        nextQuests: [{ questId: 'after', conditions: [] }],
      },
      {
        id: 'after', group: 'g', type: 'main', title: '后一条', description: '',
        preconditions: [], completionConditions: [], rewards: [],
      },
    ];
    const { qm, flagStore } = await makeQuestManager(defs);
    (qm as unknown as { actionExecutor: { register: (t: string, h: () => Promise<void>, p: string[]) => void } })
      .actionExecutor.register('slowReward', () => new Promise<void>((res) => { release = res; }), []);

    flagStore.set('go', true);
    expect(qm.getFocusedQuestId()).toBe('slow_main');
    flagStore.set('done', true);
    // 奖励还没跑完：槽已清空，绝不能还指着 slow_main
    expect(qm.getFocusedQuestId()).toBeNull();
    expect(qm.getFocusedQuestView()).toBeNull();

    await new Promise((r) => setTimeout(r, 0));
    (release as unknown as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(qm.getFocusedQuestId()).toBe('after');
  });

  it('奖励等待期间玩家显式挑了别的任务，链不许再把槽拽回来', async () => {
    let release: (() => void) | null = null;
    const defs: QuestDef[] = [
      {
        id: 'slow_main', group: 'g', type: 'main', title: '慢主线', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [{ flag: 'done' } as never],
        rewards: [{ type: 'slowReward2', params: {} } as never],
        nextQuests: [{ questId: 'after', conditions: [] }],
      },
      {
        id: 'after', group: 'g', type: 'main', title: '后一条', description: '',
        preconditions: [], completionConditions: [], rewards: [],
      },
      {
        id: 'player_pick', group: 'g', type: 'side', title: '玩家自己挑的', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [],
      },
    ];
    const { qm, flagStore } = await makeQuestManager(defs);
    (qm as unknown as { actionExecutor: { register: (t: string, h: () => Promise<void>, p: string[]) => void } })
      .actionExecutor.register('slowReward2', () => new Promise<void>((res) => { release = res; }), []);

    flagStore.set('go', true);
    flagStore.set('done', true);
    expect(qm.getFocusedQuestId()).toBeNull();
    // 奖励还在跑，玩家在面板上显式挑了另一条
    await qm.requestFocusQuest('player_pick');
    expect(qm.getFocusedQuestId()).toBe('player_pick');

    await new Promise((r) => setTimeout(r, 0));
    (release as unknown as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(qm.getStatus('after')).toBe(QuestStatus.Active);
    // 玩家的显式选择压过链式自动交接
    expect(qm.getFocusedQuestId()).toBe('player_pick');
  });

  it('当前任务完成时若槽不在它身上，槽不动', async () => {
    const defs: QuestDef[] = [
      {
        id: 'bg_main', group: 'g', type: 'main', title: '背景主线', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [{ flag: 'done' } as never],
        rewards: [], nextQuests: [{ questId: 'bg_next', conditions: [] }],
      },
      {
        id: 'bg_next', group: 'g', type: 'main', title: '背景后继', description: '',
        preconditions: [], completionConditions: [], rewards: [],
      },
      {
        id: 'watched', group: 'g', type: 'side', title: '玩家盯着的支线', description: '',
        preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [],
      },
    ];
    const { qm, flagStore } = await makeQuestManager(defs);
    flagStore.set('go', true);
    await qm.requestFocusQuest('watched');
    expect(qm.getFocusedQuestId()).toBe('watched');
    flagStore.set('done', true);
    expect(qm.getStatus('bg_next')).toBe(QuestStatus.Active);
    expect(qm.getFocusedQuestId()).toBe('watched');
  });

  it('requestFocusQuest 拒绝未接取/已完成的任务，null 清空', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await qm.requestFocusQuest('main_a');            // 还没接取
    expect(qm.getFocusedQuestId()).toBeNull();
    await qm.requestFocusQuest('不存在的任务');
    expect(qm.getFocusedQuestId()).toBeNull();
    warn.mockRestore();
    flagStore.set('a_ok', true);
    await qm.requestFocusQuest('main_a');
    expect(qm.getFocusedQuestId()).toBe('main_a');
    await qm.requestFocusQuest(null);
    expect(qm.getFocusedQuestId()).toBeNull();
  });

  it('把主线设为当前任务时不动活计激活槽（否则不可恢复的在途活计会被作废）', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    const activate = vi.fn(async () => {});
    qm.setActivateRunHandler(activate);
    flagStore.set('a_ok', true);
    await qm.requestFocusQuest('main_a');
    expect(activate).not.toHaveBeenCalled();
  });

  it('当前任务槽进存档；旧档（扁平形状）照吃且槽为空', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('a_ok', true);
    const saved = qm.serialize() as { statuses: Record<string, number>; focusedQuestId: string | null };
    expect(saved.focusedQuestId).toBe('main_a');

    const fresh = await makeQuestManager(FOCUS_DEFS);
    fresh.qm.deserialize(saved);
    expect(fresh.qm.getFocusedQuestId()).toBe('main_a');

    const legacy = await makeQuestManager(FOCUS_DEFS);
    legacy.qm.deserialize({ main_a: 1 });
    expect(legacy.qm.getStatus('main_a')).toBe(QuestStatus.Active);
    expect(legacy.qm.getFocusedQuestId()).toBeNull();
  });
});

describe('QuestManager 目标与引导（D7 / D8）', () => {
  it('目标勾选由条件派生；当前目标 = 第一条未完成的必做目标', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('a_ok', true);
    expect(qm.getQuestObjectives('main_a').map((o) => o.done)).toEqual([false, false]);
    expect(qm.getCurrentObjective('main_a')?.id).toBe('o1');
    flagStore.set('at_dock', true);
    expect(qm.getQuestObjectives('main_a').map((o) => o.done)).toEqual([true, false]);
    expect(qm.getCurrentObjective('main_a')?.id).toBe('o2');
    flagStore.set('met', true);
    expect(qm.getCurrentObjective('main_a')).toBeNull();
  });

  it('目标勾掉会广播 quest:changed（HUD 的目标行与引导靠它更新）', async () => {
    const { qm, flagStore, events } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('a_ok', true);
    events.length = 0;
    flagStore.set('at_dock', true);
    expect(events.filter((e) => e.name === 'quest:changed').length).toBeGreaterThan(0);
  });

  it('引导取当前目标的，没配则回落任务级；不是当前任务就不出引导', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('a_ok', true);
    // 当前目标 o1 没配 guidance → 回落任务级 sceneHint
    expect(qm.getActiveGuidance()).toEqual([{ kind: 'sceneHint', sceneId: 'teahouse', text: '先出门' }]);
    flagStore.set('at_dock', true);
    // 当前目标变成 o2，它自己有 guidance
    expect(qm.getActiveGuidance()).toEqual([{ kind: 'mapMarker', sceneId: 'dock' }]);
    await qm.requestFocusQuest(null);
    expect(qm.getActiveGuidance()).toEqual([]);
  });

  it('任务完成后目标一律视为勾掉（不留"已了却没勾完"的自相矛盾）', async () => {
    const { qm, flagStore } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('a_ok', true);
    flagStore.set('a_done', true);
    expect(qm.getQuestObjectives('main_a').map((o) => o.done)).toEqual([true, true]);
  });
});

describe('QuestManager 接取提示（D9）', () => {
  it('缺省档位：主线走横幅、支线走木条', async () => {
    const { qm, flagStore, events } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('a_ok', true);
    await flushAnnounce();
    expect(events).toContainEqual({
      name: 'quest:announce',
      payload: { questId: 'main_a', title: '主线甲', mode: 'accept', kind: 'quest', objective: '先去码头' },
    });

    events.length = 0;
    flagStore.set('grab_ok', true);
    await flushAnnounce();
    expect(events.filter((e) => e.name === 'quest:announce')).toEqual([]);
    expect(events).toContainEqual({
      name: 'notification:show',
      payload: { text: 'notifications.questAccepted:抢焦点的支线', type: 'quest' },
    });
  });

  it('announce:none 完全不提示', async () => {
    const { flagStore, events } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('c_ok', true);
    await flushAnnounce();
    expect(events.filter((e) => e.name === 'quest:announce' || e.name === 'notification:show')).toEqual([]);
  });

  it('同批多条都想要横幅时只出一条（主线优先），其余降级木条', async () => {
    const defs: QuestDef[] = [
      { id: 'm1', group: 'g', type: 'main', title: '主线一', description: '', preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [] },
      { id: 'm2', group: 'g', type: 'main', title: '主线二', description: '', preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [] },
      { id: 's1', group: 'g', type: 'side', title: '支线一', description: '', preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [], announce: 'banner' },
    ];
    const { flagStore, events } = await makeQuestManager(defs);
    flagStore.set('go', true);
    await flushAnnounce();
    const banners = events.filter((e) => e.name === 'quest:announce');
    expect(banners).toHaveLength(1);
    expect(banners[0].payload.questId).toBe('m1'); // 同优先级取数据序靠前的
    const toasts = events.filter((e) => e.name === 'notification:show');
    expect(toasts.map((t) => t.payload.text)).toEqual([
      'notifications.questAccepted:主线二',
      'notifications.questAccepted:支线一',
    ]);
  });

  it('同一批里「接取 + 立刻 setFocusedQuest{announce}」升级成横幅，不被先算出的木条档钉死', async () => {
    const { qm, flagStore, events } = await makeQuestManager(FOCUS_DEFS);
    // side_grab 自己是 toast 档；接取与显式提示落在同一批
    flagStore.set('grab_ok', true);
    await qm.requestFocusQuest('side_grab', { announce: true });
    await flushAnnounce();
    const banners = events.filter((e) => e.name === 'quest:announce');
    expect(banners).toHaveLength(1);
    expect(banners[0].payload).toMatchObject({ questId: 'side_grab', mode: 'focus' });
    expect(events.filter((e) => e.name === 'notification:show')).toEqual([]);
  });

  it('setFocusedQuest 勾了 announce 就出横幅（覆盖任务自己的档位）', async () => {
    const { qm, flagStore, events } = await makeQuestManager(FOCUS_DEFS);
    flagStore.set('c_ok', true);   // side_c 自己是 announce:none
    await flushAnnounce();
    events.length = 0;
    await qm.requestFocusQuest('side_c', { announce: true });
    await flushAnnounce();
    expect(events).toContainEqual({
      name: 'quest:announce',
      payload: { questId: 'side_c', title: '支线丙', mode: 'focus', kind: 'quest', objective: '' },
    });
  });

  it('读档恢复期不出任何提示', async () => {
    const { qm, flagStore, events } = await makeQuestManager(FOCUS_DEFS);
    qm.setRestoring(true);
    flagStore.set('a_ok', true);
    await flushAnnounce();
    expect(events.filter((e) => e.name === 'quest:announce' || e.name === 'notification:show')).toEqual([]);
    qm.setRestoring(false);
  });
});

describe('QuestManager 事件时序（D2 / D3）', () => {
  it('接取动作批不阻塞 quest:changed —— 两种接取路径同一时刻同步展示层', async () => {
    let resolveAccept: (() => void) | null = null;
    const defs: QuestDef[] = [{
      id: 'slow', group: 'g', type: 'side', title: '慢任务', description: '',
      preconditions: [{ flag: 'go' } as never], completionConditions: [], rewards: [],
      acceptActions: [{ type: 'slowThing', params: {} } as never],
    }];
    const { eventBus, flagStore, qm, events } = await makeQuestManager(defs);
    // 注册一条"要很久才完"的动作，模拟接取时挂一整段对话
    (qm as unknown as { actionExecutor: { register: (t: string, h: () => Promise<void>, p: string[]) => void } })
      .actionExecutor.register('slowThing', () => new Promise<void>((res) => { resolveAccept = res; }), []);

    flagStore.set('go', true);
    // 状态与广播在同一刻发生，不等动作批
    expect(qm.getStatus('slow')).toBe(QuestStatus.Active);
    expect(events.some((e) => e.name === 'quest:changed')).toBe(true);
    expect(events.some((e) => e.name === 'quest:accepted')).toBe(false); // 副作用事件仍等动作批
    // 动作批挂在 questActionTail 上，下一个微任务才真正开跑：先让它跑起来再放行
    await new Promise((r) => setTimeout(r, 0));
    (resolveAccept as unknown as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(events.some((e) => e.name === 'quest:accepted')).toBe(true);
    void eventBus;
  });
});
