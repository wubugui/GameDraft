import type { Case, Env } from '../harness';

/**
 * roundPixels 在离屏目标里的半像素平局(R2-6)。master 的 Pixi WebGL 对非根目标用翻转投影,取整在「内容自上而下」
 * 方向上断平(y = k + 0.5 落到 k + 1);顶点正好落在平局上时,上下差的就是一整行。这里的顶点都故意放在平局上,
 * 容差 0,要求逐位一致。滤镜那条让包围盒正好 64 高 = 池化纹理的 2 的幂高,滤镜输入纹理里也是平局。
 */

function opaque(env: Env, width: number, height: number, seed: number) {
  return env.dataTexture({ width, height, seed, fill: (_x, _y, c, rng) => (c === 3 ? 1 : 0.2 + rng() * 0.8) });
}

export const cases: Case[] = [
  {
    name: '取整 / roundPixels 精灵半像素平局(直接画进离屏目标)',
    width: 128,
    height: 64,
    tolerance: 0,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const specs: Array<[number, number, number, number]> = [
        [4.5, 3.5, 13, 9],
        [24, 10.5, 12, 15],
        [44.5, 20.25, 10, 11],
        [60, 30.5, 9, 20],
        [80.5, 41.5, 17, 7],
        [104, 50.75, 11, 9],
      ];
      specs.forEach(([x, y, w, h], i) => {
        const s = new lib.Sprite(opaque(env, w, h, 400 + i));
        s.roundPixels = true;
        s.position.set(x, y);
        root.addChild(s);
      });
      // 锚点 (0.5, 1):游戏里热区 / NPC 精灵的写法
      const a = new lib.Sprite(opaque(env, 15, 21, 410));
      a.anchor.set(0.5, 1);
      a.roundPixels = true;
      a.position.set(20.5, 60.5);
      root.addChild(a);
      return root;
    },
  },
  {
    name: '取整 / roundPixels 精灵经滤镜(包围盒 = 2 的幂池化纹理,平局)',
    width: 128,
    height: 128,
    tolerance: 0,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      // 63 高、锚点 (0.5, 1)、y = 100.5:滤镜包围盒 [37, 101) 共 64 行 = 池化纹理高 64,纹理里的 y 正好在 k + 0.5
      const a = new lib.Sprite(opaque(env, 40, 63, 420));
      a.anchor.set(0.5, 1);
      a.roundPixels = true;
      a.position.set(30, 100.5);
      a.filters = [new lib.AlphaFilter({ alpha: 1 })];
      const b = new lib.Sprite(opaque(env, 21, 31, 421));
      b.anchor.set(0.5, 1);
      b.roundPixels = true;
      b.position.set(90.5, 60.5);
      b.filters = [new lib.AlphaFilter({ alpha: 1 })];
      // 容器上挂滤镜、里面的精灵取整(NPC 容器滤镜的写法)
      const c = new lib.Container();
      const cs = new lib.Sprite(opaque(env, 25, 31, 422));
      cs.anchor.set(0.5, 1);
      cs.roundPixels = true;
      cs.position.set(100, 122.5);
      c.addChild(cs);
      c.filters = [new lib.AlphaFilter({ alpha: 1 })];
      root.addChild(a, b, c);
      return root;
    },
  },
  {
    name: '取整 / roundPixels 图形(合批 + 不合批)与网格(不合批)半像素平局',
    width: 128,
    height: 96,
    tolerance: 0,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const small = new lib.Graphics();
      small.rect(0, 0, 20, 13).fill(0x3388cc).rect(24, 2, 9, 7).fill(0xcc8833);
      small.roundPixels = true;
      small.position.set(4.5, 5.5);
      const big = new lib.Graphics();
      big.roundRect(0, 0, 50, 31, 8).fill({ color: 0x1a1410, alpha: 0.9 }).stroke({ color: 0xc8a050, width: 2 });
      big.circle(12, 15, 6).fill(0xd8b060);
      big.roundPixels = true;
      big.position.set(60, 4.5);
      const plane = new lib.MeshPlane({ texture: opaque(env, 32, 32, 430), verticesX: 12, verticesY: 12 });
      plane.roundPixels = true;
      plane.position.set(20.5, 50.5);
      root.addChild(small, big, plane);
      return root;
    },
  },
];
