import { Container, type ContainerOptions, type DestroyOptions } from './Container';
import { Bounds } from './Bounds';
import type { PointData } from '../math/Point';
import type { RenderCollector } from '../core/contracts';

/** 自己有可画内容的节点(Sprite / Mesh / Graphics / Text)的基类(照 Pixi `ViewContainer`) */
export abstract class ViewContainer extends Container {
  protected _bounds = new Bounds(0, 1, 0, 0);
  protected _boundsDirty = true;
  _roundPixels = 0;
  /**
   * @internal 合批元素实际带的取整标志:第一次被收集时锁定为 `渲染器 roundPixels | 本节点 roundPixels`,之后再改
   * `roundPixels` 不生效,直到 unload / destroy 丢掉 GPU 侧数据(照 Pixi 各 pipe 的 `_initGPUSprite` / `initGpuText` /
   * `_initBatchableMesh`:值只在建 BatchableXxx 时取一次)。-1 = 还没锁
   */
  _batchRoundPixels = -1;

  constructor(options: ContainerOptions = {}) {
    super(options);
    this.allowChildren = false;
  }

  override get bounds(): Bounds {
    if (!this._boundsDirty) return this._bounds;
    this.updateBounds();
    this._boundsDirty = false;
    return this._bounds;
  }

  protected abstract updateBounds(): void;

  get roundPixels(): boolean {
    return !!this._roundPixels;
  }
  set roundPixels(value: boolean) {
    this._roundPixels = value ? 1 : 0;
  }

  /** @internal 合批元素用的取整标志(首次收集时锁定,见 `_batchRoundPixels`) */
  _latchRoundPixels(collector: RenderCollector): number {
    if (this._batchRoundPixels < 0) this._batchRoundPixels = (collector.roundPixels ?? 0) | this._roundPixels;
    return this._batchRoundPixels;
  }

  override containsPoint(point: PointData): boolean {
    const b = this.bounds;
    return point.x >= b.minX && point.x <= b.maxX && point.y >= b.minY && point.y <= b.maxY;
  }

  /** 内容变了(纹理 / 几何 / 锚点) */
  onViewUpdate(): void {
    this._didViewChangeTick++;
    this._boundsDirty = true;
  }

  /** 丢掉 GPU 侧数据,下次渲染时重建(照 Pixi `ViewContainer.unload`) */
  unload(): void {
    this.emit('unload', this);
    this._batchRoundPixels = -1;
    this.onViewUpdate();
  }

  override destroy(options?: boolean | DestroyOptions): void {
    this._batchRoundPixels = -1;
    super.destroy(options);
  }
}
