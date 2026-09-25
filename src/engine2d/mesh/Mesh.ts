import { Texture } from '../textures/Texture';
import { ViewContainer } from '../scene/ViewContainer';
import type { ContainerOptions, DestroyOptions } from '../scene/Container';
import type { Bounds } from '../scene/Bounds';
import type { Geometry } from '../shader/Geometry';
import type { Shader } from '../shader/Shader';
import type { PointData } from '../math/Point';
import type { BatchableElement, CustomDrawable, RenderCollector } from '../core/contracts';
import { MeshGeometry, PlaneGeometry } from './MeshGeometry';

export interface MeshOptions<G extends Geometry = MeshGeometry, S extends Shader = Shader> extends ContainerOptions {
  geometry: G;
  shader?: S | null;
  texture?: Texture;
  roundPixels?: boolean;
  /** Pixi 的 State;接受但只读其中的 blendMode */
  state?: { blendMode?: string };
}

/**
 * 网格(照 Pixi `Mesh`):带 shader 的按自定义着色器画(不合批);不带 shader 的用缺省网格着色器,
 * 顶点不超过 100 个时并进合批。
 */
export class Mesh<G extends Geometry = MeshGeometry, S extends Shader = Shader> extends ViewContainer implements CustomDrawable {
  override renderPipeId = 'mesh';
  private _geometry!: G;
  private _shader: S | null = null;
  private _texture!: Texture;
  state: { blendMode?: string };
  private _transformedUvs: Float32Array | null = null;
  private _uvKey = '';
  private readonly _batchable: BatchableElement;

  constructor(options: MeshOptions<G, S>) {
    const { geometry, shader, texture, roundPixels, state, ...rest } = options;
    super({ label: 'Mesh', ...rest });
    this.shader = shader ?? null;
    this.texture = texture ?? (shader as unknown as { texture?: Texture } | null)?.texture ?? Texture.WHITE;
    this.state = state ?? {};
    this._geometry = geometry;
    this._geometry.on('update', this.onViewUpdate, this);
    this.roundPixels = roundPixels ?? false;
    this._batchable = {
      texture: this._texture,
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
  }

  get shader(): S {
    return this._shader as S;
  }
  set shader(value: S | null) {
    if (this._shader === value) return;
    this._shader = value;
    this.onViewUpdate();
  }

  get geometry(): G {
    return this._geometry;
  }
  set geometry(value: G) {
    if (this._geometry === value) return;
    this._geometry?.off('update', this.onViewUpdate, this);
    value.on('update', this.onViewUpdate, this);
    this._geometry = value;
    this.onViewUpdate();
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
    if (this._shader) (this._shader as unknown as { texture?: Texture }).texture = value;
    this._texture = value;
    this.onViewUpdate();
  }

  /** 是否并进合批 */
  get batched(): boolean {
    if (this._shader) return false;
    const g = this._geometry;
    if (g instanceof MeshGeometry) {
      if (g.batchMode === 'auto') return g.positions.length / 2 <= 100;
      return g.batchMode === 'batch';
    }
    return false;
  }

  override get bounds(): Bounds {
    return this._geometry.bounds;
  }

  protected updateBounds(): void {}

  override containsPoint(point: PointData): boolean {
    const { x, y } = point;
    if (!this.bounds.containsPoint(x, y)) return false;
    const vertices = this.geometry.getBuffer('aPosition').data;
    const step = this.geometry.topology === 'triangle-strip' ? 3 : 1;
    const index = this.geometry.indexBuffer;
    if (index) {
      const indices = index.data;
      for (let i = 0; i + 2 < indices.length; i += step) {
        const i0 = indices[i] * 2;
        const i1 = indices[i + 1] * 2;
        const i2 = indices[i + 2] * 2;
        if (pointInTriangle(x, y, vertices[i0], vertices[i0 + 1], vertices[i1], vertices[i1 + 1], vertices[i2], vertices[i2 + 1])) return true;
      }
    } else {
      const len = vertices.length / 2;
      for (let i = 0; i + 2 < len; i += step) {
        const i0 = i * 2;
        const i1 = (i + 1) * 2;
        const i2 = (i + 2) * 2;
        if (pointInTriangle(x, y, vertices[i0], vertices[i0 + 1], vertices[i1], vertices[i1 + 1], vertices[i2], vertices[i2 + 1])) return true;
      }
    }
    return false;
  }

  override collectRenderables(collector: RenderCollector): void {
    if (!this.batched) {
      collector.addCustom(this);
      return;
    }
    const g = this._geometry as unknown as MeshGeometry;
    const b = this._batchable;
    b.texture = this._texture;
    b.transform = this.groupTransform;
    b.color = this.groupColorAlpha;
    b.roundPixels = this._latchRoundPixels(collector);
    b.blendMode = this.groupBlendMode;
    b.topology = g.topology;
    b.positions = g.positions;
    b.uvs = this.batchUvs(g);
    b.indices = g.indices;
    b.attributeSize = g.positions.length / 2;
    b.indexSize = g.indices.length;
    collector.addBatchable(b);
  }

  /** 纹理是图集帧时,uv 要经纹理矩阵映射(照 Pixi BatchableMesh) */
  private batchUvs(g: MeshGeometry): Float32Array {
    const uvBuffer = g.getBuffer('aUV');
    const uvs = uvBuffer.data as Float32Array;
    const tm = this._texture.textureMatrix;
    if (tm.isSimple) return uvs;
    const key = `${tm._updateID}:${uvBuffer._updateID}:${this._texture.uid}`;
    if (!this._transformedUvs || this._transformedUvs.length < uvs.length) this._transformedUvs = new Float32Array(uvs.length);
    if (this._uvKey !== key) {
      this._uvKey = key;
      tm.multiplyUvs(uvs, this._transformedUvs);
    }
    return this._transformedUvs;
  }

  override destroy(options: boolean | DestroyOptions = false): void {
    const tex = this._texture;
    super.destroy(options);
    const destroyTexture = typeof options === 'boolean' ? options : options?.texture;
    if (destroyTexture && tex) {
      const destroySource = typeof options === 'boolean' ? options : options?.textureSource;
      tex.destroy(destroySource);
    }
    this._geometry?.off('update', this.onViewUpdate, this);
  }
}

export interface MeshPlaneOptions extends Omit<MeshOptions, 'geometry'> {
  texture: Texture;
  verticesX?: number;
  verticesY?: number;
}

/** 贴一张纹理的规则网格平面(照 Pixi `MeshPlane`) */
export class MeshPlane extends Mesh<PlaneGeometry> {
  autoResize = true;

