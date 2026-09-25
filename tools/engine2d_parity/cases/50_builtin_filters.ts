import type { Case, Env } from '../harness';

function scene(env: Env) {
  const { lib } = env;
  const g = new lib.Container();
  for (let i = 0; i < 3; i++) {
    const s = new lib.Sprite(env.dataTexture({ width: 24, height: 24, seed: 200 + i, fill: (x, y, c, rng) => (c === 3 ? 1 : ((x >> 3) + (y >> 3) + c) % 2 ? 0.9 : rng() * 0.3) }));
    s.position.set(16 + i * 22, 12 + i * 10);
    g.addChild(s);
  }
  return g;
}

export const cases: Case[] = [
  {
    name: '内置滤镜 / BlurFilter 缺省',
    width: 112,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const g = scene(env);
      g.filters = [new lib.BlurFilter()];
      root.addChild(g);
      return root;
    },
  },
  {
    name: '内置滤镜 / BlurFilter strength 12 quality 3 + 只 X 方向',
    width: 112,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const a = scene(env);
      a.filters = [new lib.BlurFilter({ strength: 12, quality: 3 })];
      const b = scene(env);
      b.y = 30;
      b.alpha = 0.8;
      b.filters = [new lib.BlurFilter({ strengthX: 6, strengthY: 0 })];
      root.addChild(a, b);
      return root;
    },
  },
  {
    name: '内置滤镜 / ColorMatrixFilter 链式 + AlphaFilter',
    width: 112,
    height: 80,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const g = scene(env);
      const cm = new lib.ColorMatrixFilter();
      cm.saturate(0.6);
      cm.hue(40, true);
      cm.brightness(1.1, true);
      g.filters = [cm, new lib.AlphaFilter({ alpha: 0.7 })];
      root.addChild(g);
      return root;
    },
  },
  {
    name: '九宫格 / NineSliceSprite 拉伸 + 图集帧',
    width: 128,
    height: 96,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const t = env.dataTexture({ width: 32, height: 32, seed: 210, scaleMode: 'linear' });
      const n = new lib.NineSliceSprite({ texture: t, leftWidth: 6, topHeight: 8, rightWidth: 10, bottomHeight: 5 });
      n.width = 90;
      n.height = 40;
      n.position.set(6, 6);
      const atlas = env.dataTexture({ width: 64, height: 64, seed: 211 });
      const frame = new lib.Texture({ source: atlas.source, frame: new lib.Rectangle(16, 8, 30, 28) });
      const n2 = new lib.NineSliceSprite({ texture: frame, leftWidth: 5, topHeight: 5, rightWidth: 5, bottomHeight: 5 });
      n2.width = 60;
      n2.height = 36;
      n2.position.set(50, 52);
      root.addChild(n, n2);
      return root;
    },
  },
];
