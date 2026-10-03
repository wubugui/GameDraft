import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { defaultSceneLighting } from '../data/sceneLightingDefault';
import { geometryMetaProblems } from './lightingPayloadFiles';
import { SceneDepthSystem } from './SceneDepthSystem';
import { SceneLightingSystem } from './SceneLightingSystem';
import type { SceneDepthConfig, SceneData } from '../data/types';

describe('defaultSceneLighting（场景没写 lighting 块时生效的那份）', () => {
  it('没有作者灯、显示变换恒等、不去霾 ⇒ 画面等于原画', () => {
    const d = defaultSceneLighting();
    expect(d.lights).toEqual([]);
    expect(d.display).toMatchObject({
      ev: 0, tonemap: 'none', whiteKelvin: 6500, contrast: 1, saturation: 1, lift: 0,
    });
    expect(d.dehaze ?? 0).toBe(0);
    expect(d.fog?.sigma ?? 0).toBe(0);
  });

  it('每次给新拷贝：调用方原地改（F2 / 摆灯）不串到下一个场景', () => {
    const a = defaultSceneLighting();
    a.lights.push({ id: 'x', kind: 'point', pos: [0, 0, 0], intensity: 1 });
    a.display.ev = 3;
    const b = defaultSceneLighting();
    expect(b.lights).toEqual([]);
    expect(b.display.ev).toBe(0);
  });
});

describe('深度/场景光照的加载世代与必需载荷', () => {
  const depthConfig = {
    depth_map: 'depth.png', depth_tolerance: 0, floor_offset: 0,
    M: { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], ppu: 1, cx: 0, cy: 0 },
    depth_mapping: { invert: false, scale: 1, offset: 0 },
  } as SceneDepthConfig;
  const texture = { width: 4, height: 4 };
  const assets = () => ({
    loadTexture: vi.fn(async () => texture),
    loadBitmap: vi.fn(async () => { throw new Error('optional CPU bitmap unavailable'); }),
    loadOptionalJson: vi.fn(async () => null),
  });

  it('旧深度请求晚返回不覆盖新场景，也不能把新场景禁用', async () => {
    const am = assets();
    let late!: (value: typeof texture) => void;
    am.loadTexture.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    const system = new SceneDepthSystem();
    const old = system.load('old', depthConfig, am as never, 100, 100, 1, 1, { strict: true }).catch((error) => error);
    await system.load('new', depthConfig, am as never, 100, 100, 1, 1, { strict: true });
    late({ width: 8, height: 8 });
    expect(await old).toMatchObject({ name: 'AbortError' });
    expect(system.currentSceneId).toBe('new');
    expect(system.isEnabled).toBe(true);
    expect(system.currentDepthTexture).toBe(texture);
    system.destroy();
  });

  it('strict 深度与显式碰撞缺件必须抛，可选CPU壳缺失仍可启用深度', async () => {
    const am = assets();
    const system = new SceneDepthSystem();
    am.loadTexture.mockRejectedValueOnce(new Error('required depth missing'));
    await expect(system.load('s', depthConfig, am as never, 100, 100, 1, 1, { strict: true })).rejects.toThrow(/required depth/);
    expect(system.isEnabled).toBe(false);
    await system.load('s', depthConfig, am as never, 100, 100, 1, 1, { strict: true });
    expect(system.isEnabled).toBe(true);
    expect(system.depthShellField).toBeNull();
    await expect(system.load('s', { ...depthConfig, collision_map: 'collision.png' }, am as never, 100, 100, 1, 1, { strict: true })).rejects.toThrow(/bitmap unavailable/);
    expect(system.isEnabled).toBe(false);
    system.destroy();
  });

  it('旧光照入口晚返回不能在无光照的新场景重新创建GPU表现', async () => {
    let late!: (value: unknown) => void;
    const am = { loadOptionalJson: vi.fn(() => new Promise((resolve) => { late = resolve; })), loadTexture: vi.fn() };
    const system = new SceneLightingSystem();
    const old = system.load('old', { depthConfig, backgrounds: [] } as unknown as SceneData, am as never, texture as never, { strict: true }).catch((error) => error);
    expect(await system.load('new', { backgrounds: [] } as unknown as SceneData, am as never, texture as never)).toBe(false);
    late({});
    expect(await old).toMatchObject({ name: 'AbortError' });
    expect(am.loadTexture).not.toHaveBeenCalled();
    expect(system.active).toBe(false);
    expect(system.backgroundMesh).toBeNull();
    system.unload();
  });
});

describe('geometryMetaProblems（按运行时真正读的字段验，不按版本号）', () => {
  const good = {
    version: 3, // 代次不参与判定：v3 载荷补了 albedo 之后与 v4 没有运行时差别
    native: { w: 2048, h: 1152 },
    work: { w: 512, h: 288 },
    cal: { ppu: 112.64, cx: 256, cy: 144 },
    scale: { char_wu: 0.49, scene_per_wu: 302.7 },
  };

  it('字段齐全就可用，与 version 是几无关', () => {
    expect(geometryMetaProblems(good)).toEqual([]);
    expect(geometryMetaProblems({ ...good, version: 99 })).toEqual([]);
    const { version: _v, ...noVersion } = good;
    expect(geometryMetaProblems(noVersion)).toEqual([]);
  });

  it('缺运行时要读的字段就点名说缺什么', () => {
    expect(geometryMetaProblems({ ...good, native: undefined })).toEqual(['native.w', 'native.h']);
    expect(geometryMetaProblems({ ...good, scale: { char_wu: 0.5, scene_per_wu: 0 } }))
      .toEqual(['scale.scene_per_wu']);
    expect(geometryMetaProblems(null).length).toBeGreaterThan(0);
  });

  it('盘上每一份几何场 meta 都过得了（DVC 没拉时跳过）', () => {
    const root = join(process.cwd(), 'public', 'resources', 'runtime', 'scenes');
    if (!existsSync(root)) return;
    const bad: string[] = [];
    for (const sid of readdirSync(root)) {
      const lit = join(root, sid, 'lighting');
      if (!existsSync(lit)) continue;
      for (const key of readdirSync(lit)) {
        const f = join(lit, key, 'geometry.json');
        if (!existsSync(f)) continue;
        const p = geometryMetaProblems(JSON.parse(readFileSync(f, 'utf-8')));
        if (p.length) bad.push(`${sid}/${key}: ${p.join('；')}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
