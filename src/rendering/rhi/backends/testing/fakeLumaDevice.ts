/**
 * 单测用的假 luma 设备:让真的 LumaRhiDevice 在 node 里跑(不需要 GPU)。
 *
 * - 着色器布局用 luma 真的 WGSL 接口扫描器推(与真设备同一份逻辑);bind group 走 luma 真的 BindGroupFactory,
 *   只把最底层的「建 bind group / 取布局」换成计数桩。
 * - luma 这一层的 push / popErrorScope 是空操作(照 luma 关调试时的行为);原生 GPUDevice 桩有真正的错误作用域栈,
 *   `failCreate` 命中的对象在创建时往最近的匹配作用域里报错。
 * - 原生 pass 桩把调用记进 `log`;luma 的 render / compute pass 桩照 luma 9.4 WebGPURenderPass:setPipeline 直接转原生,
 *   setBindings 经 BindGroupFactory 取 bind group 再设给原生 pass,draw 前校验(`bindingsPipeline !== pipeline` 就抛)
 *   后经顶点数组的 bindBeforeRender 设顶点 / 索引缓冲再 draw。
 * - 顶点数组用 luma 真的 WebGPUVertexArray(物理槽位 / 逻辑槽位与真设备同一份推导)。
 * - 设备丢失:`lose()` 让 `lost` resolve(照 luma WebGPUDevice:原生 GPUDevice.lost → `{ reason: 'destroyed', message }`);
 *   `destroy()` 同真设备,之后 `lost` 也会 resolve。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _getDefaultBindGroupFactory, luma } from '@luma.gl/core';
import { scanWGSLInterface } from '@luma.gl/shadertools/wgsl';

// WebGPUVertexArray 不在 @luma.gl/webgpu 的入口导出里,按包内路径取
const lumaWebgpuDist = dirname(createRequire(import.meta.url).resolve('@luma.gl/webgpu'));
const { WebGPUVertexArray } = (await import(
  pathToFileURL(join(lumaWebgpuDist, 'adapter/resources/webgpu-vertex-array.js')).href
)) as { WebGPUVertexArray: new (device: unknown, props: unknown) => unknown };

export interface FakeLumaOptions {
  /** 编译信息里带 error 的着色器(按 id) */
  shaderCompileErrors?: string[];
  /** 建对象时往原生错误作用域报错:id → 错误类别 */
  failCreate?: Record<string, 'validation' | 'internal'>;
  maxTextureSize?: number;
}

type Call = [string, ...unknown[]];

export interface FakeLuma {
  device: unknown;
  /** 原生层调用记录 */
  log: Call[];
  counts: { bindGroups: number; bindGroupLayouts: number };
  /** 画布上下文桩 */
  canvasContext: { destroyed: boolean };
  /** 模拟设备丢失(GPU 进程崩溃 / 驱动重置 / 原生 GPUDevice.destroy()) */
  lose(message?: string): void;
}

