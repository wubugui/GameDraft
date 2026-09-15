/**
 * 粒子工作台推来的效果工作态怎么套到游戏里（2026-09-14 审查 #4 / #5）：
 * - 撤销覆盖（作者换去编别的效果）= 回到**盘上此刻**那份，不是开局 AssetManager 缓存的那份；
 * - 同一份定义再来一遍（拖布置顶点、换时段外观、3 分钟保活都会带着）不重建实例——群不重飞、纸不重铺。
 *
 * 用真的 AssetManager（JSON 桶的缓存正是 #4 的来源），fetch 换成假盘。效果不带发射器，不跑模拟。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssetManager } from '../../core/AssetManager';
import { EventBus } from '../../core/EventBus';
import type { GameContext, SceneData, VfxEffectDef, VfxPlacementLibrary } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import type { VfxSpace } from './vfxSpace';

const LIB: VfxPlacementLibrary = {
  scenes: {
    梁: { base: [
      { id: '纸钱_山顶', effect: 'fx', anchor: { x: 0, y: 0 } },
      { id: '纸钱_坡下', effect: 'fx', anchor: { x: 50, y: 0 } },
      { id: '别的', effect: 'other', anchor: { x: 9, y: 0 } },
    ] },
  },
};

const fx = (label: string) => ({ id: 'fx', label, emitters: [] }) as unknown as VfxEffectDef;

interface Runtime { effect: VfxEffectDef | null; sim: unknown }

function harness() {
  const disk: Record<string, unknown> = {
    'vfx_placements.json': LIB,
    'vfx/fx.json': fx('开局盘上'),
    'vfx/other.json': { id: 'other', emitters: [] },
  };
  const fetched: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    fetched.push(url);
    const hit = Object.keys(disk).find((k) => url.endsWith(k));
    if (!hit) return { ok: false, status: 404, json: async () => null } as unknown as Response;
    const body = JSON.parse(JSON.stringify(disk[hit]));
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }));
  const eventBus = new EventBus();
  const assetManager = new AssetManager();
  const sys = new VfxSystem({
    assetManager,
    getSceneData: () => ({ id: '梁' } as unknown as SceneData),
    buildSpace: () => ({ kind: 'field' } as unknown as VfxSpace),
    getPlayerContact: () => null,
    getAppearancePhase: () => '',
    getActiveLights: () => [],
    conditionContext: () => ({}) as never,
    hasFieldGeometry: () => true,
    playSfxAt: () => {},
    log: () => {},
  });
  sys.init({ eventBus } as unknown as GameContext);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  const runtimeOf = (id: string) => (sys as unknown as { instances: Map<string, Runtime> }).instances.get(id)!;
  const labelOf = (id: string) => (runtimeOf(id).effect as unknown as { label?: string } | null)?.label ?? null;
  return { sys, eventBus, disk, fetched, flush, runtimeOf, labelOf };
}

describe('VfxSystem.applyPreviewEffect', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('#4 撤销覆盖读的是盘上此刻那份：存盘后换去编别的效果，游戏里不退回开局那份', async () => {
    const h = harness();
    h.eventBus.emit('scene:ready');
    await h.flush();
    expect(h.labelOf('纸钱_山顶')).toBe('开局盘上');        // 开局经 AssetManager.loadJson 装进 JSON 桶

    h.sys.applyPreviewEffect('fx', fx('工作态'));
    await h.flush();
    expect(h.labelOf('纸钱_山顶')).toBe('工作态');

    h.disk['vfx/fx.json'] = fx('存过盘');                   // 作者 Ctrl+S
    h.sys.applyPreviewEffect('fx', null);                    // 换去编别的效果：联动撤销这份覆盖
    await h.flush();
    expect(h.labelOf('纸钱_山顶')).toBe('存过盘');
    expect(h.labelOf('纸钱_坡下')).toBe('存过盘');
    expect(h.fetched.filter((u) => u.endsWith('vfx/fx.json'))).toHaveLength(2);
  });

  it('#5 同一份定义再来一遍（换了对象、内容逐字相同）不重建任何实例', async () => {
    const h = harness();
    h.eventBus.emit('scene:ready');
    await h.flush();
    h.sys.applyPreviewEffect('fx', fx('工作态'));
    await h.flush();
    const top = h.runtimeOf('纸钱_山顶');
    const effTop = top.effect;
    const effLow = h.runtimeOf('纸钱_坡下').effect;
    const other = h.runtimeOf('别的').effect;
    expect(effTop).toBeTruthy();

    h.sys.applyPreviewEffect('fx', fx('工作态'));             // 保活 / 拖布置顶点：带着同一份效果再发一次
    expect(top.effect).toBe(effTop);                          // 同步判：没被置空重装
    await h.flush();
    expect(h.runtimeOf('纸钱_山顶').effect).toBe(effTop);
    expect(h.runtimeOf('纸钱_坡下').effect).toBe(effLow);
    expect(h.runtimeOf('别的').effect).toBe(other);

    h.sys.applyPreviewEffect('fx', fx('真改了'));              // 真改了 ⇒ 重建
    expect(top.effect).toBeNull();
    await h.flush();
    expect(h.labelOf('纸钱_山顶')).toBe('真改了');
    expect(h.runtimeOf('别的').effect).toBe(other);           // 别的效果的实例照旧不动
  });

  it('#5 撤销后再推同一份 ⇒ 照样套上（记住的那份跟着撤销清掉）；destroy 也清', async () => {
    const h = harness();
    h.eventBus.emit('scene:ready');
    await h.flush();
    h.sys.applyPreviewEffect('fx', fx('工作态'));
    await h.flush();
    h.sys.applyPreviewEffect('fx', null);
    await h.flush();
    expect(h.labelOf('纸钱_山顶')).toBe('开局盘上');
    h.sys.applyPreviewEffect('fx', fx('工作态'));
    await h.flush();
    expect(h.labelOf('纸钱_山顶')).toBe('工作态');

    h.sys.destroy();
    expect((h.sys as unknown as { previewEffectJson: Map<string, string> }).previewEffectJson.size).toBe(0);
  });
});
