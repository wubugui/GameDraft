import { Application, Container, RendererType, type Filter } from 'pixi.js';
import type { RhiDevice } from './rhi';
import { WorldFilterPipeline, loadFilter } from './filter';
import { entitySortZ, type EntitySortBand } from './entitySortRule';
import { CanvasStage } from './CanvasStage';
import { containBox } from './viewportFit';
import { describeError, reportDevError } from '../core/devErrorOverlay';
import type { AssetManager } from '../core/AssetManager';

/** 图形后端:`webgl` = 原路径;`webgpu` = Pixi 跑在 RHI 的 WebGPU 设备上(迁移期,开发开关 `?renderer=webgpu`) */
export type RendererBackend = 'webgl' | 'webgpu';

/** 同一条渲染错误每复现多少帧打一次日志(它通常每帧都在,全打会把控制台冲爆) */
const RENDER_ERROR_REPEAT_LOG_EVERY = 300;

/** Pixi 类型未包含 null，运行时必须赋 null 以断开 auto-resize */
function setAppResizeTo(app: Application, target: Window | HTMLElement | null): void {
  (app as unknown as { resizeTo: Window | HTMLElement | null }).resizeTo = target;
}

export class Renderer {
  public app: Application;
  public worldContainer: Container;
  public backgroundLayer: Container;
  /** 投影阴影层：世界单位，位于背景之上、实体之下 */
  public shadowLayer: Container;
  public entityLayer: Container;
  /**
   * **画布**：场景之外那张屏幕空间的面（叠图 / 文档揭示 / 实体 / 特效共用一个 `order` 顺序空间）。
   * 位于世界之上、`cutsceneOverlay` 之下——画布是"画面"的一部分，所以过场的字幕、电影黑边、
   * 对白框在它之上；但它不是世界，所以不吃相机变换、不吃世界滤镜。规则见 {@link CanvasStage}。
   */
  public canvasStage: CanvasStage;
  /**
   * **世界渐黑**那一层（`fadeWorldToBlack`）：位于世界之上、**画布之下**。
   *
   * 它只黑掉世界；画布（场景之外的面）上的东西照样画在黑场上。这是 2026-09-21 画布落地后
   * **还原**出来的行为：迁移前渐黑与叠图同在 `cutsceneOverlay`，谁在上面取决于谁先加进去，
   * 而现有内容里唯一两者重叠的用法（梦段 D 「先渐黑、再出盖脸纸」）要的正是图在黑场上。
   * 摆在 `cutsceneOverlay` 里就会把盖脸纸整张吞掉（不报错，只是一片黑）。
   */
  public worldFadeLayer: Container;
  /** 演出用覆盖层：字幕、电影黑边、对白框、小游戏等，位于画布之上、UI之下 */
  public cutsceneOverlay: Container;
  public uiLayer: Container;

  /** 世界滤镜管线：仅作用于 worldContainer（场景+实体），GUI 不受影响 */
  public worldFilterPipeline: WorldFilterPipeline;
  private assetManager: AssetManager | null = null;

  private initialized = false;
  /** Application 已 destroy 后为 true，尺寸访问需降级避免异常 */
  private tornDown = false;
  /**
   * 盯的是 **舞台**（`#game-stage`，宿主给游戏的可用区域），不是画面盒 `#game-mount`：
   * 画面盒的尺寸是本类按舞台算出来的，盯它自己会自激。
   */
  private stageObserver: ResizeObserver | null = null;
  /** app.resize() 之后通知（此时 app.screen 已更新），供 Camera 等与画布像素对齐 */
  private afterResizeCallbacks = new Set<() => void>();

  private viewportWidth = 0;
  private viewportHeight = 0;
  /** `game_config.windowSize`：宿主窗口的期望尺寸（编辑器预览窗 / exe 窗按它开）。只记录，不参与布局。 */
  private preferredWindowSize: { width: number; height: number } | null = null;

  /**
   * 图形后端(迁移期)。`webgl` = 与 master 完全相同的原路径;`webgpu` = RHI 持有 WebGPU 设备,
   * Pixi 的 WebGPU 渲染器跑在同一个设备上(见 agent_docs rhi 卡「迁移期结构」)。
   */
  backend: RendererBackend = 'webgl';
  /** `backend === 'webgpu'` 时的 RHI 设备(设备的所有者;Pixi 不销毁它) */
  rhi: RhiDevice | null = null;

