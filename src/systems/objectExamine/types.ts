import type { ActionDef } from '../../data/types';

/** index.json 条目（与纸扎/转盘同形）。 */
export interface ObjectExamineIndexEntry {
  id: string;
  label: string;
  file: string;
}

/** 检视搁置托底预设（非 45° 场景截帧）。 */
export type ObjectExamineBackgroundPreset =
  | 'mud'
  | 'straw'
  | 'wood'
  | 'stone'
  | 'softGlow';

/** 一期呈现：单张静帧。后续可扩 layered / flip 等 kind，仍走同一会话壳。 */
export interface ObjectExamineStillPresentation {
  kind: 'still';
  /** 静帧图路径（runtime 资源 URL） */
  image: string;
  /**
   * 竖放姿态：绕图像中心逆时针转 90°，横构图资源变成竖槽开口。
   * 热区仍写图像像素坐标，随物体一起转。缺省 false。
   */
  upright?: boolean;
  /**
   * 搁置托底预设。与 backgroundImage 都不写时默认 softGlow。
   * 优先级：backgroundImage > backgroundPreset > softGlow。
   */
  backgroundPreset?: ObjectExamineBackgroundPreset;
  /** 自定义托底图；有则覆盖 preset */
  backgroundImage?: string;
  /**
   * 托底亮度乘数。1 = 默认；<1 乘性压暗（暖色衰减），>1 ColorMatrix 提亮。缺省 1。
   * 合法范围 0.2～2.5（运行时夹取）。
   */
  backgroundBrightness?: number;
  /**
   * 托底相对物件的铺开倍率。1 = 默认盖住探视余量；越大纹理越「近/大」。缺省 1。
   * 合法范围建议 0.5～2.5。
   */
  backgroundScale?: number;
  /**
   * 接触 AO 浓淡。0 = 关；1 = 默认；可到 3（饱和）。缺省 1。
   * 算法：最终 layer alpha 提取接触边缘黑白 mask → 高斯模糊 →
   * 以黑 alpha 乘回接收面（见 contactAo.ts），对任意透明物件通用。
   */
  contactAoIntensity?: number;
  /**
   * 接触 AO 衰减半径倍率。1 = 默认；越大影子铺得越开。缺省 1。
   * 合法范围 0.3～2.5（运行时夹取）。
   */
  contactAoScale?: number;
}

/** 烛光/月光等可开关 + 强度块。 */
export type ObjectExamineAmbienceToggle =
  | boolean
  | {
      strength?: number;
      periodSec?: number;
    };

export type ObjectExamineCloudShadowToggle =
  | boolean
  | {
      strength?: number;
      speed?: number;
    };

export type ObjectExamineDustToggle =
  | boolean
  | {
      /** 粒子数量乘数。1 = 默认；建议 0.2～3。 */
      density?: number;
      /** 不透明度乘数。1 = 默认；建议 0～3。 */
      intensity?: number;
      /** 颗粒半径乘数。1 = 默认；建议 0.2～4。 */
      radius?: number;
    };

export type ObjectExamineCrawlerSpecies = 'maggot' | 'centipede' | 'beetle';

/** @deprecated 旧掠过蝇；新内容请写 flyingFlies。仍可读，映射为飞舞默认。 */
export type ObjectExamineFliesToggle =
  | boolean
  | {
      intervalSec?: number;
      /** 若写 count 则直接当 flyingFlies.count */
      count?: number;
    };

/** 苍蝇飞舞（活动域内高速乱飞，可点击惊赶；赶走会躲一会儿再飞回来）。 */
export type ObjectExamineFlyingFliesToggle =
  | boolean
  | {
      /** 活动域中心（归一化坐标，相对物件图宽高 0~1）；x/y 缺省时使用整块空域。 */
      x?: number;
      y?: number;
      /** 同时存在的苍蝇数。缺省 5；建议 1～16。 */
      count?: number;
      /** 速度乘数。1 = 默认；建议 0.3～2.5。 */
      speed?: number;
      /** 活动范围乘数（兼容字段名 orbitRadius）。1 = 默认；建议 0.3～3。 */
      orbitRadius?: number;
      /** 被赶走后多久开始绕回（秒）。0 = 不再回来；缺省 12；建议 4～60。 */
      returnSec?: number;
      /** 尺寸乘数。1 = 默认；建议 0.2～4。 */
      size?: number;
    };

