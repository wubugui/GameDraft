import type { Container, Renderer as PixiRenderer } from 'pixi.js';

import type { AssetManager } from '../../core/AssetManager';
import { depthLog } from '../../core/depthLog';
import type { GameContext, IGameSystem, LightDef, SceneData } from '../../data/types';
import { WindowBackground, type WindowConeParams } from '../../rendering/windowWorld/WindowBackground';
import type { ResolvedPhase } from '../../utils/dayTime';
import { loadWindowWorldPayload, type WindowWorldPayload } from './windowWorldPayload';
import {
  loadCpuDepthMap, qToWorldWu, solveCone, uvToWorldWu,
  type CpuDepthMap, type GroundWorldSampler, type SolvedCone,
} from './windowWorldCone';
import {
  WindowWorldEntities,
  type WindowWorldEntityDeps, type WindowWorldMemorySnapshot,
} from './WindowWorldEntities';
import type { CharacterRegistry } from '../../data/characterRegistry';
import { CharacterLightingSystem } from '../../core/CharacterLightingSystem';
import { getNormalAtlasSource } from '../../rendering/spriteNormalAtlas';
import type { LitShaderProvider } from '../../rendering/SpriteEntity';
import type { IEntityShadingFilter } from '../../rendering/EntityLightingFilter';
import type { PerspectiveScaleResolver } from '../../utils/perspectiveScale';
import { resolveWindowWorldTarget, type WindowWorldTarget } from './windowWorldPhase';
import {
  WindowWorldRuleRunner,
  type SeenSample, type WindowWorldRuleDeps, type WindowWorldRules,
} from './windowWorldRules';

const T = 'WindowWorld';

/**
 * 法宝「窥夜」的窗户世界（玩法清单 F.5）。
 *
 * 举起法宝，从角色身上**朝鼠标指的方向**张开一片楔形，里头显示的是同一处、
 * **对面那一段**的真实样子。朝向跟指针、不跟角色 facing（制作人 2026-09-20 定：
 * 法宝是举在手上往哪儿照的，不是脸朝哪儿就照哪儿）。
 * 这一份是 **fork**：自己读场景 JSON、自己装自己的烘焙载荷、自己建辐射场。主场景不知道
 * 它存在，它也不持有主场景的任何活引用 —— 于是窗里发生什么都不可能把主场景带歪。
 *
 * ## 与主场景之间只有一个出口，且单向
 *
 * gameplay 不由窗里的东西驱动：是本系统在**外面**算「谁落在楔形里、看了多久」，
 * 再往主世界发叙事信号 / 走阳气通道。窗里的实体永远拿不到写存档的权力，
 * 不是靠它自觉，是**结构上没有那条路**。
 *
 * ## 依赖注入
 *
 * 同层系统之间不持有彼此引用（架构铁律 2）。本系统要的那几样一律由 Game 这个组装层
 * 以回调注入：当前场景 id、当前时段、时段表、角色脚点 UV、指针瞄准 UV。
 *
 * ⚠ 顶点与瞄准点都只收 **UV**。楔形由 `windowWorldCone.solveCone` 在 CPU **解一次**，
 *   背景与窗里的实体共用同一份解算结果 —— 解两遍迟早漂成「实体与背景各按各的边界裁」。
 *   而 CPU 那份读的是**同一张深度图的 CPU 副本**：两个深度族混用不报错，只是整体错位。
 */

/** 楔形的**作者可配**部分（编辑器写、场景/法宝数据里存）。单位一律 wu / 度。 */
export interface WindowConeConfig {
  /** 半角（度）。 */
  halfAngleDeg: number;
  /** 近截距（wu）——顶点附近这一截不显示，避免脚底下糊成一片。 */
  nearWu: number;
  /** 远截距（wu）。 */
  farWu: number;
  /** 相对顶点的下/上世界 Y 偏移（wu）；`up <= down` = 不限高。 */
  heightDownWu: number;
  heightUpWu: number;
  /** 边界软化：角度(度) / 距离(wu) / 高度(wu)。全 0 = 硬边（切口感）。 */
  softAngleDeg: number;
  softRangeWu: number;
  softHeightWu: number;
  /** 顶点抬高：从脚点往上抬多少（wu）。缺省贴着胸口，窗不会从地缝里长出来。 */
  apexLiftWu: number;
  /** 开 / 合的渐变时长（秒）。0 = 瞬开瞬关。 */
  fadeSeconds: number;
}