  constructor() {
    this.app = new Application();
    this.worldContainer = new Container();
    this.backgroundLayer = new Container();
    this.shadowLayer = new Container();
    this.entityLayer = new Container();
    this.worldFadeLayer = new Container();
    this.canvasStage = new CanvasStage();
    this.cutsceneOverlay = new Container();
    this.uiLayer = new Container();
    this.worldFilterPipeline = new WorldFilterPipeline(this.worldContainer);
  }

  setAssetManager(assetManager: AssetManager): void {
    this.assetManager = assetManager;
  }

  /**
   * 渲染抛错不得打死主循环(审批红线「玩家输入可能永久锁死」)。
   *
   * Pixi 的 `Ticker._tick` 是这么写的:
   * ```js
   * this._requestId = null;
   * if (this.started) {
   *   this.update(time);                                        // ← render 在这里
   *   if (this.started && this._requestId === null && ...)
   *     this._requestId = requestAnimationFrame(this._tick);    // ← 抛了就永远走不到
   * }
   * ```
   * 任何从 render 逃出来的异常都让"排下一帧"那行失效:`started` 仍是 true,却再没有
   * 人申请 rAF。后果不是掉一帧,是整局死透 —— 画面定格、输入全无、在途的切场景
   * (淡入淡出吃 ticker)永久悬住,只能刷页面。实测一次 BindGroup 自毁就够
   * (2026-09-01,dev 模式跳场景)。
   *
   * 所以这里把异常按在 render 里:照旧大声报(dev 弹错误面 + 控制台),但绝不让它
   * 逃到 ticker。丢一帧远好过丢一整局。**这是兜底,不是遮丑** —— 报出来的每一条
   * 都仍是必须查的 bug。
   */
  private installRenderCrashGuard(): void {
    const basePrototypeRender = Application.prototype.render;
    let lastMessage = '';
    let repeats = 0;
    const guarded = function guardedRender(this: Application): void {
      try {
        basePrototypeRender.call(this);
      } catch (e) {
        const message = describeError(e);
        if (message === lastMessage) {
          // 同一条错误通常每帧都复现;折叠计数,别把控制台冲爆(也别掩盖掉它还在发生)
          repeats++;
          if (repeats % RENDER_ERROR_REPEAT_LOG_EVERY === 0) {
            console.error(`[render] 渲染抛错已重复 ${repeats} 次(已拦下):${message}`, e);
          }
          return;
        }
        lastMessage = message;
        repeats = 0;
        console.error('[render] 渲染抛错,已拦下以免主循环停摆:', e);
        reportDevError(`渲染抛错(已拦下,主循环继续):${message}`, '[render]');
      }
    };
    (this.app as Application & { render: () => void }).render = guarded;
  }

