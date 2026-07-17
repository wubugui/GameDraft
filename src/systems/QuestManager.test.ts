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
  for (const name of ['quest:accepted', 'quest:completed', 'quest:untracked', 'notification:show']) {
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
    expect(Object.keys(qm.serialize() as Record<string, number>)).toEqual(['normal_quest']);
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
    expect(events).toContainEqual({ name: 'notification:show', payload: { text: 'notifications.questAccepted:零活任务', type: 'quest' } });
    events.length = 0;
    eventBus.emit('narrative:runSettled', { archetypeId: 'flow_job', exitStateId: 'delivered' });
    expect(events).toContainEqual({ name: 'quest:completed', payload: { questId: 'job_quest', title: '零活任务', repeatable: true } });
    expect(events).toContainEqual({ name: 'notification:show', payload: { text: 'notifications.questCompleted:零活任务', type: 'quest' } });
    expect(qm.getCompletedQuests()).toEqual([]); // 结算≠Completed 状态
    // 未注册的活计不镜像
    events.length = 0;
    eventBus.emit('narrative:runStarted', { archetypeId: 'flow_unknown', ordinal: 1 });
    expect(events).toEqual([]);
  });

  it('runActivated：切走 untrack、切入 accept{restored}；弃置带 jobDiscarded 通知、结算不带', async () => {
    const { eventBus, events } = await makeQuestManager();
    eventBus.emit('narrative:runActivated', { archetypeId: null, previous: 'flow_job' });
    expect(events).toContainEqual({ name: 'quest:untracked', payload: { questId: 'job_quest' } });
    events.length = 0;
    eventBus.emit('narrative:runActivated', { archetypeId: 'flow_job', previous: null });
    expect(events).toContainEqual({
      name: 'quest:accepted',
      payload: { questId: 'job_quest', title: '零活任务', repeatable: true, restored: true },
    });
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
    // 无激活实例时不补发
    events.length = 0;
    qm.setRunInfoProvider(() => runInfo({ active: 'doing', activated: false, suspended: true }));
    qm.setRestoring(false);
    expect(events).toEqual([]);
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
    expect(events).toEqual([]);
  });
});
