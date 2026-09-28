/** Tool-only composition of the shared burn functions. The frozen legacy BurnGL test is the oracle. */
import { GpuProgram, ImageSource, Mesh, MeshGeometry, Shader, Texture, UniformGroup } from '../../../src/engine2d';
import { BURN_SHADE_WGSL, BurnFieldTexture } from '../../../src/rendering/burn/BurnFilters';
import type { BurnFrame } from '../../../src/systems/burn/burnGeometry';
import type { BurnFieldInput } from './burnView';

const WGSL = /* wgsl */ `
struct BurnPreviewUniforms {
  uScreen: vec2<f32>,
  uBurnOn: f32,
  uBurnGrid: vec2<f32>,
  uBurnNow: f32,
  uBurnStep: f32,
  uBurnFlame: f32,
  uBurnEmber: f32,
  uBurnScorch: f32,
  uBurnAshFade: f32,
  uBurnEdgeNoise: f32,
  uBurnScorchColor: vec3<f32>,
  uBurnCharColor: vec3<f32>,
  uBurnAshColor: vec3<f32>,
  uBurnAshAlpha: f32,
  uBurnGlow: vec3<f32>,
  uBurnEmberGlow: vec3<f32>,
};
@group(0) @binding(0) var<uniform> burnUniforms: BurnPreviewUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(0) @binding(3) var uBurnField: texture_2d<f32>;
@group(0) @binding(4) var uBurnFieldSampler: sampler;
struct VertexOut { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VertexOut {
  let c = aPosition / burnUniforms.uScreen * 2.0 - 1.0;
  // engine2d draws into a GL-origin backing texture, then flips once when presenting.
  return VertexOut(vec4<f32>(c.x, c.y, 0.0, 1.0), aUV);
}
${BURN_SHADE_WGSL}
@fragment fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let c = textureSample(uTexture, uSampler, uv);
  if (c.a < 1e-4) { return vec4<f32>(0.0); }
  var rgb = c.rgb;
  var a = c.a;
  if (burnUniforms.uBurnOn == 1.0) {
    var emit: vec3<f32>;
    let b = burnSample(uv, &emit);
    let m = burnMaterial(rgb, a, b);
    rgb = min(m.rgb + burnGlowAdd(emit), vec3<f32>(4.0));
    a = m.a;
  }
  // Straight-alpha interpolation first, premultiply only after the combined material/glow result.
  return vec4<f32>(rgb * a, a);
}
`;

