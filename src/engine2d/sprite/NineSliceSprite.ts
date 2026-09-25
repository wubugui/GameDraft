/**
 * 移植自 PixiJS v8.17(MIT):scene/sprite-nine-slice/NineSliceSprite(+ NineSliceSpritePipe 的出图部分)。
 *
 * 九宫格精灵:四角不拉伸,边条单向拉伸,中心双向拉伸。`width` / `height` 是几何本身的尺寸(不是缩放),
 * 边条宽缺省取 `texture.defaultBorders`。
 *
 * 出图(照 Pixi `NineSliceSpritePipe` + `BatchableMesh`):每个精灵自带一份 NineSliceGeometry,
 * 内容变了(尺寸 / 边条 / 锚点 / 纹理)在下一次收集时 `geometry.update(this)`;
 * `collectRenderables` 发一个 packAsQuad = false 的合批元素,uv 经纹理矩阵映射到图集帧。
 */
import { ObservablePoint } from '../math/ObservablePoint';
import type { PointData } from '../math/Point';
import type { Rectangle } from '../math/Rectangle';
import { Texture } from '../textures/Texture';
import { ViewContainer } from '../scene/ViewContainer';
import type { ContainerOptions, DestroyOptions } from '../scene/Container';
import type { BatchableElement, RenderCollector } from '../core/contracts';
import { NineSliceGeometry } from './NineSliceGeometry';

export interface NineSliceSpriteOptions extends ContainerOptions {
  /** 纹理 */
  texture: Texture;
  /** 左边条宽(缺省 texture.defaultBorders.left,再缺省 10) */
  leftWidth?: number;
  /** 上边条高 */
  topHeight?: number;
  /** 右边条宽 */
  rightWidth?: number;
  /** 下边条高 */
  bottomHeight?: number;
  /** 宽(缺省纹理宽) */
  width?: number;
  /** 高(缺省纹理高) */
  height?: number;
  /** 顶点按像素取整 */
  roundPixels?: boolean;
  /** 锚点 */
  anchor?: PointData | number;
}

export class NineSliceSprite extends ViewContainer {
  static defaultOptions: NineSliceSpriteOptions = {
    texture: Texture.EMPTY,
  };

  override renderPipeId = 'nineSliceSprite';
  _texture!: Texture;
  _anchor: ObservablePoint;
  /** Pixi 同名字段:九宫格恒走合批 */
  batched = true;

  private _leftWidth: number;
  private _topHeight: number;
  private _rightWidth: number;
  private _bottomHeight: number;
  private _width: number;
  private _height: number;

  /** 出图用的几何(照 Pixi NineSliceSpriteGpuData,首次收集时建) */
  private _geometry: NineSliceGeometry | null = null;
  /** 内容变了、几何待更新(Pixi 的 didViewUpdate) */
  private _geometryDirty = true;
  private _transformedUvs: Float32Array | null = null;
  private _uvKey = '';
  private readonly _batchable: BatchableElement = {
    texture: Texture.EMPTY,
    transform: this.groupTransform,
    color: 0xffffffff,
    roundPixels: 0,
    blendMode: 'normal',
    topology: 'triangle-list',
    packAsQuad: false,
    attributeOffset: 0,
    attributeSize: 0,
    indexOffset: 0,
    indexSize: 0,
  };

  constructor(options: NineSliceSpriteOptions | Texture) {
    if (options instanceof Texture) {
      options = { texture: options };
    }

    const {
      width,
      height,
      anchor,
      leftWidth,
      rightWidth,
      topHeight,
      bottomHeight,
      texture,
      roundPixels,
      ...rest
    } = options;

    super({
      label: 'NineSliceSprite',
      ...rest,
    });

    this._leftWidth = leftWidth ?? texture?.defaultBorders?.left ?? NineSliceGeometry.defaultOptions.leftWidth!;
    this._topHeight = topHeight ?? texture?.defaultBorders?.top ?? NineSliceGeometry.defaultOptions.topHeight!;
    this._rightWidth = rightWidth ?? texture?.defaultBorders?.right ?? NineSliceGeometry.defaultOptions.rightWidth!;
    this._bottomHeight = bottomHeight ?? texture?.defaultBorders?.bottom ?? NineSliceGeometry.defaultOptions.bottomHeight!;

    this._width = width ?? texture.width ?? NineSliceGeometry.defaultOptions.width;
    this._height = height ?? texture.height ?? NineSliceGeometry.defaultOptions.height;

    this.allowChildren = false;
    this.texture = texture ?? NineSliceSprite.defaultOptions.texture;
    this.roundPixels = roundPixels ?? false;

    this._anchor = new ObservablePoint({
      _onUpdate: () => {
        this.onViewUpdate();
      },
    });

    if (anchor) {
      this.anchor = anchor;
    } else if (this.texture.defaultAnchor) {
      this.anchor = this.texture.defaultAnchor;
    }
  }

  /** 锚点(0..1,相对 width / height) */
  get anchor(): ObservablePoint {
    return this._anchor;
  }

  set anchor(value: PointData | number) {
    typeof value === 'number' ? this._anchor.set(value) : this._anchor.copyFrom(value);
  }

  /** 九宫格的宽(几何尺寸,不经缩放) */
  override get width(): number {
    return this._width;
  }

  override set width(value: number) {
    this._width = value;
    this.onViewUpdate();
  }

  /** 九宫格的高(几何尺寸,不经缩放) */
  override get height(): number {
    return this._height;
  }

