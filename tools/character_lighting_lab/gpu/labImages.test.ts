/**
 * 实验室纯工具视图的逐像素图(CPU)与 3D 几何:式子与迁移前 app.js 里的 BG_FS / THUMB_FS / HDR_RECOVER / MESH_FS 逐项对账,
 * 取样位置照 GL LINEAR(像素中心双线性),以及 3D 调试件要的几何(按层拆网格的 uv、经纬球、预览亮度倍率)。
 */
import { describe, expect, it } from 'vitest';
import {
  bgViewPixels, hdrRad, heat, latLongSphere, lin2srgb, meshLayers, previewTint, ramp, srgb2lin, thumbPixels, tintGround, zone,
  type Rgba,
} from './labImages';
import { contactShadowPixels, displayForGain } from './charLabView';

const P = { method: 0, maxGain: 3, pa: 0.7 };

function img(w: number, h: number, f: (x: number, y: number) => number[]): Rgba {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = f(x, y);
    d.set([c[0], c[1], c[2], c[3] ?? 255], (y * w + x) * 4);
  }
  return { width: w, height: h, data: d };
}

describe('色带 / 分层 / 热力(旧 GLSL 同式,含 int() 截断的端点)', () => {
  it('ramp 端点与段内插值;t=1 落回 s3(GLSL i=4 走最后一支、f=0)', () => {
    expect(ramp(0)).toEqual([0.06, 0.06, 0.24]);
    expect(ramp(0.125).map((v) => +v.toFixed(4))).toEqual([0.11, 0.205, 0.51]);
    expect(ramp(1)).toEqual([0.9, 0.86, 0.16]);
    expect(ramp(0.99).map((v) => +v.toFixed(2))).toEqual([0.86, 0.19, 0.12]);
  });
  it('heat:t=1 落回 s2', () => {
    expect(heat(0)).toEqual([0.03, 0.03, 0.08]);
    expect(heat(1)).toEqual([0.95, 0.35, 0.05]);
  });
  it('zone:≥6EV 洋红撞顶、层界压黑、层中不压', () => {
    const top = zone(7);
    expect(top[0]).toBeCloseTo(1 * 0.12, 5);                 // ev=6 钳位后 fract=0 → 层界
    const mid = zone(-2.5);                                   // 层中
    expect(mid).toEqual(ramp((-2.5 + 8) / 14));
    const edge = zone(-3);
    expect(edge[2]).toBeCloseTo(ramp(5 / 14)[2] * 0.12, 6);
  });
});

describe('HDR 恢复四种方法(旧 HDR_RECOVER::hdrRad)', () => {
  const base = [0.2, 0.4, 0.1];
  const L = 0.2 * 0.2126 + 0.4 * 0.7152 + 0.1 * 0.0722;
  it('0 emitter 门:base·2^(g·maxEV)', () => {
    expect(hdrRad(base, 0.5, { ...P, method: 0 })).toEqual(base.map((v) => v * Math.pow(2, 1.5)));
  });
  it('1 逆 Reinhard:base / max(1 − k·L, .015)', () => {
    const r = hdrRad(base, 0, { ...P, method: 1, pa: 0.7 });
    r.forEach((v, i) => expect(v).toBeCloseTo(base[i] / (1 - 0.7 * L), 12));
  });
  it('2 全局 gamma:base^mix(1,.34,pa) · 2^(maxEV·.12)', () => {
    const r = hdrRad(base, 0, { ...P, method: 2, pa: 0.5 });
    r.forEach((v, i) => expect(v).toBeCloseTo(Math.pow(base[i], 0.67) * Math.pow(2, 0.36), 12));
  });
  it('3 亮度扩展:低于门槛不提、高于上沿提满', () => {
    expect(hdrRad(base, 0, { ...P, method: 3, pa: 0.9 })).toEqual(base);
    const r = hdrRad([1, 1, 1], 0, { ...P, method: 3, pa: 0.1 });
    r.forEach((v) => expect(v).toBeCloseTo(Math.pow(2, 3), 12));
  });
});

describe('背景视图(旧 BG_FS 逐像素;取样 = GL LINEAR 像素中心)', () => {
  const bg = img(4, 2, (x, y) => [x * 60, y * 200, 30]);
  const gain = img(2, 1, (x) => [x * 255, 0, 0]);
  it('原画 × 预览亮度 1 = 原图(同尺寸不重采样)', () => {
    const o = bgViewPixels({ ...P, mode: 0, width: 4, height: 2, bg, gain, pgain: 1 });
    for (let i = 0; i < o.data.length; i += 4) {
      expect(Math.abs(o.data[i] - bg.data[i])).toBeLessThanOrEqual(1);
      expect(Math.abs(o.data[i + 1] - bg.data[i + 1])).toBeLessThanOrEqual(1);
    }
  });
  it('2× 缩小 = 每 2×2 的平均(像素中心双线性正好落在四格中点)', () => {
    const o = bgViewPixels({ ...P, mode: 0, width: 2, height: 1, bg, gain, pgain: 1 });
    expect(o.data[0]).toBe(Math.round(lin2srgb(srgb2lin(((0 + 60) / 2) / 255)) * 255));
    expect(o.data[1]).toBe(Math.round(lin2srgb(srgb2lin(100 / 255)) * 255));
  });
  it('HDR 恢复辐射:lin2srgb(hdrRad(srgb2lin(c), gain) × 预览亮度)', () => {
    const o = bgViewPixels({ ...P, mode: 1, width: 4, height: 2, bg, gain, pgain: 0.5 });
    // (x=3, y=1) 取 gain 在 u=7/8:源 2 列,fx=0.5·2·... = (3.5·0.5−0.5)=1.25 → 钳 1 → 255
    const c = [180 / 255, 200 / 255, 30 / 255].map(srgb2lin);
    const want = hdrRad(c, 1, P).map((v) => Math.round(Math.min(1, lin2srgb(v * 0.5)) * 255));
    expect(Array.from(o.data.slice((1 * 4 + 3) * 4, (1 * 4 + 3) * 4 + 3))).toEqual(want);
  });
  it('标定深度:按 work 分辨率逐格出图(最近邻放大交给精灵),ramp(fract(d·.35))', () => {
    const depth = { data: new Float32Array([0, 1, 2, -1]), w: 2, h: 2 };
    const o = bgViewPixels({ ...P, mode: 3, width: 99, height: 99, bg, gain, depth, pgain: 1 });
    expect([o.width, o.height]).toEqual([2, 2]);
    const r = ramp(0.35);
    expect(Math.abs(o.data[4] - Math.round(lin2srgb(srgb2lin(r[0])) * 255))).toBeLessThanOrEqual(1);
  });
});