let program: GpuProgram | undefined;
function previewProgram(): GpuProgram {
  return program ??= GpuProgram.from({ name: 'burn-workbench-single-pass',
    vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
}

export class BurnPreviewQuad {
  readonly geometry = new MeshGeometry();
  readonly uniforms = new UniformGroup({
    uScreen: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uBurnOn: { value: 0, type: 'f32' },
    uBurnGrid: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uBurnNow: { value: 0, type: 'f32' }, uBurnStep: { value: 1 / 16, type: 'f32' },
    uBurnFlame: { value: 1, type: 'f32' }, uBurnEmber: { value: 1, type: 'f32' },
    uBurnScorch: { value: 1, type: 'f32' }, uBurnAshFade: { value: 1, type: 'f32' },
    uBurnEdgeNoise: { value: 0, type: 'f32' },
    uBurnScorchColor: { value: new Float32Array(3), type: 'vec3<f32>' },
    uBurnCharColor: { value: new Float32Array(3), type: 'vec3<f32>' },
    uBurnAshColor: { value: new Float32Array(3), type: 'vec3<f32>' },
    uBurnAshAlpha: { value: 0, type: 'f32' },
    uBurnGlow: { value: new Float32Array(3), type: 'vec3<f32>' },
    uBurnEmberGlow: { value: new Float32Array(3), type: 'vec3<f32>' },
  });
  readonly shader: Shader;
  readonly mesh: Mesh;
  private field = new BurnFieldTexture(1, 1);
  private mark: { source: object; gen: number } | null = null;

  constructor(texture: Texture) {
    this.shader = new Shader({ gpuProgram: previewProgram(), resources: {
      burnUniforms: this.uniforms, uTexture: texture.source, uSampler: texture.source.style,
      uBurnField: this.field.source, uBurnFieldSampler: this.field.source.style,
    } });
    // The fragment returns PMA. Keep Mesh's default PMA blend source (WHITE); binding the straight
    // artwork as mesh.texture would make engine2d auto-select an NPM blend and multiply alpha twice.
    this.mesh = new Mesh({ geometry: this.geometry, shader: this.shader });
    this.mesh.label = 'burn-workbench-quad';
  }

  get burning(): boolean { return this.uniforms.uniforms.uBurnOn === 1; }

  place(f: BurnFrame, cam: { scale: number; x: number; y: number }, screen: { width: number; height: number }): void {
    const pos = this.geometry.positions;
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([u, v], i) => {
      pos[i * 2] = (f.ox + u * f.ux + v * f.vx) * cam.scale + cam.x;
      pos[i * 2 + 1] = (f.oy + u * f.uy + v * f.vy) * cam.scale + cam.y;
    });
    this.geometry.getBuffer('aPosition').update();
    this.uniforms.uniforms.uScreen.set([screen.width, screen.height]);
  }

  setBurn(b: BurnFieldInput | null): void {
    const u = this.uniforms.uniforms;
    u.uBurnOn = b ? 1 : 0;
    if (!b) {
      if (this.mark) {
        const old = this.field;
        this.field = new BurnFieldTexture(1, 1);
        this.shader.resources.uBurnField = this.field.source;
        this.shader.resources.uBurnFieldSampler = this.field.source.style;
        old.destroy();
      }
      this.mark = null;
      return;
    }
    if (this.field.width !== b.gridW || this.field.height !== b.gridH) {
      const old = this.field;
      this.field = new BurnFieldTexture(b.gridW, b.gridH);
      this.shader.resources.uBurnField = this.field.source;
      this.shader.resources.uBurnFieldSampler = this.field.source.style;
      this.mark = null;
      old.destroy();
    }
    if (this.mark?.source !== b.source || this.mark.gen !== b.gen) {
      b.encode(this.field.data);
      this.field.upload();
      this.mark = { source: b.source, gen: b.gen };
    }
    const p = b.params;
    u.uBurnGrid.set([p.gridW, p.gridH]);
    u.uBurnNow = p.now; u.uBurnStep = p.timeStep; u.uBurnFlame = p.flameSeconds;
    u.uBurnEmber = p.emberSeconds; u.uBurnScorch = p.scorchSeconds;
    u.uBurnAshFade = p.ashFadeSeconds; u.uBurnEdgeNoise = p.edgeNoise;
    u.uBurnScorchColor.set(p.scorchColor); u.uBurnCharColor.set(p.charColor); u.uBurnAshColor.set(p.ashColor);
    u.uBurnAshAlpha = p.ashAlpha; u.uBurnGlow.set(p.glow); u.uBurnEmberGlow.set(p.emberGlow);
  }

  destroy(): void {
    this.mesh.destroy();
    this.shader.destroy();
    this.geometry.destroy();
    this.field.destroy();
  }
}

/** Match legacy texImage2D(<img>, UNPACK_PREMULTIPLY_ALPHA=false), without changing Assets' cache. */
export async function loadPreviewTexture(url: string): Promise<Texture> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => { image.onload = image.onerror = null; resolve(); };
    image.onerror = () => { image.onload = image.onerror = null; reject(new Error(`图片装载失败：${url}`)); };
    image.src = url;
  });
  return new Texture({ source: new ImageSource({ resource: image, alphaMode: 'no-premultiply-alpha', scaleMode: 'linear' }) });
}