/**
 * 缺省楔形。**这组数是在跑马梁真机上量出来的，不是拍的**：
 * 那张场景横跨约 1844 wu，而画面纵深方向远得多；`farWu` 原来给 900 时窗只够罩住
 * 脚底下一条带，画面上看着像地上一摊影子而不是一扇窗。5000 wu 才够铺到视野深处。
 */
export const DEFAULT_WINDOW_CONE: WindowConeConfig = {
  halfAngleDeg: 34,
  nearWu: 10,
  farWu: 5000,
  heightDownWu: 0,
  heightUpWu: 0,       // 缺省不限高
  softAngleDeg: 4,
  softRangeWu: 60,
  softHeightWu: 0,
  apexLiftWu: 0,
  fadeSeconds: 0.18,
};

/**
 * 窗里环境粒子的挂载口。**装配交给 Game**（架构铁律 1：Game 是组装层，跨层 new 是它的活），
 * 窗只说「这是我的层、我的照明载荷、我看的是哪一段」。
 *
 * 为什么非要第二份粒子系统：布置库按「场景 × 时段外观」各配一份，窗要的是**对面那一段**
 * 那一份（崖墓入口的夜就配了萤火）。主世界那一份取的是当前时段，拿不到。
 */
export interface WindowVfxHandle {
  update(dt: number): void;
  destroy(): void;
}

export interface WindowVfxAttachCtx {
  /** 粒子画进这一层（已在窗的渲染树里，会跟着窗一起被楔形裁）。 */
  layer: Container;
  /** 窗自己的角色照明载荷：粒子的受光与窗里的人同源。 */
  lighting: CharacterLightingSystem;
  /** 看的是哪一段（`timeVariants` 键，空串 = 基底）——布置按它取份。 */
  appearancePhase: string;
  /**
   * **对面那一段**的灯（已按该时段过滤）。
   *
   * ⚠ 不能让窗的粒子去问主世界要灯：那一路按**当前**时段筛，于是窗里的萤火会被白天的灯
   * 照着、还拿不到夜里那几盏。两边差的不是亮度是"有没有这盏灯"，而且照例不报错。
   */
  lights: readonly LightDef[];
  /** 窗自己那份场景数据（深拷贝）。 */
  sceneData: SceneData;
}

export interface WindowWorldDeps {
  assetManager: AssetManager;
  /** 窗的背景挂这儿：主场景背景之上、阴影层之下。 */
  backgroundLayer: Container;
  /** 取 Pixi 渲染器（辐射场要用它跑一次离屏渲染）。 */
  getPixiRenderer: () => PixiRenderer | null;
  getSceneId: () => string | null;
  getPhase: () => string;
  getPhases: () => readonly ResolvedPhase[];
  /**
   * 瞄准点：鼠标此刻指着场景里的哪儿（UV 0..1）。取不到返回 null。
   *
   * 窗**跟鼠标不跟角色朝向**（制作人 2026-09-20 定）：法宝是举在手上往哪儿照的，
   * 不是角色脸朝哪儿就照哪儿。与顶点同样只给 UV，深度交给着色器自己采。
   */
  getAimUv: () => [number, number] | null;
  /** 角色注册表：窗里的实体与主场景走同一份身份合并。 */
  characterRegistry: () => CharacterRegistry;
  /** NPC 没写 phases 时算在哪几段（由 daylight 标记派生），与主场景同口径。 */
  getNpcDefaultPhases: () => readonly string[];
  /**
   * 从主世界**拷一份**场景记忆给 fork。拷完那份就是窗自己的，窗怎么改都不回写。
   * 不拷的话这周目已经拾走 / 已经关掉的东西会在窗里复活。
   */
  snapshotSceneMemory: (sceneId: string) => WindowWorldMemorySnapshot | null;
  /**
   * 深度遮挡滤镜工厂（主场景那一份）。几何各时段共享，所以窗里的人该被同一道崖壁挡住。
   */
  makeOcclusionFilter: (blend?: number) => IEntityShadingFilter | null;
  /** 场景透视缩放句柄（主场景解出来那一份，几何各时段共享）。见 `WindowWorldEntityDeps`。 */
  perspectiveScale: () => PerspectiveScaleResolver | null;
  /** 实体像素密度低通的当前档（同样是几何量，主场景算出来那一档对窗一样成立）。 */
  pixelDensityMatch: WindowWorldEntityDeps['pixelDensityMatch'];
  /** gameplay 的三个出口（阳气 / 三把火 / 叙事信号）。见 windowWorldRules 的文件注释。 */
  rules: WindowWorldRuleDeps;
  /** 挂窗里的环境粒子；不注入 = 窗里没有环境粒子（降级，不报错）。 */
  attachVfx?: (ctx: WindowVfxAttachCtx) => WindowVfxHandle | null;
  /**
   * 楔形顶点：角色脚点在场景里的 UV（0..1）。取不到返回 null。
   *
   * 只收 UV，深度由窗自己解（`groundWorldAt`：玩家站在哪块**地**上）。
   * 主场景那边的角色深度是另一套（`chestQAt` 带胸口抬升、给影子用的），
   * 借过来就是"顶点浮在半空"——窗要的是脚点，自己算一次反而不会漂。
   */
  getApexUv: () => [number, number] | null;
}

