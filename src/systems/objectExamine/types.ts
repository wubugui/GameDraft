import type { ActionDef, AudioCueRef } from '../../data/types';

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
   * 静帧横向跨越的真实宽度（厘米）——本物件唯一的物理标尺。
   * 一切以长度为单位的表现量（接触 AO 半径等）都经 texW / physicalWidthCm
   * 换算成设计像素，因此换更高分辨率的图不会改变观感。
   * 缺省 OBJECT_EXAMINE_DEFAULT_PHYSICAL_WIDTH_CM；校验器会提醒补上真值。
   * 合法范围 0.5～2000（运行时夹取）。
   */
  physicalWidthCm?: number;
  /**
   * 接触 AO 浓淡（无量纲）。0 = 关；1 = 默认；可到 3（饱和）。缺省 1。
   * 算法：最终 layer alpha 提取接触边缘黑白 mask → 高斯模糊 →
   * 以黑 alpha 乘回接收面（见 contactAo.ts），对任意透明物件通用。
   */
  contactAoIntensity?: number;
  /**
   * 接触 AO 衰减半径，**单位厘米**（真实长度，不是贴图像素也不是倍率）。
   * 缺省 OBJECT_EXAMINE_DEFAULT_CONTACT_AO_RADIUS_CM。
   * 合法范围 0～OBJECT_EXAMINE_MAX_CONTACT_AO_RADIUS_CM（运行时夹取）。
   */
  contactAoRadiusCm?: number;
}

/**
 * 氛围表现的物理默认值（厘米 / 厘米每秒）。
 *
 * 全部由旧的「物件长边比例 / 倍率」换算而来（旧值 × 175cm = 演示尸体的长边真实长度），
 * 所以换算前后演示实例逐项等值；区别是这些数从此描述的是**虫子和尘埃本身多大多快**，
 * 不再随静帧长边浮动——同一只苍蝇落在 20cm 的物件上不会缩成一个点。
 */
/** 尘埃颗粒半径上限（厘米）；实际半径 29%～100% 随机。 */
export const OBJECT_EXAMINE_DEFAULT_DUST_RADIUS_CM = 0.7535;
/** 苍蝇体长（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_FLY_LENGTH_CM = 3.675;
/** 苍蝇活动域半径（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_FLY_ROAM_RADIUS_CM = 13.125;
/** 苍蝇巡飞速度（厘米/秒）。 */
export const OBJECT_EXAMINE_DEFAULT_FLY_SPEED_CM_S = 18.375;
/** 蛆体长（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_MAGGOT_LENGTH_CM = 2.8;
/** 蛆簇半径（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_MAGGOT_CLUSTER_RADIUS_CM = 4.9;
/** 甲虫体长（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_BEETLE_LENGTH_CM = 4.025;
/** 甲虫簇半径（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_BEETLE_CLUSTER_RADIUS_CM = 7;
/** 蜈蚣体长（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_CENTIPEDE_LENGTH_CM = 13.3;
/** 蜈蚣爬行速度（厘米/秒）。 */
export const OBJECT_EXAMINE_DEFAULT_CENTIPEDE_SPEED_CM_S = 18.375;
/** 云影漂移速度（厘米/秒）。 */
export const OBJECT_EXAMINE_DEFAULT_CLOUD_SPEED_CM_S = 2.05;
/** 体表起伏落差（厘米）：躺姿人形躯干高出地面的量级。 */
export const OBJECT_EXAMINE_DEFAULT_RELIEF_CM = 18;
/** 沿沟壑走的倾向（无量纲 0~1）。 */
export const OBJECT_EXAMINE_DEFAULT_GROOVE_FOLLOW = 0.55;
/** 上坡减速强度（无量纲 0~2）。 */
export const OBJECT_EXAMINE_DEFAULT_CLIMB_SLOWDOWN = 0.9;

