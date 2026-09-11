import type {
  AudioCueRef, BackgroundLayer, SceneData, SceneDepthConfig, SceneLightingDef, SceneTimeVariant,
  TimeTransition,
} from '../data/types';
import { sameAudioCue, sameAudioCueList } from '../data/audioCue';

/**
 * 这个表现档是否**声明了画面遮挡** —— 换装那一拍据此决定盖不盖黑幕。
 *
 * 与 `NpcScheduleSystem` 读同一句话的两面：有遮挡就不演 NPC 离场、也就该有幕可遮。
 * 之前只有前半句有人认，后半句（幕）谁都没盖，于是配了 `fade` 的时段推进照样硬切。
 *
 * 判定放这里而不是内联进 `Game`：档位含义漂了（比如哪天 `cut` 也算有遮挡）两处必须
 * 同时改，而它们隔着几千行——这正是"两个真相源"的经典形状。
 */
export function transitionIsCovered(t: TimeTransition | undefined): boolean {
  return t === 'timelapse' || t === 'fade';
}

/**
 * 「场景此刻长什么样」的**纯解析**（2026-08-30）。
 *
 * 制作人定的模型是：原画就是最终的光照，**夜靠换一张夜原画**得到，不靠调暗天光。
 * 于是「现在该显示哪张背景、配哪份环境参数」就成了一次纯函数查表：
 *
 *     场景顶层（白天基底） ⊕ timeVariants[当前时段]（只写差异）
 *
 * 放 utils 而不是 SceneManager 里，是为了让它能脱离引擎单测 —— 这一层的错（拿错背景、
 * 覆盖合并漏字段）在画面上只表现为"看着不太对"，靠肉眼回归成本极高。
 */

/** 一次解析的产物：场景在某个时段的完整外观。 */
export interface ResolvedSceneAppearance {
  backgrounds: BackgroundLayer[];
  /** 第一层背景的图名 —— 烘焙产物按它索引（见 `projectPaths.bakeKeyFromBackground`）。 */
  primaryBackgroundImage: string;
  lighting: SceneLightingDef | undefined;
  depthConfig: SceneDepthConfig | undefined;
  ambientSounds: AudioCueRef[] | undefined;
  bgm: AudioCueRef | undefined;
  filterId: string | undefined;
  /** 实际命中的时段 id；空串 = 用的是顶层基底（没开日夜 / 该时段没配变体）。 */
  phase: string;
}

/**
 * 合并环境参数：`base` 之上盖 `over` 的**顶层键**。
 *
 * 只做一层：`sky` / `fog` / `display` 这些块整块替换，不逐字段深合并。
 * 理由是这些块内部彼此耦合（display 的 ev 与 tonemap 一起调才有意义），
 * 半块覆盖出来的组合作者根本没看过 —— 宁可让他整块写全。
 *
 * ⚠ `lights` 永远取 base：灯是实体、按各自 `phases` 过滤，不在时段变体里换整组。
 */
export function mergeSceneLighting(
  base: SceneLightingDef | undefined,
  over: SceneTimeVariant['lighting'] | undefined,
): SceneLightingDef | undefined {
  if (!base) return undefined;          // 没有基底就没有统一光影，覆盖也无处可盖
  if (!over) return base;
  const merged = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (k === 'lights') continue;       // 见上：灯不走这条路
    if (v !== undefined) merged[k] = v;
  }
  return merged as unknown as SceneLightingDef;
}

/**
 * 解析场景在 `phase` 时段的外观。
 *
 * `phase` 传空串 = 不做时段解析（等价于没开日夜），直接返回顶层基底。
 * 场景没开 `dayNight.enabled` 时同样只返回基底 —— 时段归属整套不生效，
 * 与 `SceneManager.entityInPhase` 的总闸口径一致。
 */
