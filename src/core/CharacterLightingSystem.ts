import { BufferImageSource, type Shader, type TextureSource, type UniformGroup } from 'pixi.js';
import type { IGameSystem, GameContext, SceneLightingDef } from '../data/types';
import { sceneBakeDirUrl, sceneRuntimeAssetUrl } from './projectPaths';
import { depthLog, depthError } from './depthLog';
import {
  fetchPayloadBlob, fetchPayloadBytes, probeAtlasFileForMode, probeModeOf,
} from './lightingPayloadFiles';
import { sampleGroundField, type GroundDepthField } from '../utils/groundDepthField';
import type {
  CharShadingParams,
  CharShadingSceneResources,
  CharacterShadingFilter,
} from '../rendering/CharacterShadingFilter';
import {
  createFrameLitUniforms,
  applyCharDisplay,
  applyCharLights,
  createCharLightUniforms,
  createLitShader,
  createSceneLitUniforms,
  LIT_SHADER_SCENE_TEXTURE_SLOTS,
  setLitShaderTexture,
} from '../rendering/CharacterLitSprite';
import type { PackedLights } from '../rendering/lighting/lightPacking';

const T = 'CharLighting';

/** f16(u16 位型)→ f32 单值解码(probe 点云可视化用,量小走标量) */
function f16(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 5.960464477539063e-8;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * Math.pow(2, e - 15);
}

/** probe 点云可视化数据(F2 调试;坐标已换算到场景世界系) */
export interface ProbeVizPoint {
  x: number;
  y: number;
  color: number;   // 0xRRGGBB,取 L2 base 首系数,实验室点云同配方
  valid: boolean;
}


/** 每场景照明烘焙载荷 v2(character_lighting_lab 导出的 lighting/ 目录)。 */
interface LightingPayloadMeta {
  version: number;
  background_sha1: string;
  work: { w: number; h: number };
  cal: { theta: number; ppu: number; cx: number; cy: number };
  world: { M: number[][]; x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
  probes: { nx: number; ny: number; nz: number; sh_lmax?: number; sh_k?: number; bin_ob?: number };
  vol: {
    nx: number; ny: number; nz: number; tiles_x: number; tiles_y: number;
    qx_min: number; qx_max: number; qy_min: number; qy_max: number;
    qz_min: number; qz_max: number;
  };
  ambient_sh: number[];
  lights: Array<{
    pos: [number, number, number];
    radiance: [number, number, number];
    area: number;
  }>;
  ground_d: { min: number; max: number };
  /** 非 bake 着色参数=场景配置(实验室导出照明时的面板值);F2 只是运行时测试覆盖。
   *  刻意不含 pgain:预览亮度是实验室显示设施,永不出实验室。 */
  shading?: {
    mode: number; spp: number; step: number; msteps: number;
    fold: number; miss_mode: number; nee: number;
    beta: number; amb: number;
    bulge: number; flatten: number;
  };
}

/** 逐帧驱动所需的实体信息(Game 从 SpriteEntity / 容器读出后传入)。 */
export interface CharShadingEntityInfo {
  /** 实体显示尺寸(场景世界单位) */
  worldW: number;
  worldH: number;
  /** 左右镜像(container.scale.x < 0) */
  flipX: boolean;
  /** 法线图集内当前帧 uv rect(x,y,w,h;归一化);null = 平面法线回退 */
  nrmRect: [number, number, number, number] | null;
  /**
   * 当前帧所属**源图集** URL(法线图按 `<图集名>.normal.png` 寻址)。
   *
   * ⚠ 必须逐帧带上:实体会在运行时换图集(玩家有常态/背尸/道士多套,NPC 可经
   * setEntityField 重载动画)。而法线纹理原来只在 scene:ready 附加滤镜时绑定一次 ——
   * 换图集后,**新图集的 uNrmRect 坐标被拿去查旧图集的法线图**,采到毫不相干的区域:
   * 角色变暗、随动画帧闪烁、且看不出规律。绑定必须跟着当前图集走。
   */
  sheetUrl?: string | null;
  /**
   * sprite 在**被滤镜对象包围盒**里占的归一化矩形 [x,y,w,h]。
   * 容器里若还有名字标签等兄弟节点,包围盒会比 sprite 大(实测 NPC 高出 26px)。
   * 不传 = [0,0,1,1](容器就是 sprite,玩家即此情形)—— 缺省即正确,属优雅降级。
   */
  spriteRect?: [number, number, number, number];
}

/**
 * 角色照明系统 v2:实验室 CHAR_FS 着色的运行时消费端。
 *
 * 职责边界(2026-07-22 拍板):对齐预览(实验室查看器)与运行时——
 * 载入 v2 全量载荷(probe 三基图集四分账 + 体素卷平铺图集 + valid + ground_d),
 * 建 GPU 纹理,供 CharacterShadingFilter 逐像素 albedo×E 着色;本系统不再有
 * 任何自创亮度模型(旧 tint 归一化/clamp 已删)。**无载荷**的场景回落旧管线
 * (光环境曲线保留);**哈希失配**的场景自 2026-08-30 起不再整份禁用,改为分级降级
 * (几何项照用、光照项标 stale + dev 大声报,见 loadScene)。
 * 所有照明参数 F2 运行时可调,不入存档。
 *
 * 2026-08-30「原画 + 加性灯」模型下,本系统给角色的 E 是**probe 烘焙的 GI 底光**,
 * 场景实体灯由 applyLights 加性叠加(与场景吃同一次 packLights)。
 */
export class CharacterLightingSystem implements IGameSystem {
  private epoch = 0;
  private _hasVolumes = false;
  private meta: LightingPayloadMeta | null = null;
  private groundD: Float32Array | null = null;
  /** 行走面深度场的 GPU 版(RG16 原图)。影子/背景调试要逐像素取地面,CPU 数组喂不了 shader */
  private groundTex: TextureSource | null = null;
  private resources: CharShadingSceneResources | null = null;
  private ownedTextures: TextureSource[] = [];
  /**
   * 体素卷纹理(占位 1×1 或真卷),与 ownedTextures 分开管:它可在场景生命周期**中途**
   * 被 ensureVolumes/releaseVolumes 换掉,不能跟着载荷整体销毁的那批走。
   */
  private volTextures: TextureSource[] = [];
  /** 已换下、等调用方重挂滤镜后再销毁的旧体素卷(先销毁会烧毁仍绑着它的滤镜) */
  private staleVolTextures: TextureSource[] = [];
  /** 当前载荷所属场景 id;ensureVolumes 按它拼 URL,也用于跨场景丢弃 */
  private loadedSceneId: string | null = null;
  /**
   * 本次载荷**实际命中**的烘焙目录（按背景图名索引的新布局，或迁移期回落的扁平布局）。
   * 体素卷/probe 图集的按需加载复用它 —— 各自再解析一遍就是第二个真相源。
   */
  private loadedBakeBase: string | null = null;
  /** 在途的体素卷拉取(去重并发调用);epoch 变化即作废 */
  private volInflight: Promise<boolean> | null = null;
  /**
   * probe 图集纹理(当前 mode 的真图 + 另两种 1×1 占位),与 ownedTextures 分开管:
   * 进场景只加载当前 mode 那一种,F2 切档由 ensureProbeAtlas 换,可中途整批换掉。
   */
  private probeTextures: TextureSource[] = [];
  private staleProbeTextures: TextureSource[] = [];
  /** 当前已加载真图的 cache mode(1/2/3);0=未加载。ensureProbeAtlas 按它去重。 */
  private loadedProbeMode = 0;
  private probeInflight: Promise<boolean> | null = null;
  private probeViz: ProbeVizPoint[] | null = null;

  /**
   * E 色度权重(F2 测试旋钮,不入存档):0=只借场景明暗(luma)、角色保留自己颜色不被场景色染;
   * 1=完整彩色 E。sprite 本身是着色后的 color(自带颜色),缺的是场景明暗——默认只借明暗。
   */
  eChroma = 0;
  /** 「GI体·纯E」调试(F2 的 8/9/10 档):角色 albedo≡1 输出 E×2^β,与场景侧同式。
   *  取证扩展:直接给数字 2/3/4 走 shader 的取证子档(raw probeE/gridT染色/valid角数)。 */
  eOnlyDebug: boolean | number = false;
  /** 诊断·定法线(F2 GI体档诊断组):0=正常 1=强制世界水平 2=强制世界向上,只改查表方向。 */
  giDiagFixedN = 0;
  /** 诊断:棋盘档(9)时角色也画 probe cell 棋盘。 */
  eCheckerDebug = false;

