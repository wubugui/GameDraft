/**
 * GiBouncePass —— 把**重打光后的场景**变成照亮角色的反弹光。
 *
 * ## 这里的 "GI" 是什么意思
 *
 * 制作人 2026-08-20 定义得很明确：
 * 「我们说的 gi 就是角色如何被 relighting 后的场景照亮，**不需要真的多次反弹**」。
 *
 * 所以这一级不解渲染方程，只做一件事：对 3D 网格的每个点，沿 16 个烘好的方向
 * 查「撞到的那面墙**现在**有多亮」，平均起来当作到达该点的反弹辐照。
 *
 * ```
 * 离线（几何，与光无关）   gi_hitmap.bin：网格点 × 方向 → 撞到哪个像素
 * 脏时（本 pass）          撞到的像素 → 查当前重打光结果 → 反弹辐照网格
 * 逐帧（角色 shader）      一次三线性 → 加进 S
 * ```
 *
 * 代价：脏时 3840 点 × 16 方向 = 61440 次纹理取样，一次性；稳态**零成本**。
 * 角色逐帧只多 8 次 texelFetch。
 *
 * ## 为什么不会双重记账
 *
 * · 从被照亮的**表面**采到的是**间接**光——解析灯算的是直接光，两者不重叠。
 * · 但灯**本体**（`emissive`）在辐射场里也是亮的，采到它等于把那盏灯的直接光
 *   再算一遍。所以场景 pass 把**自发光占该像素的比例**写进辐射场的 **alpha**，
 *   这里据此跳过主要是灯体的那些射线。存比例不存绝对亮度——绝对阈值会随灯的
 *   强度漂，灯一亮被判成"灯体"的区域就跟着变大，把该采的反弹光一起挡掉。
 */
import {
  Mesh,
  MeshGeometry,
  RenderTexture,
  type Renderer,
  Shader,
  type TextureSource,
} from 'pixi.js';

/** 与 `bake.py#GI_DIRS` 同值。改一边必须改另一边（载荷版本要 +1）。 */
export const GI_MAX_DIRS = 16;

const VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUv;
void main(void) {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
}
`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uRadiance;   // 场景重打光结果（RGBA16F；alpha = 自发光占比 0..1）
uniform sampler2D uHitmap;     // gi_hitmap（RGBA8：u, v, 命中标志, 255）
uniform vec2  uOutSize;        // 本 RT 尺寸 = (nx*nz, ny)
uniform int   uNdir;
uniform float uGain;
/**
 * 灯体排除阈值，判的是**自发光占该像素的比例**（辐射场 alpha，0..1）。
 *
 * ⚠ 判比例不判绝对亮度。绝对阈值会随灯的强度漂：灯调亮一档，被判成"灯体"的
 * 区域跟着变大，把本该采到的反弹光一起挡掉——症状是「GI 不跟着灯变」
 * （2026-08-21 实测：灯 ×10 反弹只涨 2.7%）。比例是尺度无关的。
 */
uniform float uEmitReject;

void main(void) {
    ivec2 g = ivec2(gl_FragCoord.xy);      // 列 = x + z*nx，行 = y
    int ny = int(uOutSize.y);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int d = 0; d < ${GI_MAX_DIRS}; d++) {
        if (d >= uNdir) break;
        // 命中图按方向沿高度叠：行 = dir*ny + y
        vec4 hm = texelFetch(uHitmap, ivec2(g.x, d * ny + g.y), 0);
        // miss ⇒ 那个方向看出去是天空。天光已由 skyvis 单独记账，这里**不能**再加，
        // 但**要算进分母**——否则开阔地会因为"没撞到东西"而反弹值虚高。
        wsum += 1.0;
        if (hm.b < 0.5) continue;
        vec4 r = texture(uRadiance, vec2(hm.r, hm.g));
        if (r.a > uEmitReject) continue;    // 这块主要是灯本体：那是直接光，跳过
        acc += r.rgb;
    }
    fragColor = vec4(acc / max(wsum, 1.0) * uGain, 1.0);
}
`;

/**
 * WebGPU 版(WGSL),与上面的 GLSL 逐句对应;GLSL 原样保留(WebGL 仍走它)。
 *
 * 绑定按 Pixi 网格约定:第 0 组 `globalUniforms`、第 1 组 `localUniforms` 由 Pixi 自动挂;
 * 本 pass 的资源放第 2 组,**变量名 = resources 的键名**,`giBounce` 结构体成员顺序 = JS 声明顺序。
 *
 * ## 格子寻址的行序(已用像素对照验过,别凭印象翻)
 *
 * GLSL 用 `ivec2(gl_FragCoord.xy)` 直接当格子下标。离屏 RT 上它与 WGSL 的 `@builtin(position)`
 * **指的是同一存储行**:Pixi WebGL 画 RT 时翻了投影,`gl_FragCoord.y = 0.5` 落在存储第 0 行;
 * WebGPU 的 position.y = 0.5 也是存储第 0 行。命中图 `texelFetch` / `textureLoad` 也都按存储行寻址,
 * 所以这里**原样取整、不翻 y**(`阴影与GI / GI 反弹` 用例用上下不对称的命中图锁住)。
 *
 * 循环里对辐射场的采样在非一致控制流里,改 `textureSampleLevel(…, 0)`:辐射场只有一级 mip,
 * 与 GLSL `texture()` 等价。命中图只 `textureLoad`,不需要采样器。
 * ⚠ 结构体体内不写注释:Pixi 用正则抽结构体成员,注释里的冒号会被当成成员。
 */