  async init(options: { resolution?: number; backend?: RendererBackend } = {}): Promise<void> {
    const mount = document.getElementById('game-mount');
    const resolution = Number.isFinite(options.resolution) && (options.resolution ?? 0) > 0
      ? Number(options.resolution)
      : (window.devicePixelRatio || 1);

    // ⚠ 必须在 app.init() **之前**装:TickerPlugin 在 init 里就把 `this.render` 的函数
    // 引用交给 ticker 了(`ticker.add(this.render, this, LOW)`),init 之后再覆盖实例属性
    // 就没有人看得见。
    this.installRenderCrashGuard();

    const backend = options.backend ?? 'webgl';
    let gpuOptions = {};
    if (backend === 'webgpu') {
      // 只有选了 WebGPU 才加载 RHI / luma 与 Pixi 补丁:缺省路径的包体与行为都与 master 相同
      const [{ createRhiDevice }, { installPixiWebGpuPatches }] = await Promise.all([
        import('./rhi'),
        import('./legacy/pixiWebGpuPatches'),
      ]);
      // RHI 持有 GPUDevice;迁移期画布由 Pixi 呈现,RHI 自己暂不上屏,给它一张不挂 DOM 的画布
      this.rhi = await createRhiDevice({ canvas: document.createElement('canvas'), useDevicePixels: false, autoResize: false });
      installPixiWebGpuPatches();
      gpuOptions = {
        preference: 'webgpu',
        webgpu: { gpu: { adapter: this.rhi.native.adapter, device: this.rhi.native.device } },
      };
    }

    await this.app.init({
      background: '#1a1a2e',
      resizeTo: mount ?? window,
      antialias: false,
      resolution,
      autoDensity: true,
      ...gpuOptions,
    });
    // Pixi 选不上首选后端会悄悄换下一个;这里不许悄悄换(没有 WebGPU 就明确失败)
    if (backend === 'webgpu' && this.app.renderer.type !== RendererType.WEBGPU) {
      throw new Error(`要求 WebGPU 渲染,实际得到 ${this.app.renderer.name}(Pixi 回落了)`);
    }
    this.backend = backend;

    const canvas = this.app.canvas as HTMLCanvasElement;
    if (mount) mount.appendChild(canvas);
    else document.body.appendChild(canvas);

    this.worldContainer.addChild(this.backgroundLayer);
    this.worldContainer.addChild(this.shadowLayer);
    this.entityLayer.sortableChildren = true;
    this.worldContainer.addChild(this.entityLayer);

    this.app.stage.addChild(this.worldContainer);
    this.app.stage.addChild(this.worldFadeLayer);
    this.app.stage.addChild(this.canvasStage.layer);
    this.app.stage.addChild(this.cutsceneOverlay);
    this.app.stage.addChild(this.uiLayer);

    if (mount) {
      // 舞台 = 画面盒的父元素（index.html 的 #game-stage：#app-shell 里除 F2 调试坞之外的全部区域）。
      // 没有父元素的异常挂载（测试/裸页）退回盯画面盒自己，行为与旧版一致。
      const stage = mount.parentElement ?? mount;
      this.stageObserver = new ResizeObserver(() => {
        if (!this.initialized || this.tornDown) return;
        if (this.viewportWidth > 0 && this.viewportHeight > 0) {
          // 固定视口：逻辑分辨率不变（app.screen 不动，UI/相机不需要重算），只按舞台的新尺寸
          // 重摆等比显示盒。**同步做**，不等 rAF：这只是改两条 CSS，ResizeObserver 回调本就在
          // 布局之后、绘制之前；推到 rAF 会多画一帧旧尺寸，隐藏页（rAF 停摆）更是永远不更新。
          // 以前这里直接 return，画面盒跟着 CSS 走 = 非等比拉伸。
          this.layoutMount();
          return;
        }
        requestAnimationFrame(() => {
          if (!this.initialized || this.tornDown) return;
          this.app.resize();
          this.notifyAfterResize();
        });
      });
      this.stageObserver.observe(stage);
    }

    this.initialized = true;
  }

  /**
   * 把画面盒 `#game-mount` 摆成舞台里**最大的同比例盒**（固定视口时），或铺满舞台（自由视口时）。
   *
   * 这是"逻辑分辨率固定、显示只许等比缩放"这条规则唯一的落地点。canvas 始终 100%×100% 填画面盒，
   * DOM 覆盖层（触屏 HUD、F2 常驻卡、编辑模式 HUD）都挂在画面盒上，跟着它一起居中、一起缩放。
   */
  private layoutMount(): void {
    const mount = document.getElementById('game-mount');
    if (!mount) return;
    if (!(this.viewportWidth > 0 && this.viewportHeight > 0)) {
      mount.style.width = '100%';
      mount.style.height = '100%';
      return;
    }
    const stage = mount.parentElement ?? mount;
    const rect = stage.getBoundingClientRect();
    const box = containBox(rect.width, rect.height, this.viewportWidth, this.viewportHeight);
    if (box.scale <= 0) return;   // 舞台还没布局出来（0×0）：等 ResizeObserver 下一拍
    mount.style.width = `${box.width}px`;
    mount.style.height = `${box.height}px`;
  }

  /**
   * 在画布尺寸变化且已 app.resize() 后调用回调（例如 #game-mount 被 flex 侧栏挤压）。
   * @returns 取消订阅
   */
  subscribeAfterResize(cb: () => void): () => void {
    this.afterResizeCallbacks.add(cb);
    return () => this.afterResizeCallbacks.delete(cb);
  }

