import { Filter, GlProgram, GpuProgram, Texture, type TextureSource } from '../engine2d';
import type { SceneDepthConfig } from '../data/types';
import { samplerOf } from './legacy/gpuSampler';

const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;
out vec2 vScreenPos;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
    vScreenPos = aPosition * uOutputFrame.zw + uOutputFrame.xy;
}
`;

const FRAG = /* glsl */ `
in vec2 vTextureCoord;
in vec2 vScreenPos;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uDepthMap;
uniform sampler2D uCollisionMap;

uniform float uMode;                // 0=off, 1=depth, 2=collision, 3=uv
uniform vec2  uTexSize;             // 背景纹理原始像素尺寸
uniform vec2  uWorldContainerPos;   // worldContainer 屏幕偏移
uniform vec2  uSceneSize;           // 场景在屏幕空间的像素尺寸

// 深度图参数
uniform float uInvert;
uniform float uScale;
uniform float uOffset;

// M矩阵参数（纹理像素空间）
uniform float uM_ppu;
uniform float uM_cx;
uniform float uM_cy;
uniform float uM_R00; uniform float uM_R01; uniform float uM_R02;
uniform float uM_R20; uniform float uM_R21; uniform float uM_R22;
uniform sampler2D uGroundD;    // 行走面深度场(RG16,与遮挡/影子同一份)
uniform float uGroundMin;
uniform float uGroundMax;
uniform float uHasGroundTex;   // 0=无场 → 碰撞可视化整片置灰(不拿死掉的 floor 线糊弄)

// 碰撞网格
uniform float uCol_xMin;
uniform float uCol_zMin;
uniform float uCol_cellSize;
uniform float uCol_gridW;
uniform float uCol_gridH;

// 仅深度调试用：线性深度空间归一化区间（由 depth_mapping 推导）
uniform float uDbgDepthLo;
uniform float uDbgDepthHi;

float asinh_fast(float x) {
    return log(x + sqrt(x * x + 1.0));
}

/** 近似 Viridis：保序，突出全局深浅 */
vec3 depth_debug_colormap(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3(0.05, 0.02, 0.38);
    vec3 c1 = vec3(0.02, 0.40, 0.72);
    vec3 c2 = vec3(0.18, 0.75, 0.55);
    vec3 c3 = vec3(0.85, 0.75, 0.20);
    vec3 c4 = vec3(0.92, 0.35, 0.12);
    float p = t * 4.0;
    if (p < 1.0) return mix(c0, c1, smoothstep(0.0, 1.0, p));
    if (p < 2.0) return mix(c1, c2, smoothstep(0.0, 1.0, p - 1.0));
    if (p < 3.0) return mix(c2, c3, smoothstep(0.0, 1.0, p - 2.0));
    return mix(c3, c4, smoothstep(0.0, 1.0, p - 3.0));
}

