import type { Texture } from 'pixi.js';

import type { AssetManager } from '../../core/AssetManager';
import { depthError, depthLog } from '../../core/depthLog';
import { geometryMetaProblems } from '../../core/lightingPayloadFiles';
import { sceneBakeDirUrl, sceneRuntimeAssetUrl } from '../../core/projectPaths';
import type { LightingGeometryMeta } from '../../core/SceneLightingSystem';
import { defaultSceneLighting } from '../../data/sceneLightingDefault';
import type { SceneData, SceneLightingDef } from '../../data/types';
import {
  SceneLightingPass, type SceneLightingGeometry,
} from '../../rendering/lighting/SceneLightingPass';
import { resolveSceneAppearance } from '../../utils/sceneAppearance';
import type { WindowWorldTarget } from './windowWorldPhase';

const T = 'WindowWorld';

/**
 * 窗户世界的**自有载荷**——对面那一段的原画、几何场与辐射场。
 *
 * ## 这一份为什么自己装，而不是问主场景要
 *
 * 窗户世界是一份 fork（玩法清单 F.5）：它自己读场景 JSON、自己解析目标时段的外观、
 * 自己装自己的烘焙产物。主场景不知道它存在，它也不持有主场景的任何活引用——
 * 于是"窗里演什么"永远不可能把主场景带歪，这一条是**结构上**成立的，不靠纪律。
 *
 * 唯一从主场景那边拿的是**深度纹理**，而那不是耦合是事实：同一场景各时段共享几何
 * 是硬契约（`SceneTimeVariant.depthConfig` 的注释），深度图逐场景只有一张。
 * 窗自己再装一次会拿到同一个 URL、同一份 GPU 纹理（AssetManager 有缓存）。
 *
 * ## 与 `SceneLightingSystem.load` 的关系
 *
 * 装配步骤刻意与它逐条对齐（几何 meta → 防腐哈希门 → 法线/albedo → 深度 → 组 geo），
 * 因为两边喂的是**同一个** `SceneLightingPass`。哪天那边的装配口径变了，这边不跟就是
 * 窗里窗外两套光——所以这里每一步都标了它在那边的出处，别只改一边。
 *
 * ⚠ 不复用 `SceneLightingSystem` 那个类本身：它是主场景那一份的持有者（`unload()` 会
 * 拆掉当前场景的背景 mesh），借用它等于让窗去动主场景的显示。要的是同一个 **Pass**，
 * 不是同一个**系统**。
 */
export interface WindowWorldPayload {
  sceneId: string;
  /** 这份载荷是给哪一段的（`phase` 空串 = 白日基底）。 */
  target: WindowWorldTarget;
  /** 对面那张原画。 */
  painting: Texture;
  geo: SceneLightingGeometry;
  /** 合并好的那一段的环境参数（顶层 ⊕ 该时段覆盖）。 */
  lighting: SceneLightingDef;
  /** 对面那一段的辐射场（原画 + albedo × 该时段的灯）。 */
  pass: SceneLightingPass;
  meta: LightingGeometryMeta;
  /** 那张场景深度图的 URL —— CPU 侧要解同一张（实体的楔形判据必须与背景同族）。 */
  depthUrl: string;
  /** 与 shader 同一套解码参数。两边必须同源，分开写迟早漂。 */
  depthMapping: { invert: boolean; scale: number; offset: number };
  worldWidth: number;
  worldHeight: number;
  /** M.R 第 2 行——窗的着色要拿它取世界 Y（与 LitBackground 同一处用法）。 */
  mRow1: [number, number, number];
  destroy(): void;
}

/** 装载失败的原因；调用方据此决定"法宝无反应"还是"报一声"。 */
export type WindowWorldPayloadFailure =
  | 'no-target'          // 这个场景没有对面那一副样子
  | 'no-depth-config'    // 没有深度场，窗里算不出世界位置
  | 'no-geometry'        // 那张画没烘过几何场
  | 'bad-geometry'       // 烘了但缺运行时要读的字段
  | 'texture-failed';    // 法线 / albedo / 原画装不上

export interface WindowWorldPayloadResult {
  payload: WindowWorldPayload | null;
  failure?: WindowWorldPayloadFailure;
}

/**
 * 按 `target` 装一份窗户世界的载荷。
 *
 * `sceneData` 必须是**窗自己那一份**（`AssetManager.loadSceneData` 每次返回深拷贝），
 * 不要传主场景正在用的那个对象：主场景那份已经被 `applySceneAppearance` 就地改成
 * 当前时段的样子了，拿它解析对面会解析出当前这一段。
 */
