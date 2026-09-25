/**
 * 共享光照片段的 WGSL 移植 —— 核函数级像素对照(「光照片段 /」)。
 *
 * 被测的是**片段本身**(不是哪个宿主着色器):
 *   - lightingCore(LC 段)、worldReconstruct(WR_CORE / WR_TEX / WR_SPRITE 三段)、
 *   - 角色照明公共块 CHAR_LIGHT_COMMON(含 PROBE_SAMPLING / SKYAO_SAMPLING 与注入的 charShadeCore)、
 *   - 实体灯循环 ENTITY_SCENE_LIGHTS(连同真实的 charLights uniform 组)。
 * 每个片段一个测试程序,两种语言各写一份宿主:GLSL 宿主**按运行时的方式**拼真实 GLSL 片段
 * (同一行切片器 / 直接导入运行时常量),WGSL 宿主拼 WGSL 片段(wgslChunks / 运行时导出的 WGSL 常量)。
 * 程序把画面横向分成若干块(tile),每块调一组片段函数;每个像素的实参来自固定种子的
 * rgba16float 数据纹理(两侧逐字节相同)+ 各用例的 uniform 配置,四个通道写函数结果。
 *
 * 目标是 rgba32float,两侧都**关混合**直写:WebGL 用 blendMode 'none';WebGPU 核心里 rgba32float
 * 不可混合,而 Pixi 的管线总带混合状态,所以本文件在回读前临时把 GpuStateSystem.getColorTargets
 * 包一层去掉 blend(只在本用例的 render 调用期间,只影响画进 rgba32float 的管线)。
 *
 * 宿主里的输入映射式两侧逐字照抄;GLSL 三元式在 WGSL 宿主里写成 if/else。
 * 每侧回读后先过 assertNonVacuous(NaN/Inf、整块恒定都算该侧出错),防「两边都没画」的假一致。
 * 容差按 32 位浮点给;实测结果写在 TOL 的注释里,出现非零差先查翻译,不许放宽。
 * WGSL 宿主怎么声明片段要的东西(值结构、charLights 绑定、纹理形参)照各 .wgsl 文件头,本文件就是示例。
 */
import { Container, Mesh, MeshGeometry, RenderTexture, Shader, type Texture, UniformGroup } from 'pixi.js';
import type { ParityCase, ParityEnv } from '../harness';
import LIGHTING_CORE_GLSL from '@src/rendering/lighting/lightingCore.glsl?raw';
import WORLD_RECONSTRUCT_GLSL from '@src/rendering/lighting/worldReconstruct.glsl?raw';
import {
  LC_WGSL, LIGHTING_CORE_WGSL, WORLD_RECONSTRUCT_WGSL, WR_CORE_WGSL, WR_SPRITE_WGSL, WR_TEX_WGSL,
} from '@src/rendering/lighting/wgslChunks';
import { MAX_STATIC_LIGHTS, type PackedLights } from '@src/rendering/lighting/lightPacking';
import {
  CHAR_LIGHT_COMMON_GLSL, CHAR_LIGHT_COMMON_WGSL,
  PROBE_SAMPLING_GLSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_GLSL, SKYAO_SAMPLING_WGSL,
} from '@src/rendering/CharacterShadingFilter';
import {
  applyCharLights, CHAR_LIGHTS_WGSL, createCharLightUniforms,
  ENTITY_SCENE_LIGHTS_GLSL, ENTITY_SCENE_LIGHTS_WGSL,
} from '@src/rendering/CharacterLitSprite';

// ───────────────────────────── GLSL 切片(与运行时宿主同一行切片器)

function sliceGlsl(src: string, tag: string): string {
  const b = `//__${tag}_BEGIN__`;
  const e = `//__${tag}_END__`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i < 0 || j < 0) throw new Error(`GLSL 缺切片标记 ${tag}`);
  return src.substring(i + b.length, j);
}
const WR_CORE = sliceGlsl(WORLD_RECONSTRUCT_GLSL, 'WR_CORE');
const WR_TEX = sliceGlsl(WORLD_RECONSTRUCT_GLSL, 'WR_TEX');
const WR_SPRITE = sliceGlsl(WORLD_RECONSTRUCT_GLSL, 'WR_SPRITE');
const LC = sliceGlsl(LIGHTING_CORE_GLSL, 'LIGHTING_CORE');

// ───────────────────────────── 核函数程序的公共框架

type UType = 'f32' | 'i32' | 'vec2<f32>' | 'vec3<f32>' | 'vec4<f32>' | 'mat3x3<f32>';
interface UDef {
  type: UType;
  value: number | Float32Array;
  size?: number;
  /** false = GLSL 片段自己声明了这个 uniform(CLC),GLSL 宿主不再声明 */
  glDecl?: boolean;
}
type USpec = Record<string, UDef>;

const GL_TYPE: Record<UType, string> = {
  'f32': 'float', 'i32': 'int', 'vec2<f32>': 'vec2', 'vec3<f32>': 'vec3', 'vec4<f32>': 'vec4', 'mat3x3<f32>': 'mat3',
};

function glUniformDecls(spec: USpec): string {
  return Object.entries(spec)
    .filter(([, d]) => d.glDecl !== false)
    .map(([n, d]) => `uniform ${GL_TYPE[d.type]} ${n}${d.size ? `[${d.size}]` : ''};`)
    .join('\n');
}

function wgslStruct(name: string, spec: USpec): string {
  const members = Object.entries(spec)
    .map(([n, d]) => `    ${n}: ${d.size ? `array<${d.type}, ${d.size}>` : d.type},`)
    .join('\n');
  return `struct ${name} {\n${members}\n}\n`;
}

function uniformGroup(spec: USpec): UniformGroup {
  const u: Record<string, { value: number | Float32Array; type: UType; size?: number }> = {};
  for (const [n, d] of Object.entries(spec)) u[n] = d.size ? { value: d.value, type: d.type, size: d.size } : { value: d.value, type: d.type };
  return new UniformGroup(u as never);
}

