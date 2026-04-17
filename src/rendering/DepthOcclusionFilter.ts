import { Filter, GlProgram, Texture } from 'pixi.js';
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
uniform float uWorldToPixelX;   // 世界X → 背景纹理像素
uniform float uWorldToPixelY;   // 世界Y → 背景纹理像素（与 isCollision 一致）
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uDepthPerSy;
uniform float uFloorA;
uniform float uFloorB;
uniform float uFloorOffset;
uniform float uFloorOffsetExtra;
uniform float uTolerance;
uniform vec2  uWorldContainerPos;
uniform float uEntityFootWorldY; // 精灵脚部世界坐标 Y
uniform float uDebug;          // 调试模式：1=输出调试颜色

// M矩阵参数（像素→伪3D，仅调试用）
uniform float uM_ppu;
uniform float uM_cx;
uniform float uM_cy;
uniform float uM_R00; uniform float uM_R01; uniform float uM_R02;
uniform float uM_R20; uniform float uM_R21; uniform float uM_R22;
uniform float uCol_xMin;
uniform float uCol_zMin;
uniform float uCol_cellSize;
uniform float uCol_gridW;
uniform float uCol_gridH;
uniform sampler2D uCollisionMap;

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

    if (depthUV.x < 0.0 || depthUV.x > 1.0 || depthUV.y < 0.0 || depthUV.y > 1.0) {
        finalColor = color;
        return;
    }

    vec4 depthSample = texture(uDepthMap, depthUV);
    float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;

    float d_raw = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
    float sceneDepth = d_raw * uScale + uOffset;

    // 精灵立面深度：floor / depth_per_sy 按背景纹理像素 sy 标定（与 isCollision 一致）
    float footWy = uEntityFootWorldY;
    float syTexFoot = footWy * uWorldToPixelY;
    float syTex = wy * uWorldToPixelY;
    float d_base = uFloorA * syTexFoot + uFloorB + uFloorOffset + uFloorOffsetExtra;
    float spriteDepth = d_base + uDepthPerSy * (syTex - syTexFoot);

    // ========== 调试模式 ==========
    if (uDebug > 0.5) {
        vec3 dbgColor = vec3(0.0);

        float sxTex = wx * uWorldToPixelX;
        float syTexDbg = wy * uWorldToPixelY;
        float ppx = (sxTex - uM_cx) / uM_ppu;
        float ppy = (uM_cy - syTexDbg) / uM_ppu;
        float dFloor = uFloorA * syTexDbg + uFloorB;
        float wx = uM_R00 * ppx + uM_R01 * ppy + uM_R02 * dFloor;
        float wz = uM_R20 * ppx + uM_R21 * ppy + uM_R22 * dFloor;
        float gx = (wx - uCol_xMin) / uCol_cellSize;
        float gz = (wz - uCol_zMin) / uCol_cellSize;

        float isCollision = 0.0;
        if (gx >= 0.0 && gx < uCol_gridW && gz >= 0.0 && gz < uCol_gridH) {
            vec2 colUV = vec2(gx / uCol_gridW, gz / uCol_gridH);
            vec4 colSample = texture(uCollisionMap, colUV);
            isCollision = colSample.r > 0.5 ? 1.0 : 0.0;
        }

        // 遮挡检测
        float isOccluded = sceneDepth + uTolerance < spriteDepth ? 1.0 : 0.0;

        dbgColor.r = isOccluded;
        dbgColor.g = isCollision;

        finalColor = vec4(dbgColor, 0.7);
        return;
    }
    // ========== 正常渲染 ==========

    if (sceneDepth + uTolerance < spriteDepth) {
        discard;
    }

    finalColor = color;
}
`;

let sharedProgram: GlProgram | null = null;

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
            resources: {
                depthUniforms: {
                    uSceneSize: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
                    uProjectionScale: { value: 1, type: 'f32' },
                    uWorldToPixelX: { value: 1, type: 'f32' },
                    uWorldToPixelY: { value: 1, type: 'f32' },
                    uInvert: { value: cfg.depth_mapping.invert ? 1.0 : 0.0, type: 'f32' },
                    uScale: { value: cfg.depth_mapping.scale, type: 'f32' },
                    uOffset: { value: cfg.depth_mapping.offset, type: 'f32' },
                    uDepthPerSy: { value: cfg.shader.depth_per_sy, type: 'f32' },
                    uFloorA: { value: cfg.shader.floor_depth_A, type: 'f32' },
                    uFloorB: { value: cfg.shader.floor_depth_B, type: 'f32' },
                    uFloorOffset: { value: cfg.floor_offset, type: 'f32' },
                    uFloorOffsetExtra: { value: 0, type: 'f32' },
                    uTolerance: { value: cfg.depth_tolerance, type: 'f32' },
                    uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
                    uEntityFootWorldY: { value: 0, type: 'f32' },
                    uDebug: { value: 0, type: 'f32' },
                    // M矩阵（调试用）
                    uM_ppu: { value: cfg.M.ppu, type: 'f32' },
                    uM_cx: { value: cfg.M.cx, type: 'f32' },
                    uM_cy: { value: cfg.M.cy, type: 'f32' },
                    uM_R00: { value: cfg.M.R[0][0], type: 'f32' },
                    uM_R01: { value: cfg.M.R[0][1], type: 'f32' },
                    uM_R02: { value: cfg.M.R[0][2], type: 'f32' },
                    uM_R20: { value: cfg.M.R[2][0], type: 'f32' },
                    uM_R21: { value: cfg.M.R[2][1], type: 'f32' },
                    uM_R22: { value: cfg.M.R[2][2], type: 'f32' },
                    // 碰撞网格（调试用）
                    uCol_xMin: { value: cfg.collision?.x_min ?? 0, type: 'f32' },
                    uCol_zMin: { value: cfg.collision?.z_min ?? 0, type: 'f32' },
                    uCol_cellSize: { value: cfg.collision?.cell_size ?? 1, type: 'f32' },
                    uCol_gridW: { value: cfg.collision?.grid_width ?? 0, type: 'f32' },
                    uCol_gridH: { value: cfg.collision?.grid_height ?? 0, type: 'f32' },
                },
                uDepthMap: depthTexture.source,
                // collision texture set later via setCollisionTexture
                // using depth texture as placeholder so the shader has a valid sampler
                uCollisionMap: depthTexture.source,
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

    setWorldToPixel(tx: number, ty: number): void {
        const u = this._du;
        if (u) {
            u['uWorldToPixelX'] = tx;
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

    setCollisionTexture(tex: Texture): void {
        (this.resources as Record<string, unknown>)['uCollisionMap'] = tex.source;
    }
}
