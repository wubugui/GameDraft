/**
 * 角色照明实验室逐像素对照 · 游戏侧参考页：拿实验室这一帧交出来的输入（虚拟烘焙目录、场景尺寸、脚点 / 角色高、着色参数、
 * 相机、画布尺寸 / 分辨率、背景），**照游戏组装层**画一遍，回读画布给对照脚本比：
 *
 * - 渲染器：`createRenderer`，与游戏 `Renderer.init` 同参（不抗锯齿、分辨率 = 设备像素比），清屏色同实验室；
 * - 载荷：`SceneDepthSystem.load`（depthLoader）→ `CharacterLightingSystem.load(…, 烘焙目录)` → `onReady` 把行走面注入深度系统
 *   → lightingLoader（`applyDisplay` / `applyLightFactors` / `applyLights(零盏灯)`）→ rebuildEntityShadows（`setShadowBasis`）
 *   → `applyCharMode`（`ensureVolumes` / `ensureProbeAtlas`）；
 * - 角色：玩家容器（位置 = 脚点）⊃ 变换载体精灵（不画）+ `LitSpriteQuad(createEntityLitShader(...))`（= `SpriteEntity.refreshLitQuad /
 *   syncLitQuad / syncLitQuadWorld`），遮挡开时容器挂 `createFilterForEntity()`（= `Game.attachPlayerSceneFilter`）；
 * - 每帧：`params` + `syncFrame`（= `Game.charLitFrameSync`），`updatePerFrame` + `updateEntityDepthOcclusion`（= `Game` 主循环）；
 * - 贴图：背景 = `Assets.load`（= `AssetManager.loadTexture`）或实验室算好的背景视图字节；角色颜色 = `AssetManager.loadTexture`，
 *   法线 = `*.normal.png` 那条不预乘通道。
 *
 * 不经工作台 RHI 接入层（`tools/workbench_rhi`），也不经实验室胶水（`gpu/charLabView.ts`）：这一侧是独立照游戏写的参考。
 */
import { Assets, BufferImageSource, Container, Sprite, Texture, createRenderer } from '@src/engine2d';
import type { AssetManager } from '@src/core/AssetManager';
import { resolveAssetPath } from '@src/core/assetPath';
import { CharacterLightingSystem } from '@src/core/CharacterLightingSystem';
import { SceneDepthSystem } from '@src/core/SceneDepthSystem';
import { legacyLightFactors } from '@src/data/lightFactors';
import type { SceneDepthConfig, SceneLightingDef } from '@src/data/types';
import { LitSpriteQuad } from '@src/rendering/CharacterLitSprite';
import { packLights } from '@src/rendering/lighting/lightPacking';

interface Shading {
  mode: number; spp: number; step: number; msteps: number; fold: boolean; missMode: boolean; nee: boolean;
  beta: number; amb: number; bulge: number; flatten: number; eChroma: number; showNormals: boolean; previewGain: number; skyao: boolean;
}

