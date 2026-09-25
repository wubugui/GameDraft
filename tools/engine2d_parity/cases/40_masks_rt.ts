import type { Case, Env } from '../harness';

function triMask(env: Env) {
  const { lib } = env;
  const geometry = new lib.MeshGeometry({
    positions: new Float32Array([10, 5, 90, 20, 30, 70]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  });
  return new lib.Mesh({ geometry, texture: lib.Texture.WHITE });
}

function content(env: Env) {
  const { lib } = env;
  const c = new lib.Container();
  for (let i = 0; i < 4; i++) {
    const s = new lib.Sprite(env.dataTexture({ width: 30, height: 30, seed: 90 + i }));
    s.position.set(i * 22, (i % 2) * 20);
    c.addChild(s);
  }
  return c;
}

export const cases: Case[] = [
  {
    name: '遮罩 / 网格当模板遮罩(兄弟节点)',
    width: 112,
    height: 80,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const c = content(env);
      const mask = triMask(env);
      root.addChild(c, mask);
      c.mask = mask;
      return root;
    },
  },
  {
    name: '遮罩 / 嵌套两层遮罩',
    width: 112,
    height: 80,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const outer = new lib.Container();
      const inner = content(env);
      const m1 = triMask(env);
      const m2 = triMask(env);
      m2.scale.set(-1, 1);
      m2.x = 110;
      outer.addChild(inner, m2);
      inner.mask = m2;
      root.addChild(outer, m1);
      outer.mask = m1;
      return root;
    },
  },
  {
    name: '渲染到纹理 / RenderTexture 再当精灵画',
    width: 96,
    height: 64,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const rt = lib.RenderTexture.create({ width: 48, height: 32 });
      const inner = content(env);
      inner.scale.set(0.5);
      env.renderer.render({ container: inner, target: rt, clear: true });
      const s = new lib.Sprite(rt);
      s.position.set(10, 10);
      s.rotation = 0.2;
      const s2 = new lib.Sprite(rt);
      s2.position.set(50, 30);
      s2.alpha = 0.6;
      root.addChild(s, s2);
      return root;
    },
  },
  {
    name: '渲染到纹理 / generateTexture',
    width: 96,
    height: 64,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const inner = content(env);
      inner.x = -5;
      const tex = env.renderer.generateTexture(inner);
      const s = new lib.Sprite(tex);
      s.position.set(8, 4);
      root.addChild(s);
      return root;
    },
  },
];
