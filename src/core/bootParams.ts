import { LOAD_SLOT_PARAM, NEW_GAME_PARAM, TITLE_BOOT_PARAM } from './EventBridge';

/**
 * 启动参数的来源合并：**地址栏** ∪ **打包时烘进产物的缺省**。
 *
 * ## 为什么需要烘进去的那一份
 *
 * 游戏的引导态一直靠 URL 参数表达（`?screen_title` 停标题、`?load_slot=N` 读档、
 * dev 直达族），而**双击 exe / 打开产物首页时地址栏是干净的**。于是发行版每次启动
 * 都直接开一局新游戏——玩家走不到标题上那个「继续」，存档存在却没有入口去读，
 * 看起来就像存档没了。dev 档同理：想让它从某个 devScene 起，也没地方说。
 *
 * 所以打包器按档位把一串 query 写进 `boot.js`（见 `scripts/package.mjs`），
 * 运行时把它当**缺省**用。配置在 `tools/build/build_config.json`。
 *
 * ## 为什么必须"只在没有显式引导参数时"生效
 *
 * 这是这段代码唯一微妙的地方。游戏用 **URL 参数 + 整页重启**换局
 * （`EventBridge.restartPage`），而"开新局"这一条历史上是靠**参数缺席**表达的。
 * 如果缺省无条件生效，玩家在标题点「新游戏」→ URL 被清空 → 缺省又把他送回标题，
 * 死循环。
 *
 * 修法有两半，缺一不可：
 * 1. 「新游戏」那次重启改成带一个显式标记 `?new_game=1`（见 `EventBridge`）；
 * 2. 这里只在**一个引导参数都没有**时才套用缺省。
 *
 * 于是语义从"靠参数缺席来暗示"变成了显式的：干净地址栏 = 首次启动。
 */

/** 会让"这是一次显式引导"成立的参数。任意一个出现，烘进来的缺省就整体让位。 */
const EXPLICIT_BOOT_PARAMS = [
  TITLE_BOOT_PARAM,
  LOAD_SLOT_PARAM,
  NEW_GAME_PARAM,
  // dev 直达族：给了其中任何一个，都说明调用方明确知道自己要去哪
  'mode',
  'devScene',
  'dev_scene',
  'narrativeWarp',
  'narrative_warp',
  'play_cutscene',
  'waterPreview',
  'sugarWheelPreview',
  'paperCraftPreview',
];

/** 地址栏里有没有人明确指定过引导态。 */
export function hasExplicitBoot(params: URLSearchParams): boolean {
  return EXPLICIT_BOOT_PARAMS.some((k) => params.has(k));
}

/**
 * 合并出最终的启动参数。
 *
 * @param search 地址栏的 query（`window.location.search`）
 * @param baked 打包时烘进来的缺省 query 串；非字符串/空串一律当没有
 */
export function resolveBootParams(search: string, baked: unknown): URLSearchParams {
  const params = new URLSearchParams(search);
  if (typeof baked !== 'string' || !baked.trim()) return params;
  if (hasExplicitBoot(params)) return params;

  let defaults: URLSearchParams;
  try {
    defaults = new URLSearchParams(baked.trim().replace(/^\?/, ''));
  } catch {
    console.warn('bootParams: 烘进来的启动缺省解析失败，忽略', baked);
    return params;
  }
  // 只补，不覆盖：地址栏上的非引导参数（比如某次排障加的自定义 flag）保持原样
  for (const [k, v] of defaults) {
    if (!params.has(k)) params.set(k, v);
  }
  return params;
}
