/**
 * 背景草木随风动（v2：静态底板 + 植被层）。
 *
 * v1 把整张原画做 UV 扭曲：相邻像素被拖着走，石头、树干跟着变形（制作人 2026-09-12：
 * "树干应该整体摇晃，石头应该不动"）。单层扭曲在结构上做不到——被植物盖住的背景没有像素，
 * 植物一动只能拖邻居。v2 由离线拆层（`tools/character_lighting_lab/sway_field.py`）给出：
 *
 * - **底板** `sway_plate.png`：植被沿轮廓往里一条带（`margin` 像素）补成了背景；石头、崖壁、路面都在这里，
 *   **永远不动**；
 * - **植被层**：一株一个实例、一张网格贴回**原画自己的像素**（`sway_matte` 给 alpha，`sway_ids` 保证只画本株）：
 *   - `plant`（树 / 灌丛 / 竹丛）整株绕根部**刚体转动**——树干不变形；
 *   - `field`（成片的草）平滑低频波动、下沿钉住；
 *   - **逐像素的刚体度**（`sway_rigid.png`，作者手画）：竹竿 / 树干这类"只能整体摇晃、不许跟着扭"的部位
 *     按刚体度在"整株转动"与"弯曲"之间插值——同一株里可以竿是刚体、叶子照弯，交界连续不撕开；
 *   - 叶片颤动只作用在**叶**像素上（`matte.G`），木质像素不颤。
 * - 每株的位移压在 `margin` 的 80% 以内（软封顶），所以植物挪开时露出来的只可能是底板上补过的那条带。
 *   补带宽度要兜得住**风里一直斜着**的那一份，不只是晃动的起伏（见下面"原画没有风"）。
 *
 * 风（`utils/sceneWind`，与粒子同一个钟）只给**目标弯角** θ_t = θmax·min(1, (U/U_b)²)——U 是该点此刻的
 * 平均风 × 阵风 × 湍流脉动；**每株（场是每个顶点）自己解受迫二阶振子**收敛到它，所以有惯性：
 * 阵风过去会过冲、以自己的固有频率余振、在阵风周期上会共振。固有频率 ∝ 1/√株高（高的摆得慢），
 * 阻尼 = 结构阻尼 + 随风长的气动阻尼。转动轴 = 上 × 风向（让株朝风向倒），株当成过根、朝相机的直立面
 * （与角色直立 quad 同一假设），画面偏移解回那个面上的世界偏移再转、再投回画面。
 *
 * **渲染走一张 UV 图**（制作人 2026-09-13 定的做法）：每株的网格不直接出颜色，而是往一张离屏的位移图里写
 * 「这个像素该去原图哪里取」（RG = 源 uv − 本像素 uv，乘过覆盖度；A = 覆盖度，按预乘混合叠）。
 * 之后**所有**要读原图信息的地方都先用本像素 uv 读这张图、再去原图取：不打光的背景是
 * `mix(底板, 原画(源 uv), 覆盖度)`；打光的背景读的是光照缓存与深度（`LitBackground`），
 * 植物挪开露出来的地方读"补过背景"的那一份。位移图只存 uv 与覆盖度，光照一格都不用重算。
 *
 * 运动全在 CPU（每株一个转角、每顶点一次仿射），片元只做叶片颤动与"只画本株"。网格只铺有本株像素的格子，
 * **刚体与弯曲的交界、两个锚点的分界处细分**（24 → 6，其余格子不加密；邻格细分了的格子铺成扇形，不留 T 形裂缝）；
 * 场的逐顶点风量按和角公式拆成"只随点"（参数变才重算）与"只随 t"两半，逐帧逐点只剩乘加 + 一次振子积分。
 * 落在草木上的纸钱按本株网格的三角形取**这一帧真实画出来的**位移（`offsetAt`），所以不会在竹子上滑、
 * 也不会与画面差一拍。
 *
 * 🔴 **原画没有风**。原画里的草木就是无风时的样子：画面上画的是**此刻的真实弯角**，从原画姿态算起——
 * 风往左吹就往左斜，风一直在就一直斜着，阵风来了多斜、过去了靠弹性往回弹。**不许减掉任何"平均风弯角"**。
 * 2026-09-11 第一版为了让位移小、塞得进 12 像素的补带，假定"原画画的是平均风下的姿态"、只画围绕它的起伏
 * ——这是编的，原画里没有风。它先后造成：风速调大树反而一动不动（09-12，峰值与平均一起顶到天花板，相减为 0）、
 * 纸钱往左飞树往右倒（09-13，风弱于平均的时间占大半，树大半时间被画在逆风侧）。真正要解决的是补带宽度，
 * 不是改原画的含义（跑马梁松树梢在平均风下就要顺风斜约 10 像素、阵风到约 30 像素）。
 *
 * 两种背景都接了：没点亮的背景由本类自己的合成面出颜色（`composite`）；点亮的背景只产位移图，
 * 由 `LitBackground` 去读（`SceneLightingSystem.attachSway`，露出处另算一份扣掉植物的光照缓存）。
 * ⚠ GLSL 实际编译在 ES 1.00：不用数组；模板字符串里不许出现反引号（pixi-v8-traps）。
 */
import {
  Buffer, BufferUsage, Container, Geometry, Mesh, MeshGeometry, RenderTexture, Shader, type Renderer, type Texture,
} from 'pixi.js';

import type { SceneData } from '../data/types';
import {
  addWindBlasts, resolveSceneWind, windGustBasis, windGustClock, windGustFromBasis, windGustMul, windPhase, windProfile, windVeer,
  SWAY_WAVE_SIZE_DEFAULT, WIND_GUST_BASIS, type SceneWindParams, type WindBlast,
} from '../utils/sceneWind';

/** 拆层载荷版本（`sway.json` 的 `version`）；与 `tools/character_lighting_lab/sway_field.py` 的 `SWAY_VERSION` 同步 */
export const SWAY_MAP_VERSION = 3;

/** 1 m 高的植株被吹到最大弯角一半时的风速量级（wu/s）；U_b = 此值 × √(株高 / 88)。经验参数：没有逐株刚度数据 */
const SWAY_U_BEND = 600;
/**
 * 弯角的渐近上限（弧度）：植物在强风里会顺风收拢，不会被吹平。
 * ⚠ 这是**渐近**的，不是硬截断——见 {@link swayBendAngle}。
 */
const SWAY_THETA_MAX = 0.35;
/** 位移占底板补带宽的上限：再大就会露出底板上没补过的植物本体 */
const SWAY_MARGIN_USE = 0.8;
/**
 * 草木增益 > 1 时，位移上限跟着放开到几倍（制作人 2026-09-12："调大了会走样，但我自己可以看着控制强度"）。
 * 增益 1 = 安全档（位移压在补带里，不可能露馅）；再往上是**作者自己掌握的越界档**：
 * 植物挪开的地方会露出底板上没补过的植物本体、轮廓外的网格顶点也会拉扯得更明显。
 * 与 F2「草木增益」滑条的上限同一个数。
 */
const SWAY_GAIN_CAP_MAX = 4;
/**
 * 摆动是**受迫二阶振子**，不是"按当前风速摆到位"（制作人 2026-09-12："物体对风的响应不真实"）。
 * 准静态的写法没有惯性：阵风一来立刻到位、风一停立刻回中，不会过冲、不会余振——这是看着假的主要来源。
 * 现在风只给**目标弯角**，每株（场是每个顶点）自己解 θ'' + 2ζω₀θ' + ω₀²θ = ω₀²·θ_target：
 * 阵风过去会过冲、会以自己的固有频率余振、在阵风周期上会共振。
 */
/** 阻尼比：静风里的结构阻尼 + 随风长的气动阻尼（大风里不许越吹越荡） */
const SWAY_DAMPING = 0.12;
const SWAY_DAMPING_WIND = 0.25;
/** 振子积分的子步长（秒）与一帧最多几步：ω₀·h 远小于 1 才稳；长帧不补跑一大段 */
const SWAY_SUBSTEP = 1 / 120;
const SWAY_MAX_SUBSTEPS = 8;
/** 湍流强迫：两条错频正弦（逐点相位）叠出脉动风速，第二条的频率倍率与整体幅度 */
const SWAY_TURB_F2 = 2.7;
const SWAY_TURB_GAIN = 0.625;
/** 叶片颤动：叶簇尺度（原画像素）、频率（Hz）、幅度（真实 wu，乘透视系数）；幅度 × 2π / 尺度 压在 0.35 以下 */

const SWAY_LEAF_AMP_WU = 0.7;
/** 植被网格的格子边长（场景 wu） */
const GRID_CELL = 24;
/**
 * 交界格每边细分几份（24 → 4×4 个 6）。格内位移是顶点线性插值：一格里一半竿一半叶，插出来就是半软半硬；
 * 一根比格子细的竿一个顶点都压不中，整根照弯（制作人 2026-09-14："不然大部分时候刚体没用"）。
 * **只细分交界格**——刚体与弯曲的交界、两个锚点"管辖区"的分界：整格全刚（刚体转动对位置是线性的）
 * 或全弯时，线性插值本来就是准的，加密只是白算。必须是偶数（扇形格的中心顶点要落在细格点上）。
 */
const GRID_REFINE = 4;
/** 一格（外扩一个细格）里刚体度最大最小差超过它，就算刚体交界格 */
const RIGID_MIX_TOL = 0.08;
/** 格子的铺法：不铺 / 整格两个三角 / 细分成 GRID_REFINE² 小格 / 扇形（邻格细分了，边上带挂点，防 T 形裂缝） */
const CELL_NONE = 0;
const CELL_QUAD = 1;
const CELL_FINE = 2;
const CELL_FAN = 3;

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** `sway.json` 里的一株 */
export interface SwayInstanceDef {
  id: number;
  kind: 'plant' | 'field';
  /** 根的画面点（场景 wu） */
  root: [number, number];
  /** 根的世界点（风的相位、逐株相位按它算）；缺 = 按画面点近似 */
  rootWorld?: [number, number, number];
  /** 株高（真实 wu） */
  height: number;
  /** 根部的透视系数 */
  persp: number;
  /** 株上离根最远的像素到根的距离（场景 wu） */
  reach: number;
  /** 包围盒（场景 wu） */
  bbox: [number, number, number, number];
  /**
   * 作者点的锚点（场景 wu，草木工作台）：刚体部分绕**离它最近的**锚点转，没有就绕 `root`。
   * 自动分割出来的根常常不在竿底 / 树干底——绕错的点转就是"乱在旋转"。
   */
  anchors?: [number, number][];
  /** 作者标的"整体摆"：整株所有点按根的位置取风的节奏，一起弯（不受 `wind.waveSize` 影响） */
  coherent?: boolean;
}

