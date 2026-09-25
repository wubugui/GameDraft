import type { Case, Env } from '../harness';

const VERT_GLSL = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0*uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
vec2 filterTextureCoord(void) { return aPosition * (uOutputFrame.zw * uInputSize.zw); }
void main(void) { gl_Position = filterVertexPosition(); vTextureCoord = filterTextureCoord(); }`;

const FRAG_GLSL = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputClamp;
uniform vec4 uInputSize;
uniform vec3 uMix;
uniform float uShift;
void main(void) {
  vec2 uv = clamp(vTextureCoord + vec2(uShift * uInputSize.z, 0.0), uInputClamp.xy, uInputClamp.zw);
  vec4 c = texture(uTexture, uv);
  finalColor = vec4(c.rgb * uMix, c.a);
}`;

const WGSL = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>, uInputPixel: vec4<f32>, uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>, uGlobalFrame: vec4<f32>, uOutputTexture: vec4<f32>,
};
struct Params { uMix: vec3<f32>, uShift: f32 };
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> params: Params;
struct VSOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw));
}
@fragment fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let p = clamp(uv + vec2<f32>(params.uShift * gfu.uInputSize.z, 0.0), gfu.uInputClamp.xy, gfu.uInputClamp.zw);
  let c = textureSample(uTexture, uSampler, p);
  return vec4<f32>(c.rgb * params.uMix, c.a);
}`;

function makeFilter(env: Env, mix: [number, number, number], shift: number, extra: Record<string, unknown> = {}) {
  const { lib } = env;
  return lib.Filter.from({
    gl: { vertex: VERT_GLSL, fragment: FRAG_GLSL },
    gpu: { vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } },
    resources: {
      params: {
        uMix: { value: new Float32Array(mix), type: 'vec3<f32>' },
        uShift: { value: shift, type: 'f32' },
      },
    },
    ...extra,
  });
}

function scene(env: Env) {
  const { lib } = env;
  const g = new lib.Container();
  for (let i = 0; i < 3; i++) {
    const s = new lib.Sprite(env.dataTexture({ width: 20, height: 20, seed: 70 + i }));
    s.position.set(10 + i * 18, 8 + i * 9);
    s.rotation = i * 0.3;
    g.addChild(s);
  }
  return g;
}

export const cases: Case[] = [
  {
    name: '滤镜 / 单个自定义滤镜(区域 = 子树包围盒)',
    width: 112,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const g = scene(env);
      g.filters = [makeFilter(env, [1.2, 0.8, 0.6], 2)];
      root.addChild(g);
      return root;
    },
  },
  {
    name: '滤镜 / 两个串联 + padding',
    width: 112,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const g = scene(env);
      g.position.set(6, 4);
      g.filters = [makeFilter(env, [1, 0.5, 1], 1, { padding: 4 }), makeFilter(env, [0.7, 1, 1.3], -2)];
      root.addChild(g);
      return root;
    },
  },
  {
    name: '滤镜 / 嵌套(外层滤镜内再有滤镜)+ filterArea',
    width: 112,
    height: 80,
    tolerance: 2 / 255,
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const outer = new lib.Container();
      const inner = scene(env);
      inner.filters = [makeFilter(env, [1.3, 1, 0.7], 1)];
      outer.addChild(inner);
      const other = new lib.Sprite(env.dataTexture({ width: 24, height: 24, seed: 80 }));
      other.position.set(70, 40);
      outer.addChild(other);
      outer.filters = [makeFilter(env, [0.8, 0.9, 1.2], 0)];
      outer.filterArea = new lib.Rectangle(0, 0, 100, 70);
      root.addChild(outer);
      return root;
    },
  },
  {
    name: '滤镜 / resolution 2 + 混合 add',
    width: 96,
    height: 64,
    tolerance: 2 / 255,
    clearColor: [0.1, 0.2, 0.1, 1],
    build(env) {
      const { lib } = env;
      const root = new lib.Container();
      const g = scene(env);
      const f = makeFilter(env, [1, 1, 1], 0.5, { resolution: 2 });
      f.blendMode = 'add';
      g.filters = [f];
      root.addChild(g);
      return root;
    },
  },
];
