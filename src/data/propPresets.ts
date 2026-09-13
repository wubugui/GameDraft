/**
 * 挂件预设（prop_presets.json）
 *
 * 解决的问题：`anchorX/anchorY/rotation/scale` 这四个数描述的是**挂件自己**
 * ——同一把桃木剑，不管挂谁的手、哪个场景，刀柄永远在 0.5/0.92。
 * 它们不属于某一次 attachToSocket 调用。放在动作参数里意味着每个调用点重敲一遍，
 * 既烦又必然发散（五处挂剑迟早有一处数字不一样，而且查不出来）。
 *
 * 所以：挂件属性登记一次（本表），动作只写 `prop: "taomu_jian"`。
 * 显式给的参数仍然覆盖预设，留"这一次歪着拿"的口子。
 *
 * 与 overlay_images.json 是同一个思路（短 id → 资源），只是每条不止一个字段。
 *
 * ## 手持光源（2026-09-12）
 *
 * 一支点着的火把不只是一张图：它还带一盏**跟着手走**的灯、一团火焰粒子、
 * 一串状态（点着 / 护火 / 残炭 / 灭）。这些同样是**火把自己的属性**，
 * 不是调用点的属性 —— 所以同支点一个理由，全都登记在这里：
 *
 * - `light`：自带光源。挂上就有、卸下就没；每帧跟着挂点走（`HeldPropSystem`）。
 * - `vfx`：自带效果（效果资产 id）。火焰的**声音住在效果资产自己的 `sound.loop`**
 *   里（那条本来就从发射器原点空间播、跟着锚点走），本表**不开音频字段**——
 *   开了就是第二个真相源。
 * - `states`：状态表。每个状态覆盖上面这些块（贴图 / 灯 / 效果）；
 *   动作 `setPropState` 只切状态名，连续量（渐变、闪烁）由运行时算。
 * - `persistent`：`true` = 手持物（玩法事实，入档、跨场景自动重挂）；
 *   缺省 false = 演出挂件（切场景即散，与既有行为一致）。
 */

import type { RgbColor } from './types';

/**
 * 火焰闪烁：**作者填的是相对波动幅度与频率**，不是"随机 ±20%"那种魔数。
 *
 * 运行时产出一个标量 `L(t)`（见 `systems/heldProp/heldPropSignal.ts`），
 * 同时驱动灯的强度与发射率 —— **一个信号**，否则会出现"灯在闪、火苗不动"的穿帮。
 */
export interface PropFlickerDef {
  /** 相对波动幅度（0 = 不闪；0.2 = ±20% 上下） */
  amp: number;
  /** 波动频率（Hz）。烛火 6–10 */
  hz: number;
  /**
   * 风把幅度推高多少：`amp_eff = amp × (1 + windAmp × u/u_ref)`，
   * `u` = 火焰处的空气速度（场景风，wu/s），`u_ref` = `FLAME_WIND_REF_WU_PER_S`。
   * 缺省 0 = 不吃风（室内灯笼）。
   */
  windAmp?: number;
}

/**
 * 挂件自带的光源。字段语义与 `LightDef` 同名项**逐字相同**（单位 wu），
 * 少的那几项由运行时补：`kind` 恒 `point`、`pos` 每帧由挂点算、`enabled` 由状态给。
 */
export interface PropLightDef {
  /**
   * 灯挂在哪个挂点（火头 `torch_tip` 而不是手心）。
   * 缺省 = 挂载这次用的那个挂点。挂点当前帧没标注 ⇒ 这一帧灯不发光（与挂件一起隐）。
   */
  socket?: string;
  /** 世界空间偏移（wu），加在挂点解出来的位置上。缺省 [0,0,0] */
  offset?: [number, number, number];
  kelvin?: number;
  color?: RgbColor;
  intensity: number;
  range?: number;
  softeningRadius?: number;
  /** 缺省 false。跟随灯每帧都在动，开了投影 = 每帧重解线扫前缀，先量帧时再开 */
  castShadow?: boolean;
  flicker?: PropFlickerDef;
}

