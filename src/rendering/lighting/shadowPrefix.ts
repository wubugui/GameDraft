import {
  Mesh, MeshGeometry, RenderTexture, Shader,
  type Renderer, type Texture,
} from 'pixi.js';

/**
 * 阴影的**线扫（前缀最小）**求解器 —— 取代逐像素光线步进。
 *
 * ## 为什么不 march
 *
 * 原来每盏灯每像素沿光线走 N 步查深度场。两个后果都被制作人一眼看出来：
 *
 * - **网状走样**：第 i 步永远落在「到灯距离的 i/N 处」＝以灯为圆心的等距壳上，
 *   阴影边界被量化成 N 圈同心弧。实测径向剖面去趋势后 FFT 的**主频恰好等于步数**。
 * - **漏挡**：步长随距离变粗，细遮挡体被跨过去。实测 24 步比 512 步少 10 个百分点的阴影。
 *
 * 加步数只是把弧变密、把漏挡变小，**病根还在**（而且 128 步 × 6 盏 × 236 万像素
 * ＝ 18 亿次采样）。制作人 2026-08-22：「让你考虑改算法，你还在纠结多少步」。
 *
 * ## 2D 本质给出的解
 *
 * 背景是**静态画 + 静态深度场 + 固定相机**。对一盏点光，所有阴影射线都落在
 * **过灯的径向线**上，于是这件事根本不是三维求交，是一维前缀问题：
 *
 * ```
 *   光线深度   z(k) = z_灯 + sp·k        （k ＝ 离灯的图像距离，sp ＝ 该像素的斜率）
 *   被挡      z(k) − d(k) > bias
 *   代入      sp > [ (d(k) − z_灯) + bias ] / k  =:  g(k)
 *
 *   ⇒  被挡  ⟺  sp > min_{k<u} g(k)
 * ```
 *
 * **`g` 只依赖几何与灯位，与被照的那个像素无关**；`M(u) = 前缀最小 g` 是同一条
 * 径向线上所有像素**共享**的量。所以每像素只要一次查表 + 一次比较，**零步进** ——
 * 网状走样从构造上不存在，因为压根没有离散步。
 *
 * 实测（雾津街头六盏灯，每盏 7488 像素，真值 ＝ 512 步定步长）：
 * 定步长 128 与真值不符 0.15%–0.71%，**线扫 0.04%–0.12%** —— 准 3–10 倍。
 *
 * ## GPU 上怎么做前缀
 *
 * WebGL2 没有 compute，用 **Hillis–Steele 扫描**：
 * `M_j(P) = min( M_{j−1}(P), M_{j−1}(P 沿径向朝灯挪 2^{j−1} 像素) )`，
 * ⌈log2(对角线)⌉ 趟之后 M 就是整条线的前缀最小。
 *
 * 4 盏灯打包进一张 RGBA16F 的四个通道一起扫。6 盏 ＝ 2 组 × 12 趟 × 4 次采样
 * ＝ **96 次采样/像素**，对比原来 6 × 128 ＝ 768 —— 便宜 8 倍，而且更准。
 *
 * ## ⚠ `thick`（遮挡体厚度窗）在这条路上是**不需要**的
 *
 * `thick` 是给 march 打的补丁：深度场只有可见壳没有背面，march 会把「射线在远处
 * 一堵墙背后的空气里」误判成被挡，于是要限定「只有沉进去不超过 thick 才算」。
 * 线扫问的是**地形剖面在不在光线之上**，本来就没有这个失败模式。
 * 实测六盏灯上带不带 thick 与真值的不符率**逐位相同**。
 */

/** 每张 RGBA16F 打包几盏灯。 */
export const LIGHTS_PER_SLAB = 4;

/** 扫描趟数 ＝ ⌈log2(对角线像素)⌉。2048×1152 的对角线 2350 → 12。 */
export function scanPassCount(w: number, h: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(Math.hypot(w, h), 2))));
}

/**
 * 前缀最小的单位元 —— **半浮点的最大值**，不是随便写个大数。
 *
 * ⚠ 一度写的是 1e30。slab 是 RGBA16F，硬件把它**钳成 65504**（不是 Inf 也不是 0）。
 *   min 语义不受影响（65504 仍远大于任何真实斜率，实测该场景斜率量级 1e-3），
 *   但常量与实际存进去的值差 **25 个数量级** —— 谁将来按 1e30 去比对就踩空。
 *   直接写成硬件真正存得下的那个值。
 *
 * 判据：任何一盏灯的真实 g 都远小于它。实测雾津街头六盏灯的非哨兵值域
 * 是 −0.0092 … +0.309，与 65504 差七个数量级，够安全。
 */
