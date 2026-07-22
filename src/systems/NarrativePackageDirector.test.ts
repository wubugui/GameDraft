import { describe, expect, it } from 'vitest';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { NarrativePackageDirector, type NarrativePackageRow } from './NarrativePackageDirector';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** 最小环境：真 EventBus + 可控叙事记录 stub（reached 集）+ 活跃标记集 stub。
 *  导演只维护"当前活跃章节"组织标记（不触发演出、不 gate 行为，2026-07-19 降级）；本测试验其跟踪逻辑对不对。 */
async function makeDirector(rows: NarrativePackageRow[]) {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const live = new Set<string>();
  const liveLog: Array<[string, boolean]> = [];
  const reached = new Set<string>();      // "图:状态" 到达记录（模拟永存状态）

  const director = new NarrativePackageDirector(eventBus);
  director.setControl({
    setNarrativePackageLive: async (pkg, isLive) => {
      liveLog.push([pkg, isLive]);
      if (isLive) live.add(pkg); else live.delete(pkg);
    },
    isNarrativePackageLive: (pkg) => live.has(pkg),
  });
  director.setConditionEvalContextFactory(() => ({
    flagStore,
    questManager: { getStatus: () => 0 } as never,
    scenarioState: {} as never,
    narrativeState: {
      getActiveState: () => undefined,
      isStateActive: () => false,
      hasReachedState: (g: string, s: string) => reached.has(`${g}:${s}`),
      getGraph: () => undefined,
    } as never,
  }));
  director.init({
    eventBus, flagStore,
    strings: { get: (_c: string, k: string) => k },
    assetManager: { loadJson: async () => ({ packages: rows }) },
  } as never);
  await director.loadDefs();
  return { eventBus, director, live, liveLog, reached };
}

const DONE_LEAF = { narrative: 'scenario_op', state: 'over', reached: true };

describe('NarrativePackageDirector（维护活跃章节组织标记：按里程碑/场景 标活跃/非活跃，不触发演出、不 gate 行为）', () => {
  it('里程碑驱动包行：when 成立 tick 载入=live 闩锁不重载；done 成立即 dormant，状态永存', async () => {
    const { eventBus, live, liveLog, reached } = await makeDirector([
      { id: '一章', package: 'ch1', when: [{ narrative: 'flow', state: 'beat1', reached: true }], done: [DONE_LEAF] },
    ]);
    // when 未成立：不载
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'a', to: 'b' });
    await flush();
    expect(live.has('ch1')).toBe(false);
    // when 成立 → 载入
    reached.add('flow:beat1');
    eventBus.emit('narrative:stateChanged', { graphId: 'flow', from: 'a', to: 'beat1' });
    await flush();
    expect(liveLog).toEqual([['ch1', true]]);
    // 已 live：再 tick 不重载
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'b', to: 'c' });
    await flush();
    expect(liveLog).toEqual([['ch1', true]]);
    // done 成立 → dormant
    reached.add('scenario_op:over');
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'c', to: 'd' });
    await flush();
    expect(live.has('ch1')).toBe(false);
    expect(liveLog).toEqual([['ch1', true], ['ch1', false]]);
    // 收工后不再重载（done 已成立）
    reached.delete('flow:beat1'); reached.add('flow:beat1'); // when 仍成立，但 done 也成立
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'd', to: 'e' });
    await flush();
    expect(liveLog).toEqual([['ch1', true], ['ch1', false]]);
  });

  it('场景驱动包行：进对应场景才载包；别的场景/tick 不载；done 后不再载', async () => {
    const { eventBus, live, liveLog, reached } = await makeDirector([
      { id: '支线', package: 'side', scene: '义庄', done: [DONE_LEAF] },
    ]);
    eventBus.emit('scene:revealed', { sceneId: '别处' });     // 别的场景不载
    await flush();
    expect(live.has('side')).toBe(false);
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'a', to: 'b' }); // 有 scene 的行不在 tick 载
    await flush();
    expect(live.has('side')).toBe(false);
    eventBus.emit('scene:revealed', { sceneId: '义庄' });      // 进本场景 → 载
    await flush();
    expect(liveLog).toEqual([['side', true]]);
    // done 成立后收工 + 再进场不重载
    reached.add('scenario_op:over');
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'b', to: 'c' });
    await flush();
    expect(live.has('side')).toBe(false);
    eventBus.emit('scene:revealed', { sceneId: '义庄' });
    await flush();
    expect(liveLog).toEqual([['side', true], ['side', false]]);
  });

  it('restoring 抑制评估；恢复完成跑一轮装卸清扫', async () => {
    const { eventBus, director, live, reached } = await makeDirector([
      { id: '常开', package: 'amb', when: [{ narrative: 'flow', state: 'w', reached: true }], done: [DONE_LEAF] },
    ]);
    reached.add('flow:w');
    eventBus.emit('narrative:stateChanged', { graphId: 'flow', from: 'a', to: 'w' });
    await flush();
    expect(live.has('amb')).toBe(true);
    // restoring：评估抑制
    director.setRestoring(true);
    reached.add('scenario_op:over');
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'w', to: 'z' });
    await flush();
    expect(live.has('amb')).toBe(true);
    // 恢复完成：清扫跑（done 成立→dormant）
    director.setRestoring(false);
    await flush();
    expect(live.has('amb')).toBe(false);
  });

  it('无 package 的行被忽略（导演只管包）', async () => {
    const { eventBus, liveLog } = await makeDirector([
      { id: '空行', scene: 'teahouse' } as NarrativePackageRow,
    ]);
    eventBus.emit('scene:revealed', { sceneId: 'teahouse' });
    await flush();
    expect(liveLog).toEqual([]);
  });
});
