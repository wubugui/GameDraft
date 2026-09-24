import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor, SCOPE_DETACHED } from './ActionExecutor';
import type { ActionExecScope, ActionListenContext } from './ActionExecutor';
import type { ActionRunEnd } from './actionRun';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { GameStateController } from './GameStateController';
import { InputManager } from './InputManager';
import { PerformanceSessionManager } from '../systems/performanceSession';
import type { PerformanceSession } from '../systems/performanceSession';
import type { ActionDef } from '../data/types';

/**
 * 动作「串」（`core/actionRun.ts`）：同一件事引出的动作共用一个串 id，最后一处占用放掉时
 * 发一次结束。世界脑靠它把雷符引出的压暗、闷雷、落雷拼成一件事、按"串结束"判事平息。
 * 它**只给旁听者**：执行语义（加锁、脱手、快进）一概不变。
 */
function stubDom(): void {
  const target = { addEventListener(): void {}, removeEventListener(): void {} };
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', { ...target, visibilityState: 'visible' });
}

afterEach(() => { vi.unstubAllGlobals(); });

type Heard = { type: string; ctx: ActionListenContext };

function makeWorld() {
  stubDom();
  const events = new EventBus();
  const flags = new FlagStore(events);
  const sc = new GameStateController(new InputManager());
  const exec = new ActionExecutor(events, flags, sc);
  const heard: Heard[] = [];
  const ends: ActionRunEnd[] = [];
  exec.addActionListener((type, _p, ctx) => { heard.push({ type, ctx }); });
  exec.addRunEndListener((e) => { ends.push(e); });

  /** 手动放行的等待：模拟演出里的 waitMs */
  const gates: (() => void)[] = [];
  exec.register('gate', () => new Promise<void>((resolve) => { gates.push(resolve); }));
  exec.register('probe', () => { /* 什么都不做，只让旁听者看见 */ });
  exec.register('wrap', (p, ctx, scope) => exec.executeBatchAwait(p.actions as ActionDef[], ctx, scope));

  // 脱手演出：与 Game.buildPerformanceSessions 同一接法（每个会话一份带串的 scope）
  const scopes = new WeakMap<PerformanceSession, ActionExecScope>();
  const scopeOf = (s: PerformanceSession): ActionExecScope => {
    let scope = scopes.get(s);
    if (!scope) {
      scope = s.run ? { detached: true, session: s, run: s.run } : { detached: true, session: s };
      scopes.set(s, scope);
    }
    return scope;
  };
  const sessions = new PerformanceSessionManager({
    runAction: (a, s) => exec.executeAwait(a, s.originContext, scopeOf(s)),
    runActionSync: (a, s) => { void exec.executeAwait(a, s.originContext, scopeOf(s)); },
    isPresentationOnly: (t) => t === 'gate' || t === 'probe',
    release: {
      setEnvDimNow: () => {}, releaseDuck: () => {}, clearShake: () => {}, clearStrikeLight: () => {},
      clearGust: () => {}, stopSfx: () => {}, stopVfxSoft: () => {},
    },
  });
  exec.register('detached', (p, ctx, scope) => {
    sessions.start(String(p.id ?? 'detached'), p.actions as ActionDef[], ctx, scope.run);
  });
  return { exec, heard, ends, gates, sessions };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe('动作串', () => {
  it('一批（含嵌套容器）共用一个串 id，整批跑完发一次结束', async () => {
    const { exec, heard, ends } = makeWorld();
    await exec.executeBatchAwait([
      { type: 'probe', params: {} },
      { type: 'wrap', params: { actions: [{ type: 'probe', params: {} }, { type: 'probe', params: {} }] } },
    ]);
    const ids = new Set(heard.map((h) => h.ctx.run.id));
    expect(heard).toHaveLength(4);
    expect(ids.size).toBe(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ run: { id: [...ids][0] }, interrupted: false });
  });

  it('两次顶层调用是两串；顶层单条动作自成一串', async () => {
    const { exec, heard, ends } = makeWorld();
    await exec.executeBatchAwait([{ type: 'probe', params: {} }]);
    await exec.executeAwait({ type: 'probe', params: {} });
    expect(heard[0]!.ctx.run.id).not.toBe(heard[1]!.ctx.run.id);
    expect(ends.map((e) => e.run.id)).toEqual([heard[0]!.ctx.run.id, heard[1]!.ctx.run.id]);
  });

  it('发起方：调用方声明的优先，其次按来源上下文推（zone 先于 owner），都没有是 unknown', async () => {
    const { exec, heard } = makeWorld();
    await exec.executeBatchAwait([{ type: 'probe', params: {} }], null, {
      detached: false, initiator: { kind: 'item', id: 'leifu' },
    });
    await exec.executeBatchAwait([{ type: 'probe', params: {} }], { zoneId: 'z1', ownerType: 'npc', ownerId: 'a' });
    await exec.executeBatchFromOwner([{ type: 'probe', params: {} }], 'hotspot', 'h1');
    await exec.executeBatchAwait([{ type: 'probe', params: {} }]);
    expect(heard.map((h) => h.ctx.run.initiator)).toEqual([
      { kind: 'item', id: 'leifu' },
      { kind: 'zone', id: 'z1' },
      { kind: 'hotspot', id: 'h1' },
      { kind: 'unknown' },
    ]);
    expect(heard[1]!.ctx.origin).toEqual({ zoneId: 'z1', ownerType: 'npc', ownerId: 'a' });
  });

  it('开出去的脱手演出占着这一串：批早就返回了，串要等演出播完才结束，演出里的动作同一串', async () => {
    const { exec, heard, ends, gates } = makeWorld();
    await exec.executeBatchAwait([
      { type: 'probe', params: {} },
      { type: 'detached', params: { id: 'leifu', actions: [{ type: 'gate', params: {} }, { type: 'probe', params: {} }] } },
    ], null, { detached: false, initiator: { kind: 'item', id: 'leifu' } });
    await flush();
    expect(ends).toHaveLength(0);                     // 雷还没劈完
    expect(gates).toHaveLength(1);
    gates[0]!();
    await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]!.interrupted).toBe(false);
    const ids = new Set(heard.map((h) => h.ctx.run.id));
    expect(ids.size).toBe(1);
    const inShow = heard.filter((h) => h.ctx.session === 'leifu');
    expect(inShow.map((h) => h.type)).toEqual(['gate', 'probe']);
    expect(inShow.every((h) => h.ctx.detached)).toBe(true);
  });

  it('演出被打断：在飞的那条让位之后，这一串带 interrupted 结束', async () => {
    const { exec, ends, gates, sessions } = makeWorld();
    await exec.executeBatchAwait([
      { type: 'detached', params: { id: 'leifu', actions: [{ type: 'gate', params: {} }, { type: 'probe', params: {} }] } },
    ]);
    await flush();
    expect(ends).toHaveLength(0);
    sessions.interruptAll('scene');
    await flush();
    // 在飞的等待还占着这一串（真游戏里 waitMs 见 hurried 当场让位；这里手动放行）
    expect(ends).toHaveLength(0);
    gates[0]!();
    await flush();
    expect(ends).toHaveLength(1);
    expect(ends[0]!.interrupted).toBe(true);
  });

  it('死亡 / 读档作废剩下的动作：这一串带 interrupted 结束', async () => {
    const { exec, ends, gates } = makeWorld();
    const done = exec.executeBatchAwait([{ type: 'gate', params: {} }, { type: 'probe', params: {} }]);
    await flush();
    exec.cancelPending();
    gates[0]!();
    await done;
    expect(ends).toHaveLength(1);
    expect(ends[0]!.interrupted).toBe(true);
  });

  it('手动开串（过场逐步执行）：每一步同一串，end 之前不结束，end 幂等', async () => {
    const { exec, heard, ends } = makeWorld();
    const run = exec.openRun({ kind: 'cutscene', id: 'c1' });
    await exec.executeAwait({ type: 'probe', params: {} }, null, run.scope);
    await exec.executeAwait({ type: 'probe', params: {} }, null, run.scope);
    expect(ends).toHaveLength(0);
    run.end(true);
    run.end(false);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ run: { initiator: { kind: 'cutscene', id: 'c1' } }, interrupted: true });
    expect(new Set(heard.map((h) => h.ctx.run.id)).size).toBe(1);
  });

  it('只是加了个串：作用域的脱手与否原样传给 handler', async () => {
    const { exec } = makeWorld();
    const seen: ActionExecScope[] = [];
    exec.register('peek', (_p, _c, scope) => { seen.push(scope); });
    await exec.executeBatchAwait([{ type: 'peek', params: {} }], null, SCOPE_DETACHED);
    await exec.executeBatchAwait([{ type: 'peek', params: {} }]);
    expect(seen[0]!.detached).toBe(true);
    expect(seen[1]!.detached).toBe(false);
    expect(seen.every((s) => s.run !== undefined)).toBe(true);
  });

  it('旁听方抛错不影响执行，也不影响结束通知', async () => {
    const { exec, ends } = makeWorld();
    let ran = 0;
    exec.register('count', () => { ran++; });
    exec.addActionListener(() => { throw new Error('boom'); });
    exec.addRunEndListener(() => { throw new Error('boom'); });
    await exec.executeBatchAwait([{ type: 'count', params: {} }]);
    expect(ran).toBe(1);
    expect(ends).toHaveLength(1);
  });
});
