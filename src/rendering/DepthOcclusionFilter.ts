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

uniform vec2  uSceneSize;
uniform float uInvert;
uniform float uScale;
uniform float uOffset;
uniform float uDepthPerSy;
uniform float uFloorA;
uniform float uFloorB;
uniform float uFloorOffset;
uniform float uTolerance;
uniform vec2  uWorldContainerPos;
uniform float uEntityFootY;

void main(void) {
    vec4 color = texture(uTexture, vTextureCoord);
    if (color.a < 0.004) { discard; }

    float sx = vScreenPos.x - uWorldContainerPos.x;
    float sy = vScreenPos.y - uWorldContainerPos.y;

    vec2 depthUV = vec2(sx / uSceneSize.x, sy / uSceneSize.y);

    if (depthUV.x < 0.0 || depthUV.x > 1.0 || depthUV.y < 0.0 || depthUV.y > 1.0) {
        finalColor = color;
        return;
    }

    vec4 depthSample = texture(uDepthMap, depthUV);
    float rawDepth = (depthSample.r * 255.0 * 256.0 + depthSample.g * 255.0) / 65535.0;

    float d_raw = uInvert > 0.5 ? 1.0 - rawDepth : rawDepth;
    float sceneDepth = d_raw * uScale + uOffset;

    float footSy = uEntityFootY;
    float d_base = uFloorA * footSy + uFloorB + uFloorOffset;

    float spriteDepth = d_base + uDepthPerSy * (sy - footSy);

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
                    uInvert: { value: cfg.depth_mapping.invert ? 1.0 : 0.0, type: 'f32' },
                    uScale: { value: cfg.depth_mapping.scale, type: 'f32' },
                    uOffset: { value: cfg.depth_mapping.offset, type: 'f32' },
                    uDepthPerSy: { value: cfg.shader.depth_per_sy, type: 'f32' },
                    uFloorA: { value: cfg.shader.floor_depth_A, type: 'f32' },
                    uFloorB: { value: cfg.shader.floor_depth_B, type: 'f32' },
                    uFloorOffset: { value: cfg.floor_offset, type: 'f32' },
                    uTolerance: { value: cfg.depth_tolerance, type: 'f32' },
                    uWorldContainerPos: { value: new Float32Array([0, 0]), type: 'vec2<f32>' },
                    uEntityFootY: { value: 0, type: 'f32' },
                },
                uDepthMap: depthTexture.source,
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

    setEntityFootY(y: number): void {
        const u = this._du;
        if (u) u['uEntityFootY'] = y;
    }

    setTolerance(v: number): void {
        const u = this._du;
        if (u) u['uTolerance'] = v;
    }

    setFloorOffset(v: number): void {
        const u = this._du;
        if (u) u['uFloorOffset'] = v;
    }
}
