/**
 * 应用的帧驱动插件(移植自 PixiJS v8.17(MIT):`app/TickerPlugin`)。
 *
 * init 时给应用装 `ticker`(存取器)、`start()`、`stop()`,并把 **`this.render` 当时的值**
 * 以 `UPDATE_PRIORITY.LOW` 挂到 ticker 上(context = 应用)。
 *
 * ⚠ 挂的是函数引用:init **之前**覆盖实例的 `render`(游戏的渲染兜错 `installRenderCrashGuard`)
 * 会被 ticker 调到;init **之后**再覆盖,ticker 手上的仍是旧的那个。与 Pixi 完全一致,别"修"。
 * 换 ticker(`app.ticker = other`)时同样按 `this.render` 的当前值先 remove 再 add。
 */
import { Ticker, UPDATE_PRIORITY } from '../ticker/Ticker';
import type { Application } from './Application';

export interface TickerPluginOptions {
  /** init 完立刻开始跑帧(缺省 true) */
  autoStart?: boolean;
  /** 用全局共享的 `Ticker.shared`(缺省 false = 自己 new 一个) */
  sharedTicker?: boolean;
}

/** 插件在应用实例上挂的内部字段 */
interface TickerHost {
  _ticker: Ticker | null;
  ticker: Ticker | null;
  start: () => void;
  stop: () => void;
  render: () => void;
}

function host(app: Application): TickerHost {
  return app as unknown as TickerHost;
}

export class TickerPlugin {
  static init(this: Application, options?: TickerPluginOptions): void {
    const opts: TickerPluginOptions = Object.assign({ autoStart: true, sharedTicker: false }, options);
    const self = host(this);
    Object.defineProperty(this, 'ticker', {
      configurable: true,
      set(this: Application, ticker: Ticker | null) {
        const h = host(this);
        if (h._ticker) h._ticker.remove(h.render, this);
        h._ticker = ticker;
        if (ticker) ticker.add(h.render, this, UPDATE_PRIORITY.LOW);
      },
      get(this: Application) {
        return host(this)._ticker;
      },
    });
    self.stop = () => {
      (self._ticker as Ticker).stop();
    };
    self.start = () => {
      (self._ticker as Ticker).start();
    };
    self._ticker = null;
    self.ticker = opts.sharedTicker ? Ticker.shared : new Ticker();
    if (opts.autoStart) self.start();
  }

  static destroy(this: Application): void {
    const self = host(this);
    if (self._ticker) {
      const oldTicker = self._ticker;
      self.ticker = null;
      // 共享 ticker 是受保护的,destroy 对它是空操作(见 Ticker.destroy)
      oldTicker.destroy();
    }
  }
}
