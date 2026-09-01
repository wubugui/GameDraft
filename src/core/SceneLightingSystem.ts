import { BufferImageSource, type Renderer, type Texture, type TextureSource } from 'pixi.js';

import type { SceneData, SceneDepthConfig, SceneLightingDef } from '../data/types';
import { LitBackground } from '../rendering/lighting/LitBackground';
import { SceneLightingPass, type SceneLightingGeometry } from '../rendering/lighting/SceneLightingPass';
import { GiBouncePass } from '../rendering/lighting/GiBouncePass';
import type { PackedLights } from '../rendering/lighting/lightPacking';
import { resolveDepthPerSy } from '../utils/worldReconstruct';
import type { AssetManager } from './AssetManager';
import { depthError, depthLog } from './depthLog';
import { sceneBakeDirUrl, sceneRuntimeAssetUrl } from './projectPaths';

const T = 'SceneLighting';

/** `lighting/<背景基名>/geometry.json` 的载荷。由 `tools/character_lighting_lab/scene_fields.py` 产出。 */
export interface LightingGeometryMeta {
  version: number;
  background_sha1: string;
  work: { w: number; h: number };
  native: { w: number; h: number };
  cal: { ppu: number; cx: number; cy: number };
  M: number[][];
  grid: {
    nx: number; ny: number; nz: number;
    x0: number; x1: number; y0: number; y1: number; z0: number; z1: number;
  };
  band: number;
  /**
   * 刻度链。`char_wu` 只反映**取景远近**（角色固定 150 场景坐标高，而
   * worldWidth 逐场景 700–4000），**不是**摆灯的尺度参照——那个看 `backgroundWu`。
   */
  scale: { char_wu: number; scene_per_wu: number };
  depth_range: [number, number];
  /** 烘焙期拟合出的原画遮蔽响应。场景没写 day.hemi 时用它——手填必错。 */
  day_hemi?: number;
  day_hemi_residual_corr?: number;
  /**
   * 烘焙期拟合出的**画内白天大气散射**。不除掉它，远景在夜里会继续发亮，
   * 而"远处一片亮灰"是判定"这是白天"最强的信号之一（实测远/近亮度比 4.32）。
   */
  haze?: {
    k: number;
    strength: number;
    color: [number, number, number];
    depth_min: number;
    depth_max: number;
    residual: number;
  };
  /**
   * 从原画反解出的反射率（去霾后再除 S_day）。角色标定常数的地基。
   *
   * 场景 = `A_scene × S_new`，角色 = `A_char × S_new × radianceScale`。
   * 两边的 `S_new` 是同一个，所以能不能对上只取决于反射率尺度对不对齐。
   */
  albedo?: { albedo_mean: number; albedo_p25: number; albedo_p75: number };
  /**
   * GI 命中图的元信息。缺这一节 = 本场景没烘 `gi_hitmap.bin`，GI 整体不启用
   * （画面只是少一层反弹光，不会崩）。
   */
  gi?: {
    ndir: number;
    dirs: number[][];
    work: { w: number; h: number };
    /** [宽, 高] = [nx*nz, ny*ndir] */
    size: [number, number];
    hit_rate: number;
  };
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

/**
 * 本系统认得的几何场载荷代次。改产物布局必须 +1，并同步
 * `tools/character_lighting_lab/scene_fields.py#PAYLOAD_VERSION` 与 `validator.py`。
 *
 * v2（2026-08-31）：产物从 `lighting2/<图名>/meta.json` 改住
 * `lighting/<图名>/geometry.json`（与 probe 载荷同目录，同一个工具产出），
 * 并新增 `depth_sha1`（深度重导但几何场没重烘 = 静默错，靠它抓）。
 */
/**
 * 几何场载荷代次。**三处必须一致**（这里 / `validator._LIGHTING_GEOMETRY_VERSION` /
 * `scene_fields.PAYLOAD_VERSION`），否则运行时整包忽略。
 *
 * v3（2026-09-01）：新增 `skyao_probe.bin` —— 每格 4 个 f32 的天穹遮蔽矩
 * `(a0, a1x, a1y, a1z)`，角色按**任意法线**求值 `V(N)=clamp((a0+a1·N)/cap0(N),0,1)`，
 * 乘在 GI 上。旧的 `skyvis_grid.bin` 降级为它的派生标量 `T(up)`（按法线求值做不到，
 * 竖直面偏高约 50%），只等旧代码改完就删。
 */
export const LIGHTING_GEOMETRY_VERSION = 3;

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
 * 场景没有 `lighting` 块、或没烘几何场载荷时，本系统**整体不启用**，
 * 背景照旧走原来的 Sprite 路径（旧场景零影响）。
 */
export class SceneLightingSystem {
  private meta: LightingGeometryMeta | null = null;
  private pass: SceneLightingPass | null = null;
  private litBg: LitBackground | null = null;
  private def: SceneLightingDef | null = null;
  private skyvisGrid: Float32Array | null = null;
  private skyvisTex: BufferImageSource | null = null;
  private giHitmapTex: BufferImageSource | null = null;
  private giPass: GiBouncePass | null = null;
  private enabled = false;

