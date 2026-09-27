/**
 * 燃烧工作台逐像素对照 · 游戏侧参考页：拿工作台这一帧交出来的输入（模板图地址、热点 def、燃烧场字节、着色参数、相机、
 * 画布尺寸 / 分辨率、背景），**照游戏组装层**画一遍，回读画布给对照脚本比：
 *
 * - 渲染器：`createRenderer`，与游戏 `Renderer.init` 同参（不抗锯齿、分辨率 = 设备像素比），清屏色同工作台；
 * - 贴图：`Assets.load(resolveAssetPath(url))`（= `AssetManager.loadTexture`）；
 * - 场景树：舞台 → 世界容器（位置 = 相机平移、缩放 = 投影缩放）→ 背景层 / 阴影层 / 实体层；热点 = `new Hotspot(def)` +
 *   `setDisplayTexture(模板图, 真实尺寸)`（= `SceneManager.instantiateHotspot`）+ `setPerspectiveScale`；
 * - 燃烧：`BurnRenderer.attach(滤镜宿主 = 热点)` → 燃烧场字节写进 `fieldData` → `markDirty(…, true)` →
 *   `setShade(…, burnSceneToUvAffine(burnHotspotFrame(热点, 尺寸)))`（= `BurnSystem`）→ `update(…, 世界容器)`（= `Game`）。
 *
 * 不经工作台 RHI 接入层（`tools/workbench_rhi`），也不经工作台胶水（`burnView.ts`）：这一侧是独立照游戏写的参考。
 * 按实例帧平贴的实例（NPC：游戏里走角色受光网格）不画——对照脚本保证它们在画面外。
 */
import { Assets, Container, Sprite, createRenderer, type Texture } from '@src/engine2d';
import { Hotspot } from '@src/entities/Hotspot';
import type { HotspotDef } from '@src/data/types';
import { BurnRenderer } from '@src/rendering/burn/BurnRenderer';
import type { BurnShadeParams } from '@src/rendering/burn/burnShadeParams';
import { burnHotspotFrame, burnSceneToUvAffine } from '@src/systems/burn/burnGeometry';
import { createPerspectiveScaleResolver } from '@src/utils/perspectiveScale';
import { resolveAssetPath } from '@src/core/assetPath';

interface RefItem {
  kind: 'hotspot' | 'frame';
  url: string;
  def?: Record<string, unknown> & { displayImage: { worldWidth: number; worldHeight: number } };
  burn: null | { gridW: number; gridH: number; field: string; params: BurnShadeParams };
}

interface RefInput {
  css: [number, number];
  dpr: number;
  cam: { k: number; ox: number; oy: number };
  background: number;
  bg: { url: string; w: number; h: number } | null;
  perspective: Record<string, unknown> | null;
  items: RefItem[];
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(u8: Uint8ClampedArray | Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function renderRef(input: RefInput): Promise<{ w: number; h: number; pixels: string }> {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${input.css[0]}px`;
  canvas.style.height = `${input.css[1]}px`;
  document.body.appendChild(canvas);
  const renderer = await createRenderer({
    canvas, width: input.css[0], height: input.css[1], resolution: input.dpr, antialias: false, background: input.background,
  });
  try {
    const textures: Texture[] = await Promise.all(input.items.map((it) => Assets.load<Texture>(resolveAssetPath(it.url))));
    const bgTex = input.bg ? await Assets.load<Texture>({ src: input.bg.url, parser: 'loadTextures' }) : null;

    const stage = new Container();
    const worldContainer = new Container();
    const backgroundLayer = new Container();
    const shadowLayer = new Container();
    const entityLayer = new Container();
    worldContainer.addChild(backgroundLayer, shadowLayer, entityLayer);
    stage.addChild(worldContainer);
    worldContainer.position.set(input.cam.ox, input.cam.oy);
    worldContainer.scale.set(input.cam.k, input.cam.k);
    if (bgTex && input.bg) {
      const bg = new Sprite(bgTex);
      bg.width = input.bg.w;
      bg.height = input.bg.h;
      backgroundLayer.addChild(bg);
    }
    const persp = input.perspective ? createPerspectiveScaleResolver(input.perspective as never) : null;
    const burn = new BurnRenderer();
    input.items.forEach((it, i) => {
      if (it.kind !== 'hotspot' || !it.def) return;
      const def = { type: 'inspect', interactionRange: 0, data: {}, ...structuredClone(it.def) } as unknown as HotspotDef;
      const h = new Hotspot(def);
      entityLayer.addChild(h.container);
      const size = { width: it.def.displayImage.worldWidth, height: it.def.displayImage.worldHeight };
      h.setDisplayTexture(textures[i], size.width, size.height);
      h.setPerspectiveScale(persp);
      if (!it.burn) return;
      const key = `s:${i}`;
      burn.attach(key, { kind: 'filters', host: h }, it.burn.gridW, it.burn.gridH);
      burn.fieldData(key)!.set(fromB64(it.burn.field));
      burn.markDirty(key, 0, true);
      burn.setShade(key, it.burn.params, burnSceneToUvAffine(burnHotspotFrame(h, size)));
    });
    burn.update(0, { x: worldContainer.x, y: worldContainer.y, scale: input.cam.k });
    // 画 + 回读在同一个任务里（WebGPU 画布呈现之后读不回来）
    renderer.render(stage);
    const rc = document.createElement('canvas');
    rc.width = canvas.width;
    rc.height = canvas.height;
    const ctx = rc.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(canvas, 0, 0);
    const data = ctx.getImageData(0, 0, rc.width, rc.height).data;
    burn.clear();
    stage.destroy({ children: true });
    return { w: rc.width, h: rc.height, pixels: toB64(data) };
  } finally {
    renderer.destroy();
    canvas.remove();
  }
}

(window as unknown as { __renderRef: typeof renderRef; __refReady: boolean }).__renderRef = renderRef;
(window as unknown as { __refReady: boolean }).__refReady = true;
