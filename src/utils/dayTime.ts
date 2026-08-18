import type { DayPhaseDef } from '../data/types';

/**
 * 日夜循环的**纯几何/解析工具**（无引擎依赖，可独立测试）。
 *
 * `DayManager`（时刻真相源）与 `NpcScheduleSystem`（日程查表）都消费这里的函数——
 * 放 utils 而不是任一系统内，是为了让两个同层系统不必互相 import（运行时规范律 11）。
 */

export const MINUTES_PER_DAY = 1440;

/** 缺省时段分段：内容侧不配 `game_config.dayNight.phases` 时用这四段。 */
export const DEFAULT_PHASES: readonly DayPhaseDef[] = [
  { id: 'dawn', from: '05:00', label: '拂晓' },
  { id: 'day', from: '07:00', label: '白日', daylight: true },
  { id: 'dusk', from: '18:00', label: '黄昏' },
  { id: 'night', from: '20:00', label: '入夜' },
] as const;

/** 缺省开局时刻（07:00）与缺省过渡时长。 */
export const DEFAULT_START_AT = '07:00';
export const DEFAULT_TRANSITION_MS = 1500;

/** 解析后的时段：`fromMinutes` 为当日起点分钟数。按 `fromMinutes` 升序排列使用。 */
export interface ResolvedPhase {
  id: string;
  fromMinutes: number;
  label?: string;
  /** 语义角色：这一段「人在外面做事」。见 {@link daylightPhaseIds}。 */
  daylight?: boolean;
}

/**
 * 解析 `HH:MM`（24 小时制）为当日分钟数。非法输入返回 `null`（调用方负责告警并回落），
 * 刻意不抛异常——内容数据里的错字不该让整个系统起不来。
 */
export function parseClock(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? normalizeMinutes(raw) : null;
  }
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 分钟数格式化为 `HH:MM`（供编辑器/调试显示；先归一到 [0,1440)）。 */
export function formatClock(minutes: number): string {
  const m = normalizeMinutes(minutes);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 把任意分钟数归一到 [0, 1440)（负数按 24 小时回绕）。 */
export function normalizeMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  const m = Math.round(minutes) % MINUTES_PER_DAY;
  return m < 0 ? m + MINUTES_PER_DAY : m;
}

/**
 * 规整时段表：解析 `from`、丢弃非法段与重复 id、按起点升序。
 * 全部非法（或空）时回落到 {@link DEFAULT_PHASES}——保证恒有至少一段可用。
 */
export function resolvePhases(defs: readonly DayPhaseDef[] | undefined): ResolvedPhase[] {
  const out: ResolvedPhase[] = [];
  const seen = new Set<string>();
  for (const def of defs ?? []) {
    const id = String(def?.id ?? '').trim();
    if (!id) {
      console.warn('dayTime.resolvePhases: 跳过缺 id 的时段');
      continue;
    }
    if (seen.has(id)) {
      console.warn(`dayTime.resolvePhases: 跳过重复时段 id "${id}"`);
      continue;
    }
    const fromMinutes = parseClock(def?.from);
    if (fromMinutes === null) {
      console.warn(`dayTime.resolvePhases: 时段 "${id}" 的 from 非法（需 HH:MM），已跳过`);
      continue;
    }
    seen.add(id);
    out.push({ id, fromMinutes, label: def?.label, daylight: def?.daylight === true });
  }
  if (out.length === 0) return resolveDefaultPhases();
  out.sort((a, b) => a.fromMinutes - b.fromMinutes);
  return out;
}

function resolveDefaultPhases(): ResolvedPhase[] {
  return DEFAULT_PHASES.map((p) => ({
    id: p.id,
    fromMinutes: parseClock(p.from) ?? 0,
    label: p.label,
    daylight: p.daylight === true,
  }));
}

/**
 * 求某一时刻属于哪个时段。
 *
 * **跨零点回绕**：时刻早于第一段起点时，仍属于**最后一段**（如 01:40 属于前一晚的 `night`）。
 * 这是时段表天然环形的直接后果，勿"修"成回落第一段。
 */
export function phaseAt(phases: readonly ResolvedPhase[], minutes: number): string {
  if (phases.length === 0) return '';
  const m = normalizeMinutes(minutes);
  let current = phases[phases.length - 1].id;
  for (const p of phases) {
    if (m >= p.fromMinutes) current = p.id;
    else break;
  }
  return current;
}