export function resolveSceneAppearance(
  scene: SceneData,
  phase: string,
): ResolvedSceneAppearance {
  const base: ResolvedSceneAppearance = {
    backgrounds: scene.backgrounds ?? [],
    primaryBackgroundImage: scene.backgrounds?.[0]?.image ?? 'background.png',
    lighting: scene.lighting,
    depthConfig: scene.depthConfig,
    ambientSounds: scene.ambientSounds,
    // ⚠ 基底要取场景自己的 bgm。写成 undefined 会让「白天有 BGM、夜里没配」被判成
    //   变了（undefined → undefined 反而不变，但白天的值被吞掉），而且写回时漏它 =
    //   夜的 BGM 是死数据、还白赔一次全场景重载（审查抓到）。
    bgm: scene.bgm,
    filterId: scene.filterId,
    phase: '',
  };
  const on = scene.dayNight?.enabled === true;
  const v = on && phase ? scene.timeVariants?.[phase] : undefined;
  if (!v) return base;

  const backgrounds = v.backgrounds?.length ? v.backgrounds : base.backgrounds;
  return {
    backgrounds,
    primaryBackgroundImage: backgrounds[0]?.image ?? base.primaryBackgroundImage,
    lighting: mergeSceneLighting(base.lighting, v.lighting),
    depthConfig: v.depthConfig ?? base.depthConfig,
    ambientSounds: v.ambientSounds ?? base.ambientSounds,
    bgm: v.bgm ?? base.bgm,
    filterId: v.filterId ?? base.filterId,
    phase,
  };
}

/**
 * 两次解析在**渲染上是否等价** —— 时段推进时据此决定要不要换装。
 *
 * 只比会改变画面/几何的项。`phase` 本身不比：同一场景两个时段配了同一张图、
 * 同一份环境，那就不该为了"时段名变了"白白重载一次背景纹理与烘焙载荷。
 */
export function sameAppearance(a: ResolvedSceneAppearance, b: ResolvedSceneAppearance): boolean {
  if (a.primaryBackgroundImage !== b.primaryBackgroundImage) return false;
  if (a.backgrounds.length !== b.backgrounds.length) return false;
  for (let i = 0; i < a.backgrounds.length; i++) {
    if (a.backgrounds[i]?.image !== b.backgrounds[i]?.image) return false;
  }
  if (a.filterId !== b.filterId) return false;
  // ⚠ 不能用 `!==` 比：带本处音量的引用每次解析都是新对象，
  //   引用比恒判成「变了」→ 每次时段推进都白赔一次全场景重载（背景闪一下）。
  if (!sameAudioCue(a.bgm, b.bgm)) return false;
  if (!sameAudioCueList(a.ambientSounds, b.ambientSounds)) return false;
  if (JSON.stringify(a.lighting ?? null) !== JSON.stringify(b.lighting ?? null)) return false;
  if (JSON.stringify(a.depthConfig ?? null) !== JSON.stringify(b.depthConfig ?? null)) return false;
  return true;
}

/**
 * 把某时段的外观**就地写回**场景对象。
 *
 * 存在的理由：场景加载链上有四个消费点（资源清单 / 背景 / 深度 / 光照）各自读
 * `sceneData` 的字段。让它们各自再解析一遍时段就有四个真相源，漏一处就是
 * 「背景换了但烘焙没换」这种最难查的错。所以在**装任何资源之前**改一次，下游照旧。
 *
 * ⚠ 只对 `loadSceneData` 返回的**深拷贝**用（见其实现的 `JSON.parse(JSON.stringify(...))`），
 *   直接改 AssetManager 的 JSON 缓存会污染后续所有加载。
 *
 * 返回实际命中的时段 id（空串 = 用的顶层基底）。
 */
export function applySceneAppearance(scene: SceneData, phase: string): string {
  const r = resolveSceneAppearance(scene, phase);
  if (!r.phase) return '';                 // 没开日夜 / 该时段没配变体 → 一个字段都不动
  scene.backgrounds = r.backgrounds;
  if (r.lighting) scene.lighting = r.lighting;
  if (r.depthConfig) scene.depthConfig = r.depthConfig;
  if (r.ambientSounds) scene.ambientSounds = r.ambientSounds;
  if (r.bgm !== undefined) scene.bgm = r.bgm;
  if (r.filterId !== undefined) scene.filterId = r.filterId;
  return r.phase;
}
