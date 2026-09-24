/**
 * 燃烧系统的数据（2026-09-16，玩法口径见 `docs/玩法功能需求清单.md` A3.8，机制见 agent_docs [[burn-system]]）。
 *
 * **可燃物是模板，宿主引用它 = 实例化一次**（制作人 2026-09-16 改定，取代"可燃物 = 某场景的某热点 + 布置库"）：
 *
 * | 东西 | 住哪 | 谁写 |
 * |---|---|---|
 * | 可燃物模板 {@link BurnableDef}（图 / 真实尺寸 / 握点 / 燃料 / 着火点 / 烧法 / 粒子 / 火光） | `assets/data/burnables/<id>.json`（id == 文件名），**和场景无关** | 只有燃烧工作台 |
 * | 宿主上的可燃配置 {@link BurnableHostDef}（用哪份模板 / 初始 / 玩家能不能点 / 条件 / 信号） | 宿主自己身上：热点 / NPC（场景 JSON）、挂件预设、轨迹 spawn 规格 | 编辑宿主的地方 |
 * | 粒子薄片绑模板 {@link BurnablePlateBindingDef} | 粒子效果资产 `plate.burnable` | 粒子工作台 |
 * | 运行态（每个实例的燃烧事件 / 快照、烧没了的纸钱） | 存档 `burn` 桶 | `BurnSystem` |
 *
 * 宿主开了可燃 ⇒ **它自己的图 / 动画一律不画，渲染由实例接管**：图与大小取模板（实体自己的缩放 / 旋转 / 朝向照乘）。
 *
 * 本文件只做**形状清洗与缺省**（坏字段当没写、坏条目逐条丢），不做语义校验（那是校验器与工作台保存闸门的事）。
 * 数值一律是作者面的真实单位：长度厘米、速度 cm/s、时间秒、风速 m/s（与挂件吹熄同口径）。
 */

import type { ConditionExpr, RgbColor } from './types';

// ------------------------------------------------------------------ 类型

/** 面燃烧（纸 / 布 / 纸扎）| 消耗燃烧（蜡烛 / 香） */
export type BurnMode = 'spread' | 'consume';

/**
 * 可燃物怎么摆着。决定**浮力**在不在图的平面里：
 * - `upright` 立着：浮力沿图的"上"，往上烧得快（纸扎、挂着的布、立着的香）；
 * - `ground` 平躺：浮力垂直于地面、不在平面里，只有风让它偏（地上的纸钱堆）。
 * 两者的格点世界位置也不同：立着 = 过脚点的直立面（与遮挡模型同一口径）；平躺 = 画面点正下方的地面。
 */
export type BurnOrientation = 'upright' | 'ground';

/** 着火点：图内归一化坐标（u 右、v 下，0..1），与挂件支点同口径 */
export interface BurnIgnitionPointDef {
  id: string;
  u: number;
  v: number;
}

/** 燃料：图的 alpha 以上都是燃料；可选涂层（R 通道 = 燃料量，0 = 不能烧） */
export interface BurnFuelDef {
  /** alpha 阈值 0..1（缺省 {@link BURN_DEFAULTS.alphaThreshold}） */
  alphaThreshold?: number;
  /**
   * 燃料涂层（PNG data URL，R 通道 = 燃料量）。与图同宽高比、任意分辨率（工作台固定存长边 256）。
   * 内联在资产里：一个可燃物一个文件、一个写入者，不另开图片文件。
   */
  maskData?: string;
}

/** 面燃烧的火线速度（cm/s）。平面内气流越顺着这个方向，越接近顺流速度 */
export interface BurnSpreadDef {
  /** 逆流 / 横着烧的速度（cm/s）：立着的纸往下、往两边烧 */
  speedOpposed?: number;
  /** 顺流速度（cm/s）：立着的纸无风时往正上方烧的速度（浮力气流 √(g·火焰长度) 下） */
  speedConcurrent?: number;
}

