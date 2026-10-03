/**
 * 揭幕前闸（`setRevealGate`）的时序：`scene:ready` → 闸 → 揭幕（撤遮罩）→ `scene:revealed` → onEnter。
 *
 * 闸里做的是"必须在遮罩下做完、否则就停在可见画面上"的活（粒子 shader 交给 Pixi、粒子预热）：
 * 早于 scene:ready 就拿不到实体与载荷几何，晚于揭幕就又回到"揭幕后第一帧卡住"。
 * 闸失败不可显示半准备世界；事务拒绝并明确交给安全恢复/失败界面。
 */
import { Container } from '../engine2d';
import { describe, expect, it } from 'vitest';

import { EventBus } from '../core/EventBus';
import type { AssetManager } from '../core/AssetManager';
import type { Renderer } from '../rendering/Renderer';
import type { SceneData } from '../data/types';
import { SceneManager, type LoadingOutcome } from './SceneManager';

function rig() {
  const scene = {
    id: 's1', name: '测试', worldWidth: 800, worldHeight: 600,
    spawnPoint: { x: 10, y: 20 }, backgrounds: [], hotspots: [], npcs: [],
    onEnter: [{ type: 'noop', params: {} }],
  } as unknown as SceneData;
  const assets = {
    loadSceneData: async () => JSON.parse(JSON.stringify(scene)),
    preloadManifest: async () => undefined,
    releaseScope: () => undefined,
  } as unknown as AssetManager;
  const renderer = {
    backgroundLayer: new Container(),
    entityLayer: new Container(),
    clearWorldFilter: () => undefined,
  } as unknown as Renderer;
  const bus = new EventBus();
  const order: string[] = [];
  bus.on('scene:ready', () => { order.push('ready'); });
  bus.on('scene:revealed', () => { order.push('revealed'); });
  const sm = new SceneManager(assets, bus, renderer);
  sm.setLoadingLifecycle({
    begin: async () => undefined,
    progress: () => undefined,
    reveal: async () => undefined,
    end: () => undefined,
  });
  sm.setSceneEnterRunner(async () => { order.push('onEnter'); });
  return { sm, order, assets, bus, scene };
}

