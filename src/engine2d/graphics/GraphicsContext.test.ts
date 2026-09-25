/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GraphicsContext 对照测试:同一串绘制调用分别喂给 Pixi v8.17 的 GraphicsContext 与 engine2d 的,
 * 比较三角化结果(顶点 / uv / 索引逐数相等)、区段划分(偏移 / 长度 / 颜色 / alpha / 拓扑 / 纹理)、
 * 解析后的样式、bounds、containsPoint、合批判定。Pixi 的三角化用它导出的 `buildContextBatches` 直接跑(node 下可用)。
 */
import * as PIXI from 'pixi.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Matrix } from '../math/Matrix';
import { Rectangle } from '../math/Rectangle';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import { FillGradient } from './fill/FillGradient';
import { FillPattern } from './fill/FillPattern';
import { GraphicsContext } from './GraphicsContext';
import { GraphicsContextSystem } from './GraphicsContextSystem';
import { GraphicsPath } from './path/GraphicsPath';

// ─────────────────────────────────────────── 假画布(渐变纹理用;两边同一套)

interface FakeGradient {
  id: string;
  addColorStop(offset: number, color: string): void;
}

function makeFakeCanvasFactory(log: unknown[][]) {
  let n = 0;
  return (width = 1, height = 1): any => {
    const ctx = {
      set fillStyle(v: unknown) {
        log.push(['fillStyle', typeof v === 'string' ? v : (v as FakeGradient).id]);
      },
      createLinearGradient: (...a: number[]): FakeGradient => {
        const id = `lin${n++}`;
        log.push(['createLinearGradient', ...a]);
        return { id, addColorStop: (o, c) => log.push(['addColorStop', id, o, c]) };
      },
      createRadialGradient: (...a: number[]): FakeGradient => {
        const id = `rad${n++}`;
        log.push(['createRadialGradient', ...a]);
        return { id, addColorStop: (o, c) => log.push(['addColorStop', id, o, c]) };
      },
      fillRect: (...a: number[]) => log.push(['fillRect', ...a]),
      translate: (...a: number[]) => log.push(['translate', ...a]),
      rotate: (...a: number[]) => log.push(['rotate', ...a]),
      scale: (...a: number[]) => log.push(['scale', ...a]),
    };
    log.push(['createCanvas', width, height]);
    return { width, height, getContext: () => ctx };
  };
}

const pixiLog: unknown[][] = [];
const e2dLog: unknown[][] = [];
const adapter0 = PIXI.DOMAdapter.get();
const createCanvas0 = FillGradient.createCanvas;

beforeAll(() => {
  PIXI.DOMAdapter.set({ ...adapter0, createCanvas: makeFakeCanvasFactory(pixiLog) });
  FillGradient.createCanvas = makeFakeCanvasFactory(e2dLog);
});
afterAll(() => {
  PIXI.DOMAdapter.set(adapter0);
  FillGradient.createCanvas = createCanvas0;
});

// ─────────────────────────────────────────── 两边对应的"库"

interface Lib {
  name: 'pixi' | 'e2d';
  Matrix: any;
  GraphicsPath: any;
  FillGradient: any;
  FillPattern: any;
  WHITE: any;
  /** 64×32 的整张纹理 */
  tex: any;
  /** 128×128 源上 (16,8,32,32) 的图集帧 */
  frameTex: any;
}

function makeLibs(): { pixi: Lib; e2d: Lib } {
  const pixi: Lib = {
    name: 'pixi',
    Matrix: PIXI.Matrix,
    GraphicsPath: PIXI.GraphicsPath,
    FillGradient: PIXI.FillGradient,
    FillPattern: PIXI.FillPattern,
    WHITE: PIXI.Texture.WHITE,
    tex: new PIXI.Texture({ source: new PIXI.TextureSource({ width: 64, height: 32 }) }),
    frameTex: new PIXI.Texture({ source: new PIXI.TextureSource({ width: 128, height: 128 }), frame: new PIXI.Rectangle(16, 8, 32, 32) }),
  };
  const e2d: Lib = {
    name: 'e2d',
    Matrix,
    GraphicsPath,
    FillGradient,
    FillPattern,
    WHITE: Texture.WHITE,
    tex: new Texture({ source: new TextureSource({ width: 64, height: 32 }) }),
    frameTex: new Texture({ source: new TextureSource({ width: 128, height: 128 }), frame: new Rectangle(16, 8, 32, 32) }),
  };
  return { pixi, e2d };
}

