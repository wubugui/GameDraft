import 'pixi.js/mesh';
import { BufferImageSource, Mesh, MeshGeometry, Shader, Texture } from 'pixi.js';
import type { BreathingOverlayRig } from '../data/breathingOverlays';
import BREATHING_SHADE_SRC from './breathingShade.glsl?raw';
import BREATHING_SHADE_WGSL from './breathingShade.wgsl?raw';
import { breathingStaticUniforms, sliceBreathingShade } from './breathingUniforms';
import { OVERLAY_QUAD_WGSL_VERTEX } from './overlayBlendShader';

/**
 * 呼吸图的渲染:一张 Mesh(与 showOverlayImage 的 Sprite 同一套 local 像素空间,顶点变换同 overlayBlendShader)
 * + `breathingShade.glsl`(呼吸工作台拼的是同一份),每帧按表演模拟的输出把静帧的几层重新合出来。
 * 每帧变的 uniform 由 `breathingUniforms()` 算(工作台同一份)。
 */

const VERT = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

out vec2 vUV;

void main(void) {
    mat3 modelMatrix = uTransformMatrix;
    mat3 modelViewProjectionMatrix = uProjectionMatrix * uWorldTransformMatrix * modelMatrix;
    gl_Position = vec4((modelViewProjectionMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
}
`;

const FRAG = /* glsl */ `
in vec2 vUV;
out vec4 finalColor;
${sliceBreathingShade(BREATHING_SHADE_SRC)}
void main(void) {
    finalColor = vec4(breathingShade(vUV), 1.0);
}
`;

/**
 * WebGPU 版:顶点同 overlayBlendShader 的四边形(group 0/1 = Pixi 的 globalUniforms / localUniforms),
 * 着色本体是 `breathingShade.wgsl`(与 .glsl 逐句对应;.glsl 给工作台切片,原样不动)。
 */
const WGSL = OVERLAY_QUAD_WGSL_VERTEX + BREATHING_SHADE_WGSL + /* wgsl */ `
@fragment
fn mainFragment(@location(0) vUV: vec2<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(breathingShade(vUV), 1.0);
}
`;

export interface BreathingLayerTextures {
  base: Texture;
  body?: Texture | null;
  sheet?: Texture | null;
  flap?: Texture | null;
  /** 两张位移场(RGBA16F 半精度) */
  field1: Texture;
  field2: Texture;
}

/** 从 .bin(两张 RGBA16F 背靠背,小端)建两张位移场纹理 */
export function createBreathingFieldTextures(bytes: ArrayBuffer, width: number, height: number): { field1: Texture; field2: Texture } {
  const per = width * height * 4;
  if (bytes.byteLength !== per * 2 * 2) {
    throw new Error(`呼吸图位移场尺寸不对:期望 ${per * 4} 字节(${width}×${height}×RGBA16F×2),实际 ${bytes.byteLength}`);
  }
  const mk = (offsetHalfs: number): Texture => new Texture({
    source: new BufferImageSource({
      resource: new Uint16Array(bytes, offsetHalfs * 2, per),
      width,
      height,
      format: 'rgba16float',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'linear',
      addressMode: 'clamp-to-edge',
    }),
  });
  return { field1: mk(0), field2: mk(per) };
}

export interface BreathingOverlayMeshHandle {
  mesh: Mesh;
  /** 把一帧的 uniform 喂进去(`breathingUniforms()` 的输出) */
  apply: (u: Record<string, number>) => void;
  /** Pixi 8 的 Mesh.destroy 只解引用 geometry/shader,须在销毁 mesh 后显式调用 */
  disposeGpu: () => void;
}

export function createBreathingOverlayMesh(
  tex: BreathingLayerTextures,
  rig: BreathingOverlayRig,
  size: [number, number],
  cx: number,
  cy: number,
  dispW: number,
  dispH: number,
  /**
   * 几层贴图的 rgb 是不是已经 ×alpha。游戏走 AssetManager 默认装载 = 是(浏览器在 createImageBitmap 解码期就预乘了,
   * GL 层 alphaMode 救不回,见 pixi-v8-traps);工作台页面自己 texImage2D 不预乘 = 否。
   */
  layersPremultiplied = true,
): BreathingOverlayMeshHandle {
  const x0 = cx - dispW * 0.5, x1 = cx + dispW * 0.5, y0 = cy - dispH * 0.5, y1 = cy + dispH * 0.5;
  const geometry = new MeshGeometry({
    positions: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const empty = Texture.EMPTY;
  const st = breathingStaticUniforms(rig, size, layersPremultiplied);
  const shader = Shader.from({
    gl: { vertex: VERT, fragment: FRAG },
    gpu: {
      vertex: { source: WGSL, entryPoint: 'mainVertex' },
      fragment: { source: WGSL, entryPoint: 'mainFragment' },
    },
    resources: {
      // ⚠ 成员顺序 = breathingShade.wgsl 里 BreathingUniforms 的成员顺序(WebGPU 按声明顺序排偏移)
      breathingUniforms: {
        uSize: { value: new Float32Array(st.uSize), type: 'vec2<f32>' },
        uInfl: { value: 0, type: 'f32' },
        uFlapAng: { value: 0, type: 'f32' },
        uShade: { value: 0, type: 'f32' },
        uVentPx: { value: 0, type: 'f32' },
        uCranPx: { value: 0, type: 'f32' },
        uL: { value: st.uL, type: 'f32' },
        uRoot: { value: new Float32Array(st.uRoot), type: 'vec2<f32>' },
        uRootDisp: { value: new Float32Array(st.uRootDisp), type: 'vec2<f32>' },
        uN0: { value: new Float32Array(st.uN0), type: 'vec2<f32>' },
        uLamp: { value: new Float32Array(st.uLamp), type: 'vec2<f32>' },
        uPremul: { value: st.uPremul, type: 'f32' },
      },
      uBase: tex.base.source,
      uBaseSampler: tex.base.source.style,
      uBody: (tex.body ?? empty).source,
      uBodySampler: (tex.body ?? empty).source.style,
      uSheet: (tex.sheet ?? empty).source,
      uSheetSampler: (tex.sheet ?? empty).source.style,
      uFlap: (tex.flap ?? empty).source,
      uFlapSampler: (tex.flap ?? empty).source.style,
      uF1: tex.field1.source,
      uF1Sampler: tex.field1.source.style,
      uF2: tex.field2.source,
      uF2Sampler: tex.field2.source.style,
    },
  });
  // Pixi v8 Mesh 管线会读取 mesh.texture(及 source.alphaMode);仅传 shader 时 texture 为 null 会报错
  const mesh = new Mesh({ geometry, shader, texture: tex.base }) as Mesh;
  const apply = (u: Record<string, number>): void => {
    // shader.destroy 后 resources 为 null(换层 / 收掉的竞态下可能仍有在途一帧),静默忽略
    const res = shader.resources as Record<string, { uniforms?: Record<string, unknown> }> | null;
    const g = res?.['breathingUniforms']?.uniforms;
    if (!g) return;
    for (const [k, v] of Object.entries(u)) g[k] = v;
  };
  const disposeGpu = (): void => {
    geometry.destroy();
    shader.destroy();
  };
  return { mesh, apply, disposeGpu };
}
