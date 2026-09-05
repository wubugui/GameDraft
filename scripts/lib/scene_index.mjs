/**
 * 场景索引 `assets/scene_index.json` —— **派生物，不是清单**。
 *
 * 游戏里一切"列出全部场景"的地方（Dev 菜单、F2「场景」页、打包后的 dev 档）都读它；
 * 它本身从 `public/assets/scenes/*.json` 现算：开发服由 vite 中间件按请求现算，
 * 打包由 scripts/package.mjs 在装配时写进产物。仓库里**没有**这个文件，也不该有——
 * 一旦有人手工维护，新建场景就又得"记得去加一行"，而漏掉的那个场景只是从调试菜单里
 * 消失，没有任何报错。
 *
 * 两处调用共用这一份生成器，索引的形状只在这里定义一次。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 相对产物根 / 站点根的路径；运行时 `src/dev/sceneIndex.ts` 的 SCENE_INDEX_URL 与之同名 */
export const SCENE_INDEX_REL = 'assets/scene_index.json';

/**
 * 一条索引项。场景 id 以**文件名**为准：JSON 里的 id 与文件名不一致时，
 * 运行时能加载的是文件名那个（AssetManager 按 `scenes/<id>.json` 拼路径）。
 */
export function sceneIndexEntry(id, raw) {
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : id;
  const sp = rec.spawnPoints;
  const spawnPoints = sp && typeof sp === 'object' && !Array.isArray(sp) ? Object.keys(sp) : [];
  return { id, name, spawnPoints };
}

/**
 * 枚举一个 scenes 目录 → `{ scenes: [...] }`，按显示名中文排序。
 * 目录不存在 → 空索引；单个坏 JSON → 只有 id 的条目（一个文件坏了不该让整张索引消失）。
 */
export async function buildSceneIndex(scenesDir) {
  let files = [];
  try {
    files = (await readdir(scenesDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return { scenes: [] };
  }
  const scenes = await Promise.all(
    files.map(async (file) => {
      const id = file.slice(0, -'.json'.length);
      try {
        return sceneIndexEntry(id, JSON.parse(await readFile(join(scenesDir, file), 'utf-8')));
      } catch {
        return { id, name: id, spawnPoints: [] };
      }
    }),
  );
  scenes.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { scenes };
}

/** 打包用：按产物目录里**已落地**的 assets/scenes 写出索引文件；返回场景数 */
export async function writeSceneIndex(gameDir) {
  const index = await buildSceneIndex(join(gameDir, 'assets', 'scenes'));
  await mkdir(join(gameDir, 'assets'), { recursive: true });
  const payload = { generatedBy: 'scripts/package.mjs', ...index };
  await writeFile(
    join(gameDir, ...SCENE_INDEX_REL.split('/')),
    JSON.stringify(payload, null, 2) + '\n',
    'utf-8',
  );
  return index.scenes.length;
}
