/**
 * 合批着色器(WGSL)。与 Pixi 8.17 的 WebGPU 缺省合批程序(colorBit + generateTextureBatchBit(16) + roundPixelsBit)
 * 逐句等价:顶点色在顶点着色器里预乘;每批最多 16 张纹理,片元里按纹理号选;采样用 textureSampleGrad
 * (按纹理号分支是非一致控制流,隐式导数的 textureSample 不允许)。
 */
export const MAX_BATCH_TEXTURES = 16;

function textureDecls(n: number): string {
  let s = '';
  for (let i = 1; i <= n; i++) {
    s += `@group(1) @binding(${(i - 1) * 2}) var textureSource${i}: texture_2d<f32>;\n`;
    s += `@group(1) @binding(${(i - 1) * 2 + 1}) var textureSampler${i}: sampler;\n`;
  }
  return s;
}

function textureSwitch(n: number): string {
  let s = 'switch vTextureId {\n';
  for (let i = 0; i < n - 1; i++) {
    s += `  case ${i}: { outColor = textureSampleGrad(textureSource${i + 1}, textureSampler${i + 1}, vUV, uvDx, uvDy); }\n`;
  }
  s += `  default: { outColor = textureSampleGrad(textureSource${n}, textureSampler${n}, vUV, uvDx, uvDy); }\n}`;
  return s;
}

function batchWgsl(local: boolean): string {
  return /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
${textureDecls(MAX_BATCH_TEXTURES)}${local ? `
struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(2) @binding(0) var<uniform> localUniforms: LocalUniforms;
` : ''}
fn roundPixels(position: vec2<f32>, targetSize: vec2<f32>) -> vec2<f32> {
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

struct VSOutput {
  @builtin(position) vPosition: vec4<f32>,
  @location(0) @interpolate(flat) vTextureId: u32,
  @location(1) vColor: vec4<f32>,
  @location(2) vUV: vec2<f32>,
};

@vertex
fn mainVertex(
  @location(0) aColor: vec4<f32>,
  @location(1) aPosition: vec2<f32>,
  @location(2) aTextureIdAndRound: vec2<u32>,
  @location(3) aUV: vec2<f32>,
) -> VSOutput {
  var worldTransformMatrix = globalUniforms.uWorldTransformMatrix;
  var modelMatrix = mat3x3<f32>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  var position = aPosition;
  var uv = aUV;
  var vColor = vec4<f32>(1., 1., 1., 1.);
  vColor *= vec4<f32>(aColor.rgb * aColor.a, aColor.a);
  let vTextureId = aTextureIdAndRound.y;${local ? `
  vColor *= localUniforms.uColor;
  modelMatrix *= localUniforms.uTransformMatrix;` : ''}
  let vUV = uv;
  var modelViewProjectionMatrix = globalUniforms.uProjectionMatrix * worldTransformMatrix * modelMatrix;
  var vPosition = vec4<f32>((modelViewProjectionMatrix * vec3<f32>(position, 1.0)).xy, 0.0, 1.0);
  vColor *= globalUniforms.uWorldColorAlpha;
  if (aTextureIdAndRound.x == 1u) {
    vPosition = vec4<f32>(roundPixels(vPosition.xy, globalUniforms.uResolution), vPosition.zw);
  }${local ? `
  if (localUniforms.uRound == 1.0) {
    vPosition = vec4(roundPixels(vPosition.xy, globalUniforms.uResolution), vPosition.zw);
  }` : ''}
  return VSOutput(vPosition, vTextureId, vColor, vUV);
}

@fragment
fn mainFragment(
  @location(0) @interpolate(flat) vTextureId: u32,
  @location(1) vColor: vec4<f32>,
  @location(2) vUV: vec2<f32>,
) -> @location(0) vec4<f32> {
  var uvDx = dpdx(vUV);
  var uvDy = dpdy(vUV);
  var outColor: vec4<f32>;
  ${textureSwitch(MAX_BATCH_TEXTURES)}
  return outColor * vColor;
}
`;
}

export const BATCH_WGSL = batchWgsl(false);

/**
 * 不合批图形的程序:与 Pixi 8.17 的 graphics 程序(colorBit + generateTextureBatchBit + localUniformBitGroup2 +
 * roundPixelsBit)等价 —— 合批着色器外加第 2 组的 localUniforms(节点变换 / 颜色 / 取整)。
 */
export const GRAPHICS_WGSL = batchWgsl(true);

/**
 * 缺省网格着色器(不合批的无自定义着色器网格):与 Pixi 8.17 的 GpuMeshAdapter 程序
 * (localUniformBit + textureBit + roundPixelsBit)等价。
 */
export const MESH_WGSL = /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct TextureUniforms {
  uTextureMatrix: mat3x3<f32>,
}
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var<uniform> textureUniforms: TextureUniforms;

fn roundPixels(position: vec2<f32>, targetSize: vec2<f32>) -> vec2<f32> {
  return (floor(((position * 0.5 + 0.5) * targetSize) + 0.5) / targetSize) * 2.0 - 1.0;
}

struct VSOutput {
  @builtin(position) vPosition: vec4<f32>,
  @location(0) vColor: vec4<f32>,
  @location(1) vUV: vec2<f32>,
};

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
  var worldTransformMatrix = globalUniforms.uWorldTransformMatrix;
  var modelMatrix = mat3x3<f32>(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  var vColor = vec4<f32>(1., 1., 1., 1.);
  vColor *= localUniforms.uColor;
  modelMatrix *= localUniforms.uTransformMatrix;
  let uv = (textureUniforms.uTextureMatrix * vec3(aUV, 1.0)).xy;
  var modelViewProjectionMatrix = globalUniforms.uProjectionMatrix * worldTransformMatrix * modelMatrix;
  var vPosition = vec4<f32>((modelViewProjectionMatrix * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
  vColor *= globalUniforms.uWorldColorAlpha;
  if (localUniforms.uRound == 1.0) {
    vPosition = vec4(roundPixels(vPosition.xy, globalUniforms.uResolution), vPosition.zw);
  }
  return VSOutput(vPosition, vColor, uv);
}

@fragment
fn mainFragment(@location(0) vColor: vec4<f32>, @location(1) vUV: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(uTexture, uSampler, vUV) * vColor;
}
`;