export const PREFIX_SENTINEL = 65504;

const VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUv;
void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
}
`;

/**
 * 初始化：算出每个像素的 g ＝ [ (d − z_灯) + bias ] / k。
 * k ＝ 该像素到灯的**图像距离**（像素）。k 很小的地方（灯本体附近）直接给哨兵值，
 * 免得除零把整条线毒死。
 */
const INIT_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uDepth;
uniform vec2  uTexSize;
uniform vec3  uDepthMap;     // invert, scale, offset
// 四盏灯在**图像**上的位置 xy;w = 有效标志(0 = 这个通道没灯)
uniform vec4  uLightPx[4];
uniform vec4  uLightZ;       // 四盏灯各自在 q 里的深度
uniform float uBias;
uniform float uNearPx;       // 小于这个图像距离就不参与前缀(k→0 时 g 发散)
uniform float uSentinel;

float prefixDecodeDepth(vec4 t) {
    float raw = t.r * 255.0 * 256.0 + t.g * 255.0;
    float u = raw / 65535.0;
    if (uDepthMap.x > 0.5) u = 1.0 - u;
    return u * uDepthMap.y + uDepthMap.z;
}

void main(void) {
    vec2 px = vUv * uTexSize;
    float d = prefixDecodeDepth(texture(uDepth, vUv));
    vec4 g = vec4(uSentinel);
    for (int i = 0; i < 4; i++) {
        if (uLightPx[i].w < 0.5) continue;
        float k = length(px - uLightPx[i].xy);
        if (k < uNearPx) continue;
        float v = ((d - uLightZ[i]) + uBias) / k;
        if (i == 0) g.x = v;
        else if (i == 1) g.y = v;
        else if (i == 2) g.z = v;
        else g.w = v;
    }
    fragColor = g;
}
`;

/**
 * 扫描一趟：与"沿径向朝灯挪 uOffset 像素"处取逐通道最小。
 *
 * 每个通道的灯不同 ⇒ 偏移方向也不同 ⇒ 一趟 4 次采样。这正是打包 4 盏一起扫
 * 仍然划算的原因：趟数减到 1/4，总采样数不变，但 draw call 少了 4 倍。
 *
 * `uOffset = 0` 时退化成纯拷贝（奇数趟收尾把结果搬回 slab 用）。
 */
const SCAN_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPrev;
uniform vec2  uTexSize;
uniform vec4  uLightPx[4];
uniform float uOffset;