interface RefInput {
  css: [number, number];
  dpr: number;
  background: number;
  scene: { sceneId: string; bgImage: string; baseUrl: string; work: { w: number; h: number }; native: { w: number; h: number }; wuPerQUnit: number };
  frame: { camera: { scale: number; x: number; y: number }; foot: { x: number; y: number }; heightPx: number; occlusion: boolean; shading: Shading };
  bg: { url: string } | { w: number; h: number; pixels: string; nearest: boolean };
  charColor: string;
  charNormal: string;
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

/**
 * = `AssetManager` 里 SceneDepthSystem.load 与角色图用到的三条(不直接 new AssetManager:它牵着 howler,vite 预构建在这一页里导出
 * 对不上,粒子台参考页同一个处置)。逐条照 AssetManager:loadTexture(`*.normal.png` 走不预乘通道,其余 Assets.load)、
 * loadBitmap(fetch + createImageBitmap)、loadOptionalJson(HEAD 看是不是 JSON 再取)。
 */
const assets = {
  async loadTexture(path: string): Promise<Texture> {
    const url = resolveAssetPath(path);
    return url.endsWith('.normal.png')
      ? Assets.load<Texture>({ src: url, data: { alphaMode: 'premultiplied-alpha' } })
      : Assets.load<Texture>(url);
  },
  async loadBitmap(path: string): Promise<ImageBitmap> {
    const r = await fetch(resolveAssetPath(path));
    if (!r.ok) throw new Error(`fetch ${r.status} for ${path}`);
    return createImageBitmap(await r.blob());
  },
  async loadOptionalJson<T = unknown>(path: string): Promise<T | null> {
    const url = resolveAssetPath(path);
    try {
      const probe = await fetch(url, { method: 'HEAD' });
      if (!probe.ok || !(probe.headers.get('content-type') ?? '').toLowerCase().includes('json')) return null;
      return (await (await fetch(url)).json()) as T;
    } catch {
      return null;
    }
  },
} as unknown as AssetManager;

async function renderRef(input: RefInput): Promise<{ w: number; h: number; pixels: string }> {
  const { scene: sc, frame: f } = input;
  const p = f.shading;
  const canvas = document.createElement('canvas');
  canvas.style.width = `${input.css[0]}px`;
  canvas.style.height = `${input.css[1]}px`;
  document.body.appendChild(canvas);
  const renderer = await createRenderer({
    canvas, width: input.css[0], height: input.css[1], resolution: input.dpr, antialias: false, background: input.background,
  });
  const depth = new SceneDepthSystem();
  const cl = new CharacterLightingSystem();
  try {
    // depthLoader(深度图与 depthConfig 是「导出深度」会写的那一份的虚拟版)
    const cfg = await (await fetch(`${sc.baseUrl}/depth.json`, { cache: 'no-store' })).json() as SceneDepthConfig;
    await depth.load(sc.sceneId, cfg, assets, sc.work.w, sc.work.h, sc.native.w / sc.work.w, sc.native.h / sc.work.h);
    cl.onReady = () => depth.setGroundDepthField(cl.groundDepthField, cl.groundDepthTexture);
    await cl.load(sc.sceneId, sc.work.w, sc.work.h, sc.bgImage, undefined, sc.baseUrl);
    if (!cl.active) throw new Error('参考页:载荷没装上');
    // lightingLoader:场景有 lighting 块、零盏灯;显示变换 = 实验室「预览亮度」的显示 EV
    cl.applyDisplay({ ev: Math.log2(p.previewGain), tonemap: 'none', saturation: 1, contrast: 1, lift: 0 } as SceneLightingDef['display']);
    cl.applyLightFactors(undefined);
    cl.applyLights(packLights({ lights: [] } as unknown as SceneLightingDef, sc.wuPerQUnit), sc.wuPerQUnit);
    const s = depth.getShadowSceneContext();
    cl.setShadowBasis(s ? [s.r00, s.r01, s.r02, s.r10, s.r11, s.r12, s.r20, s.r21, s.r22] : null);
    // applyCharMode
    if (p.mode < 1) {
      if (!await cl.ensureVolumes()) throw new Error('参考页:体素卷没拉到');
    } else {
      cl.releaseVolumes();
      if (!await cl.ensureProbeAtlas(p.mode)) throw new Error('参考页:probe 图集没拉到');
    }
    cl.params.mode = p.mode;
    cl.disposeStaleVolumeTextures();
    cl.disposeStaleProbeTextures();

    const color = await assets.loadTexture(input.charColor);
    const normal = await Assets.load<Texture>({ src: input.charNormal, data: { alphaMode: 'premultiplied-alpha' } });
    let bgTex: Texture;
    if ('url' in input.bg) bgTex = await Assets.load<Texture>(input.bg.url);
    else {
      bgTex = new Texture({ source: new BufferImageSource({
        resource: fromB64(input.bg.pixels), width: input.bg.w, height: input.bg.h, format: 'rgba8unorm',
        alphaMode: 'premultiplied-alpha', scaleMode: input.bg.nearest ? 'nearest' : 'linear',
      }) });
    }

    const stage = new Container();
    const world = new Container();
    stage.addChild(world);
    world.position.set(f.camera.x, f.camera.y);
    world.scale.set(f.camera.scale, f.camera.scale);
    const bg = new Sprite(bgTex);
    bg.width = sc.work.w;
    bg.height = sc.work.h;
    world.addChild(bg);
    const player = new Container();
    const sprite = new Sprite(color);
    sprite.anchor.set(0.5, 1);
    const k = f.heightPx / color.height;
    sprite.scale.set(k, k);
    sprite.renderable = false;
    player.addChild(sprite);
    const shader = cl.createEntityLitShader(color.source, normal.source);
    if (!shader) throw new Error('参考页:lit shader 建不出来');
    const quad = new LitSpriteQuad(shader);
    player.addChild(quad.mesh);
    quad.sync(color, color.width, color.height, sprite.anchor.x, sprite.anchor.y);
    quad.mesh.position.set(sprite.x, sprite.y);
    quad.mesh.scale.set(sprite.scale.x, sprite.scale.y);
    quad.mesh.rotation = sprite.rotation;
    player.position.set(f.foot.x, f.foot.y);
    quad.setWorldTransform(player.x, player.y, 1, 1, sprite.x, sprite.y, sprite.scale.x, sprite.scale.y, sprite.rotation);
    world.addChild(player);
    const filter = f.occlusion ? depth.createFilterForEntity() : null;
    player.filters = filter ? [filter] : [];

    Object.assign(cl.params, {
      spp: p.spp, step: p.step, msteps: p.msteps, fold: p.fold, missMode: p.missMode, nee: p.nee,
      beta: p.beta, ambStrength: p.amb, giStrength: 1, bulge: p.bulge, flatten: p.flatten, showNormals: p.showNormals,
      ...legacyLightFactors(p.beta, 1),
    });
    cl.eChroma = p.eChroma;
    cl.setSkyaoBlend(p.skyao ? 1 : 0);
    cl.syncFrame(world.x, world.y, f.camera.scale);
    if (filter) {
      depth.updatePerFrame(world.x, world.y, f.camera.scale);
      depth.updateEntityDepthOcclusion(filter, f.foot.x, f.foot.y, 0);
    }
    // 画完即发起 RHI 纹理回读(拷贝在调用当下提交;与实验室页的 CanvasHost.readPixels 同一条:渲染器的 readCanvasPixels)。
    // 画布按不透明合成:页面上看到的 alpha 恒 1(同 CanvasHost)
    renderer.render(stage);
    const got = await renderer.readCanvasPixels();
    if (!got) throw new Error('参考页:画布回读失败');
    const data = got.pixels;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const rc = { width: got.width, height: got.height };
    player.filters = [];
    quad.destroy();
    cl.releaseEntityLitShader(shader);
    stage.destroy({ children: true });
    if (!('url' in input.bg)) bgTex.destroy(true);
    return { w: rc.width, h: rc.height, pixels: toB64(data) };
  } finally {
    depth.destroy();
    cl.destroy();
    renderer.destroy();
    canvas.remove();
  }
}

(window as unknown as { __renderRef: typeof renderRef }).__renderRef = renderRef;
(window as unknown as { __refReady: boolean }).__refReady = true;