/** 消耗燃烧 */
export interface BurnConsumeDef {
  /** 从点着到烧完，明火要累计烧多少秒（缺省 {@link BURN_DEFAULTS.consumeSeconds}） */
  seconds?: number;
  /** 从哪头往哪头烧（缺省 top = 从上往下）。`orderData` 优先 */
  from?: 'top' | 'bottom' | 'left' | 'right';
  /** 消耗顺序涂层（PNG data URL，R 通道：黑先白后） */
  orderData?: string;
  /** 火苗在哪一列（图内 u，缺省燃料的横向重心） */
  flameU?: number;
  /** 火苗那一列有多宽（占图宽比例 0..1，缺省 {@link BURN_DEFAULTS.flameWidth}） */
  flameWidth?: number;
}

/** 样子（着色器用）。颜色是线性 0..1 RGB */
export interface BurnLookDef {
  /** 火线前方提前多少秒开始烤黄 */
  scorchSeconds?: number;
  scorchColor?: RgbColor;
  /** 烧过的焦黑 */
  charColor?: RgbColor;
  /** 火线自发光的色温（K）与强度 */
  glowKelvin?: number;
  glowStrength?: number;
  /** 余烬暗红的色温与强度 */
  emberKelvin?: number;
  emberStrength?: number;
  /** 成灰后的颜色与不透明度（0 = 烧没） */
  ashColor?: RgbColor;
  ashAlpha?: number;
  /** 从余烬结束到灰定形要几秒 */
  ashFadeSeconds?: number;
  /** 火线毛边（秒）：每处的点着时刻按噪声前后错开这么多，火线就不是一条光滑的线 */
  edgeNoise?: number;
}

/** 从哪儿发粒子：明火的地方 / 余烬的地方 / 刚成灰的地方（飞灰） */
export type BurnParticleSource = 'flame' | 'ember' | 'ash';

export interface BurnParticleSlotDef {
  /** 粒子效果 id（`assets/data/vfx/<id>.json`，发射形状应为 external） */
  effect: string;
  from: BurnParticleSource;
  /**
   * 参考面积（cm²，缺省 {@link BURN_DEFAULTS.particleRefArea}）：效果里写的发射率是"这么大一块在烧"时的量，
   * 实际发射率 × (正在烧的面积 / 参考面积)。
   */
  refArea?: number;
}

/** 火光：跟着火走的一盏运行时点光 */
export interface BurnLightDef {
  kelvin?: number;
  color?: RgbColor;
  /** 每平方米明火的强度（与场景点光同一把尺）；实际 = 它 × 明火面积 × 闪烁 */
  intensityPerM2: number;
  /** 强度上限（缺省不封） */
  maxIntensity?: number;
  range?: number;
  softeningRadius?: number;
  /** 明火"喘"的相对幅度（缺省 0.1，同火把物理闪烁） */
  puffAmp?: number;
  castShadow?: boolean;
}

/** 消耗燃烧被风吹灭（风速 m/s，与挂件吹熄同口径） */
export interface BurnBlowoutDef {
  windSpeed: number;
  drainSeconds: number;
  recoverSeconds: number;
}

/** 图内归一化点（u 右、v 下，0..1） */
export interface BurnUvPoint {
  u: number;
  v: number;
}

