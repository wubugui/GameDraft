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
 * - `particles`：**粒子挂载**（2026-09-15 起取代旧 `vfx`）：每条 = 一个粒子效果 + 贴图上的一个挂点。
 *   火焰的**声音住在效果资产自己的 `sound.loop`** 里（那条本来就从发射器原点空间播、跟着锚点走），
 *   本表**不开音频字段**——开了就是第二个真相源。
 * - `states`：状态表。每个状态覆盖上面这些块（贴图 / 灯 / 效果）；
 *   动作 `setPropState` 只切状态名，连续量（渐变、闪烁）由运行时算。
 * - `persistent`：`true` = 手持物（玩法事实，入档、跨场景自动重挂）；
 *   缺省 false = 演出挂件（切场景即散，与既有行为一致）。
 *
 * ## 燃烧物 + 粒子挂载 + 帧动画火苗（2026-09-15 制作人定）
 *
 * 一件挂件 = 一张**静态燃烧物贴图**（火把 / 篾条 / 别的燃烧物，换图即换）+ 挂在它身上的**粒子**
 * + 可选的**帧动画火苗** + **程序化燃烧状态**。火把本身只用粒子；帧动画火苗是保留的能力：
 *
 * - `firePoint`：**起火点**（贴图内归一化）。灯位、没写挂点的粒子挂载、帧动画火苗底部都从这一点出；
 *   不写 = 从挂点本身出（与改造前逐位相同——老灯笼就是这样）。
 * - `particles`：粒子挂载 `[{effect, point?}]`。`point` 是贴图上的点（杆头、杆腰都行），跟着挂件的
 *   支点 / 自转 / 缩放 / 镜像走；不写 = 起火点。状态的列表**整体替换**基础块那一串。
 * - `flame`：帧动画火苗（帧动画图集 + 满火高度），大小 / 倾斜 / 明灭程序化。
 * - `burn`：燃烧强度 0..1。帧动画火苗的高度，以及该状态**所有粒子挂载**的发射率（× 闪烁）与新生粒子大小；
 *   状态可覆盖，`setPropState` 的 `fadeMs` 同时渐变它与灯。
 * - `windShelter`：挡风比例 0..1（护火）：帧动画火苗倾斜吃的气流、粒子挂载吃的场景风都乘 `1 − 它`；不影响灯。
 * - 状态的 `onEnterActions`：**进入**该状态时执行的动作（读档 / 切场景的自动重挂不算进入）。
 */

import type { ActionDef, RgbColor } from './types';
import { resolveBurnableHost, type BurnableHostDef } from './burnables';

/**
 * 火焰闪烁。运行时产出一个标量 `L(t)`（见 `systems/heldProp/heldPropSignal.ts`），同时驱动灯的强度与火的大小
 * —— **一个信号**，否则会出现"灯在闪、火苗不动"的穿帮。两种写法：
 *
 * - **物理闪烁**（`kind` = `flame` 明火 / `ember` 炭火，2026-09-15 起火把用这个）：作者只填燃烧面直径，
 *   频率与对风的反应都由直径与火把处的相对气流推出来，见 {@link PropFlickerPhysicalDef}；
 * - **正弦闪烁**（不写 `kind`，灯笼用的老写法）：作者填相对波动幅度与频率，见 {@link PropFlickerSineDef}。
 */
export type PropFlickerDef = PropFlickerSineDef | PropFlickerPhysicalDef;

/** 正弦闪烁（老写法，灯笼的调光按它逐项调过，数值不许变） */
export interface PropFlickerSineDef {
  kind?: undefined;
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
 * 物理闪烁：频率与对风的反应从燃烧面直径与**火把处的相对气流**（场景风 − 人走动，护火挡掉 windShelter 那部分）推出。
 *
 * - `flame` 明火：
 *   ① 自己"喘"：浮力不稳定，频率 `f = 1.5/√D`（D 米，Cetegen & Ahmed 1993）；慢慢长大、一下塌掉的锯齿；
 *      风速压过火自身的浮力速度 `√(gD)` 就喘不起来：喘的幅度 × `1/(1 + u²/(gD))`；
 *   ② 风把火吹短：火焰长度 ∝ u^−0.21（Thomas 1963 横风火焰），亮度跟着阵风起落——节奏是风的，不是火的。
 *      以无风为基准（`u` 取 `√(u_风² + gD)`）：作者填的强度是无风时的亮度，风大火暗，护火挡风就亮回来。
 * - `ember` 炭火：不喘；风吹得炭火更亮——氧气供给按强制对流传质（Ranz–Marshall `Sh = 2 + 0.6 Re^½ Sc^⅓`）走，同样以无风为基准。
 */
export interface PropFlickerPhysicalDef {
  kind: 'flame' | 'ember';
  /** 燃烧面直径（米）：火把头、炭堆的直径。10 cm 的火把头 ⇒ 喘 ≈ 4.7 Hz */
  diameter: number;
  /** 明火"喘"在光输出上的相对幅度（半峰，0..1）；缺省 0.1。炭火不读 */
  puffAmp?: number;
}

/**
 * 挂件自带的光源。字段语义与 `LightDef` 同名项相同，强度统一由 packLights 换算。
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
  /** 该状态的粒子挂载（**整体替换**基础块那一串，不是并上去）。空数组 = 这个状态没有粒子 */
  particles?: PropParticleMount[];
  /** 该状态的起火点（状态换了图，起火点可能跟着挪）。不写 = 沿用基础块 */
  firePoint?: [number, number];
  /** 该状态的燃烧强度 0..1（帧动画火苗高度、粒子挂载的发射率与新生大小）。不写 = 沿用基础块（基础块也没写 = 1） */
  burn?: number;
  /** 该状态的挡风比例 0..1（护火：身子挡掉火苗处多少气流）。不写 = 沿用基础块（基础块也没写 = 0） */
  windShelter?: number;
  /**
   * 进入这个状态时执行的动作。**只在真的进入时**：`setPropState` 切过来、`attachToSocket` 动作挂上时
   * 的初始状态；读档重挂与切场景自动重挂**不执行**（那是派生表现，不是进入）。
   */
  onEnterActions?: ActionDef[];
  /**
   * 这个状态吹不吹得灭。**给 `null` = 这个状态风吹不灭**；不写 = 沿用基础块；给对象 = 整块替换基础块那份。
   */
  blowout?: PropBlowoutDef | null;
  /**
   * 这个状态能不能点别的东西。**给 `null` = 这个状态点不了**；不写 = 沿用基础块；给对象 = 整块替换基础块那份。
   */
  igniter?: PropIgniterDef | null;
}

