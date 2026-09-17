/**
 * 燃烧模拟本体：**纯函数、确定性、零 Pixi、不读挂钟**（时间由调用方给）。燃烧工作台打包的是同一个文件。
 *
 * 口径见 agent_docs [[burn-system]]；要点：
 *
 * - **一个场景一份模拟**（`BurnSceneSim`），场景里所有可燃物共用一个事件堆：面燃烧的火线逐格推进、
 *   消耗燃烧的点着 / 烧完、可燃物之间的蔓延，全按事件时刻排队处理。
 * - **连续时间**：事件的发生时刻只取决于事件本身（上一个事件的时刻 + 距离 / 速度、风在那一刻的解析值），
 *   与"哪一帧处理它"无关。所以逐帧活跑、一次跑到头的重放、离场期间照推，**结果逐位相同**。
 *   固定步长的量（消耗燃烧的吹熄、火苗碰别人）落在**全局**步长网格上（k·h），同样与帧无关。
 * - **世界空间**（铁律 0）：格点在 M-world（wu）；速度、火焰长度作者面是厘米，1 m = 88 wu。
 * - 外部事件（点火 / 熄灭 / 复原 / 挪位 / 出现 / 收掉）由调用方记日志；派生事件（火线推进、互相引燃、吹熄、烧完）永不进日志，重放时重算。
 * - **会动的实例**（NPC、被演出推着走的对象）：挪位是一条外部事件（`move` 指向这个实例的世界映射表里的一份），
 *   所以动过的东西照样逐位重放；**手上的挂件**跨场景走、没法重放，单独一份模拟，存快照（{@link BurnItemSnapshot}）。
 */
import { BURN_G, BURN_WU_PER_CM, BURN_WU_PER_M, type BurnState, type ResolvedBurnable } from '../../data/burnables';
import { sampleSceneWind, type SceneWindParams } from '../../utils/sceneWind';
import { burnWorldAt, type BurnWorldGrid } from './burnGeometry';

// ------------------------------------------------------------------ 燃料网格

/** RGBA8 图像数据（浏览器 `ImageData` 同形） */
export interface BurnImageData {
  w: number;
  h: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface BurnGrid {
  nx: number;
  ny: number;
  /** 每格燃料 0..1；< {@link BURN_MIN_FUEL} 视为没有燃料 */
  fuel: Float32Array;
  /** 消耗燃烧的顺序 0..1（面燃烧为 null） */
  order: Float32Array | null;
  /** 有燃料的格数 */
  fuelCells: number;
  /** 燃料的 uv 重心 */
  centroidU: number;
  centroidV: number;
}

export const BURN_MIN_FUEL = 0.05;

/** 图像上归一化点 (u, v) 处的 R 通道 0..1（最近邻） */
function sampleR(img: BurnImageData, u: number, v: number): number {
  const x = Math.min(img.w - 1, Math.max(0, Math.floor(u * img.w)));
  const y = Math.min(img.h - 1, Math.max(0, Math.floor(v * img.h)));
  return img.data[(y * img.w + x) * 4] / 255;
}

/**
 * 从图的 alpha（+ 燃料涂层 + 顺序涂层）建网格。每格取格内均匀采样（每格最多 4×4 个像素点），
 * 采样位置只由图尺寸与格数决定 ⇒ 同一张图同一份参数逐位相同。
 */
export function buildBurnGrid(
  b: ResolvedBurnable,
  image: BurnImageData,
  mask: BurnImageData | null,
  orderImg: BurnImageData | null,
): BurnGrid {
  const W = Math.max(1, image.w);
  const H = Math.max(1, image.h);
  const long = Math.max(W, H);
  const nx = Math.max(1, Math.round((b.gridCells * W) / long));
  const ny = Math.max(1, Math.round((b.gridCells * H) / long));
  const n = nx * ny;
  const fuel = new Float32Array(n);
  const thr = b.alphaThreshold;
  const SAMPLES = 4;
  let fuelCells = 0;
  let su = 0;
  let sv = 0;
  let sw = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let acc = 0;
      for (let sj = 0; sj < SAMPLES; sj++) {
        for (let si = 0; si < SAMPLES; si++) {
          const u = (i + (si + 0.5) / SAMPLES) / nx;
          const v = (j + (sj + 0.5) / SAMPLES) / ny;
          const px = Math.min(W - 1, Math.floor(u * W));
          const py = Math.min(H - 1, Math.floor(v * H));
          const a = image.data[(py * W + px) * 4 + 3] / 255;
          if (a < thr) continue;
          acc += mask ? sampleR(mask, u, v) : 1;
        }
      }
      const f = acc / (SAMPLES * SAMPLES);
      const c = j * nx + i;
      if (f >= BURN_MIN_FUEL) {
        fuel[c] = Math.min(1, f);
        fuelCells++;
        su += ((i + 0.5) / nx) * f;
        sv += ((j + 0.5) / ny) * f;
        sw += f;
      }
    }
  }
  let order: Float32Array | null = null;
  if (b.mode === 'consume') {
    order = new Float32Array(n);
    // 燃料包围盒（按格），方向顺序在盒内归一化：蜡烛矮一截时从它自己的顶开始
    let i0 = nx, i1 = -1, j0 = ny, j1 = -1;
    for (let c = 0; c < n; c++) {
      if (fuel[c] < BURN_MIN_FUEL) continue;
      const i = c % nx;
      const j = (c - i) / nx;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
    const spanI = Math.max(1, i1 - i0);
    const spanJ = Math.max(1, j1 - j0);
    for (let c = 0; c < n; c++) {
      const i = c % nx;
      const j = (c - i) / nx;
      let o: number;
      if (orderImg) {
        o = sampleR(orderImg, (i + 0.5) / nx, (j + 0.5) / ny);
      } else if (b.consumeFrom === 'bottom') {
        o = (j1 - j) / spanJ;
      } else if (b.consumeFrom === 'left') {
        o = (i - i0) / spanI;
      } else if (b.consumeFrom === 'right') {
        o = (i1 - i) / spanI;
      } else {
        o = (j - j0) / spanJ;
      }
      order[c] = Math.min(1, Math.max(0, o));
    }
  }
  return {
    nx,
    ny,
    fuel,
    order,
    fuelCells,
    centroidU: sw > 0 ? su / sw : 0.5,
    centroidV: sw > 0 ? sv / sw : 0.5,
  };
}

// ------------------------------------------------------------------ 事件

export type BurnExternalEvent =
  | { t: number; k: 'ignite'; u: number; v: number }
  | { t: number; k: 'igniteAll' }
  | { t: number; k: 'extinguish' }
  | { t: number; k: 'reset' }
  /** 挪位：从这一刻起世界位置换成世界映射表第 `w` 份（宿主挪了 / 场景几何换了） */
  | { t: number; k: 'move'; w: number }
  /** 出现（演出生成出来）：此前不在世界里（不点着别人、不被点着）；出现 = 一个新的、没点过的实例 */
  | { t: number; k: 'appear' }
  /** 收掉（演出生成的对象播完被收、宿主不在了）：此后不在世界里，状态定格 */
  | { t: number; k: 'vanish' };

/** 存档用的紧凑形状：`[t, 'i', u, v]` / `[t, 'a']` / `[t, 'x']` / `[t, 'r']` / `[t, 'm', w]` / `[t, '+']` / `[t, '-']` */
export type BurnEventJson =
  | [number, 'i', number, number] | [number, 'a'] | [number, 'x'] | [number, 'r']
  | [number, 'm', number] | [number, '+'] | [number, '-'];

export function burnEventToJson(e: BurnExternalEvent): BurnEventJson {
  switch (e.k) {
    case 'ignite': return [e.t, 'i', e.u, e.v];
    case 'igniteAll': return [e.t, 'a'];
    case 'extinguish': return [e.t, 'x'];
    case 'reset': return [e.t, 'r'];
    case 'move': return [e.t, 'm', e.w];
    case 'appear': return [e.t, '+'];
    case 'vanish': return [e.t, '-'];
  }
}

export function burnEventFromJson(raw: unknown): BurnExternalEvent | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const t = raw[0];
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  switch (raw[1]) {
    case 'i': {
      const u = raw[2];
      const v = raw[3];
      if (typeof u !== 'number' || typeof v !== 'number' || !Number.isFinite(u) || !Number.isFinite(v)) return null;
      return { t, k: 'ignite', u, v };
    }
    case 'a': return { t, k: 'igniteAll' };
    case 'x': return { t, k: 'extinguish' };
    case 'r': return { t, k: 'reset' };
    case 'm': {
      const w = raw[2];
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 0) return null;
      return { t, k: 'move', w };
    }
    case '+': return { t, k: 'appear' };
    case '-': return { t, k: 'vanish' };
    default: return null;
  }
}

