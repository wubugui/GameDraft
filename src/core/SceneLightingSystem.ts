import { BufferImageSource, type Renderer, type Texture, type TextureSource } from 'pixi.js';

import type { SceneData, SceneDepthConfig, SceneLightingDef } from '../data/types';
import { LitBackground } from '../rendering/lighting/LitBackground';
import { RawPatchRelightFilter } from '../rendering/lighting/RawPatchRelightFilter';
import { SceneLightingPass, type SceneLightingGeometry } from '../rendering/lighting/SceneLightingPass';
import type { PackedLights } from '../rendering/lighting/lightPacking';
import { resolveDepthPerSy } from '../utils/worldReconstruct';
import type { AssetManager } from './AssetManager';
import { depthError, depthLog } from './depthLog';
import { sceneRuntimeAssetUrl } from './projectPaths';

const T = 'SceneLighting';

/** `lighting3/meta.json` 的载荷。由 `tools/scene_relight/bake_gbuffer.py` 产出。 */
export interface LightingGeometryMeta {
  version: number;
  background_sha1: string | null;
  work: { w: number; h: number };
  native: { w: number; h: number };
  cal: { ppu: number; cx: number; cy: number };
  M: number[][];
  // ⚠ 这里曾经声明过顶层的 `grid` / `band` / `depth_range` 三个必填字段。
  //   烘焙器**从来没写过**它们（网格与 band 在 `char_grid` 里），也没有任何
  //   消费端读它们 —— `tsc` 因此全绿，数据里却是空的。同一个坑在 `scale` 上
  //   炸过一次（真机装载即抛）。**类型声明不是数据契约**：改这个接口时
  //   一定要跟 `bake_gbuffer.bake()` 里的 `meta = {...}` 逐键对一遍。
  /**
   * 刻度链。`char_wu` 只反映**取景远近**（角色固定 150 场景坐标高，而
   * worldWidth 逐场景 700–4000），**不是**摆灯的尺度参照。
   */
  scale: { char_wu: number; scene_per_wu: number };
  /** march 参数（诊断用，运行时不读 —— 它有自己的一套 uniform）。 */
  march: { steps: number; length: number; bias: number;
           bias_growth: number; thickness: number };
  /** 拟合出的白天大气散射（诊断用；去霾已在烘焙期做完）。 */
  haze: { k: number; strength: number; color: number[]; residual: number };
  /**
   * 天穹遮蔽（`sky_occlusion.png`，RGBA8：RGB = bent 方向·½+½，A = 余弦加权可见度）。
   *
   * ⚠ v3 起**不再逐像素预投影天空**。上一版每像素存 4 个纬向通道的传输，
   *   角色网格还要为同一件事再存 4 个 SH-L1 通道 —— 同一个量两种参数化，
   *   实测在角色典型法线处两边差 10%–15%。现在两侧都只存
   *   (bent 方向, 可见度)，天空是运行时的全局 SH。
   */
  sky_occlusion: { file: string; encoding: string; directions: number };
  /** 可见度对方向的线性重建 `V(ω)=clamp(a+b·ω,0,1)`（`vis_linear.png`）。 */
  vis_linear: { file: string; encoding: string; b_max: number };
  /** 烘焙期反解出的直射光（方向 / 辐射 / 拟合降幅）。migrate3 会把它写进场景。 */
  direct_light: { found: boolean; dir: number[]; radiance: number[];
                  elevation_deg?: number; azimuth_deg?: number; drop?: number };
  /** 局部 AO（`ao.png`，R8）。**与天穹传输是两个量** —— 一个问"看得见多少天"，
   *  一个问"有多封闭"。环境反弹底走这一路。 */
  ao: { file: string; encoding: string; min: number; max: number; mean: number };
  /**
   * **烘焙 GI** —— 伪世界 final gather 积出的原画自身辐照度。
   *
   *     E(x) = ∫ L_in(x,ω)·max(N·ω,0) dω ÷ ∫ max(N·ω,0) dω
   *     L_in = HDR(原画)@命中点   /   天空辐射@逃逸
   *
   * 画本身就是辐射缓存，所以这一步不含任何拟合系数。`gather_gain` 是把
   * "伪世界里没有的光"（太阳、多次反弹）吸收进整体尺度的那个自由因子。
   */
  irradiance: {
    file: string; encoding: string; method: string;
    w: number; h: number;
    /** 对数编码参数（解码必需，逐场景不同）。 */
    scale: number; log_span: number;
    hdr_max: number; gather_gain: number; sky_radiance: number[];
    directions: number;
    min: number; max: number; mean: number;
  };
  /**
   * 运行时默认灯光的**建议值**：若要用解析天光+环境替换掉烘焙 GI，大约填多少。
   * `rel_err` 是这个两基逼近相对 `E` 的平均相对误差 —— 大就说明这张画的照明
   * 有强烈的局部结构（灶口、窗），两个全局基表达不了，该摆真灯。
   */
  runtime_fit: { sky: number; ambient: number; rel_err: number; e_chroma: number[] };
  /**
   * 比例基底 `I_原画 / E`。**不是 albedo**（见 shadeCore3.glsl 头注释）。
   * `clamped_frac` = 出射辐射超过入射辐照的像素占比，那些像素的超出部分
   * 被归进 `emissive`。
   */
  base: {
    file: string; encoding: string;
    /** 对数编码参数（解码必需）。 */
    scale: number; log_span: number;
    w: number; h: number;
    median: number; p99_9: number; clamped_frac: number; chroma: number[];
  };
  /** 角色侧的 SH-L1 传输网格。 */
  char_grid: {
    file: string; nx: number; ny: number; nz: number;
    x0: number; x1: number; y0: number; y1: number; z0: number; z1: number;
    char_wu: number; band: number;
    /** GI 三通道的对数编码参数（解码必需，逐场景不同）。 */
    gi_scale: number; gi_log_span: number;
    channels: string[];
    selfcheck: { open_T_up: number; open_T_horizontal: number };
  };
  /** `gi = 1` 时输出与原画的逐像素差（存储精度体检，单位 1/255）。 */
  roundtrip: { mean_255: number; p99_255: number; max_255: number };
}

