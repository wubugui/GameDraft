/**
 * 空闲 GPU 资源回收(照 Pixi 8.17 `GCSystem`,缺省同 Pixi:开、60 s 没用过就收、每 30 s 查一次)。
 *
 * - 每次 `render()` 开始记一次 `now`(Pixi `prerender`);纹理 / 缓冲在规划阶段被取用时按它记「最近用过」。
 * - `render()` 结束(最外层)时若距上次检查已过 `gcFrequency`,跑一遍各登记的回收器(Pixi 由调度器每 30 s 置位、
 *   下一次 `postrender` 执行,时序等价)。回收器对 `autoGarbageCollect` 的资源、`now - 最近用过 >= gcMaxUnusedTime`
 *   的调 `unload()`——GPU 对象释放,CPU 侧资源还在,下次用到时重建 / 重传。
 * - 选项:`gcActive` / `gcMaxUnusedTime` / `gcFrequency`;Pixi 8.15 起弃用但仍认的 `textureGCActive` /
 *   `textureGCMaxIdle`(帧数,按 60 帧 / 秒换算成毫秒)也照 Pixi 的 TextureGCSystem 覆盖上去。
 */
export interface GCSystemOptions {
  /** 开不开回收(缺省 true) */
  gcActive?: boolean;
  /** 多久没用过就收,毫秒(缺省 60000) */
  gcMaxUnusedTime?: number;
  /** 多久查一次,毫秒(缺省 30000) */
  gcFrequency?: number;
  /** @deprecated Pixi 8.15 起改用 gcActive */
  textureGCActive?: boolean;
  /** @deprecated Pixi 8.15 起改用 gcMaxUnusedTime(这里是帧数,按 60 帧 / 秒换算) */
  textureGCMaxIdle?: number;
  /** @deprecated Pixi 8.15 起不再生效 */
  textureGCCheckCountMax?: number;
}

/** 一个回收器:收掉 `now - 最近用过 >= maxUnusedTime` 的可回收资源 */
export type GCCollector = (now: number, maxUnusedTime: number) => void;

/** Pixi TextureGCSystem 的缺省值:只有与它不同的值才覆盖(同 Pixi) */
const LEGACY_TEXTURE_GC_ACTIVE = true;
const LEGACY_TEXTURE_GC_MAX_IDLE = 60 * 60;

export class GCSystem {
  static defaultOptions = {
    gcActive: true,
    gcMaxUnusedTime: 60000,
    gcFrequency: 30000,
  };

  /** 多久没用过就收(毫秒) */
  maxUnusedTime: number;
  /** 本次渲染开始的时刻:资源「最近用过」按它记 */
  now: number;
  private readonly frequency: number;
  private readonly collectors: GCCollector[] = [];
  private _enabled = false;
  /** 上次检查(或开启)的时刻 */
  private last = 0;

  constructor(options: GCSystemOptions = {}) {
    const o = { ...GCSystem.defaultOptions, ...stripUndefined(options) };
    this.maxUnusedTime = o.gcMaxUnusedTime;
    this.frequency = o.gcFrequency;
    this.now = performance.now();
    this.enabled = o.gcActive;
    if (options.textureGCActive !== undefined && options.textureGCActive !== LEGACY_TEXTURE_GC_ACTIVE) {
      this.enabled = options.textureGCActive;
    }
    if (options.textureGCMaxIdle !== undefined && options.textureGCMaxIdle !== LEGACY_TEXTURE_GC_MAX_IDLE) {
      this.maxUnusedTime = (options.textureGCMaxIdle / 60) * 1000;
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }
  /** 打开时从此刻起计下一次检查(同 Pixi 调度器的 repeat 起点) */
  set enabled(value: boolean) {
    if (this._enabled === value) return;
    this._enabled = value;
    if (value) this.last = performance.now();
  }

  addCollector(collector: GCCollector): void {
    this.collectors.push(collector);
  }

  /** 一次 render 开始 */
  prerender(): void {
    this.now = performance.now();
  }

  /** 一次(最外层)render 结束:到点了就回收 */
  postrender(): void {
    if (!this._enabled) return;
    const t = performance.now();
    if (t - this.last < this.frequency) return;
    this.last = t;
    this.run();
  }

  /** 立即回收一遍 */
  run(): void {
    const now = performance.now();
    for (const c of this.collectors) c(now, this.maxUnusedTime);
  }

  destroy(): void {
    this._enabled = false;
    this.collectors.length = 0;
  }
}

function stripUndefined(o: GCSystemOptions): Partial<typeof GCSystem.defaultOptions> {
  const out: Record<string, unknown> = {};
  for (const k of ['gcActive', 'gcMaxUnusedTime', 'gcFrequency'] as const) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