// ------------------------------------------------------------------ 常量

/** 消耗燃烧吹熄积分的全局步长（秒） */
export const BURN_BLOWOUT_STEP = 0.1;
/** 消耗燃烧的火苗查"碰到别人"的全局步长（秒） */
export const BURN_CONTACT_STEP = 0.25;
/** 空间哈希格边长（wu） */
const HASH_CELL_WU = 16;

const enum CellSt { None = 0, Tentative = 1, Ignited = 2, Frozen = 3 }
const enum HeapKind { External = 0, Spread = 1, ConsumeIgnite = 2, Settle = 3 }

// ------------------------------------------------------------------ 最小堆（时刻, 种类, 可燃物, 格）

class EventHeap {
  t: number[] = [];
  kind: number[] = [];
  item: number[] = [];
  cell: number[] = [];

  get size(): number { return this.t.length; }

  private less(a: number, b: number): boolean {
    const ta = this.t[a], tb = this.t[b];
    if (ta !== tb) return ta < tb;
    if (this.kind[a] !== this.kind[b]) return this.kind[a] < this.kind[b];
    if (this.item[a] !== this.item[b]) return this.item[a] < this.item[b];
    return this.cell[a] < this.cell[b];
  }

  private swap(a: number, b: number): void {
    const t = this.t[a]; this.t[a] = this.t[b]; this.t[b] = t;
    const k = this.kind[a]; this.kind[a] = this.kind[b]; this.kind[b] = k;
    const i = this.item[a]; this.item[a] = this.item[b]; this.item[b] = i;
    const c = this.cell[a]; this.cell[a] = this.cell[b]; this.cell[b] = c;
  }

  push(t: number, kind: number, item: number, cell: number): void {
    this.t.push(t); this.kind.push(kind); this.item.push(item); this.cell.push(cell);
    let i = this.t.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  topTime(): number { return this.t.length > 0 ? this.t[0] : Infinity; }

  /** 弹出堆顶到 out（[t, kind, item, cell]） */
  pop(out: number[]): void {
    out[0] = this.t[0]; out[1] = this.kind[0]; out[2] = this.item[0]; out[3] = this.cell[0];
    const last = this.t.length - 1;
    if (last > 0) this.swap(0, last);
    this.t.pop(); this.kind.pop(); this.item.pop(); this.cell.pop();
    const n = this.t.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }

  clear(): void {
    this.t.length = 0; this.kind.length = 0; this.item.length = 0; this.cell.length = 0;
  }
}

// ------------------------------------------------------------------ 快照（手上的挂件：跨场景走、没法重放）

/**
 * 一个实例某一刻烧成什么样（手上挂件的存档 / 收进包里记住烧到哪）。时刻都是燃烧钟的绝对秒。
 * 面燃烧只列出不是"没点"的格（其余缺省）；非有限时刻（NaN / ±∞）存 null。
 */
export interface BurnItemSnapshot {
  t: number;
  ever: boolean;
  spread?: { cells: number[]; st: number[]; tIgn: number[]; epoch: number | null; activeUntil: number | null };
  consume?: { lit: boolean; consumed: number; consumedAt: number; vitality: number; pendingIgniteAt: number | null };
}

function finiteOrNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/** 快照 JSON 清洗（坏形状 ⇒ null；存档读回用） */
export function burnSnapshotFromJson(raw: unknown): BurnItemSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const finN = (v: unknown): number | null | undefined => (v === null ? null : fin(v) ? v : undefined);
  if (!fin(o.t)) return null;
  const snap: BurnItemSnapshot = { t: o.t, ever: o.ever === true };
  if (o.spread && typeof o.spread === 'object') {
    const sp = o.spread as Record<string, unknown>;
    const cells = sp.cells;
    const st = sp.st;
    const tIgn = sp.tIgn;
    if (!Array.isArray(cells) || !Array.isArray(st) || !Array.isArray(tIgn)) return null;
    if (cells.length !== st.length || cells.length !== tIgn.length) return null;
    if (!cells.every((c) => Number.isInteger(c) && (c as number) >= 0)) return null;
    if (!st.every((x) => x === 1 || x === 2 || x === 3)) return null;
    if (!tIgn.every(fin)) return null;
    const epoch = finN(sp.epoch);
    const activeUntil = finN(sp.activeUntil);
    if (epoch === undefined || activeUntil === undefined) return null;
    snap.spread = { cells: cells as number[], st: st as number[], tIgn: tIgn as number[], epoch, activeUntil };
  }
  if (o.consume && typeof o.consume === 'object') {
    const c = o.consume as Record<string, unknown>;
    const pending = finN(c.pendingIgniteAt);
    if (!fin(c.consumed) || !fin(c.consumedAt) || !fin(c.vitality) || pending === undefined) return null;
    snap.consume = { lit: c.lit === true, consumed: c.consumed, consumedAt: c.consumedAt, vitality: c.vitality, pendingIgniteAt: pending };
  }
  return snap;
}

// ------------------------------------------------------------------ 可燃物运行态

export interface BurnItemInput {
  /** 实例 key（场景实体 id / 挂件 `人|挂点`；一份模拟内唯一；决定处理顺序） */
  key: string;
  burnable: ResolvedBurnable;
  grid: BurnGrid;
  /**
   * 世界映射表：第 0 份 = 起始位置，`move` 事件指向后面的。空 = 还没算（有事件的实例缺它时整份模拟暂停处理，钟照走、事件照记）。
   */
  worlds: BurnWorldGrid[];
  /** 外部事件日志（按时刻升序） */
  events: BurnExternalEvent[];
  /** 起点是一份快照（手上的挂件）：模拟从快照时刻开始，事件都在它之后 */
  snapshot?: BurnItemSnapshot | null;
  /**
   * 起点就是烧完的（存档里是"烧完"、却推不出过程——资产改过 / 离场前正烧着推不出来）：
   * 所有燃料格直接定成很久以前烧完的样子，**不向外蔓延**（它不是在这一刻烧起来的）。之后的事件照常叠在上面。
   */
  baseBurnt?: boolean;
}

export interface BurnSceneEnv {
  /** 作者数据那份场景风（不含调试覆盖）；没风 = null */
  wind: SceneWindParams | null;
  /** 燃烧钟 → 风的钟 */
  windTimeAt(t: number): number;
}

/** 状态变化回调：`t` 是变化发生的模拟时刻 */
export type BurnStateListener = (key: string, from: BurnState, to: BurnState, t: number) => void;

class BurnItemSim {
  readonly idx: number;
  readonly key: string;
  readonly b: ResolvedBurnable;
  readonly grid: BurnGrid;
  readonly n: number;
  /** 世界映射表（`move` 事件的下标指向这里） */
  worlds: BurnWorldGrid[];
  /** 此刻用的那份（没算过 = null） */
  world: BurnWorldGrid | null;
  /** 在不在世界里（`appear` 之前 / `vanish` 之后不在：不点着别人、不被点着、状态定格） */
  present = true;
  /** 空间哈希里这个实例占的键（挪位时只重插它自己） */
  hashed: number[] = [];
  /** 起点是快照（手上的挂件） */
  readonly fromSnapshot: boolean;

  // 格点世界量（世界映射到了才有）
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  hAbove: Float32Array;
  /** 格面积（cm²） */
  area: Float32Array;
  /** 格的半对角线（wu） */
  halfDiag: Float32Array;
  /**
   * 片的法线（单位向量）与**纵深半厚**（wu）：画面上的一片可燃物代表一个有体积的东西——
   * 立着的（蜡烛、纸堆）纵深 ≈ 它的宽，躺着的（地上的纸）≈ 0。跨可燃物接触沿法线扣掉两边的半厚
   * （等角场景里并排摆的两堆纸，脚点深度差一截，薄片模型下永远碰不到）。
   */
  nrm: [number, number, number] = [0, 0, 1];
  halfDepth = 0;

  // 面燃烧
  st: Uint8Array;
  tIgn: Float64Array;
  /** 已点着的格，按点着先后（= 时刻不减） */
  ignList: Int32Array;
  ignTimes: Float64Array;
  ignCount = 0;
  pending = 0;
  activeUntil = -Infinity;
  /** 没点着过、有燃料的格数（None 态） */
  remaining: number;

  // 消耗燃烧
  lit = false;
  consumed = 0;
  consumedAt = 0;
  vitality = 1;
  pendingIgniteAt = Infinity;
  /** 消耗燃烧的格按顺序值排好 */
  orderSorted: Int32Array | null = null;
  orderValues: Float64Array | null = null;

