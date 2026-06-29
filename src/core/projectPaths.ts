/**
 * GameDraft 运行时统一资源 URL 入口。
 *
 * 迁移后约定（与 Python 侧 `tools/editor/shared/project_paths.py` 一致）：
 * - `public/assets`    : 仅文本/配置（data、scenes JSON、dialogues、filters）。
 * - `public/resources/runtime` : 所有运行时媒体（图片、音频、动画包、场景媒体、小玩法贴图）。
 * - `resources/editor_projects` : 工具/编辑器工程数据，运行时一般不会读到。
 *
 * 所有需要拼接资源 URL 的运行时模块都应当从本文件取入口，不再硬编码 `/assets/...`
 * 或 `/resources/runtime/...` 字符串。
 */

const ASSETS_PREFIX = '/assets/';
const RUNTIME_PREFIX = '/resources/runtime/';

/** 站点根下文本/配置 URL 前缀，例如 `/assets/data/strings.json`。 */
export const TEXT_URL_PREFIX = ASSETS_PREFIX;
/** 站点根下媒体 URL 前缀，例如 `/resources/runtime/images/x.png`。 */
export const MEDIA_URL_PREFIX = RUNTIME_PREFIX;

/** 文本配置 JSON 子目录 URL（不含后缀）。 */
export const TEXT_URLS = {
  dataDir: '/assets/data',
  scenesDir: '/assets/scenes',
  dialoguesDir: '/assets/dialogues',
  filtersDir: '/assets/data/filters',
  archiveDir: '/assets/data/archive',
  cutscenesIndex: '/assets/data/cutscenes/index.json',
  gameConfig: '/assets/data/game_config.json',
  flagRegistry: '/assets/data/flag_registry.json',
  smellProfiles: '/assets/data/smell_profiles.json',
  overlayImages: '/assets/data/overlay_images.json',
  scenarios: '/assets/data/scenarios.json',
  documentReveals: '/assets/data/document_reveals.json',
  audioConfig: '/assets/data/audio_config.json',
  strings: '/assets/data/strings.json',
  items: '/assets/data/items.json',
  quests: '/assets/data/quests.json',
  encounters: '/assets/data/encounters.json',
  rules: '/assets/data/rules.json',
  shops: '/assets/data/shops.json',
  mapConfig: '/assets/data/map_config.json',
  waterMinigamesIndex: '/assets/data/water_minigames/index.json',
  sugarWheelIndex: '/assets/data/sugar_wheel/index.json',
  paperCraftIndex: '/assets/data/paper_craft/index.json',
  narrativeGraphs: '/assets/data/narrative_graphs.json',
  pressureHolds: '/assets/data/pressure_holds.json',
  signalCues: '/assets/data/signal_cues.json',
} as const;

/** 媒体根 URL 子目录（不带尾斜杠）。 */
export const MEDIA_URLS = {
  imagesDir: '/resources/runtime/images',
  audioDir: '/resources/runtime/audio',
  animationDir: '/resources/runtime/animation',
  scenesDir: '/resources/runtime/scenes',
  illustrationsDir: '/resources/runtime/images/illustrations',
  backgroundsDir: '/resources/runtime/images/backgrounds',
  npcsDir: '/resources/runtime/images/npcs',
  charactersDir: '/resources/runtime/images/characters',
  minigamesDir: '/resources/runtime/images/minigames',
  paperCraftPartsDir: '/resources/runtime/images/minigames/paper_craft/parts',
} as const;

function trimLeadingSlashes(s: string): string {
  let i = 0;
  while (i < s.length && s[i] === '/') i++;
  return s.slice(i);
}

function joinPosix(base: string, ...rest: string[]): string {
  let out = base.endsWith('/') ? base.slice(0, -1) : base;
  for (const part of rest) {
    if (!part) continue;
    const p = part.startsWith('/') ? part.slice(1) : part;
    out = `${out}/${p}`;
  }
  return out;
}

/** 是否为媒体 URL（落在 runtime 根下）。 */
export function isMediaUrl(url: string): boolean {
  if (!url) return false;
  return url.startsWith(RUNTIME_PREFIX) || url.startsWith(RUNTIME_PREFIX.slice(1));
}

/** 是否为文本/配置 URL（落在 assets 根下）。 */
export function isTextUrl(url: string): boolean {
  if (!url) return false;
  return url.startsWith(ASSETS_PREFIX) || url.startsWith(ASSETS_PREFIX.slice(1));
}

/** 场景 JSON URL：`/assets/scenes/<sceneId>.json`。 */
export function sceneJsonUrl(sceneId: string): string {
  const sid = (sceneId ?? '').trim();
  if (!sid) throw new Error('sceneJsonUrl: sceneId required');
  return `${TEXT_URLS.scenesDir}/${sid}.json`;
}

/** 图对话 JSON URL：`/assets/dialogues/graphs/<graphId>.json`。 */
export function dialogueGraphJsonUrl(graphId: string): string {
  const gid = (graphId ?? '').trim();
  if (!gid) throw new Error('dialogueGraphJsonUrl: graphId required');
  return `${TEXT_URLS.dialoguesDir}/graphs/${gid}.json`;
}