/**
 * 能点燃别的东西（2026-09-16，燃烧系统 A3.8）。挂件预设写了这一块、并且**此刻燃着**（当前状态有灯），
 * 玩家就能拿它去点可燃物（地图上点火表演），燃着的火头也会引燃碰到的可燃粒子（纸钱）。
 */
export interface PropIgniterDef {
  /**
   * 火头那团火的长度（厘米，缺省 {@link PROP_IGNITER_DEFAULT_FLAME_CM}）：从起火点沿火焰轴伸出去多远算"碰到"。
   * 只管引燃判定，不管火苗画多大（那是粒子的事）。
   */
  flameLength?: number;
}

export const PROP_IGNITER_DEFAULT_FLAME_CM = 20;

/**
 * 耐久 = 燃料时长（玩法清单 A3.7「火把养成」，2026-09-16 制作人拍板）。
 *
 * **只在基础块**（耐久是这根火把的事，不是某个状态的事）。不写 = 没有耐久，点着就一直烧得下去
 * （随身那根旧纤藤就是这样）；写了 = 临时火把，烧完就没。
 *
 * - 只有**燃着**（当前状态有灯）的时候在烧；残炭按 {@link PROP_FUEL_EMBER_RATE} 慢慢烧；
 * - **风大烧得快**：每秒烧掉 `1 + windFactor × u`（`u` = 火把头**挡过风之后**的气流 m/s）。
 *   护火挡掉大部分风 ⇒ 每秒确实省燃料，代价是**护着火只能走不能跑**（`playerControl.guardBlocksRun`），
 *   同样一段路要多花时间，一段路烧掉的燃料并没省（制作人 2026-09-16 定的「乙案」）；
 * - 烧到 {@link PROP_FUEL_LOW_FRACTION} 以下：火苗与灯按剩下的比例变小变暗，火边的符号装的就是剩下的燃料；
 * - 烧完：切到 `outState`（与风吹灭同一条路，不算"点火"），再执行 `onSpentActions`
 *   （临时火把在这里把自己从背包里去掉、从手上卸下）。
 */
export interface PropFuelDef {
  /** 满燃料能烧多久（秒，> 0） */
  seconds: number;
  /** 风里烧得快多少：每秒倍率 = 1 + windFactor × 气流(m/s)；缺省 {@link PROP_FUEL_WIND_FACTOR} */
  windFactor?: number;
  /** 烧完切到哪个状态；缺省跟 `blowout.outState`，再缺省 `out` */
  outState?: string;
  /**
   * 烧完之后执行（切完状态才跑）。顶层 `playPropVfx` 不写 target / socket = 这件挂件自己。
   * ⚠ **别在这里写 `detachFromSocket`**：烧完这一下要冒的那口烟是挂在这件挂件上的一次性效果，
   * 同帧卸下会把它当场掐掉（2026-09-16 真跑抓到）。手上那根由系统在烟散完之后自己拿掉，
   * 见 {@link PropFuelDef.keepInHandWhenSpent}；这里只写"包里那一根没了"这类事（`removeItem`）。
   */
  onSpentActions?: ActionDef[];
  /**
   * 烧完之后**留在手上**（缺省 false = 烟散完系统自己把它从手上拿掉）。
   * 想让玩家自己收起烧完的杆子、或者剧情要那根焦木头的，写 true。
   */
  keepInHandWhenSpent?: boolean;
}

/**
 * 效果块（玩法清单 A3.7「火把养成」的"效果自由组合"，2026-09-16 制作人拍板）。
 *
 * 临时火把**比脾气不比数值**：一支火把 = 一份基础燃烧配置 + **至多两块**效果
 * （{@link PROP_EFFECTS_MAX}，多了组合爆炸、玩家也读不懂）。效果块住在
 * `prop_effects.json`（作者面在挂件预设编辑器里挑），挂件预设只写 id。
 *
 * 合成规矩（制作人定）：**数值类相乘**（几块都写了就连乘）、**行为类并集**（`fields` 与 `tags` 直接并起来）。
 * 数值全是**倍率**，1 = 不改；写在这里的名字与被乘的那个参数同名，免得作者猜"这个数是乘谁的"。
 */
