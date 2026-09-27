/**
 * 呼吸工作台逐像素对照 · 游戏侧参考页：拿工作台这一帧交出来的输入（呼吸图 id、表演帧与那几个参数、"屏"的 CSS 尺寸 / 分辨率、
 * 是不是"按住看原图"），**照游戏组装层**画一遍，回读画布给对照脚本比：
 *
 * - 渲染器：`createRenderer`，与游戏 `Renderer.init` 同参（不抗锯齿、分辨率 = 设备像素比），清屏色同工作台；
 * - 资产：`resolveBreathingOverlay`（= `BreathingOverlaySystem.loadDef`）；层贴图 `Assets.load(resolveAssetPath(url))`
 *   （= `AssetManager.loadTexture`）；位移场 `fetchPayloadBytes(resolveAssetPath(file))` → `createBreathingFieldTextures`
 *   （= `BreathingOverlaySystem.show` 的 prepare）；
 * - 摆放：`CutsceneRenderer.showBreathingLayer(…, 50, 50, 100)` → `percentLayerRect` → `createBreathingOverlayMesh(…, cx, cy, dispW, dispH)`
 *   （层贴图按游戏装载口径预乘，`layersPremultiplied` 取缺省 true）；
 * - 每帧 uniform：`breathingUniforms({frame, vent, cran, inflate, sink}, rig)` → `apply`（= `BreathingOverlaySystem.uniformsOf` / `update`）；
 *   "按住看原图"那一帧 = 每帧 uniform 全 0（工作台的对比键；游戏里没有这个键，这里照同样的 0 喂给同一个 mesh）。
 *
 * 不经工作台 RHI 接入层（`tools/workbench_rhi`），也不经工作台胶水（`gpu/breathingView.ts`）：这一侧是独立照游戏写的参考。
 * "出片"那几例：游戏的"屏"= 成品尺寸、分辨率 1；两种读法都给——
 *   `canvas`：画到画布、同任务回读（游戏上屏那一张）；
 *   `extract`：引擎自己的离屏读法 `renderer.extract.pixels(舞台)`（generateTexture → 渲染纹理 → readPixels），不经接入层。
 * 引擎的画布 pass 为了与 master（WebGL 自下而上）逐位一致，是**上下颠倒光栅化进中间纹理再翻上屏**的（FrameBuilder `flipY`），
 * 离屏渲染纹理不翻：两者在个别像素上差 1（插值的末位舍入不同）。工作台出片读的是离屏纹理，逐字节对的是 `extract`。
 */
import { Assets, Container, createRenderer, type Texture } from '@src/engine2d';
import { resolveAssetPath } from '@src/core/assetPath';
import { fetchPayloadBytes } from '@src/core/lightingPayloadFiles';
import { isBreathingOverlayError, resolveBreathingOverlay } from '@src/data/breathingOverlays';
import { createBreathingFieldTextures, createBreathingOverlayMesh } from '@src/rendering/breathingOverlayMesh';
import { breathingUniforms, type BreathingUniformInput } from '@src/rendering/breathingUniforms';
import { percentLayerRect } from '@src/rendering/overlayPercentLayout';

interface RefInput {
  asset: string;
  /** canvas = 画到画布再读；extract = 引擎的离屏读法（缺省 canvas） */
  mode?: 'canvas' | 'extract';
  css: [number, number];
  dpr: number;
  background: number;
  /** null = 按住看原图（每帧 uniform 全 0） */
  input: BreathingUniformInput | null;
}

function toB64(u8: Uint8ClampedArray | Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

async function renderRef(inp: RefInput): Promise<{ w: number; h: number; pixels: string; uniforms: Record<string, number> }> {
  const r = await fetch(`/api/breathing/doc?id=${encodeURIComponent(inp.asset)}`);
  const doc = (await r.json()).doc;
  const def = resolveBreathingOverlay(doc, inp.asset);
  if (isBreathingOverlayError(def)) throw new Error(def.error);
  const canvas = document.createElement('canvas');
  canvas.style.width = `${inp.css[0]}px`;
  canvas.style.height = `${inp.css[1]}px`;
  document.body.appendChild(canvas);
  const renderer = await createRenderer({
    canvas, width: inp.css[0], height: inp.css[1], resolution: inp.dpr, antialias: false, background: inp.background,
  });
  try {
    const L = def.layers;
    const load = (p: string | undefined): Promise<Texture | null> => (p ? Assets.load<Texture>(resolveAssetPath(p)) : Promise.resolve(null));
    const [base, body, sheet, flap, bytes] = await Promise.all([
      load(L.base), load(L.body), load(L.sheet), load(L.flap), fetchPayloadBytes(resolveAssetPath(def.fields.file)),
    ]);
    const fields = createBreathingFieldTextures(bytes, def.fields.width, def.fields.height);
    const rect = percentLayerRect(inp.css[0], inp.css[1], def.size[0], def.size[1], 50, 50, 100);
    const m = createBreathingOverlayMesh({ base: base!, body, sheet, flap, ...fields }, def.rig, def.size, rect.cx, rect.cy, rect.dispW, rect.dispH);
    const uniforms = inp.input ? breathingUniforms(inp.input, def.rig) : { uInfl: 0, uFlapAng: 0, uShade: 0, uVentPx: 0, uCranPx: 0 };
    m.apply(uniforms);
    const stage = new Container();
    stage.addChild(m.mesh);
    let data: Uint8ClampedArray;
    let w: number;
    let h: number;
    if (inp.mode === 'extract') {
      const px = await renderer.extract.pixels(stage);
      data = px.pixels;
      w = px.width;
      h = px.height;
    } else {
      // 画 + 回读在同一个任务里（WebGPU 画布呈现之后读不回来）
      renderer.render(stage);
      const rc = document.createElement('canvas');
      rc.width = canvas.width;
      rc.height = canvas.height;
      const ctx = rc.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(canvas, 0, 0);
      data = ctx.getImageData(0, 0, rc.width, rc.height).data;
      w = rc.width;
      h = rc.height;
    }
    stage.removeChild(m.mesh);
    m.mesh.destroy({ children: true, texture: false, textureSource: false });
    m.disposeGpu();
    fields.field1.destroy(true);
    fields.field2.destroy(true);
    stage.destroy();
    return { w, h, pixels: toB64(data), uniforms };
  } finally {
    renderer.destroy();
    canvas.remove();
  }
}

(window as unknown as { __renderRef: typeof renderRef; __refReady: boolean }).__renderRef = renderRef;
(window as unknown as { __refReady: boolean }).__refReady = true;
