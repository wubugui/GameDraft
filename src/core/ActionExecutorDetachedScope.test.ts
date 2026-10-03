import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor, SCOPE_DETACHED } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { GameStateController } from './GameStateController';
import { InputManager } from './InputManager';
import { GameState } from '../data/types';
import { ActionEffectScope } from './ActionEffectScope';
import { PerformanceSession } from '../systems/performanceSession';

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
  it('嵌套批共享作用域，外层结束才逆序释放', async () => {
    const { actions } = makeExecutor(), seen: string[] = [];
    actions.register('effect', () => { seen.push('persistent'); });
    actions.registerScoped('effect', p => {
      seen.push(`take:${p.id}`);
      return { cleanup: reason => { seen.push(`release:${p.id}:${reason}`); } };
    });
    actions.register('check', () => { expect(seen).toEqual(['take:a', 'take:b', 'persistent']); });
    await actions.executeBatchAwait([
      { type: 'effect', params: { lifetime: 'scope', id: 'a' } },
      { type: 'wrap', params: { actions: [{ type: 'effect', params: { lifetime: 'scope', id: 'b' } }] } },
      { type: 'effect', params: {} }, { type: 'check', params: {} },
    ]);
    expect(seen).toEqual(['take:a', 'take:b', 'persistent', 'release:b:done', 'release:a:done']);
  });

  it.each(['error', 'cancel'] as const)('%s 清理一次，包括取消后才返回的异步资源', async how => {
    const { actions } = makeExecutor(), release = vi.fn();
    let resume!: () => void;
    actions.register('effect', () => {});
    actions.registerScoped('effect', async () => {
      await new Promise<void>(resolve => { resume = resolve; });
      return { cleanup: release };
    });
    actions.register('fail', () => { throw new Error('boom'); });
    const pending = actions.executeBatchAwait([
      { type: 'effect', params: { lifetime: 'scope' } },
      ...(how === 'error' ? [{ type: 'fail', params: {} }] : []),
    ]);
    if (how === 'cancel') actions.cancelPending();
    resume();
    if (how === 'error') await expect(pending).rejects.toThrow('boom');
    else await pending;
    actions.cancelPending();
    expect(release).toHaveBeenCalledExactlyOnceWith(how === 'error' ? 'error' : 'interrupted');
  });

  it('作用域隔离、提前释放幂等、坏清理不挡其他清理', () => {
    const a = new ActionEffectScope(), b = new ActionEffectScope();
    const first = vi.fn(), other = vi.fn(), last = vi.fn();
    a.add({ key: 'same', cleanup: first }); b.add({ key: 'same', cleanup: other });
    a.release('same'); a.release('same'); a.add({ cleanup: last });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    a.add({ cleanup: () => { throw new Error('bad cleanup'); } });
    a.close(); a.close();
    expect(first).toHaveBeenCalledExactlyOnceWith('released');
    expect(last).toHaveBeenCalledExactlyOnceWith('done'); expect(other).not.toHaveBeenCalled();
    b.close(); expect(other).toHaveBeenCalledOnce(); warn.mockRestore();
  });

  it('替换回调重入关闭时，新取得的资源也归还', () => {
    const scope = new ActionEffectScope(), cleanup = vi.fn();
    scope.add({ key: 'x', cleanup: () => scope.close('interrupted') });
    scope.add({ key: 'x', cleanup });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('interrupted');
  });

  it('背景演出清理后仍补跑嵌套结算，不再取得临时效果', async () => {
    const { actions } = makeExecutor(), session = new PerformanceSession('test', [], null);
    session.hurried = true; session.effects.close('interrupted');
    const settle = vi.fn(), acquire = vi.fn();
    actions.register('settle', settle); actions.register('effect', () => {}); actions.registerScoped('effect', acquire);
    await actions.executeBatchAwait([
      { type: 'effect', params: { lifetime: 'scope' } }, { type: 'settle', params: {} },
    ], null, { detached: true, session });
    expect(settle).toHaveBeenCalledOnce(); expect(acquire).not.toHaveBeenCalled();
  });
  it('切场临时回探索并触发入场动作后，仍保留外层动作的锁直到收尾', async () => {
    const { actions, sc } = makeExecutor();
    actions.register('travel', async () => {
      sc.setState(GameState.SceneTransition);
      sc.setState(GameState.Exploring);
      await actions.executeAwait({ type: 'probe', params: {} });
      sc.setState(GameState.ActionSequence);
    });
    await actions.executeAwait({ type: 'travel', params: {} });
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it.each([false, true])('重叠动作持有同一探索锁，最后一条才释放（后开先结束=%s）', async (laterFirst) => {
    const { actions, sc } = makeExecutor();
    const done: Array<() => void> = [];
    actions.register('hold', () => new Promise<void>((resolve) => done.push(resolve)));
    const first = actions.executeAwait({ type: 'hold', params: {} });
    const later = actions.executeAwait({ type: 'hold', params: {} });
    done[laterFirst ? 1 : 0]();
    await (laterFirst ? later : first);
    expect(sc.currentState).toBe(GameState.ActionSequence);
    done[laterFirst ? 0 : 1]();
    await Promise.all([first, later]);
    expect(sc.currentState).toBe(GameState.Exploring);
  });

  it('读档后旧动作归还旧锁，不得释放新时间线的探索锁', async () => {
    const { actions, sc } = makeExecutor();
    const done: Array<() => void> = [];
    actions.register('hold', () => new Promise<void>((resolve) => done.push(resolve)));
    const old = actions.executeAwait({ type: 'hold', params: {} });
    actions.cancelPending();
    sc.setState(GameState.Exploring);
    const current = actions.executeAwait({ type: 'hold', params: {} });
    done[0]();
    await old;
    expect(sc.currentState).toBe(GameState.ActionSequence);
    done[1]();
    await current;
    expect(sc.currentState).toBe(GameState.Exploring);
  });

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