/** 未声明 physicalWidthCm 时的兜底标尺（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_PHYSICAL_WIDTH_CM = 100;
/** 物件接触 AO 缺省半径（厘米）。 */
export const OBJECT_EXAMINE_DEFAULT_CONTACT_AO_RADIUS_CM = 2;
/** 爬虫接触影缺省半径（厘米）——虫子贴在表面上，影子就那么点大。 */
export const OBJECT_EXAMINE_DEFAULT_CRITTER_AO_RADIUS_CM = 0.3;
/** 物件接触 AO 半径上限（厘米）。 */
export const OBJECT_EXAMINE_MAX_CONTACT_AO_RADIUS_CM = 8;
/**
 * 爬虫接触影半径上限（厘米）。虫子影子按定义就很小，压得比物件低是有意的：
 * cast 外扩留边按这个上限静态预留，才能让每帧平滑跟随的爬虫半径不触发 mask RT 重建。
 */
export const OBJECT_EXAMINE_MAX_CRITTER_AO_RADIUS_CM = 2;

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
      /** 浓淡（无量纲）。 */
      strength?: number;
      /** 云影漂移速度，**厘米/秒**。缺省 OBJECT_EXAMINE_DEFAULT_CLOUD_SPEED_CM_S。 */
      speedCmPerSec?: number;
    };

export type ObjectExamineDustToggle =
  | boolean
  | {
      /** 粒子数量乘数（无量纲）。1 = 默认；建议 0.2～3。 */
      density?: number;
      /** 不透明度乘数（无量纲）。1 = 默认；建议 0～3。 */
      intensity?: number;
      /**
       * 颗粒半径上限，**单位厘米**；实际半径在 29%～100% 之间随机。
       * 缺省 OBJECT_EXAMINE_DEFAULT_DUST_RADIUS_CM。
       */
      radiusCm?: number;
    };

export type ObjectExamineCrawlerSpecies = 'maggot' | 'centipede' | 'beetle';

/** 苍蝇飞舞（活动域内高速乱飞，可点击惊赶；赶走会躲一会儿再飞回来）。 */
export type ObjectExamineFlyingFliesToggle =
  | boolean
  | {
      /** 活动域中心（归一化坐标，相对物件图宽高 0~1）；x/y 缺省时使用整块空域。 */
      x?: number;
      y?: number;
      /** 同时存在的苍蝇数（无量纲）。缺省 5；建议 1～16。 */
      count?: number;
      /** 巡飞速度，**厘米/秒**。缺省 OBJECT_EXAMINE_DEFAULT_FLY_SPEED_CM_S。 */
      speedCmPerSec?: number;
      /** 活动域半径，**厘米**。缺省 OBJECT_EXAMINE_DEFAULT_FLY_ROAM_RADIUS_CM。 */
      roamRadiusCm?: number;
      /** 被赶走后多久开始绕回（秒）。0 = 不再回来；缺省 12；建议 4～60。 */
      returnSec?: number;
      /** 虫体长度，**厘米**。缺省 OBJECT_EXAMINE_DEFAULT_FLY_LENGTH_CM。 */
      lengthCm?: number;
    };

