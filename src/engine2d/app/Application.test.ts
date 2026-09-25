/**
 * Application 的 init / ticker / resizeTo / destroy 流程(假 createRenderer、假画布、手动驱动 rAF),
 * 以及 ResizePlugin / TickerPlugin 与 pixi.js 8.17 同名插件的逐步对照。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ResizePlugin as PixiResizePlugin,
  TickerPlugin as PixiTickerPlugin,
  Ticker as PixiTicker,
  UPDATE_PRIORITY as PIXI_UPDATE_PRIORITY,
} from 'pixi.js';
import { Rectangle } from '../math/Rectangle';
import { Ticker, UPDATE_PRIORITY } from '../ticker/Ticker';
import { DOMAdapter, type Adapter } from '../environment/adapter';
import { Application } from './Application';
import { ResizePlugin } from './ResizePlugin';
import { TickerPlugin } from './TickerPlugin';

const created = vi.hoisted(() => ({ renderers: [] as unknown[], options: [] as Record<string, unknown>[] }));

vi.mock('../gpu/createRenderer', () => ({
  createRenderer: vi.fn(async (options: Record<string, unknown>) => {
    created.options.push(options);
    const r = new FakeRenderer(options);
    created.renderers.push(r);
    return r;
  }),
}));

/** 只记账的渲染器:resize / render / destroy 调用都进 log */
class FakeRenderer {
  readonly canvas: { width: number; height: number; style: Record<string, string> };
  readonly screen: Rectangle;
  readonly log: string[] = [];
  readonly renderCalls: unknown[] = [];
  destroyedWith: unknown = 'not-destroyed';
  constructor(options: Record<string, unknown>) {
    this.canvas = options.canvas as FakeRenderer['canvas'];
    this.screen = new Rectangle(0, 0, options.width as number, options.height as number);
  }
  resize(w: number, h: number): void {
    this.screen.width = w;
    this.screen.height = h;
    this.log.push(`resize ${w}x${h}`);
  }
  render(options: unknown): void {
    this.renderCalls.push(options);
    this.log.push('render');
  }
  destroy(options: unknown): void {
    this.destroyedWith = options;
  }
}

// ── 手动 rAF 与全局 resize 事件
let rafQueue = new Map<number, FrameRequestCallback>();
let rafId = 0;
let resizeListeners: Array<() => void> = [];

function flushFrame(time = performance.now() + 16): void {
  const cbs = [...rafQueue.values()];
  rafQueue = new Map();
  cbs.forEach((cb) => cb(time));
}

function fireWindowResize(): void {
  [...resizeListeners].forEach((l) => l());
}

let adapter0: Adapter;
const fakeCanvases: unknown[] = [];

beforeEach(() => {
  created.renderers.length = 0;
  created.options.length = 0;
  rafQueue = new Map();
  rafId = 0;
  resizeListeners = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++rafId;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue.delete(id);
  });
  vi.stubGlobal('addEventListener', (type: string, fn: () => void) => {
    if (type === 'resize' && fn) resizeListeners.push(fn);
  });
  vi.stubGlobal('removeEventListener', (type: string, fn: () => void) => {
    if (type === 'resize') resizeListeners = resizeListeners.filter((l) => l !== fn);
  });
  adapter0 = DOMAdapter.get();
  DOMAdapter.set({
    ...adapter0,
    createCanvas: () => {
      const c = { width: 0, height: 0, style: {} };
      fakeCanvases.push(c);
      return c as unknown as HTMLCanvasElement;
    },
  });
});

afterEach(() => {
  DOMAdapter.set(adapter0);
  vi.unstubAllGlobals();
});

function rendererOf(app: Application): FakeRenderer {
  return app.renderer as unknown as FakeRenderer;
}

