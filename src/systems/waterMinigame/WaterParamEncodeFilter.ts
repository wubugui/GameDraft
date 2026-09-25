import { Filter, GlProgram, GpuProgram } from '../../engine2d';

const VERT = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

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
}
`;

const FRAG = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform float uDepth;
uniform float uGlow;

void main(void) {
    vec4 t = texture(uTexture, vTextureCoord);
    if (t.a < 0.004) discard;
    finalColor = vec4(uDepth, uGlow, 1.0, t.a);
}
`;

/**
 * WebGPU 版(与上面 GLSL 逐行对应):`@group(0)` 是 Pixi 滤镜固定的 gfu / uTexture / uSampler,
 * 本滤镜的 uniform 组放 `@group(1)`,变量名 = resources 键名 `paramUniforms`,成员顺序 = 声明顺序。
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
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

struct ParamUniforms {
  uDepth: f32,
  uGlow: f32,
};
@group(1) @binding(0) var<uniform> paramUniforms: ParamUniforms;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vTextureCoord: vec2<f32>,
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
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

@fragment
fn mainFragment(@location(0) vTextureCoord: vec2<f32>) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, vTextureCoord);
  if (t.a < 0.004) {
    discard;
  }
  return vec4<f32>(paramUniforms.uDepth, paramUniforms.uGlow, 1.0, t.a);
}
`;

let sharedProgram: GlProgram | null = null;
let sharedGpuProgram: GpuProgram | null = null;

function program(): GlProgram {
  if (!sharedProgram) sharedProgram = new GlProgram({ vertex: VERT, fragment: FRAG });
  return sharedProgram;
}

function gpuProgram(): GpuProgram {
  if (!sharedGpuProgram) {
    sharedGpuProgram = GpuProgram.from({
      name: 'water-param-encode-filter',
      vertex: { source: WGSL, entryPoint: 'mainVertex' },
      fragment: { source: WGSL, entryPoint: 'mainFragment' },
    });
  }
  return sharedGpuProgram;
}

export class WaterParamEncodeFilter extends Filter {
  constructor() {
    super({
      glProgram: program(),
      gpuProgram: gpuProgram(),
      resources: {
        paramUniforms: {
          uDepth: { value: 0.5, type: 'f32' },
          uGlow: { value: 0, type: 'f32' },
        },
      },
    });
  }

  private get _u(): Record<string, unknown> | undefined {
    return (this.resources as Record<string, { uniforms?: Record<string, unknown> }>)['paramUniforms']?.uniforms;
  }

  setDepthGlow(depth: number, glow: number): void {
    const u = this._u;
    if (!u) return;
    u['uDepth'] = Number.isFinite(depth) ? Math.max(0, depth) : 0;
    u['uGlow'] = Math.max(0, Math.min(1, glow));
  }
}