  constructor(options: MeshPlaneOptions) {
    const { texture, verticesX, verticesY, ...rest } = options;
    const geometry = new PlaneGeometry({
      width: texture.width,
      height: texture.height,
      ...(verticesX !== undefined ? { verticesX } : {}),
      ...(verticesY !== undefined ? { verticesY } : {}),
    });
    super({ ...rest, geometry, texture });
    this.texture = texture;
  }

  textureUpdated(): void {
    const g = this.geometry;
    if (!g) return;
    const { width, height } = this.texture;
    if (this.autoResize && (g.width !== width || g.height !== height)) {
      g.width = width;
      g.height = height;
      g.build({});
    }
  }

  override get texture(): Texture {
    return super.texture;
  }
  override set texture(value: Texture) {
    super.texture?.off('update', this.textureUpdated, this);
    super.texture = value;
    value.on('update', this.textureUpdated, this);
    this.textureUpdated();
  }

  override destroy(options: boolean | DestroyOptions = false): void {
    this.texture.off('update', this.textureUpdated, this);
    super.destroy(options);
  }
}

export function pointInTriangle(px: number, py: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): boolean {
  const v2x = x3 - x1;
  const v2y = y3 - y1;
  const v1x = x2 - x1;
  const v1y = y2 - y1;
  const v0x = px - x1;
  const v0y = py - y1;
  const dot00 = v2x * v2x + v2y * v2y;
  const dot01 = v2x * v1x + v2y * v1y;
  const dot02 = v2x * v0x + v2y * v0y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v0x + v1y * v0y;
  const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  return u >= 0 && v >= 0 && u + v < 1;
}
