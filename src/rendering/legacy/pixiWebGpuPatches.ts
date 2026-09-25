/**
 * Pixi v8(8.17)WebGPU 渲染器的补丁。迁移期 Pixi 跑在 RHI 的 WebGPU 设备上,原版有一处硬伤必须补:
 *
 * **管线的颜色目标格式写死成 `bgra8unorm`**(`GpuStateSystem.getColorTargets`),而且格式不进管线缓存键
 * (`PipelineSystem._updatePipeHash`)。于是往 `rgba8unorm` / `rgba16float` 的离屏目标上画,管线与 pass 的
 * 附件格式对不上,WebGPU 校验失败、整个命令缓冲作废(画面上就是那一 pass 什么都没有)。游戏的光照烘焙、
 * GI、阴影前缀、草木摆动都画进 `rgba16float`,不补就全黑。
 *
 * 补法:开 pass 时记下当前目标各颜色附件的真实格式;管线缓存键并上这组格式;建管线时按它填 `targets[i].format`。
 * 顺带:Pixi 总给颜色目标配混合,而 32 位浮点 / 整数格式在 WebGPU 核心里**不可混合**,带混合建管线必失败——
 * 这类格式建管线时去掉混合(等价于覆盖写入;这些目标本来就是数据图,不该混合)。
 * 只改这三处,WebGL 渲染器不受影响。安装幂等,必须在建 WebGPU 渲染器之前调用。
 */
import { GpuRenderTargetAdaptor, PipelineSystem } from 'pixi.js';

const INSTALLED = Symbol.for('gamedraft.pixiWebGpuPatches');

/** WebGPU 核心里不可混合的颜色格式(32 位浮点需要可选特性 float32-blendable,整数格式一律不可混合) */
const NON_BLENDABLE = /^(r|rg|rgba)32float$|int$/;

interface PatchedPipelineSystem {
  _rtFormats?: string[];
  _stencilMode: number;
  _multisampleCount: number;
  _colorMask: number;
  _depthStencilAttachment: number;
  _colorTargetCount: number;
  _pipeStateCaches: Record<string, Record<number, GPURenderPipeline>>;
  _pipeCache: Record<number, GPURenderPipeline>;
  _renderer: { state: { getColorTargets(state: unknown, count: number): GPUColorTargetState[] } };
}

interface RenderTargetLike {
  colorTextures: Array<{ source: { format: string } }>;
}

export function installPixiWebGpuPatches(): void {
  const proto = PipelineSystem.prototype as unknown as Record<string | symbol, unknown>;
  if (proto[INSTALLED]) return;
  proto[INSTALLED] = true;

  // 1) 开 pass 时记下目标格式(原版随后会调 pipeline.setRenderTarget → _updatePipeHash)
  const adaptorProto = GpuRenderTargetAdaptor.prototype as unknown as {
    startRenderPass(renderTarget: RenderTargetLike, ...rest: unknown[]): void;
    _renderer: { pipeline: PatchedPipelineSystem };
  };
  const origStart = adaptorProto.startRenderPass;
  adaptorProto.startRenderPass = function (this: typeof adaptorProto, renderTarget: RenderTargetLike, ...rest: unknown[]) {
    this._renderer.pipeline._rtFormats = renderTarget.colorTextures.map((t) => t.source.format);
    return origStart.call(this, renderTarget, ...rest);
  };

  // 2) 管线缓存键并上目标格式(数值部分与原版 getGlobalStateKey 相同)
  const pipeProto = PipelineSystem.prototype as unknown as {
    _updatePipeHash(this: PatchedPipelineSystem): void;
    _createPipeline(this: PatchedPipelineSystem, ...args: unknown[]): GPURenderPipeline;
  };
  pipeProto._updatePipeHash = function (this: PatchedPipelineSystem) {
    const base =
      (this._colorMask << 8) |
      (this._stencilMode << 5) |
      (this._depthStencilAttachment << 3) |
      (this._colorTargetCount << 1) |
      this._multisampleCount;
    const key = `${base}|${(this._rtFormats ?? []).join(',')}`;
    this._pipeStateCaches[key] ??= Object.create(null) as Record<number, GPURenderPipeline>;
    this._pipeCache = this._pipeStateCaches[key];
  };

  // 3) 建管线时按目标真实格式填 targets[i].format(原版返回的是同一个对象引用,这里逐个复制)
  const origCreate = pipeProto._createPipeline;
  pipeProto._createPipeline = function (this: PatchedPipelineSystem, ...args: unknown[]) {
    const formats = this._rtFormats ?? [];
    const stateSystem = this._renderer.state;
    const origGet = stateSystem.getColorTargets;
    stateSystem.getColorTargets = (state: unknown, count: number) =>
      origGet.call(stateSystem, state, count).map((t, i) => {
        const format = (formats[i] ?? t.format) as GPUTextureFormat;
        if (!NON_BLENDABLE.test(format)) return { ...t, format };
        const { blend: _blend, ...rest } = t;
        return { ...rest, format };
      });
    try {
      return origCreate.apply(this, args);
    } finally {
      stateSystem.getColorTargets = origGet;
    }
  };
}