type Scenario = (g: any, lib: Lib) => void;

/** 绘制场景表:覆盖游戏用法与 Pixi 各分支 */
const scenarios: Record<string, Scenario> = {
  'rect fill': (g) => g.rect(10, 20, 100, 50).fill(0xff0000),
  'rect fill {color, alpha}': (g) => g.rect(0, 0, 640, 360).fill({ color: 0x102030, alpha: 0.55 }),
  'rect 零尺寸 / 负尺寸': (g) => g.rect(0, 0, 0, 10).fill(0xffffff).rect(0, 0, -5, 10).fill(0xffffff).rect(5, 5, 1, 1).fill(0xffffff),
  'rect fill + stroke(同一路径)': (g) => g.rect(1, 2, 80, 40).fill({ color: 0x333333, alpha: 0.9 }).stroke({ color: 0xc8a050, width: 2 }),
  'rect stroke alignment 0 / 0.5 / 1': (g) => {
    g.rect(0, 0, 50, 30).stroke({ width: 4, color: 0x00ff00, alignment: 0 });
    g.rect(60, 0, 50, 30).stroke({ width: 4, color: 0x00ff00, alignment: 0.5 });
    g.rect(120, 0, 50, 30).stroke({ width: 4, color: 0x00ff00, alignment: 1 });
  },
  'roundRect fill + stroke': (g) => g.roundRect(4, 4, 200, 80, 6).fill({ color: 0x1a1410, alpha: 0.92 }).stroke({ color: 0x8a6a3a, width: 1.5 }),
  'roundRect 缺省半径 / 半径超半 / 0 半径': (g) => {
    g.roundRect(0, 0, 100, 60).fill(0xffffff);
    g.roundRect(0, 100, 40, 20, 50).fill(0xffffff);
    g.roundRect(0, 200, 30, 30, 0).fill(0xffffff);
  },
  'circle fill / stroke / 大圆(>200 顶点)': (g) => {
    g.circle(50, 50, 12).fill({ color: 0xffcc00, alpha: 0.8 });
    g.circle(150, 50, 20).stroke({ width: 3, color: 0x000000, alpha: 0.5 });
    g.circle(300, 300, 120).fill(0x224466);
  },
  'circle 半径 0': (g) => g.circle(0, 0, 0).fill(0xffffff),
  'ellipse fill + stroke': (g) => g.ellipse(30, -40, 25, 12).fill({ color: 0xffaa33, alpha: 0.6 }).stroke({ width: 2, color: 0xffffff }),
  'poly 扁平数组(不传 close)': (g) => g.poly([10, 0, 20, 3, 10, 8]).fill(0xff0000).stroke({ width: 1, color: 0 }),
  'poly 点数组 close=true / false': (g) => {
    g.poly([{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 40, y: 60 }, { x: -5, y: 30 }], true).fill(0x00ff00).stroke({ width: 3, color: 0xff00ff });
    g.poly([100, 0, 150, 10, 140, 60, 95, 30], false).stroke({ width: 3, color: 0xff00ff });
  },
  'poly 凹多边形': (g) => g.poly([0, 0, 100, 0, 100, 100, 50, 40, 0, 100], true).fill(0x445566),
  'star / regularPoly / roundPoly': (g) => {
    g.star(50, 50, 5, 40, 18, 0.3).fill(0xffd700).stroke({ width: 2, color: 0x000000, join: 'round' });
    g.regularPoly(150, 50, 30, 6, 0.1).fill(0x00ffff);
    g.roundPoly(250, 50, 30, 5, 8, 0.2).fill(0xff8800).stroke({ width: 1, color: 0 });
  },
  'roundShape(弧 / 二次)+ filletRect + chamferRect': (g) => {
    g.roundShape([{ x: 0, y: 0 }, { x: 80, y: 0, radius: 4 }, { x: 80, y: 60 }, { x: 0, y: 60, radius: 0 }], 10).fill(0x123456);
    g.roundShape([{ x: 100, y: 0 }, { x: 180, y: 10 }, { x: 160, y: 70 }], 12, true).stroke({ width: 2, color: 0xabcdef });
    g.filletRect(0, 100, 80, 50, 10).fill(0x654321);
    g.filletRect(100, 100, 80, 50, -10).stroke({ width: 2, color: 0x654321 });
    g.chamferRect(200, 100, 80, 50, 12).fill(0x777777);
  },
  'moveTo/lineTo 折线 stroke(miter 缺省)': (g) => g.moveTo(0, 0).lineTo(40, 5).lineTo(60, 50).lineTo(10, 70).stroke({ width: 6, color: 0x00ff00 }),
  'joins: miter / bevel / round × caps: butt / round / square': (g) => {
    const joins = ['miter', 'bevel', 'round'];
    const caps = ['butt', 'round', 'square'];
    let y = 0;
    for (const join of joins) {
      let x = 0;
      for (const cap of caps) {
        g.moveTo(x, y).lineTo(x + 30, y + 20).lineTo(x + 5, y + 40).lineTo(x + 40, y + 45)
          .stroke({ width: 7, color: 0xffffff, join, cap, alpha: 0.7 });
        x += 60;
      }
      y += 70;
    }
  },
  'miterLimit 小 / 锐角 / 回折': (g) => {
    g.moveTo(0, 0).lineTo(100, 5).lineTo(0, 10).stroke({ width: 8, color: 0xff0000, miterLimit: 2 });
    g.moveTo(0, 50).lineTo(100, 55).lineTo(0, 60).stroke({ width: 8, color: 0xff0000, miterLimit: 20 });
    g.moveTo(0, 100).lineTo(50, 100).lineTo(100, 100).lineTo(50, 100).stroke({ width: 4, color: 0xff0000, join: 'round' });
  },
  'stroke alignment 在开 / 闭折线上': (g) => {
    g.moveTo(0, 0).lineTo(50, 0).lineTo(50, 50).closePath().stroke({ width: 6, color: 0x0000ff, alignment: 1 });
    g.moveTo(100, 0).lineTo(150, 0).lineTo(150, 50).stroke({ width: 6, color: 0x0000ff, alignment: 0 });
  },
  'bezierCurveTo 气泡(游戏 EmoteBubble 形)': (g) => {
    const w = 120;
    const h = 90;
    const hw = w / 2;
    g.moveTo(-hw, 0);
    g.bezierCurveTo(-w * 0.18, -h * 0.20, w * 0.18, -h * 0.20, hw, 0);
    g.bezierCurveTo(w * 0.34, h * 0.34, w * 0.14, h * 0.72, 0, h);
    g.bezierCurveTo(-w * 0.14, h * 0.72, -w * 0.34, h * 0.34, -hw, 0);
    g.closePath();
    g.fill({ color: 0xfff8e8, alpha: 0.95 });
    g.stroke({ color: 0x3a2a1a, width: 2.5, alpha: 0.9, join: 'miter' });
  },
  'bezier smoothness / quadraticCurveTo': (g) => {
    g.moveTo(0, 0).bezierCurveTo(10, 80, 90, -40, 100, 50, 0.9).stroke({ width: 2, color: 0xffffff });
    g.moveTo(0, 100).quadraticCurveTo(50, 20, 100, 100).quadraticCurveTo(150, 180, 200, 100, 0.1).stroke({ width: 3, color: 0xff00ff, cap: 'round' });
  },
  'arc / arcTo / arcToSvg': (g) => {
    g.arc(50, 50, 30, 0, Math.PI * 1.5).stroke({ width: 4, color: 0xffffff });
    g.moveTo(100, 0).arc(150, 50, 20, Math.PI, 0, true).fill(0x00ff00);
    g.moveTo(200, 0).arcTo(260, 0, 260, 60, 20).lineTo(260, 100).stroke({ width: 2, color: 0xff0000, cap: 'square' });
    g.moveTo(300, 50).arcToSvg(40, 25, 30, 1, 0, 380, 60).stroke({ width: 2, color: 0x00ffff });
  },
  'arc 后接 fill(Pixi getLastPoint 取 arc 的 data[5/6])': (g) => {
    g.arc(0, 0, 10, 0, Math.PI).fill(0xff0000);
    g.lineTo(20, 20).lineTo(30, 0).fill(0x00ff00);
  },
  'cut: 矩形挖圆洞 / 圆挖矩形洞 / 描边带洞': (g) => {
    g.rect(0, 0, 100, 100).fill(0xff0000).circle(50, 50, 20).cut();
    g.circle(200, 50, 40).fill(0x00ff00).rect(190, 40, 20, 20).cut();
    g.rect(300, 0, 100, 100).fill(0x0000ff).stroke({ width: 4, color: 0xffffff }).circle(350, 50, 25).cut();
    g.rect(0, 200, 100, 100).fill(0xffffff).rect(10, 210, 20, 20).cut().rect(60, 260, 20, 20).cut();
  },
  'transform / save / restore / setTransform': (g, lib) => {
    g.translate(100, 50).rotate(0.3).scale(2, 1.5);
    g.rect(0, 0, 20, 10).fill(0xff0000);
    g.save();
    g.translate(10, 10);
    g.circle(0, 0, 8).fill(0x00ff00);
    g.moveTo(0, 0).lineTo(30, 0).lineTo(30, 30).stroke({ width: 2, color: 0x0000ff });
    g.restore();
    g.ellipse(5, 5, 10, 4).fill(0xffffff);
    g.setTransform(new lib.Matrix(1, 0.2, -0.1, 1, 5, 6));
    g.roundRect(0, 0, 40, 20, 5).stroke({ width: 3, color: 0x999999 });
    g.transform(1, 0, 0, 1, 50, 0).poly([0, 0, 10, 0, 5, 10], true).fill(0x777777);
    g.resetTransform().star(0, 0, 4, 10).fill(0x111111);
  },
  'path(GraphicsPath) + beginPath': (g, lib) => {
    const p = new lib.GraphicsPath();
    p.moveTo(0, 0).lineTo(30, 0).lineTo(15, 25).closePath();
    p.rect(40, 0, 10, 10);
    g.translate(5, 5).path(p).fill(0xff0000);
    g.resetTransform();
    g.moveTo(100, 100).lineTo(120, 100);
    g.beginPath();
    g.moveTo(0, 50).lineTo(50, 50).lineTo(50, 80).stroke({ width: 2, color: 0x00ff00 });
  },
  'setFillStyle / setStrokeStyle 后无参 fill / stroke': (g) => {
    g.setFillStyle({ color: 0x336699, alpha: 0.4 });
    g.setStrokeStyle({ width: 5, color: 0x996633, cap: 'round', join: 'bevel' });
    g.rect(0, 0, 30, 30).fill().stroke();
    g.setStrokeStyle(0xff0000);
    g.moveTo(0, 50).lineTo(40, 60).stroke();
  },
  'fill(color, alpha) 弃用写法 / 字符串颜色 / rgba 字符串': (g) => {
    g.rect(0, 0, 10, 10).fill(0x00ff00, 0.25);
    g.rect(20, 0, 10, 10).fill('#ff8800');
    g.rect(40, 0, 10, 10).fill('rgba(10,20,30,0.5)');
    g.rect(60, 0, 10, 10).fill({ color: 'rgba(200,100,50,0.5)', alpha: 0.5 });
    g.rect(80, 0, 10, 10).stroke({ color: 'rgba(255,255,255,0.3)', width: 2 });
  },
  '纹理填充:整张 / 图集帧 / global + matrix / 描边': (g, lib) => {
    g.rect(0, 0, 100, 50).fill({ texture: lib.tex });
    g.circle(150, 25, 20).fill({ texture: lib.frameTex, color: 0x88ff88, alpha: 0.5 });
    g.rect(200, 0, 60, 60).fill({ texture: lib.tex, textureSpace: 'global', matrix: new lib.Matrix(2, 0, 0, 2, 10, 5) });
    g.poly([300, 0, 360, 10, 330, 50], true).fill({ texture: lib.frameTex, textureSpace: 'global' });
    g.rect(0, 100, 80, 40).stroke({ texture: lib.tex, width: 6 });
    g.translate(10, 200).rotate(0.2).rect(0, 0, 50, 30).fill(lib.tex);
  },
  '纹理填充:PanelSkin 纸纹(roundRect + global + 恒等 matrix + tint)': (g, lib) => {
    g.roundRect(12, 8, 300, 160, 6);
    g.fill({ color: 0x17120d, alpha: 0.94 });
    g.roundRect(12, 8, 300, 160, 6);
    g.fill({ texture: lib.frameTex, color: 0x8a7350, alpha: 0.2 * 0.94, matrix: new lib.Matrix(), textureSpace: 'global' });
    g.roundRect(12, 8, 300, 160, 6);
    g.stroke({ color: 0x5a4a30, width: 1, alpha: 0.6 });
  },
  'FillPattern': (g, lib) => {
    const pattern = new lib.FillPattern(lib.frameTex, 'repeat-x');
    g.rect(0, 0, 90, 40).fill(pattern);
    const pattern2 = new lib.FillPattern(lib.tex);
    pattern2.setTransform(new lib.Matrix(0.5, 0, 0, 0.5, 3, 4));
    g.rect(0, 50, 90, 40).fill({ fill: pattern2, alpha: 0.7 });
  },
  'FillGradient 线性(UIDecor 用法)': (g, lib) => {
    const c = '200,160,90';
    const alpha = 0.6;
    const grad = new lib.FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      colorStops: [
        { offset: 0, color: `rgba(${c},0)` },
        { offset: 0.25, color: `rgba(${c},${alpha})` },
        { offset: 0.75, color: `rgba(${c},${alpha})` },
        { offset: 1, color: `rgba(${c},0)` },
      ],
      textureSpace: 'local',
    });
    g.rect(0, 0, 240, 1);
    g.fill(grad);
    const grad2 = new lib.FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 },
      colorStops: [
        { offset: 0, color: 'rgba(120,90,40,0.72)' },
        { offset: 1, color: 'rgba(60,45,20,0.72)' },
      ],
      textureSpace: 'local',
    });
    g.rect(8, 20, 300, 36);
    g.fill(grad2);
    g.rect(8, 20, 300, 36);
    g.stroke({ color: 0xc8a050, width: 1 });
  },
  'FillGradient 径向(PanelSkin / MenuUI / ObjectExamine 用法)': (g, lib) => {
    g.rect(10, 10, 400, 300);
    g.fill(new lib.FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.42 }, innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.42 }, outerRadius: 0.72,
      colorStops: [
        { offset: 0, color: 'rgba(0,0,0,0)' },
        { offset: 0.5, color: 'rgba(0,0,0,0.048)' },
        { offset: 0.7, color: 'rgba(0,0,0,0.7)' },
        { offset: 1, color: 'rgba(0,0,0,0.160)' },
      ],
      textureSpace: 'local',
    }));
    g.rect(0, 0, 1280, 720).fill(new lib.FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.45 }, innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.45 }, outerRadius: 0.78,
      colorStops: [
        { offset: 0, color: 'rgba(20,10,5,0)' },
        { offset: 0.55, color: 'rgba(20,10,5,0.06)' },
        { offset: 1, color: 'rgba(20,10,5,0.42)' },
      ],
      textureSpace: 'local',
    }));
    g.ellipse(0, 0, 300, 120).fill(new lib.FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.5 }, innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.5 }, outerRadius: 0.5,
      colorStops: [
        { offset: 0, color: 'rgba(0,0,0,0.34)' },
        { offset: 0.55, color: 'rgba(0,0,0,0.24)' },
        { offset: 1, color: 'rgba(0,0,0,0)' },
      ],
      textureSpace: 'local',
    }));
  },
  'FillGradient global 空间 / 反向 / 缺省色标': (g, lib) => {
    g.rect(0, 0, 200, 100).fill(new lib.FillGradient({ type: 'linear', start: { x: 200, y: 0 }, end: { x: 0, y: 100 }, textureSpace: 'global', colorStops: [{ offset: 0, color: 0xff0000 }, { offset: 1, color: 0x0000ff }] }));
    g.rect(0, 120, 200, 100).fill(new lib.FillGradient({ type: 'linear' }));
    g.circle(300, 50, 40).fill({ fill: new lib.FillGradient({ type: 'radial', textureSpace: 'global', center: { x: 300, y: 50 }, outerRadius: 40, colorStops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'black' }] }) });
  },
  'texture() 指令': (g, lib) => {
    g.texture(lib.tex);
    g.translate(50, 50).texture(lib.frameTex, 0xff8800, 5, 6, 40, 20);
    g.texture(lib.tex, 0);
  },
  'pixelLine': (g) => {
    g.moveTo(0, 0).lineTo(50, 0).lineTo(50, 50).stroke({ width: 1, color: 0xffffff, pixelLine: true });
    g.rect(60, 0, 30, 30).stroke({ pixelLine: true, color: 0xff0000 });
  },
  'clear 后重画': (g) => {
    g.rect(0, 0, 10, 10).fill(0xff0000);
    g.clear();
    g.circle(5, 5, 5).fill(0x00ff00);
  },
  '游戏:进度条 + 细线 + 命中层': (g) => {
    const w = 180;
    g.moveTo(0, 0).lineTo(w, 0).stroke({ width: 6, color: 0x2a2018, alpha: 0.8 });
    g.moveTo(0, 0).lineTo(w * 0.37, 0).stroke({ width: 4, color: 0xd8b060, alpha: 0.95 });
    g.rect(0, 20, w, 1).fill({ color: 0xc8b89a, alpha: 0.25 });
    g.rect(-4, -10, w + 8, 20).fill({ color: 0xffffff, alpha: 0.001 });
    g.moveTo(10, 40).lineTo(20, 50).lineTo(30, 40).closePath().fill(0xffffff);
  },
};

