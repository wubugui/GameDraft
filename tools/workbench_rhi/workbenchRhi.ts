/**
 * 工作台 RHI 接入层 · 页面侧（打进每个工作台自己的包里，命名空间 `workbenchRhi`）。
 *
 * 工作台页面是 Python serve 的原生 JS；它经这里拿到**游戏同一份** engine2d / RHI（只有 WebGPU），再用游戏自己的渲染模块
 * （滤镜、网格、着色器、贴图装载）画——不在工具里另写着色器。这一层只做"宿主"该做的事：
 *
 * - 在页面给的 `<canvas>` 上建渲染器（`createRenderer`，与游戏 `Renderer.init` 同参：不抗锯齿、分辨率 = 设备像素比）；
 *   没有 WebGPU 就抛 `WorkbenchRhiError`（带人话原因），**不回落**任何别的 API；
 * - 贴图一律走 engine2d 的 `Assets.load`（与游戏 `AssetManager.loadTexture` 同一条解码 / 上传路径，字节才对得上）；
 * - 回读：WebGPU 画布呈现后内容就读不回来了（Chrome 实测读到全 0），所以 `readPixels` 在**同一个任务里**
 *   先把上一次画的根重画一遍、再 `drawImage` 进 2D 画布取字节——读到的就是画布此刻显示的那一帧；
 * - 设备诊断（设备丢失 / 管线建坏）汇总到 `lastError`，页面自己决定怎么提示。
 *
 * 用法见 `tools/workbench_rhi/README.md`。
 */
import {
  Assets,
  createRenderer,
  type ColorSource,
  type Container,
  type Texture,
  type WebGPURenderer,
} from '../../src/engine2d';

export * as engine2d from '../../src/engine2d';

export class WorkbenchRhiError extends Error {
  constructor(message: string, readonly reason: 'no-webgpu' | 'no-adapter' | 'device' | 'other') {
    super(message);
    this.name = 'WorkbenchRhiError';
  }
}

/** 这个宿主（浏览器 / QtWebEngine）拿不拿得到 WebGPU：拿得到返回 ''，否则返回人话原因（不建设备） */
export async function probeWebGpu(): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return '这个窗口没有 WebGPU（navigator.gpu 不存在）';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? '' : '这个窗口拿不到 WebGPU 适配器（显卡 / 驱动 / 宿主参数不支持）';
  } catch (e) {
    return `WebGPU 适配器请求失败：${(e as Error)?.message ?? e}`;
  }
}

export interface CanvasHostOptions {
  /** 清屏色（缺省黑） */
  background?: ColorSource;
  /** 缺省 false（与游戏相同） */
  antialias?: boolean;
  /** 初始逻辑尺寸（CSS 像素）；之后按 `resize` */
  width?: number;
  height?: number;
  resolution?: number;
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA8，自上而下 */
  data: Uint8ClampedArray;
}

export class CanvasHost {
  /** 最近一次设备诊断（设备丢失 / 管线建坏 / 恢复失败）；没有 = '' */
  lastError = '';
  private lastRoot: Container | null = null;
  private readonly offDiag: () => void;
  private readCanvas: HTMLCanvasElement | null = null;
  private destroyed = false;

  private constructor(readonly renderer: WebGPURenderer, readonly canvas: HTMLCanvasElement) {
    this.offDiag = renderer.rhi.onDiagnostic((err, severity) => {
      if (severity === 'error') this.lastError = err.message;
    });
  }

  /** 在画布上建 WebGPU 渲染器；拿不到就抛 `WorkbenchRhiError`（不回落） */
  static async create(canvas: HTMLCanvasElement, options: CanvasHostOptions = {}): Promise<CanvasHost> {
    const why = await probeWebGpu();
    if (why) throw new WorkbenchRhiError(why, (navigator as { gpu?: unknown }).gpu ? 'no-adapter' : 'no-webgpu');
    const resolution = options.resolution ?? (window.devicePixelRatio || 1);
    let renderer: WebGPURenderer;
    try {
      renderer = await createRenderer({
        canvas,
        width: Math.max(1, options.width ?? (canvas.clientWidth || 1)),
        height: Math.max(1, options.height ?? (canvas.clientHeight || 1)),
        resolution,
        antialias: options.antialias ?? false,
        background: options.background ?? 0x000000,
        autoDensity: false,
      });
    } catch (e) {
      throw new WorkbenchRhiError(`WebGPU 设备建不起来：${(e as Error)?.message ?? e}`, 'device');
    }
    return new CanvasHost(renderer, canvas);
  }