describe('底部三张缩略图', () => {
  it('尺寸、提升场全黑(没提升)、光源图无 mask 时退回提升量热力', () => {
    const bg = img(8, 4, () => [100, 100, 100]);
    const gain = img(8, 4, () => [0, 0, 0]);
    const [hdr, lights, lift] = thumbPixels({ ...P, width: 8, height: 4, bg, gain, mask: null });
    expect([hdr.width, hdr.height]).toEqual([8, 4]);
    const black = heat(0).map((v) => Math.round(v * 255));
    expect(Array.from(lift.data.slice(0, 3))).toEqual(black);
    expect(Array.from(lights.data.slice(0, 3))).toEqual(black);
    expect(hdr.data[3]).toBe(255);
  });
});

describe('3D 几何', () => {
  it('网格按层拆开、uv = 世界 → q → 画面 / work,混层三角形计数', () => {
    const c = Math.SQRT1_2;
    const M = [[1, 0, 0], [0, c, -c], [0, -c, -c]];
    const buf = new ArrayBuffer(16 * 4);
    const f = new Float32Array(buf), u = new Uint8Array(buf);
    const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    pts.forEach((p, i) => { f.set(p, i * 4); u[i * 16 + 15] = i === 3 ? 2 : 0; });
    const idx = new Uint32Array([0, 1, 2, 1, 2, 3]).buffer;
    const cal = { ppu: 10, cx: 20, cy: 15 };
    const r = meshLayers(buf, idx, M, cal, { w: 40, h: 30 });
    expect(Array.from(r.layers[0].indices)).toEqual([0, 1, 2, 1, 2, 3]);   // 第二个三角形首顶点 tag 0
    expect(r.layers[2].indices.length).toBe(0);
    expect(r.mixed).toBe(1);
    const v = r.layers[0].vertices;
    // 点 (0,1,0):q = Mᵀ·X = (0, c, -c) → 画面 (20, 15 − 10c) / work
    expect(v[2 * 5 + 3]).toBeCloseTo(0.5, 6);
    expect(v[2 * 5 + 4]).toBeCloseTo((15 - 10 * c) / 30, 6);
  });
  it('经纬球:uv (0.5, 0.5) 朝 −z、v=0 朝上', () => {
    const s = latLongSphere(2, 4, 2);
    const at = (i: number) => Array.from(s.vertices.slice(i * 5, i * 5 + 5));
    const mid = at(1 * 5 + 2);                   // j=1(v=.5) i=2(u=.5)
    expect(mid[0]).toBeCloseTo(0, 6); expect(mid[1]).toBeCloseTo(0, 6); expect(mid[2]).toBeCloseTo(-2, 6);
    expect(at(0)[1]).toBeCloseTo(2, 6);
  });
  it('预览亮度在 sRGB 里是乘法:pow(pow(c,2.2)·g, 1/2.2) = c · g^(1/2.2)', () => {
    for (const c of [0.1, 0.5, 0.9]) expect(Math.pow(Math.pow(c, 2.2) * 3, 1 / 2.2)).toBeCloseTo(c * previewTint(3), 12);
  });
  it('地面延拓贴图 = mix(c, (.2,.5,.3), .3)', () => {
    const t = tintGround(img(1, 1, () => [100, 200, 50]));
    expect(Array.from(t.data.slice(0, 3))).toEqual([Math.round((100 / 255 * 0.7 + 0.06) * 255), Math.round((200 / 255 * 0.7 + 0.15) * 255), Math.round((50 / 255 * 0.7 + 0.09) * 255)]);
  });
});

describe('2D 场景视图的两件小东西', () => {
  it('接触阴影剖面:中心不透明、半径外全透明、smoothstep(.25,1) 过渡', () => {
    const px = contactShadowPixels(64);
    expect(px[(32 * 64 + 32) * 4 + 3]).toBe(255);
    expect(px[(0 * 64 + 0) * 4 + 3]).toBe(0);
  });
  it('预览亮度 = 显示 EV(其余恒等)', () => {
    expect(displayForGain(1)).toMatchObject({ ev: 0, tonemap: 'none', saturation: 1, contrast: 1, lift: 0 });
    expect(displayForGain(4).ev).toBe(2);
  });
});