/** 一个状态对基础块的覆盖。只写要变的那几项。 */
export interface PropStateDef {
  /** 状态的人类可读名，只给编辑器列表看 */
  label?: string;
  image?: string;
  images?: string[];
  anchorX?: number;
  anchorY?: number;
  rotation?: number;
  scale?: number;
  lit?: boolean;
  /**
   * 该状态的灯。**给 `null` = 这个状态没有灯**（灭了的火把）；
   * 不写 = 沿用基础块那盏；给对象 = 逐字段盖在基础块上。
   */
  light?: PropLightDef | null;
  /** 该状态的效果（**整体替换**基础块那一串，不是并上去）。空数组 = 这个状态没有效果 */
  vfx?: string[];
}

/** 一条挂件预设。字段全可选：只填 image 也是合法预设（其余走挂点/运行时缺省）。 */
export interface PropPresetDef {
  /** 人类可读名，只给编辑器列表看，运行时不用 */
  label?: string;
  /** 单张贴图（静态挂件） */
  image?: string;
  /** 多帧贴图（第二档：挂点标注的 frame 选第几张）；与 image 并存时 image 排在最前 */
  images?: string[];
  /** 贴图上的支点（0..1，格内归一化）：刀=刀柄、灯笼=提环。缺省图心 0.5/0.5 */
  anchorX?: number;
  anchorY?: number;
  /** 挂件自身旋转偏置（度）：补图片画的时候的朝向。缺省 0 */
  rotation?: number;
  /** 相对角色的大小。缺省 1 */
  scale?: number;
  /** 是否吃角色同一套逐像素光照；自发光的东西（灯笼火苗）给 false。缺省 true */
  lit?: boolean;
  /** 自带光源（缺省没有） */
  light?: PropLightDef;
  /** 自带效果：效果资产 id 列表（缺省没有） */
  vfx?: string[];
  /** 手持物（入档、跨场景自动重挂）。缺省 false = 演出挂件 */
  persistent?: boolean;
  /** 状态表（缺省没有状态，只有一副样子） */
  states?: Record<string, PropStateDef>;
  /** 挂上时的初始状态名；不写而有 `states` 时取第一个键 */
  defaultState?: string;
}

export type PropPresetTable = Record<string, PropPresetDef>;

/** 一次挂载真正要用的值（预设 + 状态 + 覆盖合并后的结果）。 */
export interface ResolvedPropAttach {
  /** 贴图列表；长度 0 表示这次挂载无图可用，调用方应放弃 */
  images: string[];
  anchorX?: number;
  anchorY?: number;
  rotation?: number;
  scale?: number;
  lit?: boolean;
  mirror?: boolean;
  /** 这个状态要不要带灯（null = 不带） */
  light: PropLightDef | null;
  /** 这个状态要放的效果资产 id */
  vfx: string[];
}

function finiteOrUndefined(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const it of v) {
    const s = typeof it === 'string' ? it.trim() : '';
    if (s) out.push(s);
  }
  return out;
}

function parseColor(v: unknown): RgbColor | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const c = [Number(v[0]), Number(v[1]), Number(v[2])];
  if (c.some((n) => !Number.isFinite(n))) return undefined;
  return [c[0], c[1], c[2]];
}

function parseOffset(v: unknown): [number, number, number] | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const o = [Number(v[0]), Number(v[1]), Number(v[2])];
  if (o.some((n) => !Number.isFinite(n))) return undefined;
  return [o[0], o[1], o[2]];
}

/**
 * 解析一盏挂件灯。`intensity` 拿不到正数 ⇒ null（一盏零强度的灯只会白占一个灯槽，
 * 而灯槽是 24 个的硬上限）。
 */
