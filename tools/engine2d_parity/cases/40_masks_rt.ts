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

/** 圆形 alpha 渐变的遮罩纹理(预乘:rgb = a;中心不透明,向外渐隐) */
function circleMaskTexture(env: Env, scaleMode: 'nearest' | 'linear') {
  const size = 24;
  return env.dataTexture({
    width: size,
    height: size,
    seed: 7,
    scaleMode,
    fill: (x, y) => {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      return Math.max(0, Math.min(1, 1.25 - d));
    },
  });
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
    name: '遮罩 / AlphaMask 包 Graphics(先画进纹理)',
    width: 112,
    height: 80,
    tolerance: 1 / 255,
    // 排在 Sprite 遮罩用例前面:Pixi 的 AlphaMaskEffect 进池复用,Sprite 遮罩用过后内部精灵被换成用例的遮罩精灵,
    // 用例拆场景销毁它之后再走这条(画进纹理)会读到已销毁精灵的 anchor 而抛错(Pixi 自身的池污染,engine2d 不复刻)
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const c = content(env);
      const g = new lib.Graphics().circle(40, 30, 22.5).fill({ color: 0xffffff, alpha: 0.75 }).rect(60, 10, 30.5, 12).fill(0xff8040);
      root.addChild(c, g);
      c.mask = new lib.AlphaMask({ mask: g });
      return root;
    },
  },
  {
    name: '遮罩 / Sprite 当 alpha 遮罩(nearest 纹理,旋转缩放)',
    width: 112,
    height: 80,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const c = content(env);
      const mask = new lib.Sprite(circleMaskTexture(env, 'nearest'));
      mask.anchor.set(0.5);
      mask.position.set(46, 30);
      mask.scale.set(2.2, 1.6);
      mask.rotation = 0.35;
      root.addChild(c, mask);
      c.mask = mask;
      return root;
    },
  },
  {
    name: '遮罩 / Sprite 反向 alpha 遮罩(linear 纹理,遮罩在内容里)',
    width: 112,
    height: 80,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const c = content(env);
      c.position.set(6, 4);
      const mask = new lib.Sprite(circleMaskTexture(env, 'linear'));
      mask.position.set(20, 8);
      mask.scale.set(1.5);
      c.addChild(mask);
      c.setMask({ mask, inverse: true });
      root.addChild(c);
      return root;
    },
  },
  {
    name: '遮罩 / 数字颜色遮罩(嵌套按位与)',
    width: 112,
    height: 80,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const back = new lib.Sprite(env.dataTexture({ width: 112, height: 80, seed: 5 }));
      const outer = new lib.Container();
      const c = content(env);
      c.mask = 0b1011;
      outer.addChild(c);
      const other = new lib.Sprite(env.dataTexture({ width: 30, height: 30, seed: 12 }));
      other.position.set(70, 40);
      outer.addChild(other);
      outer.mask = 0b1110;
      root.addChild(back, outer);
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