/**
 * 角色贴图的平均线性反射率。**实测值，不是教科书常数。**
 *
 * 2026-08-20 量了 `public/resources/runtime/animation/＊/atlas.png` 全部 109 张图集的
 * 不透明像素（3081 万个）：合并中位线性亮度 **0.0381**（p25 0.018 / p75 0.093）。
 *
 * ⚠ 通用图形学里说的"典型反射率 0.25"对这套美术**差 6.5 倍**——本作是暗色民俗恐怖，
 * 角色多穿深色衣物。照 0.25 填会让角色系统性偏暗到原来的 1/6.5，
 * 而且怎么调灯都救不回来（错的是尺度不是光）。
 *
 * 参考：同一次测量里场景反解反射率中位数 0.0385（雾津街头）——两者几乎相同，
 * 因为角色与背景本来就是同一个美术、同一套调色画的。所以 `radianceScale` 在
 * 这个项目里天然接近 1，偏离 1 的部分才是这张画真正的明暗特性。
 *
 * 重量一遍的办法：对每张 atlas 取 `alpha>0.5` 的像素，sRGB→线性后按
 * `[0.2126,0.7152,0.0722]` 取亮度，全部合并取中位数。
 */
export const CHARACTER_ALBEDO_REFERENCE = 0.0381;

/** 本系统认得的载荷代次。改产物布局必须 +1，并同步 `bake.py` 与 validate。 */
export const LIGHTING3_VERSION = 5;

/**
 * 统一光影系统的场景侧协调者。
 *
 * 持有烘出来的**几何场**（法线 / 天穹可见性 / 3D 可见性网格）与两级渲染：
 *
 * ```
 * ①【脏时重算】SceneLightingPass  → RGBA16F 线性 HDR 辐射场
 * ②【逐帧】    LitBackground      → 雾 → 显示变换 → 屏幕
 * ```
 *
 * 场景没有 `lighting` 块、或没烘 `lighting3/` 载荷时，本系统**整体不启用**，
 * 背景照旧走原来的 Sprite 路径（旧场景零影响）。
 */