  everIgnited = false;
  /** 纹理时间原点（这一轮第一次点着的时刻）；消耗燃烧不用 */
  epoch = NaN;
  state: BurnState = 'unburnt';
  /** 纹理脏了（调用方读完清） */
  dirty = true;

  events: BurnExternalEvent[];
  nextEvent = 0;
  readonly baseBurnt: boolean;

  /** 这个可燃物要不要世界映射才能推进：有事件（烧过 / 要烧）或起点就是烧完。没点过的缺映射时只是"点不着"，不挡别人 */
  requiresWorld(): boolean {
    return this.events.length > 0 || this.baseBurnt || this.fromSnapshot;
  }

  constructor(idx: number, input: BurnItemInput) {
    this.idx = idx;
    this.key = input.key;
    this.b = input.burnable;
    this.grid = input.grid;
    this.n = input.grid.nx * input.grid.ny;
    this.world = null;
    this.worlds = input.worlds.slice();
    this.fromSnapshot = !!input.snapshot;
    this.px = new Float32Array(0);
    this.py = new Float32Array(0);
    this.pz = new Float32Array(0);
    this.hAbove = new Float32Array(0);
    this.area = new Float32Array(0);
    this.halfDiag = new Float32Array(0);
    this.st = new Uint8Array(this.n);
    this.tIgn = new Float64Array(this.n).fill(Infinity);
    this.ignList = new Int32Array(this.n);
    this.ignTimes = new Float64Array(this.n);
    this.remaining = input.grid.fuelCells;
    this.baseBurnt = input.baseBurnt === true;
    this.events = input.events.slice().sort((a, c) => a.t - c.t);
    // 第一条事件是"出现"：出现之前不在世界里
    if (this.events.length > 0 && this.events[0].k === 'appear') this.present = false;
    if (this.b.mode === 'consume' && this.grid.order) {
      const cells: number[] = [];
      for (let c = 0; c < this.n; c++) if (this.grid.fuel[c] >= BURN_MIN_FUEL) cells.push(c);
      const ord = this.grid.order;
      cells.sort((a, c) => (ord[a] - ord[c]) || (a - c));
      this.orderSorted = Int32Array.from(cells);
      this.orderValues = Float64Array.from(cells.map((c) => ord[c] * this.b.consumeSeconds));
    }
    if (this.worlds.length > 0) this.setWorld(this.worlds[0]);
    if (input.baseBurnt) this.applyBaseBurnt();
  }

  /** 起点就是烧完（见 `BurnItemInput.baseBurnt`）：不经过事件、不蔓延 */
  private applyBaseBurnt(): void {
    const ANCIENT = -1e6;
    this.everIgnited = true;
    if (this.b.mode === 'consume') {
      this.consumed = this.consumeTotal;
      this.consumedAt = ANCIENT;
      this.lit = false;
      this.state = 'burnt';
      return;
    }
    this.epoch = ANCIENT;
    this.ignCount = 0;
    for (let c = 0; c < this.n; c++) {
      if (this.grid.fuel[c] < BURN_MIN_FUEL) continue;
      this.st[c] = CellSt.Ignited;
      this.tIgn[c] = ANCIENT;
      this.ignList[this.ignCount] = c;
      this.ignTimes[this.ignCount] = ANCIENT;
      this.ignCount++;
    }
    this.remaining = 0;
    this.pending = 0;
    this.activeUntil = ANCIENT;
    this.state = 'burnt';
  }

  setWorld(world: BurnWorldGrid): void {
    this.world = world;
    const { nx, ny } = this.grid;
    const n = this.n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.hAbove = new Float32Array(n);
    this.area = new Float32Array(n);
    this.halfDiag = new Float32Array(n);
    const tmp = [0, 0, 0, 0];
    const a = [0, 0, 0, 0];
    const bq = [0, 0, 0, 0];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        burnWorldAt(world, (i + 0.5) / nx, (j + 0.5) / ny, tmp);
        this.px[c] = tmp[0]; this.py[c] = tmp[1]; this.pz[c] = tmp[2]; this.hAbove[c] = tmp[3];
        // 格的两条边向量（格左上 → 右 / → 下）
        burnWorldAt(world, i / nx, j / ny, tmp);
        burnWorldAt(world, (i + 1) / nx, j / ny, a);
        burnWorldAt(world, i / nx, (j + 1) / ny, bq);
        const ex = a[0] - tmp[0], ey = a[1] - tmp[1], ez = a[2] - tmp[2];
        const fx = bq[0] - tmp[0], fy = bq[1] - tmp[1], fz = bq[2] - tmp[2];
        const cx = ey * fz - ez * fy, cy = ez * fx - ex * fz, cz = ex * fy - ey * fx;
        const areaWu2 = Math.hypot(cx, cy, cz);
        this.area[c] = areaWu2 / (BURN_WU_PER_CM * BURN_WU_PER_CM);
        this.halfDiag[c] = 0.5 * Math.hypot(ex + fx, ey + fy, ez + fz);
      }
    }
    // 整片的法线与纵深半厚（见字段注释）
    burnWorldAt(world, 0, 0.5, tmp);
    burnWorldAt(world, 1, 0.5, a);
    const ux = a[0] - tmp[0], uy = a[1] - tmp[1], uz = a[2] - tmp[2];
    burnWorldAt(world, 0.5, 0, tmp);
    burnWorldAt(world, 0.5, 1, a);
    const vx = a[0] - tmp[0], vy = a[1] - tmp[1], vz = a[2] - tmp[2];
    const nx3 = uy * vz - uz * vy, ny3 = uz * vx - ux * vz, nz3 = ux * vy - uy * vx;
    const nl = Math.hypot(nx3, ny3, nz3);
    this.nrm = nl > 1e-9 ? [nx3 / nl, ny3 / nl, nz3 / nl] : [0, 0, 1];
    this.halfDepth = this.b.orientation === 'upright' ? 0.5 * Math.hypot(ux, uy, uz) : 0;
  }

  /** 燃烧钟 t 时消耗燃烧累计烧了多少秒 */
  consumedAtTime(t: number): number {
    return this.lit ? this.consumed + Math.max(0, t - this.consumedAt) : this.consumed;
  }

  /** 消耗燃烧从头到尾的总秒数（最后一格也烧过明火） */
  get consumeTotal(): number {
    return this.b.consumeSeconds + this.b.flameSeconds;
  }

  cellActiveEnd(c: number): number {
    return this.tIgn[c] + this.b.flameSeconds * this.grid.fuel[c] + this.b.emberSeconds;
  }

  computeState(t: number): BurnState {
    if (this.b.mode === 'consume') {
      const s = this.consumedAtTime(t);
      if (s >= this.consumeTotal - 1e-9) return 'burnt';
      if (this.lit) return 'burning';
      return this.everIgnited ? 'out' : 'unburnt';
    }
    if (!this.everIgnited) return 'unburnt';
    if (this.pending > 0 || t < this.activeUntil) return 'burning';
    return this.remaining > 0 ? 'out' : 'burnt';
  }
}

/** 一格的读数：给着色器 / 粒子 / 灯 */
export interface BurnCellQuery {
  count: number;
  cells: Int32Array;
  /** 这些格的总面积（cm²） */
  area: number;
  /** 面积加权的世界重心 */
  cx: number;
  cy: number;
  cz: number;
}

// ------------------------------------------------------------------ 场景模拟

export class BurnSceneSim {
  private readonly items: BurnItemSim[];
  private readonly byKey = new Map<string, BurnItemSim>();
  private readonly heap = new EventHeap();
  private env: BurnSceneEnv;
  private listener: BurnStateListener | null = null;
  /** 已处理到的时刻 */
  private tDone: number;
  private worldReady = false;
  private hashKeys = new Map<number, number[]>();
  private readonly windTmp = [0, 0, 0];
  private readonly popTmp = [0, 0, 0, 0];
  /** 下一个吹熄 / 接触步的编号（t = k·h） */
  private blowK: number;
  private contactK: number;

  constructor(inputs: BurnItemInput[], env: BurnSceneEnv, startTime: number) {
    const sorted = inputs.slice().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    this.items = sorted.map((inp, i) => new BurnItemSim(i, inp));
    for (const it of this.items) this.byKey.set(it.key, it);
    this.env = env;
    this.tDone = startTime;
    this.blowK = Math.floor(startTime / BURN_BLOWOUT_STEP) + 1;
    this.contactK = Math.floor(startTime / BURN_CONTACT_STEP) + 1;
    sorted.forEach((inp, i) => { if (inp.snapshot) this.applySnapshot(this.items[i], inp.snapshot); });
    for (const it of this.items) this.rehashItem(it);
    this.refreshWorldReady();
  }

