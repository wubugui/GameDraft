import type { Point } from './yamlBlock.js';

export type { Point };

export interface GeometryValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePolygon(points: Point[]): GeometryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (points.length < 3) errors.push(`Polygon needs at least 3 points, got ${points.length}.`);
  if (hasSelfIntersection(points)) warnings.push('Polygon edges appear to self-intersect.');
  return { valid: errors.length === 0, errors, warnings };
}

export function validateRoute(points: Point[]): GeometryValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (points.length < 1) errors.push('Route needs at least 1 point.');
  return { valid: errors.length === 0, errors, warnings };
}

function cross2d(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const d1 = cross2d(b1, b2, a1);
  const d2 = cross2d(b1, b2, a2);
  const d3 = cross2d(a1, a2, b1);
  const d4 = cross2d(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

function hasSelfIntersection(points: Point[]): boolean {
  const n = points.length;
  if (n < 4) return false;
  const closed = [...points, points[0]!];
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsIntersect(closed[i]!, closed[i + 1]!, closed[j]!, closed[j + 1]!)) return true;
    }
  }
  return false;
}

export interface SceneJson {
  [key: string]: unknown;
  zones?: Array<{ id: string; polygon?: Array<{ x: number; y: number }> }>;
  npcs?: Array<{ id: string; x?: number; y?: number; patrol?: { route?: Array<{ x: number; y: number }>; speed?: number } }>;
  hotspots?: Array<{ id: string; x?: number; y?: number; polygon?: Array<{ x: number; y: number }> }>;
}

export function readPolygon(scene: SceneJson, zoneId: string): Point[] | undefined {
  const zone = scene.zones?.find((z) => z.id === zoneId);
  if (!zone?.polygon) return undefined;
  return zone.polygon.map((p) => ({ x: p.x, y: p.y }));
}

export function writePolygon(scene: SceneJson, zoneId: string, points: Point[]): SceneJson {
  const zones = (scene.zones ?? []).map((z) =>
    z.id === zoneId ? { ...z, polygon: points.map((p) => ({ x: p.x, y: p.y })) } : z,
  );
  return { ...scene, zones };
}

export function readRoute(scene: SceneJson, entityId: string): Point[] | undefined {
  const npc = scene.npcs?.find((n) => n.id === entityId);
  if (!npc?.patrol?.route) return undefined;
  return npc.patrol.route.map((p) => ({ x: p.x, y: p.y }));
}

export function writeRoute(scene: SceneJson, entityId: string, points: Point[]): SceneJson {
  const npcs = (scene.npcs ?? []).map((n) => {
    if (n.id !== entityId) return n;
    return { ...n, patrol: { ...(n.patrol ?? {}), route: points.map((p) => ({ x: p.x, y: p.y })) } };
  });
  return { ...scene, npcs };
}

export function listSpawnPoints(scene: SceneJson): string[] {
  const ids: string[] = [];
  if (scene.spawnPoint !== undefined) ids.push('spawnPoint');
  const sp = scene.spawnPoints as Record<string, unknown> | undefined;
  if (sp) ids.push(...Object.keys(sp));
  return ids;
}

export function listZones(scene: SceneJson): string[] {
  return (scene.zones ?? []).map((z) => z.id);
}

export function listEntities(scene: SceneJson): { id: string; kind: 'npc' | 'hotspot'; label?: string }[] {
  const npcs = (scene.npcs ?? []).map((n) => ({
    id: n.id,
    kind: 'npc' as const,
    label: (n as { name?: string }).name,
  }));
  const hotspots = (scene.hotspots ?? []).map((h) => ({
    id: h.id,
    kind: 'hotspot' as const,
    label: (h as { label?: string }).label,
  }));
  return [...npcs, ...hotspots];
}

export function patchSceneJsonText(text: string, updatedScene: SceneJson): string {
  try {
    JSON.parse(text);
  } catch {
    return JSON.stringify(updatedScene, null, 2);
  }
  return JSON.stringify(updatedScene, null, 2);
}