  get active(): boolean {
    return this.enabled && this.pass !== null && this.litBg !== null;
  }

  /** 供 SceneManager 挂进背景层的 mesh；未启用时为 null。 */
  get backgroundMesh() {
    return this.litBg?.mesh ?? null;
  }

  /** 角色侧要用的 3D 天穹可见性网格（CPU 侧数据）。 */
  get skyVisibilityGrid(): { data: Float32Array; meta: LightingGeometryMeta } | null {
    return this.skyvisGrid && this.meta ? { data: this.skyvisGrid, meta: this.meta } : null;
  }

  /**
   * 3D 天穹可见性网格的 GPU 纹理。
   *
   * WebGL2 有 sampler3D，但 Pixi v8 的 TextureSource 不给 3D 纹理，
   * 所以按 **Z 切片横向平铺** 成 2D：宽 = nx×nz，高 = ny，列 = `x + z·nx`。
   * 三线性在 shader 里手写（与体素卷那套平铺同思路）。
   *
   * ⚠ 两条：①`scaleMode: 'nearest'` + shader 里 `texelFetch`——硬件线性过滤会跨
   * Z 切片边界把相邻切片混进来（平铺图集的经典坑），插值必须自己算。
   * ②走 `r8unorm` 而不是浮点：与场景那张 `skyvis.png` **同为 8 位**，
   * 于是角色与背景在同一处拿到的遮蔽值逐位相同，不会在接缝上分家。
   */
  get skyVisibilityTexture(): TextureSource | null {
    if (this.skyvisTex) return this.skyvisTex;
    if (!this.skyvisGrid || !this.meta) return null;
    const g = this.meta.grid;
    const w = g.nx * g.nz;
    const h = g.ny;
    const packed = new Uint8Array(w * h);
    for (let z = 0; z < g.nz; z++) {
      for (let y = 0; y < g.ny; y++) {
        for (let x = 0; x < g.nx; x++) {
          // 烘焙侧是 C 序 (nx, ny, nz)
          const v = this.skyvisGrid[(x * g.ny + y) * g.nz + z];
          packed[y * w + (x + z * g.nx)] = Math.max(0, Math.min(255, Math.round(v * 255)));
        }
      }
    }
    this.skyvisTex = new BufferImageSource({
      resource: packed,
      width: w,
      height: h,
      format: 'r8unorm',
      scaleMode: 'nearest',
      alphaMode: 'no-premultiply-alpha',
    });
    return this.skyvisTex;
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

  /**
   * GI 反弹辐照网格。没烘 `gi_hitmap.bin` 的场景返回 null，
   * 角色侧据此把增益压到 0 —— 画面只是少一层反弹光。
   */
  get giBounceTexture(): TextureSource | null {
    return this.giPass?.bounce ?? null;
  }

  /**
   * 装载 GI 命中图并建反弹 pass。缺料一律安静跳过（GI 是加分项，不是必需）。
   *
   * ⚠ 命中图是**几何项**：它记的是"从这个网格点往那个方向看会撞到哪面墙"，
   * 与灯、时刻、天光全无关。所以摆灯、调参、推进时刻都**不用重烘**——
   * 变的只是"撞到的那面墙现在有多亮"，那是 `GiBouncePass` 每次脏时现查的。
   */
  private async loadGiHitmap(sceneId: string, meta: LightingGeometryMeta): Promise<void> {
    const gi = meta.gi;
    const pass = this.pass;
    if (!gi || !pass) return;
    const radiance = pass.radiance;
    if (!radiance) return;
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(`${this.bakeBase}/gi_hitmap.bin`);
      // ⚠ 本仓库 dev server 上文件不存在返回 **200 + HTML**，判据必须看 content-type
      if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return;
      bytes = await res.arrayBuffer();
    } catch {
      return;
    }
    const [w, h] = gi.size;
    const expect = w * h * 4;
    if (bytes.byteLength !== expect) {
      depthError(T, `${sceneId}: gi_hitmap 长度 ${bytes.byteLength} ≠ 声明 ${expect}，GI 不启用`);
      return;
    }
    this.giHitmapTex = new BufferImageSource({
      resource: new Uint8Array(bytes),
      width: w,
      height: h,
      format: 'rgba8unorm',
      scaleMode: 'nearest',
      alphaMode: 'no-premultiply-alpha',
    });
    const g = meta.grid;
    this.giPass = new GiBouncePass(radiance.source, {
      hitmap: this.giHitmapTex,
      gridN: [g.nx, g.ny, g.nz],
      ndir: gi.ndir,
    });
  }

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
    const g = m.grid;
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
   * 角色标定常数。场景显式写了 `radianceScale` 就用它，否则由烘焙期反解的反射率推。
   *
   * ⚠ 这个数**不该手填**，理由与 `day.hemi` 同源：它描述的是这张原画的性质，
   * 不是美术意图。填错的表现是角色系统性偏亮/偏暗，且怎么调灯都对不上
   * ——因为错的是尺度不是光。
   */
  get radianceScale(): number {
    const explicit = this.def?.radianceScale;
    if (explicit !== undefined) return explicit;
    const mean = this.meta?.albedo?.albedo_mean;
    if (mean === undefined || !(mean > 0)) return 1;
    return mean / CHARACTER_ALBEDO_REFERENCE;
  }

