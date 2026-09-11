/**
 * 位置引用（`PositionRef`）的解析与求值——所有"引用一个点"的动作参数共用的一份数学。
 *
 * 四种来源（2026-09-11 制作人定）：
 * - `point`：一对场景坐标数字；
 * - `entity`：某个实体此刻的位置（player / NPC / 过场临时演员 / 热点）；
 * - `slot`：某条**场景曲线**的命名插槽——曲线暴露给场景的位置，引用是活的（曲线改了插槽跟着动）。
 *   相对曲线（`binding:'free'`）的插槽没有绝对位置，引用它是内容错（构建期校验拦，运行时 warn + null）。
 * - `curve`：**曲线上的点**（制作人要的"曲线 eval 的实时点"）：在烘好的帧上按时刻 / 进度取值，
 *   再加上"这条曲线此刻在哪播"。那条轨迹**正在播**就用这次播放的位置（铜钱还在飞时，末帧点就是它
 *   这次真要落的地方，且那次播放用的是当前场景投影过的帧）；没在播就按场景曲线的原点算。
 *   相对曲线又没在播 = 没有绝对位置（内容错）。用它可以不必为"落点"专门摆一个插槽。
 *
 * 这里不碰 Game / SceneManager：谁能查实体位置、谁能装资产由调用方以 {@link PositionRefLookups} 注入，
 * 所以可以在 vitest 里用假查找钉住每一条路径。动作侧的约定：`at` 有值就覆盖同动作的 `x/y`。
 */
import type {
  CurvePointPick, PositionRef, TrajectoryAsset, TrajectoryKeyframe, TrajectorySlot,
} from '../data/types';
import { sampleKeyframeTrack } from './keyframeSampler';

export interface PositionRefLookups {
  /** 实体此刻的位置；找不到返回 null */
  entityPosition: (id: string) => { x: number; y: number } | null;
  /** 装一条轨迹资产（缺失返回 null）；实现方自己缓存 */
  loadTrajectory: (trajectoryId: string) => Promise<TrajectoryAsset | null>;
  /** 当前场景 id（场景曲线拿到别的场景用要出声；不给就不查） */
  currentSceneId?: () => string;
  /**
   * 这条轨迹**此刻在跑**的那次播放：这次用的 2D 相对帧（已按当前场景投影）+ 播放位置。
   * `curve` 档的"实时"就靠它；没在跑返回 null。不给这个查找 = 只按作者场景的原点算。
   */
  liveTrajectoryPlay?: (trajectoryId: string) => {
    keyframes: readonly TrajectoryKeyframe[];
    anchor: { x: number; y: number };
  } | null;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 把动作参数里的 `at` 规范成 {@link PositionRef}；形状不对返回 null（调用方 warn 并按没给处理）。
 * 也接受没写 `kind` 的 `{x, y}`（当 point）和裸字符串（当 entity id）——策划手写 JSON 的最短写法。
 */
export function parsePositionRef(raw: unknown): PositionRef | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const id = raw.trim();
    return id ? { kind: 'entity', id } : null;
  }
  if (typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? o.kind.trim() : '';
  if (kind === 'entity') {
    const id = String(o.id ?? '').trim();
    return id ? { kind: 'entity', id } : null;
  }
  if (kind === 'slot') {
    const trajectoryId = String(o.trajectoryId ?? '').trim();
    const slotId = String(o.slotId ?? '').trim();
    return trajectoryId && slotId ? { kind: 'slot', trajectoryId, slotId } : null;
  }
  if (kind === 'curve') {
    const trajectoryId = String(o.trajectoryId ?? '').trim();
    if (!trajectoryId) return null;
    const atMs = finite(o.atMs);
    const progress = finite(o.progress);
    const raw = typeof o.point === 'string' ? o.point.trim() : '';
    let point: CurvePointPick;
    if (raw === 'start' || raw === 'end' || raw === 'time' || raw === 'progress') point = raw;
    else if (atMs !== null) point = 'time';
    else if (progress !== null) point = 'progress';
    else point = 'end';
    const out: PositionRef = { kind: 'curve', trajectoryId, point };
    if (point === 'time') out.atMs = atMs ?? 0;
    if (point === 'progress') out.progress = progress ?? 1;
    return out;
  }
  if (kind === 'point' || kind === '') {
    const x = finite(o.x);
    const y = finite(o.y);
    return x !== null && y !== null ? { kind: 'point', x, y } : null;
  }
  return null;
}

/** 曲线的类型：缺省按老资产推（有 `authoring.sceneId` 的当场景曲线）。 */
export function trajectoryBinding(asset: TrajectoryAsset): 'scene' | 'free' {
  if (asset.binding === 'scene' || asset.binding === 'free') return asset.binding;
  return asset.authoring?.sceneId ? 'scene' : 'free';
}

/**
 * **曲线原点**在作者场景里的画面位置：帧相对它写，播放位置对齐的就是它，场景曲线不给位置就在这儿原地播。
 * 老资产退到 `anchor`。⚠ 它不是第一帧（作者可以单独摆），所以别拿"首帧 = (0,0)"当不变量。
 */
export function trajectoryOrigin(asset: TrajectoryAsset): { x: number; y: number } | null {
  const o = asset.authoring?.origin ?? asset.authoring?.anchor;
  if (!o) return null;
  const x = finite(o.x);
  const y = finite(o.y);
  return x !== null && y !== null ? { x, y } : null;
}

