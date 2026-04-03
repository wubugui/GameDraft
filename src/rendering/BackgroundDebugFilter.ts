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
        // --- 深度可视化（分层色带, 每 5 个深度单位循环一次） ---
        vec4 depthSample = texture(uDepthMap, uv);
        float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;
        float d = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
        float depth = d * uScale + uOffset;
        float band = fract(depth);
        finalColor = vec4(band, band * 0.3, 0.0, 1.0);

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
