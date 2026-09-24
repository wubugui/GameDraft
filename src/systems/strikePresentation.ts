import { sampleStrictShellSurface, type DepthShellField, type ShellBasis } from '../utils/depthShellField';
import type { Vec3 } from '../utils/sceneSpace';
import { pointInPolygon } from './vfx/vfxConfine';
import { SURFACE_TOLERANCE_WU, type VfxSpace } from './vfx/vfxSpace';

/** Keep the measured surface point through VFX, light and sound placement. */
export interface StrikeSurfacePoint {
  x: number;
  y: number;
  world: Vec3;
  normal: Vec3;
  kind: 'ground' | 'object';
  areaWu2: number;
}

// Scene geometry and collision authority are immutable for the lifetime of VfxSpace.
// Warm this catalogue behind the scene reveal gate; weak ownership releases old scenes.
// `all` is NOT a validity mask: non-ground entries require explicit author inclusion.
const surfaceCatalogues = new WeakMap<VfxSpace, {
  shell: DepthShellField; basis: number[]; wuPerQ: number;
  groundAllowed: (x: number, y: number) => boolean;
  all: StrikeSurfacePoint[]; ground: StrikeSurfacePoint[];
}>();

/**
 * Scene catalogue of observed surfaces, never a random volume of air.
 * The shell supplies unaveraged depth; the caller supplies surface authority:
 * confirmed ground, or an explicitly designated surface inclusion polygon.
 */
export function buildStrikeSurfaceCandidates(opts: {
  space: VfxSpace;
  shell: DepthShellField;
  basis: ShellBasis;
  groundAllowed: (x: number, y: number) => boolean;
  surfaceRegion?: readonly (readonly [number, number])[];
  groundOnly: boolean;
  maxSlopeDeg: number;
}): StrikeSurfacePoint[] {
  const { space, shell, basis, surfaceRegion } = opts;
  if (space.kind !== 'field' || !space.hasShell) return [];
  if (surfaceRegion && (surfaceRegion.length < 3 || surfaceRegion.some(p => !p.every(Number.isFinite)))) return [];
  const minUp = Math.cos(Math.max(0, Math.min(90, opts.maxSlopeDeg)) * Math.PI / 180);
  let cache = surfaceCatalogues.get(space);
  if (!cache || cache.shell !== shell || cache.wuPerQ !== basis.wuPerQUnit
    || cache.groundAllowed !== opts.groundAllowed || cache.basis.some((v, i) => v !== basis.basisRows[i])) {
    const all: StrikeSurfacePoint[] = [], ground: StrikeSurfacePoint[] = [];
    const scene = { x: 0, y: 0 };
    for (let y = 1; y < shell.h - 1; y++) for (let x = 1; x < shell.w - 1; x++) {
      const hit = sampleStrictShellSurface(shell, basis, x, y);
      if (!hit) continue;
      space.toScene(hit.p, scene);
      if (!Number.isFinite(scene.x) || !Number.isFinite(scene.y)) continue;
      const g = space.groundWorldAtScene(scene.x, scene.y);
      const isGround = g.every(Number.isFinite)
        && Math.hypot(hit.p[0] - g[0], hit.p[1] - g[1], hit.p[2] - g[2]) <= SURFACE_TOLERANCE_WU
        && space.groundObserved(g[0], g[2]);
      const p: StrikeSurfacePoint = { x: scene.x, y: scene.y, world: hit.p, normal: hit.normal,
        kind: isGround ? 'ground' : 'object', areaWu2: hit.areaWu2 };
      all.push(p);
      // Finite depth alone never authorizes a hit. Unknown collision is not ground.
      if (isGround && opts.groundAllowed(p.x, p.y)) ground.push(p);
    }
    cache = { shell, basis: Array.from(basis.basisRows), wuPerQ: basis.wuPerQUnit,
      groundAllowed: opts.groundAllowed, all, ground };
    surfaceCatalogues.set(space, cache);
  }
  return (surfaceRegion ? cache.all : cache.ground).filter(p =>
    (!surfaceRegion || pointInPolygon(surfaceRegion, p.x, p.y))
    && (p.kind === 'ground' ? p.normal[1] + 1e-6 >= minUp : !opts.groundOnly));
}