export interface PropEffectDef {
  id: string;
  /** 作者面显示的名字 */
  label: string;
  /** 作者备注（不是玩家文案） */
  note?: string;
  /** 灯的倍率：亮度、照多远 */
  light?: { intensity?: number; range?: number };
  /** 燃烧强度倍率（火苗多旺） */
  burn?: number;
  /** 燃料烧得快多少（倍率；1.5 = 快一半） */
  fuelRate?: number;
  /** 抗风倍率：吹熄风速、掉多快（秒数，越大越耐）、回多快（秒数，越小越快）、残炭线 */
  wind?: { windSpeed?: number; drainSeconds?: number; recoverSeconds?: number; emberBelow?: number };
  /** 火头火焰长度倍率（点得着多远的东西） */
  igniterFlame?: number;
  /**
   * 对世界的影响：**燃着的时候**在火头处放的场。粒子群体按 `tag` 的权重反应——
   * `fear` = 驱（虫子躲开）、`attract` = 招（东西围过来）。半径 wu、强度与场景里的 `emitVfxField` 同口径。
   */
  fields?: { kind: 'fear' | 'attract'; tag: string; radius: number; strength: number }[];
  /** 内容侧能问的标签（`heldProp` 条件叶的 `effect`：写 id 或写这里的标签都能命中） */
  tags?: string[];
}

/**
 * 升级（玩法清单 A3.7「火把养成」，2026-09-16）：**随身那根**火把的等级。一级 = 一套外观 + 一串效果块
 * （升级给的是"稳和好用"，那些倍率就写在效果块里，与临时火把共用一套东西）。
 *
 * 第 1 级是它本来的样子（不写 `effects` 就是原样）。等级住在存档里（`HeldPropSystem`，按挂件 id 记），
 * 拿在手上还是收在包里都算数；内容侧用 `propLevel` 条件叶问。
 */
export interface PropLevelDef {
  /** 作者面与描述里显示的名字（「裹布浸桐油」） */
  label: string;
  /**
   * 这一级的贴图（不写 = 沿用基础块那张）。状态自己写了图的仍以状态为准；
   * ⚠ 基础块用 `images` 多张（挂点驱动帧号）时，这里给一张 = 这一级换成单张，多帧就没了
   */
  image?: string;
  /** 这一级挂的效果块 id（至多 {@link PROP_EFFECTS_MAX} 块，与预设自己的 `effects` 合起来算） */
  effects?: string[];
  /** 作者备注 */
  note?: string;
}

/** 一支火把最多挂几块效果 */
export const PROP_EFFECTS_MAX = 2;

export type PropEffectTable = Record<string, PropEffectDef>;

/** 效果块库（`prop_effects.json`）：`{ id: {...} }`；坏条目跳过不炸 */
export function parsePropEffects(raw: unknown): PropEffectTable {
  const out: PropEffectTable = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = id.trim();
    if (!key || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const def: PropEffectDef = { id: key, label: typeof e.label === 'string' && e.label.trim() ? e.label.trim() : key };
    if (typeof e.note === 'string' && e.note.trim()) def.note = e.note.trim();
    const light = scaleBlock(e.light, ['intensity', 'range']);
    if (light) def.light = light;
    const burn = positiveScale(e.burn);
    if (burn !== undefined) def.burn = burn;
    const fuelRate = positiveScale(e.fuelRate);
    if (fuelRate !== undefined) def.fuelRate = fuelRate;
    const wind = scaleBlock(e.wind, ['windSpeed', 'drainSeconds', 'recoverSeconds', 'emberBelow']);
    if (wind) def.wind = wind;
    const ig = positiveScale(e.igniterFlame);
    if (ig !== undefined) def.igniterFlame = ig;
    const fields = parseEffectFields(e.fields);
    if (fields.length > 0) def.fields = fields;
    const tags = stringList(e.tags);
    if (tags.length > 0) def.tags = tags;
    out[key] = def;
  }
  return out;
}

/** 倍率：有限正数才算（0 与负数是"把这个参数按死"，不是作者想要的合成语义） */
function positiveScale(v: unknown): number | undefined {
  const n = finiteOrUndefined(v);
  return n !== undefined && n > 0 ? n : undefined;
}

function scaleBlock<K extends string>(v: unknown, keys: readonly K[]): Partial<Record<K, number>> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const src = v as Record<string, unknown>;
  const out: Partial<Record<K, number>> = {};
  let any = false;
  for (const k of keys) {
    const n = positiveScale(src[k]);
    if (n !== undefined) { out[k] = n; any = true; }
  }
  return any ? out : undefined;
}

function parseEffectFields(v: unknown): NonNullable<PropEffectDef['fields']> {
  if (!Array.isArray(v)) return [];
  const out: NonNullable<PropEffectDef['fields']> = [];
  for (const it of v) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const f = it as Record<string, unknown>;
    const kind = f.kind === 'attract' ? 'attract' : f.kind === 'fear' ? 'fear' : null;
    const tag = typeof f.tag === 'string' ? f.tag.trim() : '';
    const radius = finiteOrUndefined(f.radius);
    const strength = finiteOrUndefined(f.strength);
    if (!kind || !tag || !(radius !== undefined && radius > 0) || !(strength !== undefined && strength > 0)) continue;
    out.push({ kind, tag, radius, strength });
  }
  return out;
}

