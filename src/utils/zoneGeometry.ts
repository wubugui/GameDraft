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

export function isValidZonePolygon(polygon: ReadonlyArray<{ x: number; y: number }> | undefined): boolean {
  if (!polygon || polygon.length < 3) return false;
  for (const p of polygon) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return false;
    }
  }
  return true;
}
