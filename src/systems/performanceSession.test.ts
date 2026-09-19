import { describe, expect, it } from 'vitest';
import type { ActionDef } from '../data/types';
import type { PerformanceRelease, PerformanceSession } from './performanceSession';
import {
  PerformanceSessionManager,
  ledgerTakeDuck, ledgerTakeEnvDim, ledgerTakeGust, ledgerTakeSfx,
  ledgerTakeShake, ledgerTakeStrikeLight, ledgerTakeVfx,
} from './performanceSession';

/**
 * 脱手演出会话的契约（制作人 2026-09-19 定的三层）。
 *
 * 这些判据全都只在"玩家正好在演出跑到一半时触发了别的东西"那一刻才看得见，
 * 真机上撞一次要凑好几个条件，所以必须钉在这里。
 */

const PRESENTATION = new Set(['waitMs', 'screenFlash', 'setSceneDim', 'playSfx']);

function makeHarness() {
  const ran: string[] = [];
  const ranSync: string[] = [];
  const released: string[] = [];
  const resolvers: Array<() => void> = [];

  const release: PerformanceRelease = {
    setEnvDimNow: (s) => released.push(`envDim=${s}`),
    releaseDuck: (n) => released.push(`duck:${n}`),
    clearShake: () => released.push('shake'),
    clearStrikeLight: () => released.push('strikeLight'),
    clearGust: () => released.push('gust'),
    stopSfx: (id) => released.push(`sfx:${id}`),
    stopVfxSoft: (id) => released.push(`vfx:${id}`),
  };

  /** 演出 handler 的替身：认得几条动作，并往账本上记自己动过的旋钮。 */
  const applyLedger = (action: ActionDef, session: PerformanceSession): void => {
    const p = (action.params ?? {}) as Record<string, unknown>;
    switch (action.type) {
      case 'setSceneDim': ledgerTakeEnvDim(session, 1, Number(p.scale)); break;
      case 'duckAudio': ledgerTakeDuck(session, String(p.id ?? 'duck')); break;
      case 'cameraShake': ledgerTakeShake(session); break;
      case 'playSfx': ledgerTakeSfx(session, String(p.id ?? '')); break;
      case 'playVfx': ledgerTakeVfx(session, String(p.id ?? '')); break;
      case 'sceneWindGust': ledgerTakeGust(session); break;
      case 'strike': ledgerTakeStrikeLight(session); break;
      default: break;
    }
  };

  const manager = new PerformanceSessionManager({
    runAction: (action, session) => {
      ran.push(action.type);
      applyLedger(action, session);
      // `waitMs` 是这套里唯一"会停在半路"的动作：留一个 resolver 给测试手动放行
      if (action.type === 'waitMs') {
        return new Promise<void>((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve();
    },
    runActionSync: (action, session) => {
      ranSync.push(action.type);
      applyLedger(action, session);
    },
    isPresentationOnly: (t) => PRESENTATION.has(t),
    release,
  });

  return { manager, ran, ranSync, released, resolvers };
}

const A = (type: string, params: Record<string, unknown> = {}): ActionDef =>
  ({ type, params } as ActionDef);

/** 让排队的微任务跑完 */
const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 0); });