/** 虫簇落点（归一化坐标，相对物件图宽高 0~1；x/y 缺省时运行时自动挑点）。 */
export type ObjectExamineCritterClusterDef = {
  x?: number;
  y?: number;
  /** 个体数。蛆缺省 6，爬虫缺省 4。 */
  count?: number;
  /** 簇半径（相对物件长边，1 = 长边长度）。缺省蛆 0.028 / 爬虫 0.04。 */
  radius?: number;
  /** 个体尺寸乘数。1 = 默认；建议 0.2～4。 */
  size?: number;
};

/**
 * 爬虫三类（全部缺省开；写 false 单项关闭，crawlers:false 全关）：
 * - 蛆：小、成簇、只在原地蠕动，任何触发都不影响。
 * - 蜈蚣：过场型，不常驻；沿剪影轮廓快速爬过一次即走。
 * - 爬虫（甲虫）：平时聚成一簇微动；点击附近 → 各自沿线快速四散。
 */
export type ObjectExamineCrawlersToggle =
  | boolean
  | {
      /** 父级开关；false 时保留全部子配置但暂停爬虫表现。 */
      enabled?: boolean;
      /** 非飞行虫接触影；intensity 为强度，size 为尺寸乘数。 */
      contactShadow?: boolean | { intensity?: number; size?: number };
      /** 蛆簇。true = 自动两簇；对象可给 clusters（x/y 缺省自动挑当前物体表面点）。 */
      maggots?: boolean | { clusters?: ObjectExamineCritterClusterDef[] };
      /** 蜈蚣过场。intervalSec 平均出场间隔（秒），0 = 没有蜈蚣；speed/size 为乘数。 */
      centipede?: boolean | { intervalSec?: number; speed?: number; size?: number };
      /** 爬虫簇。regroupSec 惊散后多久重新聚回（秒），0 = 不再回来。 */
      beetles?: boolean | (ObjectExamineCritterClusterDef & { regroupSec?: number });
    };

/** Grok 出图 + 本地抠图后的检视虫子精灵。 */
export const OBJECT_EXAMINE_CRITTER_SPRITES = {
  fly: '/resources/runtime/images/examine/critters/fly.png',
  maggot: '/resources/runtime/images/examine/critters/maggot.png',
  centipede: '/resources/runtime/images/examine/critters/centipede.png',
  beetle: '/resources/runtime/images/examine/critters/beetle.png',
} as const;

/** 苍蝇嗡鸣环境层 id（audio_config ambient 登记）；有苍蝇盘旋时挂，全被赶躲起来时摘。 */
export const OBJECT_EXAMINE_FLY_BUZZ_AMBIENT_ID = 'fly_buzz';

/** 镜头微晃：可开关；对象时 `amplitude` 为幅度乘数（1=默认）。 */
export type ObjectExamineHeadSwayToggle =
  | boolean
  | {
      /** 晃动幅度乘数。1 = 默认；建议 0～3。 */
      amplitude?: number;
    };

/**
 * 呼吸感：可开关；对象时 `strength` 同时抬高幅度与频率。
 * strength 高 → 急促喘息；低 → 缓吸缓呼。建议 0～3。
 */
export type ObjectExamineBreathingToggle =
  | boolean
  | {
      strength?: number;
    };

/**
 * 检视会话氛围（仅本系统）。全部可选；缺省仅 headSway=true，其余关。
 */