export interface SwayMapMeta {
  version: number;
  plate?: { file?: string; authored?: boolean };
  matte?: string;
  /** 刚体度图（作者画）：单独一张，不塞 matte 的 alpha（canvas 预乘会把整张 RGB 清零） */
  rigid?: string;
  ids?: string;
  /** 底板补带宽（原画像素） */
  margin?: number;
  /** 视深 → 透视系数表（视深严格增）：沿作者的透视轴采出来，整张画按视深查（轴外的远山也对） */
  depthScale?: [number, number][] | null;
  instances?: SwayInstanceDef[];
  /**
   * 打光场景：植物挪开露出来的地方，光照要用的几何件的"扣掉植物"版本（与底板补在同一批像素上）。
   * 不打光的场景没有这一项。
   */
  litPlate?: { normal?: string; albedo?: string; depth?: string } | null;
}

/** CPU 副本（降半分辨率 RGBA）：id 图查"这一点属于哪株"、matte.B 取自由度 */
interface CpuMap { data: Uint8ClampedArray; w: number; h: number }

/**
 * 单通道 CPU 副本（**原画全分辨率**）：刚体度。建网格时要判"这一格里有没有竿"——
 * 半分辨率加平滑会把两三像素宽的竿抹成半灰，交界判不出来、顶点也取不满。单通道存，内存与原先半分辨率 RGBA 相同。
 */
export interface GrayMap { data: Uint8Array; w: number; h: number }