const GL_VERT = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;
void main(void) {
    mat3 m = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((m * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
}
`;

const WGSL_VERT = /* wgsl */ `
struct GlobalUniforms {
    uProjectionMatrix: mat3x3<f32>,
    uWorldTransformMatrix: mat3x3<f32>,
    uWorldColorAlpha: vec4<f32>,
    uResolution: vec2<f32>,
}
struct LocalUniforms {
    uTransformMatrix: mat3x3<f32>,
    uColor: vec4<f32>,
    uRound: f32,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}
@vertex
fn mainVert(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VOut {
    let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
    var o: VOut;
    o.pos = vec4<f32>((m * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
    o.uv = aUV;
    return o;
}
`;

interface KernelProgram {
  /** 横向几块、每块宽高(像素)、每像素读几行输入(IN(pix, 0..k-1)) */
  tiles: number;
  tw: number;
  th: number;
  k: number;
  /** 除 uIn 之外的纹理;sampled 的在 WGSL 侧另配一个「名字 + Sampler」采样器 */
  textures: { name: string; sampled: boolean }[];
  /** 另外的 uniform 组(资源键 = WGSL 变量名),WGSL 结构由 glHead/wgslHead 自己给 */
  extraGroups?: { name: string; struct: string }[];
  glHead: string;
  glMain: string;
  wgslHead: string;
  wgslMain: string;
}

/** 两侧的着色器源码只由程序形状决定(与 uniform 取值无关),Pixi 按源码缓存程序,同一程序只编译一次 */
function programSources(p: KernelProgram, spec: USpec): { gl: string; wgsl: string } {
  const glSamplers = p.textures.map((t) => `uniform sampler2D ${t.name};`).join('\n');
  const gl = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUV;
out vec4 finalColor;
uniform sampler2D uIn;
${glSamplers}
${glUniformDecls(spec)}
vec4 IN(ivec2 p, int j) { return texelFetch(uIn, ivec2(p.x, p.y + j * ${p.th}), 0); }
${p.glHead}
void main(void) {
    ivec2 pix = ivec2(floor(gl_FragCoord.xy));
    int tile = pix.x / ${p.tw};
    vec4 o = vec4(0.0);
${p.glMain}
    finalColor = o;
}
`;
  let binding = 0;
  const decl: string[] = [`@group(2) @binding(${binding++}) var<uniform> tc: TC;`];
  for (const g of p.extraGroups ?? []) decl.push(`@group(2) @binding(${binding++}) var<uniform> ${g.name}: ${g.struct};`);
  decl.push(`@group(2) @binding(${binding++}) var uIn: texture_2d<f32>;`);
  for (const t of p.textures) {
    decl.push(`@group(2) @binding(${binding++}) var ${t.name}: texture_2d<f32>;`);
    if (t.sampled) decl.push(`@group(2) @binding(${binding++}) var ${t.name}Sampler: sampler;`);
  }
  const wgsl = /* wgsl */ `${WGSL_VERT}
${wgslStruct('TC', spec)}
${p.wgslHead}
${decl.join('\n')}
fn IN(p: vec2<i32>, j: i32) -> vec4<f32> { return textureLoad(uIn, vec2<i32>(p.x, p.y + j * ${p.th}), 0); }
@fragment
fn mainFrag(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let pix = vec2<i32>(floor(pos.xy));
    let tile = pix.x / ${p.tw};
    var o = vec4<f32>(0.0);
${p.wgslMain}
    return o;
}
`;
  return { gl, wgsl };
}

/** 回读前把 WebGPU 管线的颜色目标去掉混合(rgba32float 在 WebGPU 核心里不可混合),只在本次 render 期间 */
async function renderNoBlend(env: ParityEnv, root: Container, w: number, h: number): Promise<Float32Array> {
  const rt = RenderTexture.create({ width: w, height: h, format: 'rgba32float', resolution: 1, antialias: false });
  try {
    type StateSys = { getColorTargets(s: unknown, n: number): GPUColorTargetState[] };
    const st = env.side === 'gpu' ? (env.renderer as unknown as { state: StateSys }).state : null;
    const orig = st?.getColorTargets;
    if (st && orig) st.getColorTargets = (s, n) => orig.call(st, s, n).map((t) => ({ ...t, blend: undefined }));
    try {
      env.renderer.render({ container: root, target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    } finally {
      if (st && orig) st.getColorTargets = orig;
    }
    return await env.readTexture(rt, 'rgba32float');
  } finally {
    root.destroy({ children: true });
    rt.destroy(true);
  }
}

interface KernelRun {
  spec: USpec;
  textures: Record<string, Texture>;
  groups?: Record<string, UniformGroup>;
  /** 按配置本来就该整块恒定的 tile(skyao 关、0 盏灯……);其余 tile 至少一个通道得有变化 */
  constantTiles?: number[];
}

function produceOnly(): never {
  throw new Error('本文件的用例走 produce()');
}

/**
 * 防「两边都画出同一片空白」的假一致:任何一侧出现 NaN/Inf,或某块 tile 四个通道全恒定
 * (纹理没绑上、分支没进、管线没画都会是这样),就当这一侧出错。
 */
function assertNonVacuous(name: string, data: Float32Array, p: KernelProgram, width: number, height: number,
  constantTiles: number[]): void {
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) throw new Error(`${name}:输出含 NaN/Inf(像素 ${Math.floor(i / 4) % width},${Math.floor(i / 4 / width)})`);
  }
  for (let t = 0; t < p.tiles; t++) {
    if (constantTiles.includes(t)) continue;
    let varies = false;
    for (let ch = 0; ch < 4 && !varies; ch++) {
      const first = data[(t * p.tw) * 4 + ch];
      for (let y = 0; y < height && !varies; y++) {
        for (let x = t * p.tw; x < (t + 1) * p.tw; x++) {
          if (data[(y * width + x) * 4 + ch] !== first) { varies = true; break; }
        }
      }
    }
    if (!varies) throw new Error(`${name}:tile ${t} 整块恒定 —— 被测函数没真正跑起来(纹理 / 分支 / 管线)`);
  }
}

function kernelCase(
  name: string,
  p: KernelProgram,
  tolerance: number,
  setup: (env: ParityEnv) => KernelRun,
): ParityCase {
  const width = p.tiles * p.tw;
  const height = p.th;
  return {
    name,
    width,
    height,
    target: 'rgba32float',
    tolerance,
    build: produceOnly,
    async produce(env) {
      const run = setup(env);
      const { gl, wgsl } = programSources(p, run.spec);
      const input = env.dataTexture({
        width, height: height * p.k, seed: hashName(name), format: 'rgba16float',
      });
      const resources: Record<string, unknown> = { tc: uniformGroup(run.spec), uIn: input.source };
      for (const [k, g] of Object.entries(run.groups ?? {})) resources[k] = g;
      for (const t of p.textures) {
        const tex = run.textures[t.name];
        if (!tex) throw new Error(`缺纹理 ${t.name}`);
        resources[t.name] = tex.source;
        if (t.sampled) resources[`${t.name}Sampler`] = tex.source.style;
      }
      const geometry = new MeshGeometry({
        positions: new Float32Array([0, 0, width, 0, width, height, 0, height]),
        uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      });
      const shader = Shader.from({
        gl: { vertex: GL_VERT, fragment: gl },
        gpu: { vertex: { source: wgsl, entryPoint: 'mainVert' }, fragment: { source: wgsl, entryPoint: 'mainFrag' } },
        resources: resources as never,
      });
      const mesh = new Mesh({ geometry, shader });
      mesh.blendMode = 'none';
      const root = new Container();
      root.addChild(mesh);
      const data = await renderNoBlend(env, root, width, height);
      assertNonVacuous(name, data, p, width, height, run.constantTiles ?? []);
      return data;
    },
  };
}

function hashName(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ───────────────────────────── 数据纹理

/** RG16 编码(与 raw_depth_rg.png / ground_d.png 同编码):t ∈ [0,1] → 高字节 R、低字节 G */
function rg16Texture(env: ParityEnv, w: number, h: number, seed: number, field: (x: number, y: number) => number,
  scaleMode: 'nearest' | 'linear'): Texture {
  return env.dataTexture({
    width: w, height: h, seed, format: 'rgba8unorm', scaleMode,
    fill: (x, y, c) => {
      const u = Math.max(0, Math.min(65535, Math.round(field(x, y) * 65535)));
      return c === 0 ? (u >> 8) / 255 : c === 1 ? (u & 255) / 255 : c === 2 ? 0 : 1;
    },
  });
}

/** 平滑斜坡 + 几块更近(值更小)的遮挡体,t ∈ [0,1] */
function depthField(env: ParityEnv, w: number, h: number, seed: number): (x: number, y: number) => number {
  const rng = env.rng(seed);
  const boxes: [number, number, number, number, number][] = [];
  for (let i = 0; i < 5; i++) {
    const bw = 3 + Math.floor(rng() * w * 0.25);
    const bh = 3 + Math.floor(rng() * h * 0.3);
    boxes.push([Math.floor(rng() * (w - bw)), Math.floor(rng() * (h - bh)), bw, bh, 0.1 + rng() * 0.3]);
  }
  return (x, y) => {
    let t = 0.3 + 0.45 * (y / h) + 0.08 * Math.sin(x * 0.31);
    for (const [bx, by, bw, bh, drop] of boxes) if (x >= bx && x < bx + bw && y >= by && y < by + bh) t -= drop;
    return Math.max(0, Math.min(1, t));
  };
}

function vec(...v: number[]): Float32Array {
  return new Float32Array(v);
}

/** 绕 X 轴转 deg 的行主 3×3(det = +1,游戏约定的 depthConfig.M.R 那种) */
function rotXRows(deg: number): [number[], number[], number[]] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

/** 行主 → Pixi mat3x3 的列主 Float32Array */
function colMajor(rows: number[][]): Float32Array {
  return vec(rows[0][0], rows[1][0], rows[2][0], rows[0][1], rows[1][1], rows[2][1], rows[0][2], rows[1][2], rows[2][2]);
}

// ═════════════════════════════ A. lightingCore(LC 段,连同 WR_CORE)

const LC_PROGRAM: KernelProgram = {
  tiles: 8, tw: 16, th: 16, k: 4,
  textures: [{ name: 'uDepth', sampled: true }],
  glHead: `${WR_CORE}\n${LC}`,
  wgslHead: `${WR_CORE_WGSL}\n${LC_WGSL}`,
  glMain: /* glsl */ `
    vec4 a = IN(pix, 0); vec4 b = IN(pix, 1); vec4 c = IN(pix, 2); vec4 d = IN(pix, 3);
    vec3 P = (a.xyz * 2.0 - 1.0) * 10.0;
    vec3 N = normalize(b.xyz * 2.0 - 1.0 + vec3(0.0, 0.0, 1e-3));
    float vis = a.w;
    if (tile == 0) {
        o.x = lcPointLight(P, N, uLP, uLC, uLI, uLR, uLS, vis).x;
        o.y = lcSpotLight(P, N, uLP, uSpotDir, uLC, uLI, uLR, uLS, uCosIn, uCosOut, vis).y;
        o.z = lcDirectionalLight(N, c.xyz * 2.0 - 1.0, uLC, uLI, vis).z;
        o.w = lcFalloff(dot(P - uLP, P - uLP), uLR, uLS);
    } else if (tile == 1) {
        vec3 e1 = lcAreaLight(P, N, uAC, uAU, uAV, uLC, uLI, uLR, false, vis);
        vec3 e2 = lcAreaLight(P, N, uAC, uAU, uAV, uLC, uLI, uLR, true, vis);
        float ri = lcRectIrradiance(P, N, uAC - uAU - uAV, uAC - uAU + uAV, uAC + uAU + uAV, uAC + uAU - uAV);
        vec3 e3 = lcAreaLight(P, N, uAC, uAU, uAV, uLC, uLI, 2.0, true, vis);
        o = vec4(e1.x, e2.y, ri, e3.z);
    } else if (tile == 2) {
        vec3 l1 = lcLineLight(P, N, uLA, uLSeg, uLC, uLI, uLR, uLS, vis);
        vec3 l2 = lcLineLight(P, N, uLA, uLSeg * 1e-4, uLC, uLI, uLR, uLS, vis);
        vec3 l3 = lcLineLight(P, N, uLA, c.xyz * 8.0 - 4.0, uLC, uLI, 3.0, uLS, vis);
        o = vec4(l1.x, l2.y, l3.z, l1.z);
    } else if (tile == 3) {
        float yCam = c.x * 4.0 - 2.0;
        float ySurf = c.y > 0.8 ? yCam : c.z * 4.0 - 2.0;
        float od = lcOpticalDepth(d.x * 50.0, yCam, ySurf, d.y * 0.05, 1.0 + d.z * 2.0, d.w * 2.0 - 1.0);
        o = vec4(lcApplyFog(a.xyz * 3.0, od, b.xyz), od);
    } else if (tile == 4) {
        vec3 lin = a.xyz * 4.0;
        o = vec4(lcDisplayTransform(lin, uEv, uTone, uWB, uSat, uCon, uLift, uLiftC), lcTonemap(lin, uTone).x);
    } else if (tile == 5) {
        vec3 x = a.xyz * 1.2 - 0.1;
        o = vec4(lcLinearToSrgb(x).x, lcSrgbToLinear(clamp(x, 0.0, 1.0)).y, lcTonemap(x * 3.0, 2).z, lcTonemap(x * 3.0, 1).x);
    } else if (tile == 6) {
        vec3 sky = lcSkyLight(uLC, uLI, b.x * 1.4 - 0.2, b.y, b.z * 1.4 - 0.2);
        vec3 rl = lcRelightScene(a.xyz, c.xyz * c.xyz * 0.5, d.xyz * 2.0, 8.0);
        o = vec4(sky.x, rl);
    } else {
        vec3 q0 = vec3(c.x * 3.2 - 1.6, c.y * 2.0 - 1.0, c.z * 0.6 + 0.2);
        vec3 dq = normalize(d.xyz * 2.0 - 1.0 + vec3(0.0, 0.0, 1e-3));
        o.x = lcMarchVisibility(uDepth, uDTS, uCal.x, uCal.y, uCal.z, uDM.x, uDM.y, uDM.z, q0, dq, uSteps, uMarchLen, uBias.x, uBias.y);
        o.y = lcMarchVisibility(uDepth, uDTS, uCal.x, uCal.y, uCal.z, 1.0 - uDM.x, uDM.y, uDM.z, q0, dq, uSteps, uMarchLen, uBias.x, uBias.y);
        o.z = lcMarchVisibility(uDepth, uDTS, uCal.x, uCal.y, uCal.z, uDM.x, uDM.y, uDM.z, q0, dq, 0, uMarchLen, uBias.x, uBias.y);
        o.w = lcMarchVisibility(uDepth, uDTS, uCal.x, uCal.y, uCal.z, uDM.x, uDM.y, uDM.z, q0, dq, 200, uMarchLen * 4.0, uBias.x, uBias.y);
    }`,
  wgslMain: /* wgsl */ `
    let a = IN(pix, 0); let b = IN(pix, 1); let c = IN(pix, 2); let d = IN(pix, 3);
    let P = (a.xyz * 2.0 - 1.0) * 10.0;
    let N = normalize(b.xyz * 2.0 - 1.0 + vec3<f32>(0.0, 0.0, 1e-3));
    let vis = a.w;
    if (tile == 0) {
        o.x = lcPointLight(P, N, tc.uLP, tc.uLC, tc.uLI, tc.uLR, tc.uLS, vis).x;
        o.y = lcSpotLight(P, N, tc.uLP, tc.uSpotDir, tc.uLC, tc.uLI, tc.uLR, tc.uLS, tc.uCosIn, tc.uCosOut, vis).y;
        o.z = lcDirectionalLight(N, c.xyz * 2.0 - 1.0, tc.uLC, tc.uLI, vis).z;
        o.w = lcFalloff(dot(P - tc.uLP, P - tc.uLP), tc.uLR, tc.uLS);
    } else if (tile == 1) {
        let e1 = lcAreaLight(P, N, tc.uAC, tc.uAU, tc.uAV, tc.uLC, tc.uLI, tc.uLR, false, vis);
        let e2 = lcAreaLight(P, N, tc.uAC, tc.uAU, tc.uAV, tc.uLC, tc.uLI, tc.uLR, true, vis);
        let ri = lcRectIrradiance(P, N, tc.uAC - tc.uAU - tc.uAV, tc.uAC - tc.uAU + tc.uAV, tc.uAC + tc.uAU + tc.uAV, tc.uAC + tc.uAU - tc.uAV);
        let e3 = lcAreaLight(P, N, tc.uAC, tc.uAU, tc.uAV, tc.uLC, tc.uLI, 2.0, true, vis);
        o = vec4<f32>(e1.x, e2.y, ri, e3.z);
    } else if (tile == 2) {
        let l1 = lcLineLight(P, N, tc.uLA, tc.uLSeg, tc.uLC, tc.uLI, tc.uLR, tc.uLS, vis);
        let l2 = lcLineLight(P, N, tc.uLA, tc.uLSeg * 1e-4, tc.uLC, tc.uLI, tc.uLR, tc.uLS, vis);
        let l3 = lcLineLight(P, N, tc.uLA, c.xyz * 8.0 - 4.0, tc.uLC, tc.uLI, 3.0, tc.uLS, vis);
        o = vec4<f32>(l1.x, l2.y, l3.z, l1.z);
    } else if (tile == 3) {
        let yCam = c.x * 4.0 - 2.0;
        var ySurf = c.z * 4.0 - 2.0;
        if (c.y > 0.8) { ySurf = yCam; }
        let od = lcOpticalDepth(d.x * 50.0, yCam, ySurf, d.y * 0.05, 1.0 + d.z * 2.0, d.w * 2.0 - 1.0);
        o = vec4<f32>(lcApplyFog(a.xyz * 3.0, od, b.xyz), od);
    } else if (tile == 4) {
        let lin = a.xyz * 4.0;
        o = vec4<f32>(lcDisplayTransform(lin, tc.uEv, tc.uTone, tc.uWB, tc.uSat, tc.uCon, tc.uLift, tc.uLiftC), lcTonemap(lin, tc.uTone).x);
    } else if (tile == 5) {
        let x = a.xyz * 1.2 - 0.1;
        o = vec4<f32>(lcLinearToSrgb(x).x, lcSrgbToLinear(clamp(x, vec3<f32>(0.0), vec3<f32>(1.0))).y, lcTonemap(x * 3.0, 2).z, lcTonemap(x * 3.0, 1).x);
    } else if (tile == 6) {
        let sky = lcSkyLight(tc.uLC, tc.uLI, b.x * 1.4 - 0.2, b.y, b.z * 1.4 - 0.2);
        let rl = lcRelightScene(a.xyz, c.xyz * c.xyz * 0.5, d.xyz * 2.0, 8.0);
        o = vec4<f32>(sky.x, rl);
    } else {
        let q0 = vec3<f32>(c.x * 3.2 - 1.6, c.y * 2.0 - 1.0, c.z * 0.6 + 0.2);
        let dq = normalize(d.xyz * 2.0 - 1.0 + vec3<f32>(0.0, 0.0, 1e-3));
        o.x = lcMarchVisibility(uDepth, uDepthSampler, tc.uDTS, tc.uCal.x, tc.uCal.y, tc.uCal.z, tc.uDM.x, tc.uDM.y, tc.uDM.z, q0, dq, tc.uSteps, tc.uMarchLen, tc.uBias.x, tc.uBias.y);
        o.y = lcMarchVisibility(uDepth, uDepthSampler, tc.uDTS, tc.uCal.x, tc.uCal.y, tc.uCal.z, 1.0 - tc.uDM.x, tc.uDM.y, tc.uDM.z, q0, dq, tc.uSteps, tc.uMarchLen, tc.uBias.x, tc.uBias.y);
        o.z = lcMarchVisibility(uDepth, uDepthSampler, tc.uDTS, tc.uCal.x, tc.uCal.y, tc.uCal.z, tc.uDM.x, tc.uDM.y, tc.uDM.z, q0, dq, 0, tc.uMarchLen, tc.uBias.x, tc.uBias.y);
        o.w = lcMarchVisibility(uDepth, uDepthSampler, tc.uDTS, tc.uCal.x, tc.uCal.y, tc.uCal.z, tc.uDM.x, tc.uDM.y, tc.uDM.z, q0, dq, 200, tc.uMarchLen * 4.0, tc.uBias.x, tc.uBias.y);
    }`,
};

/** 整份文件拼法(GLSL 那边停用的统一角色路径就是整份拼 worldReconstruct + lightingCore) */
const LC_FULL_PROGRAM: KernelProgram = {
  ...LC_PROGRAM,
  glHead: `${WORLD_RECONSTRUCT_GLSL}\n${LIGHTING_CORE_GLSL}`,
  wgslHead: `${WORLD_RECONSTRUCT_WGSL}\n${LIGHTING_CORE_WGSL}`,
};

interface LcCfg {
  tone: number; ev: number; wb: [number, number, number]; sat: number; con: number; lift: number;
  liftC: [number, number, number];
  depthInvert: number;
  steps: number;
  scaleMode: 'nearest' | 'linear';
}

function lcRun(cfg: LcCfg): (env: ParityEnv) => KernelRun {
  return (env) => {
    const DW = 64, DH = 40;
    const spec: USpec = {
      uLP: { type: 'vec3<f32>', value: vec(1.5, 3, -2) },
      uLC: { type: 'vec3<f32>', value: vec(1, 0.8, 0.55) },
      uLI: { type: 'f32', value: 20 },
      uLR: { type: 'f32', value: 9 },
      uLS: { type: 'f32', value: 0.3 },
      uSpotDir: { type: 'vec3<f32>', value: vec(-0.2, -1, 0.3) },
      uCosIn: { type: 'f32', value: 0.92 },
      uCosOut: { type: 'f32', value: 0.55 },
      uAC: { type: 'vec3<f32>', value: vec(-1, 2, 1) },
      uAU: { type: 'vec3<f32>', value: vec(2, 0, 0.5) },
      uAV: { type: 'vec3<f32>', value: vec(0, 0.4, 1.5) },
      uLA: { type: 'vec3<f32>', value: vec(-4, 5, -1) },
      uLSeg: { type: 'vec3<f32>', value: vec(3, -7, 2) },
      uTone: { type: 'i32', value: cfg.tone },
      uEv: { type: 'f32', value: cfg.ev },
      uWB: { type: 'vec3<f32>', value: vec(...cfg.wb) },
      uSat: { type: 'f32', value: cfg.sat },
      uCon: { type: 'f32', value: cfg.con },
      uLift: { type: 'f32', value: cfg.lift },
      uLiftC: { type: 'vec3<f32>', value: vec(...cfg.liftC) },
      uDTS: { type: 'vec2<f32>', value: vec(DW, DH) },
      uCal: { type: 'vec3<f32>', value: vec(20, 32, 20) },
      uDM: { type: 'vec3<f32>', value: vec(cfg.depthInvert, 1, 0) },
      uSteps: { type: 'i32', value: cfg.steps },
      uMarchLen: { type: 'f32', value: 1.2 },
      uBias: { type: 'vec2<f32>', value: vec(0.01, 0.25) },
    };
    const depth = rg16Texture(env, DW, DH, 11, depthField(env, DW, DH, 12), cfg.scaleMode);
    return { spec, textures: { uDepth: depth } };
  };
}

const LC_BASE: LcCfg = {
  tone: 0, ev: 0, wb: [1, 1, 1], sat: 1, con: 1, lift: 0, liftC: [1, 1, 1], depthInvert: 0, steps: 24, scaleMode: 'nearest',
};

// ═════════════════════════════ B. worldReconstruct(三段)

const WR_PROGRAM: KernelProgram = {
  tiles: 15, tw: 16, th: 16, k: 4,
  textures: [{ name: 'uDepth', sampled: true }, { name: 'uGround', sampled: true }, { name: 'uColl', sampled: true }],
  glHead: `${WR_CORE}\n${WR_TEX}\n${WR_SPRITE}`,
  wgslHead: `${WR_CORE_WGSL}\n${WR_TEX_WGSL}\n${WR_SPRITE_WGSL}`,
  glMain: /* glsl */ `
    vec4 a = IN(pix, 0); vec4 b = IN(pix, 1); vec4 c = IN(pix, 2); vec4 d = IN(pix, 3);
    vec3 q = (b.xyz * 2.0 - 1.0) * 3.0;
    vec2 cell = d.xy * 30.0 - 5.0;
    float h = wrUprightHeight(a.x * 300.0, b.x * 300.0, uR1.y, uCal.x);
    if (tile == 0) {
        vec2 w = wrScreenToWorld(a.xy * 800.0, uWCP, uPS);
        o = vec4(w, wrSceneUv(w, uExt));
    } else if (tile == 1) {
        vec2 uv = a.xy * 2.0 - 0.5;
        vec2 g = wrSceneUvGuarded(b.xy * 3000.0 - 500.0, uExt, uEps);
        o = vec4(g, wrUvInside(uv) ? 1.0 : 0.0, wrUvOutside(uv) ? 1.0 : 0.0);
    } else if (tile == 2) {
        vec2 wxy = a.xy * 3000.0;
        o = vec4(wrWorldToNativePx(wxy, uW2N), wrWorldToWorkPx(wxy, uW2W));
    } else if (tile == 3) {
        vec3 pq = wrPixelToQ(a.xy * 2048.0, uCal.x, uCal.y, uCal.z, a.z * 4.0 - 1.0);
        o = vec4(pq, wrQxToPx(c.x * 4.0 - 2.0, uCal.x, uCal.y));
    } else if (tile == 4) {
        o = vec4(wrQToPixel(q, uCal.x, uCal.y, uCal.z), wrQToWorldRow(uR1, q), wrWorldXZToCell(c.xy * 20.0 - 10.0, uCellMin, uCellSize).x);
    } else if (tile == 5) {
        o = vec4(wrQToWorld(uR0, uR1, uR2, q), wrQToWorldXZ(uR0, uR2, q).y);
    } else if (tile == 6) {
        o = vec4(wrWorldToQ(uR0, uR1, uR2, (c.xyz * 2.0 - 1.0) * 5.0), wrCellInside(cell, uGrid) ? 1.0 : 0.0);
    } else if (tile == 7) {
        o = vec4(wrQToProbeWorld(uLabM, q), wrCellOutside(cell, uGrid) ? 1.0 : 0.0);
    } else if (tile == 8) {
        o = vec4(wrDecodeRG16Unit(a), wrDecodeSceneDepth(a, 0.0, uDM.y, uDM.z), wrDecodeSceneDepth(a, 1.0, uDM.y, uDM.z), wrDecodeGroundDepth(a, uGR));
    } else if (tile == 9) {
        float up = wrUprightDelta(a.x * 1000.0, b.x * 1000.0, uW2N.y, 0.0022);
        float sd = wrSpriteDepth(c.x, up, c.y * 0.1, c.z * 0.05, c.w * 0.04);
        vec4 ob = wrApplyOcclusionBlend(vec4(b.yzw, a.w), d.z);
        o = vec4(up, sd, wrIsOccluded(d.w, sd, d.y * 0.05) ? 1.0 : 0.0, ob.w);
    } else if (tile == 10) {
        o = vec4(wrApplyOcclusionBlend(vec4(b.yzw, a.w), d.z).xyz, h);
    } else if (tile == 11) {
        vec3 qf = wrQFromFoot(c.x * 2.0 - 1.0, c.y, c.z, h, uR1.y, -uR1.z, d.x * 0.1);
        o = vec4(qf, wrDecodeSpriteNormal(d, false, a.z * 0.5).x);
    } else if (tile == 12) {
        o = vec4(wrDecodeSpriteNormal(d, true, a.z * 0.5), wrDecodeSpriteNormal(d, false, 0.0).y);
    } else if (tile == 13) {
        vec2 wxy = b.xy * uExt * 1.2 - uExt * 0.1;
        o.x = wrSampleSceneDepth(uDepth, a.xy, uDM.x, uDM.y, uDM.z);
        o.y = wrSampleGroundAtUv(uGround, a.xy, uGR);
        o.z = wrSampleGroundWorld(uGround, wxy, uExt, uGR, WR_EPS_SCENE);
        o.w = wrSampleGroundWorld(uGround, wxy, uExt, uGR, WR_EPS_TIGHT);
    } else {
        vec2 wxy = b.xy * uExt * 1.2 - uExt * 0.1;
        vec2 gc = c.xy * (uGrid + 4.0) - 2.0;
        o.x = wrSampleGroundWorldBilinear(uGround, uGTS, wxy, uExt, uGR);
        o.y = wrSampleCollisionCell(uColl, gc, uGrid) ? 1.0 : 0.0;
        o.z = wrSampleCollisionCellNearest(uColl, gc, uGrid) ? 1.0 : 0.0;
        o.w = float(WR_CONTRACT);
    }`,
  wgslMain: /* wgsl */ `
    let a = IN(pix, 0); let b = IN(pix, 1); let c = IN(pix, 2); let d = IN(pix, 3);
    let q = (b.xyz * 2.0 - 1.0) * 3.0;
    let cell = d.xy * 30.0 - 5.0;
    let h = wrUprightHeight(a.x * 300.0, b.x * 300.0, tc.uR1.y, tc.uCal.x);
    if (tile == 0) {
        let w = wrScreenToWorld(a.xy * 800.0, tc.uWCP, tc.uPS);
        o = vec4<f32>(w, wrSceneUv(w, tc.uExt));
    } else if (tile == 1) {
        let uv = a.xy * 2.0 - 0.5;
        let g = wrSceneUvGuarded(b.xy * 3000.0 - 500.0, tc.uExt, tc.uEps);
        o = vec4<f32>(g, f32(wrUvInside(uv)), f32(wrUvOutside(uv)));
    } else if (tile == 2) {
        let wxy = a.xy * 3000.0;
        o = vec4<f32>(wrWorldToNativePx(wxy, tc.uW2N), wrWorldToWorkPx(wxy, tc.uW2W));
    } else if (tile == 3) {
        let pq = wrPixelToQ(a.xy * 2048.0, tc.uCal.x, tc.uCal.y, tc.uCal.z, a.z * 4.0 - 1.0);
        o = vec4<f32>(pq, wrQxToPx(c.x * 4.0 - 2.0, tc.uCal.x, tc.uCal.y));
    } else if (tile == 4) {
        o = vec4<f32>(wrQToPixel(q, tc.uCal.x, tc.uCal.y, tc.uCal.z), wrQToWorldRow(tc.uR1, q), wrWorldXZToCell(c.xy * 20.0 - 10.0, tc.uCellMin, tc.uCellSize).x);
    } else if (tile == 5) {
        o = vec4<f32>(wrQToWorld(tc.uR0, tc.uR1, tc.uR2, q), wrQToWorldXZ(tc.uR0, tc.uR2, q).y);
    } else if (tile == 6) {
        o = vec4<f32>(wrWorldToQ(tc.uR0, tc.uR1, tc.uR2, (c.xyz * 2.0 - 1.0) * 5.0), f32(wrCellInside(cell, tc.uGrid)));
    } else if (tile == 7) {
        o = vec4<f32>(wrQToProbeWorld(tc.uLabM, q), f32(wrCellOutside(cell, tc.uGrid)));
    } else if (tile == 8) {
        o = vec4<f32>(wrDecodeRG16Unit(a), wrDecodeSceneDepth(a, 0.0, tc.uDM.y, tc.uDM.z), wrDecodeSceneDepth(a, 1.0, tc.uDM.y, tc.uDM.z), wrDecodeGroundDepth(a, tc.uGR));
    } else if (tile == 9) {
        let up = wrUprightDelta(a.x * 1000.0, b.x * 1000.0, tc.uW2N.y, 0.0022);
        let sd = wrSpriteDepth(c.x, up, c.y * 0.1, c.z * 0.05, c.w * 0.04);
        let ob = wrApplyOcclusionBlend(vec4<f32>(b.yzw, a.w), d.z);
        o = vec4<f32>(up, sd, f32(wrIsOccluded(d.w, sd, d.y * 0.05)), ob.w);
    } else if (tile == 10) {
        o = vec4<f32>(wrApplyOcclusionBlend(vec4<f32>(b.yzw, a.w), d.z).xyz, h);
    } else if (tile == 11) {
        let qf = wrQFromFoot(c.x * 2.0 - 1.0, c.y, c.z, h, tc.uR1.y, -tc.uR1.z, d.x * 0.1);
        o = vec4<f32>(qf, wrDecodeSpriteNormal(d, false, a.z * 0.5).x);
    } else if (tile == 12) {
        o = vec4<f32>(wrDecodeSpriteNormal(d, true, a.z * 0.5), wrDecodeSpriteNormal(d, false, 0.0).y);
    } else if (tile == 13) {
        let wxy = b.xy * tc.uExt * 1.2 - tc.uExt * 0.1;
        o.x = wrSampleSceneDepth(uDepth, uDepthSampler, a.xy, tc.uDM.x, tc.uDM.y, tc.uDM.z);
        o.y = wrSampleGroundAtUv(uGround, uGroundSampler, a.xy, tc.uGR);
        o.z = wrSampleGroundWorld(uGround, uGroundSampler, wxy, tc.uExt, tc.uGR, WR_EPS_SCENE);
        o.w = wrSampleGroundWorld(uGround, uGroundSampler, wxy, tc.uExt, tc.uGR, WR_EPS_TIGHT);
    } else {
        let wxy = b.xy * tc.uExt * 1.2 - tc.uExt * 0.1;
        let gc = c.xy * (tc.uGrid + 4.0) - 2.0;
        o.x = wrSampleGroundWorldBilinear(uGround, tc.uGTS, wxy, tc.uExt, tc.uGR);
        o.y = f32(wrSampleCollisionCell(uColl, uCollSampler, gc, tc.uGrid));
        o.z = f32(wrSampleCollisionCellNearest(uColl, gc, tc.uGrid));
        o.w = f32(WR_CONTRACT);
    }`,
};

function wrRun(opts: { scaleMode: 'nearest' | 'linear'; ext: [number, number]; eps: number; invert: number }): (env: ParityEnv) => KernelRun {
  return (env) => {
    const GW = 32, GH = 20, CW = 24, CH = 16, DW = 48, DH = 30;
    const rows = rotXRows(38);
    const lab = [rows[0], rows[1], rows[2].map((v) => -v)];   // det = −1 的实验室 M(与 R 差一个 Z 反号)
    const spec: USpec = {
      uWCP: { type: 'vec2<f32>', value: vec(-120, 35) },
      uPS: { type: 'f32', value: 1.7 },
      uExt: { type: 'vec2<f32>', value: vec(...opts.ext) },
      uEps: { type: 'f32', value: opts.eps },
      uW2N: { type: 'vec2<f32>', value: vec(0.512, 0.51) },
      uW2W: { type: 'vec2<f32>', value: vec(0.128, 0.1275) },
      uCal: { type: 'vec3<f32>', value: vec(450.56, 1024, 571.5) },
      uR0: { type: 'vec3<f32>', value: vec(...rows[0]) },
      uR1: { type: 'vec3<f32>', value: vec(...rows[1]) },
      uR2: { type: 'vec3<f32>', value: vec(...rows[2]) },
      uLabM: { type: 'mat3x3<f32>', value: colMajor(lab) },
      uCellMin: { type: 'vec2<f32>', value: vec(-4, -3) },
      uCellSize: { type: 'f32', value: 0.75 },
      uGrid: { type: 'vec2<f32>', value: vec(CW, CH) },
      uDM: { type: 'vec3<f32>', value: vec(opts.invert, 2.5, -0.4) },
      uGR: { type: 'vec2<f32>', value: vec(-0.3, 1.9) },
      uGTS: { type: 'vec2<f32>', value: vec(GW, GH) },
    };
    const depth = rg16Texture(env, DW, DH, 21, depthField(env, DW, DH, 22), opts.scaleMode);
    const ground = rg16Texture(env, GW, GH, 23, (x, y) => 0.2 + 0.6 * (y / GH) + 0.05 * Math.cos(x * 0.5), opts.scaleMode);
    const coll = env.dataTexture({
      width: CW, height: CH, seed: 24, format: 'rgba8unorm', scaleMode: opts.scaleMode,
      fill: (x, y, c, rng) => (c === 3 ? 1 : c === 0 ? ((x * 7 + y * 3) % 5 < 2 || rng() < 0.15 ? 1 : 0) : 0),
    });
    return { spec, textures: { uDepth: depth, uGround: ground, uColl: coll } };
  };
}

// ═════════════════════════════ C. 角色照明公共块(CHAR_LIGHT_COMMON,含 PROBE / SKYAO 两段与 charShadeCore)

const PN: [number, number, number] = [6, 5, 4];
const PROBE_COUNT = PN[0] * PN[1] * PN[2];
const PROBE_T = 16;
const PROBE_ROWS = Math.ceil(PROBE_COUNT / PROBE_T);
const VOL_N: [number, number, number] = [8, 6, 5];
const VOL_TILES: [number, number] = [3, 2];
const SKY_N: [number, number, number] = [5, 4, 6];
const SKY_TILES: [number, number] = [3, 2];

/** GLSL 版块里自己声明的 uniform(glDecl: false);WGSL 宿主在 TC 结构里按同名同序声明 */
function clcSpec(cfg: ClcCfg, env: ParityEnv): USpec {
  const rng = env.rng(31);
  const mRows = [[1, 0, 0], [0, Math.cos(0.61), Math.sin(0.61)], [0, Math.sin(0.61), -Math.cos(0.61)]];   // det = −1
  const skyRows = rotXRows(40);
  const ambSH = new Float32Array(27);
  for (let i = 0; i < 27; i++) ambSH[i] = i < 3 ? 0.6 + rng() * 0.4 : (rng() - 0.35) * 0.6;
  const lightQ = new Float32Array(192), lightE = new Float32Array(192);
  for (let i = 0; i < 48; i++) {
    lightQ.set([(rng() - 0.5) * 1.6, (rng() - 0.5) * 1.6, (rng() - 0.5) * 1.6, 0.01 + rng() * 0.04], i * 4);
    lightE.set([rng() * 5, rng() * 5, rng() * 5, 0], i * 4);
  }
  const g = (type: UType, value: number | Float32Array, size?: number): UDef => ({ type, value, size, glDecl: false });
  return {
    uM: g('mat3x3<f32>', colMajor(mRows)),
    uWMin: g('vec3<f32>', vec(-1.3, -1.5, -1.5)),
    uWScale: g('vec3<f32>', vec((PN[0] - 1) / 2.6, (PN[1] - 1) / 3, (PN[2] - 1) / 3)),
    uPN: g('vec3<f32>', vec(...PN)),
    uProbeT: g('f32', PROBE_T),
    uShK: g('f32', cfg.shK),
    uBinOb: g('f32', cfg.binOb),
    uFold: g('f32', cfg.fold),
    uSkyaoN: g('vec3<f32>', vec(...SKY_N)),
    uSkyaoTiles: g('vec2<f32>', vec(...SKY_TILES)),
    uSkyaoMin: g('vec3<f32>', vec(-1.5, -1.5, -1.5)),
    uSkyaoScale: g('vec3<f32>', vec(1 / 3, 1 / 3, 1 / 3)),
    uSkyaoM: g('mat3x3<f32>', colMajor(skyRows)),
    uSkyaoOn: g('f32', cfg.skyaoOn),
    uAmbSH: g('vec3<f32>', ambSH, 9),
    uMode: g('f32', cfg.mode),
    uAmbStrength: g('f32', 0.7),
    uVolN: g('vec3<f32>', vec(...VOL_N)),
    uVolTiles: g('vec2<f32>', vec(...VOL_TILES)),
    uQMin: g('vec3<f32>', vec(-1, -1, -1)),
    uQMax: g('vec3<f32>', vec(1, 1, 1)),
    uSpp: g('f32', cfg.spp),
    uMSteps: g('f32', cfg.msteps),
    uMissMode: g('f32', cfg.missMode),
    uNEE: g('f32', cfg.nee),
    uStep: g('f32', 0.9),
    uLightCount: g('f32', cfg.lightCount),
    uLightQ: g('vec4<f32>', lightQ, 48),
    uLightE: g('vec4<f32>', lightE, 48),
  };
}

const CLC_PROGRAM: KernelProgram = {
  tiles: 11, tw: 16, th: 16, k: 4,
  textures: ['uPL1', 'uPL2', 'uPBin', 'uValid', 'uVolRad', 'uVolEmit', 'uSkyaoTex'].map((name) => ({ name, sampled: false })),
  glHead: CHAR_LIGHT_COMMON_GLSL,
  wgslHead: CHAR_LIGHT_COMMON_WGSL,
  glMain: /* glsl */ `
    vec4 a = IN(pix, 0); vec4 b = IN(pix, 1); vec4 c = IN(pix, 2); vec4 d = IN(pix, 3);
    vec3 q = (a.xyz * 2.0 - 1.0) * 1.2;
    vec3 n = normalize(b.xyz * 2.0 - 1.0 + vec3(0.0, 0.0, 1e-3));
    if (tile == 0) {
        o = vec4(probeE(q, n), probeGridT(q).y);
    } else if (tile == 1) {
        vec2 pt = vec2(probeTexel(int(c.x * 119.0), 3, int(c.y * 3.0)));
        o = vec4(probeENearest(q, n), pt.x + pt.y * 1000.0);
    } else if (tile == 2) {
        o = vec4(ambIrr(n), shY(int(c.x * 25.0), n));
    } else if (tile == 3) {
        int ob = int(uBinOb + 0.5);
        ivec2 oc = ivec2(floor(c.xy * float(ob + 4))) - 2;
        o = vec4(octaEnc(n), float(octaIdx(oc, ob)), hash12(c.zw * 500.0));
    } else if (tile == 4) {
        o = vec4(skyaoAt(q, n), skyaoBox(q).xy, skyaoRaw(q).x);
    } else if (tile == 5) {
        o = vec4(skyaoBand(q, n), sampleSkyao(clamp(c.xyz * 1.2 - 0.1, 0.0, 1.0)).w);
    } else if (tile == 6) {
        o = sampleVol3(uVolRad, clamp(c.xyz * 1.2 - 0.1, 0.0, 1.0));
    } else if (tile == 7) {
        vec3 hi = uVolN - 1.0;
        vec3 p0 = (c.xyz * 1.6 - 0.3) * hi;
        vec3 dn = normalize(d.xyz * 2.0 - 1.0 + vec3(0.0, 0.0, 1e-3));
        dn = d.w > 0.7 ? normalize(vec3(dn.x, 0.0, dn.z)) : dn;
        o = vec4(boxEnter(p0, dn, hi), ambRad(n).xy);
    } else if (tile == 8) {
        vec3 x = c.xyz;
        vec3 E = d.xyz * 3.0;
        o = vec4(srgb2lin(x).x, lin2srgb(x * 1.2 - 0.1).y, shadeCharacterLinear(x, E, a.w, 1.5 + b.w).z,
                 shadeEntityLinear(x, E, b.xyz, 0.8, 1.3, 0.9, a.w).x);
    } else if (tile == 9) {
        o = vec4(shadeEntityLinear(c.xyz, d.xyz * 3.0, b.xyz, 1.0 + a.w, 0.5, 1.1, c.w), probeQueryN(n).z);
    } else {
        o = vec4(gatherRT(q + n * 0.02, n), 0.0);
    }`,
  wgslMain: /* wgsl */ `
    // 宿主按字段名逐个赋值建参数结构(见 charLightCommon.wgsl 文件头)
    var pp: ClcProbe;
    pp.uM = tc.uM; pp.uWMin = tc.uWMin; pp.uWScale = tc.uWScale; pp.uPN = tc.uPN;
    pp.uProbeT = tc.uProbeT; pp.uShK = tc.uShK; pp.uBinOb = tc.uBinOb; pp.uFold = tc.uFold;
    pp.uAmbSH = tc.uAmbSH; pp.uMode = tc.uMode; pp.uAmbStrength = tc.uAmbStrength;
    var sk: ClcSkyao;
    sk.uSkyaoN = tc.uSkyaoN; sk.uSkyaoTiles = tc.uSkyaoTiles; sk.uSkyaoMin = tc.uSkyaoMin;
    sk.uSkyaoScale = tc.uSkyaoScale; sk.uSkyaoM = tc.uSkyaoM; sk.uSkyaoOn = tc.uSkyaoOn;
    var vv: ClcVol;
    vv.uVolN = tc.uVolN; vv.uVolTiles = tc.uVolTiles; vv.uQMin = tc.uQMin; vv.uQMax = tc.uQMax;

    let a = IN(pix, 0); let b = IN(pix, 1); let c = IN(pix, 2); let d = IN(pix, 3);
    let q = (a.xyz * 2.0 - 1.0) * 1.2;
    let n = normalize(b.xyz * 2.0 - 1.0 + vec3<f32>(0.0, 0.0, 1e-3));
    if (tile == 0) {
        o = vec4<f32>(probeE(q, n, pp, uPL1, uPL2, uPBin, uValid), probeGridT(q, pp).y);
    } else if (tile == 1) {
        let pt = vec2<f32>(probeTexel(i32(c.x * 119.0), 3, i32(c.y * 3.0), pp));
        o = vec4<f32>(probeENearest(q, n, pp, uPL1, uPL2, uPBin, uValid), pt.x + pt.y * 1000.0);
    } else if (tile == 2) {
        o = vec4<f32>(ambIrr(n, pp), shY(i32(c.x * 25.0), n));
    } else if (tile == 3) {
        let ob = i32(tc.uBinOb + 0.5);
        let oc = vec2<i32>(floor(c.xy * f32(ob + 4))) - 2;
        o = vec4<f32>(octaEnc(n), f32(octaIdx(oc, ob)), hash12(c.zw * 500.0));
    } else if (tile == 4) {
        o = vec4<f32>(skyaoAt(q, n, sk, uSkyaoTex), skyaoBox(q, sk).xy, skyaoRaw(q, sk, uSkyaoTex).x);
    } else if (tile == 5) {
        o = vec4<f32>(skyaoBand(q, n, sk, uSkyaoTex), sampleSkyao(clamp(c.xyz * 1.2 - 0.1, vec3<f32>(0.0), vec3<f32>(1.0)), sk, uSkyaoTex).w);
    } else if (tile == 6) {
        o = sampleVol3(uVolRad, clamp(c.xyz * 1.2 - 0.1, vec3<f32>(0.0), vec3<f32>(1.0)), vv);
    } else if (tile == 7) {
        let hi = tc.uVolN - 1.0;
        let p0 = (c.xyz * 1.6 - 0.3) * hi;
        var dn = normalize(d.xyz * 2.0 - 1.0 + vec3<f32>(0.0, 0.0, 1e-3));
        if (d.w > 0.7) { dn = normalize(vec3<f32>(dn.x, 0.0, dn.z)); }
        o = vec4<f32>(boxEnter(p0, dn, hi), ambRad(n, pp).xy);
    } else if (tile == 8) {
        let x = c.xyz;
        let E = d.xyz * 3.0;
        o = vec4<f32>(srgb2lin(x).x, lin2srgb(x * 1.2 - 0.1).y, shadeCharacterLinear(x, E, a.w, 1.5 + b.w).z,
                      shadeEntityLinear(x, E, b.xyz, 0.8, 1.3, 0.9, a.w).x);
    } else if (tile == 9) {
        o = vec4<f32>(shadeEntityLinear(c.xyz, d.xyz * 3.0, b.xyz, 1.0 + a.w, 0.5, 1.1, c.w), probeQueryN(n, pp).z);
    } else {
        var rt: ClcRt;
        rt.uSpp = tc.uSpp; rt.uMSteps = tc.uMSteps; rt.uMissMode = tc.uMissMode; rt.uNEE = tc.uNEE;
        rt.uStep = tc.uStep; rt.uLightCount = tc.uLightCount; rt.uLightQ = tc.uLightQ; rt.uLightE = tc.uLightE;
        o = vec4<f32>(gatherRT(q + n * 0.02, n, pos.xy, pp, vv, &rt, uVolRad, uVolEmit), 0.0);
    }`,
};

/**
 * PROBE + SKYAO 两段单独拼(场景光照 pass 的 GI 体 / skyao 体调试视图就是这么拼的,不带 CLC 其余部分):
 * 证明两段切片各自自足。GLSL 那边 skyao 的 uniform 声明住在 PROBE 段里,WGSL 那边 ClcSkyao 住在 SKYAO 段里。
 */
const PROBE_SKYAO_PROGRAM: KernelProgram = {
  tiles: 4, tw: 16, th: 16, k: 3,
  textures: ['uPL1', 'uPL2', 'uPBin', 'uValid', 'uSkyaoTex'].map((name) => ({ name, sampled: false })),
  glHead: `${PROBE_SAMPLING_GLSL}\n${SKYAO_SAMPLING_GLSL}`,
  wgslHead: `${PROBE_SAMPLING_WGSL}\n${SKYAO_SAMPLING_WGSL}`,
  glMain: /* glsl */ `
    vec4 a = IN(pix, 0); vec4 b = IN(pix, 1); vec4 c = IN(pix, 2);
    vec3 q = (a.xyz * 2.0 - 1.0) * 1.2;
    vec3 n = normalize(b.xyz * 2.0 - 1.0 + vec3(0.0, 0.0, 1e-3));
    if (tile == 0) {
        o = vec4(probeE(q, n), probeGridT(q).z);
    } else if (tile == 1) {
        o = vec4(probeENearest(q, n), float(probeTexel(int(c.x * 119.0), 1, 0).y));
    } else if (tile == 2) {
        o = vec4(ambIrr(n), skyaoAt(q, n));
    } else {
        o = sampleSkyao(clamp(c.xyz * 1.2 - 0.1, 0.0, 1.0));
    }`,
  wgslMain: /* wgsl */ `
    var pp: ClcProbe;
    pp.uM = tc.uM; pp.uWMin = tc.uWMin; pp.uWScale = tc.uWScale; pp.uPN = tc.uPN;
    pp.uProbeT = tc.uProbeT; pp.uShK = tc.uShK; pp.uBinOb = tc.uBinOb; pp.uFold = tc.uFold;
    pp.uAmbSH = tc.uAmbSH; pp.uMode = tc.uMode; pp.uAmbStrength = tc.uAmbStrength;
    var sk: ClcSkyao;
    sk.uSkyaoN = tc.uSkyaoN; sk.uSkyaoTiles = tc.uSkyaoTiles; sk.uSkyaoMin = tc.uSkyaoMin;
    sk.uSkyaoScale = tc.uSkyaoScale; sk.uSkyaoM = tc.uSkyaoM; sk.uSkyaoOn = tc.uSkyaoOn;
    let a = IN(pix, 0); let b = IN(pix, 1); let c = IN(pix, 2);
    let q = (a.xyz * 2.0 - 1.0) * 1.2;
    let n = normalize(b.xyz * 2.0 - 1.0 + vec3<f32>(0.0, 0.0, 1e-3));
    if (tile == 0) {
        o = vec4<f32>(probeE(q, n, pp, uPL1, uPL2, uPBin, uValid), probeGridT(q, pp).z);
    } else if (tile == 1) {
        o = vec4<f32>(probeENearest(q, n, pp, uPL1, uPL2, uPBin, uValid), f32(probeTexel(i32(c.x * 119.0), 1, 0, pp).y));
    } else if (tile == 2) {
        o = vec4<f32>(ambIrr(n, pp), skyaoAt(q, n, sk, uSkyaoTex));
    } else {
        o = sampleSkyao(clamp(c.xyz * 1.2 - 0.1, vec3<f32>(0.0), vec3<f32>(1.0)), sk, uSkyaoTex);
    }`,
};

interface ClcCfg {
  mode: number; shK: number; binOb: number; fold: number; skyaoOn: number;
  spp: number; msteps: number; missMode: number; nee: number; lightCount: number;
}

function clcRun(cfg: ClcCfg): (env: ParityEnv) => KernelRun {
  return (env) => {
    const probe = (x: number, y: number, ncol: number) => {
      const flat = y * PROBE_T + Math.floor(x / ncol);
      return { flat, col: x % ncol };
    };
    const pl1 = env.dataTexture({
      width: PROBE_T * 4, height: PROBE_ROWS, seed: 41, format: 'rgba16float',
      fill: (x, y, c, rng) => (c === 3 ? 1 : probe(x, y, 4).col === 0 ? 0.5 + rng() * 2 : (rng() - 0.5) * 1.6),
    });
    const pl2 = env.dataTexture({
      width: PROBE_T * cfg.shK, height: PROBE_ROWS, seed: 42, format: 'rgba16float',
      fill: (x, y, c, rng) => (c === 3 ? 1 : probe(x, y, cfg.shK).col === 0 ? 0.5 + rng() * 1.5 : (rng() - 0.5) * 1.2),
    });
    const B = cfg.binOb * cfg.binOb;
    const pbin = env.dataTexture({
      width: PROBE_T * B, height: PROBE_ROWS, seed: 43, format: 'rgba16float',
      fill: (_x, _y, c, rng) => (c === 3 ? 1 : rng() * 2),
    });
    // 前两层(x 格 0、1)整片失效 ⇒ 落在那里的查询 8 个角全无效,走 ambIrr 兜底;其余随机 15% 失效
    const valid = env.dataTexture({
      width: PROBE_T, height: PROBE_ROWS, seed: 44, format: 'r8unorm',
      fill: (x, y, _c, rng) => {
        const flat = y * PROBE_T + x;
        if (flat >= PROBE_COUNT) return 0;
        const i = Math.floor(flat / (PN[1] * PN[2]));
        return i <= 1 || rng() < 0.15 ? 0 : 1;
      },
    });
    const volRad = env.dataTexture({
      width: VOL_TILES[0] * VOL_N[0], height: VOL_TILES[1] * VOL_N[1], seed: 45, format: 'rgba16float',
      fill: (_x, _y, c, rng) => (c === 3 ? (rng() < 0.25 ? 1 : 0) : rng() * 2),
    });
    const volEmit = env.dataTexture({
      width: VOL_TILES[0] * VOL_N[0], height: VOL_TILES[1] * VOL_N[1], seed: 46, format: 'rgba16float',
      fill: (_x, _y, c, rng) => (c === 3 ? 0 : rng()),
    });
    const skyao = env.dataTexture({
      width: SKY_TILES[0] * SKY_N[0], height: SKY_TILES[1] * SKY_N[1], seed: 47, format: 'rgba16float',
      fill: (_x, _y, c, rng) => (c === 0 ? 0.2 + rng() * 0.8 : (rng() - 0.5) * 0.8),
    });
    return {
      spec: clcSpec(cfg, env),
      textures: { uPL1: pl1, uPL2: pl2, uPBin: pbin, uValid: valid, uVolRad: volRad, uVolEmit: volEmit, uSkyaoTex: skyao },
      // skyao 关:tile 4 的三个函数都恒返回「不遮蔽 / 品红」
      constantTiles: cfg.skyaoOn ? [] : [4],
    };
  };
}

const CLC_BASE: ClcCfg = {
  mode: 2, shK: 9, binOb: 8, fold: 1, skyaoOn: 1, spp: 4, msteps: 16, missMode: 0, nee: 0, lightCount: 0,
};

// ═════════════════════════════ D. 实体灯循环(ENTITY_SCENE_LIGHTS,真实的 charLights 组)

const ESL_GL_DECLS = /* glsl */ `
uniform int  uSceneLightCount;
uniform vec4 uSceneLightA[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightB[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightC[${MAX_STATIC_LIGHTS}];
uniform vec4 uSceneLightD[${MAX_STATIC_LIGHTS}];
uniform vec3 uSMRow0;
uniform vec3 uSMRow1;
uniform vec3 uSMRow2;
uniform float uSMWuPerQUnit;
`;

const ESL_PROGRAM: KernelProgram = {
  tiles: 3, tw: 16, th: 16, k: 3,
  textures: [],
  extraGroups: [{ name: 'charLights', struct: 'CharLights' }],
  glHead: `${ESL_GL_DECLS}\n${WR_CORE}\n${LC}\n${ENTITY_SCENE_LIGHTS_GLSL}`,
  wgslHead: `${CHAR_LIGHTS_WGSL}\n${WR_CORE_WGSL}\n${LC_WGSL}\n${ENTITY_SCENE_LIGHTS_WGSL}`,
  glMain: /* glsl */ `
    vec4 a = IN(pix, 0); vec4 b = IN(pix, 1); vec4 c = IN(pix, 2);
    vec3 q = (a.xyz * 2.0 - 1.0) * 1.5;
    vec3 n = normalize(b.xyz * 2.0 - 1.0 + vec3(0.0, 0.0, 1e-3));
    if (tile == 0) {
        o = vec4(entitySceneLightsE(q, n), uDummy);
    } else {
        vec3 an = c.w > 0.6 ? normalize(vec3(n.x * 0.1, sign(n.y) + 0.001, n.z * 0.1)) : n;
        vec3 hu, hv;
        litAreaAxes(an, c.x * 3.0, c.y * 2.0, c.z * 6.2831853 - 3.14159265, hu, hv);
        o = tile == 1 ? vec4(hu, hv.x) : vec4(hv.yz, an.y, 0.0);
    }`,
  wgslMain: /* wgsl */ `
    let a = IN(pix, 0); let b = IN(pix, 1); let c = IN(pix, 2);
    let q = (a.xyz * 2.0 - 1.0) * 1.5;
    let n = normalize(b.xyz * 2.0 - 1.0 + vec3<f32>(0.0, 0.0, 1e-3));
    if (tile == 0) {
        o = vec4<f32>(entitySceneLightsE(q, n), tc.uDummy);
    } else {
        var an = n;
        if (c.w > 0.6) { an = normalize(vec3<f32>(n.x * 0.1, sign(n.y) + 0.001, n.z * 0.1)); }
        var hu: vec3<f32>;
        var hv: vec3<f32>;
        litAreaAxes(an, c.x * 3.0, c.y * 2.0, c.z * 6.2831853 - 3.14159265, &hu, &hv);
        if (tile == 1) { o = vec4<f32>(hu, hv.x); } else { o = vec4<f32>(hv.yz, an.y, 0.0); }
    }`,
};

type LightRow = { a: number[]; b: number[]; c: number[]; d: number[] };

/** 灯按 lightPacking 的 A/B/C/D 布局手排(kind:0 点 1 聚 2 面 3 平行 4 线;D.w bit1 = 双面) */
const MIXED_LIGHTS: LightRow[] = [
  { a: [1, 2, -1, 0], b: [1, 0.8, 0.6, 8], c: [6, 0.3, 0, 0], d: [0, 0, 0, 0] },
  { a: [-2, 3, 0, 1], b: [0.5, 0.7, 1, 12], c: [8, 0.5, 0.9, 0.6], d: [0.3, -1, 0.2, 0] },
  { a: [0, 1, 2, 2], b: [1, 1, 0.8, 3], c: [7, 0.4, 1.5, 0.8], d: [0, 0, -1, 0] },
  { a: [2, -1, 0, 2], b: [0.9, 0.6, 0.4, 2.5], c: [6, -0.7, 1, 2], d: [0, 1, 0.05, 2] },
  { a: [-3, 0, 1, 4], b: [0.7, 0.8, 1, 10], c: [9, 0.2, 0, 0], d: [4, 3, 0, 0] },
  { a: [0, 0, 0, 3], b: [0.3, 0.3, 0.4, 0.8], c: [0, 0, 0, 0], d: [0.2, 1, 0.3, 0] },
  { a: [0, 0, 0, 0], b: [1, 1, 1, 0], c: [5, 0.2, 0, 0], d: [0, 0, 0, 0] },
  { a: [-1, -2, 1, 0], b: [1, 0.4, 0.2, 5], c: [4, 0.1, 0, 0], d: [0, 0, 0, 1] },
  { a: [1, 4, 1, 1], b: [0.8, 1, 0.6, 30], c: [10, 0.4, 0.995, 0.97], d: [0, -1, 0, 0] },
  // 下标 9 不在 count 里:照度大到一旦被算进来就一眼可见
  { a: [0, 0.5, 0, 0], b: [1, 1, 1, 1000], c: [50, 0.1, 0, 0], d: [0, 0, 0, 0] },
];

function randomLights(env: ParityEnv, count: number): LightRow[] {
  const rng = env.rng(61);
  const out: LightRow[] = [];
  for (let i = 0; i < count; i++) {
    const kind = Math.floor(rng() * 5);
    const p = [(rng() - 0.5) * 8, (rng() - 0.5) * 8, (rng() - 0.5) * 8];
    const col = [rng(), rng(), rng()];
    const dir = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
    const c = kind === 1 ? [4 + rng() * 6, 0.1 + rng(), 0.9 + rng() * 0.09, 0.5 + rng() * 0.3]
      : kind === 2 ? [4 + rng() * 6, (rng() - 0.5) * 3, 0.5 + rng() * 2, 0.5 + rng() * 2]
        : [4 + rng() * 6, 0.1 + rng(), 0, 0];
    out.push({ a: [...p, kind], b: [...col, 0.5 + rng() * 10], c, d: [...dir, rng() < 0.5 ? 2 : 0] });
  }
  return out;
}

function eslRun(lights: LightRow[], count: number, wuPerQUnit: number): (env: ParityEnv) => KernelRun {
  return () => {
    const n = MAX_STATIC_LIGHTS * 4;
    const packed = { a: new Float32Array(n), b: new Float32Array(n), c: new Float32Array(n), d: new Float32Array(n), count };
    lights.slice(0, MAX_STATIC_LIGHTS).forEach((l, i) => {
      packed.a.set(l.a, i * 4); packed.b.set(l.b, i * 4); packed.c.set(l.c, i * 4); packed.d.set(l.d, i * 4);
    });
    const group = createCharLightUniforms();
    applyCharLights(group, packed as unknown as PackedLights, rotXRows(40), wuPerQUnit);
    return {
      spec: { uDummy: { type: 'f32', value: 0.25 } },
      textures: {},
      groups: { charLights: group },
      constantTiles: count === 0 ? [0] : [],
    };
  };
}

// ═════════════════════════════ 用例

/**
 * 容差:输出是 rgba32float,两侧最终都进同一个 SwiftShader,翻译等价时预期逐位相同或只差个位 ulp。
 * 实测(无头 SwiftShader,2026-09-25):WR / CLC(含 gatherRT)/ PROBE+SKYAO 两段 / 0 盏与 24 盏实体灯
 * **逐位相同**;LC 最大差 3.7e-9、LC+WR 整份 3.0e-8、混合实体灯 2.4e-7(值域 ~17,即个位 ulp)。
 * 变异自检(面光绕向 / probe 法线偏置 / 双面位各改一处 WGSL)全部当场变红,最大差 5e-3 ~ 6。
 * 以后出现非零差先查翻译,不许放宽。
 */
const TOL = 1e-4;

export const cases: ParityCase[] = [
  kernelCase('光照片段 / LC 全部函数 · 显示变换恒等 · 深度 nearest', LC_PROGRAM, TOL, lcRun(LC_BASE)),
  kernelCase('光照片段 / LC 全部函数 · reinhard + 饱和/对比/暗部提升 · 反深度 · 深度 linear', LC_PROGRAM, TOL,
    lcRun({ ...LC_BASE, tone: 1, ev: -0.7, wb: [1.08, 1, 0.9], sat: 0.6, con: 1.3, lift: 0.5, liftC: [0.9, 1, 1.2], depthInvert: 1, steps: 40, scaleMode: 'linear' })),
  kernelCase('光照片段 / LC 全部函数 · filmic + 曝光 · march 128 步封顶', LC_PROGRAM, TOL,
    lcRun({ ...LC_BASE, tone: 2, ev: 1.5, wb: [0.95, 1, 1.1], sat: 1.25, con: 0.8, lift: 0.15, liftC: [1, 0.9, 0.8], steps: 128 })),

  kernelCase('光照片段 / LC + WR 整份文件拼接', LC_FULL_PROGRAM, TOL,
    lcRun({ ...LC_BASE, tone: 2, sat: 0.9, con: 1.1, lift: 0.3 })),

  kernelCase('光照片段 / WR 三段全部函数 · nearest 纹理', WR_PROGRAM, TOL,
    wrRun({ scaleMode: 'nearest', ext: [1200, 800], eps: 1e-3, invert: 0 })),
  kernelCase('光照片段 / WR 三段全部函数 · linear 纹理 · 反深度 · 退化场景尺寸', WR_PROGRAM, TOL,
    wrRun({ scaleMode: 'linear', ext: [1200, 1e-7], eps: 1e-5, invert: 1 })),

  kernelCase('光照片段 / CLC L2(9 系数) · 折叠 · skyao 开', CLC_PROGRAM, TOL, clcRun(CLC_BASE)),
  kernelCase('光照片段 / CLC L1 Geomerics · 不折叠 · skyao 关', CLC_PROGRAM, TOL,
    clcRun({ ...CLC_BASE, mode: 1, fold: 0, skyaoOn: 0 })),
  kernelCase('光照片段 / CLC L4(25 系数) · 折叠', CLC_PROGRAM, TOL, clcRun({ ...CLC_BASE, shK: 25 })),
  kernelCase('光照片段 / CLC 八面体 8×8', CLC_PROGRAM, TOL, clcRun({ ...CLC_BASE, mode: 3, binOb: 8 })),
  kernelCase('光照片段 / CLC 八面体 16×16 · 不折叠', CLC_PROGRAM, TOL, clcRun({ ...CLC_BASE, mode: 3, binOb: 16, fold: 0 })),
  kernelCase('光照片段 / CLC gatherRT · miss 记环境 · NEE 关', CLC_PROGRAM, TOL,
    clcRun({ ...CLC_BASE, mode: 0, spp: 12, msteps: 48, missMode: 0, nee: 0 })),
  kernelCase('光照片段 / CLC gatherRT · miss 归一 · NEE 6 盏 · 不折叠', CLC_PROGRAM, TOL,
    clcRun({ ...CLC_BASE, mode: 0, spp: 10, msteps: 40, missMode: 1, nee: 1, lightCount: 6, fold: 0 })),
  kernelCase('光照片段 / CLC gatherRT · NEE 48 盏满载', CLC_PROGRAM, TOL,
    clcRun({ ...CLC_BASE, mode: 0, spp: 5, msteps: 30, missMode: 0, nee: 1, lightCount: 48 })),

  kernelCase('光照片段 / PROBE + SKYAO 两段单独拼 · L1', PROBE_SKYAO_PROGRAM, TOL, clcRun({ ...CLC_BASE, mode: 1 })),
  kernelCase('光照片段 / PROBE + SKYAO 两段单独拼 · 八面体 16×16', PROBE_SKYAO_PROGRAM, TOL, clcRun({ ...CLC_BASE, mode: 3, binOb: 16 })),

  kernelCase('光照片段 / 实体灯循环 · 各种灯混合(含强度 0 / count 截断)', ESL_PROGRAM, TOL,
    eslRun(MIXED_LIGHTS, 9, 2.5)),
  kernelCase('光照片段 / 实体灯循环 · 0 盏(早退)', ESL_PROGRAM, TOL, eslRun(MIXED_LIGHTS, 0, 2.5)),
  kernelCase('光照片段 / 实体灯循环 · 24 盏满载随机', ESL_PROGRAM, TOL,
    (env) => eslRun(randomLights(env, MAX_STATIC_LIGHTS), MAX_STATIC_LIGHTS, 1.7)(env)),
];