export interface ObjectExamineAmbience {
  /**
   * 镜头微晃（模仿观察时头部轻微晃动）。缺省 true（amplitude=1）。
   * 整镜一起动，不是托底/物件层间视差。
   */
  headSway?: ObjectExamineHeadSwayToggle;
  /**
   * 呼吸感（镜头随吸呼微起伏）。缺省关。
   * `strength` 越大越急促（幅度+频率一起升）。
   */
  breathing?: ObjectExamineBreathingToggle;
  /**
   * @deprecated 旧字段，等同 headSway 开关；新内容请写 headSway。
   */
  parallax?: boolean;
  candlelight?: ObjectExamineAmbienceToggle;
  moonlight?: ObjectExamineAmbienceToggle;
  cloudShadow?: ObjectExamineCloudShadowToggle;
  dust?: ObjectExamineDustToggle;
  /** 苍蝇飞舞盘旋（精灵；点击可惊赶，过一会儿绕回）。 */
  flyingFlies?: ObjectExamineFlyingFliesToggle;
  /** 爬虫三类：蛆簇（原地蠕动）/ 蜈蚣过场 / 爬虫簇（点击惊散）。 */
  crawlers?: ObjectExamineCrawlersToggle;
  /**
   * @deprecated 旧「两点圆掠过」；若未写 flyingFlies 则映射为飞舞开关。
   */
  flies?: ObjectExamineFliesToggle;
}

/** 会话进退施加的气味（接 SmellSystem action 层）。 */
export interface ObjectExamineSmellConfig {
  scent: string;
  intensity?: number;
  dir?: number;
  flicker?: boolean;
}

/** 检视音效；缺省全静音。id 须在 audio_config 登记。 */
export interface ObjectExamineAudioConfig {
  ambient?: string;
  hoverSfx?: string;
  clickSfx?: string;
}

/** 托底默认铺开：相对 max(物件宽,高) 的倍数（再乘 presentation.backgroundScale）。 */
export const OBJECT_EXAMINE_BG_COVER_BASE = 1.28;

/** 发现留痕朱砂点资源。 */
export const OBJECT_EXAMINE_CINNABAR_MARK_URL =
  '/resources/runtime/images/examine/marks/cinnabar_dot.png';

/** 解析托底亮度（夹取）。 */
export function resolveObjectExamineBackgroundBrightness(
  presentation: ObjectExamineStillPresentation,
): number {
  const v = presentation.backgroundBrightness;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.max(0.2, Math.min(2.5, v));
}

/** 解析托底铺开倍率（夹取）。 */
export function resolveObjectExamineBackgroundScale(
  presentation: ObjectExamineStillPresentation,
): number {
  const v = presentation.backgroundScale;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.max(0.5, Math.min(2.5, v));
}

/** 解析接触 AO 强度（夹取；0=关）。 */
export function resolveObjectExamineContactAoIntensity(
  presentation: ObjectExamineStillPresentation,
): number {
  const v = presentation.contactAoIntensity;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.max(0, Math.min(3, v));
}

/** 解析接触 AO 尺寸倍率（夹取）。 */
export function resolveObjectExamineContactAoScale(
  presentation: ObjectExamineStillPresentation,
): number {
  const v = presentation.contactAoScale;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  return Math.max(0.3, Math.min(2.5, v));
}

export type ObjectExaminePresentation = ObjectExamineStillPresentation;

/** 热区上的一条上下文操作。 */
export interface ObjectExamineOperationDef {
  id: string;
  /** 玩家可见；可含 [tag:…] */
  label: string;
  /**
   * 特写旁白：激活后镜头推近热区时叠在特写旁的文案；可含 [tag:…]。
   * 缺省回落到热区的 narration；都没有则无旁白浮层。
   */
  narration?: string;
  actions?: ActionDef[];
  /** 背包无此物则菜单不显示 */
  requiresItem?: string;
}

/** 持物点热区时的用物绑定。 */
export interface ObjectExamineItemUseDef {
  itemId: string;
  label: string;
  narration?: string;
  actions?: ActionDef[];
}

/**
 * 检视热区。坐标相对静帧图左上角（未缩放像素）。
 * 有 polygon 时以多边形命中，否则用 x/y/width/height 矩形。
 */