  // ---------------------------------------------------------------- mesh 着色(2026-07-25)
  // sprite 网格着色的共享 uniform 组与活 shader 注册表。frameLit 跨场景常驻、每帧同步一次
  // (syncFrame,由 Pixi ticker 驱动 —— **不经任何游戏状态分支**,Cutscene 里也照跑);
  // sceneLit 每场景重建。litShaders 用于体素卷/probe 图集热替换时就地重绑纹理。
  private readonly frameLit: UniformGroup = createFrameLitUniforms();
  /**
   * skyao 与全白的 blend 系数(制作人 2026-09-01:「加一个 blend 系数」)。
   * 0 = 完全不遮蔽(全白) 1 = 完整天穹遮蔽。乘在 GI 上,不影响太阳与实体灯。
   * ⚠ 逐帧同步进 frameLit,**不经任何游戏状态分支** —— filter 路径那次
   *   「Cutscene 态整段驱动被跳过 ⇒ uniform 冻在默认值」的事故面在这里不存在。
   */
  private skyaoBlend = 1;
  /** 调试:1=法线 2=skyao V 3=c01 4=原始矩 5=色带;null=听参数的。 */
  private showNOverride: number | null = null;
  private sceneLit: UniformGroup | null = null;
  /**
   * 场景实体灯（角色侧）。跨场景常驻:灯是**逐场景数据**没错,但这一组是就地改数组、
   * 不重建,所以不随 sceneLit 一起置 null——换场景由 applyLights 覆盖或清零。
   */
  private readonly charLights: UniformGroup = createCharLightUniforms();
  /** 最后一次收到的实体灯打包;等 shadowBasis 到位后重放(两者到达顺序不保证)。 */
  private pendingLights: PackedLights | null = null;
  /**
   * 当前载荷的背景哈希是否已失配(背景重画了但没重烘)。
   *
   * true 时几何项仍在用、光照项(probe/体素)是旧画面的光。**不影响运行**,
   * 只用于 dev 面板显式标注 —— 见 loadScene 的分级降级注释。
   */
  private payloadStale = false;
  /** 载荷是否过期(F2/调试面板读它标注"这个场景的角色光是旧的")。 */
  get isPayloadStale(): boolean { return this.payloadStale; }
  private readonly litShaders = new Set<Shader>();
  private groundRange: [number, number] = [0, 1];
  private aoContact = 0;
  private aoForm = 0;

  /** F2 可调照明参数(运行时,不入存档;默认值与实验室查看器一致,模式默认 L2) */
  readonly params: CharShadingParams = {
    mode: 3, spp: 64, step: 0.9, msteps: 160,   // 3=八面体(2026-09-02 正式档) 1=L1 Geomerics 2=SH 线性
    fold: true, missMode: false, nee: false,
    beta: 0, ambStrength: 1, giStrength: 1,
    bulge: 0.22, flatten: 0, heightScale: 1, showNormals: false,
    sunEnabled: false, sunAzimuthDeg: 315, sunElevationDeg: 40,
    sunIntensity: 0.4, sunColor: [1.0, 0.93, 0.82],
  };
  /** 总开关(关= Game 重挂旧滤镜回落曲线管线) */
  enabled = true;

  /**
   * 全局阴影表现（F2 可调，运行时，不入存档）。
   *
   * 2026-08-20 制作人否决自动 resolve 后，这里只剩**表现总控**：
   * 影子往哪儿投、有多浓，由实体自己的绑定决定（见 `rendering/entityShadowBinding.ts`）；
   * 这两个数只是最后乘上去的全局调制，用于「整场影子统一淡一点/换个颜色」。
   */
  readonly shadowStyle = {
    /** 全局阴影强度调制。暗场景里 alpha 摊在黑地上不可见，需要一个总控把它提起来。 */
    gain: 1.4,
    /** 全局阴影颜色(RGB 0..1);默认纯黑最可见,可染色 */
    color: [0, 0, 0] as [number, number, number],
  };
  /**
   * 游戏 depthConfig 基（行主 r00..r22，q→M-world）。
   *
   * ⚠ 必须是 **det=+1** 的游戏约定矩阵。阴影绑定要用它把光的世界方向投回屏幕，
   * 混进实验室那份 det=−1 的会让 Z 轴整体翻号、影子前后颠倒。
   */
  private shadowBasis: Float32Array | null = null;
  /** 当前 mode 固化 probe 图集的 CPU 拷贝(点云可视化用,(P,probeAtlasCol,4) f16;按需加载会随切档更新) */
  private probeAtlasU16: Uint16Array | null = null;
  /** probeAtlasU16 的列数(=当前 mode 系数数:L1=4 / L2=9 / BIN=64) */
  private probeAtlasCol = 9;
  /** probe valid CPU 拷贝 */
  private validU8: Uint8Array | null = null;

  private sceneWorldW = 0;
  private sceneWorldH = 0;
  /** 载荷就绪回调(Game 组装层注入:重挂实体滤镜) */
  onReady: (() => void) | null = null;

  init(_ctx: GameContext): void { /* 无跨系统依赖 */ }
  update(_dt: number): void { /* 驱动按需(Game 逐实体调用),无逐帧内部状态 */ }
  serialize(): object { return {}; }
  deserialize(_data: object): void { /* F2 参数为调试态,不入存档 */ }

  destroy(): void {
    this.epoch++;
    this.meta = null;
    this.groundD = null;
    this.groundTex = null;
    this.resources = null;
    this.probeViz = null;
    this.probeAtlasU16 = null;
    this.probeAtlasCol = 9;
    this.validU8 = null;
    this.shadowBasis = null;
    this._hasVolumes = false;
    this.volInflight = null;
    this.loadedSceneId = null;
    // 生命周期对称（运行时不变量 5）：destroy 后再 init 行为必须与首次一致。
    // 漏了这三个 → 重启后新场景会吃到旧场景的烘焙目录、旧的灯、以及一个假的 stale 标记。
    this.loadedBakeBase = null;
    this.pendingLights = null;
    this.payloadStale = false;
    this.parkLitShaders();
    for (const t of this.ownedTextures) t.destroy();
    this.ownedTextures = [];
    for (const t of this.volTextures) t.destroy();
    this.volTextures = [];
    this.disposeStaleVolumeTextures();
    for (const t of this.probeTextures) t.destroy();
    this.probeTextures = [];
    this.disposeStaleProbeTextures();
    this.loadedProbeMode = 0;
    this.probeInflight = null;
  }

  /** probe 点云(F2 调试可视化);无载荷 → null */
  getProbeViz(): ProbeVizPoint[] | null { return this.probeViz; }

  /** Game 在场景 ready 时注入深度基(ShadowSceneContext r00..r22);null=清除 */
  setShadowBasis(r: number[] | null): void {
    this.shadowBasis = r ? new Float32Array(r) : null;
    // 基与灯的到达顺序不保证(灯来自 lightingLoader,基来自 rebuildEntityShadows)。
    // 缓存住最后一次的灯,基一到就重放 —— 不赌顺序,少一次就是"灯照场景不照人"。
    //
    // ⚠ 重放**必须带上已存的 lightWuPerQUnit**。曾经写成 `applyLights(this.pendingLights)`,
    //   第二参缺省 1 把首次调用存好的尺度(雾津街头 880)踩掉 ⇒ shader 里
    //   `P = R·q × 1`,人的坐标缩在 q 尺度(±2)而灯位在 wu 尺度(±几百),
    //   **每一盏带距离的灯(point/spot/area)对角色永远差 wuPerQUnit 倍距离** ——
    //   自「原画 + 加性灯」落地起角色就没吃到过一盏点光,而 directional 不用距离、
    //   probe 底光不经这条路,所以画面"看着都在工作",日志照打"N 盏已喂给 probe 着色"。
    //   同族教训见 lighting-scale-reference 已知坑③:尺度错不报错,只是全灭。
    if (this.pendingLights) this.applyLights(this.pendingLights, this.lightWuPerQUnit);
  }

  /**
   * 阴影绑定解算要用的 q→world 基。没有深度场的场景返回 null，那种场景不投影。
   *
   * ⚠ 只读，不复制——热路径逐实体逐帧调。调用方不许改内容。
   */
  get shadowBasisRows(): Float32Array | null {
    return this.shadowBasis;
  }