export class WindowWorldSystem implements IGameSystem {
  private deps: WindowWorldDeps;
  private cone: WindowConeConfig = { ...DEFAULT_WINDOW_CONE };

  private payload: WindowWorldPayload | null = null;
  private bg: WindowBackground | null = null;
  private entities: WindowWorldEntities | null = null;
  /** `depth_map` 族的 CPU 副本：实体的楔形判据与背景必须同族同解码。 */
  private cpuDepth: CpuDepthMap | null = null;
  /**
   * 窗里角色的照明载荷 —— **第二份** `CharacterLightingSystem`，装的是**夜的** probe。
   * 主场景那一份装的是白天的；窗里的人吃那一份就会在夜景前白得发光。
   * 这个类是普通实例、无静态全局，所以再 new 一个是安全的。
   */
  private charLighting: CharacterLightingSystem | null = null;
  /** gameplay 规则层：窗 → 主世界那条**单向**出口。 */
  private readonly ruleRunner: WindowWorldRuleRunner;
  /** 窗里的环境粒子（第二份 VfxSystem，由 Game 装配）。 */
  private vfx: WindowVfxHandle | null = null;
  /** 这份载荷是哪个场景的；切场景要整份丢掉。 */
  private payloadSceneId: string | null = null;
  private loading = false;

  /** 玩家有没有举着法宝（意图），与"窗装没装好"是两回事。 */
  private wanted = false;
  /** 环境压暗（雷雨压天色）。与主世界同值，见 {@link setEnvDim}。 */
  private envDim = 1;
  /** 开合渐变的当前值 0..1。 */
  private openness = 0;
  /** 最近一次解析出的目标；给调试与"这个场景没夜画"的反馈用。 */
  private lastTarget: WindowWorldTarget | null = null;

  constructor(deps: WindowWorldDeps) {
    this.deps = deps;
    this.ruleRunner = new WindowWorldRuleRunner(deps.rules);
  }

  /** 作者配置的玩法规则（扣血 / 记住你 / 信号前缀）。 */
  applyRules(partial: Partial<WindowWorldRules>): void {
    this.ruleRunner.applyRules(partial);
  }

  get rulesConfig(): Readonly<WindowWorldRules> {
    return this.ruleRunner.current;
  }

  /**
   * 按 id 找窗里的实体。**演出作用域原语**（`runActionsInNightWindow`）用它把
   * 域内动作的目标解析落到窗里那一批——于是气泡 / 特效 / 播动画 / 走位这些
   * **现成动作一个都不用改**，作者照常按场景里的实体 id 写。
   */
  findNpc(id: string) {
    return this.entities?.findNpc(id) ?? null;
  }

  /** 调试 / 取证：谁被看了多久、谁已经记住你了。 */
  get seenDebug(): object {
    return this.ruleRunner.debugState;
  }

  init(_ctx: GameContext): void {
    // 本系统不订阅事件：开关由动作驱动，场景切换由 Game 在卸载时调 unload()。
  }

