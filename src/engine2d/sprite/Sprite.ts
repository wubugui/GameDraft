import { ObservablePoint } from '../math/ObservablePoint';
import type { PointData } from '../math/Point';
import { Texture, type TextureSourceLike } from '../textures/Texture';
import { ViewContainer } from '../scene/ViewContainer';
import { _registerSpriteClassForMasks, type ContainerOptions, type DestroyOptions } from '../scene/Container';
import type { BatchableElement, RenderCollector } from '../core/contracts';

export interface SpriteOptions extends ContainerOptions {
  texture?: Texture;
  anchor?: PointData | number;
  roundPixels?: boolean;
  width?: number;
  height?: number;
}

export interface QuadBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** 画一张纹理的四边形(照 Pixi `Sprite`) */
export class Sprite extends ViewContainer {
  override renderPipeId = 'sprite';
  private _texture!: Texture;
  private readonly _anchor: ObservablePoint;
  private readonly _visualBounds: QuadBounds = { minX: 0, maxX: 1, minY: 0, maxY: 0 };
  /**
   * 合批四边形要不要按当前纹理 / 锚点重算(照 Pixi SpritePipe:`batchableSprite.bounds` 只在 didViewUpdate 时刷新)。
   * 不跟 texture 'update' 的非动态纹理(如 RenderTexture.create 缺省)改尺寸后,四边形与滤镜 / 命中包围盒一起停在旧尺寸
   */
  private _visualBoundsDirty = true;
  private _width?: number;
  private _height?: number;
  private readonly _batchable: BatchableElement;

  constructor(options: SpriteOptions | Texture = Texture.EMPTY) {
    const o: SpriteOptions = options instanceof Texture ? { texture: options } : options;
    const { texture = Texture.EMPTY, anchor, roundPixels, width, height, ...rest } = o;
    super({ label: 'Sprite', ...rest });
    this._anchor = new ObservablePoint({ _onUpdate: () => this.onViewUpdate() });
    if (anchor) this.anchor = anchor; // 照 Pixi:`anchor: 0` / null 落到纹理的 defaultAnchor
    else if (texture.defaultAnchor) this.anchor = texture.defaultAnchor;
    this.texture = texture;
    this.roundPixels = roundPixels ?? false;
    if (width !== undefined) this.width = width;
    if (height !== undefined) this.height = height;
    this._batchable = {
      texture: this._texture,
      transform: this.groupTransform,
      color: 0xffffffff,
      roundPixels: 0,
      blendMode: 'normal',
      topology: 'triangle-list',
      packAsQuad: true,
      bounds: this._visualBounds,
      attributeOffset: 0,
      attributeSize: 4,
      indexOffset: 0,
      indexSize: 6,
    };
  }

  static from(source: Texture | TextureSourceLike, skipCache = false): Sprite {
    return new Sprite(source instanceof Texture ? source : Texture.from(source, skipCache));
  }

  get texture(): Texture {
    return this._texture;
  }
  set texture(value: Texture | null | undefined) {
    value ||= Texture.EMPTY;
    const cur = this._texture;
    if (cur === value) return;
    if (cur && cur.dynamic) cur.off('update', this.onViewUpdate, this);
    if (value.dynamic) value.on('update', this.onViewUpdate, this);
    this._texture = value;
    if (this._width) this._setWidth(this._width, value.orig.width);
    if (this._height) this._setHeight(this._height, value.orig.height);
    this.onViewUpdate();
  }

  get anchor(): ObservablePoint {
    return this._anchor;
  }
  set anchor(value: PointData | number) {
    typeof value === 'number' ? this._anchor.set(value) : this._anchor.copyFrom(value);
  }

  /** 按 trim 裁过的可见四边形(本地坐标) */
  get visualBounds(): QuadBounds {
    updateQuadBounds(this._visualBounds, this._anchor, this._texture);
    return this._visualBounds;
  }

  override onViewUpdate(): void {
    super.onViewUpdate();
    this._visualBoundsDirty = true;
  }

  protected updateBounds(): void {
    const { width, height } = this._texture.orig;
    const b = this._bounds;
    b.minX = -this._anchor._x * width;
    b.maxX = b.minX + width;
    b.minY = -this._anchor._y * height;
    b.maxY = b.minY + height;
  }

  override get width(): number {
    return Math.abs(this.scale.x) * this._texture.orig.width;
  }
  override set width(value: number) {
    this._setWidth(value, this._texture.orig.width);
    this._width = value;
  }

  override get height(): number {
    return Math.abs(this.scale.y) * this._texture.orig.height;
  }
  override set height(value: number) {
    this._setHeight(value, this._texture.orig.height);
    this._height = value;
  }

  override getSize(out: { width: number; height: number } = { width: 0, height: 0 }): { width: number; height: number } {
    out.width = Math.abs(this.scale.x) * this._texture.orig.width;
    out.height = Math.abs(this.scale.y) * this._texture.orig.height;
    return out;
  }

  override setSize(value: number | { width: number; height?: number }, height?: number): void {
    let w: number | undefined;
    if (typeof value === 'object') {
      height = value.height ?? value.width;
      w = value.width;
    } else {
      w = value;
      height ??= value;
    }
    if (w !== undefined) this._setWidth(w, this._texture.orig.width);
    if (height !== undefined) this._setHeight(height, this._texture.orig.height);
  }

  override collectRenderables(collector: RenderCollector): void {
    const b = this._batchable;
    b.texture = this._texture;
    b.transform = this.groupTransform;
    b.color = this.groupColorAlpha;
    b.roundPixels = this._latchRoundPixels(collector);
    b.blendMode = this.groupBlendMode;
    if (this._visualBoundsDirty) {
      updateQuadBounds(this._visualBounds, this._anchor, this._texture);
      this._visualBoundsDirty = false;
    }
    b.bounds = this._visualBounds;
    collector.addBatchable(b);
  }

  override destroy(options: boolean | DestroyOptions = false): void {
    const tex = this._texture;
    super.destroy(options);
    const destroyTexture = typeof options === 'boolean' ? options : options?.texture;
    if (destroyTexture && tex) {
      const destroySource = typeof options === 'boolean' ? options : options?.textureSource;
      tex.destroy(destroySource);
    }
  }
}

export function updateQuadBounds(bounds: QuadBounds, anchor: ObservablePoint, texture: Texture): void {
  const { width, height } = texture.orig;
  const trim = texture.trim;
  if (trim) {
    bounds.minX = trim.x - anchor._x * width;
    bounds.maxX = bounds.minX + trim.width;
    bounds.minY = trim.y - anchor._y * height;
    bounds.maxY = bounds.minY + trim.height;
  } else {
    bounds.minX = -anchor._x * width;
    bounds.maxX = bounds.minX + width;
    bounds.minY = -anchor._y * height;
    bounds.maxY = bounds.minY + height;
  }
}

// 照 Pixi AlphaMask.test(`mask instanceof Sprite`):Sprite(及子类)当遮罩走 alpha 遮罩
_registerSpriteClassForMasks(Sprite);
