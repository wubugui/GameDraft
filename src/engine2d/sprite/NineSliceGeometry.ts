/**
 * 移植自 PixiJS v8.17(MIT):scene/sprite-nine-slice/NineSliceGeometry。
 *
 * 4×4 顶点的九宫格平面:四角按原尺寸,边条与中心拉伸;宽 / 高小于两侧边宽之和时四角等比缩小。
 * uv 是 0..1 的「纹理 orig 空间」坐标(含 trim 换算);落到图集帧由纹理矩阵再映射一次(见 NineSliceSprite)。
 */
import type { PointData } from '../math/Point';
import { PlaneGeometry } from '../mesh/MeshGeometry';

export interface NineSliceGeometryOptions {
  /** 宽 */
  width?: number;
  /** 高 */
  height?: number;
  /** 纹理原宽 */
  originalWidth?: number;
  /** 纹理原高 */
  originalHeight?: number;
  /** 左边条宽 */
  leftWidth?: number;
  /** 上边条高 */
  topHeight?: number;
  /** 右边条宽 */
  rightWidth?: number;
  /** 下边条高 */
  bottomHeight?: number;
  /** 锚点 */
  anchor?: PointData;
  /** 纹理裁切框(null = 无裁切) */
  trim?: { x: number; y: number; width: number; height: number } | null;
}

export class NineSliceGeometry extends PlaneGeometry {
  /**
   * 缺省值(与 Pixi 相同;另带 verticesX / verticesY = 4 只为满足 PlaneGeometry 静态字段的类型,
   * 构造时本来就固定传 4×4,不影响行为)
   */
  static override defaultOptions: NineSliceGeometryOptions & typeof PlaneGeometry.defaultOptions = {
    width: 100,
    height: 100,
    leftWidth: 10,
    topHeight: 10,
    rightWidth: 10,
    bottomHeight: 10,
    originalWidth: 100,
    originalHeight: 100,
    verticesX: 4,
    verticesY: 4,
  };

  _leftWidth!: number;
  _rightWidth!: number;
  _topHeight!: number;
  _bottomHeight!: number;

  private _originalWidth!: number;
  private _originalHeight!: number;
  private _trimX!: number;
  private _trimY!: number;
  private _trimWidth!: number;
  private _trimHeight!: number;
  /** Pixi 原样:未给 anchor 时为 undefined(此时位置为 NaN,直到下一次带 anchor 的 update) */
  private _anchorX!: number | undefined;
  private _anchorY!: number | undefined;

  constructor(options: NineSliceGeometryOptions = {}) {
    options = { ...NineSliceGeometry.defaultOptions, ...options };

    super({
      width: options.width,
      height: options.height,
      verticesX: 4,
      verticesY: 4,
    });

    this._trimX = 0;
    this._trimY = 0;
    this._trimWidth = options.originalWidth ?? NineSliceGeometry.defaultOptions.originalWidth!;
    this._trimHeight = options.originalHeight ?? NineSliceGeometry.defaultOptions.originalHeight!;

    this.update(options);
  }

  /** 按选项更新几何(没给的项保持原值) */
  update(options: NineSliceGeometryOptions): void {
    this.width = options.width ?? this.width;
    this.height = options.height ?? this.height;
    this._originalWidth = options.originalWidth ?? this._originalWidth;
    this._originalHeight = options.originalHeight ?? this._originalHeight;
    this._leftWidth = options.leftWidth ?? this._leftWidth;
    this._rightWidth = options.rightWidth ?? this._rightWidth;
    this._topHeight = options.topHeight ?? this._topHeight;
    this._bottomHeight = options.bottomHeight ?? this._bottomHeight;

    this._anchorX = options.anchor?.x;
    this._anchorY = options.anchor?.y;

    if (options.trim !== undefined) {
      this._trimX = options.trim?.x ?? 0;
      this._trimY = options.trim?.y ?? 0;
      this._trimWidth = options.trim?.width ?? this._originalWidth;
      this._trimHeight = options.trim?.height ?? this._originalHeight;
    } else {
      this._trimWidth = this._originalWidth;
      this._trimHeight = this._originalHeight;
    }

    this.updateUvs();
    this.updatePositions();
  }

  /** 按宽高 / 边条 / 锚点重算 16 个顶点 */
  updatePositions(): void {
    const p = this.positions;

    const {
      width,
      height,
      _leftWidth,
      _rightWidth,
      _topHeight,
      _bottomHeight,
      _anchorX,
      _anchorY,
    } = this;

    const w = _leftWidth + _rightWidth;
    const scaleW = width > w ? 1.0 : width / w;

    const h = _topHeight + _bottomHeight;
    const scaleH = height > h ? 1.0 : height / h;

    const scale = Math.min(scaleW, scaleH);

    const anchorOffsetX = (_anchorX as number) * width;
    const anchorOffsetY = (_anchorY as number) * height;

    p[0] = p[8] = p[16] = p[24] = -anchorOffsetX;
    p[2] = p[10] = p[18] = p[26] = (_leftWidth * scale) - anchorOffsetX;
    p[4] = p[12] = p[20] = p[28] = width - (_rightWidth * scale) - anchorOffsetX;
    p[6] = p[14] = p[22] = p[30] = width - anchorOffsetX;

    p[1] = p[3] = p[5] = p[7] = -anchorOffsetY;
    p[9] = p[11] = p[13] = p[15] = (_topHeight * scale) - anchorOffsetY;
    p[17] = p[19] = p[21] = p[23] = height - (_bottomHeight * scale) - anchorOffsetY;
    p[25] = p[27] = p[29] = p[31] = height - anchorOffsetY;

    this.getBuffer('aPosition').update();
  }

  /** 按原尺寸 / 裁切 / 边条重算 16 个 uv */
  updateUvs(): void {
    const uvs = this.uvs;

    const origW = this._originalWidth;
    const origH = this._originalHeight;

    const u0 = this._trimX / origW;
    const v0 = this._trimY / origH;
    const u1 = (this._trimX + this._trimWidth) / origW;
    const v1 = (this._trimY + this._trimHeight) / origH;

    uvs[0] = uvs[8] = uvs[16] = uvs[24] = u0;
    uvs[1] = uvs[3] = uvs[5] = uvs[7] = v0;
    uvs[6] = uvs[14] = uvs[22] = uvs[30] = u1;
    uvs[25] = uvs[27] = uvs[29] = uvs[31] = v1;

    const _uvw = 1.0 / origW;
    const _uvh = 1.0 / origH;

    uvs[2] = uvs[10] = uvs[18] = uvs[26] = u0 + (_uvw * this._leftWidth);
    uvs[9] = uvs[11] = uvs[13] = uvs[15] = v0 + (_uvh * this._topHeight);

    uvs[4] = uvs[12] = uvs[20] = uvs[28] = u1 - (_uvw * this._rightWidth);
    uvs[17] = uvs[19] = uvs[21] = uvs[23] = v1 - (_uvh * this._bottomHeight);

    this.getBuffer('aUV').update();
  }
}
