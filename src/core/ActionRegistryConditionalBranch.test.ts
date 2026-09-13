import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import type { ConditionExpr } from '../data/types';

/**
 * `runActionsIf` 是内容侧唯一的条件分支容器（onEnter / 热区 / zone 批里都用它）。
 * 这里钉三件容易在重构里掉的事：
 *  ① 判据真的经 deps 求值，而不是在 handler 里另建条件上下文；
 *  ② 假分支不写 `elseActions` 时什么都不做（而不是掉进真分支）；
 *  ③ zctx 透传——zone 批里包一层条件，内层动作仍拿得到本 zone 上下文。
 */
function harness(evaluate: (expr: ConditionExpr | null | undefined) => boolean) {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const executor = new ActionExecutor(eventBus, flagStore);
  const seen: { expr: ConditionExpr | null | undefined }[] = [];
  const marks: { id: string; zoneId?: string }[] = [];

  const deps = {
    evaluateCondition: (expr: ConditionExpr | null | undefined) => {
      seen.push({ expr });
      return evaluate(expr);
    },
  } as unknown as ActionRegistryDeps;
  registerActionHandlers(executor, deps);
  // 探针动作：记下自己被执行时拿到的 zone 上下文
  executor.register('testMark', (p, zctx) => {
    marks.push({ id: String(p.id ?? ''), zoneId: zctx?.zoneId });
  }, ['id']);

  return { executor, seen, marks };
}

const NIGHT: ConditionExpr = { timePhase: '夜' } as ConditionExpr;

const branch = (extra?: Record<string, unknown>) => ({
  type: 'runActionsIf',
  params: {
    condition: NIGHT,
    actions: [{ type: 'testMark', params: { id: 'then' } }],
    ...extra,
  },
});

describe('runActionsIf 条件分支容器', () => {
  it('条件为真走 actions，且判据原样交给 deps 求值', async () => {
    const { executor, seen, marks } = harness(() => true);
    await executor.executeBatchAwait([
      branch({ elseActions: [{ type: 'testMark', params: { id: 'else' } }] }),
    ], null);
    expect(seen).toEqual([{ expr: NIGHT }]);
    expect(marks.map((m) => m.id)).toEqual(['then']);
  });

  it('条件为假走 elseActions', async () => {
    const { executor, marks } = harness(() => false);
    await executor.executeBatchAwait([
      branch({ elseActions: [{ type: 'testMark', params: { id: 'else' } }] }),
    ], null);
    expect(marks.map((m) => m.id)).toEqual(['else']);
  });

  it('条件为假而没写 elseActions：什么都不执行（不得掉进真分支）', async () => {
    const { executor, marks } = harness(() => false);
    await executor.executeBatchAwait([branch()], null);
    expect(marks).toEqual([]);
  });

  it('不写 condition 时按恒真处理（等价于 runActions）', async () => {
    const { executor, seen, marks } = harness((expr) => expr === null);
    await executor.executeBatchAwait([
      { type: 'runActionsIf', params: { actions: [{ type: 'testMark', params: { id: 'then' } }] } },
    ], null);
    expect(seen).toEqual([{ expr: null }]);
    expect(marks.map((m) => m.id)).toEqual(['then']);
  });

  it('zone 批里包一层：内层动作仍拿得到本 zone 上下文', async () => {
    const { executor, marks } = harness(() => true);
    await executor.executeBatchAwait([branch()], { zoneId: 'z1', ownerType: 'zone', ownerId: 'z1' });
    expect(marks).toEqual([{ id: 'then', zoneId: 'z1' }]);
  });
});