function parsePropLight(raw: unknown): PropLightDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const intensity = finiteOrUndefined(v.intensity);
  if (intensity === undefined || !(intensity > 0)) return null;
  const def: PropLightDef = { intensity };
  const socket = typeof v.socket === 'string' ? v.socket.trim() : '';
  if (socket) def.socket = socket;
  const offset = parseOffset(v.offset);
  if (offset) def.offset = offset;
  const kelvin = finiteOrUndefined(v.kelvin);
  if (kelvin !== undefined) def.kelvin = kelvin;
  const color = parseColor(v.color);
  if (color) def.color = color;
  const range = finiteOrUndefined(v.range);
  if (range !== undefined && range > 0) def.range = range;
  const soft = finiteOrUndefined(v.softeningRadius);
  if (soft !== undefined && soft > 0) def.softeningRadius = soft;
  if (typeof v.castShadow === 'boolean') def.castShadow = v.castShadow;
  const f = v.flicker;
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    const fv = f as Record<string, unknown>;
    const amp = finiteOrUndefined(fv.amp);
    const hz = finiteOrUndefined(fv.hz);
    if (amp !== undefined && hz !== undefined && amp > 0 && hz > 0) {
      def.flicker = { amp, hz };
      const windAmp = finiteOrUndefined(fv.windAmp);
      if (windAmp !== undefined && windAmp > 0) def.flicker.windAmp = windAmp;
    }
  }
  return def;
}

/** 解析一个状态条目。`light: null` 是**有意义的值**（这个状态没有灯），不能与"没写"混。 */
function parsePropState(raw: unknown): PropStateDef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const def: PropStateDef = {};
  const label = typeof v.label === 'string' ? v.label.trim() : '';
  if (label) def.label = label;
  const image = typeof v.image === 'string' ? v.image.trim() : '';
  if (image) def.image = image;
  const images = stringList(v.images);
  if (images.length > 0) def.images = images;
  const ax = finiteOrUndefined(v.anchorX);
  if (ax !== undefined) def.anchorX = clamp01(ax);
  const ay = finiteOrUndefined(v.anchorY);
  if (ay !== undefined) def.anchorY = clamp01(ay);
  const rot = finiteOrUndefined(v.rotation);
  if (rot !== undefined) def.rotation = rot;
  const scale = finiteOrUndefined(v.scale);
  if (scale !== undefined && scale > 0) def.scale = scale;
  if (typeof v.lit === 'boolean') def.lit = v.lit;
  if ('light' in v) def.light = v.light === null ? null : parsePropLight(v.light);
  if ('vfx' in v) def.vfx = stringList(v.vfx);
  return def;
}

/**
 * 解析 prop_presets.json。坏条目**逐条丢弃**而不是整份失败——
 * 一个挂件写错不该让别的挂件全部挂不上（与 sockets.json 的"整份判失效"相反：
 * 那边槽位错位是系统性的、这边条目之间互不相干）。
 */
export function parsePropPresets(raw: unknown): PropPresetTable {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PropPresetTable = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = key.trim();
    if (!id) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const def: PropPresetDef = {};

    const label = typeof v.label === 'string' ? v.label.trim() : '';
    if (label) def.label = label;

    const image = typeof v.image === 'string' ? v.image.trim() : '';
    if (image) def.image = image;

    const images = stringList(v.images);
    if (images.length > 0) def.images = images;

    const ax = finiteOrUndefined(v.anchorX);
    if (ax !== undefined) def.anchorX = clamp01(ax);
    const ay = finiteOrUndefined(v.anchorY);
    if (ay !== undefined) def.anchorY = clamp01(ay);

    const rot = finiteOrUndefined(v.rotation);
    if (rot !== undefined) def.rotation = rot;

    const scale = finiteOrUndefined(v.scale);
    // scale<=0 会让挂件消失且看不出原因，当没填处理
    if (scale !== undefined && scale > 0) def.scale = scale;

    if (typeof v.lit === 'boolean') def.lit = v.lit;

    const light = parsePropLight(v.light);
    if (light) def.light = light;

    const vfx = stringList(v.vfx);
    if (vfx.length > 0) def.vfx = vfx;

    if (v.persistent === true) def.persistent = true;

    if (v.states && typeof v.states === 'object' && !Array.isArray(v.states)) {
      const states: Record<string, PropStateDef> = {};
      for (const [sk, sv] of Object.entries(v.states as Record<string, unknown>)) {
        const name = sk.trim();
        if (!name) continue;
        const st = parsePropState(sv);
        if (st) states[name] = st;
      }
      if (Object.keys(states).length > 0) def.states = states;
    }
    const ds = typeof v.defaultState === 'string' ? v.defaultState.trim() : '';
    if (ds) def.defaultState = ds;

    // 一张图都没有的条目留着也挂不出东西，但**不丢**——编辑器里正在建的半成品
    // 就是这个形状，丢了会让"存了又没了"。运行时那边靠 images.length===0 放弃。
    out[id] = def;
  }
  return out;
}