  setListener(fn: BurnStateListener | null): void {
    this.listener = fn;
  }

  get time(): number {
    return this.tDone;
  }

  /**
   * 能不能推进：**要推进的**可燃物（有事件 / 起点烧完）都有了世界映射。没齐 = 事件暂不处理（钟照走，齐了按时刻补）。
   * 从没点过的可燃物缺映射不挡：它在补上映射之前点不着、也不被蔓延到（不在空间哈希里）。
   */
  get ready(): boolean {
    return this.worldReady;
  }

  keys(): string[] {
    return this.items.map((it) => it.key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** 手上挂件的模拟跟着人换场景：换一份风 */
  setEnv(env: BurnSceneEnv): void {
    this.env = env;
  }

  /**
   * 给某个可燃物补上**起始**世界映射（表里还没有任何一份时；到齐后开始处理积压的事件）。已经有了 ⇒ 不动（挪位走 {@link addWorld}）。
   */
  setWorld(key: string, world: BurnWorldGrid): void {
    const it = this.byKey.get(key);
    if (!it || it.worlds.length > 0) return;
    it.worlds.push(world);
    it.setWorld(world);
    this.rehashItem(it);
    this.refreshWorldReady();
  }

  /**
   * 整份换掉世界映射表（只剩这一份）。**只许在整份模拟没有任何过去的时候调**（{@link hasHistory} 为假：
   * 没有要重放的东西，挪位不必记事件）——调用方负责判断。
   */
  rebaseWorld(key: string, world: BurnWorldGrid): void {
    const it = this.byKey.get(key);
    if (!it) return;
    it.worlds = [world];
    it.setWorld(world);
    this.rehashItem(it);
    this.refreshWorldReady();
  }

  /** 世界映射表追加一份，返回下标（调用方随即记一条 `move` 事件指向它）；没有这个实例 ⇒ −1 */
  addWorld(key: string, world: BurnWorldGrid): number {
    const it = this.byKey.get(key);
    if (!it) return -1;
    it.worlds.push(world);
    return it.worlds.length - 1;
  }

  /**
   * **不记事件**地换此刻的世界位置（手上的挂件：跟着手走、不重放）。`rehash` = 要不要进空间哈希（没人来查它时省掉）。
   */
  setLiveWorld(key: string, world: BurnWorldGrid, rehash: boolean): void {
    const it = this.byKey.get(key);
    if (!it) return;
    if (it.worlds.length === 0) it.worlds.push(world);
    it.setWorld(world);
    if (rehash) this.rehashItem(it);
    this.refreshWorldReady();
  }

  /** 此刻用的世界映射（没算过 = null） */
  worldOf(key: string): BurnWorldGrid | null {
    return this.byKey.get(key)?.world ?? null;
  }

  /** 世界映射表（存档用） */
  worldTable(key: string): BurnWorldGrid[] {
    return this.byKey.get(key)?.worlds.slice() ?? [];
  }

  /** 在不在世界里（见 `BurnItemSim.present`） */
  isPresent(key: string): boolean {
    return this.byKey.get(key)?.present ?? false;
  }

  /** 整份模拟有没有过去（有事件 / 起点烧完 / 快照）：没有 ⇒ 实例挪位可以直接换映射、不记事件 */
  hasHistory(): boolean {
    return this.items.some((it) => it.events.length > 0 || it.baseBurnt || it.fromSnapshot);
  }

  /** 有映射、在世界里的可燃物里最大的纵深半厚（接触查询的哈希范围要放宽这么多） */
  private maxHalfDepth = 0;

  private refreshWorldReady(): void {
    this.worldReady = this.items.every((it) => it.world !== null || !it.requiresWorld());
  }

  private hashKey(ix: number, iy: number, iz: number): number {
    return ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) >>> 0);
  }

  /** 空间哈希里重插这一个实例（有映射且在世界里才插）：先摘掉它原来占的，再按此刻的格点插 */
  private rehashItem(it: BurnItemSim): void {
    for (const k of it.hashed) {
      const list = this.hashKeys.get(k);
      if (!list) continue;
      let w = 0;
      for (let r = 0; r < list.length; r++) {
        const packed = list[r];
        if (((packed / 65536) | 0) !== it.idx) list[w++] = packed;
      }
      list.length = w;
      if (w === 0) this.hashKeys.delete(k);
    }
    it.hashed = [];
    if (it.world && it.present) {
      const seen = new Set<number>();
      for (let c = 0; c < it.n; c++) {
        if (it.grid.fuel[c] < BURN_MIN_FUEL) continue;
        const k = this.hashKey(
          Math.floor(it.px[c] / HASH_CELL_WU), Math.floor(it.py[c] / HASH_CELL_WU), Math.floor(it.pz[c] / HASH_CELL_WU));
        let list = this.hashKeys.get(k);
        if (!list) { list = []; this.hashKeys.set(k, list); }
        list.push(it.idx * 65536 + c);
        if (!seen.has(k)) { seen.add(k); it.hashed.push(k); }
      }
    }
    let m = 0;
    for (const x of this.items) if (x.world && x.present) m = Math.max(m, x.halfDepth);
    this.maxHalfDepth = m;
  }

  // ---------------------------------------------------------------- 外部事件

  /** 记一条外部事件（调用方负责进日志）；时刻早于已处理到的时刻时按"现在"处理 */
  addEvent(key: string, e: BurnExternalEvent): BurnExternalEvent | null {
    const it = this.byKey.get(key);
    if (!it) return null;
    const ev = { ...e, t: Math.max(e.t, this.tDone) } as BurnExternalEvent;
    // 插入到未处理段里、按时刻保持升序（同一时刻后到的排后面）
    let i = it.events.length;
    while (i > it.nextEvent && it.events[i - 1].t > ev.t) i--;
    it.events.splice(i, 0, ev);
    this.refreshWorldReady();
    return ev;
  }

  // ---------------------------------------------------------------- 推进

  /** 把模拟推进到 t（含）。世界映射没齐时只挪钟，不处理任何事件——事件留着，齐了之后按时刻补处理 */
  advanceTo(t: number): void {
    if (!(t >= this.tDone)) return;
    if (!this.worldReady) return;
    const pop = this.popTmp;
    for (;;) {
      const tHeap = this.heap.topTime();
      const ext = this.nextExternal();
      const tExt = ext ? ext.events[ext.nextEvent].t : Infinity;
      const tBlow = this.blowK * BURN_BLOWOUT_STEP;
      const tContact = this.contactK * BURN_CONTACT_STEP;
      const next = Math.min(tHeap, tExt, tBlow, tContact);
      if (!(next <= t)) break;
      if (tExt === next) {
        // 同一时刻：外部事件先于内部事件（作者 / 玩家的动作是这一刻的因）
        const e = ext!.events[ext!.nextEvent++];
        this.applyExternal(ext!, e);
      } else if (tHeap === next) {
        this.heap.pop(pop);
        this.applyHeap(pop[0], pop[1], pop[2], pop[3]);
      } else if (tBlow === next) {
        this.blowK++;
        this.stepBlowout(tBlow);
      } else {
        this.contactK++;
        this.stepConsumeContacts(tContact);
      }
    }
    this.tDone = t;
    // 纯时间推移引起的状态变化（余烬烧完、蜡烛烧到头）在处理事件时已按精确时刻结算；这里兜一次
    for (const it of this.items) if (it.present) this.settle(it, t);
  }

  private nextExternal(): BurnItemSim | null {
    let best: BurnItemSim | null = null;
    for (const it of this.items) {
      if (it.nextEvent >= it.events.length) continue;
      if (!best || it.events[it.nextEvent].t < best.events[best.nextEvent].t) best = it;
    }
    return best;
  }

  private settle(it: BurnItemSim, t: number): void {
    const next = it.computeState(t);
    if (next === it.state) return;
    const from = it.state;
    it.state = next;
    this.listener?.(it.key, from, next, t);
  }

  private applyExternal(it: BurnItemSim, e: BurnExternalEvent): void {
    const t = e.t;
    if (e.k === 'appear') {
      // 出现 = 一个新的、没点过的实例
      this.resetItem(it);
      it.present = true;
      this.rehashItem(it);
      this.recontact(it, t);
      this.settle(it, t);
      return;
    }
    if (e.k === 'vanish') {
      it.present = false;
      this.rehashItem(it);
      return;
    }
    if (e.k === 'move') {
      const w = it.worlds[e.w];
      if (w) {
        it.setWorld(w);
        this.rehashItem(it);
        this.recontact(it, t);
      }
      return;
    }
    if (!it.present) return;
    switch (e.k) {
      case 'reset':
        this.resetItem(it);
        break;
      case 'extinguish':
        this.extinguishItem(it, t);
        break;
      case 'igniteAll':
        this.igniteItemAll(it, t);
        break;
      case 'ignite':
        this.igniteItemAt(it, t, e.u, e.v);
        break;
    }
    this.settle(it, t);
  }