export interface ObjectExamineHotspotDef {
  id: string;
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  polygon?: Array<{ x: number; y: number }>;
  /**
   * 上下文操作。空或缺省 → 默认「观察」，激活后直接跑 `actions`。
   */
  operations?: ObjectExamineOperationDef[];
  /** 特写旁白（默认「观察」路径）；可含 [tag:…]；可被操作的 narration 覆盖 */
  narration?: string;
  /** 默认「观察」路径的动作列表 */
  actions?: ActionDef[];
  /**
   * 假热区：可点可反馈，不计入发现进度、不画朱砂、不进异常影子。
   */
  decoy?: boolean;
  /** 未发现时影子条目文案（游戏口吻） */
  anomalyShade?: string;
  /** 发现后影子条目文案；缺省用 label / anomalyShade */
  anomalyRevealed?: string;
  /**
   * 异常影子浮字屏幕锚点 X（0～1，相对整屏宽）。
   * 缺省按热区序号散开，不叠成一列。
   */
  shadeUiX?: number;
  /**
   * 异常影子浮字屏幕锚点 Y（0～1，相对整屏高）。
   * 缺省按热区序号散开，不叠成一列。
   */
  shadeUiY?: number;
  /** 首次计入发现时追加跑的里程碑 Action */
  onFound?: ActionDef[];
  /** 持物点此热区时的用物表 */
  itemUses?: ObjectExamineItemUseDef[];
}

export interface ObjectExamineInstance {
  id: string;
  label: string;
  /** 顶栏标题；可含 [tag:…]；缺省用 label */
  title?: string;
  /** 全部真热区找过后的提示；可含 [tag:…]；缺省用 strings.objectExamine.allFound */
  allFoundHint?: string;
  presentation: ObjectExaminePresentation;
  hotspots: ObjectExamineHotspotDef[];
  /** 检视氛围；缺省仅镜头微晃 */
  ambience?: ObjectExamineAmbience;
  /** 进会话气味；缺省不碰 SmellSystem */
  smell?: ObjectExamineSmellConfig;
  /** 音效；缺省静音 */
  audio?: ObjectExamineAudioConfig;
  /** 全部真热区首次找齐时的里程碑 Action */
  onAllFound?: ActionDef[];
  /** 摸囊浮字；缺省 strings.objectExamine.bag */
  bagLabel?: string;
}

/** 会话结束时的轻量结果（无胜负语义；玩法进度不靠此事件）。 */
export interface ObjectExamineResult {
  instanceId: string;
  instanceLabel: string;
  foundAll: boolean;
  foundHotspotIds: string[];
  exited: boolean;
}

