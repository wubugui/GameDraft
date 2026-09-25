/**
 * WGSL 着色器独立采样器资源(`<纹理名>Sampler`)的取值口。**一律用 `samplerOf(source)`,不要直接放 `source.style`。**
 *
 * 按采样参数共享一份、永不销毁:采样器本身无状态,共享不影响任何结果;也不挂在任何纹理的生命期上
 * (Pixi 时代直接放 `source.style` 会在纹理销毁时连带弄死整个绑定组、整帧抛错;engine2d 按名字绑定、
 * 采样器按参数缓存,已没有那条路径,但保留同一纪律:采样状态跟着纹理参数走,不跟着纹理对象走)。
 *
 * 纹理之后若改了自己的 style 参数,调用方要重新 `samplerOf(source)` 取一次(参数不同就是另一份)。
 */
import { TextureStyle } from '../../engine2d';

const shared = new Map<string, TextureStyle>();

function keyOf(s: TextureStyle): string {
  return [
    s.addressModeU, s.addressModeV, s.addressModeW,
    s.magFilter, s.minFilter, s.mipmapFilter,
    s.lodMinClamp, s.lodMaxClamp, s.compare ?? '', s.maxAnisotropy,
  ].join('|');
}

/** 与 `source.style` 采样参数相同、永不销毁的共享采样器 */
export function samplerOf(source: { style: TextureStyle }): TextureStyle {
  const s = source.style;
  const key = keyOf(s);
  let out = shared.get(key);
  if (!out) {
    out = new TextureStyle({
      addressModeU: s.addressModeU,
      addressModeV: s.addressModeV,
      addressModeW: s.addressModeW,
      magFilter: s.magFilter,
      minFilter: s.minFilter,
      mipmapFilter: s.mipmapFilter,
      lodMinClamp: s.lodMinClamp,
      lodMaxClamp: s.lodMaxClamp,
      compare: s.compare,
      maxAnisotropy: s.maxAnisotropy,
    });
    // 共享件不许被任何一方销毁(Shader / Filter 的整组销毁、资源清理都可能顺手调到它)
    out.destroy = () => {};
    shared.set(key, out);
  }
  return out;
}