  private resetItem(it: BurnItemSim): void {
    it.st.fill(CellSt.None);
    it.tIgn.fill(Infinity);
    it.ignCount = 0;
    it.pending = 0;
    it.activeUntil = -Infinity;
    it.remaining = it.grid.fuelCells;
    it.lit = false;
    it.consumed = 0;
    it.consumedAt = 0;
    it.vitality = 1;
    it.pendingIgniteAt = Infinity;
    it.everIgnited = false;
    it.epoch = NaN;
    it.dirty = true;
  }

  private extinguishItem(it: BurnItemSim, t: number): void {
    if (it.b.mode === 'consume') {
      if (!it.lit) return;
      it.consumed = it.consumedAtTime(t);
      it.consumedAt = t;
      it.lit = false;
      it.pendingIgniteAt = Infinity;
      it.dirty = true;
      return;
    }
    let changed = false;
    for (let c = 0; c < it.n; c++) {
      if (it.st[c] === CellSt.Tentative) {
        it.st[c] = CellSt.None;
        it.tIgn[c] = Infinity;
        changed = true;
      } else if (it.st[c] === CellSt.Ignited && it.cellActiveEnd(c) > t) {
        it.st[c] = CellSt.Frozen;
        changed = true;
      }
    }
    it.pending = 0;
    if (it.activeUntil > t) it.activeUntil = t;
    if (changed) it.dirty = true;
  }

  private igniteItemAll(it: BurnItemSim, t: number): void {
    if (it.b.mode === 'consume') {
      this.lightConsume(it, t);
      return;
    }
    for (let c = 0; c < it.n; c++) {
      if (it.grid.fuel[c] < BURN_MIN_FUEL) continue;
      this.scheduleSpread(it, c, t);
    }
  }

  private igniteItemAt(it: BurnItemSim, t: number, u: number, v: number): void {
    if (it.b.mode === 'consume') {
      this.lightConsume(it, t);
      return;
    }
    // 离 (u, v) 最近的、还能烧的格（uv 空间，按格心；并列取格号小的）
    const { nx, ny } = it.grid;
    let best = -1;
    let bestD = Infinity;
    for (let c = 0; c < it.n; c++) {
      if (it.grid.fuel[c] < BURN_MIN_FUEL) continue;
      const s = it.st[c];
      if (s === CellSt.Ignited || s === CellSt.Frozen) continue;
      const i = c % nx;
      const j = (c - i) / nx;
      const du = (i + 0.5) / nx - u;
      const dv = (j + 0.5) / ny - v;
      const d = du * du + dv * dv;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best >= 0) this.scheduleSpread(it, best, t);
  }

  private lightConsume(it: BurnItemSim, t: number): void {
    if (it.lit) return;
    if (it.consumedAtTime(t) >= it.consumeTotal - 1e-9) return;
    it.consumed = it.consumedAtTime(t);
    it.consumedAt = t;
    it.lit = true;
    it.vitality = 1;
    it.everIgnited = true;
    it.pendingIgniteAt = Infinity;
    it.dirty = true;
    // 烧到头的精确时刻结算一次状态
    const end = t + (it.consumeTotal - it.consumed);
    this.heap.push(end, HeapKind.Settle, it.idx, 0);
  }

  /** 面燃烧：把格 c 安排在时刻 t 点着（更早的覆盖更晚的） */
  private scheduleSpread(it: BurnItemSim, c: number, t: number): void {
    const s = it.st[c];
    if (s === CellSt.Ignited || s === CellSt.Frozen) return;
    if (s === CellSt.Tentative && it.tIgn[c] <= t) return;
    if (s === CellSt.None) {
      it.st[c] = CellSt.Tentative;
      it.pending++;
    }
    it.tIgn[c] = t;
    it.dirty = true;
    if (!Number.isFinite(it.epoch)) it.epoch = t;
    this.heap.push(t, HeapKind.Spread, it.idx, c);
  }

  private applyHeap(t: number, kind: number, idx: number, c: number): void {
    const it = this.items[idx];
    // 不在世界里：状态定格（排着的推进一律作废）
    if (!it.present) return;
    if (kind === HeapKind.Settle) {
      this.settle(it, t);
      return;
    }
    if (kind === HeapKind.ConsumeIgnite) {
      if (it.pendingIgniteAt !== t) return;       // 过期
      it.pendingIgniteAt = Infinity;
      this.lightConsume(it, t);
      this.settle(it, t);
      return;
    }
    // Spread：懒删除——只认与当前暂定时刻一致的那条
    if (it.st[c] !== CellSt.Tentative || it.tIgn[c] !== t) return;
    it.st[c] = CellSt.Ignited;
    it.pending--;
    it.remaining--;
    it.everIgnited = true;
    it.ignList[it.ignCount] = c;
    it.ignTimes[it.ignCount] = t;
    it.ignCount++;
    const end = it.cellActiveEnd(c);
    if (end > it.activeUntil) it.activeUntil = end;
    this.spreadFrom(it, c, t);
    this.igniteOthersFromCell(it, c, t);
    this.settle(it, t);
    if (it.pending === 0) this.heap.push(it.activeUntil, HeapKind.Settle, it.idx, 0);
  }

  /** 源格处的气流（m/s，世界向量）：浮力 √(gL) 朝上 + 场景风 */
  private flowAt(it: BurnItemSim, c: number, t: number, out: number[]): number {
    const lm = it.b.flameLengthCm / 100;
    const uRef = Math.sqrt(BURN_G * lm);
    let wx = 0, wy = 0, wz = 0;
    const p = this.env.wind;
    if (p) {
      sampleSceneWind(p, this.env.windTimeAt(t), it.px[c], it.pz[c], it.hAbove[c], this.windTmp);
      wx = this.windTmp[0] / BURN_WU_PER_M;
      wy = this.windTmp[1] / BURN_WU_PER_M;
      wz = this.windTmp[2] / BURN_WU_PER_M;
    }
    out[0] = wx; out[1] = uRef + wy; out[2] = wz;
    return uRef;
  }

  private readonly flowTmp = [0, 0, 0];

