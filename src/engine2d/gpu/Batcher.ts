/**
 * 合批(照 Pixi 8.17 `Batcher` + `DefaultBatcher`,打包公式一字不差):元素按加入顺序在顶点 / 索引数组里占位,
 * `break()` 时把自上次断开以来的元素打包、按「纹理数 ≤ 16、混合模式与拓扑相同」切成批。
 * 顶点布局 24 字节:aPosition f32x2 | aUV f32x2 | aColor unorm8x4 | aTextureIdAndRound uint16x2。
 */
import { BLEND_TO_NPM } from './blendNpm';
import type { BatchableElement } from '../core/contracts';
import type { BlendMode } from '../core/blendModes';
import type { TextureSource } from '../textures/TextureSource';
import type { Topology } from '../shader/Geometry';
import { MAX_BATCH_TEXTURES } from './batchShader';

export const BATCH_VERTEX_FLOATS = 6;

export interface BatchRecord {
  readonly t: 'batch';
  textures: TextureSource[];
  blendMode: BlendMode;
  topology: Topology;
  /** 索引区间 */
  start: number;
  size: number;
}

export function adjustedBlendMode(blendMode: BlendMode, source: TextureSource): BlendMode {
  if (source.alphaMode === 'no-premultiply-alpha') return (BLEND_TO_NPM[blendMode] as BlendMode | undefined) ?? blendMode;
  return blendMode;
}

export class Batcher {
  attr = new ArrayBuffer(4 * 1024 * 4);
  f32 = new Float32Array(this.attr);
  u32 = new Uint32Array(this.attr);
  indices = new Uint32Array(6 * 1024);
  /** 已占用的顶点浮点数 / 索引数 */
  attributeSize = 0;
  indexSize = 0;
  private readonly pending: BatchableElement[] = [];
  private readonly pendingAttr: number[] = [];
  private readonly pendingIndex: number[] = [];
  private batchIndexStart = 0;
  private batchIndexSize = 0;

  begin(): void {
    this.attributeSize = 0;
    this.indexSize = 0;
    this.pending.length = 0;
    this.pendingAttr.length = 0;
    this.pendingIndex.length = 0;
    this.batchIndexStart = 0;
    this.batchIndexSize = 0;
  }

  add(el: BatchableElement): void {
    this.pending.push(el);
    this.pendingIndex.push(this.indexSize);
    this.pendingAttr.push(this.attributeSize);
    this.indexSize += el.indexSize;
    this.attributeSize += el.attributeSize * BATCH_VERTEX_FLOATS;
  }

  break(out: BatchRecord[]): void {
    const elements = this.pending;
    if (elements.length === 0) return;
    this.ensure(this.attributeSize, this.indexSize);
    const f32 = this.f32;
    const u32 = this.u32;
    const indexBuffer = this.indices;
    const first = elements[0];
    let blendMode = adjustedBlendMode(first.blendMode, first.texture.source);
    let topology = first.topology;
    let size = this.batchIndexSize;
    let start = this.batchIndexStart;
    let textures: TextureSource[] = [];
    let ids = new Map<TextureSource, number>();
    const finish = (): void => {
      out.push({ t: 'batch', textures, blendMode, topology, start, size: size - start });
    };
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const source = el.texture.source;
      const adjusted = adjustedBlendMode(el.blendMode, source);
      const breakRequired = blendMode !== adjusted || topology !== el.topology;
      let textureId = ids.get(source);
      if (textureId === undefined || breakRequired) {
        if (textures.length >= MAX_BATCH_TEXTURES || breakRequired) {
          finish();
          start = size;
          blendMode = adjusted;
          topology = el.topology;
          textures = [];
          ids = new Map();
        }
        textureId = textures.length;
        ids.set(source, textureId);
        textures.push(source);
      }
      size += el.indexSize;
      const attributeStart = this.pendingAttr[i];
      if (el.packAsQuad) {
        packQuadAttributes(el, f32, u32, attributeStart, textureId);
        packQuadIndex(indexBuffer, this.pendingIndex[i], attributeStart / BATCH_VERTEX_FLOATS);
      } else {
        packAttributes(el, f32, u32, attributeStart, textureId);
        packIndex(el, indexBuffer, this.pendingIndex[i], attributeStart / BATCH_VERTEX_FLOATS);
      }
    }
    if (textures.length > 0) {
      finish();
      start = size;
    }
    this.batchIndexStart = start;
    this.batchIndexSize = size;
    this.pending.length = 0;
    this.pendingAttr.length = 0;
    this.pendingIndex.length = 0;
  }

  private ensure(floats: number, indices: number): void {
    if (floats * 4 > this.attr.byteLength) {
      let n = this.attr.byteLength;
      while (n < floats * 4) n *= 2;
      const next = new ArrayBuffer(n);
      new Uint8Array(next).set(new Uint8Array(this.attr));
      this.attr = next;
      this.f32 = new Float32Array(next);
      this.u32 = new Uint32Array(next);
    }
    if (indices > this.indices.length) {
      let n = this.indices.length;
      while (n < indices) n *= 2;
      const next = new Uint32Array(n);
      next.set(this.indices);
      this.indices = next;
    }
  }
}