void main(void) {
    if (uMode < 0.5) {
        finalColor = texture(uTexture, vTextureCoord);
        return;
    }

    // 从屏幕位置算出背景 UV (与 DepthOcclusionFilter 同理)
    float sx = vScreenPos.x - uWorldContainerPos.x;
    float sy = vScreenPos.y - uWorldContainerPos.y;
    vec2 uv = vec2(sx / uSceneSize.x, sy / uSceneSize.y);

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        finalColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    if (uMode < 1.5) {
        // --- 深度调试可视化：单调 asinh + 全局线性区间归一化 + colormap（不改采样与深度逻辑） ---
        vec4 depthSample = texture(uDepthMap, uv);
        float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
        float d = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
        float depth = d * uScale + uOffset;
        float z = asinh_fast(depth);
        float z0 = asinh_fast(uDbgDepthLo);
        float z1 = asinh_fast(uDbgDepthHi);
        float t = clamp((z - z0) / max(z1 - z0, 1e-6), 0.0, 1.0);
        finalColor = vec4(depth_debug_colormap(t), 1.0);

    } else if (uMode < 2.5) {
        // --- 碰撞可视化 ---
        float texX = uv.x * uTexSize.x;
        float texY = uv.y * uTexSize.y;

        if (uHasGroundTex < 0.5) { finalColor = vec4(0.25, 0.25, 0.28, 1.0); return; }
        vec4 gsm = texture(uGroundD, uv);
        float dFloor = uGroundMin
            + ((gsm.r * 255.0 * 256.0 + gsm.g * 255.0) / 65535.0) * (uGroundMax - uGroundMin);
        float px = (texX - uM_cx) / uM_ppu;
        float py = (uM_cy - texY) / uM_ppu;

        float wx = uM_R00 * px + uM_R01 * py + uM_R02 * dFloor;
        float wz = uM_R20 * px + uM_R21 * py + uM_R22 * dFloor;

        float gx = (wx - uCol_xMin) / uCol_cellSize;
        float gz = (wz - uCol_zMin) / uCol_cellSize;

        float isCollision = 0.0;
        if (gx >= 0.0 && gx < uCol_gridW && gz >= 0.0 && gz < uCol_gridH) {
            vec2 colUV = vec2(gx / uCol_gridW, gz / uCol_gridH);
            vec4 colSample = texture(uCollisionMap, colUV);
            isCollision = colSample.r > 0.5 ? 1.0 : 0.0;
        }

        finalColor = vec4(0.0, isCollision, 0.0, 1.0);

    } else {
        // --- UV 可视化 ---
        finalColor = vec4(uv.x, uv.y, 0.0, 1.0);
    }
}
`;

/**
 * WebGPU 版(与上面 GLSL 逐段对应,四个视图全在)。约定与坑:
 * - `@group(0)` 是 Pixi 滤镜固定的 gfu / uTexture / uSampler;本滤镜的放 `@group(1)`,
 *   **变量名 = resources 键名**(`bgDebug` 与各纹理),每张纹理配一个 `<名>Sampler`;
 * - `BgDebugUniforms` 成员顺序 = 构造里 `bgDebug` 的声明顺序(Pixi 按声明顺序、WGSL 对齐算偏移);
 * - 深度 / 行走面 / 碰撞三张图的采样都在「uv 越界提前返回」之后 —— 那是非一致控制流,
 *   WGSL 的 textureSample 在那里编不过,改用 `textureSampleLevel(.., 0)`:这几张图都是单级(无 mip),
 *   与 GLSL `texture()` 等价。透传视图那次采样只受 uniform 条件控制,照用 textureSample。
 */
const WGSL = /* wgsl */ `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

struct BgDebugUniforms {
  uMode: f32,
  uTexSize: vec2<f32>,
  uWorldContainerPos: vec2<f32>,
  uSceneSize: vec2<f32>,
  uInvert: f32,
  uScale: f32,
  uOffset: f32,
  uM_ppu: f32,
  uM_cx: f32,
  uM_cy: f32,
  uM_R00: f32,
  uM_R01: f32,
  uM_R02: f32,
  uM_R20: f32,
  uM_R21: f32,
  uM_R22: f32,
  uGroundMin: f32,
  uGroundMax: f32,
  uHasGroundTex: f32,
  uCol_xMin: f32,
  uCol_zMin: f32,
  uCol_cellSize: f32,
  uCol_gridW: f32,
  uCol_gridH: f32,
  uDbgDepthLo: f32,
  uDbgDepthHi: f32,
};
@group(1) @binding(0) var<uniform> bgDebug: BgDebugUniforms;
@group(1) @binding(1) var uDepthMap: texture_2d<f32>;
@group(1) @binding(2) var uDepthMapSampler: sampler;
@group(1) @binding(3) var uCollisionMap: texture_2d<f32>;
@group(1) @binding(4) var uCollisionMapSampler: sampler;
@group(1) @binding(5) var uGroundD: texture_2d<f32>;
@group(1) @binding(6) var uGroundDSampler: sampler;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vTextureCoord: vec2<f32>,
  @location(1) vScreenPos: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(
    filterVertexPosition(aPosition),
    filterTextureCoord(aPosition),
    aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy,
  );
}

fn asinh_fast(x: f32) -> f32 {
  return log(x + sqrt(x * x + 1.0));
}