  override set height(value: number) {
    this._height = value;
    this.onViewUpdate();
  }

  /** 同时设宽高 */
  override setSize(value: number | { width: number; height?: number }, height?: number): void {
    if (typeof value === 'object') {
      height = value.height ?? value.width;
      value = value.width;
    }

    this._width = value;
    this._height = height ?? value;

    this.onViewUpdate();
  }

  /** 取宽高 */
  override getSize(out?: { width: number; height: number }): { width: number; height: number } {
    out ||= {} as { width: number; height: number };
    out.width = this._width;
    out.height = this._height;

    return out;
  }

  /** 左边条宽 */
  get leftWidth(): number {
    return this._leftWidth;
  }

  set leftWidth(value: number) {
    this._leftWidth = value;

    this.onViewUpdate();
  }

  /** 上边条高 */
  get topHeight(): number {
    return this._topHeight;
  }

  set topHeight(value: number) {
    this._topHeight = value;
    this.onViewUpdate();
  }

  /** 右边条宽 */
  get rightWidth(): number {
    return this._rightWidth;
  }

  set rightWidth(value: number) {
    this._rightWidth = value;
    this.onViewUpdate();
  }

  /** 下边条高 */
  get bottomHeight(): number {
    return this._bottomHeight;
  }

  set bottomHeight(value: number) {
    this._bottomHeight = value;
    this.onViewUpdate();
  }

  /** 纹理 */
  get texture(): Texture {
    return this._texture;
  }

  set texture(value: Texture | null | undefined) {
    value ||= Texture.EMPTY;

    const currentTexture = this._texture;

    if (currentTexture === value) return;

    if (currentTexture && currentTexture.dynamic) currentTexture.off('update', this.onViewUpdate, this);
    if (value.dynamic) value.on('update', this.onViewUpdate, this);

    this._texture = value;

    this.onViewUpdate();
  }

  /** 纹理原宽 */
  get originalWidth(): number {
    return this._texture.width;
  }

  /** 纹理原高 */
  get originalHeight(): number {
    return this._texture.height;
  }

  /** 纹理裁切框(无则 null) */
  get trim(): Rectangle | null {
    return this._texture.trim ?? null;
  }

  override onViewUpdate(): void {
    super.onViewUpdate();
    this._geometryDirty = true;
  }

  /**
   * 出图(照 Pixi NineSliceSpritePipe.addRenderable + BatchableMesh):
   * 位置 / 索引取几何;uv 在纹理不是整张源时经纹理矩阵映射到帧内。
   */
  override collectRenderables(collector: RenderCollector): void {
    const geometry = (this._geometry ??= new NineSliceGeometry());

    if (this._geometryDirty) {
      geometry.update(this);
      this._geometryDirty = false;
    }

    const b = this._batchable;

    b.texture = this._texture;
    b.transform = this.groupTransform;
    b.color = this.groupColorAlpha;
    b.roundPixels = this._roundPixels;
    b.blendMode = this.groupBlendMode;
    b.topology = geometry.topology;
    b.positions = geometry.positions;
    b.uvs = this._batchUvs(geometry);
    b.indices = geometry.indices;
    b.attributeSize = geometry.positions.length / 2;
    b.indexSize = geometry.indices.length;

    collector.addBatchable(b);
  }

  /** 照 Pixi BatchableMesh.uvs:纹理矩阵非平凡时把几何 uv 映射进帧,按(矩阵版本, uv 版本, 纹理)缓存 */
  private _batchUvs(geometry: NineSliceGeometry): Float32Array {
    const uvBuffer = geometry.getBuffer('aUV');
    const uvs = uvBuffer.data as Float32Array;
    const textureMatrix = this._texture.textureMatrix;

    if (textureMatrix.isSimple) return uvs;

    if (!this._transformedUvs || this._transformedUvs.length < uvs.length) {
      this._transformedUvs = new Float32Array(uvs.length);
      this._uvKey = '';
    }

    const key = `${textureMatrix._updateID}:${uvBuffer._updateID}:${this._texture.uid}`;

    if (this._uvKey !== key) {
      this._uvKey = key;
      textureMatrix.multiplyUvs(uvs, this._transformedUvs);
    }

    return this._transformedUvs;
  }

  override destroy(options: boolean | DestroyOptions = false): void {
    if (this.destroyed) return;

    super.destroy(options);

    // Pixi 不摘动态纹理上的 update 监听(会把销毁了的精灵挂在纹理上);这里摘掉,destroy 不留残留
    if (this._texture.dynamic) this._texture.off('update', this.onViewUpdate, this);

    const destroyTexture = typeof options === 'boolean' ? options : options?.texture;

    if (destroyTexture) {
      const destroyTextureSource = typeof options === 'boolean' ? options : options?.textureSource;

      this._texture.destroy(destroyTextureSource);
    }

    this._texture = null as unknown as Texture;

    // Pixi:NineSliceSpriteGpuData.destroy() → geometry.destroy()
    this._geometry?.destroy();
    this._geometry = null;
    this._transformedUvs = null;
  }

  protected updateBounds(): void {
    const bounds = this._bounds;

    const anchor = this._anchor;

    const width = this._width;
    const height = this._height;

    bounds.minX = -anchor._x * width;
    bounds.maxX = bounds.minX + width;

    bounds.minY = -anchor._y * height;
    bounds.maxY = bounds.minY + height;
  }
}