// ─────────────────────────────────────────── 结果抽取

function texDesc(t: any, lib: Lib): unknown {
  if (!t) return null;
  if (t === lib.WHITE) return 'WHITE';
  if (t === lib.tex) return 'tex';
  if (t === lib.frameTex) return 'frameTex';
  return {
    source: [t.source.width, t.source.height, t.source.style.addressModeU, t.source.style.addressModeV],
    frame: [t.frame.x, t.frame.y, t.frame.width, t.frame.height],
  };
}

function matDesc(m: any): unknown {
  return m ? [m.a, m.b, m.c, m.d, m.tx, m.ty] : null;
}

function styleDesc(s: any, lib: Lib): unknown {
  if (!s) return s;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) {
    const v = s[k];
    if (k === 'texture') out[k] = texDesc(v, lib);
    else if (k === 'matrix') out[k] = matDesc(v);
    else if (k === 'fill') out[k] = v ? (v instanceof lib.FillGradient ? `gradient:${v.type}` : 'pattern') : null;
    else out[k] = v;
  }
  return out;
}

function geometry(ctx: any, lib: Lib): any {
  let data: any;
  if (lib.name === 'pixi') {
    data = new PIXI.GpuGraphicsContext();
    PIXI.buildContextBatches(ctx, data);
    data.isBatchable = data.geometryData.vertices.length < 400;
  } else {
    data = GraphicsContextSystem.updateGpuContext(ctx);
  }
  return {
    vertices: data.geometryData.vertices.slice(),
    uvs: data.geometryData.uvs.slice(),
    indices: data.geometryData.indices.slice(),
    isBatchable: data.isBatchable,
    batches: data.batches.map((b: any) => ({
      indexOffset: b.indexOffset,
      indexSize: b.indexSize,
      attributeOffset: b.attributeOffset,
      attributeSize: b.attributeSize,
      baseColor: b.baseColor,
      alpha: b.alpha,
      topology: b.topology,
      texture: texDesc(b.texture, lib),
      color: b.color,
    })),
  };
}

