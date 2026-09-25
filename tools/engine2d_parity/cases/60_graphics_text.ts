import type { Case, Env } from '../harness';

function panel(env: Env) {
  const { lib } = env;
  const g = new lib.Graphics();
  g.roundRect(0, 0, 150, 90, 10).fill({ color: 0x1a1410, alpha: 0.92 }).stroke({ color: 0xc8a050, width: 1.5, alpha: 0.8 });
  g.moveTo(12, 30).lineTo(138, 30).stroke({ color: 0xc8b89a, width: 1, alpha: 0.5 });
  g.circle(20, 60, 8).fill(0xd8b060);
  return g;
}

export const cases: Case[] = [
  {
    name: '图形 / 小图形合批(矩形、圆、三角、描边)',
    width: 128,
    height: 80,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const g = new lib.Graphics();
      g.rect(4, 4, 50, 30).fill({ color: 0x2a6018, alpha: 0.85 });
      g.circle(80, 20, 12).fill(0xd8b060);
      g.moveTo(100, 10).lineTo(120, 26).lineTo(96, 34).closePath().fill(0xffffff);
      g.rect(10, 44, 60, 26).stroke({ color: 0xff4040, width: 3 });
      root.addChild(g);
      return root;
    },
  },
  {
    name: '图形 / 大图形不合批(圆角面板 + 描边)+ tint + alpha + 旋转',
    width: 200,
    height: 140,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const a = panel(env);
      a.position.set(6, 6);
      const b = panel(env);
      b.position.set(40, 40);
      b.rotation = 0.15;
      b.tint = 0x88bbff;
      b.alpha = 0.6;
      root.addChild(a, b);
      return root;
    },
  },
  {
    name: '图形 / 线性渐变 + 纹理填充 + 洞',
    width: 160,
    height: 96,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const grad = new lib.FillGradient({
        type: 'linear',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 0 },
        colorStops: [
          { offset: 0, color: 0xff0000 },
          { offset: 0.5, color: 0x00ff00 },
          { offset: 1, color: 0x0000ff },
        ],
      });
      const g = new lib.Graphics();
      g.rect(4, 4, 70, 40).fill(grad);
      const tex = env.dataTexture({ width: 8, height: 8, seed: 300 });
      g.rect(80, 4, 70, 40).fill({ texture: tex });
      g.rect(4, 50, 100, 40).fill(0x3366aa).circle(54, 70, 12).cut();
      root.addChild(g);
      return root;
    },
  },
  {
    name: '遮罩 / Graphics 圆角矩形遮罩(UI 滚动区写法)',
    width: 128,
    height: 96,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const content = new lib.Container();
      for (let i = 0; i < 5; i++) {
        const s = new lib.Sprite(env.dataTexture({ width: 40, height: 30, seed: 310 + i }));
        s.position.set(10 + (i % 3) * 36, 6 + Math.floor(i / 3) * 40);
        content.addChild(s);
      }
      const mask = new lib.Graphics();
      mask.roundRect(14, 12, 96, 64, 12).fill(0xffffff);
      root.addChild(content, mask);
      content.mask = mask;
      return root;
    },
  },
  {
    name: '文字 / Text 基本样式 + 描边 + 投影 + 换行',
    width: 220,
    height: 120,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const t1 = new lib.Text({ text: 'Hello 世界', style: { fontFamily: 'sans-serif', fontSize: 20, fill: 0xffcc66 } });
      t1.position.set(6, 4);
      const t2 = new lib.Text({
        text: 'Stroke 描边 shadow',
        style: { fontFamily: 'serif', fontSize: 18, fill: '#ffffff', stroke: { color: 0x442200, width: 3 }, dropShadow: { color: 0x000000, alpha: 0.6, blur: 2, distance: 3, angle: Math.PI / 4 } },
      });
      t2.position.set(6, 34);
      const t3 = new lib.Text({ text: '一段很长的文字需要自动换行显示在固定宽度里', style: { fontSize: 14, fill: 0xddeeff, wordWrap: true, wordWrapWidth: 150, breakWords: true, lineHeight: 18 } });
      t3.position.set(6, 64);
      t3.anchor.set(0, 0);
      const t4 = new lib.Text({ text: 'R', style: { fontSize: 30, fill: 0x88ff88 } });
      t4.anchor.set(0.5);
      t4.position.set(190, 20);
      t4.rotation = 0.3;
      t4.alpha = 0.7;
      root.addChild(t1, t2, t3, t4);
      return root;
    },
  },
  {
    name: '文字 / 分辨率 2 渲染目标(Text.resolution 自动)',
    width: 120,
    height: 40,
    resolution: 2,
    tolerance: 1 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const t = new lib.Text({ text: 'Res 2 文字', style: { fontSize: 16, fill: 0xffffff } });
      t.position.set(4, 8);
      root.addChild(t);
      return root;
    },
  },
];
