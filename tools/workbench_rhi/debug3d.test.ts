/**
 * 3D 调试件（`debug3d.ts` + `debug3d.wgsl`）的无 GPU 单测：几何 / 矩阵纯函数 + 空后端（`NullRhiDevice`）上的命令流。
 *
 * - 矩阵：GL 裁剪约定 → WebGPU 约定只改 z（x / y / w 与页面拾取用的同一个矩阵逐位相同），近平面 → 0、远平面 → 1；
 * - 命令流：一帧 = 一个多重采样 + 深度的画布 pass（清屏色 / 深度 1），每次 draw 的管线状态（拓扑 / 深度 / 混合 / 采样数）、
 *   统一数据（矩阵 / 颜色 / 点径线宽 × 像素比 / 目标尺寸）、顶点流与 draw 参数都对；同样输入两台设备记出同一串，差一点就不同；
 * - 着色器：同一份 WGSL 的每个入口都能被 RHI 的布局扫描器推出（空后端与 luma 同一个扫描器），绑定名字都给全；
 * - 设备丢失恢复后从 CPU 源重建（网格 / 贴图 / 管线）。
 * 真 GPU 的像素断言在各工作台的自检（Chrome）里。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiRenderPipelineDesc } from '../../src/rendering/rhi';
import { traceRhi } from './rhiTrace';
import { DEBUG3D_WGSL, Debug3DView, glToWebGpuClip, projectToCss, raycastMesh, stripToList, type Debug3DDraw } from './debug3d';

/** common.js 同款：GL 约定透视 / 正交 + 左手 lookAt（列主序） */
function perspectiveGl(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}
function orthoGl(h: number, aspect: number, near: number, far: number): number[] {
  const w = h * aspect;
  return [1 / w, 0, 0, 0, 0, 1 / h, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1];
}
function mul4(a: number[], b: number[]): number[] {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function lookAtLH(eye: number[], at: number[]): number[] {
  const z = [eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]];
  const zl = Math.hypot(...z);
  for (let i = 0; i < 3; i++) z[i] /= zl;
  const up = [0, 1, 0];
  const x = [z[1] * up[2] - z[2] * up[1], z[2] * up[0] - z[0] * up[2], z[0] * up[1] - z[1] * up[0]];   // x = z × up（左手）
  const xl = Math.hypot(...x);
  for (let i = 0; i < 3; i++) x[i] /= xl;
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const d = (v: number[]) => -(v[0] * eye[0] + v[1] * eye[1] + v[2] * eye[2]);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, d(x), d(y), d(z), 1];
}
function clipOf(m: ArrayLike<number>, p: number[]): number[] {
  return [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

const VP_PERSP = mul4(perspectiveGl(55 * Math.PI / 180, 16 / 9, 25, 60000), lookAtLH([300, 900, -2400], [0, 0, 0]));

describe('glToWebGpuClip', () => {
  it('只改 z：x / y / w 与原矩阵逐位相同，z\' = (z + w) / 2', () => {
    const m = glToWebGpuClip(VP_PERSP);
    for (const p of [[0, 0, 0], [120, 40, 900], [-500, 300, 2000], [10, -5, -100]]) {
      const a = clipOf(VP_PERSP, p), b = clipOf(m, p);
      expect(b[0]).toBeCloseTo(a[0], 3);
      expect(b[1]).toBeCloseTo(a[1], 3);
      expect(b[3]).toBeCloseTo(a[3], 3);
      expect(b[2]).toBeCloseTo((a[2] + a[3]) / 2, 2);
    }
    for (const i of [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15]) expect(m[i]).toBe(Math.fround(VP_PERSP[i]));
  });
  it('透视：近平面深度 0、远平面 1；正交（near 取负）同样落在 [0, 1]', () => {
    const P = glToWebGpuClip(perspectiveGl(1, 1, 10, 1000));
    const near = clipOf(P, [0, 0, -10]), far = clipOf(P, [0, 0, -1000]);
    expect(near[2] / near[3]).toBeCloseTo(0, 5);
    expect(far[2] / far[3]).toBeCloseTo(1, 5);
    const O = glToWebGpuClip(orthoGl(500, 1, -3000, 3000));
    expect(clipOf(O, [0, 0, 3000])[2]).toBeCloseTo(0, 5);   // 机位背后也画（z = -near）
    expect(clipOf(O, [0, 0, -3000])[2]).toBeCloseTo(1, 5);
  });
});

describe('projectToCss / stripToList', () => {
  it('投影：屏幕中心 = 视线上的点；相机背后 = null；左手：+X 在画面右', () => {
    const m = glToWebGpuClip(VP_PERSP);
    const c = projectToCss(m, [0, 0, 0], 1600, 900)!;
    expect(c[0]).toBeCloseTo(800, 3);
    expect(c[1]).toBeCloseTo(450, 3);
    expect(c[2]).toBeGreaterThan(0);
    expect(c[2]).toBeLessThan(1);
    const r = projectToCss(m, [100, 0, 0], 1600, 900)!;
    expect(r[0]).toBeGreaterThan(c[0]);
    expect(projectToCss(m, [600, 1800, -4800], 1600, 900)).toBeNull();
  });
  it('折线 → 线段表', () => {
    expect([...stripToList([0, 0, 0, 1, 0, 0, 1, 1, 0])]).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
    expect(stripToList([1, 2, 3]).length).toBe(0);
  });
  it('射线打网格：最近的正向命中、双面、打不到 = null、方向不必单位化', () => {
    // 两块平行的方片：z = 100（索引）与 z = 50（索引）；位置 + uv 交错（stride 5）
    const v = new Float32Array([
      -10, -10, 100, 0, 0, 10, -10, 100, 1, 0, 10, 10, 100, 1, 1, -10, 10, 100, 0, 1,
      -10, -10, 50, 0, 0, 10, -10, 50, 1, 0, 10, 10, 50, 1, 1, -10, 10, 50, 0, 1,
    ]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const h = raycastMesh(v, 5, idx, [1, 2, 0], [0, 0, 1])!;
    expect(h.t).toBeCloseTo(50, 6);
    expect(h.point).toEqual([1, 2, 50]);
    expect(h.tri).toBeGreaterThanOrEqual(2);
    expect(raycastMesh(v, 5, idx, [1, 2, 200], [0, 0, -1])!.t).toBeCloseTo(100, 6);   // 背面也算（双面）
    expect(raycastMesh(v, 5, idx, [1, 2, 0], [0, 0, 2])!.t).toBeCloseTo(25, 6);
    expect(raycastMesh(v, 5, idx, [50, 2, 0], [0, 0, 1])).toBeNull();
    expect(raycastMesh(v, 5, idx, [1, 2, 300], [0, 0, 1])).toBeNull();                  // 在身后不算
    expect(raycastMesh(new Float32Array([0, 0, 5, 1, 0, 5, 0, 1, 5]), 3, null, [0.2, 0.2, 0], [0, 0, 1])!.t).toBeCloseTo(5, 6);
  });
});

// ───────────────────────────── 空后端上的命令流

function fakeImage(w: number, h: number, seed: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + seed * 11) & 255;
  return { width: w, height: h, data, colorSpace: 'srgb' } as unknown as ImageData;
}

/** 一帧里把每种画法都用一遍（四台 view3d 的实际组合：网格 + 网格线 + 线框 + 贴地折线 + 标记 + 碰撞格 + 面 + 公告板） */
function scene(g: Debug3DView) {
  const mesh = g.createMesh({
    vertices: new Float32Array([-500, 0, 0, 0, 1, 500, 0, 0, 1, 1, 500, 400, 800, 1, 0, -500, 400, 800, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    label: '场景网格',
  });
  const tex = g.createTexture(fakeImage(4, 2, 1), '背景');
  const cells = g.createMesh({ positions: new Float32Array([0, 1, 0, 10, 1, 0, 10, 1, 10, 0, 1, 0, 10, 1, 10, 0, 1, 10]), label: '碰撞格' });
  cells.setColors(new Float32Array([1, 0, 0, 0.3, 1, 0, 0, 0.3, 1, 0, 0, 0.3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]));
  const ghost = g.createTexture(fakeImage(2, 2, 9), '幽灵');
  const draw = (d: Debug3DDraw) => {
    d.mesh(mesh, { texture: tex, tint: [0.45, 0.45, 0.45, 1] });
    d.mesh(cells, { depth: 'test' });
    d.lines([0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 100], { color: [1, 1, 1, 0.09] });
    d.lines([0, 5, 0, 50, 5, 20, 90, 5, 0], { color: [0.42, 0.7, 1, 1], strip: true, width: 2, depth: 'off' });
    d.points([10, 20, 30, 40, 50, 60], { color: [1, 0.7, 0.33, 1], size: 9, depth: 'off' });
    d.triangles([0, 0, 0, 10, 0, 0, 10, 10, 0], { color: [0.35, 0.85, 0.9, 0.28], depth: 'test' });
    d.quad([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { texture: ghost, color: [1, 1, 1, 0.5], depth: 'off' });
  };
  return { mesh, tex, cells, ghost, draw };
}

function setup(swap: [number, number] = [320, 180]) {
  const dev = new NullRhiDevice({ swapchainSize: swap });
  const pipes: RhiRenderPipelineDesc[] = [];
  const orig = dev.createRenderPipeline.bind(dev);
  dev.createRenderPipeline = (scope, desc) => {
    pipes.push(desc);
    return orig(scope, desc);
  };
  const trace = traceRhi(dev);
  const g = new Debug3DView(dev, null, { background: [0.075, 0.085, 0.105], size: swap });
  return { dev, trace, g, pipes };
}

describe('Debug3DView · 空后端命令流', () => {
  it('每种画法都录得出来：一个带深度的 4× MSAA 画布 pass，清屏色 + 深度 1，draw 次数 / 参数对', () => {
    const { dev, trace, g } = setup();
    const { draw } = scene(g);
    const ok = g.render(VP_PERSP, draw, { pixelRatio: 1.5 });
    expect(g.lastError).toBe('');
    expect(ok).toBe(true);
    const lines = trace.lines.join('\n');
    expect(trace.lines.filter((l) => l.startsWith('pass'))).toHaveLength(1);
    const pass = trace.lines.find((l) => l.startsWith('pass'))!;
    expect(pass).toMatch(/^pass canvas\(320x180\)/);   // 画进画布（多重采样 + 深度见下一条：管线的采样数 / 深度格式必须与目标一致）
    expect(pass).toContain('"clearValue":[0.075,0.085,0.105,1]');
    expect(pass).toContain('"d":{"load":"clear","clearValue":1}');
    expect(dev.lastFrameStats.draws).toBe(7);
    const draws = trace.lines.filter((l) => /^\s+draw/.test(l)).map((l) => l.trim());
    expect(draws).toEqual([
      'drawIndexed 6',       // 场景网格（索引）
      'draw 6',              // 碰撞格（6 个顶点、无索引）
      'draw 4,1,0,0',        // 两段线 = 4 个顶点，动态流起点 0
      'draw 6,2,0,0',        // 折线 3 点 → 2 段宽线实例（seg 流）
      'draw 6,2,0,0',        // 2 个点实例（pt 流）
      'draw 3,1,4,0',        // 三角形接在线段的 4 个顶点后面（v3 流）
      'draw 6,1,0,0',        // 公告板（v5 流）
    ]);
    expect(lines).toContain('ib none');
    expect(g.stats.draws).toBe(7);
  });

  it('管线状态与 WebGL 版一一对应：深度三档 / 混合 / 拓扑 / 采样数 / 深度格式', () => {
    const { g, pipes } = setup();
    g.render(VP_PERSP, scene(g).draw);
    const by = (vs: string, topo?: string) => pipes.filter((p) => (p.shader as unknown as { entryPoints: { vertex: string } }).entryPoints.vertex === vs && (!topo || p.topology === topo));
    for (const p of pipes) {
      expect(p.sampleCount).toBe(4);
      expect(p.depthFormat).toBe('depth24plus');
      expect(p.cullMode).toBe('none');
    }
    const meshPipe = by('vs_tex').find((p) => p.depth?.write)!;
    expect(meshPipe.blend).toBeNull();                               // 场景网格不混合、写深度
    expect(meshPipe.depth).toEqual({ write: true, compare: 'less-equal' });
    expect(by('vs_vcolor')[0].depth).toEqual({ write: false, compare: 'less-equal' });   // 碰撞格：测不写
    expect(by('vs_vcolor')[0].blend).toBeTruthy();
    expect(by('vs_flat', 'line-list')[0].depth).toEqual({ write: true, compare: 'less-equal' });
    expect(by('vs_wide')[0].depth).toEqual({ write: false, compare: 'always' });          // 'off'
    expect(by('vs_point')[0].depth).toEqual({ write: false, compare: 'always' });
    expect(by('vs_point')[0].vertexBuffers![0].stepMode).toBe('instance');
    expect(by('vs_flat', 'triangle-list')[0].depth).toEqual({ write: false, compare: 'less-equal' });
    for (const p of [...by('vs_flat'), ...by('vs_point'), ...by('vs_wide')]) expect(p.blend).toBeTruthy();
  });

  it('每次 draw 的统一数据：换好约定的矩阵 + 颜色 + 线宽 × 像素比 + 目标尺寸；点的颜色 / 边长在实例数据里', () => {
    const { dev, g } = setup([200, 100]);
    const writes: Record<string, Float32Array> = {};
    const orig = dev.writeBuffer.bind(dev);
    dev.writeBuffer = (b, data, off) => {
      writes[b.label] = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4).slice();
      orig(b, data, off);
    };
    g.render(VP_PERSP, (d) => {
      d.points([1, 2, 3], { color: [1, 0.5, 0.25, 0.75], size: 9 });
      d.lines([0, 0, 0, 1, 1, 1, 2, 2, 2], { strip: true, width: 2, color: [0, 1, 0, 1] });
    }, { pixelRatio: 2 });
    const f = writes['3D 调试件 · 每次 draw 的统一数据'], conv = glToWebGpuClip(VP_PERSP);
    expect([...f.subarray(0, 16)]).toEqual([...conv]);
    expect([...f.subarray(20, 24)]).toEqual([0, 0, 200, 100]);
    expect([...f.subarray(64 + 16, 64 + 24)]).toEqual([0, 1, 0, 1, 4, 0, 200, 100]);   // 第二格（256 字节）：线宽 2 × 2
    expect([...writes['3D 调试件 · 动态顶点 pt']]).toEqual([1, 2, 3, 1, 0.5, 0.25, 0.75, 18]);   // 9 CSS px × 2
  });

  it('连着画的点并成一次 draw（颜色 / 边长逐实例），中间隔了别的画法或换了深度档就另起一次', () => {
    const { dev, trace, g } = setup();
    g.render(VP_PERSP, (d) => {
      d.points([0, 0, 0], { color: [1, 0, 0, 1], size: 6, depth: 'off' });
      d.points([1, 0, 0, 2, 0, 0], { color: [0, 1, 0, 1], size: 9, depth: 'off' });
      d.points([3, 0, 0], { color: [0, 0, 1, 1], size: 12, depth: 'off' });
      d.points([4, 0, 0], { color: [1, 1, 1, 1], size: 7 });          // 换深度档
      d.lines([0, 0, 0, 1, 1, 1], {});
      d.points([5, 0, 0], { color: [1, 1, 0, 1], size: 7 });          // 隔了一条线
    });
    expect(dev.lastFrameStats.draws).toBe(4);
    expect(trace.lines.filter((l) => /^\s+draw/.test(l)).map((l) => l.trim())).toEqual(['draw 6,4,0,0', 'draw 6,1,0,4', 'draw 2,1,0,0', 'draw 6,1,0,5']);
  });

  it('同样输入两台设备记出同一串；相机 / 颜色 / 点径差一点就不同（记录器够灵敏）', () => {
    const run = (mut: (d: Debug3DDraw) => void, vp = VP_PERSP) => {
      const { trace, g } = setup();
      const s = scene(g);
      g.render(vp, (d) => { s.draw(d); mut(d); });
      return trace.lines.join('\n');
    };
    const base = run((d) => d.points([0, 0, 0], { size: 8 }));
    expect(run((d) => d.points([0, 0, 0], { size: 8 }))).toBe(base);
    expect(run((d) => d.points([0, 0, 0], { size: 9 }))).not.toBe(base);
    expect(run((d) => d.points([0, 0, 0.5], { size: 8 }))).not.toBe(base);
    expect(run((d) => d.points([0, 0, 0], { size: 8, color: [1, 1, 1, 0.99] }))).not.toBe(base);
    const vp2 = VP_PERSP.slice();
    vp2[12] += 1e-3;
    expect(run((d) => d.points([0, 0, 0], { size: 8 }), vp2)).not.toBe(base);
  });

  it('着色器只有一份：每个入口都从同一份 WGSL 建，页面侧不给任何着色源', () => {
    const { dev, g } = setup();
    const srcs = new Set<string>();
    const orig = dev.createShader.bind(dev);
    dev.createShader = (scope, desc) => {
      srcs.add(desc.wgsl);
      return orig(scope, desc);
    };
    g.render(VP_PERSP, scene(g).draw);
    expect([...srcs]).toEqual([DEBUG3D_WGSL]);
    expect(DEBUG3D_WGSL).not.toMatch(/#version|gl_Position|gl_FragColor|precision\s+mediump/);   // 不是 GLSL
  });

  it('顶点色：换颜色只重传颜色流（下一帧、录制前）；网格销毁后不再画', () => {
    const { dev, g } = setup();
    const s = scene(g);
    g.render(VP_PERSP, s.draw);
    const writes: string[] = [];
    const orig = dev.writeBuffer.bind(dev);
    dev.writeBuffer = (b, data, off) => {
      writes.push(b.label);
      orig(b, data, off);
    };
    g.render(VP_PERSP, s.draw);
    expect(writes.some((l) => l.includes('颜色'))).toBe(false);
    s.cells.setColors(new Float32Array(6 * 4).fill(0.5));
    g.render(VP_PERSP, s.draw);
    expect(writes.filter((l) => l.includes('颜色'))).toHaveLength(1);
    expect(() => s.cells.setColors(new Float32Array(3))).toThrow(/颜色长度/);
    s.mesh.destroy();
    g.render(VP_PERSP, s.draw);
    expect(dev.lastFrameStats.draws).toBe(6);
  });

  it('自检探针钩子：页面画法之后再录，关掉就没有', () => {
    const { dev, g } = setup();
    const s = scene(g);
    g.debugDraw = (d) => d.points([0, 0, 0], { color: [1, 0, 1, 1], size: 8 });
    g.render(VP_PERSP, s.draw);
    expect(dev.lastFrameStats.draws).toBe(8);
    g.debugDraw = null;
    g.render(VP_PERSP, s.draw);
    expect(dev.lastFrameStats.draws).toBe(7);
  });

  it('设备丢失恢复后：网格 / 贴图 / 管线从 CPU 源重建，照常画', async () => {
    const { dev, g } = setup();
    const s = scene(g);
    expect(g.render(VP_PERSP, s.draw)).toBe(true);
    await dev.loseDevice('测试', { restore: true });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(dev.isLost).toBe(false);
    expect(g.render(VP_PERSP, s.draw)).toBe(true);
    expect(dev.lastFrameStats.draws).toBe(7);
    expect(g.lastError).toMatch(/丢失|^$/);
  });
});