export interface BurnableDef {
  id: string;
  label?: string;
  /** 模板的图：实例接管宿主渲染时画的就是它（燃料 / 着火点都按这张图的归一化坐标存） */
  image: string;
  /**
   * 真实尺寸（厘米，> 0）：图按这个宽高画（1 m = {@link BURN_WU_PER_M} wu），燃烧速度、火焰长度、接触都按它算。
   * 宿主自己的缩放照乘（看到多大就按多大烧）。
   */
  widthCm: number;
  heightCm: number;
  /**
   * 握点：挂到手上（挂件预设开可燃）时挂点对准图上的这一点。缺省底边中点——与摆在地上认的点相同
   * （场景实体一律认图的底边中点，与全引擎的脚底约定一致，不单开一个支点）。
   */
  grip?: BurnUvPoint;
  mode: BurnMode;
  orientation: BurnOrientation;
  /** 模拟网格长边格数（16..160，缺省 96） */
  gridCells?: number;
  fuel?: BurnFuelDef;
  ignitionPoints?: BurnIgnitionPointDef[];
  spread?: BurnSpreadDef;
  consume?: BurnConsumeDef;
  /** 一处明火烧多久（秒）；消耗燃烧 = 火线带的厚度 */
  flameSeconds?: number;
  /** 明火之后余烬暗红多久（秒） */
  emberSeconds?: number;
  /** 火焰长度（cm）：引燃别的东西够得着多远、浮力气流速度、火光中心高度 */
  flameLength?: number;
  /** 被火焰碰到多少秒才着 */
  ignitionDelay?: number;
  /**
   * 雷劈能点着（缺省否）：落雷落点一定半径内、开了这一项的才被雷点着（场景里摆的、手上拿的、粒子薄片绑的都算）。
   * 点着会进存档、烧完永久没了，所以逐个模板由作者开——不开的，雷劈在旁边也不着。
   */
  lightningIgnites?: boolean;
  look?: BurnLookDef;
  particles?: BurnParticleSlotDef[];
  light?: BurnLightDef;
  /** 只对消耗燃烧：会被风吹灭 */
  blowout?: BurnBlowoutDef;
}

/** 状态 */
export type BurnState = 'unburnt' | 'burning' | 'out' | 'burnt';
export const BURN_STATES: readonly BurnState[] = ['unburnt', 'burning', 'out', 'burnt'];

export interface BurnSignalsDef {
  /** 没点 / 灭了 → 在烧 */
  ignited?: string;
  /** → 烧完 */
  burntOut?: string;
  /** 在烧 → 灭了 */
  extinguished?: string;
}

/**
 * 宿主上的可燃配置（`HotspotDef.burnable` / `NpcDef.burnable` / `PropPresetDef.burnable` / `TrajectorySpawnSpec.burnable`）。
 * 有它 ⇒ 这个宿主是模板的一个实例，渲染由实例接管。
 */
export interface BurnableHostDef {
  /** 模板 id（`assets/data/burnables/<id>.json`） */
  template: string;
  /**
   * 实例第一次出现时：没点 / 已经在烧（有着火点按第一个点，没有整体点）。缺省 unburnt。
   * 场景实体 = 第一次进场（或生成出来）那一刻；挂件 = 挂上一支新的（包里没有记着烧到哪的）那一刻。
   */
  initial?: 'unburnt' | 'burning';
  /** 玩家能不能按 E 点它（缺省 true）。只对场景实体（挂件不走按 E 点） */
  playerIgnite?: boolean;
  /** 玩家能点的条件（与实体自己的 conditions 同时满足；缺省无条件）。只对场景实体 */
  igniteConditions?: ConditionExpr[];
  signals?: BurnSignalsDef;
}

/** 粒子薄片绑的可燃模板（`VfxPlateDef.burnable`）：只能绑面燃烧的模板；贴图与大小仍归粒子 */
export interface BurnablePlateBindingDef {
  template: string;
}

// ------------------------------------------------------------------ 缺省