/** 预设里的贴图列表（image 在前、images 在后，与动作参数同序）。 */
export function propPresetImages(def: PropPresetDef | undefined): string[] {
  if (!def) return [];
  const out: string[] = [];
  if (def.image) out.push(def.image);
  if (def.images) out.push(...def.images);
  return out;
}

/** 状态里的贴图列表（同序）。 */
function propStateImages(st: PropStateDef | undefined): string[] {
  if (!st) return [];
  const out: string[] = [];
  if (st.image) out.push(st.image);
  if (st.images) out.push(...st.images);
  return out;
}

/**
 * 挂上时用哪个状态：显式给的 → `defaultState` → `states` 的第一个键 → 空串（没有状态表）。
 * 给了一个**不存在**的状态名时返回空串——调用方据此报警而不是静默挑一个。
 */
export function resolvePropStateName(def: PropPresetDef | undefined, requested?: string): string {
  if (!def?.states) return '';
  const want = (requested ?? '').trim();
  if (want) return def.states[want] ? want : '';
  const preferred = (def.defaultState ?? '').trim();
  if (preferred && def.states[preferred]) return preferred;
  return Object.keys(def.states)[0] ?? '';
}

/** 逐字段盖：状态里写了的赢，没写的沿用基础块。 */
function mergeLight(base: PropLightDef | undefined, over: PropLightDef): PropLightDef {
  if (!base) return { ...over };
  return {
    ...base,
    ...over,
    flicker: over.flicker ?? base.flicker,
    offset: over.offset ?? base.offset,
    color: over.color ?? base.color,
  };
}

/**
 * 合并预设、状态与本次调用的显式覆盖。
 *
 * 规则：**显式给了就用显式的，其次状态里的，最后预设的**。
 * 贴图整体替换而不是逐项合并——给了 image/images 就是"这次换张图"，
 * 跟预设的图拼起来只会拼出谁也没想要的序列。
 */
export function resolvePropAttach(
  preset: PropPresetDef | undefined,
  override: {
    images?: string[];
    anchorX?: number;
    anchorY?: number;
    rotation?: number;
    scale?: number;
    lit?: boolean;
    mirror?: boolean;
  },
  stateName = '',
): ResolvedPropAttach {
  const st = stateName ? preset?.states?.[stateName] : undefined;
  const ownImages = override.images ?? [];
  const stateImages = propStateImages(st);
  const light = st && 'light' in st
    ? (st.light === null || st.light === undefined ? null : mergeLight(preset?.light, st.light))
    : (preset?.light ?? null);
  return {
    images: ownImages.length > 0
      ? ownImages
      : (stateImages.length > 0 ? stateImages : propPresetImages(preset)),
    anchorX: override.anchorX ?? st?.anchorX ?? preset?.anchorX,
    anchorY: override.anchorY ?? st?.anchorY ?? preset?.anchorY,
    rotation: override.rotation ?? st?.rotation ?? preset?.rotation,
    scale: override.scale ?? st?.scale ?? preset?.scale,
    lit: override.lit ?? st?.lit ?? preset?.lit,
    mirror: override.mirror,
    light,
    vfx: st?.vfx ?? preset?.vfx ?? [],
  };
}
