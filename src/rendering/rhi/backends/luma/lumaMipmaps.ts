/// <reference types="@webgpu/types" />
/**
 * WebGPU mip 生成器(照 Pixi 8.17 `GpuMipmapGenerator`):管线 / 着色器 / 采样器按格式建一次缓存,
 * 一张纹理的全部级录进**一个**命令编码器、**一次**提交。
 *
 * 不用 luma 的 `generateMipmapsWebGPU`:它每次调用都现建两个着色器模块、一条渲染管线、采样器、uniform 缓冲,
 * 用完即毁,且每一级 `device.submit()` 一次(HUD 三团火图集 10 级 = 10 次提交 + 一次同步建管线),
 * 首次上传 / GC 回收后重传时会卡一帧;Pixi WebGPU 与 master 的 WebGL `generateMipmap` 都没有这一下。
 *
 * 只走「纹理本身可作附件」一条路(RHI 的 generateMipmaps 已要求 RENDER_TARGET),
 * 即 Pixi 的 `renderToSource` 分支:逐级把上一级线性采样画到下一级。
 */

const MIPMAP_WGSL = /* wgsl */ `
var<private> pos : array<vec2<f32>, 3> = array<vec2<f32>, 3>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(-1.0, 3.0), vec2<f32>(3.0, -1.0));

struct VertexOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) texCoord : vec2<f32>,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex : u32) -> VertexOutput {
  var output : VertexOutput;
  output.texCoord = pos[vertexIndex] * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
  return output;
}

@group(0) @binding(0) var imgSampler : sampler;
@group(0) @binding(1) var img : texture_2d<f32>;

@fragment
fn fragmentMain(@location(0) texCoord : vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(img, imgSampler, texCoord);
}
`;

export class WebGpuMipmapGenerator {
  private module: GPUShaderModule | null = null;
  private sampler: GPUSampler | null = null;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(private readonly device: GPUDevice) {}

  private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let pipeline = this.pipelines.get(format);
    if (!pipeline) {
      this.module ??= this.device.createShaderModule({ label: 'rhi-mipmap', code: MIPMAP_WGSL });
      pipeline = this.device.createRenderPipeline({
        label: `rhi-mipmap:${format}`,
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vertexMain' },
        fragment: { module: this.module, entryPoint: 'fragmentMain', targets: [{ format }] },
      });
      this.pipelines.set(format, pipeline);
    }
    return pipeline;
  }

  /** 按 level 0 生成其余各级(纹理须 2D、带 RENDER_ATTACHMENT | TEXTURE_BINDING) */
  generate(texture: GPUTexture): void {
    if (texture.mipLevelCount <= 1) return;
    if (texture.dimension !== '2d') throw new Error(`只支持 2D 纹理生成 mip(当前 ${texture.dimension})`);
    const pipeline = this.pipelineFor(texture.format);
    this.sampler ??= this.device.createSampler({ label: 'rhi-mipmap', minFilter: 'linear' });
    const layout = pipeline.getBindGroupLayout(0);
    const encoder = this.device.createCommandEncoder({ label: 'rhi-mipmap' });
    const layers = texture.depthOrArrayLayers || 1;
    for (let layer = 0; layer < layers; layer++) {
      let src = texture.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
      for (let level = 1; level < texture.mipLevelCount; level++) {
        const dst = texture.createView({ dimension: '2d', baseMipLevel: level, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 });
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
          layout,
          entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: src }],
        }));
        pass.draw(3, 1, 0, 0);
        pass.end();
        src = dst;
      }
    }
    this.device.queue.submit([encoder.finish()]);
  }
}
