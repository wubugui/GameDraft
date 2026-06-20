import { Application, BlurFilter, Container, RenderTexture, Sprite, Texture } from 'pixi.js';

export interface IrradianceProbeOptions {
  /** 探针纹理最大宽度（高按背景比例），默认 96。越小越平滑、越省。 */
  maxWidth?: number;
  /** 额外高斯模糊强度（探针像素空间），默认 5。 */
  blur?: number;
}

/**
 * 把背景图降采样 + 模糊渲染进一张小 RenderTexture，作为「逐 entity 色调融入」的辐照度探针。
 *
 * 探针 UV (0..1) 与世界 quad (0,0)-(worldWidth,worldHeight) 一一对应（背景 Sprite 恰好铺满世界 quad），
 * 因此滤镜在脚底世界坐标处按 (footX/worldW, footY/worldH) 采样即得当地环境色。
 *
 * 返回的 RenderTexture 由调用方负责 destroy（场景卸载时）。
 */
export function buildIrradianceProbe(
  app: Application,
  bgTexture: Texture,
  opts?: IrradianceProbeOptions,
): RenderTexture | null {
  const srcW = bgTexture.width;
  const srcH = bgTexture.height;
  if (!(srcW > 0) || !(srcH > 0)) return null;

  const maxW = Math.max(16, Math.min(256, opts?.maxWidth ?? 96));
  const w = Math.max(16, Math.min(maxW, srcW));
  const h = Math.max(8, Math.round((w * srcH) / srcW));

  const rt = RenderTexture.create({ width: w, height: h });

  const root = new Container();
  const spr = new Sprite(bgTexture);
  spr.width = w;
  spr.height = h;
  const blur = new BlurFilter({ strength: Math.max(0, opts?.blur ?? 5), quality: 3 });
  spr.filters = [blur];
  root.addChild(spr);

  try {
    app.renderer.render({ container: root, target: rt, clear: true });
  } catch {
    rt.destroy(true);
    root.destroy({ children: true });
    blur.destroy();
    return null;
  }

  root.destroy({ children: true });
  blur.destroy();
  return rt;
}