/**
 * 判断时刻是否落在 `[fromMinutes, toMinutes)` 区间内，**支持跨零点**
 * （`19:00`→`06:00` 表示夜里那一段，而非空区间）。
 *
 * 起止相等视为**整天**（一条日程条目占满 24 小时），不是零长度区间——
 * 零长度条目没有任何表达价值，而"整天在这儿"是常见写法。
 */
export function isWithinRange(minutes: number, fromMinutes: number, toMinutes: number): boolean {
  const m = normalizeMinutes(minutes);
  const from = normalizeMinutes(fromMinutes);
  const to = normalizeMinutes(toMinutes);
  if (from === to) return true;
  if (from < to) return m >= from && m < to;
  return m >= from || m < to;
}

/**
 * 「人在外面做事」的那几段——**NPC 未写 `phases` 时的缺省归属**，从当前时段表现算。
 *
 * ## 为什么是算的，不是常量
 *
 * 这里原先是个常量 `NPC_DEFAULT_PHASES = ['day']`，从 {@link DEFAULT_PHASES} 里抠了
 * 一个 id 硬写进代码。而那张表**会被内容侧整表替换**（本作换成了 `辰/午/暮/夜`）。
 * 表一换，`'day'` 指向一个不存在的时段，白名单判定恒假——所有开了日夜的场景
 * 全天空无一人，且没有任何报错。2026-08-18 雾津街头「一个人都没有」就是这么来的。
 *
 * 根子在于**代码存了时段 id**。所以修法不是换个常量，是让代码从此不认 id：
 * 内容侧在时段表里给「街上有人」的段打上 `daylight`，代码只问这个语义角色。
 * 时段叫什么、分几段、几点切换、什么语言，代码一概不知道，也就再没法对不上。
 * 时辰是内容侧的设定，不是引擎的概念。
 *
 * ## 缺省的含义（内容定调 2026-08-12，未变）
 *
 * 这个世界的人白天做事、天一擦黑就归家，「街上有人」是特例不是常态。
 * 龙套/群演走这条缺省，**不必人手一张日程表**——日程是给有作息的具名角色的
 * （分工见 `NpcScheduleSystem` 文件头）。要谁在别的时段也在，给他显式写 `phases`。
 *
 * 热点与 zone **不吃这个缺省**（门、路牌、可拾取物夜里当然还在），
 * 它们未写 `phases` 时仍是全时段——见 `SceneManager.entityInPhase` 的两个调用口径。
 *
 * ## 一段都没标时
 *
 * 返回 `[]` = **不施加限制**（全时段都在）。调用方负责告警一次。与「`currentPhase`
 * 取不到一律 fail-open」同一条原则：宁可街上多几个人，也绝不能静默清空整条街。
 * 这是上面那场事故留下的唯一硬要求。
 */
export function daylightPhaseIds(phases: readonly ResolvedPhase[]): readonly string[] {
  return phases.filter((p) => p.daylight === true).map((p) => p.id);
}

/**
 * 实体的**时段归属**判定（与位面 `planes` 同构的白名单）。
 *
 * - 写了 `phases` → 按白名单判。
 * - 没写 → 用 `fallback`：NPC 传 {@link NPC_DEFAULT_PHASES}（只白日），
 *   热点/zone 不传（= 全时段都在）。
 * - `currentPhase` 取不到（未接线）一律 fail-open——宁可多显示，
 *   也不能因为时钟没接上让整场景空掉。
 *
 * ⚠ 本函数不管「场景有没有开日夜」，那道闸在 `SceneManager.entityInPhase`：
 *   没开日夜的场景根本不该走时段过滤，否则旧场景一到夜里就空了。
 */
export function isEntityInPhase(
  phases: readonly string[] | undefined,
  currentPhase: string,
  fallback?: readonly string[],
): boolean {
  const list = Array.isArray(phases) && phases.length > 0 ? phases : fallback;
  if (!list || list.length === 0) return true;
  if (!currentPhase) return true;
  return list.includes(currentPhase);
}

/** 从 `fromMinutes` 前进到 `toMinutes` 需要的分钟数（跨零点按绕一圈算；相等返回 0）。 */
export function forwardDistance(fromMinutes: number, toMinutes: number): number {
  const from = normalizeMinutes(fromMinutes);
  const to = normalizeMinutes(toMinutes);
  return (to - from + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}