/** 虫簇落点（归一化坐标，相对物件图宽高 0~1；x/y 缺省时运行时自动挑点）。 */
export type ObjectExamineCritterClusterDef = {
  x?: number;
  y?: number;
  /** 个体数（无量纲）。蛆缺省 6，爬虫缺省 4。 */
  count?: number;
  /** 簇半径，**厘米**。缺省蛆 4.9 / 甲虫 7。 */
  radiusCm?: number;
  /** 单只虫体长度，**厘米**。缺省蛆 2.8 / 甲虫 4.025。 */
  lengthCm?: number;
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
      /** 非飞行虫接触影；intensity 为无量纲强度，radiusCm 为半径（厘米）。 */
      contactShadow?: boolean | { intensity?: number; radiusCm?: number };
      /**
       * 体表地形：虫子是否感知物件的起伏（衣褶、躯干隆起）。
       * `false` = 当平面爬（旧行为）。高度场由静帧烘焙，见 crawlField.ts。
       */
      terrain?: boolean | {
        /** 体表最高处相对地面的真实落差，**厘米**。0 = 等同关闭。 */
        reliefCm?: number;
        /** 沿沟壑走的倾向（无量纲 0~1）：越大越爱顺着凹处走。 */
        grooveFollow?: number;
        /** 上坡减速强度（无量纲 0~2）。 */
        climbSlowdown?: number;
      };
      /** 蛆簇。true = 自动两簇；对象可给 clusters（x/y 缺省自动挑当前物体表面点）。 */
      maggots?: boolean | { clusters?: ObjectExamineCritterClusterDef[] };
      /** 蜈蚣过场。intervalSec 平均出场间隔（秒），0 = 没有蜈蚣；速度/体长走物理单位。 */
      centipede?: boolean | {
        intervalSec?: number;
        /** 爬行速度，**厘米/秒**。缺省 OBJECT_EXAMINE_DEFAULT_CENTIPEDE_SPEED_CM_S。 */
        speedCmPerSec?: number;
        /** 虫体长度，**厘米**。缺省 OBJECT_EXAMINE_DEFAULT_CENTIPEDE_LENGTH_CM。 */
        lengthCm?: number;
      };
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
  candlelight?: ObjectExamineAmbienceToggle;
  moonlight?: ObjectExamineAmbienceToggle;
  cloudShadow?: ObjectExamineCloudShadowToggle;
  dust?: ObjectExamineDustToggle;
  /** 苍蝇飞舞盘旋（精灵；点击可惊赶，过一会儿绕回）。 */
  flyingFlies?: ObjectExamineFlyingFliesToggle;
  /** 爬虫三类：蛆簇（原地蠕动）/ 蜈蚣过场 / 爬虫簇（点击惊散）。 */
  crawlers?: ObjectExamineCrawlersToggle;
}

/** 会话进退施加的气味（接 SmellSystem action 层）。 */
export interface ObjectExamineSmellConfig {
  scent: string;
  intensity?: number;
  dir?: number;
  flicker?: boolean;
}

/**
 * 检视音效；缺省全静音。id 须在 audio_config 登记。
 *
 * `hoverSfx` / `clickSfx` 可写 `{ id, volume }` 定**本处音量**；不写就用下面这两个内置默认
 * （检视是安静场景，悬停/点击音一律压得比常规 UI 音低，否则扫一遍热点就是一串敲击）。
 */
export interface ObjectExamineAudioConfig {
  ambient?: string;
  hoverSfx?: AudioCueRef;
  clickSfx?: AudioCueRef;
}

/** `hoverSfx` 没写本处音量时的默认（历史写死值，提出来避免两处漂）。 */
export const OBJECT_EXAMINE_HOVER_SFX_DEFAULT_VOLUME = 0.35;
/** `clickSfx` 没写本处音量时的默认。 */
export const OBJECT_EXAMINE_CLICK_SFX_DEFAULT_VOLUME = 0.55;

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

/** 解析物理标尺：静帧横向真实宽度（厘米，夹取）。 */
export function resolveObjectExaminePhysicalWidthCm(
  presentation: ObjectExamineStillPresentation,
): number {
  const v = presentation.physicalWidthCm;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return OBJECT_EXAMINE_DEFAULT_PHYSICAL_WIDTH_CM;
  }
  return Math.max(0.5, Math.min(2000, v));
}

