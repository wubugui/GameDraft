/**
 * 应用的自动尺寸插件(移植自 PixiJS v8.17(MIT):`app/ResizePlugin`)。
 *
 * `resizeTo` 设成 window 或某个元素后:监听全局 `resize` 事件 → 下一帧(rAF)按目标尺寸
 * `renderer.resize(w, h)` 并立即 `this.render()` 画一帧。设值的当下同步 resize 一次。
 * - 目标是 window:取 `innerWidth / innerHeight`;是元素:取 `clientWidth / clientHeight`。
 * - `resizeTo = null` 断开监听(已排队的那一帧照旧会跑,但 `resize()` 见目标为空直接返回)。
 * - `resize()` 里调的是 `this.render` —— 实例上若覆盖过 render(游戏的渲染兜错),走覆盖后的那个。
 *
 * 与 Pixi 的唯一差别:Pixi 运行时只有私有的 `_cancelResize`(类型声明里有 `cancelResize` 但实例上没有),
 * 这里两个名字都挂上、指向同一个函数。游戏调 `app.cancelResize?.()` 之后总是紧跟 `resizeTo = null`,
 * 两边可观察行为一致。
 */
import type { Application } from './Application';

export interface ResizePluginOptions {
  /** 自动跟随尺寸的目标:window 或元素;null / 不给 = 不跟随 */
  resizeTo?: Window | HTMLElement | null;
}

/** 插件在应用实例上挂的内部字段 */
interface ResizeHost {
  _resizeId: number | null;
  _resizeTo: Window | HTMLElement | null;
  _cancelResize: (() => void) | null;
  cancelResize: (() => void) | null;
  queueResize: (() => void) | null;
  resize: (() => void) | null;
  resizeTo: Window | HTMLElement | null;
}

function host(app: Application): ResizeHost {
  return app as unknown as ResizeHost;
}

export class ResizePlugin {
  static init(this: Application, options: ResizePluginOptions): void {
    const self = host(this);
    Object.defineProperty(this, 'resizeTo', {
      configurable: true,
      set(this: Application, dom: Window | HTMLElement | null) {
        const h = host(this);
        globalThis.removeEventListener('resize', h.queueResize as () => void);
        h._resizeTo = dom;
        if (dom) {
          globalThis.addEventListener('resize', h.queueResize as () => void);
          (h.resize as () => void)();
        }
      },
      get(this: Application) {
        return host(this)._resizeTo;
      },
    });

    self.queueResize = () => {
      if (!self._resizeTo) return;
      (self._cancelResize as () => void)();
      // 下一帧再改尺寸(同一帧内多次 resize 事件只落一次)
      self._resizeId = requestAnimationFrame(() => (self.resize as () => void)());
    };

    self._cancelResize = () => {
      if (self._resizeId) {
        cancelAnimationFrame(self._resizeId);
        self._resizeId = null;
      }
    };
    self.cancelResize = self._cancelResize;

    self.resize = () => {
      if (!self._resizeTo) return;
      // 先取消排队的那次,免得这一帧里再改一遍
      (self._cancelResize as () => void)();
      let width: number;
      let height: number;
      if (self._resizeTo === globalThis.window) {
        width = globalThis.innerWidth;
        height = globalThis.innerHeight;
      } else {
        const { clientWidth, clientHeight } = self._resizeTo as HTMLElement;
        width = clientWidth;
        height = clientHeight;
      }
      this.renderer.resize(width, height);
      this.render();
    };

    self._resizeId = null;
    self._resizeTo = null;
    self.resizeTo = options.resizeTo || null;
  }

  static destroy(this: Application): void {
    const self = host(this);
    globalThis.removeEventListener('resize', self.queueResize as () => void);
    (self._cancelResize as () => void)();
    self._cancelResize = null;
    self.cancelResize = null;
    self.queueResize = null;
    self.resizeTo = null;
    self.resize = null;
  }
}
