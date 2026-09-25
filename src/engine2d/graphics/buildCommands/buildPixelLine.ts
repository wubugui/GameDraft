/**
 * 1 像素线(line-list 拓扑)。移植自 PixiJS v8.17(MIT):scene/graphics/shared/buildCommands/buildPixelLine。
 */
import { closePointEps } from '../const';

export function buildPixelLine(points: number[], closed: boolean, vertices: number[], indices: number[]): void {
  const eps = closePointEps;
  if (points.length === 0) {
    return;
  }
  const fx = points[0];
  const fy = points[1];
  const lx = points[points.length - 2];
  const ly = points[points.length - 1];
  const closePath = closed || (Math.abs(fx - lx) < eps && Math.abs(fy - ly) < eps);
  const verts = vertices;
  const length = points.length / 2;
  const indexStart = verts.length / 2;
  for (let i = 0; i < length; i++) {
    verts.push(points[i * 2]);
    verts.push(points[i * 2 + 1]);
  }
  for (let i = 0; i < length - 1; i++) {
    indices.push(indexStart + i, indexStart + i + 1);
  }
  if (closePath) {
    indices.push(indexStart + length - 1, indexStart);
  }
}
