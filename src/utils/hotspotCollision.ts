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
 * @param extraScale 场景透视缩放系数 f(footY)（等比、绕同一锚点，与旋转对易）；缺省 1
 */
export function anchorCollisionPolygonToWorld(
  anchorX: number,
  anchorY: number,
  def: AnchorCollisionDef,
  extraScale = 1,
): { x: number; y: number }[] | null {
  const poly = def.collisionPolygon;
  if (!poly || !isValidZonePolygon(poly)) return null;
  const es = Number.isFinite(extraScale) && extraScale > 0 ? extraScale : 1;
  const transformed = hasInstanceTransform(def) || es !== 1;
  if (def.collisionPolygonLocal !== true) {
    if (!transformed) return poly.map((p) => ({ x: p.x, y: p.y }));
    return poly.map((p) => {
      const v = transformLocalVector(p.x - anchorX, p.y - anchorY, def);
      return { x: anchorX + v.x * es, y: anchorY + v.y * es };
    });
  }
  if (!transformed) {
    return poly.map((p) => ({ x: p.x + anchorX, y: p.y + anchorY }));
  }
  return poly.map((p) => {
    const v = transformLocalVector(p.x, p.y, def);
    return { x: anchorX + v.x * es, y: anchorY + v.y * es };
  });
}

/**
 * 将热区 collisionPolygon 转为世界坐标多边形。
 * `collisionPolygonLocal === true` 时为相对 (x,y) 的局部坐标；否则视为旧数据（世界坐标）。
 */
export function hotspotCollisionPolygonToWorld(
  def: HotspotDef,
  extraScale = 1,
): { x: number; y: number }[] | null {
  return anchorCollisionPolygonToWorld(def.x, def.y, def, extraScale);
}

/**
 * 将 NPC 的 collisionPolygon 转为世界坐标。锚点用运行时 `npc.x`/`npc.y`（巡逻移动后仍正确）；
 * 透视系数直接读实例（随移动自动跟随）。
 */
export function npcCollisionPolygonToWorld(npc: Npc): { x: number; y: number }[] | null {
  return anchorCollisionPolygonToWorld(npc.x, npc.y, npc.def, npc.depthScaleFactor);
}
