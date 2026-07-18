import { describe, expect, it } from 'vitest';
import { ActionExecutor } from '../core/ActionExecutor';
import { EventBus } from '../core/EventBus';
import { FlagStore } from '../core/FlagStore';
import { NarrativePackageDirector, type NarrativePackageRow } from './NarrativePackageDirector';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** 最小环境：真 EventBus/ActionExecutor + 可控的叙事记录 stub + live 集 stub。 */
async function makeDirector(rows: NarrativePackageRow[]) {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const played: string[] = [];
  actionExecutor.register('testPlay', (p) => { played.push(String(p.tag ?? '')); }, ['tag']);

  const live = new Set<string>();
  const liveLog: Array<[string, boolean]> = [];
  const reached = new Set<string>();      // "图:状态" 到达记录（模拟永存状态）

  const director = new NarrativePackageDirector(eventBus, actionExecutor);
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
  return { eventBus, director, played, live, liveLog, reached };
}

const DONE_LEAF = { narrative: 'scenario_op', state: 'over', reached: true };

describe('NarrativePackageDirector（C2 章节导演：开拍/收工按清单，状态永存直接查询）', () => {
  it('cue 行：进对应场景开拍 autoPlay；无 done=每次进场重放；done 到达后永不再拍', async () => {
    const { eventBus, played, reached } = await makeDirector([
      { id: '开场', scene: 'teahouse', autoPlay: { type: 'testPlay', params: { tag: 'op' } }, done: [DONE_LEAF] },
      { id: '梦', scene: 'dream', autoPlay: { type: 'testPlay', params: { tag: 'dream' } } },
    ]);
    eventBus.emit('scene:revealed', { sceneId: 'teahouse' });
    await flush();
    expect(played).toEqual(['op']);
    eventBus.emit('scene:revealed', { sceneId: 'other' });   // 别的场景不触发
    await flush();
    expect(played).toEqual(['op']);
    eventBus.emit('scene:revealed', { sceneId: 'dream' });   // 无 done 的梦境行：进场即放
    eventBus.emit('scene:revealed', { sceneId: 'dream' });   // 再进再放（忠实旧 onEnter 语义）
    await flush();
    expect(played).toEqual(['op', 'dream', 'dream']);
    // 剧情永远完成后（记录可查）：再进茶馆不重拍
    reached.add('scenario_op:over');
    eventBus.emit('scene:revealed', { sceneId: 'teahouse' });
    await flush();
    expect(played.filter((t) => t === 'op')).toEqual(['op']);
  });

  it('package 行：开拍=置 live+autoPlay（live 即闩锁不重拍）；done 成立即收工置 dormant', async () => {
    const { eventBus, played, live, liveLog, reached } = await makeDirector([
      {
        id: '一章', package: 'ch1', scene: 'street',
        autoPlay: { type: 'testPlay', params: { tag: 'ch1' } },
        done: [DONE_LEAF],
      },
    ]);
    eventBus.emit('scene:revealed', { sceneId: 'street' });
    await flush();
    expect(liveLog).toEqual([['ch1', true]]);
    expect(played).toEqual(['ch1']);
    eventBus.emit('scene:revealed', { sceneId: 'street' });  // 已 live：不重拍
    await flush();
    expect(played).toEqual(['ch1']);
    // 拍完（记录到达终态）→ 任意状态变化 tick 收工
    reached.add('scenario_op:over');
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'a', to: 'b' });
    await flush();
    expect(live.has('ch1')).toBe(false);
    expect(liveLog).toEqual([['ch1', true], ['ch1', false]]);
    // 收工后再进场：done 已成立，不再开拍
    eventBus.emit('scene:revealed', { sceneId: 'street' });
    await flush();
    expect(played).toEqual(['ch1']);
  });

  it('无 scene 的 package 行只在状态变化 tick 评估；restoring 抑制评估、恢复完成跑收工清扫', async () => {
    const { eventBus, director, played, live, reached } = await makeDirector([
      { id: '常开', package: 'amb', autoPlay: { type: 'testPlay', params: { tag: 'amb' } }, done: [DONE_LEAF] },
    ]);
    eventBus.emit('scene:revealed', { sceneId: 'anywhere' }); // sceneEntry 不评估无 scene 行
    await flush();
    expect(played).toEqual([]);
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'a', to: 'b' });
    await flush();
    expect(played).toEqual(['amb']);
    expect(live.has('amb')).toBe(true);
    // restoring：一切评估抑制
    director.setRestoring(true);
    reached.add('scenario_op:over');
    eventBus.emit('narrative:stateChanged', { graphId: 'x', from: 'b', to: 'c' });
    await flush();
    expect(live.has('amb')).toBe(true);
    // 恢复完成：收工清扫跑（done 已成立→dormant），且不触发任何 cue 重放
    director.setRestoring(false);
    await flush();
    expect(live.has('amb')).toBe(false);
    expect(played).toEqual(['amb']);
  });
});
