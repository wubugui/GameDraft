import { Filter, GlProgram, GpuProgram, Texture } from 'pixi.js';
import type { SceneDepthConfig } from '../data/types';
import { depthLog, depthError } from '../core/depthLog';

const T = 'DepthFilter';

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

uniform vec2  uSceneSize;      // 场景世界宽高（worldWidth / worldHeight）
uniform float uProjectionScale; // Camera 投影 S，世界单位→屏幕像素
uniform float uWorldToPixelY;   // 世界Y → 背景纹理像素（与 isCollision 一致）
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uDepthPerSy;
uniform float uFloorOffset;
uniform float uFloorOffsetExtra;
uniform float uTolerance;
uniform vec2  uWorldContainerPos;
uniform float uEntityFootWorldY; // 精灵脚部世界坐标 Y
uniform float uDebug;          // 调试模式：1=输出调试颜色
/** F2：遮挡像素 alpha 乘数 [0,1]。0=discard；1=完全不裁 alpha（调试用） */
uniform float uOcclusionBlendFactor;
uniform float uFootDepthQ;     // 脚点行走面深度（实验室 uFootQ.z）
uniform float uHasFootDepth;   // 0=本帧没拿到脚深度 → 不遮挡
uniform float uFootBias;       // 实验室 0.045


void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);
    if (color.a < 0.004) { discard; }

    // 世界容器内位移（屏幕像素）≈ 世界坐标 × S
    float S = max(uProjectionScale, 1e-6);
    float sx = vScreenPos.x - uWorldContainerPos.x;
    float sy = vScreenPos.y - uWorldContainerPos.y;

    float wx = sx / S;
    float wy = sy / S;

    // 深度图与背景按世界归一化 UV 对齐
    vec2 depthUV = vec2(wx / uSceneSize.x, wy / uSceneSize.y);

    if (uHasFootDepth < 0.5 ||
        depthUV.x < 0.0 || depthUV.x > 1.0 || depthUV.y < 0.0 || depthUV.y > 1.0) {
        finalColor = color;        // 无行走面场 / 出界 → 不遮挡
        return;
    }

    vec4 depthSample = texture(uDepthMap, depthUV);
    float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;

    float d_raw = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
    float sceneDepth = d_raw * uScale + uOffset;

    // 精灵深度代理：**立在伪世界里的直立 quad**（uDepthPerSy = tanθ/ppu 就是它的深度梯度，
    // 往上越靠近相机）。
    // 脚点深度只认行走面场实测值——floor 拟合直线已废除（多层街巷可偏出 200+ 行地面），
    // 没有场就整段不遮挡（见 uHasFootDepth），绝不退回旧模型悄悄顶上。
    float syTexFoot = uEntityFootWorldY * uWorldToPixelY;
    float syTex = wy * uWorldToPixelY;
    float upright = uDepthPerSy * (syTex - syTexFoot);
    float spriteDepth = uFootDepthQ + upright + uFloorOffset + uFloorOffsetExtra - uFootBias;

    // ========== 调试模式 ==========
    if (uDebug > 0.5) {
        // 红=被遮挡 蓝=可见。碰撞通道已删:它靠 floor 拟合直线做逐像素反投影,
        // 那条线已废除;要看碰撞去实验室查看器的顶视图(世界 XZ,无遮挡无歧义)。
        finalColor = vec4(sceneDepth + uTolerance < spriteDepth
            ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0), 0.7);
        return;
    }
    // ========== 正常渲染 ==========

    // uTexture 采样为 Pixi 预乘 alpha（与 finalColor=color 通路一致）。
    // 仅改 a 会令合成仍按完整 rgb 参与预乘blend → 发亮/发白；须 rgb、a 同步乘系数。
    if (sceneDepth + uTolerance < spriteDepth) {
        if (uOcclusionBlendFactor < 1e-5) {
            discard;
        }
        finalColor = vec4(color.rgb * uOcclusionBlendFactor, color.a * uOcclusionBlendFactor);
        return;
    }

    finalColor = color;
}
`;

/**
 * WGSL 版(WebGPU 路径),与上面 VERT / FRAG 逐式对应;GLSL 一个字不动,WebGL 仍跑它。
 * 组 0 是 Pixi 滤镜约定(gfu + uTexture + uSampler);自己的资源在组 1,变量名 = resources 的键名,
 * uniform 结构体成员顺序 = JS 里 depthUniforms 的声明顺序(Pixi 按声明顺序排偏移)。
 * 分支里取样用 textureSampleLevel(.., 0.0)(WGSL 只许在一致控制流里 textureSample;深度图没有 mip,等价)。
 * 结构体里不写注释:Pixi 用正则解析结构体成员与 group 声明。
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

struct DepthUniforms {
    uSceneSize: vec2<f32>,
    uProjectionScale: f32,
    uWorldToPixelY: f32,
    uInvert: f32,
    uScale: f32,
    uOffset: f32,
    uDepthPerSy: f32,
    uFloorOffset: f32,
    uFloorOffsetExtra: f32,
    uTolerance: f32,
    uWorldContainerPos: vec2<f32>,
    uEntityFootWorldY: f32,
    uDebug: f32,
    uOcclusionBlendFactor: f32,
    uFootDepthQ: f32,
    uHasFootDepth: f32,
    uFootBias: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@group(1) @binding(0) var<uniform> depthUniforms: DepthUniforms;
@group(1) @binding(1) var uDepthMap: texture_2d<f32>;
@group(1) @binding(2) var uDepthMapSampler: sampler;

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
    var out: VSOutput;
    out.position = filterVertexPosition(aPosition);
    out.vTextureCoord = filterTextureCoord(aPosition);
    out.vScreenPos = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
    return out;
}

@fragment
fn mainFragment(
    @location(0) vTextureCoord: vec2<f32>,
    @location(1) vScreenPos: vec2<f32>,
) -> @location(0) vec4<f32> {
    let u = depthUniforms;
    let color = textureSample(uTexture, uSampler, vTextureCoord);
    if (color.a < 0.004) { discard; }

    // 世界容器内位移(屏幕像素)约等于 世界坐标 * S
    let S = max(u.uProjectionScale, 1e-6);
    let sx = vScreenPos.x - u.uWorldContainerPos.x;
    let sy = vScreenPos.y - u.uWorldContainerPos.y;
    let wx = sx / S;
    let wy = sy / S;

    // 深度图与背景按世界归一化 UV 对齐
    let depthUV = vec2<f32>(wx / u.uSceneSize.x, wy / u.uSceneSize.y);

    if (u.uHasFootDepth < 0.5 ||
        depthUV.x < 0.0 || depthUV.x > 1.0 || depthUV.y < 0.0 || depthUV.y > 1.0) {
        return color;
    }

    let depthSample = textureSampleLevel(uDepthMap, uDepthMapSampler, depthUV, 0.0);
    let rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
    var d_raw = rawDepth;
    if (u.uInvert > 0.5) { d_raw = 1.0 - rawDepth; }
    let sceneDepth = d_raw * u.uScale + u.uOffset;

    // 精灵深度代理:立在伪世界里的直立 quad(见 GLSL 注释),脚点深度只认行走面场实测值
    let syTexFoot = u.uEntityFootWorldY * u.uWorldToPixelY;
    let syTex = wy * u.uWorldToPixelY;
    let upright = u.uDepthPerSy * (syTex - syTexFoot);
    let spriteDepth = u.uFootDepthQ + upright + u.uFloorOffset + u.uFloorOffsetExtra - u.uFootBias;

    if (u.uDebug > 0.5) {
        if (sceneDepth + u.uTolerance < spriteDepth) { return vec4<f32>(1.0, 0.0, 0.0, 0.7); }
        return vec4<f32>(0.0, 0.0, 1.0, 0.7);
    }

    // uTexture 是预乘 alpha:rgb 与 a 同步乘系数
    if (sceneDepth + u.uTolerance < spriteDepth) {
        if (u.uOcclusionBlendFactor < 1e-5) { discard; }
        return vec4<f32>(color.rgb * u.uOcclusionBlendFactor, color.a * u.uOcclusionBlendFactor);
    }

    return color;
}
`;