  /**
   * 装载一个场景的光影。任何一步缺料都**安静地不启用**（返回 false），不打扰玩家；
   * dev 下留日志便于排查（构建期严于运行时，运行时对内容错误容错跳过）。
   */
  /**
   * 本场景**当前背景**的烘焙产物目录 `lighting/<背景基名>/`（probe 与几何场同住）。
   * 各处按需加载复用它 —— 再解析一遍就是第二个真相源，换背景后可能指向不同目录。
   */
  private bakeBase = '';
  /** 本场景是否参与日夜（灯的时段过滤要吃这道总闸；未装载时为 false）。 */
  private dayNightOn = false;
  /**
   * 当前时段 id 的取用口（由 Game 注入 DayManager）。灯按 `LightDef.phases` 过滤要用它。
   * 未注入 = 空串 = 不过滤，旧行为零变化。
   */
  private phaseGetter: (() => string) | null = null;

  /** 由 Game 注入当前时段（与 SceneManager.setCurrentPhaseGetter 同一个来源）。 */
  setPhaseGetter(fn: (() => string) | null): void { this.phaseGetter = fn; }

  /**
   * 灯的时段过滤该用哪个时段。**没开 `dayNight.enabled` 的场景恒返回空串**（= 不过滤）。
   *
   * 2026-08-30 审查抓到：灯的过滤原本不吃这道总闸，与实体归属（SceneManager.entityInPhase
   * 第一行就是 `dayNight.enabled !== true → return true`）、LightDef.phases 的类型注释、
   * 以及校验器的「配了 phases 但没开日夜 = 不生效」三处口径全对不上 ——
   * 于是同一个 phases 字段在灯上生效、在热点上不生效，作者无从预期。
   */
  private filterPhase(): string {
    if (!this.dayNightOn) return '';
    return this.phaseGetter?.() ?? '';
  }