function readGray(tex: Texture): GrayMap | null {
  const res = (tex.source as { resource?: unknown }).resource as CanvasImageSource | undefined;
  if (!res) return null;
  const w = Math.max(1, Math.round(tex.width)), h = Math.max(1, Math.round(tex.height));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(res, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
  return { data: out, w, h };
}

/**
 * 场景矩形 [x0, x1) × [y0, y1) 里单通道图的最小 / 最大值（0..1）。`stopAbove` 给了就在差值超过它时提前收工
 * （建网格只关心"是不是交界"，不关心确切的差）。矩形整个落在图外 ⇒ [0, 0]。
 */
export function grayRange(
  m: GrayMap, sceneW: number, sceneH: number, x0: number, y0: number, x1: number, y1: number, stopAbove = Infinity,
): [number, number] {
  const ix0 = Math.max(0, Math.floor((x0 / sceneW) * m.w)), ix1 = Math.min(m.w, Math.ceil((x1 / sceneW) * m.w));
  const iy0 = Math.max(0, Math.floor((y0 / sceneH) * m.h)), iy1 = Math.min(m.h, Math.ceil((y1 / sceneH) * m.h));
  if (ix1 <= ix0 || iy1 <= iy0) return [0, 0];
  let lo = 255, hi = 0;
  const stop = stopAbove * 255;
  for (let iy = iy0; iy < iy1; iy++) {
    const row = iy * m.w;
    for (let ix = ix0; ix < ix1; ix++) {
      const v = m.data[row + ix];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi - lo > stop) break;
  }
  return [lo / 255, hi / 255];
}

function readCpu(tex: Texture, smooth: boolean): CpuMap | null {
  const res = (tex.source as { resource?: unknown }).resource as CanvasImageSource | undefined;
  if (!res) return null;
  const w = Math.max(1, Math.round(tex.width / 2)), h = Math.max(1, Math.round(tex.height / 2));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(res, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

/** 拆层的静态输入（按场景一次） */
export interface BackgroundSwayInput {
  /** 这份输入实际装了哪几个 URL（热重载时按它把上一份的纹理丢掉，见 `AssetManager.dropTexture`） */
  urls: string[];
  plateTex: Texture;
  matteTex: Texture;
  idsTex: Texture;
  meta: SwayMapMeta;
  sceneSize: [number, number];
  /** 原画像素尺寸 */
  paintSize: [number, number];
  /** 世界 +X / +Y / +Z 走 1 wu 在场景画面上的位移（wu）：正交相机下是常数 */
  jx: [number, number];
  jy: [number, number];
  jz: [number, number];
  /** 场景点 → 世界 XZ（场的逐顶点风相位用）；给不出 ⇒ null，按画面点近似 */
  sceneToWorldXZ: ((sx: number, sy: number) => [number, number] | null) | null;
  /**
   * 场景点 → 透视系数（按该点视深查 `depthScale`）；给不出 ⇒ null，退回株根的烘焙值。
   * 不用运行时那根透视轴：轴只在可走区有意义，轴外的远山按屏幕位置投上去会拿到近处的系数。
   */
  scaleAt: ((sx: number, sy: number) => number) | null;
  ids: CpuMap | null;
  matte: CpuMap | null;
  /** 刚体度（作者画的竹竿 / 树干，原画全分辨率单通道）；老载荷没有这张 ⇒ null = 全按弯曲走 */
  rigid: GrayMap | null;
  /** 打光场景的补图（法线 / albedo / 深度，扣掉植物的版本）；三张齐了才有 */
  litPlate: { normal: Texture; albedo: Texture; depth: Texture } | null;
}

/**
 * 热重载时新的草木层要插回**旧层原来的位置**（同一个父容器里的层序）。
 * 插错就是草木跑到实体层前面或后面去——画面上很显眼，但没有任何断言看得住，所以单拎出来钉。
 *
 * @param oldIndex 旧层在父容器里的下标；`-1` = 旧层已经不在场上（那就追加到末尾）
 * @param childCount 旧层拆掉**之后**父容器里还剩几个
 */
export function swayInsertIndex(oldIndex: number, childCount: number): number {
  if (!(childCount >= 0)) return 0;
  if (oldIndex < 0) return childCount;
  return Math.max(0, Math.min(oldIndex, childCount));
}

/** `findSwayHostSprite` 看的那几样（Pixi 的 Container / Sprite 结构上满足；测试里用普通对象） */
export interface SwayHostNode {
  readonly children?: readonly unknown[];
  readonly texture?: unknown;
  readonly parent?: unknown;
  renderable?: boolean;
}

/**
 * 原地重装时场景树里**没有旧草木层**可替（进场景那次资源里没有 `sway.json` / 版本旧 ⇒ 装载钩子返回 null、
 * `SceneManager` 什么都没插）：按原画纹理找到主背景那张 Sprite，新层要像装载时那样插在它的位置上并把它藏起来。
 * 原来这一步没有：新层建好了却挂不到树上，游戏日志说"已原地换上"、工作台打勾，画面上一株都不动。
 *
 * 只往下找 `maxDepth` 层（背景层 → 场景背景容器 → Sprite）；要有 `parent` 才算（不在树上的插不回去）。
 */
export function findSwayHostSprite<N extends SwayHostNode>(root: N, primary: unknown, maxDepth = 3): N | null {
  if (!primary) return null;
  const walk = (node: SwayHostNode, depth: number): N | null => {
    if (depth > maxDepth || !Array.isArray(node.children)) return null;
    for (const c of node.children as SwayHostNode[]) {
      if (c && c.texture === primary && c.parent) return c as N;
    }
    for (const c of node.children as SwayHostNode[]) {
      const hit = c ? walk(c, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, 1);
}

/** 视深 → 透视系数：表内线性插值、表外钳两端（与烘焙端 `np.interp` 同口径） */
export function depthScaleLookup(tbl: readonly (readonly [number, number])[], d: number): number {
  const n = tbl.length;
  if (d <= tbl[0][0]) return Math.max(0.01, tbl[0][1]);
  if (d >= tbl[n - 1][0]) return Math.max(0.01, tbl[n - 1][1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tbl[mid][0] <= d) lo = mid; else hi = mid;
  }
  const [d0, s0] = tbl[lo], [d1, s1] = tbl[hi];
  return Math.max(0.01, s0 + ((s1 - s0) * (d - d0)) / Math.max(d1 - d0, 1e-9));
}

/** 装拆层要用的资源口（`AssetManager` 的子集） */
export interface SwayAssetLoader {
  loadOptionalJson<T = unknown>(path: string): Promise<T | null>;
  loadTexture(path: string): Promise<Texture>;
  getTexture(path: string): Texture | null;
}

/**
 * 从场景数据 + 烘焙目录拼出拆层输入。任何一步缺料 ⇒ null（该场景草木不动），缺料原因经 `log` 说出来
 * （"没有风"是正常情况，不说）。v1（整张扭曲）的载荷不再认。
 */
export async function loadBackgroundSwayInput(
  am: SwayAssetLoader,
  sceneData: SceneData,
  urls: { bakeDir: string; depth: string; cacheBust?: string },
  log: (msg: string) => void,
): Promise<BackgroundSwayInput | null> {
  // 重烘后原地重装：`AssetManager` 按 URL 缓存纹理，不换 URL 永远拿到旧图（改完没反应且不报错）
  const bust = urls.cacheBust ? `?v=${encodeURIComponent(urls.cacheBust)}` : '';
  if (!resolveSceneWind(sceneData.wind)) return null;
  const dc = sceneData.depthConfig;
  if (!dc?.M?.R || !dc.depth_mapping) { log('场景配了风但没有 depthConfig，草木不动'); return null; }
  const meta = await am.loadOptionalJson<SwayMapMeta>(`${urls.bakeDir}/sway.json${bust}`);
  if (!meta) { log(`没拆植被层（${urls.bakeDir}/sway.json），草木不动`); return null; }
  if (meta.version !== SWAY_MAP_VERSION) {
    log(`植被拆层版本 ${meta.version} ≠ ${SWAY_MAP_VERSION}，整份忽略（重跑 sway_field）`);
    return null;
  }
  if (!Array.isArray(meta.instances) || meta.instances.length === 0) { log('植被拆层里一株都没有'); return null; }
  const [plateTex, matteTex, idsTex] = await Promise.all([
    am.loadTexture(`${urls.bakeDir}/${meta.plate?.file ?? 'sway_plate.png'}${bust}`),
    am.loadTexture(`${urls.bakeDir}/${meta.matte ?? 'sway_matte.png'}${bust}`),
    am.loadTexture(`${urls.bakeDir}/${meta.ids ?? 'sway_ids.png'}${bust}`),
  ]);
  // 刚体度只在 CPU 上用（片元不需要），缺了就是"没人画过刚体"，不算缺料
  const rigidTex = meta.rigid
    ? await am.loadTexture(`${urls.bakeDir}/${meta.rigid}${bust}`).catch(() => null) : null;
  const loaded = [
    `${urls.bakeDir}/${meta.plate?.file ?? 'sway_plate.png'}${bust}`,
    `${urls.bakeDir}/${meta.matte ?? 'sway_matte.png'}${bust}`,
    `${urls.bakeDir}/${meta.ids ?? 'sway_ids.png'}${bust}`,
    ...(meta.rigid && rigidTex ? [`${urls.bakeDir}/${meta.rigid}${bust}`] : []),
  ];
  // 打光场景的补图：三张齐了才用（缺一张就等于打光的漏出处拿着植物的法线 / 深度去照，宁可不接）
  let litPlate: BackgroundSwayInput['litPlate'] = null;
  const lp = meta.litPlate;
  if (lp?.normal && lp.albedo && lp.depth) {
    const lpUrls = [lp.normal, lp.albedo, lp.depth].map((f) => `${urls.bakeDir}/${f}${bust}`);
    try {
      const [normal, albedo, depth] = await Promise.all(lpUrls.map((u) => am.loadTexture(u)));
      litPlate = { normal, albedo, depth };
      loaded.push(...lpUrls);
    } catch (e) {
      log(`打光补图装不上（${String(e)}），打光场景的草木不接`);
    }
  }
  // id 必须最近邻：插值出来的 id 是两株之间的假 id
  idsTex.source.scaleMode = 'nearest';
  const R = dc.M.R;
  const W = sceneData.worldWidth, H = sceneData.worldHeight;
  const depthTex = am.getTexture(urls.depth);
  const nw = plateTex.width, nh = plateTex.height;
  let ids: CpuMap | null = null, matte: CpuMap | null = null, rigid: GrayMap | null = null;
  try {
    ids = readCpu(idsTex, false);
    matte = readCpu(matteTex, true);
    if (rigidTex) rigid = readGray(rigidTex);
  } catch (e) { log(`拆层读不出 CPU 副本：${String(e)}`); }
  // 场的逐顶点世界 XZ 与透视系数：从原画深度反算（与光照同一份标定）
  let sceneToWorldXZ: BackgroundSwayInput['sceneToWorldXZ'] = null;
  let scaleAt: BackgroundSwayInput['scaleAt'] = null;
  if (depthTex) {
    const dm = readCpu(depthTex, false);
    if (dm) {
      const ppu = dc.M.ppu, cx = dc.M.cx, cy = dc.M.cy;
      const wuPerQ = (W * ppu) / Math.max(depthTex.width, 1);
      const inv = !!dc.depth_mapping.invert, sc = dc.depth_mapping.scale, of = dc.depth_mapping.offset;
      const depthAt = (sx: number, sy: number): number => {
        const ix = Math.min(dm.w - 1, Math.max(0, Math.floor((sx / W) * dm.w)));
        const iy = Math.min(dm.h - 1, Math.max(0, Math.floor((sy / H) * dm.h)));
        const o = (iy * dm.w + ix) * 4;
        const raw = (dm.data[o] * 256 + dm.data[o + 1]) / 65535;
        return (inv ? 1 - raw : raw) * sc + of;
      };
      sceneToWorldXZ = (sx, sy) => {
        const d = depthAt(sx, sy);
        const px = (sx / W) * depthTex.width, py = (sy / H) * depthTex.height;
        const qx = (px - cx) / ppu, qy = (cy - py) / ppu;
        return [
          (R[0][0] * qx + R[0][1] * qy + R[0][2] * d) * wuPerQ,
          (R[2][0] * qx + R[2][1] * qy + R[2][2] * d) * wuPerQ,
        ];
      };
      const tbl = meta.depthScale;
      if (Array.isArray(tbl) && tbl.length >= 2) scaleAt = (sx, sy) => depthScaleLookup(tbl, depthAt(sx, sy));
    }
  }
  return {
    urls: loaded,
    plateTex, matteTex, idsTex, meta,
    sceneSize: [W, H],
    paintSize: [nw, nh],
    jx: [R[0][0], -R[0][1]],
    jy: [R[1][0], -R[1][1]],
    jz: [R[2][0], -R[2][1]],
    sceneToWorldXZ, scaleAt,
    ids, matte, rigid,
    litPlate,
  };
}

// ---------------------------------------------------------------------------- 着色

const VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
in float aInst;
in float aLeaf;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec2 uSceneSize;
uniform vec2 uUvMapSize;
out vec2 vUV;
out vec2 vHere;
out float vInst;
out float vLeaf;
void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    // 网格顶点是场景坐标；位移图按原画像素尺寸开，缩放在这里做（不靠容器变换）
    vec2 rt = aPosition * (uUvMapSize / uSceneSize);
    vec2 screen = (model * vec3(rt, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUV = aUV;
    vHere = aPosition / uSceneSize;
    vInst = aInst;
    vLeaf = aLeaf;
}
`;

/**
 * 写位移图：RG = (源 uv − 本像素 uv) × 覆盖度，B = A = 覆盖度，按预乘混合叠（远的先画）。
 * 读的一方 `源 uv = 本像素 uv + RG / A`。存差值而不是绝对 uv：位移只有几十像素，半浮点在这个量级
 * 精度够（绝对 uv 到 2048 宽时半浮点只剩整像素级）；覆盖度为 0 的地方天然就是"不动"。
 */
const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
in vec2 vHere;
in float vInst;
in float vLeaf;
out vec4 fragColor;
uniform sampler2D uMatte;       // R = 植被 alpha, G = 叶度, B = 自由度
uniform sampler2D uIds;         // R/G = 实例 id 低/高字节（最近邻）
uniform vec2  uPaintSize;
uniform float uTime;
uniform float uLeafPx;          // 叶片细抖波长（原画像素，= wind.leaf.size 换算）
uniform float uLeafHz;          // 叶片细抖频率

vec2 leafFlutter(vec2 p, float t) {
    float k = 6.2831853 / max(uLeafPx, 1.0);
    float wt = 6.2831853 * uLeafHz * t;
    float a = sin((p.x * 0.83 + p.y * 0.51) * k + wt);
    float b = sin((p.y * 0.91 - p.x * 0.47) * k + wt * 1.37 + 1.9);
    float c = sin((p.x * 0.29 - p.y * 0.37) * k + wt * 0.71 + 4.1);
    return vec2(a + 0.6 * c, b - 0.6 * c) * 0.5;
}

void main(void) {
    vec2 uv = vUV;
    // 叶片颤动：只在叶像素上（木质的叶度 ≈ 0，不颤）
    float leafy = texture(uMatte, uv).g;
    uv += leafFlutter(uv * uPaintSize, uTime) * (vLeaf * leafy) / uPaintSize;
    vec4 idc = texture(uIds, uv);
    float id = floor(idc.r * 255.0 + 0.5) + 256.0 * floor(idc.g * 255.0 + 0.5);
    if (abs(id - vInst) > 0.5) { discard; }
    float a = texture(uMatte, uv).r;
    if (a < 0.004) { discard; }
    fragColor = vec4((uv - vHere) * a, a, a);
}
`;

const COMP_VERT = /* glsl */ `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUv;
void main(void) {
    mat3 model = uWorldTransformMatrix * uTransformMatrix;
    vec2 screen = (model * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4((uProjectionMatrix * vec3(screen, 1.0)).xy, 0.0, 1.0);
    vUv = aUV;
}
`;

/** 不打光的背景：先读位移图，再按源 uv 取原画，露出来的地方是补过背景的底板 */
const COMP_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPainting;
uniform sampler2D uPlate;
uniform sampler2D uUvMap;
void main(void) {
    vec3 col = texture(uPlate, vUv).rgb;
    vec4 m = texture(uUvMap, vUv);
    if (m.a > 0.002) {
        vec3 fg = texture(uPainting, vUv + m.rg / m.a).rgb;
        col = mix(col, fg, clamp(m.a, 0.0, 1.0));
    }
    fragColor = vec4(col, 1.0);
}
`;

/**
 * WebGPU 版(WGSL):与上面四段 GLSL 逐句对应。Pixi 网格约定:`globalUniforms` 在 group 0、`localUniforms` 在 group 1
 * (声明了这两个名字 GpuMeshAdapter 才自动绑),自有资源在 group 2,变量名 = Shader resources 的键名,
 * 每张纹理配一个 `<名>Sampler`;`swayU` 结构体成员顺序 = resources 里的声明顺序(WebGPU 按声明顺序排偏移)。
 */
const WGSL_MESH_UNIFORMS = /* wgsl */ `
struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
`;

/**
 * 写位移图(同 VERT + FRAG)。
 * ⚠ 片元里两次 discard 之前先把 uMatte 的 .r 取好:WGSL 的 textureSample 只许在一致控制流里调,
 *   GLSL 原文在第一次 discard 之后才取;discard 的片元结果本来就不要,提前取与原文逐像素相同。
 */
const SWAY_WGSL = WGSL_MESH_UNIFORMS + /* wgsl */ `
struct SwayU {
  uPaintSize: vec2<f32>,
  uSceneSize: vec2<f32>,
  uUvMapSize: vec2<f32>,
  uTime: f32,
  uLeafPx: f32,
  uLeafHz: f32,
}
@group(2) @binding(0) var uMatte: texture_2d<f32>;
@group(2) @binding(1) var uMatteSampler: sampler;
@group(2) @binding(2) var uIds: texture_2d<f32>;
@group(2) @binding(3) var uIdsSampler: sampler;
@group(2) @binding(4) var<uniform> swayU: SwayU;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
  @location(1) vHere: vec2<f32>,
  @location(2) vInst: f32,
  @location(3) vLeaf: f32,
}

@vertex
fn mainVertex(
  @location(0) aPosition: vec2<f32>,
  @location(1) aUV: vec2<f32>,
  @location(2) aInst: f32,
  @location(3) aLeaf: f32,
) -> VSOutput {
  let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let rt = aPosition * (swayU.uUvMapSize / swayU.uSceneSize);
  let screen = (model * vec3<f32>(rt, 1.0)).xy;
  var o: VSOutput;
  o.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
  o.vUV = aUV;
  o.vHere = aPosition / swayU.uSceneSize;
  o.vInst = aInst;
  o.vLeaf = aLeaf;
  return o;
}

fn leafFlutter(p: vec2<f32>, t: f32) -> vec2<f32> {
  let k = 6.2831853 / max(swayU.uLeafPx, 1.0);
  let wt = 6.2831853 * swayU.uLeafHz * t;
  let a = sin((p.x * 0.83 + p.y * 0.51) * k + wt);
  let b = sin((p.y * 0.91 - p.x * 0.47) * k + wt * 1.37 + 1.9);
  let c = sin((p.x * 0.29 - p.y * 0.37) * k + wt * 0.71 + 4.1);
  return vec2<f32>(a + 0.6 * c, b - 0.6 * c) * 0.5;
}

@fragment
fn mainFragment(
  @location(0) vUV: vec2<f32>,
  @location(1) vHere: vec2<f32>,
  @location(2) vInst: f32,
  @location(3) vLeaf: f32,
) -> @location(0) vec4<f32> {
  var uv = vUV;
  let leafy = textureSample(uMatte, uMatteSampler, uv).g;
  uv += leafFlutter(uv * swayU.uPaintSize, swayU.uTime) * (vLeaf * leafy) / swayU.uPaintSize;
  let idc = textureSample(uIds, uIdsSampler, uv);
  let a = textureSample(uMatte, uMatteSampler, uv).r;
  let id = floor(idc.r * 255.0 + 0.5) + 256.0 * floor(idc.g * 255.0 + 0.5);
  if (abs(id - vInst) > 0.5) { discard; }
  if (a < 0.004) { discard; }
  return vec4<f32>((uv - vHere) * a, a, a);
}
`;

/**
 * 不打光的合成面(同 COMP_VERT + COMP_FRAG)。
 * ⚠ 取原画那一下在分支里:WGSL 分支里不能 textureSample,改 textureSampleLevel(…, 0)——
 *   原画没有 mip(单级),与 GLSL 的 texture() 等价。
 */
const COMP_WGSL = WGSL_MESH_UNIFORMS + /* wgsl */ `
@group(2) @binding(0) var uPainting: texture_2d<f32>;
@group(2) @binding(1) var uPaintingSampler: sampler;
@group(2) @binding(2) var uPlate: texture_2d<f32>;
@group(2) @binding(3) var uPlateSampler: sampler;
@group(2) @binding(4) var uUvMap: texture_2d<f32>;
@group(2) @binding(5) var uUvMapSampler: sampler;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) vUv: vec2<f32>,
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VSOutput {
  let model = globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let screen = (model * vec3<f32>(aPosition, 1.0)).xy;
  var o: VSOutput;
  o.position = vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(screen, 1.0)).xy, 0.0, 1.0);
  o.vUv = aUV;
  return o;
}

@fragment
fn mainFragment(@location(0) vUv: vec2<f32>) -> @location(0) vec4<f32> {
  var col = textureSample(uPlate, uPlateSampler, vUv).rgb;
  let m = textureSample(uUvMap, uUvMapSampler, vUv);
  if (m.a > 0.002) {
    let fg = textureSampleLevel(uPainting, uPaintingSampler, vUv + m.rg / m.a, 0.0).rgb;
    col = mix(col, fg, clamp(m.a, 0.0, 1.0));
  }
  return vec4<f32>(col, 1.0);
}
`;

// ---------------------------------------------------------------------------- 运动

interface InstRt {
  def: SwayInstanceDef;
  /** 这株顶点在网格里的起止（顶点序号） */
  v0: number;
  v1: number;
  /** 当前帧：转角（弧度，刚体株） */
  theta: number;
  /** 当前帧：叶片颤动幅度（原画像素） */
  leaf: number;
  /** 当前帧：风向（水平单位向量，已带摆动） */
  dx: number;
  dz: number;
  /** 位移软封顶（场景 wu，逐帧按草木增益给） */
  cap: number;
  /** 直立面上画面偏移 → 世界偏移的 2×2 逆（a,b 两列） */
  inv: [number, number, number, number];
  /** 当前帧（刚体株）：画面偏移 = (xa·a + xb·b, ya·a + yb·b)，(a, b) = inv·(相对根的画面偏移) */
  rig: [number, number, number, number];
  /** 当前帧（场）：逐点弯角要用的本株常量 */
  fld: FieldFrame;
  /** 刚体株的振子状态：[绝对弯角, 角速度]（弧度 / 弧度每秒） */
  st: Float32Array;
  /** 本株根部的逐点相位（湍流强迫用）的 cos / sin */
  phC: number;
  phS: number;
  /** 本株的网格（纸钱按它取当前帧真实画出来的位移） */
  grid: SwayGrid | null;
}

/**
 * 一株的网格：粗格 nx × ny（边长 ≤ GRID_CELL），顶点落在细格点阵上（每粗格 k × k）。
 * `vmap` 按细格点阵寻址（(nx·k + 1) × (ny·k + 1)，-1 = 没有这个顶点），`mode` 是每个粗格的铺法（CELL_*）。
 */
interface SwayGrid {
  x0: number; y0: number; x1: number; y1: number;
  nx: number; ny: number; k: number;
  vmap: Int32Array;
  mode: Uint8Array;
}

/** 场一株一帧的常量：驱动（平均风 / 弯角系数 / 湍流钟）+ 振子（ω₀²、2ζω₀）+ 封顶 */
interface FieldFrame {
  Um: number; kb: number; cap: number; ti: number;
  sa: number; ca: number; sb: number; cb: number;
  k1: number; k2: number;
}

/** 一株的格网范围与"哪些格子铺" */
interface Grid { x0: number; y0: number; x1: number; y1: number; nx: number; ny: number; occ: Uint8Array }

/**
 * 准静态弯角：θ = θmax·x/(1+x)，x = (U/U_b)²（传进来的是 θmax·x）。
 *
 * ⚠ **不许换回 `min(θmax, θmax·x)` 那种硬截断**（制作人 2026-09-12："把风速倍率调很大，
 * 树木晃得更小，甚至一动不动"）：看得见的晃动 = 阵风峰值与平时弯角之差，硬截断一旦让两者
 * 双双顶到天花板，差**恒等于 0**——树被压死在最大弯角上一动不动，风越大越死。平滑饱和的导数处处为正：
 * 风大到 3 倍 U_b 时摆幅降到峰值的三分之一，但永远不会归零。
 * 小风下与旧式一致（x ≪ 1 时 x/(1+x) ≈ x），所以常规风力的手感不变。
 */
export function swayBendAngle(thMaxTimesX: number): number {
  return thMaxTimesX / (1 + thMaxTimesX / SWAY_THETA_MAX);
}


function softCap(v: number, cap: number): number {
  const k = v / cap;
  return v / Math.sqrt(1 + k * k);
}

/**
 * 受迫二阶振子走 `steps` 个子步：θ'' + k2·θ' + k1·(θ − target) = 0，半隐式欧拉。
 * 状态交错存在 `st[i]`（弯角）与 `st[i + 1]`（角速度）里——每株（场是每顶点）一份。
 * k1 = ω₀²、k2 = 2ζω₀；稳定条件是 ω₀·h 远小于 1（见 `SWAY_SUBSTEP`）。
 */
export function stepSwayOscillator(
  st: Float32Array, i: number, target: number, k1: number, k2: number, h: number, steps: number,
): void {
  let th = st[i], v = st[i + 1];
  for (let s = 0; s < steps; s++) {
    v += (k1 * (target - th) - k2 * v) * h;
    th += v * h;
  }
  st[i] = th;
  st[i + 1] = v;
}

/** 逐点湍流相位（按世界 XZ） */
function swayPhase(x: number, z: number): number {
  return 2.1 * Math.sin(x * 0.041 + 1.3) + 1.7 * Math.sin(z * 0.033 - 0.7) + 1.3 * Math.sin((x + z) * 0.027 + 2.1);
}

/** 这一点刚体转动的支点：离它最近的作者锚点，没有锚点就是自动分割的根 */
export function swayPivot(def: Pick<SwayInstanceDef, 'root' | 'anchors'>, sx: number, sy: number): [number, number] {
  const an = def.anchors;
  if (!an || an.length === 0) return def.root;
  let best = an[0], bd = Infinity;
  for (const a of an) {
    const d = (a[0] - sx) * (a[0] - sx) + (a[1] - sy) * (a[1] - sy);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

/**
 * 矩形 [x0, x1] × [y0, y1] 是不是跨了两个锚点的"管辖区"（{@link swayPivot} 取最近锚点的分界）。
 * "离 A 比离 B 近"是个半平面，矩形是凸的，四个角都在 A 那侧整格就都在 A 那侧——所以查四个角就是精确的。
 * 恰好压在分界线上的角也算跨（顶点取支点时平局归下标小的那个，不一定是中心那个）。
 */
export function swayPivotSplits(
  anchors: readonly (readonly [number, number])[] | undefined, x0: number, y0: number, x1: number, y1: number,
): boolean {
  if (!anchors || anchors.length < 2) return false;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let a = 0, bd = Infinity;
  for (let k = 0; k < anchors.length; k++) {
    const d = (anchors[k][0] - cx) ** 2 + (anchors[k][1] - cy) ** 2;
    if (d < bd) { bd = d; a = k; }
  }
  const [ax, ay] = anchors[a];
  for (let k = 0; k < anchors.length; k++) {
    if (k === a) continue;
    const [bx, by] = anchors[k];
    for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      if ((px - bx) ** 2 + (py - by) ** 2 <= (px - ax) ** 2 + (py - ay) ** 2) return true;
    }
  }
  return false;
}

/**
 * 扇形格的边界点（格内细格坐标），顺序：上边左→右、右边上→下、下边右→左、左边下→上（与整格三角同一绕向）。
 * 只在**邻格细分了**的那条边上带挂点；四边都没有细分的邻格 ⇒ null（整格两个三角就好）。
 */
function fanRing(up: boolean, right: boolean, down: boolean, left: boolean, k: number): [number, number][] | null {
  if (!up && !right && !down && !left) return null;
  const ring: [number, number][] = [];
  for (let t = 0; t < k; t++) if (t === 0 || up) ring.push([t, 0]);
  for (let t = 0; t < k; t++) if (t === 0 || right) ring.push([k, t]);
  for (let t = 0; t < k; t++) if (t === 0 || down) ring.push([k - t, k]);
  for (let t = 0; t < k; t++) if (t === 0 || left) ring.push([0, k - t]);
  return ring;
}

/** 细格边长（场景 wu）：粗格按包围盒均分，边长 ≤ GRID_CELL，两个方向取大的那个 */
function fineCellSize(g: { x0: number; y0: number; x1: number; y1: number; nx: number; ny: number }): number {
  return Math.max((g.x1 - g.x0) / g.nx, (g.y1 - g.y0) / g.ny) / GRID_REFINE;
}

/**
 * 按 id 图标出每株格网里有本株像素的格子，再外扩一格：位移 ≤ 补带宽 < 格边长，挪出去的像素仍落在铺了的格里。
 * 没有 CPU id 图 ⇒ 整张包围盒都铺。
 */
function markOccupied(ids: CpuMap | null, W: number, H: number, defs: readonly SwayInstanceDef[], grids: readonly Grid[]): void {
  if (!ids) { for (const G of grids) G.occ.fill(1); return; }
  let maxId = 0;
  for (const d of defs) maxId = Math.max(maxId, d.id);
  const slot = new Int32Array(maxId + 1).fill(-1);
  defs.forEach((d, k) => { slot[d.id] = k; });
  const { data, w, h } = ids;
  for (let iy = 0; iy < h; iy++) {
    const sy = ((iy + 0.5) / h) * H;
    for (let ix = 0; ix < w; ix++) {
      const o = (iy * w + ix) * 4;
      const id = data[o] + 256 * data[o + 1];
      if (!id || id > maxId || slot[id] < 0) continue;
      const G = grids[slot[id]];
      const i = Math.floor(((((ix + 0.5) / w) * W - G.x0) / (G.x1 - G.x0)) * G.nx);
      const j = Math.floor(((sy - G.y0) / (G.y1 - G.y0)) * G.ny);
      if (i >= 0 && i < G.nx && j >= 0 && j < G.ny) G.occ[j * G.nx + i] = 1;
    }
  }
  for (const G of grids) {
    const src = G.occ.slice();
    for (let j = 0; j < G.ny; j++) {
      for (let i = 0; i < G.nx; i++) {
        let hit = 0;
        for (let dj = -1; dj <= 1 && !hit; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= G.ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii >= 0 && ii < G.nx && src[jj * G.nx + ii]) { hit = 1; break; }
          }
        }
        G.occ[j * G.nx + i] = hit;
      }
    }
  }
}

/**
 * 没点亮的背景：底板 Sprite + 植被层网格，换掉原来那张平铺 Sprite。摆放与原背景相同（铺满场景世界尺寸）。
 * 由组装层在 `SceneManager` 的摆动钩子里建、在卸载钩子里销（先于纹理与背景容器）。
 */
export interface SwayBackgroundOptions {
  /**
   * 自己合成出颜色（不打光的背景）；false = 只产位移图，由打光的背景去读（`LitBackground`）。
   * 两种模式的网格、振子、位移图完全是同一份。
   */
  composite?: boolean;
}

/** 冲击风采样的暂存（逐株 / 逐顶点复用） */
const BLAST_TMP = new Float32Array(3);

export class SwayBackground {
  readonly root: Container;
  /** 这一帧的冲击风（落雷，见 `update`）；没有 = null */
  private blasts: readonly WindBlast[] | null = null;
  private blastTime = 0;
  /** 位移图：RG = (源 uv − 本像素 uv) × 覆盖度，A = 覆盖度（场景 uv 寻址，原画像素尺寸） */
  readonly uvMap: RenderTexture;
  private readonly comp: Mesh<MeshGeometry, Shader> | null = null;
  private readonly compShader: Shader | null = null;
  private uvDirty = true;
  private uvBroken = false;
  private readonly mesh: Mesh<Geometry, Shader>;
  private readonly shader: Shader;
  private readonly insts: InstRt[] = [];
  private readonly byId = new Map<number, InstRt>();
  private readonly p0: Float32Array;
  private readonly pos: Float32Array;
  private readonly leaf: Float32Array;
  private readonly posBuf: Buffer;
  private readonly leafBuf: Buffer;
  private readonly margin: number;
  /** 场的逐顶点静态量：自由度、刚体度、世界 XZ、逐点摆动相位的 (cos, sin) */
  private readonly vFree: Float32Array;
  private readonly vRigid: Float32Array;
  private readonly vWorld: Float32Array;
  private readonly vOsc: Float32Array;
  /** 场的逐顶点幅度 株高·自由度^1.25·透视（静态） */
  private readonly vAmp: Float32Array;
  /** 场的逐顶点阵风"只随点"那半（风向 / 风速 / 阵风周期变了才重算） */
  private readonly vGust: Float32Array;
  /** 场的逐顶点振子状态：[绝对弯角, 角速度] 交错 */
  private readonly vSt: Float32Array;
  /** 逐顶点刚体转动的支点（场景 wu）：离它最近的作者锚点，没有就是根 */
  private readonly vPivot: Float32Array;
  /** 下一帧把状态按当前风"摆到位"（进场景 / 断档 / 停风后恢复，避免一上来先荡一下） */
  private prime = true;
  private lastTime = 0;
  private gustKey: [number, number, number, number, number] = [NaN, NaN, NaN, NaN, NaN];
  private readonly clock = new Float32Array(WIND_GUST_BASIS);
  private moving = false;
  private destroyed = false;
  /** 上一帧 `update` 的耗时（毫秒，指数滑动平均）：F2 面板按它显示这套摆动的实时开销 */
  private ms = 0;

  constructor(painting: Texture, private readonly inp: BackgroundSwayInput, opts: SwayBackgroundOptions = {}) {
    const [W, H] = inp.sceneSize;
    this.root = new Container();
    this.margin = (inp.meta.margin ?? 12) * (W / inp.paintSize[0]);

    // ---- 网格：每株一张格网、只铺有本株像素的格子，远的先画
    const defs = [...(inp.meta.instances ?? [])].sort((a, b) => a.root[1] - b.root[1]);
    const grids: Grid[] = defs.map((d) => {
      const pad = this.margin;
      const x0 = Math.max(0, d.bbox[0] - pad), y0 = Math.max(0, d.bbox[1] - pad);
      const x1 = Math.min(W, d.bbox[2] + pad), y1 = Math.min(H, d.bbox[3] + pad);
      const nx = Math.max(1, Math.ceil((x1 - x0) / GRID_CELL)), ny = Math.max(1, Math.ceil((y1 - y0) / GRID_CELL));
      return { x0, y0, x1, y1, nx, ny, occ: new Uint8Array(nx * ny) };
    });
    markOccupied(inp.ids, W, H, defs, grids);
    const p0: number[] = [], uv: number[] = [], inst: number[] = [], idx: number[] = [];
    const [ja, jb] = [inp.jx, inp.jy];
    const det = ja[0] * jb[1] - jb[0] * ja[1];
    const inv: [number, number, number, number] = Math.abs(det) > 1e-9
      ? [jb[1] / det, -jb[0] / det, -ja[1] / det, ja[0] / det] : [1, 0, 0, 1];
    const K = GRID_REFINE;
    defs.forEach((d, k) => {
      const G = grids[k];
      const v0 = p0.length / 2;
      const FX = G.nx * K, FY = G.ny * K;
      // 顶点一律落在细格点阵上：整格的四个角就是 (i·K, j·K) 那几个点，与细分格、扇形格的挂点天然共用
      const vmap = new Int32Array((FX + 1) * (FY + 1)).fill(-1);
      const vert = (I: number, J: number): number => {
        const key = J * (FX + 1) + I;
        if (vmap[key] < 0) {
          const x = G.x0 + ((G.x1 - G.x0) * I) / FX, y = G.y0 + ((G.y1 - G.y0) * J) / FY;
          vmap[key] = p0.length / 2;
          p0.push(x, y);
          uv.push(x / W, y / H);
          inst.push(d.id);
        }
        return vmap[key];
      };
      const mode = new Uint8Array(G.nx * G.ny);
      for (let j = 0; j < G.ny; j++) {
        for (let i = 0; i < G.nx; i++) {
          const c = j * G.nx + i;
          if (G.occ[c]) mode[c] = this.cellNeedsRefine(d, G, i, j) ? CELL_FINE : CELL_QUAD;
        }
      }
      const fineAt = (i: number, j: number): boolean =>
        i >= 0 && j >= 0 && i < G.nx && j < G.ny && mode[j * G.nx + i] === CELL_FINE;
      for (let j = 0; j < G.ny; j++) {
        for (let i = 0; i < G.nx; i++) {
          const c = j * G.nx + i;
          if (mode[c] === CELL_NONE) continue;
          const I0 = i * K, J0 = j * K;
          if (mode[c] === CELL_FINE) {
            for (let fj = 0; fj < K; fj++) {
              for (let fi = 0; fi < K; fi++) {
                const a = vert(I0 + fi, J0 + fj), b = vert(I0 + fi + 1, J0 + fj);
                const cc = vert(I0 + fi, J0 + fj + 1), e = vert(I0 + fi + 1, J0 + fj + 1);
                idx.push(a, b, e, a, e, cc);
              }
            }
            continue;
          }
          const ring = fanRing(fineAt(i, j - 1), fineAt(i + 1, j), fineAt(i, j + 1), fineAt(i - 1, j), K);
          if (!ring) {
            const a = vert(I0, J0), b = vert(I0 + K, J0), cc = vert(I0, J0 + K), e = vert(I0 + K, J0 + K);
            idx.push(a, b, e, a, e, cc);
            continue;
          }
          // ⚠ 邻格细分了，共用的那条边上多出 K−1 个挂点：这一格还按两个三角铺，挂点处就是 T 形接缝，
          //   两边位移不同时裂开一条缝、露出底板。扇形从格心连到边上的每一个点，与邻格逐点对上。
          mode[c] = CELL_FAN;
          const ctr = vert(I0 + K / 2, J0 + K / 2);
          const ids = ring.map(([di, dj]) => vert(I0 + di, J0 + dj));
          for (let t = 0; t < ids.length; t++) idx.push(ctr, ids[t], ids[(t + 1) % ids.length]);
        }
      }
      if (p0.length / 2 === v0) return;
      const rt: InstRt = {
        def: d, v0, v1: p0.length / 2, theta: 0, leaf: 0, dx: 1, dz: 0,
        cap: SWAY_MARGIN_USE * this.margin, inv, rig: [0, 0, 0, 0],
        fld: { Um: 0, kb: 0, cap: SWAY_MARGIN_USE * this.margin, ti: 0, sa: 0, ca: 1, sb: 0, cb: 1, k1: 0, k2: 0 },
        st: new Float32Array(2), phC: 1, phS: 0,
        grid: { x0: G.x0, y0: G.y0, x1: G.x1, y1: G.y1, nx: G.nx, ny: G.ny, k: K, vmap, mode },
      };
      // 根部相位与逐点相位都按波浪尺寸算，在 refreshGust 里（波浪尺寸可以在 F2 里实时拖）
      this.insts.push(rt);
      this.byId.set(d.id, rt);
    });
    this.p0 = Float32Array.from(p0);
    this.pos = Float32Array.from(p0);
    const nv = this.p0.length / 2;
    this.leaf = new Float32Array(nv);
    this.vFree = new Float32Array(nv);
    this.vRigid = new Float32Array(nv);
    this.vWorld = new Float32Array(nv * 2);
    this.vOsc = new Float32Array(nv * 2);
    this.vAmp = new Float32Array(nv);
    this.vGust = new Float32Array(nv * WIND_GUST_BASIS);
    this.vSt = new Float32Array(nv * 2);
    this.vPivot = new Float32Array(nv * 2);
    for (const rt of this.insts) {
      for (let v = rt.v0; v < rt.v1; v++) {
        const [pxv, pyv] = swayPivot(rt.def, this.p0[v * 2], this.p0[v * 2 + 1]);
        this.vPivot[v * 2] = pxv;
        this.vPivot[v * 2 + 1] = pyv;
      }
    }
    for (const rt of this.insts) {
      if (rt.def.kind !== 'field') continue;
      const fine = rt.grid ? fineCellSize(rt.grid) : GRID_CELL / K;
      for (let v = rt.v0; v < rt.v1; v++) {
        const sx = this.p0[v * 2], sy = this.p0[v * 2 + 1];
        this.vFree[v] = this.sampleFree(sx, sy);
        this.vRigid[v] = this.rigidCoverage(sx, sy, fine);
        const wxz = inp.sceneToWorldXZ?.(sx, sy) ?? null;
        const px = wxz ? wxz[0] : sx, pz = wxz ? wxz[1] : -sy;
        this.vWorld[v * 2] = px;
        this.vWorld[v * 2 + 1] = pz;
        const fr = this.vFree[v];
        this.vAmp[v] = fr > 0 ? Math.max(rt.def.height, 4) * Math.pow(fr, 1.25) * this.scaleAt(sx, sy, rt.def.persp) : 0;
      }
    }
    this.posBuf = new Buffer({ data: this.pos, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.leafBuf = new Buffer({ data: this.leaf, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.posBuf, format: 'float32x2' },
        aUV: { buffer: new Buffer({ data: Float32Array.from(uv), usage: BufferUsage.VERTEX }), format: 'float32x2' },
        aInst: { buffer: new Buffer({ data: Float32Array.from(inst), usage: BufferUsage.VERTEX }), format: 'float32' },
        aLeaf: { buffer: this.leafBuf, format: 'float32' },
      },
      indexBuffer: new Buffer({ data: Uint32Array.from(idx), usage: BufferUsage.INDEX }),
    });
    const [nw, nh] = inp.paintSize;
    // ★ 半浮点：RG 存的是**差值**（几十像素量级，精度足够），可以线性过滤（预乘量插值是对的）
    this.uvMap = RenderTexture.create({ width: nw, height: nh, format: 'rgba16float', scaleMode: 'linear', antialias: false });
    this.shader = Shader.from({
      gl: { vertex: VERT, fragment: FRAG },
      gpu: {
        vertex: { source: SWAY_WGSL, entryPoint: 'mainVertex' },
        fragment: { source: SWAY_WGSL, entryPoint: 'mainFragment' },
      },
      resources: {
        uMatte: inp.matteTex.source,
        uMatteSampler: inp.matteTex.source.style,
        uIds: inp.idsTex.source,
        uIdsSampler: inp.idsTex.source.style,
        // ⚠ 成员顺序 = SWAY_WGSL 里 SwayU 的成员顺序
        swayU: {
          uPaintSize: { value: new Float32Array(inp.paintSize), type: 'vec2<f32>' },
          uSceneSize: { value: new Float32Array([W, H]), type: 'vec2<f32>' },
          uUvMapSize: { value: new Float32Array([nw, nh]), type: 'vec2<f32>' },
          uTime: { value: 0, type: 'f32' },
          uLeafPx: { value: 22, type: 'f32' },
          uLeafHz: { value: 3.2, type: 'f32' },
        },
      },
    });
    // 网格不进场景树：每帧渲进位移图（`renderUv`），屏幕上只有合成面（或打光的背景）去读它
    this.mesh = new Mesh({ geometry, shader: this.shader });
    if (opts.composite !== false) {
      this.compShader = Shader.from({
        gl: { vertex: COMP_VERT, fragment: COMP_FRAG },
        gpu: {
          vertex: { source: COMP_WGSL, entryPoint: 'mainVertex' },
          fragment: { source: COMP_WGSL, entryPoint: 'mainFragment' },
        },
        resources: {
          uPainting: painting.source,
          uPaintingSampler: painting.source.style,
          uPlate: inp.plateTex.source,
          uPlateSampler: inp.plateTex.source.style,
          uUvMap: this.uvMap.source,
          uUvMapSampler: this.uvMap.source.style,
        },
      });
      this.comp = new Mesh({
        geometry: new MeshGeometry({
          positions: new Float32Array([0, 0, W, 0, W, H, 0, H]),
          uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
          indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        }),
        shader: this.compShader,
      });
      this.root.addChild(this.comp);
    }
  }

  /**
   * 把这一帧的网格渲进位移图。放在逐帧 update 之后、主画面渲染之前（与光照缓存同一拍）。
   * 渲染路径上抛一次就是整局卡死（pixi-v8-traps），所以这里兜住：大声报一次，之后不再画（草木静止）。
   */
  renderUv(renderer: Renderer): void {
    if (this.destroyed || this.uvBroken || !this.uvDirty) return;
    try {
      renderer.render({ container: this.mesh, target: this.uvMap, clear: true, clearColor: [0, 0, 0, 0] });
      this.uvDirty = false;
    } catch (e) {
      this.uvBroken = true;
      console.error('[backgroundSway] 位移图渲染失败，草木停在原位', e);
    }
  }

  /** 顶点数（调试 / 性能读数） */
  get vertexCount(): number { return this.p0.length / 2; }

  /** 逐帧耗时（毫秒，平滑过）：预算是"整套风 ≤ 2 ms/帧"，超了先看顶点数与实例数 */
  get updateMs(): number { return this.ms; }

  /** 株数（调试 / 性能读数） */
  get instanceCount(): number { return this.insts.length; }

  /** 位移软封顶：增益 1 = 压在底板补带里；增益再大按倍数放开（作者自己掌握，会露出补带外的内容） */
  private capFor(w: SceneWindParams): number {
    return SWAY_MARGIN_USE * this.margin * Math.min(SWAY_GAIN_CAP_MAX, Math.max(1, w.gainSway));
  }

  /** 该点的透视系数（按视深查）；没有深度 / 表 ⇒ 株根的烘焙值 */
  private scaleAt(sx: number, sy: number, fallback: number): number {
    return this.inp.scaleAt ? this.inp.scaleAt(sx, sy) : fallback;
  }

  private sampleFree(sx: number, sy: number): number {
    return this.sampleMatte(sx, sy, 2, 1);
  }

  /**
   * 顶点的刚体度（作者手画：竹竿 / 树干；1 = 只跟着整株转、一点不弯）= 以它为中心、半边长一个细格的方块里**最大**的那个。
   * ⚠ 不许退回"只取顶点那一点"：比格子细的竿会从顶点之间漏过去，整根照弯（制作人 2026-09-14 实测"还有扭曲"）。
   * 取一个细格内的最大值，竿上每个像素所在细格的四个角都看得见它，竿上插出来的刚体度就是满的；
   * 代价是竿两侧一个细格（≈ 6 wu）内的叶子跟着变硬——这就是过渡带。缺这张图 ⇒ 0（照旧全弯）。
   */
  private rigidCoverage(sx: number, sy: number, reach: number): number {
    const m = this.inp.rigid;
    if (!m) return 0;
    const [W, H] = this.inp.sceneSize;
    return grayRange(m, W, H, sx - reach, sy - reach, sx + reach, sy + reach)[1];
  }

  /**
   * 这一粗格要不要细分（见 GRID_REFINE）。两种交界：
   * - **刚体交界**（只对场：`plant` 整株刚转，不看刚体度）：这一格**外扩一个细格**里刚体度有高有低。
   *   外扩的窗口与顶点取刚体度的窗口一样大——不外扩的话，整格判成"全弯"、角上的顶点却从隔壁取到了竿，
   *   这一整格被带硬半边；
   * - **锚点分界**：刚体部分（`plant` 整株 / 场里有刚体的格）跨了两个锚点的管辖区。两边绕不同的点转，
   *   同一格里插值就是两种转动搅在一起。
   */
  private cellNeedsRefine(d: SwayInstanceDef, G: Grid, i: number, j: number): boolean {
    const cw = (G.x1 - G.x0) / G.nx, ch = (G.y1 - G.y0) / G.ny;
    const x0 = G.x0 + i * cw, y0 = G.y0 + j * ch, x1 = x0 + cw, y1 = y0 + ch;
    let rigidHere = d.kind === 'plant';
    const m = this.inp.rigid;
    if (d.kind === 'field' && m) {
      const e = fineCellSize(G);
      const [W, H] = this.inp.sceneSize;
      const [lo, hi] = grayRange(m, W, H, x0 - e, y0 - e, x1 + e, y1 + e, RIGID_MIX_TOL);
      if (hi - lo > RIGID_MIX_TOL) return true;
      rigidHere = hi > RIGID_MIX_TOL;
    }
    return rigidHere && swayPivotSplits(d.anchors, x0, y0, x1, y1);
  }

  /**
   * 场景点 (sx, sy) 这一帧**真实画出来的**位移：找到它落在哪个三角形里，按三个顶点的当前位移线性插值
   * ——与 GPU 光栅化是同一个插值，所以纸钱拿到的就是画面上那一点（细分格、扇形格一样）。
   */
  private drawnOffset(rt: InstRt, sx: number, sy: number, out: { x: number; y: number }): void {
    out.x = 0;
    out.y = 0;
    const g = rt.grid;
    if (!g) return;
    const fx = ((sx - g.x0) / Math.max(g.x1 - g.x0, 1e-6)) * g.nx;
    const fy = ((sy - g.y0) / Math.max(g.y1 - g.y0, 1e-6)) * g.ny;
    const i = Math.min(g.nx - 1, Math.max(0, Math.floor(fx)));
    const j = Math.min(g.ny - 1, Math.max(0, Math.floor(fy)));
    const u = Math.min(1, Math.max(0, fx - i)), q = Math.min(1, Math.max(0, fy - j));
    const md = g.mode[j * g.nx + i];
    if (md === CELL_NONE) return;
    const K = g.k, S = g.nx * K + 1;
    const at = (I: number, J: number): number => g.vmap[J * S + I];
    const I0 = i * K, J0 = j * K;
    if (md === CELL_FINE) {
      const uf = u * K, qf = q * K;
      const fi = Math.min(K - 1, Math.floor(uf)), fj = Math.min(K - 1, Math.floor(qf));
      this.quadOffset(at(I0 + fi, J0 + fj), at(I0 + fi + 1, J0 + fj), at(I0 + fi, J0 + fj + 1),
        at(I0 + fi + 1, J0 + fj + 1), uf - fi, qf - fj, out);
      return;
    }
    if (md === CELL_QUAD) {
      this.quadOffset(at(I0, J0), at(I0 + K, J0), at(I0, J0 + K), at(I0 + K, J0 + K), u, q, out);
      return;
    }
    const fineAt = (ii: number, jj: number): boolean =>
      ii >= 0 && jj >= 0 && ii < g.nx && jj < g.ny && g.mode[jj * g.nx + ii] === CELL_FINE;
    const ring = fanRing(fineAt(i, j - 1), fineAt(i + 1, j), fineAt(i, j + 1), fineAt(i - 1, j), K);
    if (!ring) return;
    const c = at(I0 + K / 2, J0 + K / 2);
    for (let t = 0; t < ring.length; t++) {
      const [ai, aj] = ring[t], [bi, bj] = ring[(t + 1) % ring.length];
      // (u, q) 在三角 (格心, A, B) 里的重心坐标
      const ax = ai / K - 0.5, ay = aj / K - 0.5, bx = bi / K - 0.5, by = bj / K - 0.5;
      const px = u - 0.5, py = q - 0.5;
      const den = ax * by - bx * ay;
      if (Math.abs(den) < 1e-12) continue;
      const la = (px * by - bx * py) / den, lb = (ax * py - px * ay) / den;
      if (la < -1e-9 || lb < -1e-9 || la + lb > 1 + 1e-9) continue;
      const va = at(I0 + ai, J0 + aj), vb = at(I0 + bi, J0 + bj);
      const P = this.pos, Q = this.p0, lc = 1 - la - lb;
      out.x = lc * (P[c * 2] - Q[c * 2]) + la * (P[va * 2] - Q[va * 2]) + lb * (P[vb * 2] - Q[vb * 2]);
      out.y = lc * (P[c * 2 + 1] - Q[c * 2 + 1]) + la * (P[va * 2 + 1] - Q[va * 2 + 1]) + lb * (P[vb * 2 + 1] - Q[vb * 2 + 1]);
      return;
    }
  }

  /** 整格 / 细格的两个三角 (a,b,e) 与 (a,e,c)（与建网格时同一条对角线）里的线性插值；(u, q) 是格内 0..1 坐标 */
  private quadOffset(a: number, b: number, c: number, e: number, u: number, q: number, out: { x: number; y: number }): void {
    if (a < 0 || b < 0 || c < 0 || e < 0) return;
    const P = this.pos, Q = this.p0;
    for (let k = 0; k < 2; k++) {
      const A = P[a * 2 + k] - Q[a * 2 + k], B = P[b * 2 + k] - Q[b * 2 + k];
      const C = P[c * 2 + k] - Q[c * 2 + k], E = P[e * 2 + k] - Q[e * 2 + k];
      const v = u >= q ? A + u * (B - A) + q * (E - B) : A + q * (C - A) + u * (E - C);
      if (k === 0) out.x = v; else out.y = v;
    }
  }

  private sampleMatte(sx: number, sy: number, ch: number, fallback: number): number {
    const m = this.inp.matte;
    if (!m) return fallback;
    const [W, H] = this.inp.sceneSize;
    const ix = Math.min(m.w - 1, Math.max(0, Math.floor((sx / W) * m.w)));
    const iy = Math.min(m.h - 1, Math.max(0, Math.floor((sy / H) * m.h)));
    return m.data[(iy * m.w + ix) * 4 + ch] / 255;
  }

  private instAt(sx: number, sy: number): InstRt | null {
    const m = this.inp.ids;
    if (!m) return null;
    const [W, H] = this.inp.sceneSize;
    const ix = Math.min(m.w - 1, Math.max(0, Math.floor((sx / W) * m.w)));
    const iy = Math.min(m.h - 1, Math.max(0, Math.floor((sy / H) * m.h)));
    const o = (iy * m.w + ix) * 4;
    const id = m.data[o] + 256 * m.data[o + 1];
    return id ? this.byId.get(id) ?? null : null;
  }

  /** 逐顶点阵风基：风的推进参数（风向 / 风速 / 阵风周期）变了才重算，其余时候每帧逐点零超越函数 */
  /**
   * 风向 / 风速 / 阵风周期 / 波浪尺寸变了才重算的逐点量：湍流相位与阵风的"只随点"那半。
   *
   * 波浪尺寸按**株内的相对位置**起作用：每个点先朝本株的根收拢 `s = 缺省 / 当前` 倍，再去取风的节奏。
   * 所以调大波浪尺寸，同一株上的点离得"更近"、一起动；株与株之间各自的根不同，风扫过草坡的先后照旧。
   * ⚠ 只放大湍流的空间尺度不够：阵风是沿风向**扫过去**的，一株沿风向铺开 600 wu，
   *   阵风到两头就差 1.5 s，照样一截先弯一截后弯（测试抓到过，相关系数 −0.19）。两样必须一起收拢。
   * 标了"整体摆"的株等于收拢到零：所有点都按根的位置取，整株同一个节奏。
   * 缺省波浪尺寸（s = 1）不收拢，与改成可调之前逐位一致。
   */
  private refreshGust(w: SceneWindParams): void {
    const k = this.gustKey;
    if (k[0] === w.dirX && k[1] === w.dirZ && k[2] === w.speed && k[3] === w.gustPeriod && k[4] === w.waveSize) return;
    this.gustKey = [w.dirX, w.dirZ, w.speed, w.gustPeriod, w.waveSize];
    const s = SWAY_WAVE_SIZE_DEFAULT / Math.max(w.waveSize, 1e-3);
    for (const rt of this.insts) {
      const rw = rt.def.rootWorld ?? [rt.def.root[0], 0, -rt.def.root[1]];
      const rph = swayPhase(rw[0], rw[2]);
      rt.phC = Math.cos(rph);
      rt.phS = Math.sin(rph);
      if (rt.def.kind !== 'field') continue;
      const k2 = rt.def.coherent === true ? 0 : s;
      for (let v = rt.v0; v < rt.v1; v++) {
        const wx = this.vWorld[v * 2], wz = this.vWorld[v * 2 + 1];
        const px = k2 === 1 ? wx : rw[0] + (wx - rw[0]) * k2;
        const pz = k2 === 1 ? wz : rw[2] + (wz - rw[2]) * k2;
        const ph = swayPhase(px, pz);
        this.vOsc[v * 2] = Math.cos(ph);
        this.vOsc[v * 2 + 1] = Math.sin(ph);
        if (this.vAmp[v] > 0) windGustBasis(w, windPhase(w, 0, px, pz), this.vGust, v * WIND_GUST_BASIS);
      }
    }
  }

  /** 每株一帧的公共量：位移上限、风向（带摆动）、振子系数；刚体株就地把转角解出来 */
  private stepInstance(rt: InstRt, w: SceneWindParams, time: number, h: number, steps: number): void {
    const d = rt.def;
    rt.cap = this.capFor(w);
    rt.fld.cap = rt.cap;
    const [wx, , wz] = d.rootWorld ?? [d.root[0], 0, -d.root[1]];
    const Hh = Math.max(d.height, 4);
    const tau = windPhase(w, time, wx, wz);
    const Ub = SWAY_U_BEND * Math.sqrt(Hh / 88);
    const kb = SWAY_THETA_MAX / (Ub * Ub);
    // 振子：固有频率随株高降（高的摆得慢），阻尼 = 结构 + 气动（风越大越吃阻尼）
    const Um0 = w.speed * w.gainSway * windProfile(w, Math.max(Hh * 0.6, w.roughness * 1.5));
    const om0 = 2 * Math.PI * Math.sqrt(88 / Hh);
    const zeta = SWAY_DAMPING + SWAY_DAMPING_WIND * Math.min(1, Um0 / Ub);
    const k1 = om0 * om0, k2 = 2 * zeta * om0;
    // 湍流强迫的两条错频钟（逐点相位在顶点 / 株上）
    const fT = Math.max(0.2, Um0 / Math.max(w.turbScale, 1));
    const aT = 2 * Math.PI * fT * time, bT = aT * SWAY_TURB_F2;
    const sa = Math.sin(aT), ca = Math.cos(aT), sb = Math.sin(bT), cb = Math.cos(bT);
    const ti = w.turbIntensity * SWAY_TURB_GAIN;
    const a = windVeer(w, tau), cv = Math.cos(a), sv = Math.sin(a);
    rt.dx = w.dirX * cv - w.dirZ * sv;
    rt.dz = w.dirX * sv + w.dirZ * cv;
    const J = this.inp;
    // 整株的刚体转角：`plant` 全株用它；`field` 里被标成刚体的像素（竹竿 / 树干）也用它，
    // 所以一根竿是整根一起摆，不会各段各弯
    {
      const n = (sa * rt.phC + ca * rt.phS) + 0.6 * (sb * rt.phC + cb * rt.phS);
      let U = Math.max(0, Um0 * windGustMul(w, tau) * (1 + ti * n));
      // 冲击风（落雷落地那一下）：与平均风按矢量合成——弯多少看合风速，往哪弯看合风向（离落点近的往外倒）
      if (this.blasts) {
        BLAST_TMP[0] = 0; BLAST_TMP[1] = 0; BLAST_TMP[2] = 0;
        if (addWindBlasts(this.blasts, this.blastTime, wx, wz, Hh * 0.6, BLAST_TMP) > 0) {
          const bx = U * rt.dx + BLAST_TMP[0] * w.gainSway, bz = U * rt.dz + BLAST_TMP[2] * w.gainSway;
          const m = Math.hypot(bx, bz);
          if (m > 1e-6) { U = m; rt.dx = bx / m; rt.dz = bz / m; }
        }
      }
      const tgt = swayBendAngle(kb * U * U);
      if (this.prime) { rt.st[0] = tgt; rt.st[1] = 0; }
      stepSwayOscillator(rt.st, 0, tgt, k1, k2, h, steps);
      // 画的就是此刻的真实弯角：原画没有风，从原画姿态（直立）算起，什么都不减。梢部位移压在封顶里
      rt.theta = softCap(rt.st[0], rt.cap / Math.max(d.reach, 1));
      // 直立面上的世界偏移 (a, b)，转动轴 = 上 × 风向 ⇒ Δ = θ·(dx·b, −dx·a, dz·b)，投回画面
      const th = rt.theta, dx = rt.dx, dz = rt.dz;
      rt.rig[0] = -th * dx * J.jy[0];
      rt.rig[1] = th * (dx * J.jx[0] + dz * J.jz[0]);
      rt.rig[2] = -th * dx * J.jy[1];
      rt.rig[3] = th * (dx * J.jx[1] + dz * J.jz[1]);
      if (d.kind === 'plant') {
        rt.leaf = SWAY_LEAF_AMP_WU * (U / (Ub + U)) * 2 * d.persp * (this.inp.paintSize[0] / this.inp.sceneSize[0]);
        return;
      }
    }
    // 场按株高处的风（不打六折：草叶整片都在株高以内）；逐顶点的驱动与解算在 update 里
    const F = rt.fld;
    F.Um = w.speed * w.gainSway * windProfile(w, Hh);
    F.kb = kb;
    F.ti = ti;
    F.sa = sa; F.ca = ca; F.sb = sb; F.cb = cb;
    F.k1 = k1; F.k2 = k2;
    const uLeaf = F.Um * windGustMul(w, tau);
    rt.leaf = SWAY_LEAF_AMP_WU * (uLeaf / (Ub + uLeaf)) * 2 * d.persp
      * (this.inp.paintSize[0] / this.inp.sceneSize[0]);
  }

  /**
   * 逐帧：每株一个转角（刚体株）/ 每顶点一个位移（场），写进网格。
   * `blasts` / `blastTime` = 冲击风（落雷落地那一下，见 `utils/sceneWind` 的 `WindBlast`）与它自己的钟：
   * 与平均风按矢量合成，离落点近的草木往外倒、再弹回来（振子自己的过冲）。
   */
  update(wind: SceneWindParams | null, time: number, blasts?: readonly WindBlast[] | null, blastTime = 0): void {
    if (this.destroyed) return;
    this.blasts = blasts && blasts.length ? blasts : null;
    this.blastTime = blastTime;
    const t0 = performance.now();
    this.updateInner(wind, time);
    this.ms += (performance.now() - t0 - this.ms) * 0.1;
  }

  private updateInner(wind: SceneWindParams | null, time: number): void {
    const u = this.shader.resources.swayU?.uniforms as Record<string, unknown> | undefined;
    if (u) {
      u.uTime = time;
      if (wind) {
        u.uLeafPx = wind.leafSize * (this.inp.paintSize[0] / this.inp.sceneSize[0]);
        u.uLeafHz = wind.leafHz;
      }
    }
    if (!wind || !(wind.gainSway > 0)) {
      if (this.moving) {
        this.moving = false;
        this.prime = true;
        this.pos.set(this.p0);
        this.leaf.fill(0);
        this.posBuf.update();
        this.leafBuf.update();
        this.uvDirty = true;
      }
      return;
    }
    this.moving = true;
    const w = wind;
    const J = this.inp;
    const p0 = this.p0, pos = this.pos;
    // 振子要真步长；断档 / 倒带（切场景、调试跳帧）就把状态按当前风摆到位，不补跑
    let dt = time - this.lastTime;
    this.lastTime = time;
    if (!(dt > 0) || dt > 0.5) { dt = SWAY_SUBSTEP; this.prime = true; }
    const steps = Math.max(1, Math.min(SWAY_MAX_SUBSTEPS, Math.ceil(dt / SWAY_SUBSTEP)));
    const h = Math.min(dt, SWAY_MAX_SUBSTEPS * SWAY_SUBSTEP) / steps;
    this.refreshGust(w);
    windGustClock(w, time, this.clock);
    for (const rt of this.insts) {
      this.stepInstance(rt, w, time, h, steps);
      const d = rt.def;
      if (d.kind === 'plant') {
        const [xa, xb, ya, yb] = rt.rig;
        const [i0, i1, i2, i3] = rt.inv;
        const pv = this.vPivot;
        for (let v = rt.v0; v < rt.v1; v++) {
          // 绕这一点的支点转（作者锚点，或者根）
          const rx = p0[v * 2] - pv[v * 2], ry = p0[v * 2 + 1] - pv[v * 2 + 1];
          const a = i0 * rx + i1 * ry, b = i2 * rx + i3 * ry;
          pos[v * 2] = p0[v * 2] + xa * a + xb * b;
          pos[v * 2 + 1] = p0[v * 2 + 1] + ya * a + yb * b;
        }
      } else {
        // 场：每一点按自己的世界位置吃阵风（阵风扫过草坡），下沿钉住（自由度）
        const ex = J.jx[0] * rt.dx + J.jz[0] * rt.dz, ey = J.jx[1] * rt.dx + J.jz[1] * rt.dz;
        const F = rt.fld;
        const prime = this.prime;
        const [xa, xb, ya, yb] = rt.rig;
        const [i0, i1, i2, i3] = rt.inv;
        const pv = this.vPivot;
        for (let v = rt.v0; v < rt.v1; v++) {
          const A = this.vAmp[v];
          const rg = this.vRigid[v];
          if (A <= 0 && rg <= 0) continue;
          // 驱动：本点此刻的风（平均 × 阵风 × 湍流脉动）→ 它此刻"想弯到"的角度
          const cp = this.vOsc[v * 2], sp = this.vOsc[v * 2 + 1];
          const g = windGustFromBasis(w, this.clock, this.vGust, v * WIND_GUST_BASIS);
          const n = (F.sa * cp + F.ca * sp) + 0.6 * (F.sb * cp + F.cb * sp);
          let U = Math.max(0, F.Um * g * (1 + F.ti * n));
          // 冲击风：这一点自己的合风（离落点近的往外倒），方向逐点
          let vex = ex, vey = ey;
          if (this.blasts) {
            BLAST_TMP[0] = 0; BLAST_TMP[1] = 0; BLAST_TMP[2] = 0;
            if (addWindBlasts(this.blasts, this.blastTime, this.vWorld[v * 2], this.vWorld[v * 2 + 1], rt.def.height, BLAST_TMP) > 0) {
              const bx = U * rt.dx + BLAST_TMP[0] * w.gainSway, bz = U * rt.dz + BLAST_TMP[2] * w.gainSway;
              const m = Math.hypot(bx, bz);
              if (m > 1e-6) {
                U = m;
                const ux = bx / m, uz = bz / m;
                vex = J.jx[0] * ux + J.jz[0] * uz; vey = J.jx[1] * ux + J.jz[1] * uz;
              }
            }
          }
          const tgt = swayBendAngle(F.kb * U * U);
          // 解算：这一点自己的惯性（过冲 / 余振 / 与阵风共振都从这里出来）
          if (prime) { this.vSt[v * 2] = tgt; this.vSt[v * 2 + 1] = 0; }
          stepSwayOscillator(this.vSt, v * 2, tgt, F.k1, F.k2, h, steps);
          const amp = softCap(A * this.vSt[v * 2], F.cap);          // 真实弯角，原画没有风
          let ox = vex * amp, oy = vey * amp;
          if (rg > 0) {
            // 刚体度：往"绕支点转"那一头插值（1 = 完全不弯，只跟着竿转；支点 = 最近的作者锚点或根）
            const rx = p0[v * 2] - pv[v * 2], ry = p0[v * 2 + 1] - pv[v * 2 + 1];
            const a = i0 * rx + i1 * ry, b = i2 * rx + i3 * ry;
            ox += rg * (xa * a + xb * b - ox);
            oy += rg * (ya * a + yb * b - oy);
          }
          pos[v * 2] = p0[v * 2] + ox;
          pos[v * 2 + 1] = p0[v * 2 + 1] + oy;
        }
      }
      this.leaf.fill(rt.leaf, rt.v0, rt.v1);
    }
    this.prime = false;
    this.posBuf.update();
    this.leafBuf.update();
    this.uvDirty = true;
  }

  /** 草木在场景点 (sx, sy) 的位移（给躺在上面的纸钱）；该点不属于任何一株 ⇒ false */
  offsetAt(
    wind: SceneWindParams | null, t: number, sx: number, sy: number, _wx: number, _wz: number, out: { x: number; y: number },
  ): boolean {
    if (this.destroyed || !wind || !(wind.gainSway > 0)) return false;
    const rt = this.instAt(sx, sy);
    if (!rt) return false;
    const d = rt.def, J = this.inp;
    if (d.kind === 'plant') {
      const [pvx, pvy] = swayPivot(d, sx, sy);
      const rx = sx - pvx, ry = sy - pvy;
      const a = rt.inv[0] * rx + rt.inv[1] * ry, b = rt.inv[2] * rx + rt.inv[3] * ry;
      out.x = rt.rig[0] * a + rt.rig[1] * b;
      out.y = rt.rig[2] * a + rt.rig[3] * b;
      return true;
    }
    // 场：状态在顶点上，纸钱取**这一帧真实画出来的**位移（按三角形插值，与光栅化同一个；不再另算一份公式）
    this.drawnOffset(rt, sx, sy, out);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.root.removeFromParent();
    // ⚠ 顺序即正确性：先拆读位移图的合成面，最后才销毁位移图（BindGroup 见死即自毁，pixi-v8-traps）。
    //   打光模式下读它的是 LitBackground —— 所有者必须先让它解绑（`SceneLightingSystem.detachSway`）。
    if (this.comp) {
      const cg = this.comp.geometry;
      this.comp.destroy();
      cg.destroy(true);
      this.compShader?.destroy();
    }
    // Mesh.destroy 只把 geometry 置空、不销毁它；shader 由所有者（本类）回收；纹理归资产管理器
    const g = this.mesh.geometry;
    this.mesh.destroy();
    g.destroy(true);
    this.shader.destroy();
    this.uvMap.destroy(true);
    this.root.destroy();
  }
}
