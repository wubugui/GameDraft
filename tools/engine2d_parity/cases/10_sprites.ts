import type { Case } from '../harness';

/** 纹理:4×4 块的彩色格子,alpha 渐变(预乘) */
function checker(env: Parameters<Case['build']>[0], seed: number, w = 32, h = 32) {
  return env.dataTexture({
    width: w,
    height: h,
    seed,
    fill: (x, y, c, rng) => {
      const a = ((x >> 2) + (y >> 2)) % 3 === 0 ? 0.5 : 1;
      if (c === 3) return a;
      return rng() * a;
    },
  });
}

export const cases: Case[] = [
  {
    name: '精灵 / 平移缩放旋转 + 锚点',
    width: 128,
    height: 96,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const tex = checker(env, 1);
      const a = new lib.Sprite(tex);
      a.position.set(10, 12);
      const b = new lib.Sprite(tex);
      b.anchor.set(0.5);
      b.position.set(64, 48);
      b.rotation = 0.6;
      b.scale.set(1.3, 0.8);
      const c = new lib.Sprite(tex);
      c.position.set(100, 60);
      c.skew.set(0.2, -0.1);
      c.pivot.set(8, 8);
      root.addChild(a, b, c);
      return root;
    },
  },
  {
    name: '精灵 / tint + alpha 继承(8 位量化)',
    width: 96,
    height: 64,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const tex = checker(env, 2);
      const g = new lib.Container();
      g.alpha = 0.7;
      g.tint = 0x88ccff;
      const s1 = new lib.Sprite(tex);
      s1.tint = 0xff8844;
      s1.alpha = 0.55;
      const s2 = new lib.Sprite(tex);
      s2.x = 40;
      s2.alpha = 0.33;
      g.addChild(s1, s2);
      root.addChild(g);
      const s3 = new lib.Sprite(tex);
      s3.position.set(20, 30);
      s3.tint = '#40a060';
      root.addChild(s3);
      return root;
    },
  },
  {
    name: '精灵 / 混合模式 normal add multiply screen erase',
    width: 160,
    height: 48,
    tolerance: 1 / 255,
    clearColor: [0.2, 0.3, 0.4, 1],
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const base = checker(env, 3);
      const over = checker(env, 4);
      const modes = ['normal', 'add', 'multiply', 'screen', 'erase'] as const;
      modes.forEach((m, i) => {
        const b = new lib.Sprite(base);
        b.x = i * 32;
        const o = new lib.Sprite(over);
        o.x = i * 32 + 6;
        o.y = 6;
        o.blendMode = m;
        root.addChild(b, o);
      });
      return root;
    },
  },
  {
    name: '容器 / zIndex 排序 + visible / renderable',
    width: 96,
    height: 64,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      root.sortableChildren = true;
      for (let i = 0; i < 6; i++) {
        const s = new lib.Sprite(checker(env, 10 + i, 24, 24));
        s.position.set(i * 12, i * 6);
        s.zIndex = (i * 7) % 5;
        if (i === 2) s.visible = false;
        if (i === 4) s.renderable = false;
        root.addChild(s);
      }
      return root;
    },
  },
  {
    name: '纹理 / 图集帧 + trim + 超过 16 张纹理的合批',
    width: 160,
    height: 96,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const atlas = checker(env, 20, 64, 64);
      const frame = new lib.Texture({
        source: atlas.source,
        frame: new lib.Rectangle(8, 8, 24, 16),
        orig: new lib.Rectangle(0, 0, 32, 24),
        trim: new lib.Rectangle(4, 4, 24, 16),
      });
      const s = new lib.Sprite(frame);
      s.anchor.set(0.5);
      s.position.set(20, 20);
      root.addChild(s);
      for (let i = 0; i < 20; i++) {
        const t = checker(env, 100 + i, 8, 8);
        const sp = new lib.Sprite(t);
        sp.position.set(40 + (i % 10) * 12, 40 + Math.floor(i / 10) * 12);
        root.addChild(sp);
      }
      return root;
    },
  },
  {
    name: '纹理 / 线性过滤放大 + 非预乘源(npm 混合)',
    width: 96,
    height: 64,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const t = env.dataTexture({ width: 8, height: 8, seed: 30, scaleMode: 'linear', alphaMode: 'premultiplied-alpha' });
      const s = new lib.Sprite(t);
      s.scale.set(5, 4);
      root.addChild(s);
      const npm = env.dataTexture({ width: 8, height: 8, seed: 31, alphaMode: 'no-premultiply-alpha' });
      const s2 = new lib.Sprite(npm);
      s2.position.set(50, 10);
      s2.scale.set(4);
      root.addChild(s2);
      return root;
    },
  },
  {
    name: '渲染目标分辨率 2',
    width: 64,
    height: 48,
    resolution: 2,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const s = new lib.Sprite(checker(env, 40));
      s.position.set(5.5, 3.25);
      s.rotation = 0.3;
      root.addChild(s);
      return root;
    },
  },
];