  async load(
    sceneId: string,
    sceneData: SceneData,
    assetManager: AssetManager,
    paintingTexture: Texture,
  ): Promise<boolean> {
    this.unload();
    // 烘焙产物按**当前生效的第一层背景**索引（2026-08-30「背景与烘焙绑死」）。
    // 2026-08-31 起几何场与 probe 载荷同住 `lighting/<背景基名>/`，由角色照明实验室
    // 一个工具产出；**没有回落布局**——找不到就是没烘，让它明说，别静默拿别人的几何。
    this.bakeBase = sceneBakeDirUrl(
      sceneId, sceneData.backgrounds?.[0]?.image ?? 'background.png');
    this.dayNightOn = sceneData.dayNight?.enabled === true;
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
      `${this.bakeBase}/geometry.json`,
    );
    if (!meta) {
      depthLog(T, `${sceneId}: 没烘几何场（跑 \`sh scripts/py.sh -m `
        + `tools.character_lighting_lab.scene_fields --scene ${sceneId}\`）`);
      return false;
    }
    // ---- 几何场的防腐门（2026-08-30 审查抓到：这一层原本**完全没有**）----
    //
    // lighting/ 那份 probe 载荷一直有 background_sha1 门，lighting2/ 却没有。
    // 配上「按图名找不到就回落扁平」之后，后果是**静默拿白天的几何去照夜的原画**：
    // 法线、天穹可见性、GI 命中图全是白天那张图的，而画面上只表现为"夜里光的走向
    // 不太对"，作者根本无从下手。
    //
    // 与角色侧同口径：**不整份禁用**（烘焙数据可以缺省，缺省不能影响运行），
    // 而是照常装载 + dev 大声报。回落到扁平布局时尤其要报——那份多半是白天的。
    {
      const want = (sceneData.backgrounds?.[0]?.image ?? '').split('/').pop() ?? '';
      const sha = (meta as { background_sha1?: unknown }).background_sha1;
      if (typeof sha === 'string' && sha) {
        try {
          const r = await fetch(sceneRuntimeAssetUrl(sceneId, want));
          const buf = await r.arrayBuffer();
          const dg = await crypto.subtle.digest('SHA-1', buf);
          const hex = Array.from(new Uint8Array(dg))
            .map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
          if (hex !== sha) {
            depthError(T, `${sceneId}: 几何场与当前背景 ${want} 对不上`
              + `(烘焙 ${sha} vs 现况 ${hex})`
              + '。法线/天穹可见性属于另一张图，光的走向会不对。'
              + `请重烘：\`sh scripts/py.sh -m `
              + `tools.character_lighting_lab.scene_fields --scene ${sceneId}\``);
          }
        } catch (e) {
          depthError(T, `${sceneId}: 几何场哈希门跑不起来`, e);
        }
      }
    }
    if (meta.version !== LIGHTING_GEOMETRY_VERSION) {
      depthError(T, `${sceneId}: 几何场载荷版本 ${meta.version} ≠ ${LIGHTING_GEOMETRY_VERSION}，整包忽略`
        + '（2026-08-31 起产物改住 lighting/<背景基名>/，跑 `python tools/migrate_lighting_payloads.py` 迁移）');
      return false;
    }