export class SceneLightingSystem {
  private meta: LightingGeometryMeta | null = null;
  private pass: SceneLightingPass | null = null;
  private geo: SceneLightingGeometry | null = null;
  /**
   * `renderRaw` 装饰实体的重打光滤镜。它们不走角色那条链（那条会除掉
   * `charRefIntensity` 反解基底，对"从背景抠出来的补丁"是错的），只吃
   * `E_目标/E` 这个比值 —— 见 `RawPatchRelightFilter`。
   */
  private readonly rawPatchFilters = new Set<RawPatchRelightFilter>();
  private litBg: LitBackground | null = null;
  private def: SceneLightingDef | null = null;
  /** 角色侧的 SH-L1 传输网格（RGBA8，逐通道 Z 切片平铺）。 */
  private shGridTex: BufferImageSource | null = null;
  private shGridBytes: Uint8Array | null = null;
  private enabled = false;

  get active(): boolean {
    return this.enabled && this.pass !== null && this.litBg !== null;
  }

  /** 供 SceneManager 挂进背景层的 mesh；未启用时为 null。 */
  get backgroundMesh() {
    return this.litBg?.mesh ?? null;
  }

  /**
   * 角色侧的 **SH-L1 天穹传输网格**（GPU 纹理）。
   *
   * 每格每通道存 `(a0, a1)`，运行时 `T_k(N) = a0 + a1·N` —— 这是角色能和场景
   * 走同一套光照的前提：场景把法线烘进了传输基（逐像素法线固定），
   * 而角色的法线**逐像素在变**，喂标量就永远对不上。v2 的标量网格实测比角色
   * 真正需要的那个量偏高 61%（中位），而且身上完全没有方向性。
   *
   * 布局：4 个通道**纵向堆叠**成一张图 —— 宽 = nx*nz，高 = ny*4，
   * 通道 c 占 [c*ny, (c+1)*ny) 行；每行内列 = x + z*nx。
   *
   * 两条铁律：
   * 1. scaleMode nearest + shader 里 texelFetch —— 硬件线性过滤会跨 Z 切片与
   *    通道边界混样（平铺图集的经典坑），三线性必须自己算。
   * 2. alphaMode no-premultiply-alpha —— a1 的三个分量装在 GBA 里当**数据**用，
   *    走默认装载通道会在解码期被预乘毁掉（见 pixi-v8-traps）。
   */
  get skyTransportTexture(): TextureSource | null {
    if (this.shGridTex) return this.shGridTex;
    if (!this.shGridBytes || !this.meta) return null;
    const g = this.meta.char_grid;
    const nch = g.channels.length;
    const w = g.nx * g.nz;
    const h = g.ny * nch;
    const packed = new Uint8Array(w * h * 4);
    // 烘焙侧是 C 序 (channel, x, y, z, rgba)
    for (let c = 0; c < nch; c++) {
      for (let z = 0; z < g.nz; z++) {
        for (let y = 0; y < g.ny; y++) {
          for (let x = 0; x < g.nx; x++) {
            const src = ((((c * g.nx + x) * g.ny + y) * g.nz) + z) * 4;
            const dst = ((c * g.ny + y) * w + (x + z * g.nx)) * 4;
            packed[dst] = this.shGridBytes[src];
            packed[dst + 1] = this.shGridBytes[src + 1];
            packed[dst + 2] = this.shGridBytes[src + 2];
            packed[dst + 3] = this.shGridBytes[src + 3];
          }
        }
      }
    }
    this.shGridTex = new BufferImageSource({
      resource: packed,
      width: w,
      height: h,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      alphaMode: 'no-premultiply-alpha',
    });
    return this.shGridTex;
  }

  /**
   * **1 个伪世界 q 单位 = 多少 wu**。作者面（wu）与 shader 的 march（q）之间的桥。
   *
   * `= worldWidth / (native_w / ppu)`，逐场景不同：雾津街头 880、teahouse 154。
   * 它不是"单位换算"而是**两个空间之间的 transform**——世界空间是游戏摆 NPC /
   * 热区 / spawn 用的那个（`worldWidth` 就是世界宽度），伪世界 q 是深度重建出来的。
   *
   * ⚠ 别把 q 单位叫成 wu。角色在 q 里从 0.17 变到 0.97（随相机标定），
   *   在 wu 里**28 个场景恒为 150**。
   */
  get wuPerQUnit(): number {
    return this.meta?.scale.scene_per_wu ?? 1;
  }

