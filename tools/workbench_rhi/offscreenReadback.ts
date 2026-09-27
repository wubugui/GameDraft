/**
 * 工作台 RHI 接入层 · 离屏渲染纹理 + 异步回读（打进工作台的包，命名空间 `offscreenReadback`）。
 *
 * 画布回读（`CanvasHost.readPixels`）只能同任务重画再 `drawImage`，尺寸跟着画布走、每次都要同步等 GPU；
 * 出片要的是**按成品尺寸**逐帧画、逐帧读、读的时候别卡住下一帧——这里给的就是这个：
 *
 * - `createOffscreenTarget(host | renderer, w, h)`：在**同一个渲染器 / 同一台设备**上建一张离屏渲染纹理
 *   （engine2d `RenderTexture`，分辨率 1：像素 = 逻辑像素），`render(root)` 把一棵场景树画进去（与画到画布同一条渲染路径，
 *   只是目标不同）；
 * - `read()` / `capture(root)`：异步回读，返回**自上而下**的 RGBA8（纹理里存的字节，即预乘；不透明画面 = 直接的颜色）。
 *   拷贝命令在调用的那一刻就排进 GPU 队列（`rhi.readTexture` → `copyTextureToBuffer` 立即提交），之后再往同一张纹理里画
 *   不影响已经发出的读——所以出片可以"画第 i 帧 → 发读 i → 画第 i+1 帧 → 发读 i+1…"，同时挂着好几帧在读；
 * - 行序：WebGPU 纹理第 0 行就是画面最上面一行，回读原样给出，**不翻**（以前 WebGL `readPixels` 是自下而上、要服务端翻）。
 *
 * 不画画布、不碰 `CanvasHost` 的"上一次画的根"——预览照常画自己的，互不影响。用法见 `tools/workbench_rhi/README.md`。
 */
import { RenderTexture, type ColorSource, type Container, type WebGPURenderer } from '../../src/engine2d';
import type { Pixels } from './workbenchRhi';

export interface OffscreenTargetOptions {
  /** 每次 `render` 先清成这个颜色（缺省透明黑 `[0, 0, 0, 0]`，与 `generateTexture` 相同） */
  clearColor?: ColorSource | [number, number, number, number];
}

/** 渲染器，或带渲染器的宿主（`CanvasHost`） */
export type RendererLike = WebGPURenderer | { readonly renderer: WebGPURenderer };

function rendererOf(r: RendererLike): WebGPURenderer {
  return 'renderer' in r && r.renderer ? r.renderer : (r as WebGPURenderer);
}

export class OffscreenTarget {
  readonly texture: RenderTexture;
  private readonly clearColor: ColorSource | [number, number, number, number];
  private rendered = false;
  private destroyed = false;

  constructor(readonly renderer: WebGPURenderer, width: number, height: number, options: OffscreenTargetOptions = {}) {
    if (!(width >= 1 && height >= 1)) throw new Error(`离屏目标尺寸不对：${width}×${height}`);
    this.texture = RenderTexture.create({ width: Math.round(width), height: Math.round(height), resolution: 1, antialias: false });
    this.clearColor = options.clearColor ?? [0, 0, 0, 0];
  }

  get width(): number {
    return this.texture.source.pixelWidth;
  }

  get height(): number {
    return this.texture.source.pixelHeight;
  }

  /** 把 `root` 画进离屏纹理（`root` 自己的变换照常生效；目标像素 (0, 0)–(w, h) = 逻辑坐标） */
  render(root: Container): void {
    if (this.destroyed) throw new Error('离屏目标已销毁');
    this.renderer.render({ container: root, target: this.texture, clear: true, clearColor: this.clearColor });
    this.rendered = true;
  }

  /**
   * 异步回读当前内容（自上而下 RGBA8，预乘字节）。拷贝在调用时就排进队列：之后再 `render` 不影响这一次读到的内容。
   * 还没画过 = 抛错（读到的会是未定义内容）。
   */
  read(): Promise<Pixels> {
    if (this.destroyed) return Promise.reject(new Error('离屏目标已销毁'));
    if (!this.rendered) return Promise.reject(new Error('离屏目标还没画过'));
    return this.renderer.readPixels(this.texture.source).then(({ pixels, width, height }) => ({ width, height, data: pixels }));
  }

  /** `render(root)` + `read()`：返回的 Promise 就是这一次画的内容 */
  capture(root: Container): Promise<Pixels> {
    this.render(root);
    return this.read();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.texture.destroy(true);
  }
}

/** 在宿主（或渲染器）的设备上建一张 `width × height` 的离屏目标 */
export function createOffscreenTarget(host: RendererLike, width: number, height: number, options?: OffscreenTargetOptions): OffscreenTarget {
  return new OffscreenTarget(rendererOf(host), width, height, options);
}