function instructionsDesc(ctx: any, lib: Lib): unknown {
  return ctx.instructions.map((ins: any) => ({
    action: ins.action,
    style: ins.action === 'texture'
      ? { ...ins.data, image: texDesc(ins.data.image, lib), transform: matDesc(ins.data.transform) }
      : styleDesc(ins.data.style, lib),
    hole: !!ins.data.hole,
  }));
}

function boundsDesc(b: any): number[] {
  return [b.minX, b.minY, b.maxX, b.maxY];
}

function hitGrid(ctx: any, b: number[]): boolean[] {
  const out: boolean[] = [];
  const [x0, y0, x1, y1] = b;
  const pad = 6;
  const steps = 41;
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const x = x0 - pad + ((x1 - x0 + pad * 2) * i) / steps;
      const y = y0 - pad + ((y1 - y0 + pad * 2) * j) / steps;
      out.push(ctx.containsPoint({ x, y }));
    }
  }
  return out;
}

function run(scenario: Scenario): { pixi: any; e2d: any } {
  const libs = makeLibs();
  const pctx = new PIXI.GraphicsContext();
  const ectx = new GraphicsContext();
  pixiLog.length = 0;
  e2dLog.length = 0;
  scenario(pctx, libs.pixi);
  scenario(ectx, libs.e2d);
  const pGeom = geometry(pctx, libs.pixi);
  const eGeom = geometry(ectx, libs.e2d);
  const pBounds = boundsDesc(pctx.bounds);
  const eBounds = boundsDesc(ectx.bounds);
  return {
    pixi: {
      geom: pGeom,
      instructions: instructionsDesc(pctx, libs.pixi),
      bounds: pBounds,
      hits: hitGrid(pctx, pBounds),
      canvasLog: pixiLog.slice(),
      sourceStyles: [libs.pixi.tex, libs.pixi.frameTex].map((t) => [t.source.style.addressModeU, t.source.style.addressModeV]),
    },
    e2d: {
      geom: eGeom,
      instructions: instructionsDesc(ectx, libs.e2d),
      bounds: eBounds,
      hits: hitGrid(ectx, eBounds),
      canvasLog: e2dLog.slice(),
      sourceStyles: [libs.e2d.tex, libs.e2d.frameTex].map((t) => [t.source.style.addressModeU, t.source.style.addressModeV]),
    },
  };
}

