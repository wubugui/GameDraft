/**
 * 框架自检:只用 Pixi 自带(两边都有官方程序)的东西。这几条不过,说明框架本身(行序、格式、回读)有问题,
 * 其余用例的结论都不可信。
 */
import { ColorMatrixFilter, Container, Graphics, Sprite } from 'pixi.js';
import type { ParityCase } from '../harness';

export const cases: ParityCase[] = [
  {
    name: '框架自检 / 非对称数据纹理原样画出(行序)',
    width: 16,
    height: 8,
    tolerance: 0,
    build(env) {
      // 左上角一个亮块、其余渐变:上下翻了、左右翻了都会被抓到
      const tex = env.dataTexture({
        width: 16, height: 8, seed: 1,
        fill: (x, y, c) => (c === 3 ? 1 : x < 3 && y < 2 ? 1 : c === 0 ? x / 15 : c === 1 ? y / 7 : 0.25),
      });
      const root = new Container();
      root.addChild(new Sprite(tex));
      return root;
    },
  },
  {
    name: '框架自检 / 半透明图形 + 颜色矩阵滤镜(8 位)',
    width: 32,
    height: 32,
    tolerance: 2 / 255,
    build() {
      const root = new Container();
      const g = new Graphics().rect(4, 4, 20, 12).fill({ color: 0xff8800, alpha: 0.6 }).rect(10, 14, 16, 14).fill({ color: 0x2266ff, alpha: 0.8 });
      const f = new ColorMatrixFilter();
      f.hue(40, false);
      g.filters = [f];
      root.addChild(g);
      return root;
    },
  },
  {
    name: '框架自检 / 浮点目标 rgba16float',
    width: 8,
    height: 8,
    target: 'rgba16float',
    tolerance: 1e-3,
    build(env) {
      const tex = env.dataTexture({ width: 8, height: 8, seed: 7, format: 'rgba16float', fill: (x, y, c) => (c === 3 ? 1 : (x + y * 8 + c) / 64) });
      const root = new Container();
      root.addChild(new Sprite(tex));
      return root;
    },
  },
];