  /** 作者配置（编辑器写、场景/法宝数据带）。不传的键保留当前值。 */
  applyConeConfig(cfg: Partial<WindowConeConfig>): void {
    this.cone = { ...this.cone, ...cfg };
  }

  get coneConfig(): Readonly<WindowConeConfig> {
    return this.cone;
  }

  /** 这个场景此刻能不能开窗（有没有对面那一副样子）。 */
  canOpen(sceneData: SceneData): boolean {
    return resolveWindowWorldTarget(sceneData, this.deps.getPhase(), this.deps.getPhases()).usable;
  }

  get isOpen(): boolean {
    return this.wanted;
  }

  /** 最近一次解析结果（调试面板 / 无反应时给反馈用）。 */
  get target(): WindowWorldTarget | null {
    return this.lastTarget;
  }

  /**
   * 举起法宝。`sceneData` 传**窗自己那一份**（`AssetManager.loadSceneData` 的深拷贝），
   * 不要传主场景正在用的那个对象——它已被就地改成当前时段的样子了。
   */
  async open(sceneId: string, sceneData: SceneData): Promise<boolean> {
    const target = resolveWindowWorldTarget(sceneData, this.deps.getPhase(), this.deps.getPhases());
    this.lastTarget = target;
    if (!target.usable) {
      depthLog(T, `${sceneId}: 这个场景没有对面那一副样子，法宝无反应`);
      return false;
    }
    // 同一场景同一目标的载荷可以留着复用（收窗不拆，切场景才拆）——法宝会被反复开合。
    if (this.payload && this.payloadSceneId === sceneId && this.payload.target.phase === target.phase) {
      this.wanted = true;
      return true;
    }
    if (this.loading) return false;
    this.loading = true;
    try {
      this.disposePayload();
      const r = await loadWindowWorldPayload(this.deps.assetManager, sceneId, sceneData, target);
      if (!r.payload) {
        depthLog(T, `${sceneId}: 窗户世界载荷装不起来（${r.failure}），法宝无反应`);
        return false;
      }
      const radiance = r.payload.pass.radiance;
      if (!radiance) {
        r.payload.destroy();
        return false;
      }
      this.payload = r.payload;
      this.payloadSceneId = sceneId;
      this.bg = new WindowBackground(
        radiance, r.payload.geo, r.payload.worldWidth, r.payload.worldHeight,
      );
      this.bg.applyParams(r.payload.lighting);
      this.bg.mesh.visible = false;
      this.deps.backgroundLayer.addChild(this.bg.mesh);

      // 实体的楔形判据要与背景同族：自己解一份同一张深度图的 CPU 副本。
      this.cpuDepth = await loadCpuDepthMap(r.payload.depthUrl, r.payload.depthMapping);

      // 窗里角色的受光：装**对面那一段**的角色载荷，再把窗自己那组灯推给它。
      // 顺序抄主场景那条链（load → applyDisplay → applyLightFactors → applyLights）。
      const cl = new CharacterLightingSystem();
      await cl.load(
        sceneId, r.payload.worldWidth, r.payload.worldHeight, r.payload.target.backgroundImage,
      );
      cl.applyDisplay(r.payload.lighting.display ?? null);
      cl.applyLightFactors(r.payload.lighting.lightFactors);
      /**
       * ⚠ `setShadowBasis` **必须排在 `applyLights` 之前**，而且不能省。
       *
       * 它注入的是 q→M-world 那个 det=+1 基。`applyLights` 拿不到基**不会报错**：
       * 它把灯存进 `pendingLights`、打一行"暂缓，等 depthConfig 基注入后重放"，
       * 然后按**没有灯**喂进去。主场景那边的重放由 `rebuildEntityShadows` 触发；
       * 窗不建投影阴影，所以那一次重放**永远不会来** —— 窗里的人于是只剩 probe 底光。
       *
       * 2026-09-21 在雾津街头量到的就是这个：控制台明写「8 盏已打包，等基注入后重放」，
       * 画面上送葬队伍比真夜暗三成，而夜里照着他们的恰恰是那 6 盏街灯。
       *
       * 基取**窗自己载荷**里那一份（`geo.mRows` ← `depthConfig.M.R`），不问主场景要：
       * 各时段共享几何是硬契约，两边本来就是同一个矩阵，而自带的那份不会随主场景切换失效。
       */
      const R = r.payload.geo.mRows;
      cl.setShadowBasis([...R[0], ...R[1], ...R[2]]);
      cl.applyLights(r.payload.pass.packedLights ?? null, r.payload.geo.wuPerQUnit);
      this.charLighting = cl;
      // 开窗这一刻主世界可能正压着天色（雷雨）：补推一次，别让窗先亮一下再跟上。
      if (this.envDim < 1) {
        cl.setEnvDim(this.envDim);
        this.pushEffectiveDisplay();
      }

      // 窗里的实体：从**窗自己那份**场景数据实例化，状态用**拷来的**场景记忆。
      this.entities = new WindowWorldEntities({
        assetManager: this.deps.assetManager,
        characterRegistry: this.deps.characterRegistry(),
        litShaderProvider: () => this.windowLitShaderProvider(),
        makeOcclusionFilter: (blend) => this.deps.makeOcclusionFilter(blend),
        perspectiveScale: () => this.deps.perspectiveScale(),
        pixelDensityMatch: () => this.deps.pixelDensityMatch(),
      });
      // 挂在窗背景**之上**、主场景实体之下：楔形从角色往外张开，窗里的东西
      // 永远比玩家远，压在玩家下面是对的。
      this.deps.backgroundLayer.addChild(this.entities.container);
      await this.entities.build(
        sceneData, target.phase,
        this.deps.snapshotSceneMemory(sceneId),
        this.deps.getNpcDefaultPhases(),
      );

      // 环境粒子：按**对面那一段**的布置出粒子（崖墓入口的夜就配了萤火）。
      // 装不起来就没有粒子，不影响窗本身——烘焙 / 布置缺省不许把别的搞坏。
      if (this.deps.attachVfx && this.entities) {
        // 灯按目标时段筛一次再给——与辐射场那一级 applyParams(def, target.phase) 同口径。
        const all = r.payload.lighting.lights ?? [];
        this.vfx = this.deps.attachVfx({
          layer: this.entities.container,
          lighting: cl,
          appearancePhase: target.phase,
          lights: all.filter((l) => !l.phases?.length || l.phases.includes(target.phase)),
          sceneData,
        });
      }

      this.wanted = true;
      return true;
    } finally {
      this.loading = false;
    }
  }

