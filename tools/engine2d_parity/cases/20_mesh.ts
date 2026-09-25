import type { Case, Env } from '../harness';

const GLSL_VERT = `
in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
}`;
const GLSL_FRAG = `
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uTex;
uniform vec4 uTint;
uniform float uGain;
void main() {
  vec4 c = texture(uTex, vUV);
  finalColor = vec4(c.rgb * uTint.rgb * uGain, c.a) * uTint.a;
}`;
const WGSL = `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> }
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 }
struct Params { uTint: vec4<f32>, uGain: f32 }
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@group(2) @binding(0) var<uniform> params: Params;
@group(2) @binding(1) var uTex: texture_2d<f32>;
@group(2) @binding(2) var uTexSampler: sampler;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VOut {
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return VOut(vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0), aUV);
}
@fragment fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(uTex, uTexSampler, uv);
  return vec4<f32>(c.rgb * params.uTint.rgb * params.uGain, c.a) * params.uTint.a;
}`;

function makeMesh(env: Env, x: number, y: number, seed: number) {
  const { lib } = env;
  const tex = env.dataTexture({ width: 16, height: 16, seed, scaleMode: 'linear' });
  const geometry = new lib.MeshGeometry({
    positions: new Float32Array([0, 0, 40, 0, 44, 36, -4, 30]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
  const shader = lib.Shader.from({
    gl: { vertex: GLSL_VERT, fragment: GLSL_FRAG },
    gpu: { vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } },
    resources: {
      uTex: tex.source,
      uTexSampler: tex.source.style,
      params: {
        uTint: { value: new Float32Array([0.9, 0.7, 0.5, 0.8]), type: 'vec4<f32>' },
        uGain: { value: 1.2, type: 'f32' },
      },
    },
  });
  const mesh = new lib.Mesh({ geometry, shader });
  mesh.position.set(x, y);
  return mesh;
}

export const cases: Case[] = [
  {
    name: '网格 / 自定义着色器 + UniformGroup + 局部 / 全局变换',
    width: 128,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const m1 = makeMesh(env, 8, 8, 50);
      const m2 = makeMesh(env, 70, 20, 51);
      m2.rotation = 0.4;
      m2.scale.set(1.2, 0.9);
      root.addChild(m1, m2);
      root.position.set(4, 3);
      return root;
    },
  },
  {
    name: '网格 / 自定义着色器 + add 混合',
    width: 96,
    height: 64,
    tolerance: 2 / 255,
    clearColor: [0.1, 0.1, 0.2, 1],
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const m = makeMesh(env, 10, 10, 52);
      m.blendMode = 'add';
      root.addChild(m);
      return root;
    },
  },
  {
    name: 'MeshPlane / 缺省网格(合批 ≤100 顶点)',
    width: 96,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const tex = env.dataTexture({ width: 32, height: 32, seed: 60, scaleMode: 'linear' });
      const plane = new lib.MeshPlane({ texture: tex, verticesX: 6, verticesY: 6 });
      plane.position.set(10, 10);
      const pos = plane.geometry.positions;
      for (let i = 0; i < pos.length; i += 2) pos[i + 1] += Math.sin(pos[i] * 0.3) * 3;
      plane.geometry.getBuffer('aPosition').update();
      plane.tint = 0xddeeff;
      root.addChild(plane);
      return root;
    },
  },
  {
    name: 'MeshPlane / 缺省网格(不合批 >100 顶点)',
    width: 96,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const tex = env.dataTexture({ width: 32, height: 32, seed: 61, scaleMode: 'linear' });
      const plane = new lib.MeshPlane({ texture: tex, verticesX: 12, verticesY: 12 });
      plane.position.set(20, 8);
      plane.alpha = 0.8;
      root.addChild(plane);
      return root;
    },
  },
];