const WGSL = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
}

struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
}

struct GiBounce {
    uOutSize: vec2<f32>,
    uNdir: i32,
    uGain: f32,
    uEmitReject: f32,
}

@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

@group(2) @binding(0) var uRadiance: texture_2d<f32>;
@group(2) @binding(1) var uRadianceSampler: sampler;
@group(2) @binding(2) var uHitmap: texture_2d<f32>;
@group(2) @binding(3) var<uniform> giBounce: GiBounce;

struct VSOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) vUv: vec2<f32>,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
    let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    return VSOutput(vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0), aUV);
}

@fragment
fn mainFragment(input: VSOutput) -> @location(0) vec4<f32> {
    let g = vec2<i32>(input.position.xy);
    let ny = i32(giBounce.uOutSize.y);
    var acc = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var d = 0; d < ${GI_MAX_DIRS}; d++) {
        if (d >= giBounce.uNdir) { break; }
        let hm = textureLoad(uHitmap, vec2<i32>(g.x, d * ny + g.y), 0);
        wsum += 1.0;
        if (hm.b < 0.5) { continue; }
        let r = textureSampleLevel(uRadiance, uRadianceSampler, vec2<f32>(hm.r, hm.g), 0.0);
        if (r.a > giBounce.uEmitReject) { continue; }
        acc += r.rgb;
    }
    return vec4<f32>(acc / max(wsum, 1.0) * giBounce.uGain, 1.0);
}
`;

export interface GiBounceGeometry {
  /** gi_hitmap 纹理（RGBA8，尺寸 nx*nz × ny*ndir） */
  hitmap: TextureSource;
  /** [nx, ny, nz] */
  gridN: [number, number, number];
  ndir: number;
}

/**
 * 反弹辐照网格。**脏时重算**，与场景辐射场同一次触发；稳态零成本。
 */
export class GiBouncePass {
  private rt: RenderTexture | null = null;
  private mesh: Mesh<MeshGeometry, Shader> | null = null;
  private shader: Shader | null = null;
  private destroyed = false;
  private readonly geo: GiBounceGeometry;
  private readonly radiance: TextureSource;

  constructor(radiance: TextureSource, geo: GiBounceGeometry) {
    this.radiance = radiance;
    this.geo = geo;
    if (geo.ndir > GI_MAX_DIRS) {
      console.warn(
        `[GiBouncePass] 载荷有 ${geo.ndir} 个 GI 方向，shader 上限 ${GI_MAX_DIRS}，`
        + '多出的被忽略 —— 载荷与运行时代次不匹配，应当重烘或改 GI_MAX_DIRS',
      );
    }
  }

  /** 反弹辐照网格纹理。角色 shader 按 skyvis 同一套平铺规则三线性采样。 */
  get bounce(): TextureSource | null {
    return this.rt?.source ?? null;
  }

  private ensure(): void {
    if (this.rt || this.destroyed) return;
    const [nx, ny, nz] = this.geo.gridN;
    const w = nx * nz;
    const h = ny;
    // RGBA16F：反弹是线性 HDR 量，8 位会在暗场景里量化成台阶
    this.rt = RenderTexture.create({
      width: w, height: h, format: 'rgba16float', scaleMode: 'nearest', antialias: false,
    });
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, w, 0, w, h, 0, h]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
      gpu: {
        vertex: { source: WGSL, entryPoint: 'mainVertex' },
        fragment: { source: WGSL, entryPoint: 'mainFragment' },
      },
      resources: {
        uRadiance: this.radiance,
        // WGSL 要单独的采样器(WebGL 侧没有这个名字,Pixi 忽略)
        uRadianceSampler: this.radiance.style,
        uHitmap: this.geo.hitmap,
        giBounce: {
          uOutSize: { value: new Float32Array([w, h]), type: 'vec2<f32>' },
          uNdir: { value: Math.min(this.geo.ndir, GI_MAX_DIRS), type: 'i32' },
          uGain: { value: 1, type: 'f32' },
          // 0.5 = 自发光占一半以上才算"打在灯上"。被照亮的地面/墙面 emitFrac 极小，
          // 不会被误伤；灯芯附近 emitFrac → 1，稳稳被挡。
          uEmitReject: { value: 0.5, type: 'f32' },
        },
      },
    });
    this.mesh = new Mesh({ geometry, shader: this.shader });
  }
  /** 重算。由 `SceneLightingPass` 重算之后立刻调（它先，我后——我读它的产物）。 */
  render(renderer: Renderer): void {
    this.ensure();
    if (!this.rt || !this.mesh) return;
    // ⚠ Pixi 坑①：渲离屏 RT 必须显式 clear，否则串到上一次的内容
    renderer.render({ container: this.mesh, target: this.rt, clear: true });
  }

  destroy(): void {
    this.destroyed = true;
    this.mesh?.destroy();
    this.mesh = null;
    this.shader?.destroy();
    this.shader = null;
    this.rt?.destroy(true);
    this.rt = null;
  }
}
