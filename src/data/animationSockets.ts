import type {
  AnimationSetDef,
  SocketAtlasFingerprint,
  SocketDef,
  SocketFramePose,
  SocketSetDef,
} from './types';

/**
 * 动画挂点（sockets）的解析与失效判定。
 *
 * 数据住在动画包目录的 **sidecar** `sockets.json`，不进 anim.json：
 * anim.json 是产线产物（`export_gamedraft_anim*` 从零拼 dict），挂点是人工逐帧标的，
 * 两者生命周期不同。更要紧的是——挂点按**图集槽位**索引，重导出后槽位会漂移，
 * 所以必须能判"这份标注还对不对得上现在这张图集"，而不是让它悄悄错位。
 */

export const SOCKETS_SCHEMA_VERSION = 1;

/** `<dir>/anim.json` → `<dir>/sockets.json`；给不出目录时返回空串。 */
export function socketsJsonUrlForAnim(animJsonUrl: string): string {
  const url = (animJsonUrl || '').trim();
  const cut = url.lastIndexOf('/');
  if (cut < 0) return '';
  return `${url.slice(0, cut)}/sockets.json`;
}

function finiteNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function parsePose(raw: unknown): SocketFramePose | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const x = finiteNum(m.x);
  const y = finiteNum(m.y);
  if (x === null || y === null) return null;
  const pose: SocketFramePose = { x, y };
  const angle = finiteNum(m.angle);
  if (angle !== null && angle !== 0) pose.angle = angle;
  if (m.front === true) pose.front = true;
  const frame = finiteNum(m.frame);
  if (frame !== null) pose.frame = Math.trunc(frame);
  return pose;
}

/**
 * 从 anim 定义取出图集指纹（与 sockets.json 里存的那份比对）。
 *
 * **只取 cols / rows / slotCount**——这三个决定"槽位索引指向哪一格"。
 * 刻意**不含** cellWidth/cellHeight：格子像素尺寸变了而网格没变，意味着图集只是换了
 * 分辨率、槽位次序没动，格内归一化坐标依然成立，不该误杀。而且这两个值在 TS 侧经
 * `normalizeAnimationSetDef` 由纹理推导补全、编辑器侧读的是原始 JSON，放进指纹会让
 * 两侧对同一个包算出不同答案——8 个没写 cellWidth 的包会因此永远判失效。
 */
export function fingerprintOfAnim(def: AnimationSetDef): SocketAtlasFingerprint {
  return {
    cols: def.cols,
    rows: def.rows,
    slotCount: def.atlasFrames?.length ?? 0,
  };
}

/** 两份指纹是否一致（全等比较；任一维不同即视为图集换过了）。 */
export function fingerprintMatches(
  a: SocketAtlasFingerprint | null | undefined,
  b: SocketAtlasFingerprint | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.cols === b.cols && a.rows === b.rows && a.slotCount === b.slotCount;
}

/**
 * 解析 sockets.json 原始 JSON。结构性坏数据一律返回 null（当作没有挂点），
 * 单个坏 pose 跳过——挂点是表现层增益，任何时候都不该把角色本身弄挂。
 */
export function parseSocketSet(raw: unknown): SocketSetDef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const atlasRaw = m.atlas;
  if (typeof atlasRaw !== 'object' || atlasRaw === null) return null;
  const a = atlasRaw as Record<string, unknown>;
  const cols = finiteNum(a.cols);
  const rows = finiteNum(a.rows);
  const slotCount = finiteNum(a.slotCount);
  if (cols === null || rows === null || slotCount === null) return null;
  // `sockets` 可以缺省（一份只标了落脚帧、一个挂点都没有的 sidecar 是合法的）；
  // 但写了却不是对象就是结构坏了。
  const socketsRaw = m.sockets === undefined ? {} : m.sockets;
  if (typeof socketsRaw !== 'object' || socketsRaw === null) return null;

  const sockets: Record<string, SocketDef> = {};
  for (const [name, defRaw] of Object.entries(socketsRaw as Record<string, unknown>)) {
    if (typeof defRaw !== 'object' || defRaw === null) continue;
    const d = defRaw as Record<string, unknown>;
    const posesRaw = d.poses;
    if (typeof posesRaw !== 'object' || posesRaw === null) continue;
    const poses: Record<string, SocketFramePose> = {};
    for (const [slot, poseRaw] of Object.entries(posesRaw as Record<string, unknown>)) {
      const pose = parsePose(poseRaw);
      if (pose) poses[slot] = pose;
    }
    const out: SocketDef = { poses };
    if (typeof d.label === 'string' && d.label.trim()) out.label = d.label.trim();
    sockets[name] = out;
  }

  const version = finiteNum(m.schemaVersion) ?? SOCKETS_SCHEMA_VERSION;
  return {
    schemaVersion: Math.trunc(version),
    atlas: { cols, rows, slotCount },
    sockets,
    contactSlots: parseContactSlots(m.contactSlots, slotCount),
  };
}

/**
 * 落脚帧槽位：只收 `0 <= 整数 < slotCount`，去重升序；不是数组/整份坏掉 ⇒ 空（无脚步）。
 * 单个坏项跳过——与 pose 同一口径：标注是表现层增益，任何时候不该把角色本身弄挂。
 */