  /**
   * 把场景实体灯喂给角色着色（2026-08-30「原画 + 加性灯」模型）。
   *
   * `packed` 必须是 `SceneLightingPass` 用的**同一次** `packLights` 结果——角色与场景
   * 吃同一份数据，「灯对角色和场景一视同仁」才是构造性的。传 null = 本场景没有实体灯
   * （角色只剩 probe 的 GI 底光，与改动前逐像素一致）。
   *
   * q→M-world 的三行直接复用 `shadowBasis`：它本来就是 depthConfig 的 **det=+1** 基，
   * 与着色要的是同一个（两个 M 不许混，见 coordinate-spaces 铁律 3）。基还没注入时
   * 当作没有灯——宁可少一层光，也不要拿错矩阵把灯打到镜像位置去。
   */
  /** 场景显示变换 → 角色(与背景同一组数)。def 为空 = 恒等,旧行为零变化。 */
  applyDisplay(display: SceneLightingDef['display'] | null): void {
    applyCharDisplay(this.charLights, display);
  }

  /**
   * 打包这批灯时用的 `wuPerQUnit`（铁律 0：灯位与 P 都要是 wu，两者才能相减）。
   * 由 `applyLights` 的调用方随灯一起给 —— 它与 `SceneLightingSystem.wuPerQUnit`
   * 必须是同一个数，否则角色的 P 与灯位差一个场景相关的比例，灯会打到天边去。
   */
  private lightWuPerQUnit = 1;

  applyLights(packed: PackedLights | null, wuPerQUnit = 1): void {
    this.pendingLights = packed;
    this.lightWuPerQUnit = wuPerQUnit > 0 ? wuPerQUnit : 1;
    const b = this.shadowBasis;
    if (!packed || !b || b.length < 9) {
      // 基还没到 = **进场景时的正常暂态**（灯来自 lightingLoader，基来自随后的
      // rebuildEntityShadows）。不报错：setShadowBasis 会拿 pendingLights 重放一次。
      // 真正的失败是"重放也没来"，那种情况下面这行不会有后继的 ok 日志，dev 一眼可辨。
      if (packed && packed.count > 0) {
        depthLog(T, `角色实体灯暂缓：${packed.count} 盏已打包，等 depthConfig 基注入后重放`);
      }
      applyCharLights(this.charLights, null, null);
      return;
    }
    depthLog(T, `角色实体灯：${packed.count} 盏已喂给 probe 着色`);
    applyCharLights(this.charLights, packed, [
      [b[0], b[1], b[2]], [b[3], b[4], b[5]], [b[6], b[7], b[8]],
    ], this.lightWuPerQUnit);
  }

  /**
   * 实体**胸口**参考点的伪世界 q。阴影绑定拿它算「灯在哪个方向」。
   *
   * 为什么取胸口不取脚点：脚点贴着地面，与灯的方向关系会被地面高差放大
   * （角色站在台阶上时影子方向会跳）。胸口与着色的采样带一致。
   *
   * ⚠ 脚深度走 `sampleGroundField`，与 `driveFilter` / `SceneDepthSystem` **同一个采样器**。
   * 遮挡、阴影、着色三处一旦用上不同的地面值就会互相打架，且画面上只表现为"差一点"。
   */
  chestQAt(worldX: number, worldY: number, worldH: number): [number, number, number] | null {
    const m = this.meta;
    const g = this.groundD;
    if (!m || !g) return null;
    const W = m.work.w;
    const H = m.work.h;
    const sx = (worldX / Math.max(this.sceneWorldW, 1e-6)) * W;
    const sy = (worldY / Math.max(this.sceneWorldH, 1e-6)) * H;
    const d = sampleGroundField(g, W, H, sx, sy);
    const cosT = Math.cos(m.cal.theta);
    const sinT = Math.sin(m.cal.theta);
    const hWu = this.heightQ(worldH) ?? 0;
    return [
      (sx - m.cal.cx) / m.cal.ppu,
      (m.cal.cy - sy) / m.cal.ppu + 0.5 * hWu * cosT,
      d - 0.5 * hWu * sinT,
    ];
  }

  /**
   * 实体高度(场景世界 px)→ **伪世界 q**。`chestQAt` 抬胸口用的就是它,一处表达式。
   *
   * 影子绑定要拿它算"灯离头顶多近"(`spread`):那是个比值,分子分母必须同尺——
   * 给 wu 会差一个 `wuPerQUnit`(雾津街头 880),不报错,只是影子恒不散开。
   */
  heightQ(worldH: number): number | null {
    const m = this.meta;
    if (!m) return null;
    const cosT = Math.cos(m.cal.theta);
    return (worldH * (m.work.h / Math.max(this.sceneWorldH, 1e-6))) / Math.max(cosT * m.cal.ppu, 1e-6);
  }

  get active(): boolean { return this.enabled && this.resources !== null; }
  /** 场景静态资源(滤镜创建用);无载荷 → null */
  get shadingResources(): CharShadingSceneResources | null {
    return this.enabled ? this.resources : null;
  }
  get loadedInfo(): { probes: number; lights: number } | null {
    if (!this.meta) return null;
    const p = this.meta.probes;
    return { probes: p.nx * p.ny * p.nz, lights: this.meta.lights.length };
  }
  /** RT gather 体素卷是否已载(仅 dev);false 时 RT 模式(0)会采空卷 → F2 应禁选 RT。 */
  get hasVolumes(): boolean { return this._hasVolumes; }

  /** 体素卷纹理工厂;产物登记在 volTextures(可中途整批换掉),不进 ownedTextures。 */
  private makeVolumeTexture(buf: ArrayBuffer, w: number, h: number): TextureSource {
    const tex = new BufferImageSource({
      resource: new Uint16Array(buf), width: w, height: h,
      format: 'rgba16float', scaleMode: 'nearest',
      alphaMode: 'no-premultiply-alpha',
    });
    this.volTextures.push(tex);
    return tex;
  }

  /**
   * 把 resources 上的体素卷换成给定两张。**旧纹理只移入待销毁队列,不当场销毁**——
   * 活着的角色滤镜仍绑着它们,调用方必须先重挂滤镜、再 `disposeStaleVolumeTextures()`。
   */
  private swapVolumeTextures(radBuf: ArrayBuffer, emitBuf: ArrayBuffer, w: number, h: number): void {
    this.staleVolTextures.push(...this.volTextures);
    this.volTextures = [];
    const rad = this.makeVolumeTexture(radBuf, w, h);
    const emit = this.makeVolumeTexture(emitBuf, w, h);
    if (this.resources) {
      this.resources.volRad = rad;
      this.resources.volEmit = emit;
    }
    this.rebindLitSceneTextures();   // 同上:体素卷热替换直达 mesh shader
  }

  /**
   * 销毁上一批体素卷纹理,释放显存。**只能在调用方重挂完角色滤镜之后调**:
   * Pixi v8 的 BindGroup 一旦发现所绑资源已 destroyed 就把自己作废(resources=null),
   * 之后读 filter.resources 直接抛——先销毁不是泄漏,是把那些滤镜永久烧毁。
   * (根因见 agent_docs/_meta/inbox/2026-07-23-pixi-bindgroup-self-destruct-on-texture-destroy.md)
   */
  disposeStaleVolumeTextures(): void {
    for (const t of this.staleVolTextures) t.destroy();
    this.staleVolTextures = [];
  }

  /**
   * 按需拉 RT-gather 体素卷(vol_rad/vol_emit,20–27MB)。仅 F2 开 RT 时调用。
   * 已载 → 直接 true;在途 → 复用同一个 Promise(去重并发点击)。
   * 返回后调用方必须重挂角色滤镜——滤镜在构造时捕获纹理,换卷不会自动生效。
   */
  async ensureVolumes(): Promise<boolean> {
    if (this._hasVolumes) return true;
    if (this.volInflight) return this.volInflight;
    const meta = this.meta;
    const sceneId = this.loadedSceneId;
    if (!meta || !sceneId || !this.resources) return false;

    const myEpoch = this.epoch;
    // 复用 load() 解析好的烘焙目录（按背景图名索引，或迁移期回落的扁平布局）——
    // 这里再解析一遍就会有第二个真相源，换背景后两处可能指向不同目录。
    const base = this.loadedBakeBase ?? sceneRuntimeAssetUrl(sceneId, 'lighting');
    const V = meta.vol;
    const task = (async (): Promise<boolean> => {
      try {
        const [rad, emit] = await Promise.all([
          fetchPayloadBytes(`${base}/vol_rad.bin`),
          fetchPayloadBytes(`${base}/vol_emit.bin`),
        ]);
        // 旧时间线不写新状态:拉取期间切了场景/重载了载荷 → 整批丢弃
        if (myEpoch !== this.epoch) return false;
        this.swapVolumeTextures(rad, emit, V.tiles_x * V.nx, V.tiles_y * V.ny);
        this._hasVolumes = true;
        depthLog(T, sceneId, `: RT 体素卷已载 (${((rad.byteLength + emit.byteLength) / 1048576).toFixed(1)}MB)`);
        return true;
      } catch (e) {
        depthError(T, 'volume load failed', e);
        return false;
      } finally {
        if (myEpoch === this.epoch) this.volInflight = null;
      }
    })();
    this.volInflight = task;
    return task;
  }