  private spreadFrom(it: BurnItemSim, c: number, t: number): void {
    const { nx, ny } = it.grid;
    const i = c % nx;
    const j = (c - i) / nx;
    const F = this.flowTmp;
    const uRef = this.flowAt(it, c, t, F);
    const vo = it.b.speedOpposed;
    const vc = it.b.speedConcurrent;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= ny) continue;
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ii = i + di;
        if (ii < 0 || ii >= nx) continue;
        const nIdx = jj * nx + ii;
        if (it.grid.fuel[nIdx] < BURN_MIN_FUEL) continue;
        const s = it.st[nIdx];
        if (s === CellSt.Ignited || s === CellSt.Frozen) continue;
        const dx = it.px[nIdx] - it.px[c];
        const dy = it.py[nIdx] - it.py[c];
        const dz = it.pz[nIdx] - it.pz[c];
        const dWu = Math.hypot(dx, dy, dz);
        if (!(dWu > 1e-9)) {
          this.scheduleSpread(it, nIdx, t);
          continue;
        }
        const along = (F[0] * dx + F[1] * dy + F[2] * dz) / dWu;
        const v = vo + (vc - vo) * Math.max(0, along) / uRef;
        const dCm = dWu / BURN_WU_PER_CM;
        this.scheduleSpread(it, nIdx, t + dCm / v);
      }
    }
  }

  /**
   * 一段火焰（从 (x,y,z) 沿轴 a 长 L wu、源半径 r）碰到的别的可燃物的格 ⇒ 在 t + 目标引燃时间点着，
   * 前提是火焰到那时还在（`flameUntil`）。
   */
  private igniteOthersFromSegment(
    srcIdx: number, x: number, y: number, z: number, ax: number, ay: number, az: number, L: number, r: number,
    t: number, flameUntil: number, onlyTarget = -1,
  ): void {
    if (this.items.length < 2) return;
    const src = this.items[srcIdx];
    if (!src.present) return;
    const x1 = x + ax * L, y1 = y + ay * L, z1 = z + az * L;
    const pad = r + this.maxHalfDepth + src.halfDepth + 2 * HASH_CELL_WU;
    const minX = Math.floor((Math.min(x, x1) - pad) / HASH_CELL_WU), maxX = Math.floor((Math.max(x, x1) + pad) / HASH_CELL_WU);
    const minY = Math.floor((Math.min(y, y1) - pad) / HASH_CELL_WU), maxY = Math.floor((Math.max(y, y1) + pad) / HASH_CELL_WU);
    const minZ = Math.floor((Math.min(z, z1) - pad) / HASH_CELL_WU), maxZ = Math.floor((Math.max(z, z1) + pad) / HASH_CELL_WU);
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iy = minY; iy <= maxY; iy++) {
        for (let iz = minZ; iz <= maxZ; iz++) {
          const list = this.hashKeys.get(this.hashKey(ix, iy, iz));
          if (!list) continue;
          for (const packed of list) {
            const ti = (packed / 65536) | 0;
            if (ti === srcIdx || (onlyTarget >= 0 && ti !== onlyTarget)) continue;
            const tgt = this.items[ti];
            const tc = packed - ti * 65536;
            // 哈希碰撞：确认真的在这一格
            if (Math.floor(tgt.px[tc] / HASH_CELL_WU) !== ix || Math.floor(tgt.py[tc] / HASH_CELL_WU) !== iy
              || Math.floor(tgt.pz[tc] / HASH_CELL_WU) !== iz) continue;
            const arrival = t + tgt.b.ignitionDelay;
            if (arrival > flameUntil) continue;
            if (tgt.b.mode === 'spread') {
              const s = tgt.st[tc];
              if (s === CellSt.Ignited || s === CellSt.Frozen) continue;
              if (s === CellSt.Tentative && tgt.tIgn[tc] <= arrival) continue;
            } else {
              if (tgt.lit || tgt.pendingIgniteAt <= arrival) continue;
              if (tgt.consumedAtTime(t) >= tgt.consumeTotal - 1e-9) continue;
              // 蜡烛 / 香只有"芯"那一处点得着：火苗那一列、还没烧到的最上面一带
              if (!this.isWickCell(tgt, tc, t)) continue;
            }
            // 点到线段的距离（沿目标法线扣掉两边的纵深半厚）
            const px = tgt.px[tc] - x, py = tgt.py[tc] - y, pz = tgt.pz[tc] - z;
            let s = px * ax + py * ay + pz * az;
            s = Math.min(L, Math.max(0, s));
            const d = contactGap(px - ax * s, py - ay * s, pz - az * s, tgt.nrm, tgt.halfDepth + src.halfDepth);
            if (d > r + tgt.halfDiag[tc]) continue;
            if (tgt.b.mode === 'spread') {
              this.scheduleSpread(tgt, tc, arrival);
            } else {
              tgt.pendingIgniteAt = arrival;
              this.heap.push(arrival, HeapKind.ConsumeIgnite, tgt.idx, 0);
            }
          }
        }
      }
    }
  }

  /**
   * 挪位 / 出现的那一刻：火焰碰别人平时只在格子**点着那一刻**查（静止的东西之后也碰不到新的），
   * 挪过来的实例要补查一次——别人此刻的明火碰不碰得到它、它此刻的明火碰得到谁。消耗燃烧的火苗每个接触步都在查，不用补。
   */
  private recontact(moved: BurnItemSim, t: number): void {
    if (this.items.length < 2 || !moved.present || !moved.world) return;
    const a = this.axisTmp;
    const each = (src: BurnItemSim, only: number): void => {
      if (!src.present || !src.world || src.b.mode !== 'spread') return;
      const b = src.b;
      const start = lowerBound(src.ignTimes.subarray(0, src.ignCount), t - b.flameSeconds);
      for (let k = start; k < src.ignCount; k++) {
        const ti = src.ignTimes[k];
        if (ti > t) break;
        const c = src.ignList[k];
        if (src.st[c] === CellSt.Frozen) continue;
        const until = ti + b.flameSeconds * src.grid.fuel[c];
        if (!(until > t)) continue;
        const L = this.flameAxis(src, c, t, a);
        this.igniteOthersFromSegment(src.idx, src.px[c], src.py[c], src.pz[c], a[0], a[1], a[2], L, src.halfDiag[c], t, until, only);
      }
    };
    for (const src of this.items) if (src !== moved) each(src, moved.idx);
    each(moved, -1);
  }

  /** 火焰轴（单位向量）写进 out，返回火焰长度（wu） */
  private flameAxis(it: BurnItemSim, c: number, t: number, out: number[]): number {
    const F = this.flowTmp;
    this.flowAt(it, c, t, F);
    const len = Math.hypot(F[0], F[1], F[2]);
    if (len > 1e-9) { out[0] = F[0] / len; out[1] = F[1] / len; out[2] = F[2] / len; } else { out[0] = 0; out[1] = 1; out[2] = 0; }
    return it.b.flameLengthCm * BURN_WU_PER_CM;
  }

  private readonly axisTmp = [0, 1, 0];

  private igniteOthersFromCell(it: BurnItemSim, c: number, t: number): void {
    if (this.items.length < 2) return;
    const a = this.axisTmp;
    const L = this.flameAxis(it, c, t, a);
    const flameUntil = t + it.b.flameSeconds * it.grid.fuel[c];
    this.igniteOthersFromSegment(it.idx, it.px[c], it.py[c], it.pz[c], a[0], a[1], a[2], L, it.halfDiag[c], t, flameUntil);
  }

  /** 消耗燃烧：格 c 是不是"芯"（火苗那一列、顺序值不超过此刻累计秒 + 一个明火带） */
  private isWickCell(it: BurnItemSim, c: number, t: number): boolean {
    if (!it.grid.order) return false;
    const nx = it.grid.nx;
    const i = c % nx;
    const fu = it.b.flameU ?? it.grid.centroidU;
    if (Math.abs((i + 0.5) / nx - fu) > it.b.flameWidth / 2) return false;
    const ov = it.grid.order[c] * it.b.consumeSeconds;
    const s = it.consumedAtTime(t);
    return ov >= s - it.b.flameSeconds && ov <= s + it.b.flameSeconds;
  }

  /** 此刻消耗燃烧的火苗那一格（面燃烧 / 没有 = −1） */
  flameCell(key: string): number {
    const it = this.byKey.get(key);
    return it ? this.flameCellOf(it, this.tDone) : -1;
  }

  /** 消耗燃烧的火苗在哪一格（明火带与火苗列的交集里顺序最早的那格；没有 = −1） */
  private flameCellOf(it: BurnItemSim, t: number): number {
    if (it.b.mode !== 'consume' || !it.orderSorted || !it.orderValues) return -1;
    const s = it.consumedAtTime(t);
    const lo = lowerBound(it.orderValues, s - it.b.flameSeconds);
    const { nx } = it.grid;
    const fu = it.b.flameU ?? it.grid.centroidU;
    const half = it.b.flameWidth / 2;
    let fallback = -1;
    for (let k = lo; k < it.orderSorted.length; k++) {
      if (it.orderValues[k] > s) break;
      const c = it.orderSorted[k];
      if (fallback < 0) fallback = c;
      const i = c % nx;
      if (Math.abs((i + 0.5) / nx - fu) <= half) return c;
    }
    return fallback;
  }

  private stepConsumeContacts(t: number): void {
    if (this.items.length < 2) return;
    for (const it of this.items) {
      if (it.b.mode !== 'consume' || !it.lit || !it.present || !it.world) continue;
      const c = this.flameCellOf(it, t);
      if (c < 0) continue;
      const a = this.axisTmp;
      const L = this.flameAxis(it, c, t, a);
      // 火苗一直在：到下一个接触步之前都算"还在"
      this.igniteOthersFromSegment(it.idx, it.px[c], it.py[c], it.pz[c], a[0], a[1], a[2], L, it.halfDiag[c], t, t + BURN_CONTACT_STEP + it.b.ignitionDelay);
    }
  }

  private stepBlowout(t: number): void {
    const h = BURN_BLOWOUT_STEP;
    for (const it of this.items) {
      const bo = it.b.blowout;
      if (it.b.mode !== 'consume' || !bo || !it.lit || !it.present || !it.world) continue;
      const c = this.flameCellOf(it, t);
      let u = 0;
      if (c >= 0 && this.env.wind) {
        sampleSceneWind(this.env.wind, this.env.windTimeAt(t), it.px[c], it.pz[c], it.hAbove[c], this.windTmp);
        u = Math.hypot(this.windTmp[0], this.windTmp[2]) / BURN_WU_PER_M;
      }
      const ws = bo.windSpeed;
      const rate = u > ws ? -((u - ws) / ws) / bo.drainSeconds : (1 - u / ws) / bo.recoverSeconds;
      it.vitality = Math.min(1, Math.max(0, it.vitality + rate * h));
      if (it.vitality <= 0) {
        this.extinguishItem(it, t);
        this.settle(it, t);
      }
    }
  }

  /**
   * 一段**外来的**火焰（燃着的纸钱）此刻碰到了哪些可燃物、碰在哪一格（每个可燃物取最近的一格）。
   * 调用方据此记外部点火事件（时刻 = 现在 + 目标引燃时间）。世界映射没齐时返回空。
   * 已经着了 / 定格的格、正烧着或烧完的消耗燃烧不算。
   */
  findContacts(
    x: number, y: number, z: number, ax: number, ay: number, az: number, L: number, r: number,
  ): { key: string; u: number; v: number; delay: number }[] {
    if (!this.worldReady) return [];
    const best = new Map<number, { c: number; d: number }>();
    const x1 = x + ax * L, y1 = y + ay * L, z1 = z + az * L;
    const pad = r + this.maxHalfDepth + 2 * HASH_CELL_WU;
    const minX = Math.floor((Math.min(x, x1) - pad) / HASH_CELL_WU), maxX = Math.floor((Math.max(x, x1) + pad) / HASH_CELL_WU);
    const minY = Math.floor((Math.min(y, y1) - pad) / HASH_CELL_WU), maxY = Math.floor((Math.max(y, y1) + pad) / HASH_CELL_WU);
    const minZ = Math.floor((Math.min(z, z1) - pad) / HASH_CELL_WU), maxZ = Math.floor((Math.max(z, z1) + pad) / HASH_CELL_WU);
    const t = this.tDone;
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iy = minY; iy <= maxY; iy++) {
        for (let iz = minZ; iz <= maxZ; iz++) {
          const list = this.hashKeys.get(this.hashKey(ix, iy, iz));
          if (!list) continue;
          for (const packed of list) {
            const ti = (packed / 65536) | 0;
            const tgt = this.items[ti];
            const tc = packed - ti * 65536;
            if (Math.floor(tgt.px[tc] / HASH_CELL_WU) !== ix || Math.floor(tgt.py[tc] / HASH_CELL_WU) !== iy
              || Math.floor(tgt.pz[tc] / HASH_CELL_WU) !== iz) continue;
            if (tgt.b.mode === 'spread') {
              const s = tgt.st[tc];
              if (s === CellSt.Ignited || s === CellSt.Frozen) continue;
            } else {
              if (tgt.lit || tgt.consumedAtTime(t) >= tgt.consumeTotal - 1e-9) continue;
              if (!this.isWickCell(tgt, tc, t)) continue;
            }
            const px = tgt.px[tc] - x, py = tgt.py[tc] - y, pz = tgt.pz[tc] - z;
            let s = px * ax + py * ay + pz * az;
            s = Math.min(L, Math.max(0, s));
            const d = contactGap(px - ax * s, py - ay * s, pz - az * s, tgt.nrm, tgt.halfDepth);
            if (d > r + tgt.halfDiag[tc]) continue;
            const prev = best.get(ti);
            if (!prev || d < prev.d || (d === prev.d && tc < prev.c)) best.set(ti, { c: tc, d });
          }
        }
      }
    }
    const out: { key: string; u: number; v: number; delay: number }[] = [];
    for (const [ti, { c }] of [...best].sort((a, b) => a[0] - b[0])) {
      const it = this.items[ti];
      const i = c % it.grid.nx;
      const j = (c - i) / it.grid.nx;
      out.push({ key: it.key, u: (i + 0.5) / it.grid.nx, v: (j + 0.5) / it.grid.ny, delay: it.b.ignitionDelay });
    }
    return out;
  }

  // ---------------------------------------------------------------- 快照

  /** 此刻（{@link time}）烧成什么样（手上挂件的存档 / 收进包里记住烧到哪）；没有这个实例 ⇒ null */
  exportSnapshot(key: string): BurnItemSnapshot | null {
    const it = this.byKey.get(key);
    if (!it) return null;
    const snap: BurnItemSnapshot = { t: this.tDone, ever: it.everIgnited };
    if (it.b.mode === 'consume') {
      snap.consume = {
        lit: it.lit, consumed: it.consumed, consumedAt: it.consumedAt, vitality: it.vitality,
        pendingIgniteAt: finiteOrNull(it.pendingIgniteAt),
      };
    } else {
      const cells: number[] = [];
      const st: number[] = [];
      const tIgn: number[] = [];
      for (let c = 0; c < it.n; c++) {
        const x = it.st[c];
        if (x === CellSt.None || !Number.isFinite(it.tIgn[c])) continue;
        cells.push(c);
        st.push(x);
        tIgn.push(it.tIgn[c]);
      }
      snap.spread = { cells, st, tIgn, epoch: finiteOrNull(it.epoch), activeUntil: finiteOrNull(it.activeUntil) };
    }
    return snap;
  }

  /** 构造时把快照铺进这个实例（排着的推进按时刻重新入堆）。形状对不上烧法 ⇒ 当没点过 */
  private applySnapshot(it: BurnItemSim, snap: BurnItemSnapshot): void {
    this.resetItem(it);
    const t = snap.t;
    if (it.b.mode === 'consume') {
      const c = snap.consume;
      if (!c) return;
      it.everIgnited = snap.ever;
      it.consumed = Math.min(it.consumeTotal, Math.max(0, c.consumed));
      it.consumedAt = c.consumedAt;
      it.vitality = Math.min(1, Math.max(0, c.vitality));
      it.lit = c.lit && it.consumedAtTime(t) < it.consumeTotal - 1e-9;
      if (it.lit) this.heap.push(it.consumedAt + (it.consumeTotal - it.consumed), HeapKind.Settle, it.idx, 0);
      if (c.pendingIgniteAt !== null && !it.lit) {
        it.pendingIgniteAt = c.pendingIgniteAt;
        this.heap.push(c.pendingIgniteAt, HeapKind.ConsumeIgnite, it.idx, 0);
      }
    } else {
      const sp = snap.spread;
      if (!sp) return;
      const done: number[] = [];
      for (let k = 0; k < sp.cells.length; k++) {
        const c = sp.cells[k];
        const x = sp.st[k];
        if (c >= it.n || it.grid.fuel[c] < BURN_MIN_FUEL) continue;
        it.st[c] = x;
        it.tIgn[c] = sp.tIgn[k];
        if (x === CellSt.Tentative) {
          it.pending++;
          this.heap.push(sp.tIgn[k], HeapKind.Spread, it.idx, c);
        } else {
          done.push(c);
        }
      }
      done.sort((a, c) => (it.tIgn[a] - it.tIgn[c]) || (a - c));
      it.ignCount = done.length;
      for (let k = 0; k < done.length; k++) {
        it.ignList[k] = done[k];
        it.ignTimes[k] = it.tIgn[done[k]];
      }
      it.remaining = it.grid.fuelCells - done.length;
      it.everIgnited = snap.ever;
      it.epoch = sp.epoch ?? NaN;
      it.activeUntil = sp.activeUntil ?? -Infinity;
      if (it.pending === 0 && it.activeUntil > t) this.heap.push(it.activeUntil, HeapKind.Settle, it.idx, 0);
    }
    it.dirty = true;
    it.state = it.computeState(t);
  }

  // ---------------------------------------------------------------- 读数

  /** 第 c 格格心的图内 uv（表现层按宿主此刻的位置自己换算世界点用） */
  cellUv(key: string, c: number): { u: number; v: number } | null {
    const it = this.byKey.get(key);
    if (!it || c < 0 || c >= it.n) return null;
    const i = c % it.grid.nx;
    return { u: (i + 0.5) / it.grid.nx, v: ((c - i) / it.grid.nx + 0.5) / it.grid.ny };
  }

  state(key: string): BurnState | null {
    return this.byKey.get(key)?.state ?? null;
  }

  /** 消耗燃烧的火势（0..1）；面燃烧恒 1 */
  vitality(key: string): number {
    const it = this.byKey.get(key);
    return it && it.b.mode === 'consume' ? it.vitality : 1;
  }

  /**
   * 着色器的时间原点与此刻：面燃烧 = (epoch, t − epoch)；消耗燃烧 = (0, 累计烧了多少秒)。
   * 没点着过的面燃烧 epoch 为 NaN（此刻给 −∞ 的等价大负数）。
   */
  shaderClock(key: string): { now: number; timeStep: number } {
    const it = this.byKey.get(key);
    if (!it) return { now: -1e6, timeStep: 1 / 16 };
    if (it.b.mode === 'consume') {
      return { now: it.consumedAtTime(this.tDone), timeStep: consumeTimeStep(it) };
    }
    return { now: Number.isFinite(it.epoch) ? this.tDone - it.epoch : -1e6, timeStep: SPREAD_TIME_STEP };
  }

  /** 纹理是否脏了（读后清） */
  takeDirty(key: string): boolean {
    const it = this.byKey.get(key);
    if (!it || !it.dirty) return false;
    it.dirty = false;
    return true;
  }

  /**
   * 编码燃烧场纹理（RGBA8，nx×ny，行优先 v 向下）：
   * RG = 点着时刻（16 位定点，时间步 `timeStep`，65535 = 不会点着）；B = 燃料；A = 熄灭定格（255）。
   */
  encodeTexture(key: string, out: Uint8Array): void {
    const it = this.byKey.get(key);
    if (!it) return;
    const n = it.n;
    if (it.b.mode === 'consume') {
      const step = consumeTimeStep(it);
      const ord = it.grid.order!;
      for (let c = 0; c < n; c++) {
        const o = c * 4;
        const f = it.grid.fuel[c];
        if (f < BURN_MIN_FUEL) { out[o] = 255; out[o + 1] = 255; out[o + 2] = 0; out[o + 3] = 0; continue; }
        const q = Math.min(65534, Math.max(0, Math.round((ord[c] * it.b.consumeSeconds) / step)));
        out[o] = q >> 8; out[o + 1] = q & 255; out[o + 2] = Math.round(f * 255); out[o + 3] = 0;
      }
      return;
    }
    const epoch = it.epoch;
    for (let c = 0; c < n; c++) {
      const o = c * 4;
      const f = it.grid.fuel[c];
      const ti = it.tIgn[c];
      let q = 65535;
      if (f >= BURN_MIN_FUEL && Number.isFinite(ti) && Number.isFinite(epoch)) {
        q = Math.min(65534, Math.max(0, Math.round((ti - epoch) / SPREAD_TIME_STEP)));
      }
      out[o] = q >> 8;
      out[o + 1] = q & 255;
      out[o + 2] = f >= BURN_MIN_FUEL ? Math.round(f * 255) : 0;
      out[o + 3] = it.st[c] === CellSt.Frozen ? 255 : 0;
    }
  }

  /**
   * 此刻某一段的格：`flame` 明火 / `ember` 余烬 / `ash` 刚成灰（1 秒内）。
   * 消耗燃烧的 `flame` 只算火苗那一列（光与火苗粒子从那出）。
   */
  query(key: string, source: 'flame' | 'ember' | 'ash', out: BurnCellQuery): BurnCellQuery {
    out.count = 0; out.area = 0; out.cx = 0; out.cy = 0; out.cz = 0;
    const it = this.byKey.get(key);
    if (!it || !it.world) return out;
    const t = this.tDone;
    if (out.cells.length < it.n) out.cells = new Int32Array(it.n);
    const push = (c: number): void => {
      const a = it.area[c];
      out.cells[out.count++] = c;
      out.area += a;
      out.cx += it.px[c] * a; out.cy += it.py[c] * a; out.cz += it.pz[c] * a;
    };
    const b = it.b;
    if (b.mode === 'consume') {
      if (!it.orderSorted || !it.orderValues) return finishQuery(out);
      const s = it.consumedAtTime(t);
      let lo: number, hi: number;
      if (source === 'flame') {
        if (!it.lit) return finishQuery(out);
        lo = s - b.flameSeconds; hi = s;
      } else if (source === 'ember') {
        lo = s - b.flameSeconds - b.emberSeconds; hi = s - b.flameSeconds;
      } else {
        lo = s - b.flameSeconds - b.emberSeconds - 1; hi = s - b.flameSeconds - b.emberSeconds;
      }
      const fu = b.flameU ?? it.grid.centroidU;
      const half = b.flameWidth / 2;
      const nx = it.grid.nx;
      for (let k = lowerBound(it.orderValues, lo); k < it.orderSorted.length; k++) {
        const ov = it.orderValues[k];
        if (ov > hi) break;
        if (ov <= lo) continue;
        const c = it.orderSorted[k];
        if (source === 'flame') {
          const i = c % nx;
          if (Math.abs((i + 0.5) / nx - fu) > half) continue;
        }
        push(c);
      }
      return finishQuery(out);
    }
    // 面燃烧：点着列表按时刻升序，二分出窗口再逐格精确判
    const flameMax = b.flameSeconds;
    let tLo: number;
    if (source === 'flame') tLo = t - flameMax;
    else if (source === 'ember') tLo = t - flameMax - b.emberSeconds;
    else tLo = t - flameMax - b.emberSeconds - 1;
    const start = lowerBound(it.ignTimes.subarray(0, it.ignCount), tLo);
    for (let k = start; k < it.ignCount; k++) {
      const ti = it.ignTimes[k];
      if (ti > t) break;
      const c = it.ignList[k];
      if (it.st[c] === CellSt.Frozen) continue;
      const fEnd = ti + b.flameSeconds * it.grid.fuel[c];
      const eEnd = fEnd + b.emberSeconds;
      if (source === 'flame') { if (t < fEnd) push(c); }
      else if (source === 'ember') { if (t >= fEnd && t < eEnd) push(c); }
      else if (t >= eEnd && t < eEnd + 1) push(c);
    }
    return finishQuery(out);
  }

  /** 世界位置读数（给粒子出生点）：第 c 格的格心与半对角线 */
  cellWorld(key: string, c: number, out: number[]): boolean {
    const it = this.byKey.get(key);
    if (!it || !it.world || c < 0 || c >= it.n) return false;
    out[0] = it.px[c]; out[1] = it.py[c]; out[2] = it.pz[c]; out[3] = it.halfDiag[c];
    return true;
  }

  /** 纵深半厚（wu，见 `BurnItemSim.halfDepth`）；没映射 = 0 */
  halfDepthOf(key: string): number {
    const it = this.byKey.get(key);
    return it && it.world ? it.halfDepth : 0;
  }

  /** 火焰长度（wu）与此刻火焰轴（世界单位向量，写进 axis） */
  flameAxisAt(key: string, c: number, axis: number[]): number {
    const it = this.byKey.get(key);
    if (!it || !it.world || c < 0 || c >= it.n) { axis[0] = 0; axis[1] = 1; axis[2] = 0; return 0; }
    return this.flameAxis(it, c, this.tDone, axis);
  }

  grid(key: string): BurnGrid | null {
    return this.byKey.get(key)?.grid ?? null;
  }

  burnable(key: string): ResolvedBurnable | null {
    return this.byKey.get(key)?.b ?? null;
  }

  /** 外部事件日志（给存档） */
  events(key: string): BurnExternalEvent[] {
    return this.byKey.get(key)?.events.slice() ?? [];
  }

  /** 还没处理到的外部事件（模拟没就绪时记下的；快照存档要把它们一起带上） */
  pendingEvents(key: string): BurnExternalEvent[] {
    const it = this.byKey.get(key);
    return it ? it.events.slice(it.nextEvent) : [];
  }

  /** 整份调试读数 */
  debugItem(key: string): {
    state: BurnState; mode: string; ignited: number; pending: number; remaining: number; lit: boolean;
    consumed: number; vitality: number; events: number;
  } | null {
    const it = this.byKey.get(key);
    if (!it) return null;
    return {
      state: it.state,
      mode: it.b.mode,
      ignited: it.ignCount,
      pending: it.pending,
      remaining: it.remaining,
      lit: it.lit,
      consumed: it.consumedAtTime(this.tDone),
      vitality: it.vitality,
      events: it.events.length,
    };
  }
}

