import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Rectangle, Texture, TextureSource } from '../engine2d';
import { bodyFootprintOf, footprintOf, medianFootprint, mirrorFootprint, scanFootprint } from './footprintExtent';
import { SpriteEntity } from './SpriteEntity';

/** 造一条 w×h 的 RGBA 像素，给定的 [x0,x1) × [y0,y1) 矩形不透明。 */
function strip(w: number, h: number, boxes: [number, number, number, number][]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const [x0, x1, y0, y1] of boxes) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d[(y * w + x) * 4 + 3] = 255;
  }
  return d;
}

describe('scanFootprint：剪影贴地那一截的左右范围', () => {
  it('两只脚贴着帧底：范围从左脚左沿到右脚右沿（两脚之间的空隙算在里面）', () => {
    const d = strip(100, 40, [[30, 40, 30, 40], [55, 68, 32, 40]]);
    expect(scanFootprint(d, 100, 40, 6)).toEqual({ lo: 0.3, hi: 0.68 });
  });

  it('脚离帧底有透明边：从最低的不透明行往上找，照样找得到（帧底 ≠ 脚底）', () => {
    const d = strip(100, 40, [[40, 60, 20, 28]]);          // 最低行 27，帧底 39
    expect(scanFootprint(d, 100, 40, 4)).toEqual({ lo: 0.4, hi: 0.6 });
  });

  it('只取最低那一截：上面更宽的身体不算', () => {
    const d = strip(100, 40, [[10, 90, 0, 20], [45, 55, 20, 40]]);   // 宽身子在上，窄腿在下
    expect(scanFootprint(d, 100, 40, 6)).toEqual({ lo: 0.45, hi: 0.55 });
  });

  it('整条都透明：null（这一帧底部没东西挨地，不画接触阴影）', () => {
    expect(scanFootprint(strip(50, 20, []), 50, 20, 4)).toBeNull();
  });

  it('半透明（低于阈值）不算贴地', () => {
    const d = strip(50, 10, []);
    for (let x = 0; x < 50; x++) d[(9 * 50 + x) * 4 + 3] = 100;
    expect(scanFootprint(d, 50, 10, 3)).toBeNull();
  });
});

describe('mirrorFootprint：显示朝向与图集相反时关于帧中线翻', () => {
  it('镜像', () => {
    expect(mirrorFootprint({ lo: 0.2, hi: 0.5 }, true)).toEqual({ lo: 0.5, hi: 0.8 });
  });
  it('不镜像原样', () => {
    const fp = { lo: 0.2, hi: 0.5 };
    expect(mirrorFootprint(fp, false)).toBe(fp);
  });
});

describe('medianFootprint：身体胶囊按站立片段定一份，不跟每帧步幅变', () => {
  it('中心、半宽各取中位数：偶尔挪一下脚的那一帧不带偏', () => {
    const fp = medianFootprint([
      { lo: 0.4, hi: 0.6 }, { lo: 0.4, hi: 0.6 }, { lo: 0.1, hi: 0.9 }, { lo: 0.42, hi: 0.62 },
    ])!;
    // 中心 0.5 / 0.5 / 0.5 / 0.52 → 0.5；半宽 0.1 / 0.1 / 0.4 / 0.1 → 0.1
    expect(fp.lo).toBeCloseTo(0.4, 10);
    expect(fp.hi).toBeCloseTo(0.6, 10);
  });

  it('偶数帧取中间两个的平均', () => {
    const fp = medianFootprint([{ lo: 0.4, hi: 0.6 }, { lo: 0.5, hi: 0.9 }])!;
    expect((fp.lo + fp.hi) / 2).toBeCloseTo(0.6, 10);   // 中心 0.5、0.7
    expect((fp.hi - fp.lo) / 2).toBeCloseTo(0.15, 10);  // 半宽 0.1、0.2
  });

  it('挨不着地的帧不参与；全都挨不着地 ⇒ null', () => {
    const one = medianFootprint([null, { lo: 0.3, hi: 0.5 }, null])!;
    expect(one.lo).toBeCloseTo(0.3, 10);
    expect(one.hi).toBeCloseTo(0.5, 10);
    expect(medianFootprint([null, null])).toBeNull();
    expect(medianFootprint([])).toBeNull();
  });

  it('有帧读不到像素 ⇒ undefined（调用方不缓存、退回按当前帧）', () => {
    expect(medianFootprint([{ lo: 0.3, hi: 0.5 }, undefined])).toBeUndefined();
  });
});

// ───────────────────────────── bodyFootprintOf:engine2d 纹理走同一条像素回读(footprintOf)
//
// 游戏里图集源的 resource 是 Assets 解出来的 ImageBitmap(engine2d 的 unload 只放 GPU 侧,CPU 侧留着),
// footprintOf 把帧底那条画进 2D 画布再 getImageData。node 环境没有这两样:这里用假的 ImageBitmap +
// 假画布(drawImage 记下源矩形、getImageData 从合成图集的 alpha 平面切那一块)把整条链跑通。

class FakeBitmap {
  constructor(readonly width: number, readonly height: number, readonly alpha: Uint8Array) {}
}

let draws = 0;