let sharedProgram: GlProgram | null = null;
let sharedGpuProgram: GpuProgram | null = null;

function getSharedGpuProgram(): GpuProgram {
    if (!sharedGpuProgram) {
        sharedGpuProgram = GpuProgram.from({
            vertex: { source: WGSL, entryPoint: 'mainVertex' },
            fragment: { source: WGSL, entryPoint: 'mainFragment' },
        });
    }
    return sharedGpuProgram;
}

function getSharedProgram(): GlProgram {
    if (!sharedProgram) {
        try {
            sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
            depthLog(T, 'GlProgram created OK');
        } catch (e) {
            depthError(T, 'GlProgram creation FAILED', e);
            throw e;
        }
    }
    return sharedProgram;
}

/** 调试：强制创建共享 GlProgram，便于随后对 gl.getError 做 drain */
export function warmUpDepthOcclusionGlProgramForDiagnostics(): GlProgram {
    return getSharedProgram();
}

export class DepthOcclusionFilter extends Filter {
    readonly _isDepthOcclusion = true;

    private constructor(depthTexture: Texture, cfg: SceneDepthConfig) {
        depthLog(T, 'constructor depthTex size:', depthTexture.width, 'x', depthTexture.height);
        depthLog(T, 'cfg.depth_mapping:', cfg.depth_mapping);
        depthLog(T, 'cfg.shader:', cfg.shader);

        const program = getSharedProgram();

        super({
            glProgram: program,
            gpuProgram: getSharedGpuProgram(),
            resources: {
                depthUniforms: {
                    uSceneSize: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
                    uProjectionScale: { value: 1, type: 'f32' },
                    uWorldToPixelY: { value: 1, type: 'f32' },
                    uInvert: { value: cfg.depth_mapping.invert ? 1.0 : 0.0, type: 'f32' },
                    uScale: { value: cfg.depth_mapping.scale, type: 'f32' },
                    uOffset: { value: cfg.depth_mapping.offset, type: 'f32' },
                    uDepthPerSy: { value: cfg.shader.depth_per_sy, type: 'f32' },
                    uFloorOffset: { value: cfg.floor_offset, type: 'f32' },
                    uFloorOffsetExtra: { value: 0, type: 'f32' },
                    uTolerance: { value: cfg.depth_tolerance, type: 'f32' },
                    uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
                    uEntityFootWorldY: { value: 0, type: 'f32' },
                    uDebug: { value: 0, type: 'f32' },
                    uOcclusionBlendFactor: { value: 0, type: 'f32' },
                    uFootDepthQ: { value: 0, type: 'f32' },
                    uHasFootDepth: { value: 0, type: 'f32' },
                    uFootBias: { value: 0.045, type: 'f32' },
                },
                uDepthMap: depthTexture.source,
                // WGSL 的采样器:深度图自己的 style(WebGL 用纹理自带采样状态,不认这个键)
                uDepthMapSampler: depthTexture.source.style,
            },
        });

        depthLog(T, 'super() OK, resources keys:', Object.keys(this.resources));
        const du = (this.resources as Record<string, { uniforms?: Record<string, unknown> }>)['depthUniforms'];
        if (du?.uniforms) {
            depthLog(T, 'uniforms keys:', Object.keys(du.uniforms));
        } else {
            depthError(T, 'depthUniforms.uniforms MISSING after super()');
        }
    }

