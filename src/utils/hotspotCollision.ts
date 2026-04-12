import type { HotspotDef } from '../data/types';
import { isValidZonePolygon } from './zoneGeometry';

/**
 * 将热区 collisionPolygon 转为世界坐标多边形。
 * `collisionPolygonLocal === true` 时为相对 (x,y) 的局部坐标；否则视为旧数据（世界坐标）。
 */
export function hotspotCollisionPolygonToWorld(def: HotspotDef): { x: number; y: number }[] | null {
  const poly = def.collisionPolygon;
  if (!poly || !isValidZonePolygon(poly)) return null;
  if (def.collisionPolygonLocal !== true) {
    return poly.map((p) => ({ x: p.x, y: p.y }));
  }
  const ox = def.x;
  const oy = def.y;
  return poly.map((p) => ({ x: p.x + ox, y: p.y + oy }));
}
