import 'pixi.js/mesh';
import { Mesh, MeshGeometry, Shader, Texture } from 'pixi.js';

const VERT = /* glsl */ `
in vec2 aPosition;
in vec2 aUV;

uniform vec2 uResolution;
out vec2 vUV;

void main(void) {
    vec2 p = aPosition;
    float nx = p.x / max(uResolution.x, 1.0) * 2.0 - 1.0;
    float ny = -(p.y / max(uResolution.y, 1.0) * 2.0 - 1.0);
    gl_Position = vec4(nx, ny, 0.0, 1.0);
    vUV = aUV;
}
`;

const FRAG = /* glsl */ `
in vec2 vUV;
out vec4 finalColor;

uniform sampler2D uTextureFrom;
uniform sampler2D uTextureTo;
uniform float uT;

void main(void) {
    vec4 a = texture(uTextureFrom, vUV);
    vec4 b = texture(uTextureTo, vUV);
    finalColor = mix(a, b, clamp(uT, 0.0, 1.0));
}
`;

export interface OverlayBlendMeshHandle {
  /** 自定义 Shader 的 Mesh，运行时类型为 Mesh<MeshGeometry, Shader> */
  mesh: Mesh;
  setT: (t: number) => void;
}

/**
 * 单 Mesh + 双纹理 shader：片元 mix(from, to, t)。几何尺寸为屏幕像素，与 cutsceneOverlay 对齐。
 */
export function createOverlayBlendMesh(
  texFrom: Texture,
  texTo: Texture,
  screenW: number,
  screenH: number,
  cx: number,
  cy: number,
  dispW: number,
  dispH: number,
): OverlayBlendMeshHandle {
  const hw = dispW * 0.5;
  const hh = dispH * 0.5;
  const x0 = cx - hw;
  const x1 = cx + hw;
  const y0 = cy - hh;
  const y1 = cy + hh;

  const positions = new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  const geometry = new MeshGeometry({ positions, uvs, indices });

  const shader = Shader.from({
    gl: { vertex: VERT, fragment: FRAG },
    resources: {
      blendUniforms: {
        uT: { value: 0, type: 'f32' },
        uResolution: { value: new Float32Array([screenW, screenH]), type: 'vec2<f32>' },
      },
      uTextureFrom: texFrom.source,
      uTextureTo: texTo.source,
    },
  });

  // Pixi v8 Mesh 管线会读取 mesh.texture（及 source.alphaMode）；仅传 shader 时 texture 为 null会报错。
  const mesh = new Mesh({ geometry, shader, texture: texTo }) as Mesh;

  const setT = (t: number): void => {
    const clamped = Math.max(0, Math.min(1, t));
    const u = (shader.resources as Record<string, { uniforms?: Record<string, unknown> }>)['blendUniforms']?.uniforms;
    if (u) {
      /** Pixi 初始化后标量 uniform 多为裸 number，与 DepthOcclusionFilter 一致直接赋值 */
      u['uT'] = clamped;
    }
  };

  return { mesh, setT };
}