  /**
   * 这张背景有多宽（**wu**）—— 应当**等于场景的 `worldWidth`**（雾津街头 4000）。
   *
   * ⚠ `meta.cal` 是 **work 分辨率**（512×288）的标定，不是 native（2048×1152）的。
   *   一度写成 `native.w / cal.ppu`，正好差 **4 倍**（2048/112.64 = 18.18 而不是 4.5455），
   *   于是这个读数报 16000。它只喂 F2 的读数、不进 shader，所以画面没事，
   *   但读数错了会让人照着它估参数。native 那套标定在 `geo.cal` 里（= depthConfig.M）。
   */
  get backgroundWu(): number {
    const m = this.meta;
    return m ? (m.work.w / Math.max(m.cal.ppu, 1e-9)) * this.wuPerQUnit : 0;
  }

  // ⚠ **屏幕空间反弹那套**（`gi_hitmap` + `GiBouncePass`）已在 v3 移除，
  //   依据是制作人 2026-08-22 的「角色暂时不考虑 gi，把 gi 拿掉」。
  //
  //   ⚠ 现在 `sc3Shade` 第四个参数上接的**烘焙 GI 不是那个东西**，别混为一谈：
  //   它是烘焙期在伪世界里 final gather 积出的**场景自身辐照度**（`irradiance.png`
  //   / 网格 5..7 通道），是"原画里本来就有的光"，不是新加的一遍反弹。
  //   场景默认 `gi = 1` 时画面精确等于原画；角色查同一份网格 —— 这正是
  //   「融入场景」要的东西，也是角色在未重打光的场景里唯一的光源。
  /**
   * 角色侧要的**场景那一半**几何：深度场标定 + M + 3D 网格边界。
   *
   * 角色的 work px 标定那一半由 `CharacterLightingSystem.unifiedGeometry` 给，
   * 两半在 `Game` 里合成一个 `UnifiedCharGeometry`。分开给是因为它们各自的
   * 真相源本来就在两处——硬凑到一处只会让哪边该负责哪个数变得含糊。
   */
  get characterGeometryHalf(): {
    depthSize: [number, number];
    depthCal: [number, number, number];
    depthMapping: [number, number, number];
    mRows: [number[], number[], number[]];
    grid: { n: [number, number, number]; min: [number, number, number]; max: [number, number, number] };
    depth: TextureSource;
  } | null {
    const m = this.meta;
    const p = this.pass;
    if (!m || !p) return null;
    const g = m.char_grid;
    const geo = p.geometry;
    return {
      depthSize: [m.native.w, m.native.h],
      depthCal: geo.cal,
      depthMapping: geo.depthMapping,
      mRows: geo.mRows,
      grid: {
        n: [g.nx, g.ny, g.nz],
        min: [g.x0, g.y0, g.z0],
        max: [g.x1, g.y1, g.z1],
      },
      depth: geo.depth.source,
    };
  }

  /** 最近一次打包好的灯。角色 shader 用**这一份**，不重打——重打就有漂的可能。 */
  get packedLights(): PackedLights | null {
    return this.pass?.packedLights ?? null;
  }

  /**
   * 角色图集的参考天穹强度 —— 把角色送进和场景同一个基底空间。
   *
   * 见 `SceneLightingDef.charRefIntensity`：角色基底 = 图集 ÷ ((1+N·up)/2 × 本值)。
   * 缺省 1（美术按"单位强度天穹"画的）。
   *
   * ⚠ 这**不是** v2 的 `radianceScale`。那个是标量总增益，补不上逐像素的场；
   *   这里是解析除法的分母系数。
   */
  get charRefIntensity(): number {
    return this.def?.charRefIntensity ?? 1;
  }

  /**
   * 角色网格 GI 通道的对数编码参数。**逐场景不同**（scale = 该场景网格 a₀ 的中位）。
   *
   * ⚠ 没有合理缺省：填错不会报错，只是角色整体偏亮/偏暗一个常数倍。
   * 所以由这里从 meta 直读，绝不在着色器侧兜底。
   */
  get giScale(): number {
    return this.meta?.char_grid.gi_scale ?? 1;
  }

  get giLogSpan(): number {
    return this.meta?.char_grid.gi_log_span ?? 16;
  }

