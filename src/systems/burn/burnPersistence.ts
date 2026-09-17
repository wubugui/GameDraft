/**
 * 燃烧系统的存档形状与清洗（纯函数）。
 *
 * 存的是"推得出当时状态的最小事实"：
 * - **场景里的实例**（热点 / NPC / 演出生成留下的对象）：外部事件日志（点火 / 熄灭 / 复原 / 挪位 / 出现 / 收掉）
 *   + 世界映射表 + 指纹；派生出来的火线、蔓延、吹熄、烧完一概不存，读档后同一份模拟按事件重放到存档时刻（确定性，见 `burnSim.ts`）；
 * - **手上的可燃挂件**（跟着人跨场景走、没法重放）：快照（此刻烧成什么样），按「人|挂点」记；
 * - **收进包里的**：按挂件 id 记最后那一根烧到哪（同火把燃料：下次拿出来接着烧，烧完的不记）；
 * - 纸钱（表演态粒子）只存"哪几张永久烧没了"。
 *
 * v1（热点布置库时代）的档不认：整桶丢弃（燃烧状态回到没点）。
 */
import { isBurnState, type BurnState } from '../../data/burnables';
import {
  burnEventFromJson,
  burnEventToJson,
  burnSnapshotFromJson,
  type BurnEventJson,
  type BurnExternalEvent,
  type BurnItemSnapshot,
} from './burnSim';
import { BURN_WORLD_GRID } from './burnGeometry';

export const BURN_SAVE_VERSION = 2;

export interface BurnItemRecord {
  /** 模板 id */
  burnable: string;
  /** 指纹：模板（清洗后）+ 燃料网格——变了就推不出来 */
  fp: string;
  /** 最近一次知道的状态（模拟没建 / 没就绪时条件叶读它） */
  state: BurnState;
  /** 起点：fresh = 没烧过的样子；burnt = 直接烧完（推不出过程时切成的） */
  base: 'fresh' | 'burnt';
  events: BurnExternalEvent[];
  /** 世界映射表（每份 `burnWorldGridToJson`，第 0 份起始、`move` 事件指向后面的）；空 = 没算过 */
  worlds: number[][];
}

export interface BurnSceneRecordData {
  /** [这一段开始的燃烧钟, 燃烧钟 − 风钟] */
  visits: [number, number][];
  /** 场景风定义的指纹 */
  windFp: string;
  items: Map<string, BurnItemRecord>;
  /** 效果实例 id → 发射器序号 → 烧没了的槽位 */
  plates: Map<string, Map<number, Set<number>>>;
}

/** 手上 / 包里一根可燃挂件的事实 */
export interface BurnHeldRecord {
  /** 挂件预设 id */
  prop: string;
  /** 模板 id */
  burnable: string;
  fp: string;
  state: BurnState;
  /** 烧成什么样；没点过 = null */
  snap: BurnItemSnapshot | null;
  /** 快照之后还没处理的外部事件（模拟没就绪时记下的） */
  events: BurnExternalEvent[];
}

type HeldJson = { p: string; b: string; fp: string; st: BurnState; s: BurnItemSnapshot | null; ev?: BurnEventJson[] };

export interface BurnSaveJson {
  v: number;
  clock: number;
  scenes: Record<string, {
    visits: [number, number][];
    wind: string;
    items: Record<string, { b: string; fp: string; st: BurnState; base: 'fresh' | 'burnt'; ev: BurnEventJson[]; w: number[][] }>;
    plates: Record<string, Record<string, number[]>>;
  }>;
  /** 「人|挂点」→ 手上那根 */
  held: Record<string, HeldJson>;
  /** 挂件 id → 包里那根 */
  pocket: Record<string, HeldJson>;
}

export function emptySceneRecordData(): BurnSceneRecordData {
  return { visits: [], windFp: '', items: new Map(), plates: new Map() };
}

/** 53 位字符串哈希（cyrb53），给指纹用 */
export function burnHash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 手上 / 包里的「人|挂点」键 */
export function burnHeldKey(target: string, socket: string): string {
  return `${target}|${socket}`;
}

/**
 * 场景记录 → 存档 JSON。`extraBurntPlates` = 存档那一刻还在烧的纸（推不出来，按烧没了写进档；不改记录本身）。
 */
