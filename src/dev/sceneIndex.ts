/**
 * 全量场景索引 —— 派生物，不是清单。
 *
 * 一切"列出全部场景"的调试入口（Dev 菜单、F2「场景」页）都从这里取。索引文件
 * `/assets/scene_index.json` 仓库里没有：开发服由 vite 中间件按请求从
 * `public/assets/scenes/*.json` 现算，打包由 `scripts/package.mjs` 装配时写进产物，
 * 两边共用 `scripts/lib/scene_index.mjs` 同一份生成器。新建场景不需要登记到任何地方。
 *
 * 拿不到（静态托管漏了文件、网络错）时返回空数组，调用方退回"地图节点 + game_config"
 * 那份派生清单——那份只覆盖玩家可走的节点，梦境/演出/测试场景不在其中，所以只当兜底。
 */

export const SCENE_INDEX_URL = '/assets/scene_index.json';

export interface SceneIndexEntry {
  id: string;
  name: string;
  /** 场景 JSON 的 spawnPoints 键；无则空数组（走场景默认 spawnPoint） */
  spawnPoints: string[];
}

/** 把索引文件的 JSON 收成干净的条目：缺 id 的丢掉、缺 name 的用 id、spawnPoints 只留非空串 */
export function normalizeSceneIndex(data: unknown): SceneIndexEntry[] {
  const scenes = (data as { scenes?: unknown } | null)?.scenes;
  if (!Array.isArray(scenes)) return [];
  const out: SceneIndexEntry[] = [];
  for (const raw of scenes) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as { id?: unknown; name?: unknown; spawnPoints?: unknown };
    const id = String(rec.id ?? '').trim();
    if (!id) continue;
    const name = String(rec.name ?? '').trim() || id;
    const spawnPoints = Array.isArray(rec.spawnPoints)
      ? rec.spawnPoints.map((s) => String(s)).filter(Boolean)
      : [];
    out.push({ id, name, spawnPoints });
  }
  return out;
}

/**
 * 取索引；任何失败都返回空数组（调用方据此退回派生清单）。
 *
 * 按 content-type 判而不只看状态码：dev server 对不存在的路径可能回 200 + index.html
 * （optional-asset-probe 卡的老坑），当成 JSON 去解析只会得到一个空索引外加一条噪音。
 */
export async function fetchSceneIndex(fetchImpl: typeof fetch = fetch): Promise<SceneIndexEntry[]> {
  try {
    const r = await fetchImpl(SCENE_INDEX_URL, { cache: 'no-store' });
    if (!r.ok) return [];
    const ct = r.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('json')) return [];
    return normalizeSceneIndex(await r.json());
  } catch {
    return [];
  }
}