/** 解析接触 AO 半径（厘米，夹取）。 */
export function resolveObjectExamineContactAoRadiusCm(
  presentation: ObjectExamineStillPresentation,
): number {
  const v = presentation.contactAoRadiusCm;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return OBJECT_EXAMINE_DEFAULT_CONTACT_AO_RADIUS_CM;
  }
  return Math.max(0, Math.min(OBJECT_EXAMINE_MAX_CONTACT_AO_RADIUS_CM, v));
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
  cloudShadow: { enabled: boolean; strength: number; speedCmPerSec: number };
  dust: { enabled: boolean; density: number; intensity: number; radiusCm: number };
  flyingFlies: {
    enabled: boolean;
    x: number | null;
    y: number | null;
    count: number;
    speedCmPerSec: number;
    roamRadiusCm: number;
    returnSec: number;
    lengthCm: number;
  };
  crawlers: {
    enabled: boolean;
    /** 父级开关原始语义；与是否存在已开启物种分开。 */
    parentEnabled: boolean;
    /** 原始值是否为结构化对象；供 F2 保真切换，区别于旧布尔 false/true。 */
    hasStructuredConfig: boolean;
    contactShadow: { enabled: boolean; intensity: number; radiusCm: number };
    terrain: {
      enabled: boolean;
      reliefCm: number;
      grooveFollow: number;
      climbSlowdown: number;
    };
    /** 蛆簇（原地蠕动，不受触发）。x/y 为 null 时运行时自动挑点。 */
    maggots: {
      enabled: boolean;
      clusters: Array<{
        x: number | null;
        y: number | null;
        count: number;
        radiusCm: number;
        lengthCm: number;
      }>;
    };
    /** 蜈蚣过场。intervalSec = 0 即没有蜈蚣。 */
    centipede: {
      enabled: boolean;
      /** 原始子项是否为结构化对象；intervalSec=0 时仍需保留速度/体长。 */
      hasStructuredConfig: boolean;
      intervalSec: number;
      speedCmPerSec: number;
      lengthCm: number;
    };
    /** 爬虫簇（点击惊散）。x/y 为 null 时运行时自动挑点。 */
    beetles: {
      enabled: boolean;
      x: number | null;
      y: number | null;
      count: number;
      radiusCm: number;
      lengthCm: number;
      regroupSec: number;
    };
  };
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
  const CLOUD_SPEED = OBJECT_EXAMINE_DEFAULT_CLOUD_SPEED_CM_S;
  const DUST_R = OBJECT_EXAMINE_DEFAULT_DUST_RADIUS_CM;
  const cloud =
    a.cloudShadow === true
      ? { enabled: true, strength: 0.22, speedCmPerSec: CLOUD_SPEED }
      : a.cloudShadow && typeof a.cloudShadow === 'object'
        ? {
            enabled: true,
            strength: clamp(
              typeof a.cloudShadow.strength === 'number' ? a.cloudShadow.strength : 0.22,
              0,
              1,
            ),
            speedCmPerSec: clamp(
              finiteNumber(a.cloudShadow.speedCmPerSec, CLOUD_SPEED),
              0.1,
              10,
            ),
          }
        : { enabled: false, strength: 0.22, speedCmPerSec: CLOUD_SPEED };
  const dust =
    a.dust === true
      ? { enabled: true, density: 1, intensity: 1, radiusCm: DUST_R }
      : a.dust && typeof a.dust === 'object'
        ? {
            enabled: true,
            density: clamp(typeof a.dust.density === 'number' ? a.dust.density : 1, 0.2, 3),
            intensity: clamp(
              typeof a.dust.intensity === 'number' ? a.dust.intensity : 1,
              0,
              3,
            ),
            radiusCm: clamp(finiteNumber(a.dust.radiusCm, DUST_R), 0.02, 8),
          }
        : { enabled: false, density: 1, intensity: 1, radiusCm: DUST_R };
  const flyingFlies = resolveFlyingFlies(a.flyingFlies);
  const crawlers = resolveCrawlers(a.crawlers);
  const headSway = resolveHeadSway(a.headSway);
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
  };
}

export type ResolvedObjectExamineFlyingFlies = ResolvedObjectExamineAmbience['flyingFlies'];
export type ResolvedObjectExamineCrawlers = ResolvedObjectExamineAmbience['crawlers'];

