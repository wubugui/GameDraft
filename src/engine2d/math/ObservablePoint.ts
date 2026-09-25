import type { PointData, PointLike } from './Point';

export interface Observer<T> {
  _onUpdate: (point?: T) => void;
}

/** 值变了回调观察者的点(照 Pixi `ObservablePoint`;Container 的 position / scale / pivot / skew 用它) */
export class ObservablePoint implements PointLike {
  _x: number;
  _y: number;
  private readonly _observer: Observer<ObservablePoint> | null;

  constructor(observer: Observer<ObservablePoint> | null, x = 0, y = 0) {
    this._x = x;
    this._y = y;
    this._observer = observer;
  }

  clone(observer?: Observer<ObservablePoint>): ObservablePoint {
    return new ObservablePoint(observer ?? this._observer, this._x, this._y);
  }

  set(x = 0, y = x): this {
    if (this._x !== x || this._y !== y) {
      this._x = x;
      this._y = y;
      this._observer?._onUpdate(this);
    }
    return this;
  }

  copyFrom(p: PointData): this {
    if (this._x !== p.x || this._y !== p.y) {
      this._x = p.x;
      this._y = p.y;
      this._observer?._onUpdate(this);
    }
    return this;
  }

  copyTo<T extends PointLike>(p: T): T {
    p.set(this._x, this._y);
    return p;
  }

  equals(p: PointData): boolean {
    return p.x === this._x && p.y === this._y;
  }

  get x(): number {
    return this._x;
  }
  set x(value: number) {
    if (this._x !== value) {
      this._x = value;
      this._observer?._onUpdate(this);
    }
  }

  get y(): number {
    return this._y;
  }
  set y(value: number) {
    if (this._y !== value) {
      this._y = value;
      this._observer?._onUpdate(this);
    }
  }

  toString(): string {
    return `[ObservablePoint x=${this._x} y=${this._y}]`;
  }
}
