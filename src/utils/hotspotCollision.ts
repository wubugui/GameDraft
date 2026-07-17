import type { HotspotDef } from '../data/types';
import type { Npc } from '../entities/Npc';
import { hasInstanceTransform, transformLocalVector } from './entityTransform';
import { isValidZonePolygon } from './zoneGeometry';

/** 与 HotspotDef / NpcDef 的碰撞字段子集一致（含实例 transform，quad 级真变换）。 */
export type AnchorCollisionDef = {
  collisionPolygon?: { x: number; y: number }[];
  collisionPolygonLocal?: boolean;
  scale?: number;
  rotation?: number;
};

/**
 * 将锚定实体上的 `collisionPolygon` 转为世界坐标多边形。
 * `collisionPolygonLocal === true` 时为相对 (anchorX, anchorY) 的局部坐标；否则视为旧数据（世界坐标）。
 * 实例 transform（def.scale/rotation）在**求值时**绕锚点施加——两种 authored 坐标系统一
 * 绕 (anchorX, anchorY) 缩放×旋转，运行时改字段后命中自动跟随（无需烘焙/失效逻辑）。
 */
export function anchorCollisionPolygonToWorld(
  anchorX: number,
  anchorY: number,
  def: AnchorCollisionDef,
): { x: number; y: number }[] | null {
  const poly = def.collisionPolygon;
  if (!poly || !isValidZonePolygon(poly)) return null;
  const transformed = hasInstanceTransform(def);
  if (def.collisionPolygonLocal !== true) {
    if (!transformed) return poly.map((p) => ({ x: p.x, y: p.y }));
    return poly.map((p) => {
      const v = transformLocalVector(p.x - anchorX, p.y - anchorY, def);
      return { x: anchorX + v.x, y: anchorY + v.y };
    });
  }
  if (!transformed) {
    return poly.map((p) => ({ x: p.x + anchorX, y: p.y + anchorY }));
  }
  return poly.map((p) => {
    const v = transformLocalVector(p.x, p.y, def);
    return { x: anchorX + v.x, y: anchorY + v.y };
  });
}

/**
 * 将热区 collisionPolygon 转为世界坐标多边形。
 * `collisionPolygonLocal === true` 时为相对 (x,y) 的局部坐标；否则视为旧数据（世界坐标）。
 */
export function hotspotCollisionPolygonToWorld(def: HotspotDef): { x: number; y: number }[] | null {
  return anchorCollisionPolygonToWorld(def.x, def.y, def);
}

/**
 * 将 NPC 的 collisionPolygon 转为世界坐标。锚点用运行时 `npc.x`/`npc.y`（巡逻移动后仍正确）。
 */
export function npcCollisionPolygonToWorld(npc: Npc): { x: number; y: number }[] | null {
  return anchorCollisionPolygonToWorld(npc.x, npc.y, npc.def);
}