void main(void) {
    vec4 cur = texture(uPrev, vUv);
    if (uOffset <= 0.0) { fragColor = cur; return; }
    vec2 px = vUv * uTexSize;
    for (int i = 0; i < 4; i++) {
        if (uLightPx[i].w < 0.5) continue;
        vec2 toLight = uLightPx[i].xy - px;
        float k = length(toLight);
        if (k < 1e-4) continue;
        // 朝灯挪，但不许越过灯 —— 越过就跑到径向线的另一侧去了，那不是"前缀"
        float adv = min(uOffset, k);
        vec2 sUv = (px + toLight / k * adv) / uTexSize;
        if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) continue;
        vec4 s = texture(uPrev, sUv);
        if (i == 0) cur.x = min(cur.x, s.x);
        else if (i == 1) cur.y = min(cur.y, s.y);
        else if (i == 2) cur.z = min(cur.z, s.z);
        else cur.w = min(cur.w, s.w);
    }
    fragColor = cur;
}
`;

export interface ShadowPrefixGeometry {
  depth: Texture;
  /** [w, h] native */
  depthSize: [number, number];
  /** invert, scale, offset */
  depthMapping: [number, number, number];
  /** ppu, cx, cy（native 标定） */
  cal: [number, number, number];
}

/** 一盏灯喂给求解器需要的东西（位置**已折进伪世界 q**）。 */
export interface PrefixLight {
  q: [number, number, number];
  castShadow: boolean;
}

/**
 * 线扫求解器。持有 ping-pong 与结果 slab；`solve` 之后用 `slab(i)` 取纹理。
 *
 * 生命周期与 `SceneLightingPass` 同步：脏时重解一次，稳态零成本。
 */
export class ShadowPrefixPass {
  private slabs: RenderTexture[] = [];
  private scratch: RenderTexture | null = null;
  private initShader: Shader | null = null;
  private scanShader: Shader | null = null;
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private destroyed = false;

  constructor(private geo: ShadowPrefixGeometry) {}

  /** 第 i 组（每组 4 盏）的前缀最小纹理；没解过返回 null。 */
  slab(i: number): Texture | null {
    return this.slabs[i] ?? null;
  }

  private ensure(slabCount: number): void {
    if (this.destroyed) return;
    const [w, h] = this.geo.depthSize;
    const mk = (): RenderTexture => RenderTexture.create({
      width: w, height: h, format: 'rgba16float', scaleMode: 'linear', antialias: false,
    });
    while (this.slabs.length < slabCount) this.slabs.push(mk());
    if (!this.scratch) this.scratch = mk();
    if (this.mesh) return;

    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.initShader = Shader.from({
      gl: { vertex: VERT, fragment: INIT_FRAG },
      resources: {
        uDepth: this.geo.depth.source,
        prefixInit: {
          uTexSize: { value: new Float32Array([w, h]), type: 'vec2<f32>' },
          uDepthMap: { value: new Float32Array(this.geo.depthMapping), type: 'vec3<f32>' },
          uLightPx: { value: new Float32Array(16), type: 'vec4<f32>', size: 4 },
          uLightZ: { value: new Float32Array(4), type: 'vec4<f32>' },
          uBias: { value: 0, type: 'f32' },
          uNearPx: { value: 2, type: 'f32' },
          uSentinel: { value: PREFIX_SENTINEL, type: 'f32' },
        },
      },
    });
    this.scanShader = Shader.from({
      gl: { vertex: VERT, fragment: SCAN_FRAG },
      resources: {
        uPrev: this.slabs[0].source,
        prefixScan: {
          uTexSize: { value: new Float32Array([w, h]), type: 'vec2<f32>' },
          uLightPx: { value: new Float32Array(16), type: 'vec4<f32>', size: 4 },
          uOffset: { value: 1, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.initShader });
  }

  /**
   * 解一次。`lights` 按 `packLights` 的下标顺序给，`biasQ` 是 q 空间的起步偏置。
   * 返回实际用到的 slab 数。
   */
  solve(renderer: Renderer, lights: readonly PrefixLight[], biasQ: number): number {
    if (this.destroyed) return 0;
    const [w, h] = this.geo.depthSize;
    const slabCount = Math.max(1, Math.ceil(lights.length / LIGHTS_PER_SLAB));
    this.ensure(slabCount);
    const mesh = this.mesh;
    const init = this.initShader;
    const scan = this.scanShader;
    const scratch = this.scratch;
    if (!mesh || !init || !scan || !scratch) return 0;

    const passes = scanPassCount(w, h);
    const [ppu, cx, cy] = this.geo.cal;

    for (let s = 0; s < slabCount; s++) {
      const px = new Float32Array(16);
      const lz = new Float32Array(4);
      let any = false;
      for (let c = 0; c < LIGHTS_PER_SLAB; c++) {
        const l = lights[s * LIGHTS_PER_SLAB + c];
        if (!l || !l.castShadow) continue;
        px[c * 4] = cx + l.q[0] * ppu;
        px[c * 4 + 1] = cy - l.q[1] * ppu;
        px[c * 4 + 3] = 1;
        lz[c] = l.q[2];
        any = true;
      }

      const ui = init.resources.prefixInit.uniforms;
      (ui.uLightPx as Float32Array).set(px);
      (ui.uLightZ as Float32Array).set(lz);
      ui.uBias = biasQ;
      mesh.shader = init;
      renderer.render({ container: mesh, target: this.slabs[s], clear: true });
      if (!any) continue;                       // 这一组一盏带影灯都没有，哨兵就够了

      const us = scan.resources.prefixScan.uniforms;
      (us.uLightPx as Float32Array).set(px);
      mesh.shader = scan;
      let src: RenderTexture = this.slabs[s];
      let dst: RenderTexture = scratch;
      for (let j = 0; j < passes; j++) {
        us.uOffset = 2 ** j;
        scan.resources.uPrev = src.source;
        renderer.render({ container: mesh, target: dst, clear: true });
        const t = src; src = dst; dst = t;
      }
      if (src !== this.slabs[s]) {
        us.uOffset = 0;                         // 位移 0 ＝ 纯拷贝
        scan.resources.uPrev = src.source;
        renderer.render({ container: mesh, target: this.slabs[s], clear: true });
      }
    }
    return slabCount;
  }

  destroy(): void {
    this.destroyed = true;
    // ⚠ Pixi 坑②：先解绑再销毁，顺序反了不是泄漏，是把 shader 的 BindGroup 永久烧毁
    this.mesh?.destroy();
    this.mesh = null;
    this.initShader = null;
    this.scanShader = null;
    for (const s of this.slabs) s.destroy(true);
    this.slabs = [];
    this.scratch?.destroy(true);
    this.scratch = null;
  }
}