/**
 * 把效果块的倍率乘进这一次挂载解出来的值（数值类相乘）。行为类（`fields` / `tags`）不在这里——
 * 那是逐帧的事，见 `HeldPropSystem`。纯函数：同一份输入永远同一份输出（工作台与游戏共用）。
 */
export function applyPropEffects(resolved: ResolvedPropAttach, effects: readonly PropEffectDef[]): ResolvedPropAttach {
  if (effects.length === 0) return resolved;
  const mul = (base: number | undefined, pick: (e: PropEffectDef) => number | undefined): number | undefined => {
    if (base === undefined) return undefined;
    let k = 1;
    for (const e of effects) k *= pick(e) ?? 1;
    return k === 1 ? base : base * k;
  };
  const out: ResolvedPropAttach = { ...resolved };
  out.burn = mul(resolved.burn, (e) => e.burn)!;
  if (resolved.light) {
    out.light = {
      ...resolved.light,
      intensity: mul(resolved.light.intensity, (e) => e.light?.intensity)!,
      ...(resolved.light.range !== undefined ? { range: mul(resolved.light.range, (e) => e.light?.range)! } : {}),
    };
  }
  if (resolved.blowout) {
    out.blowout = {
      ...resolved.blowout,
      windSpeed: mul(resolved.blowout.windSpeed, (e) => e.wind?.windSpeed)!,
      drainSeconds: mul(resolved.blowout.drainSeconds, (e) => e.wind?.drainSeconds)!,
      recoverSeconds: mul(resolved.blowout.recoverSeconds, (e) => e.wind?.recoverSeconds)!,
      ...(resolved.blowout.emberBelow !== undefined
        ? { emberBelow: clamp01(mul(resolved.blowout.emberBelow, (e) => e.wind?.emberBelow)!) }
        : {}),
    };
  }
  if (resolved.igniter) {
    const len = mul(resolved.igniter.flameLength ?? PROP_IGNITER_DEFAULT_FLAME_CM, (e) => e.igniterFlame);
    out.igniter = { ...resolved.igniter, flameLength: len };
  }
  return out;
}

/** 燃料这一刻烧得多快的效果倍率（数值类相乘） */
export function propEffectFuelRate(effects: readonly PropEffectDef[]): number {
  let k = 1;
  for (const e of effects) k *= e.fuelRate ?? 1;
  return k;
}

/** 残炭里燃料烧得慢（炭火比明火省）：每秒按这个比例扣 */
export const PROP_FUEL_EMBER_RATE = 0.3;
/** 燃料没写 `windFactor` 时的缺省：10 m/s 的风里烧得快一倍 */
export const PROP_FUEL_WIND_FACTOR = 0.1;
/**
 * 「快烧完了」那一段有多长：满燃料的这么大比例，**但最多** {@link PROP_FUEL_LOW_MAX_SECONDS} 秒。
 * 这一段里火苗与灯按剩下的比例收小、火边出符号。烧四分钟的火把不该最后五十秒都在打蔫。
 */
export const PROP_FUEL_LOW_FRACTION = 0.2;
export const PROP_FUEL_LOW_MAX_SECONDS = 15;

/** 「快烧完了」那一段有多少秒（满燃料 `seconds` 的火把） */
export function propFuelLowSeconds(seconds: number): number {
  return Math.min(seconds * PROP_FUEL_LOW_FRACTION, PROP_FUEL_LOW_MAX_SECONDS);
}

/**
 * 风吹灭火（2026-09-15 制作人定"风能把火吹灭"，控制权在策划手里）。
 *
 * 挂着的火把有一个**火势** `v`（0..1，挂上 / 从残炭或灭被动作点着时 = 1）。每帧取火把处的相对气流 `u`
 * （场景风 − 人走动，× (1 − 挡风)；与火苗倾斜、物理闪烁同一份）：
 * - `u > windSpeed` ⇒ 火势掉：每秒 `(u − windSpeed) / windSpeed / drainSeconds`（风是吹熄风速两倍时 `drainSeconds` 秒从满到底）；
 * - `u ≤ windSpeed` ⇒ 火势回：每秒 `(1 − u / windSpeed) / recoverSeconds`（无风时 `recoverSeconds` 秒从底回满）。
 * 火势乘在燃烧强度（火苗大小 / 发射量）与灯的强度上——"眼看火要灭"是看得见的。
 *
 * 越线：
 * - 掉过 `emberBelow` ⇒ （`auto` 时）切到 `emberState`，再执行 `onEmberActions`；
 * - 在残炭里火势回到 `emberBelow` 上方一截（挡住了风：护火 / 风停）⇒ （`auto` 时）回到 `recoverState`——炭里还有热，挡住风就复燃
 *   （制作人 2026-09-15："用挡风挡一下就回来了"，不另设吹火操作）；
 * - 掉到 0 ⇒ （`auto` 时）切到 `outState`，再执行 `onOutActions`。**灭了物理不会再点着**，点火只能靠火种 / 动作。
 * `auto: false` = 只执行动作、不切状态（切不切、走什么分支交给叙事状态机：动作里发信号）。
 * 已经在 `outState` 里就不再算。`lockPropState` 锁定不灭（`lit`）期间火势只回不掉。`setPropState` 永远优先。
 */