/** 滤镜 JSON URL：`/assets/data/filters/<filterId>.json`。 */
export function filterJsonUrl(filterId: string): string {
  const id = (filterId ?? '').trim();
  if (!id) throw new Error('filterJsonUrl: filterId required');
  return `${TEXT_URLS.filtersDir}/${id}.json`;
}

/** data 子目录下的 JSON URL；entry.file 已是绝对路径时原样返回。 */
export function dataSubdirJsonUrl(subdir: string, file: string): string {
  const name = (file ?? '').trim();
  if (!name) throw new Error('dataSubdirJsonUrl: file required');
  if (name.startsWith('/')) return name;
  const dir = (subdir ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!dir) throw new Error('dataSubdirJsonUrl: subdir required');
  return joinPosix(TEXT_URLS.dataDir, dir, name);
}

/** 场景媒体子目录：`/resources/runtime/scenes/<sceneId>`。 */
export function sceneRuntimeDirUrl(sceneId: string): string {
  const sid = (sceneId ?? '').trim();
  if (!sid) throw new Error('sceneRuntimeDirUrl: sceneId required');
  return `${MEDIA_URLS.scenesDir}/${sid}`;
}

/**
 * 把场景 JSON 中相对资源（短文件名或子路径）解析成完整媒体 URL：
 * `<scene_runtime_dir>/<ref>`。当 ref 是完整 URL（`/resources/...`、`/assets/...`、
 * 绝对 http(s) 或本地绝对路径）时原样返回；`/assets/...` 媒体引用是不允许的，会抛错。
 */
export function sceneRuntimeAssetUrl(sceneId: string, ref: string): string {
  const r = (ref ?? '').trim();
  if (!r) throw new Error('sceneRuntimeAssetUrl: ref required');
  if (r.startsWith('http://') || r.startsWith('https://')) return r;
  if (r.startsWith(ASSETS_PREFIX)) {
    throw new Error(`sceneRuntimeAssetUrl: 媒体不可指向 assets 根: ${r}`);
  }
  if (r.startsWith(RUNTIME_PREFIX)) return r;
  if (r.startsWith('resources/')) return `/${r}`;
  if (r.startsWith('assets/')) {
    throw new Error(`sceneRuntimeAssetUrl: 媒体不可指向 assets 根: ${r}`);
  }
  // 本地绝对路径（用户机器上的） - 直接返回
  if (/^[a-zA-Z]:[\\/]/.test(r) || r.startsWith('/')) return r;
  return `${sceneRuntimeDirUrl(sceneId)}/${trimLeadingSlashes(r)}`;
}

/**
 * 把短名（例如 `images/backgrounds/x.png` 或 `audio/y.wav`）解析为媒体 URL，
 * 与 `[img:...]` 和档案插图等历史短名一致：短名一律落在 `runtime` 下。
 *
 * 已经是 `/resources/runtime/...` 完整 URL 的原样返回；指向 `/assets/...`
 * 的媒体引用会抛错（迁移后媒体不再允许落在 assets 根下）。
 */
export function mediaUrlFromShortPath(refIn: string): string {
  const ref = (refIn ?? '').trim();
  if (!ref) throw new Error('mediaUrlFromShortPath: ref required');
  if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
  if (ref.startsWith(RUNTIME_PREFIX)) return ref;
  if (ref.startsWith('resources/runtime/')) return `/${ref}`;
  if (ref.startsWith(ASSETS_PREFIX) || ref.startsWith('assets/')) {
    throw new Error(`mediaUrlFromShortPath: 媒体不可指向 assets 根: ${ref}`);
  }
  // 本地绝对路径直出
  if (/^[a-zA-Z]:[\\/]/.test(ref)) return ref;
  if (ref.startsWith('/')) {
    // 形如 `/foo/bar.png` 但不是 runtime/assets 前缀；保守拒绝，避免错跑到 vite 站点根下其它路径
    throw new Error(`mediaUrlFromShortPath: 不识别的绝对 URL: ${ref}`);
  }
  return joinPosix(MEDIA_URLS.imagesDir, ref.replace(/^images\//, ''));
}

/**
 * 与 `mediaUrlFromShortPath` 类似，但允许传入纯子路径 + 已知的媒体子目录（图片、音频等）。
 * 例如 `mediaUrlForRoot('audio', 'bgm/x.wav')` →
 * `/resources/runtime/audio/bgm/x.wav`。
 */
export function mediaUrlForRoot(
  rootKind: 'images' | 'audio' | 'animation' | 'scenes',
  ref: string,
): string {
  const r = (ref ?? '').trim();
  if (!r) throw new Error('mediaUrlForRoot: ref required');
  if (r.startsWith(RUNTIME_PREFIX)) return r;
  if (r.startsWith(ASSETS_PREFIX) || r.startsWith('assets/')) {
    throw new Error(`mediaUrlForRoot: 媒体不可指向 assets 根: ${r}`);
  }
  switch (rootKind) {
    case 'images':
      return joinPosix(MEDIA_URLS.imagesDir, r);
    case 'audio':
      return joinPosix(MEDIA_URLS.audioDir, r);
    case 'animation':
      return joinPosix(MEDIA_URLS.animationDir, r);
    case 'scenes':
      return joinPosix(MEDIA_URLS.scenesDir, r);
  }
}