  /**
   * 窗自己那份 shader 提供者：与主场景的 `litShaderProvider` 同形，只是绑在**窗的**
   * 照明载荷上。统一角色路径已停用，所以这里只有 `createEntityLitShader` 这一条。
   */
  private windowLitShaderProvider(): LitShaderProvider | null {
    const cl = this.charLighting;
    if (!cl) return null;
    const am = this.deps.assetManager;
    return {
      create: (colorTex, sheetUrl) =>
        cl.createEntityLitShader(colorTex, getNormalAtlasSource(am, sheetUrl)),
      swapTextures: (sh, colorTex, sheetUrl) =>
        cl.swapEntityLitTextures(sh, colorTex, getNormalAtlasSource(am, sheetUrl)),
      release: (sh) => cl.releaseEntityLitShader(sh),
    };
  }

  /**
   * 每**渲染**帧同步窗里角色的共享帧组。由 Game 挂在与主场景 `syncFrame` **同一个**
   * Pixi ticker 回调里 —— 刻意不放进本系统的 `update(dt)`：那条路挂在游戏 tick 上，
   * 断点冻结 / 定帧模式会整段跳过，于是这一组会冻在上一帧（主场景那边为此写了两处警告）。
   *
   * ⚠ 这一组**不是"位姿而已"**。`uMode`（走哪本 probe 图集）、曝光三项倍率、
   *   `uBulge`、AO 全在里头，而它们只有 `syncFrame` 这一个出口。不同步 = 整组停在
   *   `createFrameLitUniforms()` 的构造缺省上，而那份缺省与真实载荷对不上：
   *
   *   · `uMode` 缺省 **2**（SH L2），载荷烘的是 **3**（八面体，2026-09-02 正式档）。
   *     `load()` 只给当前 mode 建真图集，另两种是 1×1 占位 —— shader 于是去采那张
   *     占位图：`E ≡ 0`，窗里的人**一片黑**。
   *   · `uTotalFactor` 缺省 1，雾津街头那份 `beta=4.2` 算出来约 5.9 —— 就算 mode 对了
   *     也还差着六倍。
   *
   *   两条都**零报错**。2026-09-21 就是这么黑掉整支送葬队伍的。
   */
  syncRenderFrame(wcX: number, wcY: number, projectionScale: number, ao: { contact: number; form: number }): void {
    const cl = this.charLighting;
    if (!cl) return;
    // AO 不自己算：主世界算好的那两个数直接借过来，窗里窗外一个口径。
    cl.setSharedAO(ao.contact, ao.form);
    cl.syncFrame(wcX, wcY, projectionScale);
  }