/** World-distance filtering happens AFTER landing on the measured surface. */
export function sampleStrikeFallback(opts: {
  from: Vec3; radius: number; minDistance: number; separation: number;
  previous: readonly Vec3[]; random: { angle: number; radius: number };
  candidates: readonly StrikeSurfacePoint[];
  bounds: { left: number; right: number; top: number; bottom: number };
  strictSeparation?: boolean;
}): StrikeSurfacePoint | null {
  const { from, radius, bounds } = opts;
  if (!from.every(Number.isFinite) || !Number.isFinite(radius) || radius < 0
    || !Number.isFinite(opts.minDistance) || opts.minDistance < 0 || opts.minDistance > radius
    || bounds.left >= bounds.right || bounds.top >= bounds.bottom) return null;
  const eligible: { p: StrikeSurfacePoint; spaced: boolean }[] = [];
  let total = 0, spacedTotal = 0;
  for (const p of opts.candidates) {
    if (p.x < bounds.left || p.x > bounds.right || p.y < bounds.top || p.y > bounds.bottom) continue;
    const distance = Math.hypot(p.world[0] - from[0], p.world[1] - from[1], p.world[2] - from[2]);
    if (distance < opts.minDistance || distance > radius || !(p.areaWu2 > 0) || !Number.isFinite(distance)) continue;
    const spaced = opts.previous.every(q => Math.hypot(p.world[0] - q[0], p.world[1] - q[1], p.world[2] - q[2]) >= opts.separation);
    eligible.push({ p, spaced });
    total += p.areaWu2;
    if (spaced) spacedTotal += p.areaWu2;
  }
  // Only optional spacing may soften; radius, surface and viewport never do.
  const useSpaced = spacedTotal > 0;
  if (!useSpaced && opts.strictSeparation) return null;
  const weight = useSpaced ? spacedTotal : total;
  if (!(weight > 0) || !Number.isFinite(weight)) return null;
  // Independent cosmetic draws: never consume the gameplay RNG stream.
  const unit = ((opts.random.angle + opts.random.radius) % 1 + 1) % 1;
  let remaining = unit * weight;
  let last: StrikeSurfacePoint | null = null;
  for (const { p, spaced } of eligible) {
    if (useSpaced && !spaced) continue;
    last = p;
    remaining -= p.areaWu2;
    if (remaining < 0) return p;
  }
  return last;
}

/**
 * 从雷形效果池里给这一道雷挑一个变体：**同一条雷链里不重样**，池用完了才允许重复。
 *
 * 一次施法的五道雷若各自独立抽，十选五撞形的概率约七成（2026-09-23 实测 9 次施法只有 3 次五道全不同）——
 * 同一张雷形在一场雷暴里出现两次，一眼就露馅。每道仍只吃调用方给的一个随机数 `pick ∈ [0,1)`，
 * 所以雷链的其余随机（概率 / 间隔 / 落点）一个不变。挑中的会记进 `used`（调用方整条链共用一份）。
 * 池为空返回 `null`（调用方退回单个 `effect`）。
 */
export function pickBoltVariant(pool: readonly string[], pick: number, used: Set<string>): string | null {
  if (pool.length === 0) return null;
  const fresh = pool.filter((id) => !used.has(id));
  const choices = fresh.length > 0 ? fresh : pool;
  const p = Number.isFinite(pick) ? Math.min(Math.max(pick, 0), 1 - Number.EPSILON) : 0;
  const effect = choices[Math.floor(p * choices.length) % choices.length];
  used.add(effect);
  return effect;
}
