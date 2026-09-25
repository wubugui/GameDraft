/**
 * 应用外壳(移植自 PixiJS v8.17(MIT):`app/Application`;插件见 ResizePlugin / TickerPlugin)。
 *
 * 用法与 Pixi 相同:`const app = new Application(); await app.init(options);`,之后
 * `app.stage` / `app.renderer` / `app.canvas` / `app.screen` / `app.ticker` / `app.render()` /
 * `app.resize()` / `app.resizeTo` / `app.destroy()`。
 *
 * 流程逐行对应 Pixi:
 * - init:拷一份 options → 建渲染器(Pixi 是 `autoDetectRenderer`,这里是 `createRenderer`,只有 WebGPU)
 *   → 按顺序跑插件的 init(ResizePlugin 先、TickerPlugin 后;ResizePlugin 设 resizeTo 时会同步
 *   resize + render 一次)。
 * - render 是**原型方法**:游戏在 init 之前把实例的 `render` 换成带兜错的版本,并用
 *   `Application.prototype.render` 调回原实现;TickerPlugin 挂到 ticker 上的是 init 当时的 `this.render`。
 * - destroy:插件逆序 destroy → stage.destroy(options) → renderer.destroy(rendererDestroyOptions)。
 *
 * 渲染器参数:`preference` / `webgpu` / `webgl` 等后端选择项接受但不起作用(只有 WebGPU,不回落);
 * `view` 是 `canvas` 的旧名(同 Pixi);没给画布时与 Pixi 的 ViewSystem 一样经 `DOMAdapter.createCanvas()` 建;
 * 宽高缺省 800×600(同 Pixi ViewSystem.defaultOptions)。
 */
import { Container, type DestroyOptions } from '../scene/Container';
import type { Rectangle } from '../math/Rectangle';
import type { Ticker } from '../ticker/Ticker';
import type { RendererBase } from '../gpu/Renderer';
import type { WebGPURenderer } from '../gpu/WebGPURenderer';
import { createRenderer, type CreateRendererOptions } from '../gpu/createRenderer';
import { DOMAdapter } from '../environment/adapter';
import { ResizePlugin, type ResizePluginOptions } from './ResizePlugin';
import { TickerPlugin, type TickerPluginOptions } from './TickerPlugin';

/** 渲染后端偏好(Pixi 的取值;engine2d 只有 WebGPU,一律忽略) */
export type RendererPreference = 'webgl' | 'webgpu' | 'canvas';

export interface ApplicationOptions extends CreateRendererOptions, ResizePluginOptions, TickerPluginOptions {
  /** @deprecated 同 Pixi:`canvas` 的旧名 */
  view?: HTMLCanvasElement;
  /** 后端偏好:接受但忽略(只有 WebGPU;没有 WebGPU 时 createRenderer 直接抛错,不回落) */
  preference?: RendererPreference | RendererPreference[];
  /** Pixi 的分后端参数:接受但忽略(设备由 RHI 建,或经 `rhi` 传入现成设备) */
  webgpu?: Record<string, unknown>;
  /** Pixi 的分后端参数:接受但忽略 */
  webgl?: Record<string, unknown>;
  /** 其余 Pixi 渲染器参数(powerPreference / hello / eventMode / eventFeatures 等)原样传给渲染器 */
  [key: string]: unknown;
}

/** 渲染器销毁参数(同 Pixi:true = 把画布从 DOM 摘掉) */
export type RendererDestroyOptions = boolean | { removeView?: boolean };

/** 应用插件:init / destroy 以应用实例为 this 调用(与 Pixi 的 ApplicationPlugin 相同) */
export interface ApplicationPlugin {
  init(this: Application, options: Partial<ApplicationOptions>): void;
  destroy(this: Application): void;
}

/** 同 Pixi ViewSystem.defaultOptions 的宽高缺省 */
const VIEW_DEFAULTS = { width: 800, height: 600 } as const;

let warnedViewDeprecation = false;
let warnedCtorDeprecation = false;

export class Application<R extends RendererBase = WebGPURenderer> {
  /**
   * 已装的插件,按顺序 init、逆序 destroy。
   * 与 Pixi 注册顺序相同:ResizePlugin、TickerPlugin(Pixi 另有一个只调 devtools 全局钩子的 ApplicationInitHook,不移植)。
   * @internal
   */
  static _plugins: ApplicationPlugin[] = [ResizePlugin, TickerPlugin];