  /**
   * 烘焙期算出来的**体检指标**。给 F2 面板显示 —— 这几个数是判断
   * 「画面不对是参数问题还是模型问题」的第一手依据，藏起来等于让人瞎调。
   *
   * - `analyticFitErr`：用解析天光+环境两个基去逼近烘焙 `E` 的平均相对误差。
   *   **大不是错误** —— 它说的是"这张画的照明有强烈局部结构（灶口/窗），
   *   两个全局基表达不了"。重打光时该摆真灯，而不是指望调天光。
   * - `roundtripP99`：`gi = 1` 时输出与原画的逐像素差（1/255）。
   *   这是**存储精度**体检，超过 2 就该怀疑基底的量化档位。
   * - `lightScale`：这个场景**一盏灯该填多大强度**的量级参考（= 用解析天光+环境
   *   逼近烘焙 `E` 时那两个系数之和）。
   *
   *   ⚠ 这条必须显示出来，否则摆灯只能靠瞎试：`E` 的中位跨场景差 **25000 倍**
   *   （城隍庙夜 0.04 ↔ 梦_醒来土路 1041），因为 `to_hdr` 对亮画的展开是指数级的。
   *   而这个尺度**不能归一** —— `base ≤ 1` 这条物理钳位就绑在 `E` 的绝对值上，
   *   把 `E` 缩到中位 1 会让 base 全部撞顶、整张图变成自发光。既然改不了，
   *   就得把它摆到台面上。
   * - `clampedPixels`：**发光压过反射**的像素占比 —— 也就是"重打光时不会跟着
   *   变的那部分画面"。这里刻意用**像素**口径而不是光能口径：灯的 HDR 辐射
   *   极亮，按光能算连 teahouse 这种普通室内都报 79%，而实际上 91% 的像素
   *   照样跟着灯变。作者要判断的是"改光有多少画面会响应"，那是面积问题。
   *   （光能口径仍在 meta 里：`emissive.surface_energy_frac`。）
   * - `openTUp` / `openTHorizontal`：角色网格最开阔格点上的传输值。
   *   户外应当贴近解析真值 **1.000 / 0.500**；偏离说明烘焙的求积或归一化出了问题。
   */
  get diagnostics(): {
    analyticFitErr: number; roundtripP99: number;    lightScale: number; openTUp: number; openTHorizontal: number;
  } | null {
    const m = this.meta;
    if (!m) return null;
    return {
      analyticFitErr: m.runtime_fit.rel_err,
      roundtripP99: m.roundtrip.p99_255,
      lightScale: m.runtime_fit.sky + m.runtime_fit.ambient,
      openTUp: m.char_grid.selfcheck.open_T_up,
      openTHorizontal: m.char_grid.selfcheck.open_T_horizontal,
    };
  }