function resolveFlyingFlies(
  v: ObjectExamineFlyingFliesToggle | undefined,
): ResolvedObjectExamineFlyingFlies {
  const defaults = {
    x: null,
    y: null,
    count: 5,
    speedCmPerSec: OBJECT_EXAMINE_DEFAULT_FLY_SPEED_CM_S,
    roamRadiusCm: OBJECT_EXAMINE_DEFAULT_FLY_ROAM_RADIUS_CM,
    returnSec: 12,
    lengthCm: OBJECT_EXAMINE_DEFAULT_FLY_LENGTH_CM,
  };
  if (v === false) return { enabled: false, ...defaults };
  if (v === true) return { enabled: true, ...defaults };
  if (v && typeof v === 'object') {
    return {
      enabled: true,
      x: normPoint(v.x),
      y: normPoint(v.y),
      count: Math.round(clamp(finiteNumber(v.count, defaults.count), 1, 16)),
      speedCmPerSec: clamp(
        finiteNumber(v.speedCmPerSec, defaults.speedCmPerSec),
        1,
        200,
      ),
      roamRadiusCm: clamp(
        finiteNumber(v.roamRadiusCm, defaults.roamRadiusCm),
        1,
        200,
      ),
      returnSec: clamp(
        finiteNumber(v.returnSec, defaults.returnSec),
        0,
        60,
      ),
      lengthCm: clamp(finiteNumber(v.lengthCm, defaults.lengthCm), 0.2, 40),
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
    contactShadow: {
      enabled: false,
      intensity: 1,
      radiusCm: OBJECT_EXAMINE_DEFAULT_CRITTER_AO_RADIUS_CM,
    },
    terrain: {
      enabled: false,
      reliefCm: OBJECT_EXAMINE_DEFAULT_RELIEF_CM,
      grooveFollow: OBJECT_EXAMINE_DEFAULT_GROOVE_FOLLOW,
      climbSlowdown: OBJECT_EXAMINE_DEFAULT_CLIMB_SLOWDOWN,
    },
    maggots: { enabled: false, clusters: [] },
    centipede: {
      enabled: false,
      hasStructuredConfig: false,
      intervalSec: 0,
      speedCmPerSec: OBJECT_EXAMINE_DEFAULT_CENTIPEDE_SPEED_CM_S,
      lengthCm: OBJECT_EXAMINE_DEFAULT_CENTIPEDE_LENGTH_CM,
    },
    beetles: {
      enabled: false,
      x: null,
      y: null,
      count: 4,
      radiusCm: OBJECT_EXAMINE_DEFAULT_BEETLE_CLUSTER_RADIUS_CM,
      lengthCm: OBJECT_EXAMINE_DEFAULT_BEETLE_LENGTH_CM,
      regroupSec: 30,
    },
  };
  if (v === false || v === undefined) return off;

  let terrain: ResolvedObjectExamineCrawlers['terrain'] = {
    enabled: true,
    reliefCm: OBJECT_EXAMINE_DEFAULT_RELIEF_CM,
    grooveFollow: OBJECT_EXAMINE_DEFAULT_GROOVE_FOLLOW,
    climbSlowdown: OBJECT_EXAMINE_DEFAULT_CLIMB_SLOWDOWN,
  };
  const MAGGOT_R = OBJECT_EXAMINE_DEFAULT_MAGGOT_CLUSTER_RADIUS_CM;
  const MAGGOT_LEN = OBJECT_EXAMINE_DEFAULT_MAGGOT_LENGTH_CM;
  let contactShadow: ResolvedObjectExamineCrawlers['contactShadow'] = {
    enabled: true,
    intensity: 1,
    radiusCm: OBJECT_EXAMINE_DEFAULT_CRITTER_AO_RADIUS_CM,
  };

  // 蛆：默认自动两簇
  let maggots: ResolvedObjectExamineCrawlers['maggots'] = {
    enabled: true,
    clusters: [
      { x: null, y: null, count: 6, radiusCm: MAGGOT_R, lengthCm: MAGGOT_LEN },
      { x: null, y: null, count: 6, radiusCm: MAGGOT_R, lengthCm: MAGGOT_LEN },
    ],
  };
  // 蜈蚣：默认 24s 一次过场
  let centipede: ResolvedObjectExamineCrawlers['centipede'] = {
    enabled: true,
    hasStructuredConfig: false,
    intervalSec: 24,
    speedCmPerSec: OBJECT_EXAMINE_DEFAULT_CENTIPEDE_SPEED_CM_S,
    lengthCm: OBJECT_EXAMINE_DEFAULT_CENTIPEDE_LENGTH_CM,
  };
  // 爬虫簇：默认自动一簇
  let beetles: ResolvedObjectExamineCrawlers['beetles'] = {
    enabled: true,
    x: null,
    y: null,
    count: 4,
    radiusCm: OBJECT_EXAMINE_DEFAULT_BEETLE_CLUSTER_RADIUS_CM,
    lengthCm: OBJECT_EXAMINE_DEFAULT_BEETLE_LENGTH_CM,
    regroupSec: 30,
  };

  if (v && typeof v === 'object') {
    if (v.contactShadow === false) {
      contactShadow = { ...contactShadow, enabled: false };
    } else if (v.contactShadow && typeof v.contactShadow === 'object') {
      contactShadow = {
        enabled: true,
        intensity: clamp(finiteNumber(v.contactShadow.intensity, 1), 0, 2),
        radiusCm: clamp(
          finiteNumber(
            v.contactShadow.radiusCm,
            OBJECT_EXAMINE_DEFAULT_CRITTER_AO_RADIUS_CM,
          ),
          0,
          OBJECT_EXAMINE_MAX_CRITTER_AO_RADIUS_CM,
        ),
      };
    }
    if (v.terrain === false) {
      terrain = { ...terrain, enabled: false };
    } else if (v.terrain && typeof v.terrain === 'object') {
      const reliefCm = clamp(
        finiteNumber(v.terrain.reliefCm, OBJECT_EXAMINE_DEFAULT_RELIEF_CM),
        0,
        200,
      );
      terrain = {
        enabled: reliefCm > 0,
        reliefCm,
        grooveFollow: clamp(
          finiteNumber(v.terrain.grooveFollow, OBJECT_EXAMINE_DEFAULT_GROOVE_FOLLOW),
          0,
          1,
        ),
        climbSlowdown: clamp(
          finiteNumber(v.terrain.climbSlowdown, OBJECT_EXAMINE_DEFAULT_CLIMB_SLOWDOWN),
          0,
          2,
        ),
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
          radiusCm: clamp(finiteNumber(c.radiusCm, MAGGOT_R), 0.2, 100),
          lengthCm: clamp(finiteNumber(c.lengthCm, MAGGOT_LEN), 0.1, 40),
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
        speedCmPerSec: OBJECT_EXAMINE_DEFAULT_CENTIPEDE_SPEED_CM_S,
        lengthCm: OBJECT_EXAMINE_DEFAULT_CENTIPEDE_LENGTH_CM,
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
        speedCmPerSec: clamp(
          finiteNumber(
            v.centipede.speedCmPerSec,
            OBJECT_EXAMINE_DEFAULT_CENTIPEDE_SPEED_CM_S,
          ),
          1,
          200,
        ),
        lengthCm: clamp(
          finiteNumber(v.centipede.lengthCm, OBJECT_EXAMINE_DEFAULT_CENTIPEDE_LENGTH_CM),
          0.5,
          150,
        ),
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
        radiusCm: clamp(
          finiteNumber(v.beetles.radiusCm, OBJECT_EXAMINE_DEFAULT_BEETLE_CLUSTER_RADIUS_CM),
          0.2,
          100,
        ),
        lengthCm: clamp(
          finiteNumber(v.beetles.lengthCm, OBJECT_EXAMINE_DEFAULT_BEETLE_LENGTH_CM),
          0.1,
          40,
        ),
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
    terrain,
    maggots,
    centipede,
    beetles,
  };
}

function resolveHeadSway(
  v: ObjectExamineHeadSwayToggle | undefined,
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