  /**
   * 环境压暗（雷雨压天色）。**必须与主世界同值**：窗不跟，暴雨里这扇窗就是一个亮洞。
   *
   * 两头都要推，跟主世界那个唯一入口（`Game.applyEnvDim`）同形：
   * 背景走显示曝光（`display.ev` 是 log2 的量，×s ⇔ ev + log2(s)），
   * 角色/粒子走总受光倍率（`CharacterLightingSystem.setEnvDim`）——两条链的实现完全不同，
   * 只压一边就是人浮在背景上。
   */
  setEnvDim(scale: number): void {
    const s = Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : 1;
    if (Math.abs(s - this.envDim) < 1e-4) return;
    this.envDim = s;
    this.charLighting?.setEnvDim(s);
    this.pushEffectiveDisplay();
  }

  /** 把当前压暗档推进窗自己的辐射场。开窗时也要补一次（开窗那一刻可能正在下雨）。 */
  private pushEffectiveDisplay(): void {
    const p = this.payload;
    if (!p) return;
    // s=0 时 log2 是 -∞，按"全黑"给一个足够深的档，不让 NaN 流进 shader（抄主场景那份）。
    const def = this.envDim >= 1
      ? p.lighting
      : {
        ...p.lighting,
        display: {
          ...p.lighting.display,
          ev: p.lighting.display.ev + (this.envDim > 0 ? Math.log2(this.envDim) : -24),
        },
      };
    p.pass.applyParams(def, p.target.phase);
    p.pass.markDirty();
  }

  /**
   * 「这个场景坐标下的**地**在 M-world 的哪儿」。楔形顶点与窗里实体的落点都问它。
   *
   * 走窗自己那份角色照明载荷的行走面（`chestQAt(x, y, 0)` ⇒ 不抬胸口 = 脚点的 q），
   * 再按同一套 M 转成 wu。用的是与遮挡 / 阴影 / 着色**同一个采样器**（那边的注释写死了
   * 这一条），所以窗里"人站在哪"与"人被怎么照"永远是同一个地面。
   *
   * 取不到（几何项没装起来）返回 null，调用方回落 `depth_map` 那条 —— 降级不报错，
   * 但降级后就会有遮挡物误判（见 {@link GroundWorldSampler}）。
   */
  private readonly groundWorldAt: GroundWorldSampler = (sceneX, sceneY) => {
    const cl = this.charLighting;
    const p = this.payload;
    if (!cl || !p) return null;
    const q = cl.chestQAt(sceneX, sceneY, 0);
    return q ? qToWorldWu(p.geo, q) : null;
  };

  /** 收起法宝。载荷留着（同场景反复开合不重装），只是渐隐。 */
  close(): void {
    this.wanted = false;
  }

  /** 切场景：整份丢掉。`destroy()` 与它同一条路。 */
  unload(): void {
    this.wanted = false;
    this.openness = 0;
    this.lastTarget = null;
    // 三把火那条显示请求必须撤：窗没了火还亮着，玩家会以为自己还在界外面。
    this.ruleRunner.reset();
    this.disposePayload();
  }