    static createForEntity(depthTexture: Texture, cfg: SceneDepthConfig): DepthOcclusionFilter {
        depthLog(T, 'createForEntity called');
        try {
            const f = new DepthOcclusionFilter(depthTexture, cfg);
            depthLog(T, 'createForEntity OK');
            return f;
        } catch (e) {
            depthError(T, 'createForEntity FAILED', e);
            throw e;
        }
    }

    private get _du() {
        return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)['depthUniforms']?.uniforms;
    }

    setSceneSize(w: number, h: number): void {
        const u = this._du;
        if (u) {
            const arr = u['uSceneSize'] as Float32Array;
            arr[0] = w; arr[1] = h;
        } else {
            depthError(T, 'setSceneSize: _du null');
        }
    }

    setWorldContainerPos(x: number, y: number): void {
        const u = this._du;
        if (u) {
            const arr = u['uWorldContainerPos'] as Float32Array;
            arr[0] = x; arr[1] = y;
        }
    }

    setProjectionScale(s: number): void {
        const u = this._du;
        if (u) u['uProjectionScale'] = s;
    }

    setWorldToPixel(_tx: number, ty: number): void {
        const u = this._du;
        if (u) {
            u['uWorldToPixelY'] = ty;
        }
    }

    /** 脚部世界坐标 Y（与 Player/NPC 的 y 一致） */
    setEntityFootY(worldY: number): void {
        const u = this._du;
        if (u) u['uEntityFootWorldY'] = worldY;
    }

    setTolerance(v: number): void {
        const u = this._du;
        if (u) u['uTolerance'] = v;
    }

    setFloorOffset(v: number): void {
        const u = this._du;
        if (u) u['uFloorOffset'] = v;
    }

    /** 按实体叠加的 floor 偏移（depth_floor 区等），与场景 floor_offset 相加 */
    setFloorOffsetExtra(v: number): void {
        const u = this._du;
        if (u) u['uFloorOffsetExtra'] = v;
    }

    setDebug(on: boolean): void {
        const u = this._du;
        if (u) u['uDebug'] = on ? 1.0 : 0.0;
    }

    /** 被遮挡时精灵 alpha 乘数；0=discard */
    setOcclusionBlendFactor(v: number): void {
        const u = this._du;
        if (u) u['uOcclusionBlendFactor'] = Math.min(1, Math.max(0, v));
    }

    /** 脚点行走面深度（实验室 uFootQ.z）；null = 回落旧的 floor 直线口径 */
    setFootDepthQ(v: number | null): void {
        const u = this._du;
        if (!u) return;
        if (v === null || !Number.isFinite(v)) { u['uHasFootDepth'] = 0; return; }
        u['uFootDepthQ'] = v;
        u['uHasFootDepth'] = 1;
    }

    /** 脚点遮挡偏置（实验室常数 0.045） */
    setFootBias(v: number): void {
        const u = this._du;
        if (u) u['uFootBias'] = Math.max(0, v);
    }
}