function installFakeCanvas(): void {
  let last: { img: FakeBitmap; sx: number; sy: number } | null = null;
  const canvas: { width: number; height: number; getContext: () => unknown } = { width: 0, height: 0, getContext: () => ctx };
  const ctx = {
    canvas,
    clearRect(): void {},
    drawImage(img: FakeBitmap, sx: number, sy: number): void {
      draws++;
      last = { img, sx, sy };
    },
    getImageData(_x: number, _y: number, w: number, h: number): { data: Uint8ClampedArray } {
      const data = new Uint8ClampedArray(w * h * 4);
      const l = last;
      if (l) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const ix = l.sx + x;
            const iy = l.sy + y;
            if (ix < l.img.width && iy < l.img.height) data[(y * w + x) * 4 + 3] = l.img.alpha[iy * l.img.width + ix];
          }
        }
      }
      return { data };
    },
  };
  vi.stubGlobal('ImageBitmap', FakeBitmap);
  vi.stubGlobal('document', { createElement: () => canvas });
}

const CELL_W = 20;
const CELL_H = 40;
const BAND = 0.12;
const SEARCH = 0.35;

/** 一行 n 格的图集:第 i 格帧底 4 行在 [x0, x1) 列不透明(站立片段的脚)。 */
function atlasBitmap(feet: Array<[number, number]>): FakeBitmap {
  const w = CELL_W * feet.length;
  const alpha = new Uint8Array(w * CELL_H);
  feet.forEach(([x0, x1], i) => {
    for (let y = CELL_H - 4; y < CELL_H; y++) for (let x = x0; x < x1; x++) alpha[y * w + i * CELL_W + x] = 255;
  });
  return new FakeBitmap(w, CELL_H, alpha);
}

function framesOf(source: TextureSource, n: number): Texture[] {
  return Array.from({ length: n }, (_, i) => new Texture({ source, frame: new Rectangle(i * CELL_W, 0, CELL_W, CELL_H) }));
}

describe('bodyFootprintOf：站立片段逐帧量、取中位数，按帧组缓存（engine2d 纹理）', () => {
  beforeAll(installFakeCanvas);
  afterAll(() => { vi.unstubAllGlobals(); });

  it('中位数：中心、半宽各取中位（一帧挪脚不带偏），同一个帧组第二次不再读像素', () => {
    // 半宽 4 / 6 / 2 px（÷20 = 0.2 / 0.3 / 0.1），中心都在 10 px ⇒ 中位 {0.3, 0.7}
    const bmp = atlasBitmap([[6, 14], [4, 16], [8, 12]]);
    const source = new TextureSource({ resource: bmp, width: bmp.width, height: bmp.height });
    const frames = framesOf(source, 3);
    const before = draws;
    const fp = bodyFootprintOf(frames, BAND, SEARCH)!;
    expect(draws - before).toBe(3);
    expect(fp.lo).toBeCloseTo(0.3, 10);
    expect(fp.hi).toBeCloseTo(0.7, 10);
    // 与逐帧 footprintOf 的中位数同值
    expect(medianFootprint(frames.map((t) => footprintOf(t, BAND, SEARCH)))).toEqual(fp);
    const again = draws;
    expect(bodyFootprintOf(frames, BAND, SEARCH)).toBe(fp);
    expect(draws).toBe(again);
  });

  it('空帧组 / 全都挨不着地 ⇒ null（调用方退回按当前帧）；后者是确定结果，也缓存', () => {
    expect(bodyFootprintOf([], BAND, SEARCH)).toBeNull();
    const bmp = new FakeBitmap(CELL_W * 2, CELL_H, new Uint8Array(CELL_W * 2 * CELL_H));
    const frames = framesOf(new TextureSource({ resource: bmp, width: bmp.width, height: bmp.height }), 2);
    expect(bodyFootprintOf(frames, BAND, SEARCH)).toBeNull();
    const n = draws;
    expect(bodyFootprintOf(frames, BAND, SEARCH)).toBeNull();
    expect(draws).toBe(n);
  });

  it('图集像素还没到（占位源没有 resource）⇒ null 且不缓存；资源到了同一个帧组就量得出', () => {
    const source = new TextureSource({ width: CELL_W * 2, height: CELL_H });
    const frames = framesOf(source, 2);
    expect(bodyFootprintOf(frames, BAND, SEARCH)).toBeNull();
    const bmp = atlasBitmap([[5, 15], [5, 15]]);
    source.resource = bmp as unknown as typeof source.resource;
    const fp = bodyFootprintOf(frames, BAND, SEARCH)!;
    expect(fp.lo).toBeCloseTo(0.25, 10);
    expect(fp.hi).toBeCloseTo(0.75, 10);
  });

  it('SpriteEntity.getBodyReferenceFrames 给的（按站立偏移裁底的）帧照样量得出，且按角色固定', () => {
    // 两格：idle（格 0，脚 [6,14)）、run（格 1，脚 [0,20) 步幅大）
    const bmp = atlasBitmap([[6, 14], [0, 20]]);
    const e = new SpriteEntity();
    e.loadFromDef(new Texture({ source: new TextureSource({ resource: bmp, width: bmp.width, height: bmp.height }) }), {
      spritesheet: 'x.png', cols: 2, rows: 1, cellWidth: CELL_W, cellHeight: CELL_H, worldWidth: 100, worldHeight: 150,
      states: {
        idle: { frames: [0], frameRate: 8, loop: true, footOffset: 0.05 },
        run: { frames: [1], frameRate: 8, loop: true },
      },
    });
    e.playAnimation('run');
    const refs = e.getBodyReferenceFrames();
    expect(refs).toHaveLength(1);
    expect(refs[0].frame.height).toBeCloseTo(CELL_H * 0.95, 6);   // 裁掉脚底线以下那截
    const fp = bodyFootprintOf(refs, BAND, SEARCH)!;
    expect(fp.lo).toBeCloseTo(0.3, 10);                         // 站立那一格的脚，不是跑步那一格的步幅
    expect(fp.hi).toBeCloseTo(0.7, 10);
  });
});
