/**
 * 设备纹理尺寸上限(R2-1):master 的 Pixi WebGL 拿的是 GPU 的 MAX_TEXTURE_SIZE(桌面常见 16384);
 * WebGPU 不显式要就只给规范缺省 maxTextureDimension2D = 8192,放大观察物件时 contact-AO 滤镜的池纹理(16384 宽)
 * 建不出来、整帧失败。这里在假的 navigator.gpu 上走一遍 createLumaRhiDevice,看它向适配器要设备时带上了适配器支持的上限。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RhiError } from '../../types';
import { createLumaRhiDevice } from './LumaRhiDevice';

function fakeAdapter(maxTextureDimension2D: number) {
  const requested: GPUDeviceDescriptor[] = [];
  const adapter = {
    features: new Set<string>(['float32-filterable', 'texture-compression-bc']),
    limits: { maxTextureDimension1D: maxTextureDimension2D, maxTextureDimension2D, maxTextureDimension3D: 2048, maxBindGroups: 4 },
    info: { vendor: 'fake', architecture: '', device: '', description: '' },
    async requestDevice(desc?: GPUDeviceDescriptor): Promise<GPUDevice> {
      requested.push(desc ?? {});
      // 只看描述符;真建设备要一整套 GPUDevice,测试里到此为止
      throw new Error('fake adapter: 不建设备');
    },
  };
  return { adapter, requested };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LumaRhiDevice 向适配器要纹理尺寸上限(R2-1,对照 master WebGL 的 MAX_TEXTURE_SIZE)', () => {
  it('requestDevice 带 requiredLimits.maxTextureDimension2D = 适配器上限;不额外要特性(同 core 档)', async () => {
    const { adapter, requested } = fakeAdapter(16384);
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => adapter } });
    await expect(createLumaRhiDevice({ canvas: {} as HTMLCanvasElement })).rejects.toBeInstanceOf(RhiError);
    expect(requested).toHaveLength(1);
    expect(requested[0].requiredLimits).toEqual({ maxTextureDimension2D: 16384 });
    expect(requested[0].requiredFeatures ?? []).toEqual([]);
  });

  it('适配器上限就是 8192 时照要 8192(不超出适配器能力)', async () => {
    const { adapter, requested } = fakeAdapter(8192);
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => adapter } });
    await expect(createLumaRhiDevice({ canvas: {} as HTMLCanvasElement })).rejects.toBeInstanceOf(RhiError);
    expect(requested[0].requiredLimits).toEqual({ maxTextureDimension2D: 8192 });
  });
});
