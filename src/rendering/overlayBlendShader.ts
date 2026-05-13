import 'pixi.js/mesh';
import { Mesh, MeshGeometry, Shader, Texture } from 'pixi.js';

/**
 * 顶点变换与 Pixi v8 默认 Mesh shader 完全一致（见 high-shader/defaultProgramTemplate 的 vertexGlTemplate）：
 *   modelMatrix = uTransformMatrix; // 来自 localUniformBit
 *   mvp = uProjectionMatrix * uWorldTransformMatrix * modelMatrix;
 *   gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
 *
 * 这三个 mat3 uniform 由 Pixi 的 Mesh 渲染管线（GlMeshAdaptor / GpuMeshAdapter）在渲染时自动绑定到 shader：
 *   - globalUniforms.bindGroup  -> slot 100（uProjectionMatrix / uWorldTransformMatrix / uWorldColorAlpha / uResolution）
 *   - meshPipe.localUniformsBindGroup -> slot 101（uTransformMatrix / uColor / uRound）
 * 这样自定义 shader 下的 Mesh 与同父容器下的 Sprite 共享一套投影与世界变换，避免两条路径在窗口 resize、
 * 渲染到 RenderTexture、父容器变换等场景下出现错位（与 showOverlayImage 的 Sprite 对齐）。
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
 * 单 Mesh + 双纹理 shader：片元 mix(from, to, t)。
 * 几何以 Mesh 的 local 像素坐标给出（Pixi Sprite 同一套空间），投影/世界变换由 Pixi 自动注入的 uniform 负责，
 * 与 `CutsceneRenderer.showPercentImg` 的 Sprite 保持像素对齐。
 */
export function createOverlayBlendMesh(
  texFrom: Texture,
  texTo: Texture,
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