  /**
   * 装载一个场景的光影。任何一步缺料都**安静地不启用**（返回 false），不打扰玩家；
   * dev 下留日志便于排查（构建期严于运行时，运行时对内容错误容错跳过）。
   */
  // ⚠ v3 起**不再需要原画**：渲染路径上的背景本体是 `lighting3/base.png`
  //   （原画 ÷ E_est，烘焙期算好）。原画只在本方法返回 false 时由 SceneManager
  //   当普通 Sprite 兜底。参数删掉是为了让"谁在用原画"这件事一眼可见。
  async load(
    sceneId: string,
    sceneData: SceneData,
    assetManager: AssetManager,
  ): Promise<boolean> {
    this.unload();
    const def = sceneData.lighting;
    if (!def) {
      depthLog(T, `${sceneId}: 场景未配 lighting 块，走旧路径`);
      return false;
    }
    const depthCfg = sceneData.depthConfig;
    if (!depthCfg) {
      depthError(T, `${sceneId}: 配了 lighting 但没有 depthConfig —— 统一光影依赖深度场`);
      return false;
    }

    // ⚠ 走 loadOptionalJson 不走 loadJson：本仓库 dev server 上文件不存在返回的是
    //   **200 + HTML** 而不是 404，判据必须看 content-type（optional-asset-probe 机制卡）。
    const meta = await assetManager.loadOptionalJson<LightingGeometryMeta>(
      sceneRuntimeAssetUrl(sceneId, 'lighting3/meta.json'),
    );
    if (!meta) {
      depthLog(T, `${sceneId}: 没烘 lighting3/（跑 \`py -m tools.scene_relight.bake_gbuffer --scene ${sceneId}\`）`);
      return false;
    }
    if (meta.version !== LIGHTING3_VERSION) {
      depthError(T, `${sceneId}: lighting3 载荷版本 ${meta.version} ≠ ${LIGHTING3_VERSION}，整包忽略`);
      return false;
    }

    let normal: Texture;
    let skyOcc: Texture;
    let visLin: Texture;
    let aoTex: Texture;
    let base: Texture;
    let irradiance: Texture;
    try {
      normal = await assetManager.loadTexture(sceneRuntimeAssetUrl(sceneId, 'lighting3/normal.png'));
      skyOcc = await assetManager.loadTexture(sceneRuntimeAssetUrl(sceneId, 'lighting3/sky_occlusion.png'));
      visLin = await assetManager.loadTexture(sceneRuntimeAssetUrl(sceneId, 'lighting3/vis_linear.png'));
      aoTex = await assetManager.loadTexture(sceneRuntimeAssetUrl(sceneId, 'lighting3/ao.png'));
      // ★ base 是**渲染路径上的背景本体**（原画不再进渲染），必须原生分辨率、
      //   且必须 await 纳入加载门 —— 它没到位就没有背景可画。
      base = await assetManager.loadTexture(sceneRuntimeAssetUrl(sceneId, 'lighting3/base.png'));
      // ★ 烘焙 GI 与自发光同样是**正式载荷**，不是调试图：缺了它们默认画面
      //   （gi=1）就不再等于原画。所以一起纳入加载门，不做可选降级 ——
      //   静默少一张图的后果是"这个场景怎么变暗了"，查起来极贵。
      irradiance = await assetManager.loadTexture(
        sceneRuntimeAssetUrl(sceneId, 'lighting3/irradiance.png'));
    } catch (e) {
      depthError(T, `${sceneId}: lighting3 贴图装载失败`, e);
      return false;
    }

    const depthTex = assetManager.getTexture(
      sceneRuntimeAssetUrl(sceneId, depthCfg.depth_map),
    );
    if (!depthTex) {
      depthError(T, `${sceneId}: 拿不到深度纹理，统一光影不启用`);
      return false;
    }

    // 装载期一致性断言：depth_per_sy ≡ tanθ/ppu。这条不成立时画面会**静默错到底**
    // （角色上半身穿透前景、影子整体偏移），没有任何报错，所以必须在这里响。
    const R = depthCfg.M.R;
    const flatR = [R[0][0], R[0][1], R[0][2], R[1][0], R[1][1], R[1][2], R[2][0], R[2][1], R[2][2]];
    const dps = resolveDepthPerSy(flatR, depthCfg.M.ppu, depthCfg.shader?.depth_per_sy);
    if (!dps.ok) {
      depthError(
        T,
        `${sceneId}: depth_per_sy 与 M 不自洽（声明 ${dps.declared} vs 由 M 推出 ${dps.expected}）`
        + ' —— 多半是改了 M.ppu/俯角却没重烘深度',
      );
    }

    const cg = meta.char_grid;
    const geo: SceneLightingGeometry = {
      base,
      baseScale: meta.base.scale,
      baseLogSpan: meta.base.log_span,
      irradiance,
      irradianceScale: meta.irradiance.scale,
      irradianceLogSpan: meta.irradiance.log_span,
      normal,
      skyOcc,
      visLin,
      visBMax: meta.vis_linear.b_max,
      ao: aoTex,
      depth: depthTex,
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
      gridMin: [cg.x0, cg.y0, cg.z0],
      gridMax: [cg.x1, cg.y1, cg.z1],
    };

    this.meta = meta;
    this.def = def;
    this.geo = geo;
    this.pass = new SceneLightingPass(geo);
    this.pass.applyParams(def);
    this.pass.markDirty();

    // LitBackground 采样 pass 的 RT，所以必须先让 pass 建出 RT
    // （update 时才真正渲染，这里只是把资源建出来）
    const radiance = this.pass.radiance;
    if (!radiance) {
      // ensure() 在 applyParams 里已跑过，理论到不了这
      depthError(T, `${sceneId}: 辐射场 RT 未建立`);
      this.unload();
      return false;
    }
    this.litBg = new LitBackground(
      radiance, geo,
      [R[1][0], R[1][1], R[1][2]],
      sceneData.worldWidth, sceneData.worldHeight,
    );
    this.litBg.applyParams(def);

    // 角色侧的 SH-L1 传输网格。⚠ 缺了**是致命的**：角色会拿不到天穹传输，
    //   而 v3 里角色与场景走同一条链，没有"回落旧 probe"这个后路了。
    //   所以这里失败要整包不启用，而不是安静降级成平光。
    const g = meta.char_grid;
    try {
      const url = sceneRuntimeAssetUrl(sceneId, `lighting3/${g.file}`);
      const res = await fetch(url);
      // ⚠ 本仓库 dev server 上文件不存在返回 **200 + HTML**，判据必须看 content-type
      if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
        throw new Error('missing');
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const expect = g.channels.length * g.nx * g.ny * g.nz * 4;
      if (bytes.length !== expect) {
        depthError(T, `${sceneId}: sky_sh_grid 长度 ${bytes.length} ≠ 网格声明 ${expect}`);
        this.unload();
        return false;
      }
      this.shGridBytes = bytes;
    } catch {
      depthError(T, `${sceneId}: 拿不到 lighting3/${g.file}，统一光影不启用`);
      this.unload();
      return false;
    }

    this.enabled = true;
    depthLog(T, `${sceneId}: 统一光影 v3 已启用（角色高 ${meta.scale.char_wu.toFixed(3)} wu，`
      + `往返 p99 ${meta.roundtrip.p99_255.toFixed(2)}/255）`);
    return true;
  }