export interface PropBlowoutDef {
  /** 吹熄风速（m/s，火把处气流，已算挡风）。超过它火势就往下掉 */
  windSpeed: number;
  /** 气流是吹熄风速两倍时，火势从满掉到底要几秒 */
  drainSeconds: number;
  /** 无风时，火势从底回满要几秒 */
  recoverSeconds: number;
  /** 残炭线 0..1；不写 = 没有残炭这一步，掉到底直接灭 */
  emberBelow?: number;
  /** 残炭线切到哪个状态；缺省 `ember` */
  emberState?: string;
  /** 火势到底切到哪个状态；缺省 `out` */
  outState?: string;
  /** 残炭里挡住风、火势回到残炭线上方时复燃回哪个状态；缺省 `lit` */
  recoverState?: string;
  /** 越线时自动切状态；缺省 true。false = 只执行动作 */
  auto?: boolean;
  /** 自动切状态用的渐变（毫秒，灯强度与燃烧强度同钟）；缺省 500 */
  fadeMs?: number;
  /** 掉过残炭线时执行（在自动切状态之后）。顶层 `playPropVfx` 不写 target / socket = 这件挂件 */
  onEmberActions?: ActionDef[];
  /** 火势到底时执行（在自动切状态之后） */
  onOutActions?: ActionDef[];
}

export const PROP_BLOWOUT_DEFAULT_FADE_MS = 500;

/**
 * 粒子挂载：一个粒子效果挂在挂件贴图上的一个点。
 * `point` 为 null = 没写 ⇒ 落到起火点，再没有 ⇒ 挂点本身。
 */
export interface PropParticleMount {
  /** 效果资产 id（`assets/data/vfx/<id>.json`） */
  effect: string;
  /** 贴图上的挂点（归一化 0..1，同支点口径）；null = 起火点 / 挂点本身 */
  point: [number, number] | null;
}

/**
 * 帧动画火苗：一张帧动画图集（行优先排）+ 满火时的高度。
 *
 * 格尺寸由贴图推（`cellW = 宽 / cols`，`rows = ceil(frames / cols)`，`cellH = 高 / rows`），
 * 不在数据里再写一遍像素——写了就是第二个真相源，换一张图集必然对不上。
 */
export interface PropFlameDef {
  /** 图集 URL */
  image: string;
  /** 列数（≥1） */
  cols: number;
  /** 帧数（≥1） */
  frames: number;
  /** 帧率 */
  fps: number;
  /**
   * **满火（burn = 1）时一格帧的高度，单位 wu**（透视系数 1 处；角色高约 150 wu）。
   * 与挂件 `scale` 无关：换一根粗一号的火把杆，火苗不会跟着放大。
   */
  height: number;
}

/** 帧动画火苗的缺省帧率 */
export const PROP_FLAME_DEFAULT_FPS = 24;

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
  /** 粒子挂载（缺省没有） */
  particles?: PropParticleMount[];
  /** 手持物（入档、跨场景自动重挂）。缺省 false = 演出挂件 */
  persistent?: boolean;
  /** 状态表（缺省没有状态，只有一副样子） */
  states?: Record<string, PropStateDef>;
  /** 挂上时的初始状态名；不写而有 `states` 时取第一个键 */
  defaultState?: string;
  /** 起火点（贴图内归一化 0..1）。不写 = 灯与粒子从挂点本身出 */
  firePoint?: [number, number];
  /** 帧动画火苗（缺省没有） */
  flame?: PropFlameDef;
  /** 燃烧强度 0..1（缺省 1） */
  burn?: number;
  /**
   * 挡风比例 0..1（缺省 0）：帧动画火苗倾斜吃的气流、粒子挂载吃的场景风都乘 `1 − windShelter`。
   * **护火**就是它——侧身、拿手拢着，火苗吃到的风少了、立起来了。正弦闪烁的灯（灯笼）不吃它；物理闪烁的灯与吹灭都吃它。
   */
  windShelter?: number;
  /** 风吹灭火（缺省没有 = 永远吹不灭，灯笼、演出道具火） */
  blowout?: PropBlowoutDef;
  /** 玩家能用按键操作这件挂件（点火 / 熄灭、按住护火）。缺省没有 = 玩家不能操作。只在基础块 */
  playerControl?: PropPlayerControlDef;
  /** 能点燃别的东西（缺省没有 = 点不了）。状态可覆盖，见 {@link PropStateDef.igniter} */
  igniter?: PropIgniterDef;
  /** 耐久（燃料时长，只在基础块）。缺省没有 = 烧不完（随身那根火把） */
  fuel?: PropFuelDef;
  /**
   * 挂在这根火把上的效果块 id（`prop_effects.json`），至多 {@link PROP_EFFECTS_MAX} 块；
   * 多写的运行时只认前两块（校验器报错）。只在基础块——效果是这根火把的脾气，不随状态变
   */
  effects?: string[];
  /**
   * 等级表（随身那根火把的升级；第 1 项 = 出厂的样子）。不写 = 这根不能升级。
   * 等级本身进存档（按挂件 id 记），换外观 + 叠效果块，见 {@link PropLevelDef}
   */
  levels?: PropLevelDef[];
  /**
   * 可燃（A3.8）：这件挂件是可燃物模板的一个实例（香、蜡烛）。有它 ⇒ 挂件自己的图 / 状态图 / 灯 / 粒子 / 帧动画火苗 / 起火点
   * 一律不画，渲染由实例接管：图取模板、按模板真实尺寸画、挂点对准模板的握点（`scale` / `rotation` 照乘）；
   * 燃着就算"手上有火"（能按 E 点可燃实体、会引燃纸钱）。与火把那一套（`states` 的外观、`light`、`playerControl`、
   * `blowout`、`igniter`、`fuel`）互斥，校验器拦。`playerIgnite` / `igniteConditions` 对挂件不读。
   */
  burnable?: BurnableHostDef;
}

