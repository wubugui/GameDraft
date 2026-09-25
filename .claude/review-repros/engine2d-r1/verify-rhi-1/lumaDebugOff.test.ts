import { describe, it, expect, vi } from 'vitest';
import { WebGPUDevice } from '@luma.gl/webgpu';
// @ts-ignore deep import of the class luma uses for createRenderPipeline
import { WebGPURenderPipeline } from '../../../../node_modules/@luma.gl/webgpu/dist/adapter/resources/webgpu-render-pipeline.js';

describe('luma WebGPURenderPipeline with debug:false (as LumaRhiDevice creates it)', () => {
  it('never pushes a native error scope -> linkStatus success even when native creation is invalid', async () => {
    const nativePush = vi.fn();
    const nativePop = vi.fn(async () => ({ message: 'GPUValidationError: invalid pipeline' }));
    const nativeCreate = vi.fn(() => ({ label: '', __invalid: true }));
    const dev: any = Object.create((WebGPUDevice as any).prototype);
    dev.props = { debug: false, debugShaders: 'never' };
    dev.handle = { pushErrorScope: nativePush, popErrorScope: nativePop, createRenderPipeline: nativeCreate };
    dev.reportError = vi.fn(() => () => {});
    dev.debug = vi.fn();
    dev.userData = {};
    dev.type = 'webgpu';
    dev.statsManager = { getStats: () => ({ get: () => ({ incrementCount() {}, decrementCount() {}, addCount() {}, subtractCount() {} }) }) };
    // skip descriptor building details
    const origDesc = (WebGPURenderPipeline as any).prototype._getRenderPipelineDescriptor;
    (WebGPURenderPipeline as any).prototype._getRenderPipelineDescriptor = () => ({ fake: true });
    (WebGPURenderPipeline as any).prototype.addStats = () => {};
    let p: any;
    try {
      p = new (WebGPURenderPipeline as any)(dev, {
        id: 'bad', vs: { handle: {} }, fs: { handle: {} },
        shaderLayout: { attributes: [], bindings: [] }, bufferLayout: [],
      });
    } finally {
      (WebGPURenderPipeline as any).prototype._getRenderPipelineDescriptor = origDesc;
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(nativeCreate).toHaveBeenCalledTimes(1);
    expect(nativePush).not.toHaveBeenCalled();
    expect(nativePop).not.toHaveBeenCalled();
    expect(p.linkStatus).toBe('success');
    console.log('[luma debug:false] native pushErrorScope calls =', nativePush.mock.calls.length, 'linkStatus =', p.linkStatus);
  });
});