describe('Application.init', () => {
  it('建渲染器(画布取自 DOMAdapter、宽高缺省 800×600、参数原样下传),装好 ticker / resize', async () => {
    const app = new Application();
    const stage = app.stage;
    await app.init({ background: '#1a1a2e', antialias: false, resolution: 2, autoDensity: true, preference: 'webgpu' });
    const opts = created.options[0];
    expect(opts.width).toBe(800);
    expect(opts.height).toBe(600);
    expect(opts.background).toBe('#1a1a2e');
    expect(opts.resolution).toBe(2);
    expect(opts.autoDensity).toBe(true);
    expect(opts.canvas).toBe(fakeCanvases[fakeCanvases.length - 1]);
    expect(app.stage).toBe(stage);
    expect(app.canvas).toBe(opts.canvas);
    expect(app.screen).toBe(rendererOf(app).screen);
    expect(app.ticker).toBeInstanceOf(Ticker);
    expect(app.ticker.started).toBe(true);
    expect(typeof app.resize).toBe('function');
    expect(typeof app.queueResize).toBe('function');
    expect(typeof app.cancelResize).toBe('function');
    expect(app.resizeTo).toBeNull();
    app.destroy();
  });

  it('给了 canvas / 宽高就用给的(view 是 canvas 的旧名)', async () => {
    const canvas = { width: 1, height: 1, style: {} } as unknown as HTMLCanvasElement;
    const app = new Application();
    await app.init({ view: canvas, width: 260, height: 220 });
    expect(created.options[0].canvas).toBe(canvas);
    expect(created.options[0].width).toBe(260);
    expect(created.options[0].height).toBe(220);
    app.destroy();
  });

  it('ticker 调的是 init 之前覆盖的实例 render(游戏的 installRenderCrashGuard)', async () => {
    const app = new Application();
    const base = Application.prototype.render;
    const guardedThis: unknown[] = [];
    (app as Application & { render: () => void }).render = function guardedRender(this: Application): void {
      guardedThis.push(this);
      try {
        base.call(this);
      } catch {
        /* 兜住 */
      }
    };
    await app.init();
    flushFrame();
    expect(guardedThis).toEqual([app]);
    expect(rendererOf(app).renderCalls).toEqual([{ container: app.stage }]);

    // init 之后再覆盖:ticker 手上仍是 init 时的那个(与 Pixi 相同)
    const late = vi.fn();
    (app as Application & { render: () => void }).render = late;
    flushFrame();
    expect(late).not.toHaveBeenCalled();
    expect(guardedThis.length).toBe(2);
    app.destroy();
  });

  it('render 在 LOW 优先级:LOW+1 的回调先跑、UTILITY 后跑', async () => {
    const app = new Application();
    await app.init();
    const order: string[] = [];
    const r = rendererOf(app);
    const origRender = r.render.bind(r);
    r.render = (o: unknown) => {
      order.push('render');
      origRender(o);
    };
    app.ticker.add(() => order.push('utility'), undefined, UPDATE_PRIORITY.UTILITY);
    app.ticker.add(() => order.push('low+1'), undefined, UPDATE_PRIORITY.LOW + 1);
    app.ticker.add(() => order.push('normal'));
    flushFrame();
    expect(order).toEqual(['normal', 'low+1', 'render', 'utility']);
    app.destroy();
  });

  it('autoStart:false 不自动跑帧;start / stop 控制 ticker', async () => {
    const app = new Application();
    await app.init({ autoStart: false });
    expect(app.ticker.started).toBe(false);
    app.start();
    expect(app.ticker.started).toBe(true);
    app.stop();
    expect(app.ticker.started).toBe(false);
    app.destroy();
  });

  it('sharedTicker:用 Ticker.shared,destroy 只摘掉 render、不销毁共享 ticker', async () => {
    const app = new Application();
    await app.init({ sharedTicker: true, autoStart: false });
    expect(app.ticker).toBe(Ticker.shared);
    const before = Ticker.shared.count;
    app.destroy();
    expect(Ticker.shared.count).toBe(before - 1);
    Ticker.shared.add(() => {});
    expect(Ticker.shared.count).toBe(before);
  });
});

describe('Application.resizeTo', () => {
  it('元素:init 时同步 resize(clientWidth/clientHeight)+ render;全局 resize 事件 → 下一帧再 resize + render', async () => {
    const el = { clientWidth: 640, clientHeight: 480 } as unknown as HTMLElement;
    const app = new Application();
    await app.init({ resizeTo: el, autoStart: false });
    const r = rendererOf(app);
    expect(r.log).toEqual(['resize 640x480', 'render']);
    expect(resizeListeners.length).toBe(1);

    (el as unknown as { clientWidth: number }).clientWidth = 1024;
    fireWindowResize();
    fireWindowResize(); // 同一帧里多次只落一次
    expect(r.log).toEqual(['resize 640x480', 'render']);
    flushFrame();
    expect(r.log).toEqual(['resize 640x480', 'render', 'resize 1024x480', 'render']);
    expect(app.screen.width).toBe(1024);
    app.destroy();
    expect(resizeListeners.length).toBe(0);
  });

  it('window:取 innerWidth / innerHeight', async () => {
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('innerWidth', 1280);
    vi.stubGlobal('innerHeight', 720);
    const app = new Application();
    await app.init({ resizeTo: globalThis.window, autoStart: false });
    expect(rendererOf(app).log).toEqual(['resize 1280x720', 'render']);
    app.destroy();
  });

  it('resizeTo = null 断开监听;排队中的那次落空;cancelResize 取消排队', async () => {
    const el = { clientWidth: 300, clientHeight: 200 } as unknown as HTMLElement;
    const app = new Application();
    await app.init({ resizeTo: el, autoStart: false });
    const r = rendererOf(app);
    r.log.length = 0;

    app.queueResize();
    app.cancelResize();
    flushFrame();
    expect(r.log).toEqual([]);

    app.queueResize();
    (app as unknown as { resizeTo: HTMLElement | null }).resizeTo = null;
    expect(resizeListeners.length).toBe(0);
    flushFrame();
    expect(r.log).toEqual([]);

    // 手动 resize 在没有目标时什么都不做
    app.resize();
    expect(r.log).toEqual([]);

    // 重新挂上:立即 resize 一次
    app.resizeTo = el;
    expect(r.log).toEqual(['resize 300x200', 'render']);
    app.destroy();
  });
});