    let normal: Texture;
    let skyvis: Texture;
    try {
      normal = await assetManager.loadTexture(`${this.bakeBase}/normal.png`);
      skyvis = await assetManager.loadTexture(`${this.bakeBase}/skyvis.png`);
    } catch (e) {
      depthError(T, `${sceneId}: 几何场贴图装载失败`, e);
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

    const geo: SceneLightingGeometry = {
      normal,
      skyvis,
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

    this.meta = meta;
    this.def = def;
    this.pass = new SceneLightingPass(paintingTexture, geo);
    this.pass.applyParams(def, meta.day_hemi, this.filterPhase());
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

    // ⛔ **3D 天穹可见性网格与 GI 命中图不再装载**（2026-08-31 制作人拍板）。
    //
    // 这两份载荷的唯一消费者是统一角色路径（`Game.UNIFIED_CHAR_PATH_ENABLED`），
    // 那条路 2026-08-30 起整条关死。继续装载的代价是实打实的：每次进场景多两次
    // fetch（gi_hitmap 单场景 240 KB），而 `GiBouncePass` 还会在**每次脏时**
    // （推时刻 / 开关灯 / F2 调参）跑 3840 点 × 16 方向 = 61440 次纹理取样，
    // 算出一张没有任何人读的反弹网格。
    //
    // 烘焙侧**照旧产出**这两个文件（重烘 28 个场景很贵，将来复活那条路要用），
    // 只是运行时不读、打包不抽取。复活时把这一段还原即可：
    // `skyvisGrid` ← skyvis_grid.bin、`loadGiHitmap()` ← gi_hitmap.bin，
    // 两者的解析代码都原样留着（见 `loadGiHitmap` 与 `skyVisibilityTexture`）。
    this.skyvisGrid = null;

    this.enabled = true;
    depthLog(T, `${sceneId}: 场景光照已启用（角色高 ${meta.scale.char_wu.toFixed(3)} wu）`);
    return true;
  }

  /**
   * 改了光照参数：写进 uniform 并标脏。下一帧 update 时重算缓存。
   *
   * ⚠ **这是低层的一半，只管场景**。灯还要推给角色侧（`CharacterLightingSystem.applyLights`
   * 吃的是**同一份** `packedLights`，「一视同仁」靠的就是这个），所以外部一律走
   * `Game.applySceneLightingParams` —— 它是唯一同时推两边的口。
   *
   * 直接调这个的后果不是报错，是**两边悄悄不同步**：场景的灯灭了、角色身上还亮着。
   * 2026-08-30 我在 devtools 里就是从这个口做 A/B，得出「灯灭了角色还是白的 ⇒
   * 不是灯的锅」这个**完全错误**的结论，绕了一大圈。取证也要走正式入口。
   */
  applyParams(def: SceneLightingDef): void {
    this.def = def;
    this.pass?.applyParams(def, this.meta?.day_hemi, this.filterPhase());
    this.pass?.markDirty();
    this.litBg?.applyParams(def);
  }

  get params(): SceneLightingDef | null {
    return this.def;
  }

  /** 调试可视化：0=正常 1=天穹可见性 2=法线 3=S_day 4=S_new 5=比值 6=线性化原画 7=GI体。 */
  setDebug(mode: number): void {
    this.pass?.setDebug(mode);
  }

  /** 诊断·定法线转发(GI体档,F2 诊断组)。 */
  setGiFixedN(n: number): void {
    this.pass?.setGiFixedN(n);
  }

  /** 「GI体」视图(7/8/9)的 probe 资源转发;null = 退回占位。见 SceneLightingPass.setProbeResources。 */
  setProbeResources(res: Parameters<SceneLightingPass['setProbeResources']>[0]): void {
    this.pass?.setProbeResources(res);
    // 喂完必须重算:视图开着时改 β/mode(F2 滑块)走的就是这条,不脏 RT 就冻着旧画面
    this.pass?.markDirty();
  }

  /** 逐帧调。脏才重算，稳态零成本。返回是否真的重算了（供性能观测）。 */
  update(renderer: Renderer): boolean {
    const recomputed = this.pass?.update(renderer) ?? false;
    // ⚠ 顺序即正确性：GI 读的是**这一次**重算出来的辐射场，必须排在它之后。
    //   反过来会让反弹光永远落后一次改动——F2 拖滑杆时表现为"角色慢半拍"。
    if (recomputed) this.giPass?.render(renderer);
    return recomputed;
  }

  unload(): void {
    // ⚠ Pixi 坑②：先拆显示端再销毁它引用的 RT，顺序反了会把 shader 的 BindGroup 永久烧毁
    this.litBg?.destroy();
    this.litBg = null;
    this.pass?.destroy();
    this.pass = null;
    this.meta = null;
    this.def = null;
    // 跨场景残留会让新场景吃到旧场景的口径：bakeBase 会让按需加载去拉上一个场景的
    // 目录，dayNightOn 会让没开日夜的场景照旧过滤灯（=某些灯莫名不亮）。
    this.bakeBase = '';
    this.dayNightOn = false;
    this.skyvisGrid = null;
    this.giPass?.destroy();
    this.giPass = null;
    this.giHitmapTex?.destroy();
    this.giHitmapTex = null;
    this.skyvisTex?.destroy();
    this.skyvisTex = null;
    this.enabled = false;
  }
}