  private disposePayload(): void {
    /**
     * ⚠ 拆的顺序就是**绑的反序**，一步都不能乱（见 [[pixi-v8-traps]] 第一条）：
     *
     *   粒子 → 实体 → 角色照明载荷 → 窗背景 mesh → 辐射场
     *
     * 粒子与实体的 shader 绑着角色照明载荷的纹理，窗背景绑着辐射场的 RT。
     * 先销毁被绑的一方，BindGroup 见到已销毁的资源就把自己作废，**下一帧渲染即抛**——
     * 而那一抛发生在渲染路径上：不是掉一帧，是 ticker 再不排帧、整局死透。
     */
    this.vfx?.destroy();
    this.vfx = null;
    this.entities?.destroy();
    this.entities = null;
    this.charLighting?.destroy();
    this.charLighting = null;
    this.cpuDepth = null;
    if (this.bg) {
      this.bg.mesh.parent?.removeChild(this.bg.mesh);
      this.bg.destroy();
      this.bg = null;
    }
    this.payload?.destroy();
    this.payload = null;
    this.payloadSceneId = null;
  }

  update(dt: number): void {
    // 开合渐变
    const speed = this.cone.fadeSeconds > 0 ? dt / this.cone.fadeSeconds : 1e9;
    this.openness = this.wanted
      ? Math.min(1, this.openness + speed)
      : Math.max(0, this.openness - speed);

    const bg = this.bg;
    const payload = this.payload;
    if (!bg || !payload) return;

    if (this.openness <= 0) {
      bg.mesh.visible = false;
      this.entities?.update(dt, this.groundWorldAt, null);
      this.ruleRunner.update(dt, false, this.cone.farWu, []);
      return;
    }

    const apexUv = this.deps.getApexUv();
    const aimUv = this.deps.getAimUv();
    // 顶点 = 玩家脚下那块**地**。行走面取不到才回落 `depth_map`（降级路，见 groundWorldAt）。
    const apexWorld = (apexUv && this.cpuDepth)
      ? (this.groundWorldAt(apexUv[0] * payload.worldWidth, apexUv[1] * payload.worldHeight)
        ?? uvToWorldWu(payload.geo, this.cpuDepth, apexUv[0], apexUv[1]))
      : null;
    // 瞄准点还没有（指针一次都没动过）时不画：比随便挑个方向先扫一下好，
    // 那种"一开窗先朝某处闪一下"最难查。指针一动立刻就有。
    const solved: SolvedCone | null = (apexWorld && aimUv && this.cpuDepth)
      ? solveCone(payload.geo, this.cpuDepth, apexWorld, aimUv, {
        halfAngleDeg: this.cone.halfAngleDeg,
        softAngleDeg: this.cone.softAngleDeg,
        nearWu: this.cone.nearWu,
        farWu: this.cone.farWu,
        softRangeWu: this.cone.softRangeWu,
        heightDownWu: this.cone.heightDownWu,
        heightUpWu: this.cone.heightUpWu,
        softHeightWu: this.cone.softHeightWu,
        apexLiftWu: this.cone.apexLiftWu,
        opacity: this.openness,
      })
      : null;

    // 实体照常推进（动画 / 巡逻不因为看不见就停），只是按楔形给 alpha。
    const samples: SeenSample[] = this.entities?.update(dt, this.groundWorldAt, solved) ?? [];
    this.vfx?.update(dt);
    // 看是双向的：同一个遮罩值既决定它现不现身，也决定它有没有看见你。
    this.ruleRunner.update(dt, solved !== null, this.cone.farWu, samples);

    if (!solved) { bg.mesh.visible = false; return; }

    const cone: WindowConeParams = {
      apex: solved.apex,
      axisH: solved.axisH,
      halfAngleDeg: this.cone.halfAngleDeg,
      range: [this.cone.nearWu, this.cone.farWu],
      height: [this.cone.heightDownWu, this.cone.heightUpWu],
      soft: [this.cone.softAngleDeg, this.cone.softRangeWu, this.cone.softHeightWu],
      opacity: this.openness,
    };
    bg.applyCone(cone);
    bg.mesh.visible = true;

    // 辐射场：脏时才重算（灯是静态的，稳态每帧零光照计算）。
    const r = this.deps.getPixiRenderer();
    if (r) payload.pass.update(r);
  }

  serialize(): object {
    // 窗是当场的东西，不进存档：读档回来法宝该是收着的。
    return {};
  }

  deserialize(_data: object): void {
    this.unload();
  }

  destroy(): void {
    this.unload();
  }
}