describe('SceneManager 揭幕前闸', () => {
  it('scene:ready 之后、揭幕之前 await 闸（闸里的异步活做完才撤遮罩）', async () => {
    const { sm, order } = rig();
    sm.setRevealGate(async (id) => {
      order.push(`gate:${id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push('gate:done');
    });
    await sm.loadScene('s1', undefined, undefined, null, undefined, async () => { order.push('reveal'); });
    expect(order).toEqual(['ready', 'gate:s1', 'gate:done', 'reveal', 'revealed', 'onEnter']);
  });

  it('闸抛错：拒绝加载，不揭幕、不执行 onEnter，不把半准备世界视为可存档', async () => {
    const { sm, order } = rig();
    sm.setRevealGate(async () => { order.push('gate'); throw new Error('boom'); });
    await expect(sm.loadScene('s1', undefined, undefined, null, undefined, async () => { order.push('reveal'); })).rejects.toThrow('boom');
    expect(order).toEqual(['ready', 'gate']);
    expect(sm.captureSceneReady).toBe(false);
    expect(sm.currentSceneData).toBeNull();
  });

  it('没有揭幕回调（初始直达 / 重载）也过闸；摘掉闸后不再调用', async () => {
    const { sm, order } = rig();
    let calls = 0;
    sm.setRevealGate(async () => { calls++; });
    await sm.loadScene('s1');
    expect(calls).toBe(1);
    sm.setRevealGate(null);
    sm.unloadScene();
    await sm.loadScene('s1');
    expect(calls).toBe(1);
    expect(order.filter((x) => x === 'ready')).toHaveLength(2);
  });

  it('首帧闸未完成时不能报告100%，任何公共load入口都先由加载生命周期取得控制', async () => {
    const { sm } = rig();
    const ratios: number[] = [];
    const lifecycle: string[] = [];
    let release!: () => void;
    let reached!: () => void;
    const reachedGate = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    sm.setLoadingLifecycle({
      begin: async ctx => { lifecycle.push(`begin:${ctx.id}`); },
      progress: (_ctx, ratio) => ratios.push(ratio),
      reveal: async () => { lifecycle.push('reveal'); },
      end: (_ctx, outcome) => { lifecycle.push(`end:${outcome.status}`); },
    });
    sm.setRevealGate(async () => { reached(); await gate; });
    const load = sm.loadScene('s1');
    await reachedGate;
    expect(sm.isLoading).toBe(true);
    expect(sm.captureSceneReady).toBe(false);
    expect(sm.committedSceneData).toBeNull();
    expect(ratios.length).toBeGreaterThan(0);
    expect(Math.max(...ratios)).toBeLessThan(1);
    expect(lifecycle).toEqual(['begin:load:1']);
    release();
    await load;
    expect(ratios[ratios.length - 1]).toBe(1);
    expect(ratios.every((ratio, index) => index === 0 || ratio >= ratios[index - 1])).toBe(true);
    expect(lifecycle).toEqual(['begin:load:1', 'reveal', 'end:success']);
    expect(sm.captureSceneReady).toBe(true);
  });

  it('onEnter里的切场能await目标场景，原动作批在目标真正揭幕后续接', async () => {
    const { sm, assets, scene } = rig();
    assets.loadSceneData = async id => ({ ...scene, id, onEnter: id === 's1' ? scene.onEnter : [] });
    const order: string[] = [];
    sm.setLoadingLifecycle({
      begin: async ctx => { order.push(`begin:${ctx.sceneId}`); },
      progress: () => undefined,
      reveal: async ctx => { order.push(`reveal:${ctx.sceneId}`); },
      end: ctx => { order.push(`end:${ctx.sceneId}`); },
    });
    sm.setSceneEnterRunner(async () => {
      order.push('onEnter:start');
      await sm.switchScene('s2');
      order.push(`onEnter:resume:${sm.currentSceneData?.id}`);
    });
    await sm.loadInitialScene('s1');
    expect(order).toEqual([
      'begin:s1', 'reveal:s1', 'end:s1', 'onEnter:start',
      'begin:s2', 'reveal:s2', 'end:s2', 'onEnter:resume:s2',
    ]);
  });

  it('失效JSON晚到不覆写新世界；interrupt立即封口旧请求且新请求可以完成', async () => {
    const { sm, assets, scene } = rig();
    let started!: () => void;
    const oldStarted = new Promise<void>(resolve => { started = resolve; });
    let releaseOld!: (scene: SceneData) => void;
    const oldJson = new Promise<SceneData>(resolve => { releaseOld = resolve; });
    assets.loadSceneData = async id => {
      if (id === 'old') { started(); return await oldJson; }
      return { ...scene, id, onEnter: [] };
    };
    const outcomes: Array<{ status: string; replacement?: boolean }> = [];
    sm.setLoadingLifecycle({
      begin: async () => undefined,
      progress: () => undefined,
      reveal: async () => undefined,
      end: (_ctx, outcome) => { outcomes.push(outcome); },
    });
    const old = sm.loadInitialScene('old');
    const oldRejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await oldStarted;
    await sm.reloadScene('new', undefined, undefined, { interrupt: true });
    await oldRejected;
    expect(outcomes[0]).toMatchObject({ status: 'cancelled', replacement: true });
    releaseOld({ ...scene, id: 'old', onEnter: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(sm.currentSceneData?.id).toBe('new');
    expect(sm.committedSceneData?.id).toBe('new');
  });

  it('加载失败回到原站位和镜头，根onEnter不会重播，原调用依然reject', async () => {
    const { sm, assets, scene } = rig();
    assets.loadSceneData = async id => {
      if (id === 'broken') throw new Error('required background missing');
      return { ...scene, id };
    };
    let position = { x: 10, y: 20 };
    let camera = { x: 30, y: 40, zoom: 2 };
    sm.setPlayerPositionSetter((x, y) => { position = { x, y }; });
    sm.setPlayerPositionGetter(() => ({ ...position }));
    sm.setCameraSnapshotHooks(() => ({ ...camera }), snapshot => { camera = snapshot as typeof camera; });
    let onEnterCount = 0;
    sm.setSceneEnterRunner(async () => { onEnterCount++; });
    await sm.loadInitialScene('s1');
    position = { x: 321, y: 123 };
    camera = { x: 400, y: 250, zoom: 1.75 };
    await expect(sm.switchScene('broken')).rejects.toThrow('required background missing');
    expect(position).toEqual({ x: 321, y: 123 });
    expect(camera).toEqual({ x: 400, y: 250, zoom: 1.75 });
    expect(onEnterCount).toBe(1);
    expect(sm.currentSceneData?.id).toBe('s1');
    expect(sm.captureSceneReady).toBe(true);
  });

  it('整个事务的watchdog覆盖JSON等待，不把永不settle的上游Promise泄露给调用者', async () => {
    const { sm, assets } = rig();
    assets.loadSceneData = async () => await new Promise<SceneData>(() => undefined);
    await expect(sm.reloadScene('hung', undefined, undefined, { timeoutMs: 10 })).rejects.toThrow('Scene loading exceeded 10 ms');
    expect(sm.isLoading).toBe(false);
    expect(sm.currentSceneData).toBeNull();
    expect(sm.captureSceneReady).toBe(false);
  });

  it('destroy之后重init，迟到的旧任务不回载、不发送收尾事件、不覆盖新场景', async () => {
    const { sm, assets, scene, bus } = rig();
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    let late!: (scene: SceneData) => void;
    const oldJson = new Promise<SceneData>(resolve => { late = resolve; });
    assets.loadSceneData = async id => {
      if (id === 'stale') { reached(); return await oldJson; }
      return { ...scene, id, onEnter: [] };
    };
    const ended: string[] = [];
    bus.on('scene:transitionEnd', payload => { ended.push(payload.toSceneId); });
    const old = sm.loadInitialScene('stale');
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    sm.destroy();
    sm.init({} as never);
    sm.setLoadingLifecycle({ begin: async () => undefined, progress: () => undefined, reveal: async () => undefined, end: () => undefined });
    await sm.reloadScene('fresh');
    await rejected;
    late({ ...scene, id: 'stale', onEnter: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(sm.currentSceneData?.id).toBe('fresh');
    expect(ended).toEqual(['fresh']);
    expect(sm.captureSceneReady).toBe(true);
  });

  it('读档scope的两次reload之间，外部切场延迟登记，不堵住scope内部队列也不插入', async () => {
    const { sm, assets, scene } = rig();
    const prepared: string[] = [];
    assets.loadSceneData = async id => {
      prepared.push(id);
      return { ...scene, id, onEnter: [] };
    };
    await sm.loadInitialScene('safe');
    const release = sm.acquireLoadingScope('restore');
    let externalDone = false;
    const external = sm.switchScene('external').then(() => { externalDone = true; });
    await sm.reloadScene('restore-first', undefined, undefined, { scopeId: 'restore' });
    expect(sm.isSceneReady).toBe(true);
    expect(sm.isLoading).toBe(true);
    expect(sm.captureSceneReady).toBe(false);
    expect(sm.lastSafeSceneSnapshot?.sceneId).toBe('safe');
    await sm.reloadScene('restore-rollback', undefined, undefined, { scopeId: 'restore' });
    expect(prepared).toEqual(['safe', 'restore-first', 'restore-rollback']);
    expect(externalDone).toBe(false);
    release();
    expect(sm.lastSafeSceneSnapshot?.sceneId).toBe('restore-rollback');
    await external;
    expect(prepared).toEqual(['safe', 'restore-first', 'restore-rollback', 'external']);
    expect(sm.currentSceneData?.id).toBe('external');
  });

  it('取消时scope外部等待请求明确reject，release后不会重新登记旧时间线', async () => {
    const { sm } = rig();
    const release = sm.acquireLoadingScope('restore');
    const deferred = sm.switchScene('stale');
    const rejected = expect(deferred).rejects.toMatchObject({ name: 'AbortError' });
    sm.cancelLoading();
    await rejected;
    release();
    await sm.waitForLoadingIdle();
    expect(sm.currentSceneData).toBeNull();
    expect(sm.isLoading).toBe(false);
  });

  it('连续排队的无onEnter加载保留Loading与遮幕，只揭开最终完整世界', async () => {
    const { sm, assets, scene, bus } = rig();
    assets.loadSceneData = async id => ({ ...scene, id, onEnter: [] });
    let state = 'Exploring';
    const released: string[] = [];
    const revealed: string[] = [];
    bus.on('scene:revealed', payload => { revealed.push(payload.sceneId); });
    sm.setLoadingLifecycle({
      begin: async () => { state = 'Loading'; },
      progress: () => undefined,
      reveal: async context => { revealed.push(`effect:${context.sceneId}`); },
      end: (context, outcome) => {
        if (!outcome.continuesLoading) { state = 'Exploring'; released.push(context.sceneId); }
      },
    });
    const first = sm.loadInitialScene('first');
    const second = sm.switchScene('second');
    await first;
    expect(state).toBe('Loading');
    expect(released).toEqual([]);
    await second;
    expect(released).toEqual(['second']);
    expect(revealed).toEqual(['effect:second', 'second']);
    expect(state).toBe('Exploring');
  });

  it('连续切往同一场景的末项仍交还Loading，且不重复装载或播放onEnter', async () => {
    const { sm, assets, scene, order } = rig();
    const fetched: string[] = [];
    assets.loadSceneData = async id => { fetched.push(id); return { ...scene, id, onEnter: [] }; };
    let state = 'Exploring';
    const lifecycle: string[] = [];
    sm.setLoadingLifecycle({
      begin: async ctx => { state = 'Loading'; lifecycle.push(`begin:${ctx.sceneId}`); },
      progress: () => undefined,
      reveal: async ctx => { lifecycle.push(`reveal:${ctx.sceneId}`); },
      end: (_ctx, outcome) => { if (!outcome.continuesLoading) state = 'Exploring'; },
    });
    await Promise.all([sm.switchScene('target'), sm.switchScene('target')]);
    expect(state).toBe('Exploring');
    expect(sm.isLoading).toBe(false);
    expect(sm.captureSceneReady).toBe(true);
    expect(fetched).toEqual(['target']);
    expect(lifecycle).toEqual(['begin:target', 'begin:target', 'reveal:target']);
    expect(order).toEqual(['ready', 'revealed']);
    // An idle same-scene request retains its existing zero-work/no-fade behavior.
    await sm.switchScene('target');
    expect(fetched).toEqual(['target']);
    expect(lifecycle).toHaveLength(3);
  });

  it('读档scope放出的同目标请求接完已有Loading，不重载刚恢复的场景', async () => {
    const { sm, assets, scene } = rig();
    const fetched: string[] = [];
    assets.loadSceneData = async id => { fetched.push(id); return { ...scene, id, onEnter: [] }; };
    let state = 'Exploring';
    let restoring = false;
    let reveals = 0;
    sm.setLoadingLifecycle({
      needsHandoff: () => state === 'Loading',
      begin: async () => { state = 'Loading'; },
      progress: () => undefined,
      reveal: async () => { if (!restoring) reveals++; },
      end: (_ctx, outcome) => { if (!restoring && !outcome.continuesLoading) state = 'Exploring'; },
    });
    await sm.loadInitialScene('safe');
    restoring = true;
    const release = sm.acquireLoadingScope('restore');
    const external = sm.switchScene('target');
    await sm.reloadScene('target', undefined, undefined, { scopeId: 'restore' });
    expect(state).toBe('Loading');
    restoring = false;
    release();
    await external;
    expect(state).toBe('Exploring');
    expect(sm.captureSceneReady).toBe(true);
    expect(fetched).toEqual(['safe', 'target']);
    expect(reveals).toBe(2);
  });

  it('同目标只有完整就绪的场景可复用，半准备的同id世界仍重新装载', async () => {
    const { sm, assets, scene } = rig();
    let loads = 0;
    assets.loadSceneData = async id => { loads++; return { ...scene, id, onEnter: [] }; };
    await sm.loadInitialScene('target');
    (sm as unknown as { sceneReady: boolean }).sceneReady = false;
    await sm.switchScene('target');
    expect(loads).toBe(2);
    expect(sm.captureSceneReady).toBe(true);
  });

  it.each(['switch', 'reload'] as const)('%s加载和原场景恢复双失败，重试保留原目标、落点、请求类型与onEnter语义', async kind => {
    const { sm, assets, scene } = rig();
    const fetched: string[] = [];
    assets.loadSceneData = async id => {
      fetched.push(id);
      return { ...scene, id, spawnPoints: { entry: { x: 81, y: 92 } } };
    };
    let position = { x: 0, y: 0 };
    sm.setPlayerPositionSetter((x, y) => { position = { x, y }; });
    sm.setPlayerPositionGetter(() => ({ ...position }));
    let enters = 0;
    sm.setSceneEnterRunner(async () => { enters++; });
    const began: string[] = [];
    let failed: LoadingOutcome | undefined;
    let failedContextScene = '';
    sm.setLoadingLifecycle({
      begin: async ctx => { began.push(`${ctx.kind}:${ctx.sceneId}`); },
      progress: () => undefined,
      reveal: async () => undefined,
      end: (ctx, outcome) => {
        if (outcome.status === 'failed') { failed = outcome; failedContextScene = ctx.sceneId; }
      },
    });
    await sm.loadInitialScene('safe');
    let fail = true;
    sm.setRevealGate(async () => { if (fail) throw new Error('GPU unavailable'); });
    const camera = { x: 111, y: 222 };
    const release = kind === 'reload' ? sm.acquireLoadingScope('restore') : undefined;
    const original = kind === 'switch'
      ? sm.switchScene('target', 'entry')
      : sm.reloadScene('target', 'entry', camera, { suppressOnEnter: false, timeoutMs: 500, scopeId: 'restore' });
    camera.x = 999;
    await expect(original).rejects.toThrow('GPU unavailable');
    expect(failedContextScene).toBe('safe');
    expect(failed?.retry).toBeTypeOf('function');
    expect(sm.currentSceneData).toBeNull();
    release?.();
    fail = false;
    const retry = failed!.retry!;
    await retry();
    expect(fetched).toEqual(['safe', 'target', 'target']);
    expect(sm.currentSceneData?.id).toBe('target');
    expect(began[began.length - 1]).toBe(`${kind}:target`);
    expect(position).toEqual(kind === 'switch' ? { x: 81, y: 92 } : { x: 111, y: 222 });
    expect(enters).toBe(2);
    sm.destroy();
    sm.init({} as never);
    await expect(retry()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('失败重试保留请求的短超时，不能退回全局长超时', async () => {
    const { sm, assets, scene } = rig();
    assets.loadSceneData = async id => ({ ...scene, id, onEnter: [] });
    let retry: (() => Promise<void>) | undefined;
    sm.setLoadingLifecycle({
      begin: async () => undefined,
      progress: () => undefined,
      reveal: async () => undefined,
      end: (_ctx, outcome) => { retry = outcome.retry; },
    });
    await sm.loadInitialScene('safe');
    sm.setRevealGate(async () => { throw new Error('GPU unavailable'); });
    await expect(sm.reloadScene('target', undefined, undefined, { timeoutMs: 10 })).rejects.toThrow('GPU unavailable');
    assets.loadSceneData = async () => await new Promise<SceneData>(() => undefined);
    await expect(retry!()).rejects.toThrow('Scene loading exceeded 10 ms');
    expect(sm.isLoading).toBe(false);
  });
});
