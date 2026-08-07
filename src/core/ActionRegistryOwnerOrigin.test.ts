import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import { resolveDialogueOwner } from './actionOrigin';
import type { ActionOriginContext } from '../data/types';

/**
 * 最后一处未覆盖的接缝：`startDialogueGraph` handler 有没有把**来源上下文**交给桥接层。
 *
 * 这一跳断了的话，前面 zone / 热区 / 叙事图 / 任务把 owner 线程化下来全是白做——
 * 动作参数里没写 owner 的图照旧拿不到 owner，ownerState 静默走 missingWrapperNext。
 * 别的测试各自覆盖了 ActionExecutor 的线程化与 Game 的四档判定，唯独中间这一跳
 * 只有一行 `zctx`，最容易在后续重构里被顺手抹掉。
 */
function harness() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const executor = new ActionExecutor(eventBus, flagStore);
  const calls: {
    graphId: string;
    npcId?: string;
    ownerType?: string;
    ownerId?: string;
    origin?: ActionOriginContext | null;
  }[] = [];

  const startDialogueGraph: ActionRegistryDeps['startDialogueGraph'] = async (
    graphId, _entry, npcId, ownerType, ownerId, _dim, origin,
  ) => {
    calls.push({ graphId, npcId, ownerType, ownerId, origin });
  };
  const deps = { startDialogueGraph } as unknown as ActionRegistryDeps;

  // registerActionHandlers 会注册全部动作；这里只驱动 startDialogueGraph，
  // 其它 handler 不被调用，故 deps 其余字段缺席不影响本用例。
  registerActionHandlers(executor, deps);
  return { executor, calls };
}

describe('startDialogueGraph 动作把来源上下文交给桥接层', () => {
  it('zone 来源批：origin 原样透传', async () => {
    const { executor, calls } = harness();
    await executor.executeBatchAwait(
      [{ type: 'startDialogueGraph', params: { graphId: 'dlg' } }],
      { zoneId: 'z1', ownerType: 'zone', ownerId: 'z1' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.origin).toEqual({ zoneId: 'z1', ownerType: 'zone', ownerId: 'z1' });
    // 桥接层据此解出的 owner（与 Game.ts 同一判定源）
    expect(
      resolveDialogueOwner({
        paramOwnerType: calls[0]!.ownerType,
        paramOwnerId: calls[0]!.ownerId,
        paramNpcId: calls[0]!.npcId,
        originOwnerType: calls[0]!.origin?.ownerType,
        originOwnerId: calls[0]!.origin?.ownerId,
      }),
    ).toEqual({ ownerType: 'zone', ownerId: 'z1', source: 'origin' });
  });

  it('热区来源批：origin 原样透传', async () => {
    const { executor, calls } = harness();
    await executor.executeBatchFromOwner(
      [{ type: 'startDialogueGraph', params: { graphId: 'dlg' } }],
      'hotspot',
      'h1',
    );
    expect(calls[0]!.origin).toEqual({ ownerType: 'hotspot', ownerId: 'h1' });
  });

  it('嵌套 runActions 里的 startDialogueGraph 同样拿得到来源', async () => {
    const { executor, calls } = harness();
    await executor.executeBatchFromOwner(
      [
        {
          type: 'runActions',
          params: { actions: [{ type: 'startDialogueGraph', params: { graphId: 'dlg' } }] },
        },
      ],
      'quest',
      'q1',
    );
    expect(calls[0]!.origin).toEqual({ ownerType: 'quest', ownerId: 'q1' });
  });

  it('动作显式写了 npcId 时，来源仍照传，但判定结果以 npcId 为准', async () => {
    const { executor, calls } = harness();
    await executor.executeBatchFromOwner(
      [{ type: 'startDialogueGraph', params: { graphId: 'dlg', npcId: '崖墓任务发布者' } }],
      'zone',
      'new_zone_0',
    );
    // 真实工程里 test_room_b 那条 zone 就是这么写的：运行时解出 npc:崖墓任务发布者
    expect(calls[0]!.npcId).toBe('崖墓任务发布者');
    expect(calls[0]!.origin?.ownerId).toBe('new_zone_0');
    expect(
      resolveDialogueOwner({
        paramNpcId: calls[0]!.npcId,
        originOwnerType: calls[0]!.origin?.ownerType,
        originOwnerId: calls[0]!.origin?.ownerId,
      }),
    ).toEqual({ ownerType: 'npc', ownerId: '崖墓任务发布者', source: 'npcId' });
  });

  it('无来源的批（信号 cue / 延迟事件等）传 null，不伪造 owner', async () => {
    const { executor, calls } = harness();
    await executor.executeBatchAwait([
      { type: 'startDialogueGraph', params: { graphId: 'dlg' } },
    ]);
    expect(calls[0]!.origin).toBeNull();
  });
});