/**
 * 玩家按键操作挂着的火（2026-09-15 制作人定）：`T` 燃着（点着 / 护火 / 残炭）时熄灭、灭了时点火；按住 `Q` 护火、松开回点着
 * （残炭里按住 `Q` 不切状态，只挡风——挡住了火势回得来就复燃）。
 * 按键受锁（`lockPropState`）：`lit` 熄不了、`unlit` 点不着；`setPropState` 不受锁。键位常量见 `HeldPropSystem`。
 */
export interface PropPlayerControlDef {
  /** 点着的状态；缺省 `lit` */
  litState?: string;
  /** 护火的状态；缺省 `guarding` */
  guardState?: string;
  /** 熄灭切到的状态；缺省 `out` */
  outState?: string;
  /** 熄灭渐变（毫秒）；缺省 400 */
  extinguishFadeMs?: number;
  /** 点火渐变（毫秒）；缺省 250 */
  igniteFadeMs?: number;
  /**
   * 火势掉到这条线以下，火边出「快灭了」的符号（残炭时一直出）；缺省 0.8，0 = 不提示。
   * 锁定不灭、灭了、演出 / 对话里不出。
   */
  hintBelow?: number;
  /**
   * 护着火的时候只能走不能跑；缺省 true（制作人 2026-09-16：侧身把火拢住还撒腿狂奔不像话，
   * 而且这是护火省燃料的代价——不然一路按着护火键最划算）。
   */
  guardBlocksRun?: boolean;
}

export const PROP_CONTROL_DEFAULTS = {
  litState: 'lit',
  guardState: 'guarding',
  outState: 'out',
  extinguishFadeMs: 400,
  igniteFadeMs: 250,
  hintBelow: 0.8,
  guardBlocksRun: true,
} as const;

/** `lockPropState` 的锁：`lit` 锁定不灭（风压不掉火势、玩家熄不了）/ `unlit` 点不燃（玩家点不着）/ `none` 解锁 */
export type PropLockMode = 'lit' | 'unlit' | 'none';

export function parsePropLockMode(v: unknown): PropLockMode | null {
  return v === 'lit' || v === 'unlit' || v === 'none' ? v : null;
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
  /** 这个状态的粒子挂载（状态 → 基础块 → 空） */
  particles: PropParticleMount[];
  /** 起火点（状态 → 基础块）；null = 从挂点本身出 */
  firePoint: [number, number] | null;
  /** 燃烧强度（状态 → 基础块 → 1） */
  burn: number;
  /** 挡风比例（状态 → 基础块 → 0） */
  windShelter: number;
  /** 帧动画火苗（只在基础块）；null = 没有 */
  flame: PropFlameDef | null;
  /** 进入这个状态时执行的动作（只在状态里有；没有状态 / 没写 = 空） */
  onEnterActions: ActionDef[];
  /** 这个状态吹不吹得灭（状态 → 基础块；状态写 null 或都没写 = null，吹不灭） */
  blowout: PropBlowoutDef | null;
  /** 这个状态能不能点别的东西（状态 → 基础块；状态写 null 或都没写 = null，点不了） */
  igniter: PropIgniterDef | null;
  /**
   * 可燃（A3.8）：这件挂件是可燃物模板的实例。有它 ⇒ `images` 为空、灯 / 粒子 / 火苗 / 起火点 / 吹熄 / 点火能力全空，
   * 贴图、支点（模板握点）、大小（模板真实尺寸 × `scale`）由组装层按模板挂；燃烧由燃烧系统管。
   */
  burnable?: BurnableHostDef;
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
  if (f && typeof f === 'object' && !Array.isArray(f) && ((f as Record<string, unknown>).kind === 'flame' || (f as Record<string, unknown>).kind === 'ember')) {
    // 物理闪烁：直径必须是 > 0 的有限数，否则整块丢（不闪，与老写法缺量同一个口径）；puffAmp 夹 0..1、非数当没写
    const fv = f as Record<string, unknown>;
    const diameter = finiteOrUndefined(fv.diameter);
    if (diameter !== undefined && diameter > 0) {
      const phys: PropFlickerPhysicalDef = { kind: fv.kind as 'flame' | 'ember', diameter };
      const puff = finiteOrUndefined(fv.puffAmp);
      if (phys.kind === 'flame' && puff !== undefined) phys.puffAmp = Math.min(1, Math.max(0, puff));
      def.flicker = phys;
    }
  } else if (f && typeof f === 'object' && !Array.isArray(f)) {
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

/** 起火点：长度 ≥2 且前两项是有限数 ⇒ 各自夹到 0..1（同支点口径）；否则当没写 */
function parseFirePoint(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length < 2) return undefined;
  const x = finiteOrUndefined(v[0]);
  const y = finiteOrUndefined(v[1]);
  if (x === undefined || y === undefined) return undefined;
  return [clamp01(x), clamp01(y)];
}

/** 燃烧强度：有限数 ⇒ 夹到 0..1；否则当没写 */
function parseBurn(v: unknown): number | undefined {
  const n = finiteOrUndefined(v);
  return n === undefined ? undefined : clamp01(n);
}

/**
 * 帧动画火苗块。没有图或满火高度不是正数 ⇒ **整块作废**：一个没有图或没有大小的火苗画不出任何东西。
 */
function parsePropFlame(raw: unknown): PropFlameDef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const image = typeof v.image === 'string' ? v.image.trim() : '';
  const height = finiteOrUndefined(v.height);
  if (!image || height === undefined || !(height > 0)) return undefined;
  const colsRaw = finiteOrUndefined(v.cols);
  const cols = colsRaw !== undefined && Math.trunc(colsRaw) >= 1 ? Math.trunc(colsRaw) : 1;
  const framesRaw = finiteOrUndefined(v.frames);
  const frames = framesRaw !== undefined && Math.trunc(framesRaw) >= 1 ? Math.trunc(framesRaw) : cols;
  const fpsRaw = finiteOrUndefined(v.fps);
  const fps = fpsRaw !== undefined && fpsRaw > 0 ? fpsRaw : PROP_FLAME_DEFAULT_FPS;
  return { image, cols, frames, fps, height };
}

