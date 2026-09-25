/**
 * uv 生成与顶点变换。移植自 PixiJS v8.17(MIT):rendering/renderers/shared/geometry/utils/buildUvs、transformVertices。
 */
import type { Matrix } from '../../math/Matrix';

export function buildUvs(
  vertices: number[],
  verticesStride: number,
  verticesOffset: number,
  uvs: number[],
  uvsOffset: number,
  uvsStride: number,
  size: number,
  matrix: Matrix,
): void {
  let index = 0;
  verticesOffset *= verticesStride;
  uvsOffset *= uvsStride;
  const a = matrix.a;
  const b = matrix.b;
  const c = matrix.c;
  const d = matrix.d;
  const tx = matrix.tx;
  const ty = matrix.ty;
  while (index < size) {
    const x = vertices[verticesOffset];
    const y = vertices[verticesOffset + 1];
    uvs[uvsOffset] = a * x + c * y + tx;
    uvs[uvsOffset + 1] = b * x + d * y + ty;
    uvsOffset += uvsStride;
    verticesOffset += verticesStride;
    index++;
  }
}

export function buildSimpleUvs(uvs: number[], uvsOffset: number, uvsStride: number, size: number): void {
  let index = 0;
  uvsOffset *= uvsStride;
  while (index < size) {
    uvs[uvsOffset] = 0;
    uvs[uvsOffset + 1] = 0;
    uvsOffset += uvsStride;
    index++;
  }
}

export function transformVertices(vertices: number[], m: Matrix, offset?: number, stride?: number, size?: number): void {
  const a = m.a;
  const b = m.b;
  const c = m.c;
  const d = m.d;
  const tx = m.tx;
  const ty = m.ty;
  offset ||= 0;
  stride ||= 2;
  size ||= vertices.length / stride - offset;
  let index = offset * stride;
  for (let i = 0; i < size; i++) {
    const x = vertices[index];
    const y = vertices[index + 1];
    vertices[index] = a * x + c * y + tx;
    vertices[index + 1] = b * x + d * y + ty;
    index += stride;
  }
}