describe('Application.destroy', () => {
  it('插件逆序销毁 → stage.destroy(options) → renderer.destroy(rendererDestroyOptions)', async () => {
    const app = new Application();
    const el = { clientWidth: 10, clientHeight: 10 } as unknown as HTMLElement;
    await app.init({ resizeTo: el });
    const r = rendererOf(app);
    const ticker = app.ticker;
    const stage = app.stage;
    app.destroy(true, { children: true });
    expect(r.destroyedWith).toBe(true);
    expect(stage.destroyed).toBe(true);
    expect(app.stage).toBeNull();
    expect(app.renderer).toBeNull();
    expect(ticker.started).toBe(false);
    expect(ticker.count).toBe(0);
    expect(resizeListeners.length).toBe(0);
    expect(rafQueue.size).toBe(0);
  });
});

// ─────────────────────────── 与 pixi.js 插件逐步对照

interface PluginSet {
  Resize: { init(this: unknown, o: unknown): void; destroy(this: unknown): void };
  Ticker: { init(this: unknown, o: unknown): void; destroy(this: unknown): void };
}

/** 同一套操作分别跑 Pixi 与 engine2d 的插件,记下渲染器收到的调用与全局监听数 */
function runPluginScenario(plugins: PluginSet, lowPriority: number): string[] {
  const log: string[] = [];
  const el = { clientWidth: 500, clientHeight: 400 };
  interface FakeApp {
    renderer: { resize(w: number, h: number): void };
    render(this: unknown): void;
    ticker: { update(t: number): void; add(fn: () => void, ctx?: unknown, p?: number): void };
    resizeTo: unknown;
    cancelResize?: () => void;
  }
  const app = {
    renderer: {
      resize: (w: number, h: number) => log.push(`resize ${w}x${h}`),
    },
    render(this: unknown) {
      log.push(`render this=${this === app}`);
    },
  } as unknown as FakeApp;
  const options = { resizeTo: el, autoStart: false };
  plugins.Resize.init.call(app, options);
  plugins.Ticker.init.call(app, options);
  log.push(`listeners ${resizeListeners.length}`);
  app.ticker.add(() => log.push('low+1'), undefined, lowPriority + 1);
  app.ticker.update(performance.now() + 1000);
  el.clientWidth = 700;
  fireWindowResize();
  log.push(`raf ${rafQueue.size}`);
  flushFrame();
  app.cancelResize?.(); // Pixi 运行时没有这个方法(只有 _cancelResize),?. 落空
  app.resizeTo = null;
  log.push(`listeners ${resizeListeners.length}`);
  fireWindowResize();
  flushFrame();
  plugins.Ticker.destroy.call(app);
  plugins.Resize.destroy.call(app);
  log.push(`listeners ${resizeListeners.length} raf ${rafQueue.size} ticker ${String(app.ticker)}`);
  return log;
}

describe('ResizePlugin / TickerPlugin 与 pixi.js 8.17 对照', () => {
  it('同一套操作,渲染器收到的调用序列、监听增减完全相同', () => {
    const pixiLog = runPluginScenario(
      { Resize: PixiResizePlugin as unknown as PluginSet['Resize'], Ticker: PixiTickerPlugin as unknown as PluginSet['Ticker'] },
      PIXI_UPDATE_PRIORITY.LOW,
    );
    const e2dLog = runPluginScenario(
      { Resize: ResizePlugin as unknown as PluginSet['Resize'], Ticker: TickerPlugin as unknown as PluginSet['Ticker'] },
      UPDATE_PRIORITY.LOW,
    );
    expect(e2dLog).toEqual(pixiLog);
    expect(pixiLog).toEqual([
      'resize 500x400', 'render this=true', // 设 resizeTo 时同步 resize + render
      'listeners 1',
      'low+1', 'render this=true', // ticker:render 在 LOW
      'raf 1', // resize 事件 → 排到下一帧
      'resize 700x400', 'render this=true',
      'listeners 0', // resizeTo = null
      'listeners 0 raf 0 ticker null',
    ]);
    expect(UPDATE_PRIORITY.LOW).toBe(PIXI_UPDATE_PRIORITY.LOW);
    expect(PixiTicker).toBeDefined();
  });
});
