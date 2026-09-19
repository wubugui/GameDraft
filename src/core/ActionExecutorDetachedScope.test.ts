import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor, SCOPE_DETACHED } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { GameStateController } from './GameStateController';
import { InputManager } from './InputManager';
import { GameState } from '../data/types';

/**
 * 「脱手执行」＝ 演出在背景跑、玩家照常走。
 *
 * 缺省批在 Exploring 时会切进 `ActionSequence`（= 玩家一动不能动），批里每条 `waitMs`
 * 都在那把锁下面。雷符那段近十秒的酝酿曾因此把人钉在原地（2026-09-19 制作人报「放了技能
 * 之后完全不能动」）。脱手作用域跳过加锁，且**必须随容器往下传**——否则批里套一层
 * `runActions` 就地把锁又加回来，看起来就是"只有一半时间能动"。
 */
/** node 环境没有 window：InputManager 构造即要用，给个只收不发的替身就够。 */
function stubDom(): void {
  const target = { addEventListener(): void {}, removeEventListener(): void {} };
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { ...target, visibilityState: 'visible' });
}

afterEach(() => { vi.unstubAllGlobals(); });

function makeExecutor() {
  stubDom();
  const events = new EventBus();
  const flags = new FlagStore(events);
  const sc = new GameStateController(new InputManager());
  const actions = new ActionExecutor(events, flags, sc);
  const seen: GameState[] = [];
  actions.register('probe', () => { seen.push(sc.currentState); });
  actions.register('detach', (p) => {
    void actions.executeBatchAwait(
      (p.actions ?? []) as { type: string; params: Record<string, unknown> }[],
      null,
      SCOPE_DETACHED,
    );
  });
  actions.register('wrap', (p, ctx, scope) => actions.executeBatchAwait(
    (p.actions ?? []) as { type: string; params: Record<string, unknown> }[],
    ctx,
    scope,
  ));
  return { actions, sc, seen };
}

describe('动作批的执行作用域', () => {
  it('缺省批把 Exploring 锁成 ActionSequence，跑完还回去', async () => {
    const { actions, sc, seen } = makeExecutor();
    sc.setState(GameState.Exploring);
    await actions.executeBatchAwait([{ type: 'probe', params: {} }]);
    expect(seen).toEqual([GameState.ActionSequence]);
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it('脱手批全程停在 Exploring——玩家能走', async () => {
    const { actions, sc, seen } = makeExecutor();
    sc.setState(GameState.Exploring);
    await actions.executeBatchAwait([{ type: 'probe', params: {} }], null, SCOPE_DETACHED);
    expect(seen).toEqual([GameState.Exploring]);
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it('脱手随嵌套容器往下传，内层不会把锁重新加回来', async () => {
    const { actions, sc, seen } = makeExecutor();
    sc.setState(GameState.Exploring);
    await actions.executeBatchAwait(
      [{ type: 'wrap', params: { actions: [{ type: 'probe', params: {} }] } }],
      null,
      SCOPE_DETACHED,
    );
    expect(seen).toEqual([GameState.Exploring]);
  });

  it('脱手批发车即返回：调用方不等它跑完', async () => {
    const { actions, sc, seen } = makeExecutor();
    sc.setState(GameState.Exploring);
    let slowDone = false;
    actions.register('slow', async () => {
      await new Promise<void>((r) => { setTimeout(r, 30); });
      slowDone = true;
    });
    await actions.executeBatchAwait([
      { type: 'detach', params: { actions: [{ type: 'slow', params: {} }, { type: 'probe', params: {} }] } },
    ]);
    expect(slowDone).toBe(false);          // 外层已经走完，里面还在跑
    expect(sc.currentState).toBe(GameState.Exploring);
    await new Promise<void>((r) => { setTimeout(r, 60); });
    expect(slowDone).toBe(true);
    expect(seen).toEqual([GameState.Exploring]);
  });
});