/**
 * 粒子挂载列表：条目须为对象且 `effect` 是非空串，否则**丢该条**（一条写坏不连累别的挂载）；
 * `point` 同起火点清洗，写坏当没写（落到起火点）。不是数组 ⇒ 空。
 */
function parseParticleMounts(v: unknown): PropParticleMount[] {
  if (!Array.isArray(v)) return [];
  const out: PropParticleMount[] = [];
  for (const it of v) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const m = it as Record<string, unknown>;
    const effect = typeof m.effect === 'string' ? m.effect.trim() : '';
    if (!effect) continue;
    out.push({ effect, point: parseFirePoint(m.point) ?? null });
  }
  return out;
}

/**
 * 吹灭块：三个必填量（吹熄风速、掉速、回速）都必须是 > 0 的有限数，否则整块丢（= 吹不灭，与"缺量就整块不要"同口径）；
 * `emberBelow` 夹 0..1、非数当没写；状态名空串当没写；`auto` 只认布尔；`fadeMs` ≥ 0。
 */
function parseBlowout(v: unknown): PropBlowoutDef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const b = v as Record<string, unknown>;
  const windSpeed = finiteOrUndefined(b.windSpeed);
  const drainSeconds = finiteOrUndefined(b.drainSeconds);
  const recoverSeconds = finiteOrUndefined(b.recoverSeconds);
  if (!(windSpeed !== undefined && windSpeed > 0) || !(drainSeconds !== undefined && drainSeconds > 0)
    || !(recoverSeconds !== undefined && recoverSeconds > 0)) return undefined;
  const def: PropBlowoutDef = { windSpeed, drainSeconds, recoverSeconds };
  const ember = finiteOrUndefined(b.emberBelow);
  if (ember !== undefined) def.emberBelow = clamp01(ember);
  const es = typeof b.emberState === 'string' ? b.emberState.trim() : '';
  if (es) def.emberState = es;
  const os = typeof b.outState === 'string' ? b.outState.trim() : '';
  if (os) def.outState = os;
  const rs = typeof b.recoverState === 'string' ? b.recoverState.trim() : '';
  if (rs) def.recoverState = rs;
  if (typeof b.auto === 'boolean') def.auto = b.auto;
  const fade = finiteOrUndefined(b.fadeMs);
  if (fade !== undefined && fade >= 0) def.fadeMs = fade;
  const onEmber = parseActionList(b.onEmberActions);
  if (onEmber.length > 0) def.onEmberActions = onEmber;
  const onOut = parseActionList(b.onOutActions);
  if (onOut.length > 0) def.onOutActions = onOut;
  return def;
}

/** 点火块：对象即开（`{}` = 全用缺省）；火焰长度须是 > 0 的有限数，否则当没写（用缺省） */
function parseIgniter(v: unknown): PropIgniterDef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  const def: PropIgniterDef = {};
  const len = finiteOrUndefined(c.flameLength);
  if (len !== undefined && len > 0) def.flameLength = len;
  return def;
}

/** 等级表：`label` 非空才算一级（图与效果块可不写）；一条都没有 = 这根不能升级 */
function parseLevels(v: unknown): PropLevelDef[] {
  if (!Array.isArray(v)) return [];
  const out: PropLevelDef[] = [];
  for (const it of v) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const l = it as Record<string, unknown>;
    const label = typeof l.label === 'string' ? l.label.trim() : '';
    if (!label) continue;
    const def: PropLevelDef = { label };
    const image = typeof l.image === 'string' ? l.image.trim() : '';
    if (image) def.image = image;
    const effects = stringList(l.effects);
    if (effects.length > 0) def.effects = effects;
    const note = typeof l.note === 'string' ? l.note.trim() : '';
    if (note) def.note = note;
    out.push(def);
  }
  return out;
}

/** 耐久块：`seconds` 必须是正数，否则整块当没写（没有耐久 = 烧不完，与写坏了就永远点不着比更安全） */
function parseFuel(v: unknown): PropFuelDef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const f = v as Record<string, unknown>;
  const seconds = finiteOrUndefined(f.seconds);
  if (!(seconds !== undefined && seconds > 0)) return undefined;
  const def: PropFuelDef = { seconds };
  const wind = finiteOrUndefined(f.windFactor);
  if (wind !== undefined && wind >= 0) def.windFactor = wind;
  const out = typeof f.outState === 'string' ? f.outState.trim() : '';
  if (out) def.outState = out;
  const spent = parseActionList(f.onSpentActions);
  if (spent.length > 0) def.onSpentActions = spent;
  if (typeof f.keepInHandWhenSpent === 'boolean') def.keepInHandWhenSpent = f.keepInHandWhenSpent;
  return def;
}