function packAttributes(el: BatchableElement, f32: Float32Array, u32: Uint32Array, index: number, textureId: number): void {
  const textureIdAndRound = (textureId << 16) | (el.roundPixels & 0xffff);
  const wt = el.transform;
  const { a, b, c, d, tx, ty } = wt;
  const positions = el.positions!;
  const uvs = el.uvs!;
  const argb = el.color;
  const offset = el.attributeOffset;
  const end = offset + el.attributeSize;
  for (let i = offset; i < end; i++) {
    const i2 = i * 2;
    const x = positions[i2];
    const y = positions[i2 + 1];
    f32[index++] = a * x + c * y + tx;
    f32[index++] = d * y + b * x + ty;
    f32[index++] = uvs[i2];
    f32[index++] = uvs[i2 + 1];
    u32[index++] = argb;
    u32[index++] = textureIdAndRound;
  }
}

function packQuadAttributes(el: BatchableElement, f32: Float32Array, u32: Uint32Array, index: number, textureId: number): void {
  const uvs = el.texture.uvs;
  const { a, b, c, d, tx, ty } = el.transform;
  const bounds = el.bounds!;
  const w0 = bounds.maxX;
  const w1 = bounds.minX;
  const h0 = bounds.maxY;
  const h1 = bounds.minY;
  const argb = el.color;
  const textureIdAndRound = (textureId << 16) | (el.roundPixels & 0xffff);
  f32[index + 0] = a * w1 + c * h1 + tx;
  f32[index + 1] = d * h1 + b * w1 + ty;
  f32[index + 2] = uvs.x0;
  f32[index + 3] = uvs.y0;
  u32[index + 4] = argb;
  u32[index + 5] = textureIdAndRound;
  f32[index + 6] = a * w0 + c * h1 + tx;
  f32[index + 7] = d * h1 + b * w0 + ty;
  f32[index + 8] = uvs.x1;
  f32[index + 9] = uvs.y1;
  u32[index + 10] = argb;
  u32[index + 11] = textureIdAndRound;
  f32[index + 12] = a * w0 + c * h0 + tx;
  f32[index + 13] = d * h0 + b * w0 + ty;
  f32[index + 14] = uvs.x2;
  f32[index + 15] = uvs.y2;
  u32[index + 16] = argb;
  u32[index + 17] = textureIdAndRound;
  f32[index + 18] = a * w1 + c * h0 + tx;
  f32[index + 19] = d * h0 + b * w1 + ty;
  f32[index + 20] = uvs.x3;
  f32[index + 21] = uvs.y3;
  u32[index + 22] = argb;
  u32[index + 23] = textureIdAndRound;
}

function packQuadIndex(indexBuffer: Uint32Array, index: number, indicesOffset: number): void {
  indexBuffer[index] = indicesOffset + 0;
  indexBuffer[index + 1] = indicesOffset + 1;
  indexBuffer[index + 2] = indicesOffset + 2;
  indexBuffer[index + 3] = indicesOffset + 0;
  indexBuffer[index + 4] = indicesOffset + 2;
  indexBuffer[index + 5] = indicesOffset + 3;
}

function packIndex(el: BatchableElement, indexBuffer: Uint32Array, index: number, indicesOffset: number): void {
  const indices = el.indices!;
  const size = el.indexSize;
  const indexOffset = el.indexOffset;
  const attributeOffset = el.attributeOffset;
  for (let i = 0; i < size; i++) indexBuffer[index++] = indicesOffset + indices[i + indexOffset] - attributeOffset;
}