  /** 逻辑尺寸（CSS 像素）+ 设备像素比；画布的 CSS 尺寸归页面管 */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.destroyed) return;
    this.renderer.resize(Math.max(1, cssWidth), Math.max(1, cssHeight), dpr > 0 ? dpr : 1);
  }

  render(root: Container): void {
    if (this.destroyed) return;
    this.lastRoot = root;
    this.renderer.render(root);
  }

  /**
   * 回读画布（设备像素，自上而下 RGBA8）：同一个任务里先把上一次 `render` 的根重画一遍再取，
   * 取到的就是画布显示的那一帧。没画过 = null。
   */
  readPixels(x = 0, y = 0, width?: number, height?: number): Pixels | null {
    if (this.destroyed || !this.lastRoot) return null;
    this.renderer.render(this.lastRoot);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const w = Math.max(1, Math.min(width ?? W, W - x));
    const h = Math.max(1, Math.min(height ?? H, H - y));
    const rc = (this.readCanvas ??= document.createElement('canvas'));
    if (rc.width !== W) rc.width = W;
    if (rc.height !== H) rc.height = H;
    const ctx = rc.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.canvas, 0, 0);
    return { width: w, height: h, data: ctx.getImageData(x, y, w, h).data };
  }

  /** 画面里与清屏色差得出来的像素数（冒烟用：画面非空）；没画过 = 0 */
  countDrawnPixels(tolerance = 6): number {
    const px = this.readPixels();
    if (!px) return 0;
    const [r, g, b] = this.renderer.background.colorRgba.map((v) => Math.round(v * 255));
    let n = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      if (Math.abs(px.data[i] - r) + Math.abs(px.data[i + 1] - g) + Math.abs(px.data[i + 2] - b) > tolerance) n++;
    }
    return n;
  }

  /** 读一个 CSS 点的像素 `[r, g, b, a]`（按当前分辨率换到设备像素） */
  readPixel(cssX: number, cssY: number): number[] {
    const r = this.renderer.resolution;
    const x = Math.min(this.canvas.width - 1, Math.max(0, Math.round(cssX * r)));
    const y = Math.min(this.canvas.height - 1, Math.max(0, Math.round(cssY * r)));
    const px = this.readPixels(x, y, 1, 1);
    return px ? [...px.data] : [0, 0, 0, 0];
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offDiag();
    this.lastRoot = null;
    this.renderer.destroy();
  }
}

/** `CanvasHost.create` 的函数式别名（原生 JS 页面里少写一个类名） */
export function createCanvasHost(canvas: HTMLCanvasElement, options?: CanvasHostOptions): Promise<CanvasHost> {
  return CanvasHost.create(canvas, options);
}

/**
 * 装一张图成纹理：与游戏 `AssetManager.loadTexture` 同一条（engine2d `Assets.load`，缺省解码期预乘）。
 * URL 没有图片扩展名（如 `/api/scene_bg?id=…`）时显式指定纹理装载器。
 */
export function loadTexture(url: string): Promise<Texture> {
  return /\.(png|jpe?g|webp|avif|gif)(\?|#|$)/i.test(url)
    ? Assets.load<Texture>(url)
    : Assets.load<Texture>({ src: url, parser: 'loadTextures' });
}

/** 放掉 `loadTexture` 装过的图（GPU 资源一起放）；没装过不报错 */
export async function unloadTexture(url: string): Promise<void> {
  try {
    await Assets.unload(url);
  } catch {
    /* 没装过 */
  }
}