export function createFakeLuma(options: FakeLumaOptions = {}): FakeLuma {
  const log: Call[] = [];
  const counts = { bindGroups: 0, bindGroupLayouts: 0 };
  const scopes: { filter: string; error: { message: string } | null }[] = [];
  const raise = (filter: string, message: string): void => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].filter === filter) {
        scopes[i].error ??= { message };
        return;
      }
    }
    log.push(['uncapturedError', filter, message]);
  };
  const maybeFail = (id: string): void => {
    const filter = options.failCreate?.[id];
    if (filter) raise(filter, `「${id}」建坏了(测试注入)`);
  };
  const gpu = {
    pushErrorScope: (filter: string) => {
      scopes.push({ filter, error: null });
    },
    popErrorScope: () => {
      const s = scopes.pop();
      if (!s) return Promise.reject(new Error('错误作用域栈是空的'));
      return Promise.resolve(s.error);
    },
  };
  let resolveLost!: (info: { reason: 'destroyed'; message: string }) => void;
  const lost = new Promise<{ reason: 'destroyed'; message: string }>((r) => {
    resolveLost = r;
  });
  const lose = (message = '测试模拟的设备丢失'): void => resolveLost({ reason: 'destroyed', message });
  const makeSampler = (props: unknown) => ({ handle: { sampler: props }, props, destroy() {} });
  const canvasContext = {
    destroyed: false,
    getCurrentFramebuffer: (opts?: { depthStencilFormat?: unknown }) => ({
      width: 16,
      height: 16,
      colorAttachments: [{ handle: { view: 'canvas' } }],
      depthStencilAttachment: opts?.depthStencilFormat ? { handle: { view: 'canvas-depth' } } : null,
    }),
    getDrawingBufferSize: () => [16, 16],
    setDrawingBufferSize: (w: number, h: number) => log.push(['setDrawingBufferSize', w, h]),
    destroy() {
      canvasContext.destroyed = true;
      log.push(['canvasContext.destroy']);
    },
  };

  const nativeRenderPass = (label: string) => ({
    label,
    setPipeline: (p: unknown) => log.push(['setPipeline', p]),
    setBindGroup: (g: number, bg: unknown) => log.push(['setBindGroup', g, bg]),
    setVertexBuffer: (slot: number, b: unknown, offset?: number) => log.push(['setVertexBuffer', slot, b, offset ?? 0]),
    setIndexBuffer: (b: unknown, format: unknown) => log.push(['setIndexBuffer', b, format]),
    setViewport: (...a: number[]) => log.push(['setViewport', ...a]),
    setScissorRect: (...a: number[]) => log.push(['setScissorRect', ...a]),
    setStencilReference: (r: number) => log.push(['setStencilReference', r]),
    draw: (n: number, ...rest: unknown[]) => log.push(['draw', n, ...rest]),
    drawIndexed: (n: number, ...rest: unknown[]) => log.push(['drawIndexed', n, ...rest]),
    end: () => log.push(['pass.end', label]),
  });

  /** 照 luma 9.4 WebGPURenderPass:setPipeline 记 pipeline;draw 前要求本管线 setBindings 过 */
  class LumaRenderPass {
    pipeline: { handle: unknown; shaderLayout: { bindings: unknown[] } } | null = null;
    bindingsPipeline: unknown = null;
    vertexArray: { bindBeforeRender(pass: unknown): void } | null = null;
    constructor(readonly handle: ReturnType<typeof nativeRenderPass>) {}
    setPipeline(p: { handle: unknown; shaderLayout: { bindings: unknown[] } }) {
      this.pipeline = p;
      this.handle.setPipeline(p.handle);
    }
    setBindings(bindings: never, options?: { _bindGroupCacheKeys?: never }) {
      if (!this.pipeline) throw new Error('RenderPass.setPipeline() must be called before setBindings()');
      this.bindingsPipeline = this.pipeline;
      setBindGroups(this.handle, this.pipeline, bindings, options?._bindGroupCacheKeys);
    }
    setVertexArray(va: { bindBeforeRender(pass: unknown): void }) {
      this.vertexArray = va;
    }
    setParameters() {}
    draw(o: { vertexCount?: number; indexCount?: number }) {
      if (!this.pipeline) throw new Error('RenderPass.setPipeline() must be called before draw()');
      if (this.pipeline.shaderLayout.bindings.length > 0 && this.bindingsPipeline !== this.pipeline) {
        throw new Error('RenderPass.setBindings() must be called after setPipeline() before draw()');
      }
      this.vertexArray?.bindBeforeRender(this);
      if (o.indexCount !== undefined) this.handle.drawIndexed(o.indexCount);
      else this.handle.draw(o.vertexCount ?? 0);
      return true;
    }
    end() {
      this.handle.end();
    }
  }

  const setBindGroups = (native: { setBindGroup(g: number, bg: unknown): void }, pipeline: unknown, bindings: never, keys: never | undefined) => {
    const groups = _getDefaultBindGroupFactory(device as never).getBindGroups(pipeline as never, bindings, keys) as Record<string, unknown>;
    for (const [g, bg] of Object.entries(groups)) if (bg) native.setBindGroup(Number(g), bg);
  };

  const device = {
    type: 'webgpu',
    _factories: {},
    handle: gpu,
    limits: {
      maxTextureDimension2D: options.maxTextureSize ?? 8192,
      maxVertexAttributes: 16,
      maxColorAttachments: 8,
      maxComputeWorkgroupSizeX: 256,
      maxComputeWorkgroupSizeY: 256,
      maxComputeWorkgroupSizeZ: 64,
      maxComputeInvocationsPerWorkgroup: 256,
    },
    info: { vendor: 'fake', renderer: 'fake' },
    // luma Resource 基类建对象时要的统计 / 用户数据
    statsManager: luma.stats,
    userData: {},
    preferredColorFormat: 'bgra8unorm',
    lost,
    isTextureFormatFilterable: () => false,
    isTextureFormatRenderable: () => true,
    getDefaultCanvasContext: () => canvasContext,
    // luma 关调试时这两个是空操作
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(),
    _createBindGroupLayoutWebGPU: (pipeline: { id: string }, group: number) => {
      counts.bindGroupLayouts++;
      return { layoutOf: pipeline.id, group };
    },
    _createBindGroupWebGPU: (_layout: unknown, _shaderLayout: unknown, bindings: Record<string, unknown>, group: number) => {
      counts.bindGroups++;
      return { bindGroup: counts.bindGroups, group, names: Object.keys(bindings) };
    },
    createShader: (props: { id: string; source: string }) => {
      maybeFail(props.id);
      const bad = options.shaderCompileErrors?.includes(props.id) ?? false;
      const messages = bad ? [{ type: 'error', lineNum: 1, linePos: 1, message: '测试注入的编译错误' }] : [];
      return {
        id: props.id,
        source: props.source,
        asyncCompilationStatus: Promise.resolve(bad ? 'error' : 'success'),
        getCompilationInfo: async () => messages,
        destroy() {},
      };
    },
    createRenderPipeline: (props: { id: string; vs: { source: string }; vertexEntryPoint?: string }) => {
      const shaderLayout = scanWGSLInterface(props.vs.source, { vertexEntryPoint: props.vertexEntryPoint });
      if (!shaderLayout) throw new Error('luma.gl assertion failed.');
      maybeFail(props.id);
      return { id: props.id, handle: { nativePipeline: props.id }, shaderLayout, linkStatus: 'success', destroy() {} };
    },
    createComputePipeline: (props: { id: string; shader: { source: string } }) => {
      const scanned = scanWGSLInterface(props.shader.source, { scanVertexAttributes: false });
      if (!scanned) throw new Error('luma.gl assertion failed.');
      maybeFail(props.id);
      return { id: props.id, handle: { nativePipeline: props.id }, shaderLayout: { bindings: scanned.bindings }, destroy() {} };
    },
    createVertexArray: (props: unknown) => new WebGPUVertexArray(device, props),
    createBuffer: (props: { id: string; byteLength: number; indexType?: string }) => ({
      id: props.id,
      byteLength: props.byteLength,
      indexType: props.indexType,
      handle: { buffer: props.id },
      write() {},
      readAsync: async () => new Uint8Array(props.byteLength),
      destroy() {},
    }),
    createTexture: (props: { id: string; width: number; height: number; format: string; mipLevels?: number; samples?: number; sampler?: unknown }) => {
      const t = {
        id: props.id,
        width: props.width,
        height: props.height,
        format: props.format,
        mipLevels: props.mipLevels ?? 1,
        samples: props.samples ?? 1,
        sampler: makeSampler(props.sampler) as unknown,
        view: { handle: { view: props.id } },
        setSampler(s: unknown) {
          t.sampler = s;
        },
        copyExternalImage: (o: unknown) => log.push(['copyExternalImage', props.id, o]),
        writeData: () => log.push(['writeData', props.id]),
        destroy() {},
      };
      return t;
    },
    createSampler: (props: unknown) => makeSampler(props),
    createFramebuffer: (props: { width: number; height: number; colorAttachments: { id: string }[]; depthStencilAttachment: { id: string } | null }) => ({
      width: props.width,
      height: props.height,
      colorAttachments: props.colorAttachments.map((c) => ({ handle: { view: c.id } })),
      depthStencilAttachment: props.depthStencilAttachment ? { handle: { view: props.depthStencilAttachment.id } } : null,
      destroy() {},
    }),
    createCommandEncoder: (props: { id: string }) => ({
      handle: { beginRenderPass: (d: { label: string }) => nativeRenderPass(d.label) },
      beginRenderPass: (p: { handle: ReturnType<typeof nativeRenderPass> }) => new LumaRenderPass(p.handle),
      beginComputePass: (p: { id: string }) => {
        const handle = {
          setPipeline: (x: unknown) => log.push(['compute.setPipeline', x]),
          setBindGroup: (g: number, bg: unknown) => log.push(['compute.setBindGroup', g, bg]),
          dispatchWorkgroups: (x: number) => log.push(['dispatch', x]),
          end: () => log.push(['compute.end', p.id]),
        };
        return {
          handle,
          pipeline: null as unknown,
          setPipeline(pl: { handle: unknown }) {
            this.pipeline = pl;
            handle.setPipeline(pl.handle);
          },
          setBindings(bindings: never) {
            setBindGroups(handle, this.pipeline, bindings, undefined);
          },
          dispatch: (x: number) => handle.dispatchWorkgroups(x),
          end: () => handle.end(),
        };
      },
      copyBufferToBuffer: () => log.push(['copyBufferToBuffer']),
      copyTextureToTexture: () => log.push(['copyTextureToTexture']),
      pushDebugGroup() {},
      popDebugGroup() {},
      finish: () => {
        log.push(['encoder.finish', props.id]);
        return { commandBuffer: props.id };
      },
      destroy() {},
    }),
    submit: (cb: unknown) => log.push(['submit', cb]),
    destroy: () => {
      log.push(['luma.destroy']);
      lose('设备已销毁');
    },
  };
  return { device, log, counts, canvasContext, lose };
}
