import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { makeOwnerOrigin, resolveDialogueOwner, withOwner } from './actionOrigin';
import type { ActionOriginContext } from '../data/types';

describe('makeOwnerOrigin', () => {
  it('要求 ownerType/ownerId 成对，缺一即无 owner', () => {
    expect(makeOwnerOrigin('npc', 'a')).toEqual({ ownerType: 'npc', ownerId: 'a' });
    expect(makeOwnerOrigin('npc', '')).toBeNull();
    expect(makeOwnerOrigin('', 'a')).toBeNull();
    expect(makeOwnerOrigin(undefined, undefined)).toBeNull();
    expect(makeOwnerOrigin('  npc  ', ' a ')).toEqual({ ownerType: 'npc', ownerId: 'a' });
  });

  it('withOwner 换 owner 但保留 zoneId 等其它来源信息', () => {
    const base: ActionOriginContext = { zoneId: 'z1', ownerType: 'zone', ownerId: 'z1' };
    expect(withOwner(base, 'npc', 'n1')).toEqual({ zoneId: 'z1', ownerType: 'npc', ownerId: 'n1' });
    // 新 owner 不成对时原样返回，不把已有 owner 抹成半个
    expect(withOwner(base, 'npc', '')).toEqual(base);
  });
});

describe('resolveDialogueOwner 四档优先级', () => {
  it('显式 ownerType+ownerId 压过一切', () => {
    expect(
      resolveDialogueOwner({
        paramOwnerType: 'hotspot',
        paramOwnerId: 'h1',
        paramNpcId: 'n1',
        originOwnerType: 'zone',
        originOwnerId: 'z1',
        ambientOwnerType: 'scene',
        ambientOwnerId: 's1',
      }),
    ).toEqual({ ownerType: 'hotspot', ownerId: 'h1', source: 'explicit' });
  });

  it('显式 ownerType 但缺 ownerId：判为无 owner，绝不跨命名空间借 id', () => {
    // 这是最关键的一条：借来 npc/zone/scene 的 id 会解出一个根本不存在的 owner，
    // 比"没有 owner"更难查（会静默命中别人的状态机或永远走 fallback）。
    expect(
      resolveDialogueOwner({
        paramOwnerType: 'hotspot',
        paramNpcId: 'n1',
        originOwnerType: 'zone',
        originOwnerId: 'z1',
        ambientOwnerType: 'scene',
        ambientOwnerId: 's1',
      }),
    ).toEqual({ ownerType: '', ownerId: '', source: 'none' });
  });

  it('只给 npcId 等价于 npc:<npcId>，压过来源与 ambient', () => {
    expect(
      resolveDialogueOwner({
        paramNpcId: 'n1',
        originOwnerType: 'zone',
        originOwnerId: 'z1',
        ambientOwnerType: 'scene',
        ambientOwnerId: 's1',
      }),
    ).toEqual({ ownerType: 'npc', ownerId: 'n1', source: 'npcId' });
  });

  it('无显式 owner、无 npcId 时落到来源实体', () => {
    expect(
      resolveDialogueOwner({
        originOwnerType: 'zone',
        originOwnerId: 'z1',
        ambientOwnerType: 'scene',
        ambientOwnerId: 's1',
      }),
    ).toEqual({ ownerType: 'zone', ownerId: 'z1', source: 'origin' });
  });

  it('来源也没有时落到场景 onEnter 的 ambient owner', () => {
    expect(
      resolveDialogueOwner({ ambientOwnerType: 'scene', ambientOwnerId: 's1' }),
    ).toEqual({ ownerType: 'scene', ownerId: 's1', source: 'ambient' });
  });

  it('四档全空 = 无 owner', () => {
    expect(resolveDialogueOwner({})).toEqual({ ownerType: '', ownerId: '', source: 'none' });
  });

  it('只有 ownerId 没有 ownerType 时沿用来源类型，其次 ambient 类型', () => {
    expect(
      resolveDialogueOwner({ paramOwnerId: 'x', originOwnerType: 'zone', originOwnerId: 'z1' }),
    ).toEqual({ ownerType: 'zone', ownerId: 'x', source: 'origin' });
    expect(
      resolveDialogueOwner({ paramOwnerId: 'x', ambientOwnerType: 'scene', ambientOwnerId: 's1' }),
    ).toEqual({ ownerType: 'scene', ownerId: 'x', source: 'ambient' });
    expect(resolveDialogueOwner({ paramOwnerId: 'x' })).toEqual({ ownerType: '', ownerId: '', source: 'none' });
  });
});

describe('ActionExecutor 来源上下文线程化', () => {
  function harness() {
    const eventBus = new EventBus();
    const flagStore = new FlagStore(eventBus);
    const executor = new ActionExecutor(eventBus, flagStore);
    const seen: (ActionOriginContext | null)[] = [];
    executor.register('probe', (_p, ctx) => { seen.push(ctx); });
    executor.register('runActions', async (p, ctx) => {
      await executor.executeBatchAwait((p.actions as never[]) ?? [], ctx);
    }, ['actions']);
    return { executor, seen };
  }

  it('executeBatchFromOwner 把 owner 传给批内每条动作', async () => {
    const { executor, seen } = harness();
    await executor.executeBatchFromOwner(
      [{ type: 'probe', params: {} }, { type: 'probe', params: {} }],
      'hotspot',
      'h1',
    );
    expect(seen).toEqual([
      { ownerType: 'hotspot', ownerId: 'h1' },
      { ownerType: 'hotspot', ownerId: 'h1' },
    ]);
  });

  it('owner 不成对时视为无来源（不制造半个 owner）', async () => {
    const { executor, seen } = harness();
    await executor.executeBatchFromOwner([{ type: 'probe', params: {} }], 'hotspot', '');
    expect(seen).toEqual([null]);
  });

  it('嵌套 runActions 逐层转发来源上下文', async () => {
    const { executor, seen } = harness();
    await executor.executeBatchFromOwner(
      [{ type: 'runActions', params: { actions: [{ type: 'probe', params: {} }] } }],
      'zone',
      'z1',
    );
    expect(seen).toEqual([{ ownerType: 'zone', ownerId: 'z1' }]);
  });

  it('两个来源的批交错执行时各拿各的上下文（禁全局栈的理由）', async () => {
    const { executor, seen } = harness();
    // 故意让两批在微任务粒度交错：全局"当前 owner"栈在这里必然串味。
    await Promise.all([
      executor.executeBatchFromOwner(
        [{ type: 'probe', params: {} }, { type: 'probe', params: {} }],
        'zone',
        'zA',
      ),
      executor.executeBatchFromOwner(
        [{ type: 'probe', params: {} }, { type: 'probe', params: {} }],
        'zone',
        'zB',
      ),
    ]);
    expect(seen.filter((c) => c?.ownerId === 'zA')).toHaveLength(2);
    expect(seen.filter((c) => c?.ownerId === 'zB')).toHaveLength(2);
    expect(seen).toHaveLength(4);
  });
});
