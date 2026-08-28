import type { GameConfig, PlayerAvatarConfig, TextPaletteEntry } from '../data/types';

/**
 * 把 `game_config.json` 读到的内容并进运行时配置。
 *
 * ## 为什么不是白名单
 *
 * 这段逻辑原来是**逐键白名单**：每个字段手写一行 `if (cfg.x) target.x = cfg.x`。
 * 那个形状的问题不在于写起来烦，在于**它把正确性押在"有人记得来这里加一行"上**，
 * 而漏掉的后果是完全静默的：类型有、编辑器有、校验器有、消费端也有，唯独没人把值搬进来，
 * 于是消费端恒收 `undefined`，作者配了半天一点反应都没有。
 *
 * 这不是假设——代码注释里记录在案的就有四次：`dayNight`、`playerAvatar.portraitSlug`、
 * `playerActs`、`emoteBubbleScale`。第五次只是时间问题。
 *
 * ## 现在的形状
 *
 * **默认整包合并**：JSON 里出现过的键一律采用，新增字段自动生效，不用来这里登记。
 * 只有**需要校验或归一**的字段才在 {@link NORMALIZERS} 里登记一条——
 * 于是"漏登记"最坏的后果从"配置整个失效"降级成"少一道校验"。
 *
 * 另一半改进：**校验不通过时会 warn**。以前 `emoteBubbleScale: "大"` 这种是静默忽略的，
 * 和"没配"长得一模一样。
 */

/** 归一化器：返回 `undefined` = 这个值不可用，保持原值不动。 */
type Normalizer = (raw: unknown, prev: unknown) => unknown;

/** 非空字符串才认——空串不该把缺省顶掉（原 `if (cfg.x)` 的语义）。 */
const nonEmptyString: Normalizer = (raw) => (typeof raw === 'string' && raw.trim() ? raw : undefined);

/** 任意字符串都认，包括空串（用于"显式清空"有意义的字段）。 */
const anyString: Normalizer = (raw) => (typeof raw === 'string' ? raw : undefined);

const finiteNumber: Normalizer = (raw) => (
  typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
);

const positiveNumber: Normalizer = (raw) => (
  typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined
);

const boolOnly: Normalizer = (raw) => (typeof raw === 'boolean' ? raw : undefined);

/** 对象浅拷：不让运行时配置和刚 load 出来的 JSON 共享引用。 */
const objectClone: Normalizer = (raw) => (
  raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as object) } : undefined
);

const sizePair: Normalizer = (raw) => {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as { width?: unknown; height?: unknown };
  return typeof o.width === 'number' && typeof o.height === 'number'
    ? { width: o.width, height: o.height }
    : undefined;
};

const paletteList: Normalizer = (raw) => (
  Array.isArray(raw) ? raw.map((e) => ({ ...(e as TextPaletteEntry) })) : undefined
);

/**
 * `playerAvatar` 逐子字段合并，不是整块替换：JSON 里只写了 `portraitSlug` 时，
 * `animManifest` 要保住缺省的那份，否则主角会没有动画包。
 */
const playerAvatarMerge: Normalizer = (raw, prev) => {
  if (!raw || typeof raw !== 'object') return undefined;
  const incoming = raw as PlayerAvatarConfig;
  const base = (prev ?? {}) as PlayerAvatarConfig;
  return {
    animManifest: incoming.animManifest ?? base.animManifest,
    stateMap: incoming.stateMap ? { ...incoming.stateMap } : base.stateMap,
    portraitSlug: incoming.portraitSlug ?? base.portraitSlug,
  } satisfies PlayerAvatarConfig;
};

/**
 * 需要校验/归一的字段。**没登记的按"存在即采用（对象浅拷）"合并**。
 *
 * 往 `GameConfig` 加字段时：只有当它需要额外校验才来这里加一条；不加也能生效。
 */
const NORMALIZERS: Partial<Record<keyof GameConfig, Normalizer>> = {
  // 三个必填项：空串不许顶掉缺省
  initialScene: nonEmptyString,
  initialQuest: nonEmptyString,
  fallbackScene: nonEmptyString,
  // 这两个允许显式空串（"配了但就是不播"与"没配"是两回事）
  initialCutscene: anyString,
  initialCutsceneDoneFlag: anyString,

  viewport: sizePair,
  windowSize: sizePair,
  playerAvatar: playerAvatarMerge,
  playerActs: objectClone,
  entityLighting: objectClone,
  health: objectClone,
  dayNight: objectClone,
  textPalette: paletteList,

  emoteBubbleScale: finiteNumber,
  entityPixelDensityMatch: boolOnly,
  entityPixelDensityMatchBlurScale: positiveNumber,
};

/**
 * 不由本函数合并的键。
 *
 * `startupFlags` 不是"配置值"而是**一次副作用**（把初始 flag 写进 FlagStore），
 * 而且 dev 模式下刻意整块跳过。语义在 `Game.loadGameConfig` 里，不在这。
 */
const SIDE_EFFECT_KEYS = new Set<string>(['startupFlags']);

/** 默认合并：能浅拷的浅拷，其余直取。 */
function defaultMerge(raw: unknown): unknown {
  if (Array.isArray(raw)) return [...raw];
  if (raw && typeof raw === 'object') return { ...(raw as object) };
  return raw;
}

/**
 * 把 `incoming` 并进 `target`（原地修改）。
 *
 * @returns 被校验挡下的键（值存在但形状不对）——调用方据此 warn，
 *          免得"配了没生效"和"没配"长得一样。
 */
export function mergeGameConfig(
  target: GameConfig,
  incoming: Partial<GameConfig> | null | undefined,
): { rejected: string[] } {
  const rejected: string[] = [];
  if (!incoming || typeof incoming !== 'object') return { rejected };

  for (const [key, raw] of Object.entries(incoming)) {
    if (raw === undefined || SIDE_EFFECT_KEYS.has(key)) continue;
    const normalize = NORMALIZERS[key as keyof GameConfig];
    const next = normalize
      ? normalize(raw, (target as unknown as Record<string, unknown>)[key])
      : defaultMerge(raw);
    if (next === undefined) {
      rejected.push(key);
      continue;
    }
    (target as unknown as Record<string, unknown>)[key] = next;
  }
  return { rejected };
}

/** 测试用：暴露登记了归一化器的键，供"字段覆盖度"用例比对。 */
export const __NORMALIZED_KEYS = Object.keys(NORMALIZERS);
/** 测试用：不参与合并的键。 */
export const __SIDE_EFFECT_KEYS = [...SIDE_EFFECT_KEYS];
