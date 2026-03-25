import { Application, Container, type Filter } from 'pixi.js';
import { WorldFilterPipeline, loadFilter } from './filter';

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
    await this.app.init({
      background: '#1a1a2e',
      resizeTo: window,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    document.body.appendChild(this.app.canvas as HTMLCanvasElement);

    this.worldContainer.addChild(this.backgroundLayer);
    this.worldContainer.addChild(this.entityLayer);

    this.app.stage.addChild(this.worldContainer);
    this.app.stage.addChild(this.cutsceneOverlay);
    this.app.stage.addChild(this.uiLayer);

    this.initialized = true;
  }

  sortEntityLayer(): void {
    this.entityLayer.children.sort((a, b) => a.y - b.y);
  }

  get screenWidth(): number {
    return this.app.screen.width;
  }

  get screenHeight(): number {
    return this.app.screen.height;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  destroy(): void {
    this.worldFilterPipeline.clear();
    this.app.destroy(true);
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
