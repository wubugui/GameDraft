/**
 * 揭幕前闸（`setRevealGate`）的时序：`scene:ready` → 闸 → 揭幕（撤遮罩）→ `scene:revealed` → onEnter。
 *
 * 闸里做的是"必须在遮罩下做完、否则就停在可见画面上"的活（粒子 shader 交给 Pixi、粒子预热）：
 * 早于 scene:ready 就拿不到实体与载荷几何，晚于揭幕就又回到"揭幕后第一帧卡住"。
 * 闸抛错也必须照常揭幕——不许把首屏锁在黑幕后（scene-onenter-reveal-timing）。
 */
import { Container } from '../engine2d';
import { describe, expect, it } from 'vitest';

import { EventBus } from '../core/EventBus';
import type { AssetManager } from '../core/AssetManager';
import type { Renderer } from '../rendering/Renderer';
import type { SceneData } from '../data/types';
import { SceneManager } from './SceneManager';

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
  sm.setSceneEnterRunner(async () => { order.push('onEnter'); });
  return { sm, order };
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

  it('闸抛错：照常揭幕、照常 onEnter', async () => {
    const { sm, order } = rig();
    sm.setRevealGate(async () => { order.push('gate'); throw new Error('boom'); });
    await sm.loadScene('s1', undefined, undefined, null, undefined, async () => { order.push('reveal'); });
    expect(order).toEqual(['ready', 'gate', 'reveal', 'revealed', 'onEnter']);
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
});