function parseContactSlots(raw: unknown, slotCount: number): number[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<number>();
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) continue;
    if (slotCount > 0 && v >= slotCount) continue;
    out.add(v);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** 解算挂点局部位姿要的宿主状态（SpriteEntity 与编辑器画布共用同一套输入）。 */
export interface SocketHostFrame {
  /** 精灵在世界中的宽/高（anim.json 归一化后的值） */
  worldWidth: number;
  worldHeight: number;
  /** 透视系数（近大远小）；1 = 不缩 */
  depthScale: number;
  /** 朝向：1 右、-1 左（镜像） */
  facing: 1 | -1;
  /** 跳跃视觉抬升（容器局部 px，负=向上）；非跳跃时 0 */
  visualLiftY: number;
  /**
   * 宿主精灵的锚点（世界包围盒内归一化，x 0=左 1=右、y 0=顶 1=底）。
   * **缺省 (0.5, 1) = 底中 = 脚底**，即锚点可配之前写死的那个值。
   *
   * 为什么必须知道：挂点标注是**格内**归一化（`raw.x/raw.y` 同样 0..1），而返回的是
   * **容器局部**坐标，两者之间差的正是"格子的哪一点压在容器原点上"= 锚点。
   * 不传就按脚底算，宿主一旦把锚点挪到圆心，刀就会整体错半个身位（而且不报错）。
   */
  anchorX?: number;
  anchorY?: number;
}

/** 解算出的容器局部位姿 */
export interface SocketLocalPose {
  x: number;
  y: number;
  angleDeg: number;
  front: boolean;
  frame: number | null;
  scale: number;
  facing: 1 | -1;
}

/**
 * 把格内归一化标注解算成**容器局部**位姿。运行时与编辑器画布共用这一处，
 * 免得"编辑器里对齐了、游戏里差半个身位"。
 *
 * 换算链（与 `SpriteEntity.applySpriteScale` / `getAuthoredBubbleAnchorLocalY` 同源）：
 * - `x`：格内 0..1 → 以底中锚为原点 → 乘世界宽与透视 → 乘朝向（镜像整体翻到另一侧）
 * - `y`：格内 0=顶 1=底(脚线) → 脚点为 0、向上为负 → 加跳跃视觉抬升
 * - `angle`：朝左时取反（镜像后顺时针变逆时针）
 */
export function socketPoseToLocal(
  raw: SocketFramePose,
  host: SocketHostFrame,
): SocketLocalPose {
  const d = host.depthScale > 0 && Number.isFinite(host.depthScale) ? host.depthScale : 1;
  const sign = host.facing;
  // 格内归一化 → 容器局部：减掉的正是宿主锚点（缺省底中，与改造前逐位相同）
  const ax = typeof host.anchorX === 'number' && Number.isFinite(host.anchorX) ? host.anchorX : 0.5;
  const ay = typeof host.anchorY === 'number' && Number.isFinite(host.anchorY) ? host.anchorY : 1;
  return {
    x: (raw.x - ax) * host.worldWidth * d * sign,
    y: host.visualLiftY + (raw.y - ay) * host.worldHeight * d,
    angleDeg: (raw.angle ?? 0) * sign,
    front: raw.front === true,
    frame: typeof raw.frame === 'number' ? raw.frame : null,
    scale: d,
    facing: sign,
  };
}

/** 解析结果 + 是否与当前图集对得上（对不上时 `set` 仍返回，供编辑器提示重标）。 */
export interface ResolvedSockets {
  set: SocketSetDef | null;
  /** true = 指纹对不上，运行时必须当作没有挂点 */
  stale: boolean;
}

/**
 * 把原始 sidecar JSON 解析成运行时可用的挂点集。
 * 指纹对不上时 `stale=true`：运行时据此拒绝使用（宁可不挂，不挂错）。
 */
export function resolveSockets(raw: unknown, animDef: AnimationSetDef): ResolvedSockets {
  const set = parseSocketSet(raw);
  if (!set) return { set: null, stale: false };
  const stale = !fingerprintMatches(set.atlas, fingerprintOfAnim(animDef));
  return { set, stale };
}

/** AssetManager 里本模块用到的那一小片（避免 data 层反向依赖 core 的具体类）。 */
export interface OptionalJsonLoader {
  loadOptionalJson<T = unknown>(path: string): Promise<T | null>;
}

/**
 * 随动画包载它的挂点 sidecar。**没有 sockets.json 是绝大多数包的常态**，
 * 返回 `{set:null,stale:false}`（等于没挂点），不报错、不打日志。
 */
export async function loadSocketsForAnim(
  loader: OptionalJsonLoader,
  animJsonUrl: string,
  animDef: AnimationSetDef,
): Promise<ResolvedSockets> {
  const url = socketsJsonUrlForAnim(animJsonUrl);
  if (!url) return { set: null, stale: false };
  const raw = await loader.loadOptionalJson(url);
  if (raw === null) return { set: null, stale: false };
  return resolveSockets(raw, animDef);
}
