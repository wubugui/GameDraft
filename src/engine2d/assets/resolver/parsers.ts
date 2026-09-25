/**
 * 地址解析插件(移植自 PixiJS v8.17(MIT):`assets/resolver/parsers/resolveTextureUrl`、`resolveJsonUrl`)。
 * 从图片地址读出 `resolution`(`@2x` → 2,没有 → 1)与 `format`(最后一个点之后)。
 */
import { loadTextures } from '../loader/parsers/loadTextures';
import { Resolver } from './Resolver';
import type { ResolveURLParser } from '../types';

export const resolveTextureUrl: ResolveURLParser = {
  extension: {
    type: 'resolve-parser',
    name: 'resolveTexture',
  },
  test: (url: string) => (loadTextures.test as (url: string) => boolean)(url),
  parse: (value: string) => ({
    resolution: parseFloat(Resolver.RETINA_PREFIX.exec(value)?.[1] ?? '1'),
    format: value.split('.').pop(),
    src: value,
  }),
};

export const resolveJsonUrl: ResolveURLParser = {
  extension: {
    type: 'resolve-parser',
    priority: -2,
    name: 'resolveJson',
  },
  test: (value: string) => Resolver.RETINA_PREFIX.test(value) && value.endsWith('.json'),
  parse: resolveTextureUrl.parse,
};
