import { Application, Container } from 'pixi.js';

export class Renderer {
  public app: Application;
  public worldContainer: Container;
  public backgroundLayer: Container;
  public entityLayer: Container;
  public foregroundLayer: Container;
  /** 演出用覆盖层：图片、电影黑边等，位于世界之上、UI之下 */
  public cutsceneOverlay: Container;
  public uiLayer: Container;

  private initialized = false;

  constructor() {
    this.app = new Application();
    this.worldContainer = new Container();
    this.backgroundLayer = new Container();
    this.entityLayer = new Container();
    this.foregroundLayer = new Container();
    this.cutsceneOverlay = new Container();
    this.uiLayer = new Container();
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
    this.worldContainer.addChild(this.foregroundLayer);

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
    this.app.destroy(true);
  }
}