export const BURN_DEFAULTS = {
  gridCells: 96,
  gridCellsMin: 16,
  gridCellsMax: 160,
  alphaThreshold: 0.1,
  speedOpposed: 0.6,
  speedConcurrent: 6,
  consumeSeconds: 600,
  flameWidth: 0.2,
  flameSeconds: 3,
  emberSeconds: 4,
  flameLength: 12,
  ignitionDelay: 0.5,
  particleRefArea: 100,
  lightPuffAmp: 0.1,
  lightRange: 420,
  lightSoftening: 12,
  look: {
    scorchSeconds: 1.5,
    scorchColor: [0.55, 0.38, 0.18] as RgbColor,
    charColor: [0.06, 0.05, 0.045] as RgbColor,
    glowKelvin: 1400,
    glowStrength: 2,
    emberKelvin: 1000,
    emberStrength: 0.9,
    ashColor: [0.42, 0.4, 0.38] as RgbColor,
    ashAlpha: 0.3,
    ashFadeSeconds: 3,
    edgeNoise: 0.8,
  },
} as const;

/** 1 米 = 88 wu（角色高 150 wu 按 1.7 m），与 `acousticSpace.DEFAULT_WU_PER_METER` / 火把火苗同一把尺 */
export const BURN_WU_PER_M = 88;
export const BURN_WU_PER_CM = BURN_WU_PER_M / 100;
/** 重力（m/s²），浮力气流速度 √(g·L) 用 */
export const BURN_G = 9.81;

/** 一份清洗后、缺省填齐的可燃物（模拟与着色器只读这个） */
export interface ResolvedBurnable {
  id: string;
  label: string;
  image: string;
  widthCm: number;
  heightCm: number;
  grip: BurnUvPoint;
  mode: BurnMode;
  orientation: BurnOrientation;
  gridCells: number;
  alphaThreshold: number;
  maskData: string | null;
  ignitionPoints: BurnIgnitionPointDef[];
  speedOpposed: number;
  speedConcurrent: number;
  consumeSeconds: number;
  consumeFrom: 'top' | 'bottom' | 'left' | 'right';
  orderData: string | null;
  flameU: number | null;
  flameWidth: number;
  flameSeconds: number;
  emberSeconds: number;
  flameLengthCm: number;
  ignitionDelay: number;
  /** 雷劈能点着（不进燃烧指纹：开关它不改这件东西怎么烧，不该让存档里的记录作废） */
  lightningIgnites: boolean;
  look: Required<BurnLookDef>;
  particles: Required<BurnParticleSlotDef>[];
  light: BurnLightDef | null;
  blowout: BurnBlowoutDef | null;
}

// ------------------------------------------------------------------ 清洗

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function pos(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
}