export function sceneRecordToJson(
  rec: BurnSceneRecordData,
  extraBurntPlates: readonly { instanceId: string; emitterIndex: number; slots: readonly number[] }[] = [],
  liveStates?: ReadonlyMap<string, BurnState>,
): BurnSaveJson['scenes'][string] {
  const items: BurnSaveJson['scenes'][string]['items'] = {};
  for (const [key, it] of rec.items) {
    items[key] = {
      b: it.burnable,
      fp: it.fp,
      st: liveStates?.get(key) ?? it.state,
      base: it.base,
      ev: it.events.map(burnEventToJson),
      w: it.worlds.map((w) => w.slice()),
    };
  }
  const plates: Record<string, Record<string, Set<number>>> = {};
  for (const [inst, byEmitter] of rec.plates) {
    for (const [e, slots] of byEmitter) {
      const set = ((plates[inst] ??= {})[String(e)] ??= new Set());
      for (const s of slots) set.add(s);
    }
  }
  for (const x of extraBurntPlates) {
    const set = ((plates[x.instanceId] ??= {})[String(x.emitterIndex)] ??= new Set());
    for (const s of x.slots) set.add(s);
  }
  const platesOut: Record<string, Record<string, number[]>> = {};
  for (const [inst, byEmitter] of Object.entries(plates)) {
    for (const [e, set] of Object.entries(byEmitter)) {
      if (set.size > 0) (platesOut[inst] ??= {})[e] = [...set].sort((a, b) => a - b);
    }
  }
  return { visits: rec.visits.map((v) => [v[0], v[1]]), wind: rec.windFp, items, plates: platesOut };
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function worldJsonOk(w: unknown): w is number[] {
  return Array.isArray(w) && w.length === BURN_WORLD_GRID * BURN_WORLD_GRID * 4 && w.every(finite);
}

/** 存档 JSON → 场景记录。坏条目逐条丢（一条坏不连累别的）；整份不是对象 ⇒ null */
export function sceneRecordFromJson(raw: unknown): BurnSceneRecordData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const rec = emptySceneRecordData();
  if (Array.isArray(o.visits)) {
    for (const v of o.visits) {
      if (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1])) rec.visits.push([v[0], v[1]]);
    }
    rec.visits.sort((a, b) => a[0] - b[0]);
  }
  rec.windFp = typeof o.wind === 'string' ? o.wind : '';
  if (o.items && typeof o.items === 'object' && !Array.isArray(o.items)) {
    for (const [key, v] of Object.entries(o.items as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const it = v as Record<string, unknown>;
      if (typeof it.b !== 'string' || typeof it.fp !== 'string' || !isBurnState(it.st)) continue;
      const worlds = Array.isArray(it.w) ? it.w.filter(worldJsonOk).map((w) => w.slice()) : [];
      const events: BurnExternalEvent[] = [];
      if (Array.isArray(it.ev)) {
        for (const e of it.ev) {
          const ev = burnEventFromJson(e);
          // 挪位指向表外 = 这一条推不出来：丢（对账时它的指纹 / 世界照常比，缺映射按缺映射收束）
          if (ev && !(ev.k === 'move' && ev.w >= worlds.length)) events.push(ev);
        }
      }
      events.sort((a, b) => a.t - b.t);
      rec.items.set(key, {
        burnable: it.b, fp: it.fp, state: it.st, base: it.base === 'burnt' ? 'burnt' : 'fresh', events, worlds,
      });
    }
  }
  if (o.plates && typeof o.plates === 'object' && !Array.isArray(o.plates)) {
    for (const [inst, byEmitter] of Object.entries(o.plates as Record<string, unknown>)) {
      if (!byEmitter || typeof byEmitter !== 'object' || Array.isArray(byEmitter)) continue;
      const m = new Map<number, Set<number>>();
      for (const [e, slots] of Object.entries(byEmitter as Record<string, unknown>)) {
        const ei = Number(e);
        if (!Number.isInteger(ei) || ei < 0 || !Array.isArray(slots)) continue;
        const set = new Set<number>();
        for (const s of slots) if (Number.isInteger(s) && (s as number) >= 0) set.add(s as number);
        if (set.size > 0) m.set(ei, set);
      }
      if (m.size > 0) rec.plates.set(inst, m);
    }
  }
  return rec;
}

export function heldRecordToJson(r: BurnHeldRecord): HeldJson {
  const out: HeldJson = { p: r.prop, b: r.burnable, fp: r.fp, st: r.state, s: r.snap ? JSON.parse(JSON.stringify(r.snap)) as BurnItemSnapshot : null };
  if (r.events.length > 0) out.ev = r.events.map(burnEventToJson);
  return out;
}

/** 坏形状 ⇒ null；快照坏了按没点过（`snap` = null）留着 */
export function heldRecordFromJson(raw: unknown): BurnHeldRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.p !== 'string' || !o.p || typeof o.b !== 'string' || typeof o.fp !== 'string' || !isBurnState(o.st)) return null;
  const events: BurnExternalEvent[] = [];
  if (Array.isArray(o.ev)) {
    for (const e of o.ev) {
      const ev = burnEventFromJson(e);
      if (ev && (ev.k === 'ignite' || ev.k === 'igniteAll' || ev.k === 'extinguish' || ev.k === 'reset')) events.push(ev);
    }
  }
  events.sort((a, b) => a.t - b.t);
  return { prop: o.p, burnable: o.b, fp: o.fp, state: o.st, snap: o.s == null ? null : burnSnapshotFromJson(o.s), events };
}

/** 风钟映射：燃烧钟 t 时风的钟（取最后一段开始于 t 之前的偏移；t 早于第一段取第一段） */
export function windTimeFromVisits(visits: readonly [number, number][], t: number): number {
  if (visits.length === 0) return t;
  let lo = 0;
  let hi = visits.length - 1;
  if (t < visits[0][0]) return t - visits[0][1];
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (visits[m][0] <= t) lo = m; else hi = m - 1;
  }
  return t - visits[lo][1];
}