export async function loadWindowWorldPayload(
  assetManager: AssetManager,
  sceneId: string,
  sceneData: SceneData,
  target: WindowWorldTarget,
): Promise<WindowWorldPayloadResult> {
  if (!target.usable) return { payload: null, failure: 'no-target' };

  const look = resolveSceneAppearance(sceneData, target.phase);
  const depthCfg = look.depthConfig;
  if (!depthCfg) {
    // 与 SceneLightingSystem.load 同口径：没有深度场就没有世界重建，窗里连锥体都判不了。
    depthError(T, `${sceneId}: 对面那一段没有 depthConfig，窗户世界不启用`);
    return { payload: null, failure: 'no-depth-config' };
  }

  const bakeBase = sceneBakeDirUrl(sceneId, look.primaryBackgroundImage);

  // ⚠ 走 loadOptionalJson 不走 loadJson：dev server 上文件不存在返回 200 + HTML
  //   而不是 404，判据必须看 content-type（optional-asset-probe 机制卡）。
  const meta = await assetManager.loadOptionalJson<LightingGeometryMeta>(`${bakeBase}/geometry.json`);
  if (!meta) {
    depthLog(T, `${sceneId}: 对面那张画没烘几何场（${bakeBase}），窗户世界不启用`);
    return { payload: null, failure: 'no-geometry' };
  }
  const metaProblems = geometryMetaProblems(meta);
  if (metaProblems.length > 0) {
    depthError(T, `${sceneId}: 对面那份 geometry.json 缺运行时要读的字段（${metaProblems.join('；')}）`);
    return { payload: null, failure: 'bad-geometry' };
  }

  // 防腐门：几何场是不是这张画烘出来的。对不上时**照常装载 + 大声报**
  //（与 SceneLightingSystem 同口径：烘焙数据可以缺省，缺省不能影响运行），
  // 因为静默拿错几何在画面上只表现为"窗里光的走向不太对"，作者无从下手。
  await warnIfGeometryMismatched(sceneId, look.primaryBackgroundImage, meta);

  const depthUrl = sceneRuntimeAssetUrl(sceneId, depthCfg.depth_map);
  let painting: Texture;
  let normal: Texture;
  let albedo: Texture;
  let depth: Texture;
  try {
    painting = await assetManager.loadTexture(look.primaryBackgroundImage);
    normal = await assetManager.loadTexture(`${bakeBase}/normal.png`);
    albedo = await assetManager.loadTexture(`${bakeBase}/albedo.png`);
    // 深度逐场景一张（各时段共享几何是硬契约）；AssetManager 有缓存，这里拿到的
    // 与主场景用的是同一份 GPU 纹理，不会多占显存。
    depth = await assetManager.loadTexture(depthUrl);
  } catch (e) {
    depthError(T, `${sceneId}: 窗户世界贴图装载失败（${bakeBase}）`, e);
    return { payload: null, failure: 'texture-failed' };
  }

  const R = depthCfg.M.R;
  const geo: SceneLightingGeometry = {
    normal,
    albedo,
    depth,
    depthSize: [meta.native.w, meta.native.h],
    cal: [depthCfg.M.ppu, depthCfg.M.cx, depthCfg.M.cy],
    wuPerQUnit: meta.scale.scene_per_wu,
    depthMapping: [
      depthCfg.depth_mapping.invert ? 1 : 0,
      depthCfg.depth_mapping.scale,
      depthCfg.depth_mapping.offset,
    ],
    mRows: [
      [R[0][0], R[0][1], R[0][2]],
      [R[1][0], R[1][1], R[1][2]],
      [R[2][0], R[2][1], R[2][2]],
    ],
    haze: meta.haze
      ? {
        k: meta.haze.k,
        strength: meta.haze.strength,
        color: meta.haze.color,
        depthMin: meta.haze.depth_min,
        depthMax: meta.haze.depth_max,
      }
      : undefined,
  };

  // 没写 lighting 块 ≠ 不打光：按缺省块走（画面 = 原画），与主场景同口径。
  const lighting = look.lighting ?? defaultSceneLighting();
  const pass = new SceneLightingPass(painting, geo);
  // 第二个参数是**灯的时段过滤依据**：窗里要亮的是对面那一段的灯，不是此刻这一段的。
  pass.applyParams(lighting, target.phase);
  pass.markDirty();

  depthLog(T, `${sceneId}: 窗户世界载荷就绪 → [${target.phase || '基底'}] ${bakeBase}`);

  return {
    payload: {
      sceneId,
      target,
      painting,
      geo,
      lighting,
      pass,
      meta,
      depthUrl,
      depthMapping: {
        invert: depthCfg.depth_mapping.invert === true,
        scale: depthCfg.depth_mapping.scale,
        offset: depthCfg.depth_mapping.offset,
      },
      worldWidth: sceneData.worldWidth,
      worldHeight: sceneData.worldHeight,
      mRow1: [R[1][0], R[1][1], R[1][2]],
      destroy(): void {
        pass.destroy();
        // 贴图归 AssetManager 管（主场景也可能在用同一份），这里只拆自己建的 pass。
      },
    },
  };
}

/** 几何场与原画对不上就报——只报不拦，理由见调用处。 */
async function warnIfGeometryMismatched(
  sceneId: string,
  backgroundUrl: string,
  meta: LightingGeometryMeta,
): Promise<void> {
  const sha = (meta as { background_sha1?: unknown }).background_sha1;
  if (typeof sha !== 'string' || !sha) return;
  try {
    const r = await fetch(backgroundUrl);
    const buf = await r.arrayBuffer();
    const dg = await crypto.subtle.digest('SHA-1', buf);
    const hex = Array.from(new Uint8Array(dg))
      .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
    if (hex !== sha) {
      depthError(T, `${sceneId}: 窗户世界的几何场与那张画对不上`
        + `（烘焙 ${sha} vs 现况 ${hex}），窗里光的走向会不对。`
        + `重烘：\`sh scripts/py.sh -m tools.character_lighting_lab.scene_fields --scene ${sceneId}\``);
    }
  } catch (e) {
    depthError(T, `${sceneId}: 窗户世界几何场哈希门跑不起来`, e);
  }
}