function nonNeg(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function color(v: unknown): RgbColor | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const c = [Number(v[0]), Number(v[1]), Number(v[2])];
  if (c.some((n) => !Number.isFinite(n))) return undefined;
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 着火点列表：id 非空且不重复、u/v 有限数夹 0..1；坏条目逐条丢 */
function ignitionPoints(v: unknown): BurnIgnitionPointDef[] {
  if (!Array.isArray(v)) return [];
  const out: BurnIgnitionPointDef[] = [];
  const seen = new Set<string>();
  for (const it of v) {
    const o = obj(it);
    if (!o) continue;
    const id = str(o.id);
    const u = num(o.u);
    const vv = num(o.v);
    if (!id || seen.has(id) || u === undefined || vv === undefined) continue;
    seen.add(id);
    out.push({ id, u: clamp01(u), v: clamp01(vv) });
  }
  return out;
}

function particles(v: unknown): Required<BurnParticleSlotDef>[] {
  if (!Array.isArray(v)) return [];
  const out: Required<BurnParticleSlotDef>[] = [];
  for (const it of v) {
    const o = obj(it);
    if (!o) continue;
    const effect = str(o.effect);
    const from = o.from === 'flame' || o.from === 'ember' || o.from === 'ash' ? o.from : null;
    if (!effect || !from) continue;
    out.push({ effect, from, refArea: pos(o.refArea) ?? BURN_DEFAULTS.particleRefArea });
  }
  return out;
}

function light(v: unknown): BurnLightDef | null {
  const o = obj(v);
  if (!o) return null;
  const intensityPerM2 = pos(o.intensityPerM2);
  if (intensityPerM2 === undefined) return null;
  const def: BurnLightDef = { intensityPerM2 };
  const kelvin = pos(o.kelvin);
  if (kelvin !== undefined) def.kelvin = kelvin;
  const c = color(o.color);
  if (c) def.color = c;
  const maxI = pos(o.maxIntensity);
  if (maxI !== undefined) def.maxIntensity = maxI;
  const range = pos(o.range);
  if (range !== undefined) def.range = range;
  const soft = pos(o.softeningRadius);
  if (soft !== undefined) def.softeningRadius = soft;
  const puff = num(o.puffAmp);
  if (puff !== undefined) def.puffAmp = clamp01(puff);
  if (typeof o.castShadow === 'boolean') def.castShadow = o.castShadow;
  return def;
}

function blowout(v: unknown): BurnBlowoutDef | null {
  const o = obj(v);
  if (!o) return null;
  const windSpeed = pos(o.windSpeed);
  const drainSeconds = pos(o.drainSeconds);
  const recoverSeconds = pos(o.recoverSeconds);
  if (windSpeed === undefined || drainSeconds === undefined || recoverSeconds === undefined) return null;
  return { windSpeed, drainSeconds, recoverSeconds };
}

function look(v: unknown): Required<BurnLookDef> {
  const o = obj(v) ?? {};
  const d = BURN_DEFAULTS.look;
  return {
    scorchSeconds: nonNeg(o.scorchSeconds) ?? d.scorchSeconds,
    scorchColor: color(o.scorchColor) ?? [...d.scorchColor] as RgbColor,
    charColor: color(o.charColor) ?? [...d.charColor] as RgbColor,
    glowKelvin: pos(o.glowKelvin) ?? d.glowKelvin,
    glowStrength: nonNeg(o.glowStrength) ?? d.glowStrength,
    emberKelvin: pos(o.emberKelvin) ?? d.emberKelvin,
    emberStrength: nonNeg(o.emberStrength) ?? d.emberStrength,
    ashColor: color(o.ashColor) ?? [...d.ashColor] as RgbColor,
    ashAlpha: num(o.ashAlpha) !== undefined ? clamp01(num(o.ashAlpha)!) : d.ashAlpha,
    ashFadeSeconds: nonNeg(o.ashFadeSeconds) ?? d.ashFadeSeconds,
    edgeNoise: nonNeg(o.edgeNoise) ?? d.edgeNoise,
  };
}

/** 握点：两项都是有限数才算（夹 0..1），否则缺省底边中点 */
function grip(v: unknown): BurnUvPoint {
  const o = obj(v);
  const u = num(o?.u);
  const vv = num(o?.v);
  if (u === undefined || vv === undefined) return { u: 0.5, v: 1 };
  return { u: clamp01(u), v: clamp01(vv) };
}

/**
 * 清洗一份可燃物模板并填齐缺省。`id` / `image` / 正的真实尺寸缺失 ⇒ null（没法用：画不出来也算不了速度）；
 * mode / orientation 写坏按缺省（spread / upright）。`fileId` 给了就以文件名为准（资产约定 id == 文件名）。
 */
export function resolveBurnable(raw: unknown, fileId?: string): ResolvedBurnable | null {
  const o = obj(raw);
  if (!o) return null;
  const id = fileId?.trim() || str(o.id);
  const image = str(o.image);
  const widthCm = pos(o.widthCm);
  const heightCm = pos(o.heightCm);
  if (!id || !image || widthCm === undefined || heightCm === undefined) return null;
  const fuel = obj(o.fuel) ?? {};
  const spread = obj(o.spread) ?? {};
  const consume = obj(o.consume) ?? {};
  const gridRaw = num(o.gridCells);
  const gridCells = gridRaw === undefined
    ? BURN_DEFAULTS.gridCells
    : Math.min(BURN_DEFAULTS.gridCellsMax, Math.max(BURN_DEFAULTS.gridCellsMin, Math.round(gridRaw)));
  const vo = pos(spread.speedOpposed) ?? BURN_DEFAULTS.speedOpposed;
  // 顺流不许比逆流慢（否则"往上烧得慢"与浮力的物理方向相反）；写反了按逆流算
  const vc = Math.max(vo, pos(spread.speedConcurrent) ?? BURN_DEFAULTS.speedConcurrent);
  const from = consume.from === 'bottom' || consume.from === 'left' || consume.from === 'right' ? consume.from : 'top';
  const flameU = num(consume.flameU);
  const mask = str(fuel.maskData);
  const order = str(consume.orderData);
  return {
    id,
    label: str(o.label) || id,
    image,
    widthCm,
    heightCm,
    grip: grip(o.grip),
    mode: o.mode === 'consume' ? 'consume' : 'spread',
    orientation: o.orientation === 'ground' ? 'ground' : 'upright',
    gridCells,
    alphaThreshold: num(fuel.alphaThreshold) !== undefined ? clamp01(num(fuel.alphaThreshold)!) : BURN_DEFAULTS.alphaThreshold,
    maskData: mask.startsWith('data:image/') ? mask : null,
    ignitionPoints: ignitionPoints(o.ignitionPoints),
    speedOpposed: vo,
    speedConcurrent: vc,
    consumeSeconds: pos(consume.seconds) ?? BURN_DEFAULTS.consumeSeconds,
    consumeFrom: from,
    orderData: order.startsWith('data:image/') ? order : null,
    flameU: flameU === undefined ? null : clamp01(flameU),
    flameWidth: num(consume.flameWidth) !== undefined ? Math.max(0.01, clamp01(num(consume.flameWidth)!)) : BURN_DEFAULTS.flameWidth,
    flameSeconds: pos(o.flameSeconds) ?? BURN_DEFAULTS.flameSeconds,
    emberSeconds: nonNeg(o.emberSeconds) ?? BURN_DEFAULTS.emberSeconds,
    flameLengthCm: pos(o.flameLength) ?? BURN_DEFAULTS.flameLength,
    ignitionDelay: nonNeg(o.ignitionDelay) ?? BURN_DEFAULTS.ignitionDelay,
    lightningIgnites: o.lightningIgnites === true,
    look: look(o.look),
    particles: particles(o.particles),
    light: light(o.light),
    blowout: o.mode === 'consume' ? blowout(o.blowout) : null,
  };
}

function signals(v: unknown): BurnSignalsDef | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const out: BurnSignalsDef = {};
  for (const k of ['ignited', 'burntOut', 'extinguished'] as const) {
    const s = str(o[k]);
    if (s) out[k] = s;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 清洗宿主上的可燃配置；不是对象 / `template` 缺失 ⇒ null（这个宿主不可燃） */
export function resolveBurnableHost(raw: unknown): BurnableHostDef | null {
  const o = obj(raw);
  if (!o) return null;
  const template = str(o.template);
  if (!template) return null;
  const def: BurnableHostDef = { template };
  if (o.initial === 'burning') def.initial = 'burning';
  if (o.playerIgnite === false) def.playerIgnite = false;
  if (Array.isArray(o.igniteConditions) && o.igniteConditions.length > 0) {
    def.igniteConditions = o.igniteConditions as ConditionExpr[];
  }
  const sig = signals(o.signals);
  if (sig) def.signals = sig;
  return def;
}

/** 模板的画面尺寸（wu，未乘宿主缩放） */
export function burnableWorldSize(b: Pick<ResolvedBurnable, 'widthCm' | 'heightCm'>): { width: number; height: number } {
  return { width: b.widthCm * BURN_WU_PER_CM, height: b.heightCm * BURN_WU_PER_CM };
}

export function isBurnState(v: unknown): v is BurnState {
  return v === 'unburnt' || v === 'burning' || v === 'out' || v === 'burnt';
}