  /** 根容器 */
  stage: Container = new Container();
  /** 渲染器(init 之后才有) */
  renderer!: R;

  // ── TickerPlugin 在 init 里装到实例上(init 之前访问是 undefined,与 Pixi 相同)
  declare ticker: Ticker;
  declare start: () => void;
  declare stop: () => void;

  // ── ResizePlugin 在 init 里装到实例上
  declare resizeTo: Window | HTMLElement;
  declare resize: () => void;
  declare queueResize: () => void;
  declare cancelResize: () => void;

  constructor(...args: unknown[]) {
    if (args[0] !== undefined && !warnedCtorDeprecation) {
      warnedCtorDeprecation = true;
      console.warn('[engine2d] Application 构造参数已弃用(同 Pixi v8),请用 await app.init(options)');
    }
  }

  /** 建渲染器并装插件 */
  async init(options?: Partial<ApplicationOptions>): Promise<void> {
    options = { ...options };
    this.stage ||= new Container();
    this.renderer = (await createRenderer(toRendererOptions(options))) as unknown as R;

    // ── 事件系统接线位置(events 模块另写,接线由主代理做)。
    // Pixi 里 EventSystem 是**渲染器系统**,在 autoDetectRenderer 内部 init,早于下面的插件:
    //   renderer.events = eventSystem; eventSystem.setTargetElement(renderer.canvas);
    //   eventSystem.resolution = renderer.resolution;(渲染器 resolutionChange 时同步)
    //   缺省 eventMode = options.eventMode ?? 'passive';features ← options.eventFeatures;
    //   事件根 = renderer.lastObjectRendered(即 stage);另有 EventsTicker 挂在 Ticker.system(INTERACTION 优先级)。
    // 销毁由 renderer.destroy 负责(RendererBase.events.destroy())。

    Application._plugins.forEach((plugin) => {
      plugin.init.call(this as unknown as Application, options as Partial<ApplicationOptions>);
    });
  }

  /** 把 stage 画到画布(TickerPlugin 每帧以 LOW 优先级调用) */
  render(): void {
    this.renderer.render({ container: this.stage });
  }

  /** 渲染器的画布 */
  get canvas(): HTMLCanvasElement {
    return this.renderer.canvas;
  }

  /** @deprecated 同 Pixi:用 {@link canvas} */
  get view(): HTMLCanvasElement {
    if (!warnedViewDeprecation) {
      warnedViewDeprecation = true;
      console.warn('[engine2d] Application.view 已弃用(同 Pixi v8),请用 Application.canvas');
    }
    return this.renderer.canvas;
  }

  /** 渲染器的屏幕矩形(逻辑尺寸) */
  get screen(): Rectangle {
    return this.renderer.screen;
  }

  /**
   * 销毁应用。
   * @param rendererDestroyOptions false(缺省)= 画布留在 DOM;true / `{ removeView: true }` = 摘掉画布
   * @param options stage 的销毁参数(同 Container.destroy)
   */
  destroy(rendererDestroyOptions: RendererDestroyOptions = false, options: boolean | DestroyOptions = false): void {
    const plugins = Application._plugins.slice(0);
    plugins.reverse();
    plugins.forEach((plugin) => {
      plugin.destroy.call(this as unknown as Application);
    });
    this.stage.destroy(options);
    this.stage = null as unknown as Container;
    this.renderer.destroy(rendererDestroyOptions);
    this.renderer = null as unknown as R;
  }
}

/** Application 参数 → createRenderer 参数(与 Pixi 一样整份传下去,只补画布与宽高缺省) */
function toRendererOptions(options: Partial<ApplicationOptions>): CreateRendererOptions {
  const merged: Partial<ApplicationOptions> = { ...VIEW_DEFAULTS, ...options };
  if (merged.width === undefined) merged.width = VIEW_DEFAULTS.width;
  if (merged.height === undefined) merged.height = VIEW_DEFAULTS.height;
  merged.canvas = options.canvas ?? options.view ?? DOMAdapter.get().createCanvas();
  return merged as CreateRendererOptions;
}