describe('GraphicsContext 与 Pixi v8.17 逐数对照', () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(name, () => {
      const { pixi, e2d } = run(scenario);
      expect(e2d.instructions).toEqual(pixi.instructions);
      expect(e2d.geom.vertices).toEqual(pixi.geom.vertices);
      expect(e2d.geom.uvs).toEqual(pixi.geom.uvs);
      expect(e2d.geom.indices).toEqual(pixi.geom.indices);
      expect(e2d.geom.batches).toEqual(pixi.geom.batches);
      expect(e2d.geom.isBatchable).toBe(pixi.geom.isBatchable);
      expect(e2d.bounds).toEqual(pixi.bounds);
      expect(e2d.hits).toEqual(pixi.hits);
      expect(e2d.canvasLog).toEqual(pixi.canvasLog);
      expect(e2d.sourceStyles).toEqual(pixi.sourceStyles);
      // 场景确实画出了东西(半径 0 的圆按 Pixi 规则什么都不出)
      if (name !== 'circle 半径 0') expect(pixi.geom.batches.length).toBeGreaterThan(0);
    });
  }
});

describe('GraphicsContext 行为', () => {
  it('脏标记:改指令才重建几何;clear 后几何清空', () => {
    const ctx = new GraphicsContext();
    ctx.rect(0, 0, 10, 10).fill(0xff0000);
    const a = GraphicsContextSystem.updateGpuContext(ctx);
    expect(ctx.dirty).toBe(false);
    const verts = a.geometryData.vertices;
    expect(verts.length).toBe(8);
    expect(GraphicsContextSystem.updateGpuContext(ctx)).toBe(a);
    ctx.clear();
    expect(ctx.dirty).toBe(true);
    const b = GraphicsContextSystem.updateGpuContext(ctx);
    expect(b.geometryData.vertices.length).toBe(0);
    expect(b.batches.length).toBe(0);
    expect(boundsDesc(ctx.bounds)).toEqual([0, 0, 0, 0]);
  });

  it('batchMode:auto 按 200 顶点分界,batch / no-batch 强制', () => {
    const ctx = new GraphicsContext();
    ctx.circle(0, 0, 300).fill(0xffffff);
    expect(GraphicsContextSystem.updateGpuContext(ctx).isBatchable).toBe(false);
    ctx.batchMode = 'batch';
    ctx.dirty = true;
    expect(GraphicsContextSystem.updateGpuContext(ctx).isBatchable).toBe(true);
    const small = new GraphicsContext();
    small.rect(0, 0, 1, 1).fill(0);
    small.batchMode = 'no-batch';
    expect(GraphicsContextSystem.updateGpuContext(small).isBatchable).toBe(false);
  });

  it('update 事件、clone、destroy', () => {
    const ctx = new GraphicsContext();
    let n = 0;
    ctx.on('update', () => n++);
    ctx.rect(0, 0, 5, 5).fill(0xffffff).stroke({ width: 2, color: 0 });
    expect(n).toBe(2);
    const c = ctx.clone();
    expect(c.instructions.length).toBe(2);
    expect(boundsDesc(c.bounds)).toEqual(boundsDesc(ctx.bounds));
    let destroyed = 0;
    ctx.on('destroy', () => destroyed++);
    ctx.destroy();
    expect(ctx.destroyed).toBe(true);
    expect(destroyed).toBe(1);
    ctx.destroy();
    expect(destroyed).toBe(1);
  });

  it('destroy({ texture: true }) 连带销毁纹理 / 渐变', () => {
    const tex = new Texture({ source: new TextureSource({ width: 4, height: 4 }) });
    const ctx = new GraphicsContext();
    ctx.rect(0, 0, 4, 4).fill({ texture: tex });
    ctx.destroy({ texture: true });
    expect(tex.destroyed).toBe(true);
    const grad = new FillGradient({ type: 'linear', colorStops: [{ offset: 0, color: 0 }, { offset: 1, color: 0xffffff }] });
    const ctx2 = new GraphicsContext();
    ctx2.rect(0, 0, 4, 4).fill(grad);
    const gradTex = grad.texture;
    ctx2.destroy(true);
    expect(gradTex.destroyed).toBe(true);
    expect(grad.texture).toBeNull();
  });

  it('svg / SVG 路径字符串:未移植,明确报错', () => {
    expect(() => new GraphicsContext().svg('<svg/>')).toThrow();
    expect(() => new GraphicsPath('M0 0 L10 10')).toThrow();
  });
});