  /**
   * 卸掉体素卷、换回 1×1 占位并释放显存;mode 若停在 RT 则抬回 cache(L2),
   * 否则会采空卷得黑。同样需要调用方重挂滤镜。
   */
  releaseVolumes(): void {
    this.volInflight = null;
    if (!this._hasVolumes) return;
    this.swapVolumeTextures(new Uint16Array(4).buffer, new Uint16Array(4).buffer, 1, 1);
    this._hasVolumes = false;
    if (this.params.mode < 1) this.params.mode = 3;
    depthLog(T, this.loadedSceneId ?? '?', ': RT 体素卷已卸');
  }

  /**
   * cache mode → probe 图集规格(v3 固化:L1=4列 / SH=shK 列(L2=9/L4=25) / BIN=binOb² 方向)。
   * 文件名一律查 `lightingPayloadFiles.ts` 的表——打包清单按同一张表抽取,别在这里写死。
   */
  private static probeCfg(mode: number, shK = 9, binOb = 8): { col: number; file: string } {
    const file = probeAtlasFileForMode(mode);
    if (mode === 1) return { col: 4, file };
    if (mode === 2) return { col: shK, file };          // 'l2' 是槽名,列数按 probes.sh_k
    return { col: binOb * binOb, file };                // 3 及缺省 = 八面体(正式档)
  }

  /** 载荷的球谐系数数:老载荷没记 sh_k 就是 9(L2)。 */
  private static shKOf(meta: { probes: { sh_k?: number } } | null | undefined): number {
    return meta?.probes.sh_k ?? 9;
  }

  /** 载荷的八面体边长:老载荷没记 bin_ob 就是 8。 */
  private static binObOf(meta: { probes: { bin_ob?: number } } | null | undefined): number {
    return meta?.probes.bin_ob ?? 8;
  }

  /**
   * probe 平铺布局:P 颗 probe 摆成 T 颗/行 x H 行(图集每颗占 ncol 个 texel,valid 占 1)。
   * 老布局「1 颗 1 行」在 P=11.9 万时高度直接超 GPU MAX_TEXTURE_SIZE(16384),
   * Pixi **不报错**,采样静默全黑 —— 盘上 E 明明正常,实机角色漆黑(2026-09-01)。
   * T 取 4 的倍数:valid 是 r8unorm,行字节数不 4 对齐会踩 UNPACK_ALIGNMENT。
   * GLSL 侧的同一套映射见 CharacterShadingFilter 的 probeTexel。
   */
  static probeTiling(rows: number): { T: number; H: number } {
    const T = Math.max(4, Math.ceil(Math.ceil(rows / 8192) / 4) * 4);
    return { T, H: Math.max(1, Math.ceil(rows / T)) };
  }

  /** probe 图集纹理工厂;登记在 probeTextures(可中途整批换掉),不进 ownedTextures。 */
  private makeProbeTexture(buf: ArrayBuffer, col: number, rows: number): TextureSource {
    const { T, H } = CharacterLightingSystem.probeTiling(rows);
    let data = new Uint16Array(buf);
    const need = T * H * col * 4;
    if (data.length < need) {          // 行尾补齐的哑 probe,shader 永远不索引到
      const padded = new Uint16Array(need);
      padded.set(data);
      data = padded;
    }
    const tex = new BufferImageSource({
      resource: data, width: T * col, height: H,
      format: 'rgba16float', scaleMode: 'nearest',
      alphaMode: 'no-premultiply-alpha',
    });
    this.probeTextures.push(tex);
    return tex;
  }

  /**
   * 把 resources 上的三张 probe 图集换成「mode 真图 + 另两种 1×1 占位」。
   * shader 按 mode 采样,只采当前 mode 那张,占位不被采。**旧纹理只移入待销毁队列**——
   * 活着的滤镜仍绑着,调用方须先重挂滤镜、再 disposeStaleProbeTextures()(同体素卷)。
   */
  private swapProbeAtlas(mode: number, buf: ArrayBuffer, rows: number): void {
    if (!this.resources) return;
    this.staleProbeTextures.push(...this.probeTextures);
    this.probeTextures = [];
    const cfg = CharacterLightingSystem.probeCfg(mode, CharacterLightingSystem.shKOf(this.meta),
                                                 CharacterLightingSystem.binObOf(this.meta));
    const real = this.makeProbeTexture(buf, cfg.col, rows);
    const ph = (): TextureSource => this.makeProbeTexture(new Uint16Array(4).buffer, 1, 1);
    this.resources.atlasL1 = mode === 1 ? real : ph();
    this.resources.atlasL2 = mode === 2 ? real : ph();
    this.resources.atlasBin = mode === 3 ? real : ph();
    this.loadedProbeMode = mode;
    // CPU 侧能流采样(影子跟灯)跟随切档到的 mode;点云 viz 颜色仍是首载值(仅调试着色,不重算)
    this.probeAtlasU16 = new Uint16Array(buf);
    this.probeAtlasCol = cfg.col;
    this.rebindLitSceneTextures();   // mesh shader 就地跟随新图集(filter 靠重挂,mesh 靠这)
  }

  disposeStaleProbeTextures(): void {
    for (const t of this.staleProbeTextures) t.destroy();
    this.staleProbeTextures = [];
  }

  /**
   * 按需加载指定 cache mode 的 probe 图集(进场景只载当前 mode,F2 切档才拉别的)。
   * 已载 → true;在途 → 复用同一 Promise。返回后调用方必须重挂滤镜(滤镜捕获纹理)。
   */
  async ensureProbeAtlas(mode: number): Promise<boolean> {
    const m = mode === 1 || mode === 3 ? mode : 2;
    if (this.loadedProbeMode === m) return true;
    if (this.probeInflight) return this.probeInflight;
    const meta = this.meta;
    const sceneId = this.loadedSceneId;
    if (!meta || !sceneId || !this.resources) return false;
    const myEpoch = this.epoch;
    const base = this.loadedBakeBase ?? sceneRuntimeAssetUrl(sceneId, 'lighting');
    const rows = meta.probes.nx * meta.probes.ny * meta.probes.nz;
    const cfg = CharacterLightingSystem.probeCfg(m, CharacterLightingSystem.shKOf(meta),
                                                 CharacterLightingSystem.binObOf(meta));
    const task = (async (): Promise<boolean> => {
      try {
        const buf = await fetchPayloadBytes(`${base}/${cfg.file}`);
        if (myEpoch !== this.epoch) return false;   // 旧时间线不写新状态
        this.swapProbeAtlas(m, buf, rows);
        depthLog(T, sceneId, `: probe 图集切至 mode ${m} (${(buf.byteLength / 1048576).toFixed(2)}MB)`);
        return true;
      } catch (e) {
        depthError(T, 'probe atlas load failed', e);
        return false;
      } finally {
        if (myEpoch === this.epoch) this.probeInflight = null;
      }
    })();
    this.probeInflight = task;
    return task;
  }

