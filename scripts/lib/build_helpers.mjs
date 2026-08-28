/**
 * 打包管线里那几段**判对错的纯逻辑**。
 *
 * 抽出来不是为了复用（只有两个调用方），是为了**能测**：护栏、路径校验、引用改写
 * 这类代码一旦错了，后果是递归删掉工作目录、把服务开成任意读文件、或者整包静音，
 * 而它们全都藏在脚本主流程里、跑一次要几分钟、错了也不一定当场看得出来。
 *
 * 这里的函数一律纯函数：给输入出判断，不碰磁盘、不发请求。
 * 单测见 `scripts/lib/build_helpers.test.mjs`。
 */

import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// ------------------------------------------------------------ 产物目录护栏

/**
 * `--out` 指的地方能不能当产物根。
 *
 * 产物根会被 `rmSync(recursive, force)` 删掉重建，所以这不是"规范一下路径"，
 * 是**删之前必须过的闸**：`--out .` 递归删当前目录、`--out public` 删掉 2.9 GB
 * 素材树、`--out` 漏了值还会因为参数解析返回布尔而在 cwd 下建一个叫 `true` 的目录。
 *
 * @returns `{ ok: true, abs }` 或 `{ ok: false, abs, reason }`
 */
export function checkStagingDir(releaseRoot, out) {
  const abs = resolve(out);
  const rel = relative(resolve(releaseRoot), abs);
  const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  return inside
    ? { ok: true, abs }
    : { ok: false, abs, reason: `必须落在 ${resolve(releaseRoot)} 之下（这个目录会被递归删除后重建）` };
}

// ------------------------------------------------------ 发布输出目录

/** 上一次构建留在输出目录里的标记文件。它的存在 = "这个目录是我建的，可以覆盖"。 */
export const BUILD_MARKER = '.gamedraft-build.json';

/**
 * 输出目录**路径本身**安不安全（不看磁盘）。
 *
 * 这个目录会被清空重写，而它是每次调用传进来的——手滑传成仓库根或者盘符根，
 * 后果不可逆。所以先做一遍与磁盘无关的路径体检。
 *
 * @returns `{ ok: true }` 或 `{ ok: false, reason }`
 */
export function checkOutputPath(outDir, repoRoot) {
  if (typeof outDir !== 'string' || !outDir.trim()) {
    return { ok: false, reason: '没给输出目录' };
  }
  const abs = resolve(outDir);
  const root = resolve(repoRoot);

  // 盘符根 / 文件系统根：`resolve` 之后 dirname 等于自身
  if (dirname(abs) === abs) {
    return { ok: false, reason: `不能是盘符/文件系统根：${abs}` };
  }
  if (abs === root) {
    return { ok: false, reason: '不能是仓库根目录' };
  }
  // 仓库根的祖先：清它等于连仓库一起清
  const rootRel = relative(abs, root);
  if (rootRel && !rootRel.startsWith('..') && !isAbsolute(rootRel)) {
    return { ok: false, reason: `是仓库根的上级目录，清它会连仓库一起清：${abs}` };
  }
  // 仓库内的源码/数据树
  const inRepo = relative(root, abs);
  if (inRepo && !inRepo.startsWith('..') && !isAbsolute(inRepo)) {
    const top = inRepo.split(/[/\\]/)[0];
    const PROTECTED = ['public', 'src', 'src-tauri', 'tools', 'resources', 'scripts', 'agent_docs', 'docs', 'config', '.git'];
    if (PROTECTED.includes(top)) {
      return { ok: false, reason: `不能落在仓库的源码/数据目录里：${top}/` };
    }
  }
  return { ok: true, abs };
}

/**
 * 目录当前状态该怎么处置。
 *
 * @param state `'missing'` | `'empty'` | `'previous-build'`（有构建标记）| `'foreign'`（有别的东西）
 * @param force 显式要求覆盖
 */
export function outputDirDisposition(state, { force = false } = {}) {
  switch (state) {
    case 'missing':
      return { ok: true, action: 'create' };
    case 'empty':
      return { ok: true, action: 'use' };
    case 'previous-build':
      return { ok: true, action: 'overwrite' };
    case 'foreign':
      return force
        ? { ok: true, action: 'overwrite' }
        : {
          ok: false,
          reason: `目录里有东西，但不是上一次构建留下的（没有 ${BUILD_MARKER}）。`
            + '为防手滑清掉别的目录，这里不自动覆盖；确认无误就加 --force。',
        };
    default:
      return { ok: false, reason: `未知目录状态：${state}` };
  }
}

// -------------------------------------------------------- 静态服务路径校验

/**
 * 把请求路径安全地解析到产物目录下。
 *
 * **必须同时按 `/` 和 `\` 分段。** 只按 `/` 分的话，`..\..\secret.txt`
 * （可以用 `%5C` 编码送进来）会被当成一个单段、不等于 `..`、直接放行，
 * 而 Windows 的 `path.join` 认得 `\`，于是逃出产物目录 —— 挡的只是 POSIX 那一半。
 *
 * 解析完再确认落点仍在根内，防住上面没想到的形态。
 *
 * @returns `{ ok: true, disk }` 或 `{ ok: false }`
 */
export function safeStaticPath(gameDir, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : String(urlPath).replace(/^\/+/, '');
  const segs = rel.split(/[/\\]/);
  if (segs.length === 0 || segs.some((s) => s === '..' || s === '')) return { ok: false };
  const disk = join(gameDir, ...segs);
  const back = relative(gameDir, disk);
  if (back.startsWith('..') || isAbsolute(back)) return { ok: false };
  return { ok: true, disk };
}

