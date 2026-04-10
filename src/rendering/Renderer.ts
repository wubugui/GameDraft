import { Application, Container, type Filter } from 'pixi.js';
import { WorldFilterPipeline, loadFilter } from './filter';

/** Pixi 类型未包含 null，运行时必须赋 null 以断开 auto-resize */
function setAppResizeTo(app: Application, target: Window | HTMLElement | null): void {
  (app as unknown as { resizeTo: Window | HTMLElement | null }).resizeTo = target;
}

export class Renderer {
  public app: Application;
  public worldContainer: Container;
  public backgroundLayer: Container;
  public entityLayer: Container;
  /** 演出用覆盖层：图片、电影黑边等，位于世界之上、UI之下 */
  public cutsceneOverlay: Container;
  public uiLayer: Container;

  /** 世界滤镜管线：仅作用于 worldContainer（场景+实体），GUI 不受影响 */
  public worldFilterPipeline: WorldFilterPipeline;

  private initialized = false;
  /** Application 已 destroy 后为 true，尺寸访问需降级避免异常 */
  private tornDown = false;
  private mountObserver: ResizeObserver | null = null;
  /** app.resize() 之后通知（此时 app.screen 已更新），供 Camera 等与画布像素对齐 */
  private afterResizeCallbacks = new Set<() => void>();

  private viewportWidth = 0;
  private viewportHeight = 0;

  constructor() {
    this.app = new Application();
    this.worldContainer = new Container();
    this.backgroundLayer = new Container();
    this.entityLayer = new Container();
    this.cutsceneOverlay = new Container();
    this.uiLayer = new Container();
    this.worldFilterPipeline = new WorldFilterPipeline(this.worldContainer);
  }

  async init(): Promise<void> {
    const mount = document.getElementById('game-mount');

    await this.app.init({
      background: '#1a1a2e',
      resizeTo: mount ?? window,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    const canvas = this.app.canvas as HTMLCanvasElement;
    if (mount) mount.appendChild(canvas);
    else document.body.appendChild(canvas);

    this.worldContainer.addChild(this.backgroundLayer);
    this.worldContainer.addChild(this.entityLayer);

    this.app.stage.addChild(this.worldContainer);
    this.app.stage.addChild(this.cutsceneOverlay);
    this.app.stage.addChild(this.uiLayer);

    if (mount) {
      this.mountObserver = new ResizeObserver(() => {
        if (this.initialized && !this.tornDown) {
          if (this.viewportWidth > 0 && this.viewportHeight > 0) {
            return;
          }
          this.app.resize();
          this.notifyAfterResize();
        }
      });
      this.mountObserver.observe(mount);
    }

    this.initialized = true;
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
    for (const cb of this.afterResizeCallbacks) {
      try {
        cb();
      } catch (e) {
        console.warn('Renderer: afterResize callback failed', e);
      }
    }
  }

  /**
   * 设置逻辑视口大小（内部渲染分辨率）。
   * 游戏在此分辨率下渲染，canvas 通过 CSS 铺满容器 --
   * 纯粹是渲染完成后的显示变换，不干预 Camera/Stage 等游戏内坐标管线。
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
    } else {
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
   * 设置游戏容器（#game-mount）的 CSS 尺寸，作为"窗口大小"。
   * 纯 CSS 层面，不影响渲染分辨率或游戏内坐标。
   * 传 0,0 恢复为填满浏览器窗口。
   */
  setWindowSize(width: number, height: number): void {
    const mount = document.getElementById('game-mount');
    if (!mount) return;
    if (width > 0 && height > 0) {
      mount.style.width = `${width}px`;
      mount.style.height = `${height}px`;
      mount.style.maxWidth = '100vw';
      mount.style.maxHeight = '100vh';
    } else {
      mount.style.width = '100%';
      mount.style.height = '100%';
      mount.style.maxWidth = '';
      mount.style.maxHeight = '';
    }
    if (this.initialized && !this.tornDown && !(this.viewportWidth > 0 && this.viewportHeight > 0)) {
      this.app.resize();
      this.notifyAfterResize();
    }
  }

  /**
   * 实体前后次序：按子树根节点世界脚底 y（与 SpriteEntity anchor 底中、碰撞/深度脚点一致）。
   */
  sortEntityLayer(): void {
    this.entityLayer.children.sort((a, b) => a.y - b.y);
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

    if (this.mountObserver) {
      this.mountObserver.disconnect();
      this.mountObserver = null;
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
    const filter = await loadFilter(filterId);
    this.setWorldFilter(filter);
  }

  /**
   * 清除世界滤镜
   */
  clearWorldFilter(): void {
    this.worldFilterPipeline.clear();
  }
}