// 近似 Viridis:保序,突出全局深浅
fn depth_debug_colormap(t0: f32) -> vec3<f32> {
  let t = clamp(t0, 0.0, 1.0);
  let c0 = vec3<f32>(0.05, 0.02, 0.38);
  let c1 = vec3<f32>(0.02, 0.40, 0.72);
  let c2 = vec3<f32>(0.18, 0.75, 0.55);
  let c3 = vec3<f32>(0.85, 0.75, 0.20);
  let c4 = vec3<f32>(0.92, 0.35, 0.12);
  let p = t * 4.0;
  if (p < 1.0) { return mix(c0, c1, smoothstep(0.0, 1.0, p)); }
  if (p < 2.0) { return mix(c1, c2, smoothstep(0.0, 1.0, p - 1.0)); }
  if (p < 3.0) { return mix(c2, c3, smoothstep(0.0, 1.0, p - 2.0)); }
  return mix(c3, c4, smoothstep(0.0, 1.0, p - 3.0));
}

@fragment
fn mainFragment(
  @location(0) vTextureCoord: vec2<f32>,
  @location(1) vScreenPos: vec2<f32>,
) -> @location(0) vec4<f32> {
  if (bgDebug.uMode < 0.5) {
    return textureSample(uTexture, uSampler, vTextureCoord);
  }

  // 从屏幕位置算出背景 UV(与 DepthOcclusionFilter 同理)
  let sx = vScreenPos.x - bgDebug.uWorldContainerPos.x;
  let sy = vScreenPos.y - bgDebug.uWorldContainerPos.y;
  let uv = vec2<f32>(sx / bgDebug.uSceneSize.x, sy / bgDebug.uSceneSize.y);

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  if (bgDebug.uMode < 1.5) {
    // 深度调试可视化:单调 asinh + 全局线性区间归一化 + colormap
    let depthSample = textureSampleLevel(uDepthMap, uDepthMapSampler, uv, 0.0);
    let rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
    var d = rawDepth;
    if (bgDebug.uInvert > 0.5) { d = 1.0 - rawDepth; }
    let depth = d * bgDebug.uScale + bgDebug.uOffset;
    let z = asinh_fast(depth);
    let z0 = asinh_fast(bgDebug.uDbgDepthLo);
    let z1 = asinh_fast(bgDebug.uDbgDepthHi);
    let t = clamp((z - z0) / max(z1 - z0, 1e-6), 0.0, 1.0);
    return vec4<f32>(depth_debug_colormap(t), 1.0);
  } else if (bgDebug.uMode < 2.5) {
    // 碰撞可视化
    let texX = uv.x * bgDebug.uTexSize.x;
    let texY = uv.y * bgDebug.uTexSize.y;

    if (bgDebug.uHasGroundTex < 0.5) { return vec4<f32>(0.25, 0.25, 0.28, 1.0); }
    let gsm = textureSampleLevel(uGroundD, uGroundDSampler, uv, 0.0);
    let dFloor = bgDebug.uGroundMin
      + ((gsm.r * 255.0 * 256.0 + gsm.g * 255.0) / 65535.0) * (bgDebug.uGroundMax - bgDebug.uGroundMin);
    let px = (texX - bgDebug.uM_cx) / bgDebug.uM_ppu;
    let py = (bgDebug.uM_cy - texY) / bgDebug.uM_ppu;

    let wx = bgDebug.uM_R00 * px + bgDebug.uM_R01 * py + bgDebug.uM_R02 * dFloor;
    let wz = bgDebug.uM_R20 * px + bgDebug.uM_R21 * py + bgDebug.uM_R22 * dFloor;

    let gx = (wx - bgDebug.uCol_xMin) / bgDebug.uCol_cellSize;
    let gz = (wz - bgDebug.uCol_zMin) / bgDebug.uCol_cellSize;

    var isCollision = 0.0;
    if (gx >= 0.0 && gx < bgDebug.uCol_gridW && gz >= 0.0 && gz < bgDebug.uCol_gridH) {
      let colUV = vec2<f32>(gx / bgDebug.uCol_gridW, gz / bgDebug.uCol_gridH);
      let colSample = textureSampleLevel(uCollisionMap, uCollisionMapSampler, colUV, 0.0);
      if (colSample.r > 0.5) { isCollision = 1.0; }
    }

    return vec4<f32>(0.0, isCollision, 0.0, 1.0);
  }
  // UV 可视化
  return vec4<f32>(uv.x, uv.y, 0.0, 1.0);
}
`;

let sharedProgram: GlProgram | null = null;
let sharedGpuProgram: GpuProgram | null = null;

function getProgram(): GlProgram {
    if (!sharedProgram) {
        sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
    }
    return sharedProgram;
}

function getGpuProgram(): GpuProgram {
    if (!sharedGpuProgram) {
        sharedGpuProgram = GpuProgram.from({
            name: 'background-debug-filter',
            vertex: { source: WGSL, entryPoint: 'mainVertex' },
            fragment: { source: WGSL, entryPoint: 'mainFragment' },
        });
    }
    return sharedGpuProgram;
}

export class BackgroundDebugFilter extends Filter {
    constructor() {
        const placeholder = Texture.WHITE;
        super({
            glProgram: getProgram(),
            gpuProgram: getGpuProgram(),
            resources: {
                bgDebug: {
                    uMode: { value: 0, type: 'f32' },
                    uTexSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
                    uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
                    uSceneSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
                    uInvert: { value: 0, type: 'f32' },
                    uScale: { value: 1, type: 'f32' },
                    uOffset: { value: 0, type: 'f32' },
                    uM_ppu: { value: 1, type: 'f32' },
                    uM_cx: { value: 0, type: 'f32' },
                    uM_cy: { value: 0, type: 'f32' },
                    uM_R00: { value: 1, type: 'f32' },
                    uM_R01: { value: 0, type: 'f32' },
                    uM_R02: { value: 0, type: 'f32' },
                    uM_R20: { value: 0, type: 'f32' },
                    uM_R21: { value: 0, type: 'f32' },
                    uM_R22: { value: 1, type: 'f32' },
                    // 行走面场的解码区间与「有没有场」:必须在这里声明。Pixi 的 uniform 组只认构造时声明的键,
                    // 事后往 uniforms 上挂新键——WebGL 首次生成同步函数时会去读不存在的类型描述而抛
                    // (整帧渲染失败);若同步函数先于挂键生成,新键则永远不上传(碰撞视图恒置灰);
                    // WebGPU 的 uniform 缓冲布局也只按声明的键排。
                    uGroundMin: { value: 0, type: 'f32' },
                    uGroundMax: { value: 1, type: 'f32' },
                    uHasGroundTex: { value: 0, type: 'f32' },
                    uCol_xMin: { value: 0, type: 'f32' },
                    uCol_zMin: { value: 0, type: 'f32' },
                    uCol_cellSize: { value: 1, type: 'f32' },
                    uCol_gridW: { value: 0, type: 'f32' },
                    uCol_gridH: { value: 0, type: 'f32' },
                    uDbgDepthLo: { value: -1, type: 'f32' },
                    uDbgDepthHi: { value: 1, type: 'f32' },
                },
                uDepthMap: placeholder.source,
                uDepthMapSampler: samplerOf(placeholder.source),
                uCollisionMap: placeholder.source,
                uCollisionMapSampler: samplerOf(placeholder.source),
                uGroundD: placeholder.source,
                uGroundDSampler: samplerOf(placeholder.source),
            },
        });
    }

    private get _u() {
        // Pixi 的 BindGroup 在所绑资源被 destroy 时会**自毁**(onResourceChange → resources=null)，
        // 此后读 filter.resources 直接抛。本滤镜跨场景长活、却绑着按场景销毁的照明载荷纹理
        // (uGroundD)，所以这条路真会走到——一旦抛进调用方，照明就绪回调会被掀翻、整场景照明
        // 载荷被静默丢弃(见 unbindSceneTextures)。**调试可视化坏掉可以，绝不能拖垮玩法。**
        try {
            return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)['bgDebug']?.uniforms;
        } catch {
            return undefined;
        }
    }

    setMode(mode: number): void {
        const u = this._u;
        if (u) u['uMode'] = mode;
    }

    getMode(): number {
        return (this._u?.['uMode'] as number) ?? 0;
    }

    loadSceneData(
        depthTexture: Texture,
        texWidth: number,
        texHeight: number,
        cfg: SceneDepthConfig,
    ): void {
        const u = this._u;
        if (!u) return;

        (this.resources as Record<string, unknown>)['uDepthMap'] = depthTexture.source;
        (this.resources as Record<string, unknown>)['uDepthMapSampler'] = samplerOf(depthTexture.source);

        const sz = u['uTexSize'] as Float32Array;
        sz[0] = texWidth; sz[1] = texHeight;

        const dm = cfg.depth_mapping;
        u['uInvert'] = dm.invert ? 1.0 : 0.0;
        u['uScale'] = dm.scale;
        u['uOffset'] = dm.offset;

        // d∈[0,1] → depth = d*scale+offset；推导显示归一化区间，仅影响 F2 深度着色
        const o = dm.offset;
        const s = dm.scale;
        let lo = Math.min(o, s + o);
        let hi = Math.max(o, s + o);
        if (lo > hi) [lo, hi] = [hi, lo];
        const span = hi - lo;
        const pad = Math.max(span * 0.12, Math.max(Math.abs(s), 1e-6) * 0.05, 1e-3);
        let nLo = lo - pad;
        let nHi = hi + pad;
        if (span < 1e-8) {
            nLo = o - 1;
            nHi = o + 1;
        }
        if (nHi - nLo < 1e-6) {
            nLo -= 1;
            nHi += 1;
        }
        u['uDbgDepthLo'] = nLo;
        u['uDbgDepthHi'] = nHi;

        const M = cfg.M;
        u['uM_ppu'] = M.ppu;
        u['uM_cx'] = M.cx;
        u['uM_cy'] = M.cy;
        u['uM_R00'] = M.R[0][0]; u['uM_R01'] = M.R[0][1]; u['uM_R02'] = M.R[0][2];
        u['uM_R20'] = M.R[2][0]; u['uM_R21'] = M.R[2][1]; u['uM_R22'] = M.R[2][2];


        const col = cfg.collision;
        if (col) {
            u['uCol_xMin'] = col.x_min;
            u['uCol_zMin'] = col.z_min;
            u['uCol_cellSize'] = col.cell_size;
            u['uCol_gridW'] = col.grid_width;
            u['uCol_gridH'] = col.grid_height;
        }
    }

    setWorldContainerPos(x: number, y: number): void {
        const u = this._u;
        if (u) {
            const arr = u['uWorldContainerPos'] as Float32Array;
            arr[0] = x; arr[1] = y;
        }
    }

    setSceneSize(w: number, h: number): void {
        const u = this._u;
        if (u) {
            const arr = u['uSceneSize'] as Float32Array;
            arr[0] = w; arr[1] = h;
        }
    }

    /** 注入行走面深度场(碰撞可视化的地面来源);null=无场,可视化置灰 */
    setGroundTexture(g: { tex: TextureSource; min: number; max: number } | null): void {
        const u = this._u;
        if (!u) return;
        const ground = g?.tex ?? Texture.WHITE.source;
        (this.resources as Record<string, unknown>)['uGroundD'] = ground;
        (this.resources as Record<string, unknown>)['uGroundDSampler'] = samplerOf(ground);
        u['uGroundMin'] = g?.min ?? 0;
        u['uGroundMax'] = g?.max ?? 1;
        u['uHasGroundTex'] = g ? 1 : 0;
    }

    setCollisionTexture(tex: Texture): void {
        const u = this._u;
        if (!u) return;
        (this.resources as Record<string, unknown>)['uCollisionMap'] = tex.source;
        (this.resources as Record<string, unknown>)['uCollisionMapSampler'] = samplerOf(tex.source);
    }

    /**
     * 场景卸载必调：把所有**按场景销毁**的纹理换回 Texture.WHITE。
     *
     * 本滤镜跨场景长活，而 uGroundD(照明载荷) / uDepthMap / uCollisionMap 都随场景销毁。
     * Pixi 的 BindGroup 监听所绑资源的 change 事件，一旦发现资源 destroyed 就把自己整个作废
     * (resources=null)，之后这个滤镜的任何 uniform 读写都抛。**必须先解绑再销毁纹理**，
     * 顺序反了就等于把滤镜烧掉——而调用方(照明就绪回调)被抛穿后，整份照明载荷会被 load()
     * 的 catch 丢弃，表现为"这张场景没光照 + 影子采到已销毁纹理直接崩"。
     */
    unbindSceneTextures(): void {
        const u = this._u;
        if (!u) return;
        const white = Texture.WHITE.source;
        const r = this.resources as Record<string, unknown>;
        r['uGroundD'] = white;
        r['uGroundDSampler'] = samplerOf(white);
        r['uDepthMap'] = white;
        r['uDepthMapSampler'] = samplerOf(white);
        r['uCollisionMap'] = white;
        r['uCollisionMapSampler'] = samplerOf(white);
        u['uHasGroundTex'] = 0;
    }
}