/** URL 解码，畸形转义（`%ZZ`）返回 null 而不是抛——http 处理器里同步抛出去会杀掉进程。 */
export function decodeUrlPath(rawUrl) {
  try {
    return decodeURIComponent(String(rawUrl ?? '/').split('?')[0]);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- 404 分类

/**
 * **按设计就会 404** 的请求。它们出现在记录里是正常的，不算漏抽。
 *
 * 不做这个区分的话验收门永远红，红久了就没人看了——那比没有门更糟。
 */
export const EXPECTED_404 = [
  {
    pat: /\/sockets\.json$/,
    why: '动画挂点表是可选 sidecar（109 个包里只有 2 个有），运行时探测不到就降级，见 optional-asset-probe 卡',
  },
  {
    pat: /^\/__gamedraft-api\//,
    why: 'dev server 的中间件 API。打包产物里本来就没有它——存档因此走内存降级，页面顶部那条红横幅就是它的正确表现',
  },
  { pat: /^\/favicon\.ico$/, why: '浏览器自动请求，游戏不依赖' },
];

/** 命中返回那条豁免，否则 null（= 真的漏抽了）。 */
export function classify404(url) {
  for (const e of EXPECTED_404) if (e.pat.test(url)) return e;
  return null;
}

// ---------------------------------------------------- authoring 残留识别

/** 不该出现在任何产物里的 authoring 残留。 */
export const AUTHORING_LEAKS = [
  { pat: /\.py$/, why: '生成脚本' },
  { pat: /\.jsonl$/, why: '批处理日志' },
  { pat: /\.npy$/, why: 'numpy 中间件' },
  { pat: /\.dvc$/, why: 'DVC 指针' },
  // `.bak-20260810-200341.json` 这种带日期后缀的备份是以 `.json` 结尾的，
  // 只写 `*.bak` 抓不到它——真实存在于 public/assets/data 下。
  { pat: /\.bak(-[^/]*)?(\.[a-z0-9]+)?$/i, why: 'authoring 备份' },
  { pat: /\/preview\//, why: '编辑器预览图' },
  { pat: /scene_background_backups\//, why: '背景备份' },
  { pat: /character_setup_refs\//, why: '角色配置参考图' },
  { pat: /atlas\.meta\.json$/, why: '烘包期元数据' },
];

/** 命中返回那条规则，否则 null。 */
export function classifyLeak(rel) {
  for (const e of AUTHORING_LEAKS) if (e.pat.test(rel)) return e;
  return null;
}

// ---------------------------------------------------------- 清单落地比对

/**
 * 清单里的一条是不是真落地了。
 *
 * 清单记的是**源文件名**，而发行档会把 wav 转码成 ogg 再落地。逐字比对的话
 * 194 个音频会被全部误报成"没落地"，真正的漏拷反而被淹在里面看不见
 * ——这个坑当场踩过一次。
 *
 * @param rel 清单条目（相对产物根）
 * @param present 产物里实际有的路径集合
 */
export function manifestEntryLanded(rel, present) {
  if (present.has(rel)) return true;
  return rel.toLowerCase().endsWith('.wav') && present.has(`${rel.slice(0, -4)}.ogg`);
}

// ------------------------------------------------------ 光照烘焙新鲜度

/**
 * 烘焙时记的背景哈希与当前背景对不对得上。
 *
 * 判据与运行时逐字一致：`lighting/lighting.json` 的 `background_sha1` 是
 * `background.png` 的 SHA-1 **前若干位**（实测 12 位）。对不上时
 * `CharacterLightingSystem` 会把那个场景的角色光照**整个禁用**。
 *
 * 这一类问题所有别的门都抓不到：文件都在（素材审计过）、路径都对（零 404）、
 * 类型也对，唯独**内容换了**——重画了背景却没重烘光照。
 *
 * @param bakedSha1 lighting.json 里记的（短哈希）
 * @param actualSha1 background.png 的完整 SHA-1
 * @returns `{ ok }`；`ok:null` = 没记哈希，无从比对（不算失败）
 */
export function bakeFreshness(bakedSha1, actualSha1) {
  if (typeof bakedSha1 !== 'string' || !bakedSha1) {
    return { ok: null, reason: 'lighting.json 没有 background_sha1' };
  }
  if (typeof actualSha1 !== 'string' || !actualSha1) {
    return { ok: null, reason: '算不出 background.png 的哈希' };
  }
  // 按烘焙时记的长度截取再比：记的是短哈希，全长比一定不等
  const actual = actualSha1.slice(0, bakedSha1.length);
  return { ok: actual === bakedSha1, baked: bakedSha1, actual };
}

// -------------------------------------------------------- wav → ogg 引用改写

/**
 * 判断一个字符串是不是指向某个**已转码**的 wav，是就换成 `.ogg`。
 *
 * 只在该字符串确实指向转过码的文件时才改——全文替换 `.wav` 会误伤文案里提到的
 * 文件名、注释、以及没进包的路径。
 *
 * 认三种写法：完整相对路径（`resources/runtime/audio/x.wav`）、短名
 * （`audio/x.wav`，audio_config 里就是这么写的）、带前导斜杠的绝对 URL。
 *
 * @param s 原字符串
 * @param renamedRels 已转码文件的**相对产物根**路径集合（`resources/runtime/audio/...wav`）
 * @returns 换过的字符串；没命中则原样返回同一个引用
 */
export function swapWavRef(s, renamedRels) {
  if (typeof s !== 'string' || !s.toLowerCase().endsWith('.wav')) return s;
  const norm = s.replace(/^\/+/, '').replace(/\\/g, '/');
  const hit = renamedRels.has(norm)
    || renamedRels.has(`resources/runtime/${norm}`);
  return hit ? `${s.slice(0, -4)}.ogg` : s;
}