export function findTrajectorySlot(asset: TrajectoryAsset, slotId: string): TrajectorySlot | null {
  if (!Array.isArray(asset.slots)) return null;
  return asset.slots.find((s) => s && String(s.id) === slotId) ?? null;
}

/** 曲线上某个点相对曲线原点的偏移（在烘好的帧上取值；帧里没写的通道由采样器补缺省）。 */
export function sampleTrajectoryOffset(
  frames: readonly TrajectoryKeyframe[],
  ref: { point?: CurvePointPick; atMs?: number; progress?: number },
): { x: number; y: number } | null {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const last = frames[frames.length - 1];
  const totalMs = finite(last?.atMs) ?? 0;
  const pick = ref.point ?? 'end';
  let t: number;
  if (pick === 'start') t = finite(frames[0]?.atMs) ?? 0;
  else if (pick === 'end') t = totalMs;
  else if (pick === 'time') t = finite(ref.atMs) ?? 0;
  else t = totalMs * Math.min(1, Math.max(0, finite(ref.progress) ?? 1));
  // 采样器自己钳两端（t ≤ 首帧 → 首帧、t ≥ 末帧 → 末帧），所以越界的 atMs 不用另外判
  const s = sampleKeyframeTrack(frames, t, { channels: { x: 0, y: 0 } });
  return { x: s.x, y: s.y };
}

/**
 * 求值。失败一律 `null` + `console.warn`（动作侧按"没给位置"处理），绝不抛：位置引用错是内容错，
 * 不该把整段演出炸掉。
 */
export async function resolvePositionRef(
  ref: PositionRef | null | undefined,
  lookups: PositionRefLookups,
): Promise<{ x: number; y: number } | null> {
  if (!ref) return null;
  if (ref.kind === 'point') return { x: ref.x, y: ref.y };
  if (ref.kind === 'entity') {
    const p = lookups.entityPosition(ref.id);
    if (!p) console.warn(`[positionRef] 找不到实体 "${ref.id}"，位置引用作废`);
    return p;
  }
  if (ref.kind === 'curve') return resolveCurvePoint(ref, lookups);
  const asset = await lookups.loadTrajectory(ref.trajectoryId);
  if (!asset) {
    console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 装不上，插槽 "${ref.slotId}" 作废`);
    return null;
  }
  if (trajectoryBinding(asset) !== 'scene') {
    console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 是相对曲线，它的插槽没有绝对位置，不能当位置引用`);
    return null;
  }
  const slot = findTrajectorySlot(asset, ref.slotId);
  if (!slot) {
    console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 没有插槽 "${ref.slotId}"`);
    return null;
  }
  const x = finite(slot.x);
  const y = finite(slot.y);
  if (x === null || y === null) {
    console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 插槽 "${ref.slotId}" 坐标不是有限数`);
    return null;
  }
  const scene = lookups.currentSceneId?.();
  if (scene && asset.authoring?.sceneId && asset.authoring.sceneId !== scene) {
    console.warn(`[positionRef] 场景曲线 "${ref.trajectoryId}" 绑定的是 "${asset.authoring.sceneId}"，当前是 "${scene}"：插槽坐标按作者场景给`);
  }
  return { x, y };
}

/**
 * `curve` 档：曲线上的点 = 帧上取的偏移 + 这条曲线此刻的播放位置。
 *
 * 播放位置的两档，顺序不能反：
 * 1. **正在播** → 用那次播放的锚点与那次的帧（帧已按当前场景投影，世界空间资产跨场景也准）——
 *    这就是"实时点"：铜钱还在飞，`end` 取到的就是它这次真要落的地方；
 * 2. 没在播 → 场景曲线按作者摆的原点算（静态引用，曲线在工作台里改了它跟着变）。
 *    相对曲线不绑场景、又没在播，就是没有绝对位置可言（内容错，构建期校验拦）。
 */
async function resolveCurvePoint(
  ref: Extract<PositionRef, { kind: 'curve' }>,
  lookups: PositionRefLookups,
): Promise<{ x: number; y: number } | null> {
  const live = lookups.liveTrajectoryPlay?.(ref.trajectoryId) ?? null;
  if (live) {
    const off = sampleTrajectoryOffset(live.keyframes, ref);
    if (!off) {
      console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 这次播放没有帧，曲线点作废`);
      return null;
    }
    return { x: live.anchor.x + off.x, y: live.anchor.y + off.y };
  }
  const asset = await lookups.loadTrajectory(ref.trajectoryId);
  if (!asset) {
    console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 装不上，曲线点作废`);
    return null;
  }
  if (trajectoryBinding(asset) !== 'scene') {
    console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 是相对曲线：不在播的时候它的点没有绝对位置`);
    return null;
  }
  const origin = trajectoryOrigin(asset);
  if (!origin) {
    console.warn(`[positionRef] 场景曲线 "${ref.trajectoryId}" 没有 authoring.origin，曲线点算不出来（在轨迹工作台重存一次会回填）`);
    return null;
  }
  const off = sampleTrajectoryOffset(asset.keyframes, ref);
  if (!off) {
    console.warn(`[positionRef] 轨迹 "${ref.trajectoryId}" 没有 keyframes（没烘过？），曲线点作废`);
    return null;
  }
  const scene = lookups.currentSceneId?.();
  if (scene && asset.authoring?.sceneId && asset.authoring.sceneId !== scene) {
    console.warn(`[positionRef] 场景曲线 "${ref.trajectoryId}" 绑定的是 "${asset.authoring.sceneId}"，当前是 "${scene}"：曲线点按作者场景给`);
  }
  return { x: origin.x + off.x, y: origin.y + off.y };
}