/** 玩家操作块：对象即开（`{}` = 全用缺省）；状态名空串当没写；渐变 ≥ 0 */
function parsePlayerControl(v: unknown): PropPlayerControlDef | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const c = v as Record<string, unknown>;
  const def: PropPlayerControlDef = {};
  for (const k of ['litState', 'guardState', 'outState'] as const) {
    const name = typeof c[k] === 'string' ? (c[k] as string).trim() : '';
    if (name) def[k] = name;
  }
  for (const k of ['extinguishFadeMs', 'igniteFadeMs'] as const) {
    const n = finiteOrUndefined(c[k]);
    if (n !== undefined && n >= 0) def[k] = n;
  }
  const hint = finiteOrUndefined(c.hintBelow);
  if (hint !== undefined) def.hintBelow = clamp01(hint);
  if (typeof c.guardBlocksRun === 'boolean') def.guardBlocksRun = c.guardBlocksRun;
  return def;
}

/** 动作列表：只留 `{type: 非空串}` 的条目；params 缺 / 不是对象 ⇒ 空对象（与执行器的入参形状一致） */
function parseActionList(v: unknown): ActionDef[] {
  if (!Array.isArray(v)) return [];
  const out: ActionDef[] = [];
  for (const it of v) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const a = it as Record<string, unknown>;
    const type = typeof a.type === 'string' ? a.type.trim() : '';
    if (!type) continue;
    const params = a.params && typeof a.params === 'object' && !Array.isArray(a.params)
      ? a.params as Record<string, unknown>
      : {};
    out.push({ type, params });
  }
  return out;
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
  if ('particles' in v) def.particles = parseParticleMounts(v.particles);
  const fp = parseFirePoint(v.firePoint);
  if (fp) def.firePoint = fp;
  const burn = parseBurn(v.burn);
  if (burn !== undefined) def.burn = burn;
  const shelter = parseBurn(v.windShelter);
  if (shelter !== undefined) def.windShelter = shelter;
  const enter = parseActionList(v.onEnterActions);
  if (enter.length > 0) def.onEnterActions = enter;
  // null 是有意义的值（这个状态吹不灭）；坏块当"没写"（沿用基础块），与 light 的坏对象口径一致
  if (v.blowout === null) def.blowout = null;
  else if ('blowout' in v) {
    const b = parseBlowout(v.blowout);
    if (b) def.blowout = b;
  }
  // 同 blowout：null = 这个状态点不了；坏块当没写（沿用基础块）
  if (v.igniter === null) def.igniter = null;
  else if ('igniter' in v) {
    const ig = parseIgniter(v.igniter);
    if (ig) def.igniter = ig;
  }
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

    const particles = parseParticleMounts(v.particles);
    if (particles.length > 0) def.particles = particles;

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

    const fp = parseFirePoint(v.firePoint);
    if (fp) def.firePoint = fp;
    const flame = parsePropFlame(v.flame);
    if (flame) def.flame = flame;
    const burn = parseBurn(v.burn);
    if (burn !== undefined) def.burn = burn;
    const shelter = parseBurn(v.windShelter);
    if (shelter !== undefined) def.windShelter = shelter;
    const blowout = parseBlowout(v.blowout);
    if (blowout) def.blowout = blowout;
    const control = parsePlayerControl(v.playerControl);
    if (control) def.playerControl = control;
    const igniter = parseIgniter(v.igniter);
    if (igniter) def.igniter = igniter;
    const fuel = parseFuel(v.fuel);
    if (fuel) def.fuel = fuel;
    const effects = stringList(v.effects);
    if (effects.length > 0) def.effects = effects;
    const levels = parseLevels(v.levels);
    if (levels.length > 0) def.levels = levels;
    // 可燃（A3.8）：图 / 握点 / 尺寸由可燃物模板接管
    const burnable = resolveBurnableHost(v.burnable);
    if (burnable) def.burnable = burnable;

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
  const burnable = resolveBurnableHost(preset?.burnable);
  if (burnable) {
    // 渲染由可燃物实例接管：火把那一套一律不带（校验器拦互斥字段），只留"这一次怎么拿"的覆盖
    return {
      images: [],
      rotation: override.rotation ?? preset?.rotation,
      scale: override.scale ?? preset?.scale,
      lit: override.lit ?? preset?.lit,
      mirror: override.mirror,
      light: null, particles: [], firePoint: null, burn: 1, windShelter: 0, flame: null, onEnterActions: [],
      blowout: null, igniter: null, burnable,
    };
  }
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
    particles: st?.particles ?? preset?.particles ?? [],
    firePoint: st?.firePoint ?? preset?.firePoint ?? null,
    burn: st?.burn ?? preset?.burn ?? 1,
    windShelter: st?.windShelter ?? preset?.windShelter ?? 0,
    flame: preset?.flame ?? null,
    onEnterActions: st?.onEnterActions ?? [],
    blowout: st && 'blowout' in st ? (st.blowout ?? null) : (preset?.blowout ?? null),
    igniter: st && 'igniter' in st ? (st.igniter ?? null) : (preset?.igniter ?? null),
  };
}