/** 解析后的氛围（运行时 / F2 热调共用）。 */
export interface ResolvedObjectExamineAmbience {
  headSway: { enabled: boolean; amplitude: number };
  breathing: { enabled: boolean; strength: number };
  candlelight: { enabled: boolean; strength: number; periodSec: number };
  moonlight: { enabled: boolean; strength: number; periodSec: number };
  cloudShadow: { enabled: boolean; strength: number; speed: number };
  dust: { enabled: boolean; density: number; intensity: number; radius: number };
  flyingFlies: {
    enabled: boolean;
    x: number | null;
    y: number | null;
    count: number;
    speed: number;
    orbitRadius: number;
    returnSec: number;
    size: number;
  };
  crawlers: {
    enabled: boolean;
    /** 父级开关原始语义；与是否存在已开启物种分开。 */
    parentEnabled: boolean;
    /** 原始值是否为结构化对象；供 F2 保真切换，区别于旧布尔 false/true。 */
    hasStructuredConfig: boolean;
    contactShadow: { enabled: boolean; intensity: number; size: number };
    /** 蛆簇（原地蠕动，不受触发）。x/y 为 null 时运行时自动挑点。 */
    maggots: {
      enabled: boolean;
      clusters: Array<{
        x: number | null;
        y: number | null;
        count: number;
        radius: number;
        size: number;
      }>;
    };
    /** 蜈蚣过场。intervalSec = 0 即没有蜈蚣。 */
    centipede: {
      enabled: boolean;
      /** 原始子项是否为结构化对象；intervalSec=0 时仍需保留 speed/size。 */
      hasStructuredConfig: boolean;
      intervalSec: number;
      speed: number;
      size: number;
    };
    /** 爬虫簇（点击惊散）。x/y 为 null 时运行时自动挑点。 */
    beetles: {
      enabled: boolean;
      x: number | null;
      y: number | null;
      count: number;
      radius: number;
      size: number;
      regroupSec: number;
    };
  };
  /** @deprecated 兼容旧 F2 文案；等同 flyingFlies 的粗摘要。 */
  flies: { enabled: boolean; intervalSec: number };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function resolveLightToggle(
  v: ObjectExamineAmbienceToggle | undefined,
  defaults: { strength: number; periodSec: number },
): { enabled: boolean; strength: number; periodSec: number } {
  if (v === true) {
    return { enabled: true, strength: defaults.strength, periodSec: defaults.periodSec };
  }
  if (v && typeof v === 'object') {
    return {
      enabled: true,
      strength: clamp(
        typeof v.strength === 'number' && Number.isFinite(v.strength) ? v.strength : defaults.strength,
        0,
        1.5,
      ),
      periodSec: clamp(
        typeof v.periodSec === 'number' && Number.isFinite(v.periodSec)
          ? v.periodSec
          : defaults.periodSec,
        0.5,
        30,
      ),
    };
  }
  return { enabled: false, strength: defaults.strength, periodSec: defaults.periodSec };
}

/** 合并实例 ambience + 可选 F2 覆盖 → 运行时解析值。 */
export function resolveObjectExamineAmbience(
  ambience?: ObjectExamineAmbience | null,
  override?: Partial<ObjectExamineAmbience> | null,
): ResolvedObjectExamineAmbience {
  const a: ObjectExamineAmbience = { ...(ambience ?? {}), ...(override ?? {}) };
  const cloud =
    a.cloudShadow === true
      ? { enabled: true, strength: 0.22, speed: 18 }
      : a.cloudShadow && typeof a.cloudShadow === 'object'
        ? {
            enabled: true,
            strength: clamp(
              typeof a.cloudShadow.strength === 'number' ? a.cloudShadow.strength : 0.22,
              0,
              1,
            ),
            speed: clamp(
              typeof a.cloudShadow.speed === 'number' ? a.cloudShadow.speed : 18,
              1,
              80,
            ),
          }
        : { enabled: false, strength: 0.22, speed: 18 };
  const dust =
    a.dust === true
      ? { enabled: true, density: 1, intensity: 1, radius: 1 }
      : a.dust && typeof a.dust === 'object'
        ? {
            enabled: true,
            density: clamp(typeof a.dust.density === 'number' ? a.dust.density : 1, 0.2, 3),
            intensity: clamp(
              typeof a.dust.intensity === 'number' ? a.dust.intensity : 1,
              0,
              3,
            ),
            radius: clamp(typeof a.dust.radius === 'number' ? a.dust.radius : 1, 0.2, 4),
          }
        : { enabled: false, density: 1, intensity: 1, radius: 1 };
  const flyingFlies = resolveFlyingFlies(a.flyingFlies, a.flies);
  const crawlers = resolveCrawlers(a.crawlers);
  /** 兼容旧字段展示：interval 无实际用途，enabled 跟飞舞走。 */
  const flies = {
    enabled: flyingFlies.enabled,
    intervalSec: 7,
  };

  const headSway = resolveHeadSway(a.headSway, a.parallax);
  const breathing = resolveBreathing(a.breathing);

  return {
    headSway,
    breathing,
    candlelight: resolveLightToggle(a.candlelight, { strength: 0.12, periodSec: 3.2 }),
    moonlight: resolveLightToggle(a.moonlight, { strength: 0.1, periodSec: 5.5 }),
    cloudShadow: cloud,
    dust,
    flyingFlies,
    crawlers,
    flies,
  };
}

export type ResolvedObjectExamineFlyingFlies = ResolvedObjectExamineAmbience['flyingFlies'];
export type ResolvedObjectExamineCrawlers = ResolvedObjectExamineAmbience['crawlers'];

function resolveFlyingFlies(
  v: ObjectExamineFlyingFliesToggle | undefined,
  legacy: ObjectExamineFliesToggle | undefined,
): ResolvedObjectExamineFlyingFlies {
  const defaults = {
    x: null,
    y: null,
    count: 5,
    speed: 1,
    orbitRadius: 1,
    returnSec: 12,
    size: 1,
  };
  if (v === false) return { enabled: false, ...defaults };
  if (v === true) return { enabled: true, ...defaults };
  if (v && typeof v === 'object') {
    return {
      enabled: true,
      x: normPoint(v.x),
      y: normPoint(v.y),
      count: Math.round(clamp(finiteNumber(v.count, defaults.count), 1, 16)),
      speed: clamp(finiteNumber(v.speed, defaults.speed), 0.3, 2.5),
      orbitRadius: clamp(
        finiteNumber(v.orbitRadius, defaults.orbitRadius),
        0.3,
        3,
      ),
      returnSec: clamp(
        finiteNumber(v.returnSec, defaults.returnSec),
        0,
        60,
      ),
      size: clamp(finiteNumber(v.size, defaults.size), 0.2, 4),
    };
  }
  // 旧 flies → 飞舞
  if (legacy === true) return { enabled: true, ...defaults };
  if (legacy && typeof legacy === 'object') {
    return {
      enabled: true,
      x: defaults.x,
      y: defaults.y,
      count: Math.round(
        clamp(finiteNumber(legacy.count, defaults.count), 1, 16),
      ),
      speed: defaults.speed,
      orbitRadius: defaults.orbitRadius,
      returnSec: defaults.returnSec,
      size: defaults.size,
    };
  }
  return { enabled: false, ...defaults };
}

function normPoint(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : null;
}

function resolveCrawlers(
  v: ObjectExamineCrawlersToggle | undefined,
): ResolvedObjectExamineCrawlers {
  const off: ResolvedObjectExamineCrawlers = {
    enabled: false,
    parentEnabled: false,
    hasStructuredConfig: false,
    contactShadow: { enabled: false, intensity: 1, size: 1 },
    maggots: { enabled: false, clusters: [] },
    centipede: { enabled: false, hasStructuredConfig: false, intervalSec: 0, speed: 1, size: 1 },
    beetles: { enabled: false, x: null, y: null, count: 4, radius: 0.04, size: 1, regroupSec: 30 },
  };
  if (v === false || v === undefined) return off;

  let contactShadow: ResolvedObjectExamineCrawlers['contactShadow'] = {
    enabled: true,
    intensity: 1,
    size: 1,
  };

  // 蛆：默认自动两簇
  let maggots: ResolvedObjectExamineCrawlers['maggots'] = {
    enabled: true,
    clusters: [
      { x: null, y: null, count: 6, radius: 0.028, size: 1 },
      { x: null, y: null, count: 6, radius: 0.028, size: 1 },
    ],
  };
  // 蜈蚣：默认 24s 一次过场
  let centipede: ResolvedObjectExamineCrawlers['centipede'] = {
    enabled: true,
    hasStructuredConfig: false,
    intervalSec: 24,
    speed: 1,
    size: 1,
  };
  // 爬虫簇：默认自动一簇
  let beetles: ResolvedObjectExamineCrawlers['beetles'] = {
    enabled: true,
    x: null,
    y: null,
    count: 4,
    radius: 0.04,
    size: 1,
    regroupSec: 30,
  };

  if (v && typeof v === 'object') {
    if (v.contactShadow === false) {
      contactShadow = { ...contactShadow, enabled: false };
    } else if (v.contactShadow && typeof v.contactShadow === 'object') {
      contactShadow = {
        enabled: true,
        intensity: clamp(finiteNumber(v.contactShadow.intensity, 1), 0, 2),
        size: clamp(finiteNumber(v.contactShadow.size, 1), 0.5, 1.8),
      };
    }
    if (v.maggots === false) {
      maggots = { enabled: false, clusters: [] };
    } else if (v.maggots && typeof v.maggots === 'object') {
      const raw = Array.isArray(v.maggots.clusters) ? v.maggots.clusters : [];
      const clusters = raw
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({
          x: normPoint(c.x),
          y: normPoint(c.y),
          count: Math.round(clamp(finiteNumber(c.count, 6), 1, 24)),
          radius: clamp(finiteNumber(c.radius, 0.028), 0.005, 0.2),
          size: clamp(finiteNumber(c.size, 1), 0.2, 4),
        }));
      maggots = {
        enabled: clusters.length > 0,
        clusters: clusters.length ? clusters : maggots.clusters,
      };
      if (clusters.length === 0) maggots.enabled = true; // 空数组 = 用默认两簇
    }
    if (v.centipede === false) {
      centipede = {
        enabled: false,
        hasStructuredConfig: false,
        intervalSec: 0,
        speed: 1,
        size: 1,
      };
    } else if (v.centipede && typeof v.centipede === 'object') {
      const intervalSec = clamp(
        finiteNumber(v.centipede.intervalSec, 24),
        0,
        300,
      );
      centipede = {
        enabled: intervalSec > 0,
        hasStructuredConfig: true,
        intervalSec,
        speed: clamp(finiteNumber(v.centipede.speed, 1), 0.3, 3),
        size: clamp(finiteNumber(v.centipede.size, 1), 0.2, 4),
      };
    }
    if (v.beetles === false) {
      beetles = { ...beetles, enabled: false };
    } else if (v.beetles && typeof v.beetles === 'object') {
      beetles = {
        enabled: true,
        x: normPoint(v.beetles.x),
        y: normPoint(v.beetles.y),
        count: Math.round(clamp(finiteNumber(v.beetles.count, 4), 1, 16)),
        radius: clamp(finiteNumber(v.beetles.radius, 0.04), 0.005, 0.2),
        size: clamp(finiteNumber(v.beetles.size, 1), 0.2, 4),
        regroupSec: clamp(
          finiteNumber(v.beetles.regroupSec, 30),
          0,
          300,
        ),
      };
    }
  }