describe('脱手演出会话', () => {
  it('没人打断就按顺序跑完，跑完才收摊', async () => {
    const h = makeHarness();
    h.manager.start('sk', [A('duckAudio', { id: 'sk' }), A('waitMs'), A('setFlag')]);
    await tick();
    expect(h.ran).toEqual(['duckAudio', 'waitMs']);   // 停在 waitMs 上
    expect(h.manager.activeIds()).toEqual(['sk']);

    h.resolvers[0]();                                  // 等待结束
    await tick();
    expect(h.ran).toEqual(['duckAudio', 'waitMs', 'setFlag']);
    expect(h.manager.activeIds()).toEqual([]);
    expect(h.released).toEqual(['duck:sk']);           // 账本归位
  });

  it('打断：演出整段丢掉，结算一条不少，而且是**同步**补的', async () => {
    const h = makeHarness();
    h.manager.start('sk', [
      A('waitMs'),
      A('screenFlash'), A('playSfx', { id: 'boom' }),   // 纯演出 → 丢
      A('strike'), A('setFlag'), A('giveItem'),         // 结算 → 补
    ]);
    await tick();
    expect(h.ran).toEqual(['waitMs']);

    h.manager.interruptAll('cutscene');
    // 同步：这一行之前不许有 await —— 切场景那类收尾路径等不起一个微任务
    expect(h.ranSync).toEqual(['strike', 'setFlag', 'giveItem']);
    expect(h.manager.activeIds()).toEqual([]);
  });

  it('打断后那条还在飞的等待醒来，不许接着往下跑', async () => {
    const h = makeHarness();
    h.manager.start('sk', [A('waitMs'), A('setFlag')]);
    await tick();
    h.manager.interruptAll('scene');
    expect(h.ranSync).toEqual(['setFlag']);

    h.resolvers[0]();            // 那条 waitMs 现在才结束
    await tick();
    expect(h.ran).toEqual(['waitMs']);          // 没有第二次 setFlag
    expect(h.ranSync).toEqual(['setFlag']);
  });

  it('归位倒着放，一样不落', async () => {
    const h = makeHarness();
    h.manager.start('sk', [
      A('setSceneDim', { scale: 0.2 }),
      A('duckAudio', { id: 'a' }), A('duckAudio', { id: 'b' }),
      A('cameraShake'), A('sceneWindGust'), A('strike'),
      A('playSfx', { id: 's1' }), A('playVfx', { id: 'v1' }),
      A('waitMs'),
    ]);
    await tick();
    h.manager.interruptAll('death');
    expect(h.released).toEqual([
      'vfx:v1', 'sfx:s1', 'gust', 'strikeLight', 'shake', 'duck:b', 'duck:a', 'envDim=1',
    ]);
  });

  it('作者自己把天色还回去了，账本就不插手（别把 2.6 秒的放晴拍成瞬间）', async () => {
    const h = makeHarness();
    h.manager.start('sk', [A('setSceneDim', { scale: 0.2 }), A('setSceneDim', { scale: 1 })]);
    await tick();
    expect(h.released).toEqual([]);   // 目标已经回到进入前，不再补一刀
  });

  it('同名再放一次＝顶替：前一段当场按打断收掉', async () => {
    const h = makeHarness();
    h.manager.start('leifu', [A('duckAudio', { id: 'leifu' }), A('waitMs'), A('setFlag')]);
    await tick();
    h.manager.start('leifu', [A('waitMs')]);
    // 前一段：结算补齐 + 归位
    expect(h.ranSync).toEqual(['setFlag']);
    expect(h.released).toEqual(['duck:leifu']);
    expect(h.manager.activeIds()).toEqual(['leifu']);
  });

  it('不同名字的两段各跑各的，互不打扰', async () => {
    const h = makeHarness();
    h.manager.start('weather', [A('waitMs')]);
    h.manager.start('leifu', [A('waitMs')]);
    await tick();
    expect(h.manager.activeIds().sort()).toEqual(['leifu', 'weather']);
  });

  it('补跑里的动作又触发一次打断：不递归、也不把剩下的吞掉', async () => {
    // 真实场景：补跑的结算动作里有个 switchScene 式的东西，回头又喊了一次 interruptAll。
    const ranSync: string[] = [];
    const released: string[] = [];
    let manager!: PerformanceSessionManager;
    manager = new PerformanceSessionManager({
      runAction: (action) => (action.type === 'waitMs'
        ? new Promise<void>(() => { /* 永远停在这 */ })
        : Promise.resolve()),
      runActionSync: (action, session) => {
        ranSync.push(action.type);
        if (action.type === 'reentrant') manager.interruptAll('scene');   // 回头再喊一次
        if (action.type === 'duckAudio') ledgerTakeDuck(session, 'sk');
      },
      isPresentationOnly: (t) => PRESENTATION.has(t),
      release: {
        setEnvDimNow: () => { /* no-op */ },
        releaseDuck: (n) => released.push(`duck:${n}`),
        clearShake: () => { /* no-op */ },
        clearStrikeLight: () => { /* no-op */ },
        clearGust: () => { /* no-op */ },
        stopSfx: () => { /* no-op */ },
        stopVfxSoft: () => { /* no-op */ },
      },
    });

    manager.start('sk', [A('waitMs'), A('reentrant'), A('duckAudio'), A('setFlag')]);
    await tick();
    manager.interruptAll('cutscene');

    // 重入那一下被挡住了，但**本轮补跑照常走完**——没有被"已经在收了"顺手吞掉
    expect(ranSync).toEqual(['reentrant', 'duckAudio', 'setFlag']);
    expect(manager.activeIds()).toEqual([]);
    expect(released).toEqual(['duck:sk']);
  });

  it('拆除＝把所有会话按打断收掉（归位照做）', async () => {
    const h = makeHarness();
    h.manager.start('a', [A('duckAudio', { id: 'a' }), A('waitMs')]);
    h.manager.start('b', [A('cameraShake'), A('waitMs')]);
    await tick();
    h.manager.destroy();
    expect(h.manager.activeIds()).toEqual([]);
    expect(h.released).toEqual(['duck:a', 'shake']);
  });
});
