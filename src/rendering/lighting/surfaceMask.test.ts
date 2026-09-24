/**
 * 表面材质的解析（缺省值只在 SURFACE_DEFAULTS 一处）：全局缺省材质不写的量取缺省、越界夹住；
 * 区的反光 / 粗糙度不写取种类缺省；形状不对的区跳过。遮罩画布本身要浏览器，这里只验解析。
 */
import { describe, expect, it } from 'vitest';
import { resolveSurfaceDefaults, resolveSurfaceRegion, SURFACE_DEFAULTS } from './surfaceMask';

describe('表面材质解析', () => {
  it('全局缺省材质：不写 = 缺省，越界夹住', () => {
    expect(resolveSurfaceDefaults(null)).toEqual({ ...SURFACE_DEFAULTS.ground });
    expect(resolveSurfaceDefaults({ roughness: 0.2, detail: 5, ripple: -1, reflect: 2 }))
      .toEqual({ reflect: 1, roughness: 0.2, detail: 2, ripple: 0 });
  });

  it('区：反光 / 粗糙度取种类缺省；羽化缺省 24；形状不对的返回 null', () => {
    const poly: [number, number][] = [[0, 0], [1, 0], [1, 1]];
    expect(resolveSurfaceRegion({ id: 'a', kind: 'water', polygon: poly }))
      .toMatchObject({ water: true, reflect: SURFACE_DEFAULTS.water.reflect, roughness: SURFACE_DEFAULTS.water.roughness, feather: 24 });
    expect(resolveSurfaceRegion({ id: 'b', kind: 'wet', polygon: poly, roughness: 0.6 }))
      .toMatchObject({ water: false, roughness: 0.6 });
    expect(resolveSurfaceRegion({ id: 'c', kind: 'wet', polygon: [[0, 0], [1, 1]] })).toBeNull();
  });
});