  const parentEnabled = !(v && typeof v === 'object' && v.enabled === false);
  return {
    enabled: parentEnabled && (maggots.enabled || centipede.enabled || beetles.enabled),
    parentEnabled,
    hasStructuredConfig: !!v && typeof v === 'object',
    contactShadow,
    maggots,
    centipede,
    beetles,
  };
}

function resolveHeadSway(
  v: ObjectExamineHeadSwayToggle | undefined,
  legacyParallax: boolean | undefined,
): { enabled: boolean; amplitude: number } {
  const defaultAmp = 1;
  if (v === false) return { enabled: false, amplitude: defaultAmp };
  if (v === true) return { enabled: true, amplitude: defaultAmp };
  if (v && typeof v === 'object') {
    return {
      enabled: true,
      amplitude: clamp(
        typeof v.amplitude === 'number' && Number.isFinite(v.amplitude) ? v.amplitude : defaultAmp,
        0,
        3,
      ),
    };
  }
  if (legacyParallax !== undefined) {
    return { enabled: legacyParallax !== false, amplitude: defaultAmp };
  }
  return { enabled: true, amplitude: defaultAmp };
}

function resolveBreathing(
  v: ObjectExamineBreathingToggle | undefined,
): { enabled: boolean; strength: number } {
  const defaultStrength = 1;
  if (v === false || v === undefined) return { enabled: false, strength: defaultStrength };
  if (v === true) return { enabled: true, strength: defaultStrength };
  return {
    enabled: true,
    strength: clamp(
      typeof v.strength === 'number' && Number.isFinite(v.strength) ? v.strength : defaultStrength,
      0,
      3,
    ),
  };
}