  /**
   * 场景切换时调用;无载荷/哈希失配 → 本场景保持 inactive(回落旧管线)。
   *
   * **从不加载体素卷**:vol_rad/vol_emit 合计 20–27MB/场景,只有 F2 的实时 RT 对比
   * (mode 0)用得上,进场景一律用 1×1 占位纹理保 shader 绑定、并把 mode 钳到 ≥1。
   * 要 RT 时由 `ensureVolumes()` 现拉、关掉时 `releaseVolumes()` 立刻还回去。
   */
  async load(
    sceneId: string,
    worldW: number,
    worldH: number,
    /**
     * 本场景**当前生效**的第一层背景图名（如 `background.png`）。
     *
     * 烘焙产物按它索引（制作人 2026-08-30：背景与烘焙绑死，图名即 key），
     * 防腐门也对它算哈希 —— 从此换背景连带换烘焙，不可能错配。
     * 不传 = 老口径 `background.png`，旧调用零影响。
     */
    backgroundImage = 'background.png',
  ): Promise<void> {
    const myEpoch = ++this.epoch;
    this._hasVolumes = false;
    this.volInflight = null;   // 旧场景的在途拉取作废(epoch 已变,回来也写不进)
    this.loadedSceneId = null;
    this.loadedBakeBase = null;
    // 跨场景残留：pendingLights 会被下一个场景的 setShadowBasis 重放，
    // 把**上一个场景的灯**打到新场景角色身上（审查抓到）。
    this.pendingLights = null;
    this.payloadStale = false;
    this.meta = null; this.groundD = null; this.resources = null; this.probeViz = null;
    this.probeAtlasU16 = null; this.validU8 = null;
    this.parkLitShaders();      // 活 shader 先退白图,再销毁旧纹理(防 BindGroup 自毁)
    for (const t of this.ownedTextures) t.destroy();
    this.ownedTextures = [];
    for (const t of this.volTextures) t.destroy();
    this.volTextures = [];
    this.disposeStaleVolumeTextures();
    for (const t of this.probeTextures) t.destroy();
    this.probeTextures = [];
    this.disposeStaleProbeTextures();
    this.loadedProbeMode = 0;
    this.probeInflight = null;
    this.sceneWorldW = worldW; this.sceneWorldH = worldH;
    // 按背景图名索引；找不到就回落到旧的扁平布局（迁移期两条都认，缺省不影响运行）。
    const perBg = sceneBakeDirUrl(sceneId, backgroundImage);
    const legacy = sceneRuntimeAssetUrl(sceneId, 'lighting');
    let base = perBg;
    let meta: LightingPayloadMeta;
    try {
      let r = await fetch(`${base}/lighting.json`);
      if (!r.ok) {
        base = legacy;
        r = await fetch(`${base}/lighting.json`);
        if (r.ok) depthLog(T, sceneId, `: 用旧的扁平烘焙布局(${legacy});迁移后可摘`);
      }
      if (!r.ok) { depthLog(T, sceneId, ': no lighting payload'); return; }
      this.loadedBakeBase = base;
      meta = await r.json();
      // vite dev 的 SPA fallback 会给缺失文件回 200+HTML;json() 抛错走 catch,
      // 但反序列化侥幸成功的畸形体也要挡:验证载荷形状。
      // v3 起 probe 图集为固化最终 E(单块球谐);v2(分账)与本运行时列布局不兼容 → 需重导出。
      if (typeof meta?.version !== 'number' || meta.version < 3
        || !meta.probes || !meta.world || !meta.cal || !meta.vol) {
        depthLog(T, sceneId, ': lighting payload missing/旧版(需重导出 v3 固化), ignored');
        return;
      }
    } catch { depthLog(T, sceneId, ': no lighting payload'); return; }
    if (myEpoch !== this.epoch) return;

    // 防腐门:背景内容哈希(与 validator 同一契约)。
    //
    // ⚠ 2026-08-30 从「失配即整份禁用」改为**分级降级**(制作人口径:烘焙数据可以缺省,
    //   缺省不能把别的搞坏)。整份丢的实际后果今天实测过:失配时连纯几何的 ground_d
    //   一起没了,而**两条角色着色路都要它** —— 于是整个场景的角色退成不打光的裸 sprite,
    //   雾津街头(序章主场景)就是这么黑着的。
    //
    //   分级依据是载荷里混着两类东西:
    //   · 几何/标定(work/cal/world/ground_d) —— 背景重画后仍近似成立(尤其只是 relight
    //     换色的情况,几何逐像素不变),丢了代价极大;
    //   · 光照项(probe 图集/体素卷/烘焙反解光源) —— 烘死的是**那一版画面的光**,失配即过期。
    //
    //   所以失配时**照常装载**,但标记 stale 并在 dev 大声报 —— 「失败不得伪装成功」由
    //   这条可见告警承担,而不是靠把画面搞坏来提醒作者。
    let stale = false;
    try {
      const bg = await fetch(sceneRuntimeAssetUrl(sceneId, backgroundImage));
      const digest = await crypto.subtle.digest('SHA-1', await bg.arrayBuffer());
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
      if (hex !== meta.background_sha1) {
        stale = true;
        depthError(T, sceneId,
          `: 照明烘焙过期(bake ${meta.background_sha1} vs bg ${hex}) —— 几何项仍用,`
          + '光照项(probe/体素)已是旧画面的光,请在角色照明实验室重烘并重新导出');
      }
    } catch (e) {
      stale = true;
      depthError(T, 'hash gate failed(按过期处理,几何项仍用)', e);
    }
    this.payloadStale = stale;
    if (myEpoch !== this.epoch) return;

    try {
      // probe 图集**按需加载**:进场景只拉当前 mode 那一种(游戏默认 L2=9列);另两种 F2 切档
      // 才由 ensureProbeAtlas 现拉。省掉白加载(尤其 BIN 那份;固化后 L2 仅 ~0.12MB)。
      const shMode0 = (meta.shading as { mode?: number } | undefined)?.mode;
      // 载荷 shading.mode 说了算(1=L1 Geomerics / 2=SH 线性 / 3=八面体);缺省八面体(2026-09-02 正式档)。
      // 判定在 lightingPayloadFiles.probeModeOf —— 打包清单按同一条规则决定抽哪张图集。
      const targetProbeMode = probeModeOf(shMode0);
      const probeCfg0 = CharacterLightingSystem.probeCfg(targetProbeMode,
                                                          CharacterLightingSystem.shKOf(meta),
                                                          CharacterLightingSystem.binObOf(meta));
      // skyao probe 的网格与坐标系在 **geometry.json**(几何场那侧产的),
      // 不在 lighting.json 里 —— 两个文件同住一个目录,但由两条烘焙路径分别产出。
      // 缺文件不算错(老载荷没有这一份):skyao 静默降级为「不遮蔽」。
      //
      // ⚠ 前三个走 fetchPayloadBytes/Blob:缺文件**必须抛**。以前是裸 `r.arrayBuffer()`,
      //   发行包漏抽 atlas_bin.bin 时 404 正文被当图集吃进去——偶数字节补零成全黑,
      //   奇数字节 Uint16Array 抛 RangeError 整份作废,28 个场景就这么黑了一轮而零报错。
      const [atlasBuf, valid, groundBuf, geomRes, skyaoRes] = await Promise.all([
        fetchPayloadBytes(`${base}/${probeCfg0.file}`),
        fetchPayloadBytes(`${base}/probes_valid.bin`),
        fetchPayloadBlob(`${base}/ground_d.png`),
        fetch(`${base}/geometry.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`${base}/skyao_probe.bin`).then((r) => (r.ok ? r.arrayBuffer() : null))
          .catch(() => null),
      ]);
      if (myEpoch !== this.epoch) return;

      const P = meta.probes.nx * meta.probes.ny * meta.probes.nz;
      // 当前 mode 建真图,另两种 1×1 占位(shader 按 mode 采样,占位不被采)。三张进 probeTextures(可换)。
      const realAtlas = this.makeProbeTexture(atlasBuf, probeCfg0.col, P);
      const phTex = (): TextureSource => this.makeProbeTexture(new Uint16Array(4).buffer, 1, 1);
      const atlasL1 = targetProbeMode === 1 ? realAtlas : phTex();
      const atlasL2 = targetProbeMode === 2 ? realAtlas : phTex();
      const atlasBin = targetProbeMode === 3 ? realAtlas : phTex();
      this.loadedProbeMode = targetProbeMode;
      const { T: vT, H: vH } = CharacterLightingSystem.probeTiling(P);
      let validData = new Uint8Array(valid);
      if (validData.length < vT * vH) {
        const padded = new Uint8Array(vT * vH);   // 补齐位 = 0 = invalid,不参与插值
        padded.set(validData);
        validData = padded;
      }
      const validTex = new BufferImageSource({
        resource: validData, width: vT, height: vH,
        format: 'r8unorm', scaleMode: 'nearest',
        alphaMode: 'no-premultiply-alpha',
      });
      this.ownedTextures.push(validTex);
      const V = meta.vol;
      // 进场景一律 1×1 占位卷保 shader 采样器绑定合法;cache 着色路径(mode≥1)从不采样它。
      // 真卷由 ensureVolumes() 在开 RT 时现拉替换(volTextures 独立于 ownedTextures 管理)。
      const volRadTex = this.makeVolumeTexture(new Uint16Array(4).buffer, 1, 1);
      const volEmitTex = this.makeVolumeTexture(new Uint16Array(4).buffer, 1, 1);
      this._hasVolumes = false;

      // ground_d.png:RG16 → 深度场(footQ 的 CPU 采样源)
      const bmp = await createImageBitmap(groundBuf);
      if (myEpoch !== this.epoch) { bmp.close(); return; }
      const bmp0w = bmp.width, bmp0h = bmp.height;
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx2 = cv.getContext('2d')!;
      ctx2.drawImage(bmp, 0, 0);
      const id = ctx2.getImageData(0, 0, bmp.width, bmp.height).data;
      bmp.close();
      // GPU 版:直接用原始 RG16 位图建纹理,shader 里按 min/max 解码(与 CPU 侧同一份数据)
      const gtex = new BufferImageSource({
        resource: new Uint8Array(id.buffer.slice(0)), width: bmp0w, height: bmp0h,
        format: 'rgba8unorm', scaleMode: 'nearest', alphaMode: 'no-premultiply-alpha',
      });
      this.ownedTextures.push(gtex);
      const g = new Float32Array(meta.work.w * meta.work.h);
      const span = meta.ground_d.max - meta.ground_d.min;
      for (let i = 0; i < g.length; i++) {
        g[i] = meta.ground_d.min + ((id[i * 4] * 256 + id[i * 4 + 1]) / 65535) * span;
      }

      // 光源表:世界 → q(M 正交,逆=转置)
      const M = meta.world.M;
      const lightsQ = new Float32Array(48 * 4);
      const lightsE = new Float32Array(48 * 4);
      const lightCount = Math.min(48, meta.lights.length);
      for (let i = 0; i < lightCount; i++) {
        const li = meta.lights[i];
        const X = li.pos;
        lightsQ[i * 4] = M[0][0] * X[0] + M[1][0] * X[1] + M[2][0] * X[2];
        lightsQ[i * 4 + 1] = M[0][1] * X[0] + M[1][1] * X[1] + M[2][1] * X[2];
        lightsQ[i * 4 + 2] = M[0][2] * X[0] + M[1][2] * X[1] + M[2][2] * X[2];
        lightsQ[i * 4 + 3] = li.area;
        lightsE[i * 4] = li.radiance[0];
        lightsE[i * 4 + 1] = li.radiance[1];
        lightsE[i * 4 + 2] = li.radiance[2];
      }

      // ---- skyao probe:rgba16f 平铺图集(a0,a1x,a1y,a1z)----
      // ⚠⚠ 它的 M 是 geometry.json 的 **depthConfig det=+1**,与下面 probe 用的
      //    meta.world.M(det=-1)**不是一个矩阵**。混用不报错,只是方向整个镜像。
      let skyao: NonNullable<CharShadingSceneResources['skyao']> | null = null;
      const sp = (geomRes as { skyao_probe?: Record<string, number>;
                              M?: number[][] } | null)?.skyao_probe;
      const spM = (geomRes as { M?: number[][] } | null)?.M;
      if (sp && spM && skyaoRes) {
        const want = sp.atlas_w * sp.atlas_h * 4 * 2;
        if (skyaoRes.byteLength !== want) {
          depthError(T, sceneId, `: skyao_probe.bin ${skyaoRes.byteLength} 字节 ≠ `
            + `图集 ${sp.atlas_w}x${sp.atlas_h} rgba16f 应有的 ${want} —— 已跳过`);
        } else {
          const tex = new BufferImageSource({
            resource: new Uint16Array(skyaoRes), width: sp.atlas_w, height: sp.atlas_h,
            format: 'rgba16float', scaleMode: 'nearest',
            alphaMode: 'no-premultiply-alpha',
          });
          this.ownedTextures.push(tex);
          skyao = {
            tex,
            n: [sp.nx, sp.ny, sp.nz],
            tiles: [sp.tiles_x, sp.tiles_y],
            wMin: [sp.x0, sp.y0, sp.z0],
            wScale: [
              1 / Math.max(sp.x1 - sp.x0, 1e-5),
              1 / Math.max(sp.y1 - sp.y0, 1e-5),
              1 / Math.max(sp.z1 - sp.z0, 1e-5),
            ],
            mCol: new Float32Array([
              spM[0][0], spM[1][0], spM[2][0],
              spM[0][1], spM[1][1], spM[2][1],
              spM[0][2], spM[1][2], spM[2][2],
            ]),
          };
          depthLog(T, sceneId, `: skyao probe ${sp.nx}x${sp.ny}x${sp.nz} 已载入`);
        }
      }

      const w = meta.world;
      const pn = meta.probes;
      this.meta = meta;
      this.groundD = g;
      this.groundTex = gtex;
      this.probeAtlasU16 = new Uint16Array(atlasBuf);
      this.probeAtlasCol = probeCfg0.col;
      this.validU8 = new Uint8Array(valid);
      this.resources = {
        atlasL1, atlasL2, atlasBin, valid: validTex,
        volRad: volRadTex, volEmit: volEmitTex,
        workW: meta.work.w, workH: meta.work.h,
        worldToWorkX: meta.work.w / Math.max(worldW, 1e-6),
        worldToWorkY: meta.work.h / Math.max(worldH, 1e-6),
        cal: { ppu: meta.cal.ppu, cx: meta.cal.cx, cy: meta.cal.cy, theta: meta.cal.theta },
        vol: {
          nx: V.nx, ny: V.ny, nz: V.nz, tilesX: V.tiles_x, tilesY: V.tiles_y,
          qMin: [V.qx_min, V.qy_min, V.qz_min], qMax: [V.qx_max, V.qy_max, V.qz_max],
        },
        mCol: new Float32Array([
          M[0][0], M[1][0], M[2][0],
          M[0][1], M[1][1], M[2][1],
          M[0][2], M[1][2], M[2][2],
        ]),
        wMin: [w.x0, w.y0, w.z0],
        wScale: [
          (pn.nx - 1) / Math.max(w.x1 - w.x0, 1e-5),
          (pn.ny - 1) / Math.max(w.y1 - w.y0, 1e-5),
          (pn.nz - 1) / Math.max(w.z1 - w.z0, 1e-5),
        ],
        pn: [pn.nx, pn.ny, pn.nz],
        probeT: CharacterLightingSystem.probeTiling(P).T,
        shK: CharacterLightingSystem.shKOf(meta),
        binOb: CharacterLightingSystem.binObOf(meta),
        ambSH: new Float32Array(meta.ambient_sh),
        lightsQ, lightsE, lightCount,
        skyao,
      };
      // probe 点云可视化数据:规则晶格位置(=运行时插值实际用的格点)投回场景
      // 世界系;颜色取固化 E 的 DC 系数(coeff 0),与实验室查看器点云同配方(×0.9 → 1/2.2)。
      {
        const atlasU16 = this.probeAtlasU16!;
        const nCol = this.probeAtlasCol;
        const validU8 = new Uint8Array(valid);
        const pts: ProbeVizPoint[] = [];
        const s2wX = meta.work.w / Math.max(worldW, 1e-6);
        const s2wY = meta.work.h / Math.max(worldH, 1e-6);
        for (let px = 0; px < pn.nx; px++) {
          for (let py = 0; py < pn.ny; py++) {
            for (let pz = 0; pz < pn.nz; pz++) {
              const flat = px * (pn.ny * pn.nz) + py * pn.nz + pz;
              const X = w.x0 + (pn.nx > 1 ? (px / (pn.nx - 1)) * (w.x1 - w.x0) : 0);
              const Y = w.y0 + (pn.ny > 1 ? (py / (pn.ny - 1)) * (w.y1 - w.y0) : 0);
              const Z = w.z0 + (pn.nz > 1 ? (pz / (pn.nz - 1)) * (w.z1 - w.z0) : 0);
              // world → q(M 正交,逆=转置)→ work px → 场景世界
              const qx = M[0][0] * X + M[1][0] * Y + M[2][0] * Z;
              const qy = M[0][1] * X + M[1][1] * Y + M[2][1] * Z;
              const sx = meta.cal.cx + qx * meta.cal.ppu;
              const sy = meta.cal.cy - qy * meta.cal.ppu;
              let color = 0;
              for (let c = 0; c < 3; c++) {
                const v = Math.max(f16(atlasU16[(flat * nCol) * 4 + c]) * 0.9, 0);
                const b = Math.max(30, Math.min(255, Math.round(Math.pow(v, 1 / 2.2) * 255)));
                color = (color << 8) | b;
              }
              pts.push({
                x: sx / s2wX, y: sy / s2wY,
                color, valid: validU8[flat] > 0,
              });
            }
          }
        }
        this.probeViz = pts;
      }

      // 场景配置接管非 bake 着色参数(F2 打开即这些值;F2 改动=运行时测试,
      // 场景重载即回配置)。太阳为游戏侧参数,载荷不含,保持现值。
      const sh = meta.shading;
      if (sh) {
        Object.assign(this.params, {
          mode: sh.mode, spp: sh.spp, step: sh.step, msteps: sh.msteps,
          fold: sh.fold > 0, missMode: sh.miss_mode > 0, nee: sh.nee > 0,
          beta: sh.beta, ambStrength: sh.amb,
          bulge: sh.bulge, flatten: sh.flatten,
          // 旧载荷没有 giStrength(2026-09-01 新增)——缺省 1 = 行为不变
          giStrength: (() => {
            const g = (sh as { giStrength?: unknown }).giStrength;
            return typeof g === 'number' && Number.isFinite(g) ? g : 1;
          })(),
        });
        // E 色度权重(实验室调色区导出;缺省 0=只借场景明暗)。F2 旋钮可临时覆盖测试。
        const ec = (sh as { eChroma?: number }).eChroma;
        this.eChroma = typeof ec === 'number' && Number.isFinite(ec) ? ec : 0;
      }
      // 进场景恒未载体素卷 → 强制 cache 着色(mode≥1),RT(mode 0)会采样占位卷得黑。
      if (this.params.mode < 1) this.params.mode = 3;
      // sprite 网格着色:场景静态组(mesh 路径与 filter 同源同值)
      this.groundRange = [meta.ground_d.min, meta.ground_d.max];
      this.sceneLit = createSceneLitUniforms({
        worldToWorkX: this.resources.worldToWorkX, worldToWorkY: this.resources.worldToWorkY,
        cal: this.resources.cal, vol: this.resources.vol,
        mCol: this.resources.mCol, wMin: this.resources.wMin, wScale: this.resources.wScale,
        pn: this.resources.pn, probeT: this.resources.probeT, shK: this.resources.shK,
        binOb: this.resources.binOb,
        ambSH: this.resources.ambSH,
        lightsQ: this.resources.lightsQ, lightsE: this.resources.lightsE,
        lightCount: this.resources.lightCount,
        groundMin: this.groundRange[0], groundMax: this.groundRange[1],
        sceneWorldW: this.sceneWorldW, sceneWorldH: this.sceneWorldH,
        workW: this.resources.workW, workH: this.resources.workH,
        skyao: this.resources.skyao ?? null,
      });
      this.loadedSceneId = sceneId;
      depthLog(T, sceneId, `: lighting v3 active, ${P} probes, ${lightCount} lights, `
        + `vol ${V.nx}x${V.ny}x${V.nz}, shading ${sh ? `cfg(mode ${sh.mode})` : 'defaults'}`);
      this.onReady?.();
    } catch (e) {
      depthError(T, 'payload load failed', e);
      if (myEpoch === this.epoch) {
        this.meta = null; this.groundD = null; this.resources = null;
        this.loadedSceneId = null; this._hasVolumes = false;
        for (const t of this.ownedTextures) t.destroy();
        this.ownedTextures = [];
        for (const t of this.volTextures) t.destroy();
        this.volTextures = [];
        this.disposeStaleVolumeTextures();
        for (const t of this.probeTextures) t.destroy();
        this.probeTextures = [];
        this.disposeStaleProbeTextures();
        this.loadedProbeMode = 0;
        this.probeInflight = null;
      }
    }
  }

  /**
   * 逐帧驱动一个着色滤镜:脚点 → footQ(ground_d 双线性),实体尺寸 → quad wu,
   * 当前帧法线 rect / 镜像,以及全量 F2 参数同步。
   */
  /**
   * 行走面深度场(实验室 walk_depth / ground_d.png)——遮挡与阴影的地面锚点。
   * 与烘焙的 probe/体素无关:只要载荷在就可用,着色总开关关掉也照常供给。
   * 供 SceneDepthSystem 接管(Game 在载荷就绪时注入),取代旧的 floor_depth_A/B 拟合直线。
   */
  /** 行走面深度场的 GPU 纹理 + 解码区间(RG16:d = min + (r*256+g)/65535 * (max-min)) */
  get groundDepthTexture(): { tex: TextureSource; min: number; max: number } | null {
    const m = this.meta;
    return m && this.groundTex
      ? { tex: this.groundTex, min: m.ground_d.min, max: m.ground_d.max }
      : null;
  }

  get groundDepthField(): GroundDepthField | null {
    const m = this.meta; const g = this.groundD;
    return m && g ? { data: g, w: m.work.w, h: m.work.h } : null;
  }

  /** 场景世界坐标 → 行走面深度(work-res 双线性);无载荷返回 null */
  sampleGroundDepth(worldX: number, worldY: number): number | null {
    const m = this.meta; const g = this.groundD;
    if (!m || !g) return null;
    return sampleGroundField(
      g, m.work.w, m.work.h,
      (worldX / Math.max(this.sceneWorldW, 1e-6)) * m.work.w,
      (worldY / Math.max(this.sceneWorldH, 1e-6)) * m.work.h,
    );
  }

  driveFilter(
    filter: CharacterShadingFilter,
    worldX: number,
    worldY: number,
    ent: CharShadingEntityInfo | null,
  ): void {
    const m = this.meta; const g = this.groundD; const res = this.resources;
    if (!m || !g || !res) return;
    const W = m.work.w, H = m.work.h;
    const sx = (worldX / Math.max(this.sceneWorldW, 1e-6)) * W;
    const sy = (worldY / Math.max(this.sceneWorldH, 1e-6)) * H;
    const d = sampleGroundField(g, W, H, sx, sy);
    const qx = (sx - m.cal.cx) / m.cal.ppu;
    const qy = (m.cal.cy - sy) / m.cal.ppu;
    filter.setFootQ(qx, qy, d);
    if (ent) {
      const cosT = Math.cos(m.cal.theta);
      const wWu = (ent.worldW * res.worldToWorkX) / m.cal.ppu;
      const hWu = (ent.worldH * res.worldToWorkY) / Math.max(cosT * m.cal.ppu, 1e-6)
        * this.params.heightScale;
      filter.setCharSize(wWu, hWu);
      filter.setNormalFrame(ent.nrmRect, ent.flipX);
      // 法线 local UV 的唯一依据:sprite 的世界 AABB(锚点=底中,故左上 = x−w/2, y−h)。
      // 与 color 帧同一套 UV;裁剪无关(半出屏的实体不再整块采到边缘列)。
      filter.setSpriteWorldRect(
        worldX - ent.worldW / 2, worldY - ent.worldH, ent.worldW, ent.worldH,
      );
    }
    filter.applyParams(this.params);
    filter.applyDebugState(
      this.showNOverride ?? (this.params.showNormals ? 1 : 0),
      typeof this.eOnlyDebug === 'number' ? this.eOnlyDebug : (this.eOnlyDebug ? 1 : 0),
      this.eCheckerDebug ? 1 : 0,
      this.skyaoBlend,
      typeof this.giDiagFixedN === 'number' ? this.giDiagFixedN : 0,
    );
    filter.setEChroma(this.eChroma);
  }

  // ---------------------------------------------------------------- mesh 着色 API(2026-07-25)

  /**
   * 统一光影的角色路径要用的场景几何（2026-08-20）。
   *
   * 只交出**标定与 ground 场**——光一概不给：新路径的光来自 `SceneLightingSystem`，
   * 与背景同一份。这里若顺手把 probe/体素也交出去，就等于开了第二个光源真相，
   * 「角色与场景明暗一致」立刻失去构造性保证。
   *
   * 载荷没装好时返回 null，调用方据此回落旧路径。
   */
  get unifiedGeometry(): {
    worldToWork: [number, number];
    cal: { ppu: number; cx: number; cy: number; theta: number };
    groundRange: [number, number];
    sceneWorld: [number, number];
    ground: TextureSource;
  } | null {
    const r = this.resources;
    if (!r || !this.groundTex) return null;
    return {
      worldToWork: [r.worldToWorkX, r.worldToWorkY],
      cal: r.cal,
      groundRange: this.groundRange,
      sceneWorld: [this.sceneWorldW, this.sceneWorldH],
      ground: this.groundTex,
    };
  }

  /**
   * 形体参数（鼓起/压平/两条 AO）。**这一组是旧路径专用的**。
   *
   * ⚠ 曾经写的是「新旧两条角色路径吃同一组，避免切换时跳变」，那条已经不成立、
   *   而且当初就是个 bug 源：这里的 flatten/bulge 来自旧 probe 载荷
   *   （`lighting/lighting.json` 的 shading 块），是给**旧着色模型**调的。
   *   雾津街头带着 flatten=1.0，喂给新模型等于把法线整个压平，
   *   每盏灯的 N·L 都一样、方向性全丢。新路径改从
   *   `SceneLightingDef.characterShape` 取（缺省 flatten=0），
   *   只有两条 AO 是新旧真正共享的量（见 `UnifiedCharacterLighting.syncFrame`）。
   */
  get shapeParams(): { bulge: number; flatten: number; aoContact: number; aoForm: number } {
    return {
      bulge: this.params.bulge,
      flatten: this.params.flatten,
      aoContact: this.aoContact,
      aoForm: this.aoForm,
    };
  }

  /** 场景卸载/重载前把活 shader 的场景纹理全部退到白图 —— 防 BindGroup 绑到已销毁纹理自毁。 */
  private parkLitShaders(): void {
    for (const sh of [...this.litShaders]) {
      try {
        // 槽位表的权威源在 CharacterLitSprite（与 createLitShader 的 resources 同处维护）——
        // 手抄一份就会漏，漏一个槽位 = 那张纹理销毁时把整个 BindGroup 带走 = 卡死。
        for (const k of LIT_SHADER_SCENE_TEXTURE_SLOTS) {
          setLitShaderTexture(sh, k, null);
        }
      } catch {
        // 已被销毁的 shader(实体拆除顺序在本系统 destroy 之后/之前都可能发生):
        // BindGroup 内部已置空,setResource 会抛。抛了 = 它死了,从注册表剔除。
        // ⚠ 不接这一层的代价不是"少退一张图",而是 park 半途炸掉 —— destroy()/load()
        // 整个中断,下一场景的载荷装不上(2026-09-01:夜时段换装后 probes 恒 null,
        // 角色照明整场安静失效,查了半天以为是夜载荷坏了)。
        this.litShaders.delete(sh);
      }
    }
    this.sceneLit = null;
  }

  /** 体素卷/probe 图集热替换后,把新纹理就地重绑到所有活 shader(mesh 不走"重挂滤镜"那套)。 */
  private rebindLitSceneTextures(): void {
    const r = this.resources;
    if (!r) return;
    for (const sh of this.litShaders) {
      setLitShaderTexture(sh, 'uPL1', r.atlasL1);
      setLitShaderTexture(sh, 'uPL2', r.atlasL2);
      setLitShaderTexture(sh, 'uPBin', r.atlasBin);
      setLitShaderTexture(sh, 'uValid', r.valid);
      setLitShaderTexture(sh, 'uVolRad', r.volRad);
      setLitShaderTexture(sh, 'uVolEmit', r.volEmit);
      if (this.groundTex) setLitShaderTexture(sh, 'uGround', this.groundTex);
    }
  }

  /** 为一个实体建 sprite 网格着色 shader;无载荷/关闭时返回 null(实体走旧管线)。 */
  createEntityLitShader(colorTex: TextureSource, nrm: TextureSource | null): Shader | null {
    const r = this.resources;
    if (!r || !this.sceneLit || !this.groundTex || !this.enabled) return null;
    const sh = createLitShader(this.sceneLit, this.frameLit, this.charLights, {
      colorTex, nrm, ground: this.groundTex,
      atlasL1: r.atlasL1, atlasL2: r.atlasL2, atlasBin: r.atlasBin,
      valid: r.valid, volRad: r.volRad, volEmit: r.volEmit,
      skyao: r.skyao?.tex ?? null,
    });
    this.litShaders.add(sh);
    return sh;
  }

  /** 实体销毁/关闭着色时回收(shader 归照明系统管,mesh/geometry 归实体)。 */
  releaseEntityLitShader(sh: Shader): void {
    this.litShaders.delete(sh);
    sh.destroy();
  }

  /** 实体运行时换图集(背尸/道士/setEntityField):就地换 color+normal 源,同源短路。 */
  swapEntityLitTextures(sh: Shader, colorTex: TextureSource, nrm: TextureSource | null): void {
    setLitShaderTexture(sh, 'uColorTex', colorTex);
    setLitShaderTexture(sh, 'uNrm', nrm);
  }

  /** AO(env 驱动;与 filter 的 applyShadowFilterToneAO 同一组值,由 Game 在同处喂)。 */
  setSharedAO(contact: number, form: number): void {
    this.aoContact = contact;
    this.aoForm = form;
  }

  /**
   * 每渲染帧同步共享帧组(worldContainer 位姿 + 全部照明参数)。
   * 由 Pixi ticker 直接驱动(Game 注册),**不经任何游戏状态分支** —— filter 路径那次
   * "Cutscene 态整段驱动被跳过 → uniform 冻在默认值"的事故面在这里结构上不存在。
   */
  /** skyao 与全白的 blend:0=不遮蔽 1=完整。filter 路径同步走 setFilterSkyaoBlend。 */
  setSkyaoBlend(v: number): void {
    this.skyaoBlend = Math.max(0, Math.min(1, Number(v) || 0));
    // filter 路径有自己的 uniform 组(不共用 frameLit),得逐个推
    for (const f of this.litShaders) {
      const u = (f as unknown as { resources?: Record<string, { uniforms?: Record<string, unknown> }> })
        .resources;
      const g = u?.['charShadeScene'] ?? u?.['sceneShade'];
      if (g?.uniforms && 'uSkyaoBlend' in g.uniforms) g.uniforms['uSkyaoBlend'] = this.skyaoBlend;
    }
  }

  get skyaoBlendValue(): number { return this.skyaoBlend; }

  /** 调试视图:0=正常 1=法线 2=skyao V(灰度) 3=skyao 查表 c01 4=skyao 原始矩 a0 5=V 色带。 */
  setCharDebugView(mode: number): void {
    const m = Math.max(0, Math.min(5, Math.round(Number(mode) || 0)));
    this.showNOverride = m === 0 ? null : m;
  }

  /** skyao 载荷的实况(诊断用):没载上就是 on=false —— 那时 blend 拨到哪都没效果。 */
  get skyaoInfo(): { on: boolean; n?: number[]; tiles?: number[]; blend: number } {
    const k = this.resources?.skyao;
    return k
      ? { on: true, n: [...k.n], tiles: [...k.tiles], blend: this.skyaoBlend }
      : { on: false, blend: this.skyaoBlend };
  }

  syncFrame(wcX: number, wcY: number, projectionScale: number): void {
    const u = this.frameLit.uniforms as Record<string, unknown>;
    const wc = u['uWCPos'] as Float32Array;
    wc[0] = wcX; wc[1] = wcY;
    u['uWCScale'] = projectionScale;
    const p = this.params;
    u['uMode'] = p.mode; u['uSpp'] = p.spp; u['uMSteps'] = p.msteps;
    u['uFold'] = p.fold ? 1 : 0; u['uMissMode'] = p.missMode ? 1 : 0; u['uNEE'] = p.nee ? 1 : 0;
    u['uStep'] = p.step; u['uBeta'] = Math.pow(2, p.beta); u['uAmbStrength'] = p.ambStrength;
    u['uBulge'] = p.bulge; u['uFlatten'] = p.flatten; u['uShowN'] = this.showNOverride ?? (p.showNormals ? 1 : 0);
    u['uEOnly'] = typeof this.eOnlyDebug === 'number' ? this.eOnlyDebug : (this.eOnlyDebug ? 1 : 0);
    u['uGiStrength'] = p.giStrength;
    u['uFixedNQ'] = this.giDiagFixedN;
    u['uEChecker'] = this.eCheckerDebug ? 1 : 0;
    u['uSunOn'] = p.sunEnabled ? 1 : 0;
    const az = (p.sunAzimuthDeg * Math.PI) / 180;
    const el = (p.sunElevationDeg * Math.PI) / 180;
    const d = u['uSunDirQ'] as Float32Array;
    d[0] = Math.cos(el) * Math.cos(az); d[1] = Math.sin(el); d[2] = Math.cos(el) * Math.sin(az);
    const c = u['uSunColor'] as Float32Array;
    c[0] = p.sunColor[0] * p.sunIntensity;
    c[1] = p.sunColor[1] * p.sunIntensity;
    c[2] = p.sunColor[2] * p.sunIntensity;
    u['uEChroma'] = this.eChroma;
    u['uAOContact'] = this.aoContact; u['uAOForm'] = this.aoForm;
    u['uSkyaoBlend'] = this.skyaoBlend;
    this.frameLit.update();
  }
}