  /** 改了光照参数：写进 uniform 并标脏。下一帧 update 时重算缓存。 */
  applyParams(def: SceneLightingDef): void {
    this.def = def;
    this.pass?.applyParams(def);
    this.pass?.markDirty();
    this.litBg?.applyParams(def);
    // 装饰补丁与背景吃**同一组**显示变换 —— 分家的话补丁的色调会和背景对不上，
    // 而那正是 `renderRaw` 当初要躲开的毛病。
    for (const f of this.rawPatchFilters) f.applyParams(def);
  }

  /**
   * 给 `renderRaw` 装饰实体建一份重打光滤镜。载荷没到位就返回 null
   * （调用方回落到"什么都不挂"，也就是现状）。
   */
  createRawPatchFilter(): RawPatchRelightFilter | null {
    const rad = this.pass?.radiance;
    if (!this.enabled || !this.geo || !rad) return null;
    const f = new RawPatchRelightFilter(this.geo, rad);
    if (this.def) f.applyParams(this.def);
    this.rawPatchFilters.add(f);
    return f;
  }

  releaseRawPatchFilter(f: RawPatchRelightFilter): void {
    this.rawPatchFilters.delete(f);
  }

  /** 逐帧把相机与世界容器位姿喂给装饰补丁滤镜（与深度遮挡滤镜同一个节拍）。 */
  updateRawPatchFrame(worldContainerX: number, worldContainerY: number,
                      projectionScale: number, sceneW: number, sceneH: number): void {
    for (const f of this.rawPatchFilters) {
      f.setWorldContainerPos(worldContainerX, worldContainerY);
      f.setProjectionScale(projectionScale);
      f.setSceneSize(sceneW, sceneH);
    }
  }

  get params(): SceneLightingDef | null {
    return this.def;
  }

  /** 调试可视化：0=正常 1=天穹可见性 2=法线 3=S_day 4=S_new 5=比值 6=线性化原画。 */
  setDebug(mode: number): void {
    this.pass?.setDebug(mode);
  }

  /** 逐帧调。脏才重算，稳态零成本。返回是否真的重算了（供性能观测）。 */
  update(renderer: Renderer): boolean {
    return this.pass?.update(renderer) ?? false;
  }

  unload(): void {
    // ⚠ Pixi 坑②：先拆显示端再销毁它引用的 RT，顺序反了会把 shader 的 BindGroup 永久烧毁
    this.litBg?.destroy();
    this.litBg = null;
    this.pass?.destroy();
    this.pass = null;
    this.geo = null;
    this.rawPatchFilters.clear();
    this.meta = null;
    this.def = null;
    this.shGridBytes = null;
    this.shGridTex?.destroy();
    this.shGridTex = null;
    this.enabled = false;
  }
}