/** 真异常热区（非 decoy）。 */
export function isObjectExamineRealHotspot(hs: ObjectExamineHotspotDef): boolean {
  return hs.decoy !== true;
}

/** 预设托底资源（相对 site root 的 URL）。 */
export const OBJECT_EXAMINE_BACKGROUND_PRESETS: Record<
  ObjectExamineBackgroundPreset,
  string
> = {
  mud: '/resources/runtime/images/examine/backgrounds/mud.png',
  straw: '/resources/runtime/images/examine/backgrounds/straw.png',
  wood: '/resources/runtime/images/examine/backgrounds/wood.png',
  stone: '/resources/runtime/images/examine/backgrounds/stone.png',
  softGlow: '/resources/runtime/images/examine/backgrounds/soft_glow.png',
};

/** 解析最终托底 URL：自定义图 > preset > softGlow。 */
export function resolveObjectExamineBackgroundUrl(
  presentation: ObjectExamineStillPresentation,
): string {
  const custom = presentation.backgroundImage?.trim();
  if (custom) return custom;
  const preset = presentation.backgroundPreset ?? 'softGlow';
  return OBJECT_EXAMINE_BACKGROUND_PRESETS[preset] ?? OBJECT_EXAMINE_BACKGROUND_PRESETS.softGlow;
}