  private notifyAfterResize(): void {
    // 画布上的 item 按屏幕百分比定位，尺寸一变必须重摆；放在订阅者之前，
    // 免得订阅方（CutsceneRenderer 的 relayoutForScreenSize 等）读到还没重摆的位置。
    try {
      this.canvasStage.relayout(this.screenWidth, this.screenHeight);
    } catch (e) {
      console.warn('Renderer: canvasStage relayout failed', e);
    }
    for (const cb of this.afterResizeCallbacks) {
      try {
        cb();
      } catch (e) {
        console.warn('Renderer: afterResize callback failed', e);
      }
    }
  }

  /**
   * 设置逻辑视口大小（内部渲染分辨率，`game_config.viewport`）。
   * 游戏在此分辨率下渲染；canvas 铺满画面盒 `#game-mount`，而画面盒由 {@link layoutMount}
   * 按舞台尺寸**等比**摆放（信箱/柱箱）——纯粹是渲染完成后的显示变换，
   * 不干预 Camera/Stage 等游戏内坐标管线，`app.screen` 恒为这个尺寸。
   * 传 0,0 取消固定视口，恢复跟随容器自动 resize。
   */
  setViewportSize(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;

    const app = this.app as Application & { cancelResize?: () => void };

    if (width > 0 && height > 0) {
      try { app.cancelResize?.(); } catch { /* ignore */ }
      try { setAppResizeTo(this.app, null); } catch { /* ignore */ }

      this.app.renderer.resize(width, height);

      const canvas = this.app.canvas as HTMLCanvasElement;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      this.layoutMount();
    } else {
      this.layoutMount();   // 画面盒回到 100%×100%
      const mount = document.getElementById('game-mount');
      if (mount) {
        try { setAppResizeTo(this.app, mount); } catch { /* ignore */ }
      }
      this.app.resize();
    }

    this.notifyAfterResize();
  }

  getViewportSize(): { width: number; height: number } | null {
    if (this.viewportWidth > 0 && this.viewportHeight > 0) {
      return { width: this.viewportWidth, height: this.viewportHeight };
    }
    return null;
  }

  /**
   * 记录 `game_config.windowSize`——**宿主窗口**的期望尺寸。
   *
   * 它由宿主消费：编辑器 F5 按它开预览窗（`tools/editor/main_window.py`），exe 按它开 Tauri 窗
   * （`src-tauri/src/main.rs` 启动时读同一份 game_config.json）。前端**不再**据此改画面盒的 CSS：
   * 画面盒永远由舞台尺寸 + 视口比例算出（{@link layoutMount}），窗口是多大就在里面等比放多大。
   *
   * 以前这里把 `#game-mount` 写死成 `windowSize` 像素并 `max-height:100vh` 封顶，配上 F2 调试坞
   * CSS 的 `flex:1 1 auto`，画面盒实际是"横向撑满窗口、竖向封顶 768"——任何非 4:3 窗口都非等比拉伸。
   * 传 0,0 = 没配 windowSize。
   */
  setWindowSize(width: number, height: number): void {
    this.preferredWindowSize = width > 0 && height > 0 ? { width, height } : null;
  }

  /** `game_config.windowSize`（宿主窗口期望尺寸）；没配返回 null。 */
  getPreferredWindowSize(): { width: number; height: number } | null {
    return this.preferredWindowSize;
  }

