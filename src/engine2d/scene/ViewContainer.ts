import { Container, type ContainerOptions, type DestroyOptions } from './Container';
import { Bounds } from './Bounds';
import type { PointData } from '../math/Point';

/** 自己有可画内容的节点(Sprite / Mesh / Graphics / Text)的基类(照 Pixi `ViewContainer`) */
export abstract class ViewContainer extends Container {
  protected _bounds = new Bounds(0, 1, 0, 0);
  protected _boundsDirty = true;
  _roundPixels = 0;

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

  override containsPoint(point: PointData): boolean {
    const b = this.bounds;
    return point.x >= b.minX && point.x <= b.maxX && point.y >= b.minY && point.y <= b.maxY;
  }

  /** 内容变了(纹理 / 几何 / 锚点) */
  onViewUpdate(): void {
    this._didViewChangeTick++;
    this._boundsDirty = true;
  }

  override destroy(options?: boolean | DestroyOptions): void {
    super.destroy(options);
  }
}
