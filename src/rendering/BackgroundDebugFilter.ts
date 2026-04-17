import { Filter, GlProgram, Texture } from 'pixi.js';
import type { SceneDepthConfig } from '../data/types';

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
uniform float uFloorA;
uniform float uFloorB;

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

        float dFloor = uFloorA * texY + uFloorB;
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

let sharedProgram: GlProgram | null = null;

function getProgram(): GlProgram {
    if (!sharedProgram) {
        sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
    }
    return sharedProgram;
}

/** 调试：强制创建共享 GlProgram，便于随后对 gl.getError 做 drain */
export function warmUpBackgroundDebugGlProgramForDiagnostics(): GlProgram {
    return getProgram();
}

export class BackgroundDebugFilter extends Filter {
    constructor() {
        const placeholder = Texture.WHITE;
        super({
            glProgram: getProgram(),
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
                    uFloorA: { value: 0, type: 'f32' },
                    uFloorB: { value: 0, type: 'f32' },
                    uCol_xMin: { value: 0, type: 'f32' },
                    uCol_zMin: { value: 0, type: 'f32' },
                    uCol_cellSize: { value: 1, type: 'f32' },
                    uCol_gridW: { value: 0, type: 'f32' },
                    uCol_gridH: { value: 0, type: 'f32' },
                    uDbgDepthLo: { value: -1, type: 'f32' },
                    uDbgDepthHi: { value: 1, type: 'f32' },
                },
                uDepthMap: placeholder.source,
                uCollisionMap: placeholder.source,
            },
        });
    }

    private get _u() {
        return (this.resources as Record<string, { uniforms: Record<string, unknown> }>)['bgDebug']?.uniforms;
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

        u['uFloorA'] = cfg.shader.floor_depth_A;
        u['uFloorB'] = cfg.shader.floor_depth_B;

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

    setCollisionTexture(tex: Texture): void {
        (this.resources as Record<string, unknown>)['uCollisionMap'] = tex.source;
    }
}
