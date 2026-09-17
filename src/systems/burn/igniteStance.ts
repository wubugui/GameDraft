/**
 * 点火站位的**纯数据**版本（燃烧工作台打包它，在编辑器里画出每个着火点左右两个站位）。
 *
 * 游戏里点火表演走 `SpriteEntity.predictAttachmentPointOffset`（读实体上已挂好的挂件与贴图），这里吃的是
 * 同一批**数据**（动画包 anim.json / sockets.json、挂件预设、贴图像素尺寸），拼的是同一组纯函数
 * （`socketPoseToLocal` + `attachmentPointLocal` + `solveIgniteStance`，求解器住在这里——不依赖游戏状态机，工作台包不牵 types.ts）——`igniteStance.test.ts` 钉着两条路逐位相同。
 */
import { attachmentPointLocal, socketPoseToLocal, type AttachmentPlacement } from '../../data/animationSockets';
import type { SocketFramePose } from '../../data/types';

export interface IgniteStanceQuery {
  /** 接触帧时火头相对脚底的偏移（场景 wu）；这一帧没标挂点等 ⇒ null */
  tipOffset(facing: 1 | -1, depthScale: number): { x: number; y: number } | null;
  /** 脚点处的透视系数 */
  depthScaleAt(x: number, y: number): number;
}

/**
 * 解站位：脚底 = 目标 − 火头偏移（透视系数随脚点变，不动点迭代）。
 * 返回脚点与残差（火头与目标在画面上差多少 wu）；解不出（这一帧没标挂点）⇒ null。
 */
export function solveIgniteStance(
  target: { x: number; y: number },
  start: { x: number; y: number },
  facing: 1 | -1,
  q: IgniteStanceQuery,
  iterations = 32,
): { x: number; y: number; residual: number } | null {
  let fx = start.x;
  let fy = start.y;
  for (let k = 0; k < iterations; k++) {
    const o = q.tipOffset(facing, q.depthScaleAt(fx, fy));
    if (!o) return null;
    const nx = target.x - o.x;
    const ny = target.y - o.y;
    const moved = Math.hypot(nx - fx, ny - fy);
    fx = nx;
    fy = ny;
    if (moved < 1e-9) break;
  }
  const o = q.tipOffset(facing, q.depthScaleAt(fx, fy));
  if (!o) return null;
  return { x: fx, y: fy, residual: Math.hypot(fx + o.x - target.x, fy + o.y - target.y) };
}

export interface IgniteStanceData {
  /** anim.json 里用得到的几项 */
  anim: {
    worldWidth: number;
    worldHeight: number;
    states: Record<string, { frames: number[] }>;
  };
  /** 逻辑状态 → 片段（`game_config.playerAvatar.stateMap`） */
  stateMap?: Record<string, string>;
  /** sockets.json 里用得到的几项 */
  sockets: {
    sockets: Record<string, { poses: Record<string, SocketFramePose> }>;
    igniteSlots?: number[];
  };
  /** 挂在哪个挂点（玩家右手） */
  socket: string;
  /** 点火片段的逻辑状态名 */
  logical: string;
  /** 挂件摆法（预设的 scale / anchor / rotation / mirror + 贴图像素尺寸） */
  attach: AttachmentPlacement;
  /** 起火点（贴图内归一化；没写起火点 = 支点） */
  u: number;
  v: number;
}

export interface IgniteContact {
  clip: string;
  frame: number;
  slot: number;
  marked: boolean;
}

/** 点火片段的接触帧（与 `SpriteEntity.igniteContactFrame` 同口径）；片段不存在 ⇒ null（调用方退 idle） */
export function igniteContactOf(d: IgniteStanceData, logical = d.logical): IgniteContact | null {
  const clip = d.stateMap?.[logical] ?? logical;
  const seq = d.anim.states[clip]?.frames;
  if (!seq || seq.length === 0) return null;
  const marks = new Set(d.sockets.igniteSlots ?? []);
  for (let i = 0; i < seq.length; i++) if (marks.has(seq[i])) return { clip, frame: i, slot: seq[i], marked: true };
  return { clip, frame: 0, slot: seq[0], marked: false };
}

/** 接触帧时火头相对脚底的偏移（场景 wu）；这一帧没标挂点 ⇒ null。玩家缺省底中锚点、无外层变换 */
export function igniteTipOffset(d: IgniteStanceData, contact: IgniteContact, facing: 1 | -1, depthScale: number): { x: number; y: number } | null {
  const raw = d.sockets.sockets[d.socket]?.poses[String(contact.slot)];
  if (!raw) return null;
  const pose = socketPoseToLocal(raw, {
    worldWidth: d.anim.worldWidth,
    worldHeight: d.anim.worldHeight,
    depthScale: depthScale > 0 && Number.isFinite(depthScale) ? depthScale : 1,
    facing,
    visualLiftY: 0,
  });
  return attachmentPointLocal(pose, d.attach, d.u, d.v);
}

export interface IgniteStanceResult {
  facing: 1 | -1;
  x: number;
  y: number;
  residual: number;
}

/**
 * 一个着火点（场景坐标）左右两个站位：朝右点（人在左边）与朝左点（人在右边）。
 * `depthScaleAt` = 场景透视系数；解不出（这一帧没标挂点 / 片段不存在）⇒ 那一侧 null。
 */
export function igniteStancesFor(
  d: IgniteStanceData, target: { x: number; y: number }, depthScaleAt: (x: number, y: number) => number,
): { contact: IgniteContact | null; right: IgniteStanceResult | null; left: IgniteStanceResult | null } {
  const contact = igniteContactOf(d) ?? igniteContactOf(d, 'idle');
  if (!contact) return { contact: null, right: null, left: null };
  const solve = (facing: 1 | -1): IgniteStanceResult | null => {
    const s = solveIgniteStance(target, target, facing, {
      tipOffset: (f, depth) => igniteTipOffset(d, contact, f, depth),
      depthScaleAt,
    });
    return s ? { facing, ...s } : null;
  };
  return { contact, right: solve(1), left: solve(-1) };
}