  /**
   * 实体前后次序：按子树根节点世界脚底 y（与 SpriteEntity anchor 底中、碰撞/深度脚点一致）。
   * 带展示图且 `spriteSort` 为 back/front 的热点容器会标 `entitySortBand`，此处写入 zIndex 后 sortChildren。
   *
   * 碰撞多边形遮挡：热点若携带 `entityOcclusionPolygon`（世界坐标），则用玩家脚点做竖直扫描线判定：
   * - 玩家在多边形下方（near side）→ 热点排在玩家后面（back band）
   * - 玩家在多边形上方（far side）或内部 → 热点排在玩家前面（front band）
   * 该逻辑优先级高于静态 `entitySortBand`。
   *
   * **规则本体在 {@link entitySortZ}（`./entitySortRule`），本方法只负责遍历与 sortChildren。**
   * 场景编辑器画布按同一条规则派 z（Python 镜像 `tools/editor/shared/entity_sort_math.py`），
   * 两侧由 parity 测试钉死同一组黄金用例 —— 改规则必须改那一处，不要在这里就地改。
   */
  sortEntityLayer(playerFootX?: number, playerFootY?: number): void {
    for (const child of this.entityLayer.children) {
      const ext = child as {
        entitySortBand?: EntitySortBand;
        entityOcclusionPolygon?: ReadonlyArray<{ x: number; y: number }>;
        /** 实例旋转实体的变换后接地线 y（实体自身维护）；缺省用容器 y（锚点） */
        entitySortFootY?: number;
      };
      child.zIndex = entitySortZ(
        {
          band: ext.entitySortBand,
          occlusionPolygon: ext.entityOcclusionPolygon,
          sortFootY: ext.entitySortFootY,
          y: child.y,
        },
        playerFootX,
        playerFootY,
      );
    }
    this.entityLayer.sortChildren();
  }

  get screenWidth(): number {
    if (this.tornDown || !this.initialized) {
      return typeof window !== 'undefined' ? window.innerWidth : 800;
    }
    try {
      const w = this.app.screen.width;
      if (Number.isFinite(w)) return w;
    } catch {
      /* Application 正在或已 teardown 时 Pixi 可能抛错 */
    }
    return typeof window !== 'undefined' ? window.innerWidth : 800;
  }

  get screenHeight(): number {
    if (this.tornDown || !this.initialized) {
      return typeof window !== 'undefined' ? window.innerHeight : 600;
    }
    try {
      const h = this.app.screen.height;
      if (Number.isFinite(h)) return h;
    } catch {
      /* 同上 */
    }
    return typeof window !== 'undefined' ? window.innerHeight : 600;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  destroy(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    this.initialized = false;
    this.afterResizeCallbacks.clear();

    if (this.stageObserver) {
      this.stageObserver.disconnect();
      this.stageObserver = null;
    }

    this.worldFilterPipeline.clear();

    const app = this.app as Application & { cancelResize?: () => void };
    try {
      app.cancelResize?.();
    } catch {
      /* ignore */
    }
    try {
      // 先断开 resizeTo，避免 ResizePlugin.destroy 里 _cancelResize 已不可靠（Pixi v8 + HMR/重复卸载）
      setAppResizeTo(this.app, null);
    } catch {
      /* ignore */
    }
    try {
      app.destroy(true);
    } catch (e) {
      console.warn('Renderer: Application.destroy failed', e);
    }
    // 设备归 RHI:Pixi 拆完再拆设备(Pixi 自己从不销毁传进去的设备)
    try {
      this.rhi?.destroy();
    } catch (e) {
      console.warn('Renderer: RHI destroy failed', e);
    }
    this.rhi = null;
  }

  // ---------- 世界滤镜 API（仅作用于 worldContainer，GUI 不受影响） ----------

  /**
   * 设置世界滤镜栈，支持多个 shader 效果串联
   */
  setWorldFilters(filters: Filter[]): void {
    this.worldFilterPipeline.setFilters(filters);
  }

  /**
   * 设置单个世界滤镜
   */
  setWorldFilter(filter: Filter | null): void {
    this.worldFilterPipeline.setFilters(filter ? [filter] : []);
  }

  /**
   * 加载滤镜 JSON 并应用到世界
   * @param filterId assets/data/filters/{filterId}.json
   */
  async loadAndSetWorldFilter(filterId: string): Promise<void> {
    const filter = this.assetManager
      ? await this.assetManager.loadFilter(filterId)
      : await loadFilter(filterId);
    this.setWorldFilter(filter);
  }

  /**
   * 清除世界滤镜
   */
  clearWorldFilter(): void {
    this.worldFilterPipeline.clear();
  }

  getDebugRenderState(): Record<string, unknown> {
    return {
      worldX: this.worldContainer.x,
      worldY: this.worldContainer.y,
      worldScaleX: this.worldContainer.scale.x,
      worldScaleY: this.worldContainer.scale.y,
      worldFilterCount: this.worldFilterPipeline.getFilters().length,
      worldFilterApplied: this.worldContainer.filters !== null && this.worldContainer.filters.length > 0,
    };
  }
}
