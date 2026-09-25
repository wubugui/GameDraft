/**
 * WGSL 着色器独立采样器资源(`<纹理名>Sampler`)的取值口。**一律用 `samplerOf(source)`,不要直接放 `source.style`。**
 *
 * 为什么:Pixi 里 `TextureSource.destroy()` 会连带销毁它的 `style`,style 销毁时发 `change`,含它的 BindGroup
 * 随即自毁(pixi-v8-traps「BindGroup 见死即自毁」)。采样器槽和纹理槽在同一个组里——宿主换了纹理却漏换采样器,
 * 旧纹理一销毁,这一组就死了,**WebGL 下整帧照样抛**(WebGL 虽然不用这个采样器资源,组还是那个组)。
 * 「换纹理时记得换采样器」靠每个宿主手工维护必然会漏,所以采样器资源干脆不挂在任何纹理的生命期上:
 * 按采样参数共享一份、永不销毁。采样器本身无状态,共享不影响任何结果。
 *
 * 纹理之后若改了自己的 style 参数,调用方要重新 `samplerOf(source)` 取一次(参数不同就是另一份)。
 */
import { TextureStyle } from 'pixi.js';

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
