/**
 * Zone 多边形几何：点在简单多边形内（射线法）。
 */

export function isPointInPolygon(
  polygon: ReadonlyArray<{ x: number; y: number }>,
  px: number,
  py: number,
): boolean {
  const n = polygon.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const dy = yj - yi;
    if (Math.abs(dy) < 1e-12) continue;
    const xinters = xi + ((xj - xi) * (py - yi)) / dy;
    if ((yi > py) !== (yj > py) && px < xinters) inside = !inside;
  }
  return inside;
}

/**
 * 竖直扫描线法：判断点 (px,py) 在多边形的上方(far)、下方(near) 还是内部。
 * 在 x=px 处求多边形所有边的 Y 交点，比较 py 与 yMin/yMax。
 * 支持凸/凹多边形。若 x=px 无交点（点在多边形水平范围外），返回 null。
 */
export function pointPolygonVerticalSide(
  polygon: ReadonlyArray<{ x: number; y: number }>,
  px: number,
  py: number,
): 'above' | 'below' | 'inside' | null {
  const n = polygon.length;
  if (n < 3) return null;
  let yMin = Infinity;
  let yMax = -Infinity;
  let hitCount = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x;
    const xj = polygon[j].x;
    if ((xi <= px && xj >= px) || (xj <= px && xi >= px)) {
      const dx = xj - xi;
      const t = Math.abs(dx) < 1e-12 ? 0.5 : (px - xi) / dx;
      if (t < 0 || t > 1) continue;
      const yi = polygon[i].y;
      const yj = polygon[j].y;
      const yHit = yi + t * (yj - yi);
      if (yHit < yMin) yMin = yHit;
      if (yHit > yMax) yMax = yHit;
      hitCount++;
    }
  }
  if (hitCount === 0) return null;
  if (py < yMin) return 'above';
  if (py > yMax) return 'below';
  return 'inside';
}

export function isValidZonePolygon(polygon: ReadonlyArray<{ x: number; y: number }> | undefined): boolean {
  if (!polygon || polygon.length < 3) return false;
  for (const p of polygon) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return false;
    }
  }
  return true;
}