/** 面燃烧纹理的时间步（秒）：1/16 s × 65534 ≈ 68 分钟 */
export const SPREAD_TIME_STEP = 1 / 16;

function consumeTimeStep(it: BurnItemSim): number {
  return Math.max(SPREAD_TIME_STEP, it.b.consumeSeconds / 65534);
}

function finishQuery(out: BurnCellQuery): BurnCellQuery {
  if (out.area > 0) { out.cx /= out.area; out.cy /= out.area; out.cz /= out.area; }
  return out;
}

/** 第一个 ≥ x 的下标 */
/** 接触距离：向量 (qx,qy,qz) 沿法线 n 的分量扣掉 `slack`（两边的纵深半厚，不扣成负），与面内分量合成 */
function contactGap(qx: number, qy: number, qz: number, n: readonly number[], slack: number): number {
  if (!(slack > 0)) return Math.hypot(qx, qy, qz);
  const dn = qx * n[0] + qy * n[1] + qz * n[2];
  const px = qx - dn * n[0], py = qy - dn * n[1], pz = qz - dn * n[2];
  return Math.hypot(px, py, pz, Math.max(0, Math.abs(dn) - slack));
}

function lowerBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < x) lo = m + 1; else hi = m;
  }
  return lo;
}

export function createBurnCellQuery(): BurnCellQuery {
  return { count: 0, cells: new Int32Array(0), area: 0, cx: 0, cy: 0, cz: 0 };
}
