import { describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';

import {
  BUILD_MARKER,
  bakeFreshness,
  checkOutputPath,
  checkStagingDir,
  classify404,
  outputDirDisposition,
  classifyLeak,
  decodeUrlPath,
  manifestEntryLanded,
  safeStaticPath,
  swapWavRef,
} from './build_helpers.mjs';

const ROOT = resolve('E:/proj');
const RELEASE = join(ROOT, 'release');
const GAME = join(ROOT, 'release', 'dev', 'game');

describe('产物目录护栏（rmSync 之前的最后一道闸）', () => {
  it('放行 release/ 之下的目录', () => {
    expect(checkStagingDir(RELEASE, join(RELEASE, 'dev')).ok).toBe(true);
    expect(checkStagingDir(RELEASE, join(RELEASE, 'release')).ok).toBe(true);
  });

  it('拒绝仓库根 —— `--out .` 就是递归删当前目录', () => {
    expect(checkStagingDir(RELEASE, ROOT).ok).toBe(false);
  });

  it('拒绝游戏数据目录 —— `--out public` 就是删掉 2.9 GB 素材树', () => {
    for (const d of ['public', 'src', 'resources', 'tools']) {
      expect(checkStagingDir(RELEASE, join(ROOT, d)).ok).toBe(false);
    }
  });

  it('拒绝往上跑', () => {
    expect(checkStagingDir(RELEASE, resolve(ROOT, '..')).ok).toBe(false);
  });

  it('拒绝 release 根自己 —— 它是容器，不是某一档的产物目录', () => {
    expect(checkStagingDir(RELEASE, RELEASE).ok).toBe(false);
  });

  it('拒绝参数漏了值时的布尔转字符串（会在 cwd 下建个叫 true 的目录）', () => {
    expect(checkStagingDir(RELEASE, String(true)).ok).toBe(false);
  });
});

describe('发布输出目录：路径体检（它会被清空重写）', () => {
  const REPO = resolve('E:/GameDev/GameDraft');

  it('放行仓库外的正常目录', () => {
    expect(checkOutputPath('D:/builds/current', REPO).ok).toBe(true);
    expect(checkOutputPath('D:/builds/2026-08-28T09-00', REPO).ok).toBe(true);
  });

  it('放行仓库内但不在源码树里的目录（比如 release/ 下面）', () => {
    expect(checkOutputPath(join(REPO, 'release', 'ship'), REPO).ok).toBe(true);
  });

  it('拒绝盘符根 —— 手滑传成 D:/ 就是灾难', () => {
    expect(checkOutputPath('D:/', REPO).ok).toBe(false);
    expect(checkOutputPath('D:\\', REPO).ok).toBe(false);
  });

  it('拒绝仓库根本身', () => {
    expect(checkOutputPath(REPO, REPO).ok).toBe(false);
  });

  it('拒绝仓库根的上级 —— 清它会连仓库一起清', () => {
    expect(checkOutputPath(resolve(REPO, '..'), REPO).ok).toBe(false);
    expect(checkOutputPath(resolve(REPO, '../..'), REPO).ok).toBe(false);
  });

  it('拒绝落进源码/游戏数据树', () => {
    for (const d of ['public', 'src', 'tools', 'resources', 'scripts', 'agent_docs', 'src-tauri', 'docs']) {
      const v = checkOutputPath(join(REPO, d, 'out'), REPO);
      expect(v.ok, d).toBe(false);
    }
  });

  it('空值直接拒', () => {
    expect(checkOutputPath('', REPO).ok).toBe(false);
    expect(checkOutputPath(undefined, REPO).ok).toBe(false);
    expect(checkOutputPath(true, REPO).ok).toBe(false); // --out-dir 后面漏了值
  });
});

describe('发布输出目录：覆盖策略', () => {
  it('不存在就建，空目录直接用', () => {
    expect(outputDirDisposition('missing').action).toBe('create');
    expect(outputDirDisposition('empty').action).toBe('use');
  });

  it('认得出是上一次构建 → 直接覆盖（编辑器手动 build 走这条）', () => {
    expect(outputDirDisposition('previous-build')).toEqual({ ok: true, action: 'overwrite' });
  });

  it('陌生的非空目录 → 拒绝，要 --force —— 防手滑清掉别的东西', () => {
    const v = outputDirDisposition('foreign');
    expect(v.ok).toBe(false);
    expect(v.reason).toContain(BUILD_MARKER);
    expect(outputDirDisposition('foreign', { force: true })).toEqual({ ok: true, action: 'overwrite' });
  });
});

describe('静态服务路径校验', () => {
  it('正常路径解析到产物目录下', () => {
    const r = safeStaticPath(GAME, '/assets/data/game_config.json');
    expect(r.ok).toBe(true);
    expect(r.disk).toBe(join(GAME, 'assets', 'data', 'game_config.json'));
  });

  it('根落到 index.html', () => {
    expect(safeStaticPath(GAME, '/').disk).toBe(join(GAME, 'index.html'));
  });

  it('挡住 POSIX 穿越', () => {
    expect(safeStaticPath(GAME, '/../../package.json').ok).toBe(false);
    expect(safeStaticPath(GAME, '/assets/../../../secret').ok).toBe(false);
  });

  it('挡住 Windows 反斜杠穿越 —— 只按 / 分段的话这条会漏', () => {
    expect(safeStaticPath(GAME, '/..\\..\\package.json').ok).toBe(false);
    expect(safeStaticPath(GAME, '/assets\\..\\..\\..\\secret').ok).toBe(false);
  });

  it('挡住空段（//、结尾斜杠这类）', () => {
    expect(safeStaticPath(GAME, '/assets//data').ok).toBe(false);
  });

  it('中文路径正常放行（场景名就是中文）', () => {
    const r = safeStaticPath(GAME, '/resources/runtime/scenes/雾津街头/background.png');
    expect(r.ok).toBe(true);
    expect(r.disk).toContain('雾津街头');
  });
});

describe('URL 解码', () => {
  it('正常解码，中文按 UTF-8 还原', () => {
    expect(decodeUrlPath('/%E9%9B%BE%E6%B4%A5.json')).toBe('/雾津.json');
  });

  it('去掉 query', () => {
    expect(decodeUrlPath('/a.png?v=1')).toBe('/a.png');
  });

  it('畸形转义返回 null 而不是抛 —— 抛出去会杀掉整个服务进程', () => {
    expect(decodeUrlPath('/%ZZ')).toBeNull();
    expect(decodeUrlPath('/%')).toBeNull();
  });
});

describe('404 分类', () => {
  it('挂点表探测是按设计的', () => {
    expect(classify404('/resources/runtime/animation/dog_anim/sockets.json')).not.toBeNull();
  });

  it('dev server API 在打包产物里缺席是按设计的', () => {
    expect(classify404('/__gamedraft-api/store/saves')).not.toBeNull();
  });

  it('favicon 是浏览器自己要的', () => {
    expect(classify404('/favicon.ico')).not.toBeNull();
  });

  it('真素材缺失不豁免 —— 这才是验收门要抓的', () => {
    expect(classify404('/resources/runtime/images/dialogue_portraits/clara/clara_calm.png')).toBeNull();
    expect(classify404('/resources/runtime/scenes/雾津街头/background.png')).toBeNull();
    expect(classify404('/resources/runtime/animation/dog_anim/atlas.png')).toBeNull();
  });

  it('不能因为路径里带 sockets.json 字样就豁免整条路径', () => {
    expect(classify404('/resources/runtime/images/sockets.json.png')).toBeNull();
  });
});

describe('authoring 残留识别', () => {
  it('抓得到常见残留', () => {
    for (const p of [
      'resources/runtime/audio/demo/batch_generate.py',
      'resources/runtime/audio/demo/batch_log.jsonl',
      'resources/runtime/scenes/x/depth_cache.npy',
      'resources/runtime/runtime.dvc',
      'resources/runtime/scenes/x/preview/a.png',
      'resources/runtime/scene_background_backups/a.png',
      'resources/runtime/character_setup_refs/a.png',
      'resources/runtime/animation/a/atlas.meta.json',
    ]) {
      expect(classifyLeak(p), p).not.toBeNull();
    }
  });

  it('抓得到带日期后缀的备份 —— 它以 .json 结尾，`*.bak` 的写法漏得掉', () => {
    expect(classifyLeak('assets/data/audio_config.bak-20260810-200341.json')).not.toBeNull();
    expect(classifyLeak('assets/data/x.bak')).not.toBeNull();
  });

  it('不误伤正常素材', () => {
    for (const p of [
      'assets/data/audio_config.json',
      'resources/runtime/images/ui/frame_wood.png',
      'resources/runtime/animation/a/anim.json',
      'resources/runtime/scenes/x/background.png',
    ]) {
      expect(classifyLeak(p), p).toBeNull();
    }
  });
});

describe('清单落地比对', () => {
  const present = new Set([
    'assets/data/game_config.json',
    'resources/runtime/audio/bgm/theme.ogg',
    'resources/runtime/images/ui/frame.png',
  ]);

  it('原样在的算落地', () => {
    expect(manifestEntryLanded('assets/data/game_config.json', present)).toBe(true);
  });

  it('清单记 .wav、产物是 .ogg 也算落地 —— 逐字比对会误报 194 个音频', () => {
    expect(manifestEntryLanded('resources/runtime/audio/bgm/theme.wav', present)).toBe(true);
  });

  it('真没落地的照样报出来 —— 不能因为放宽而漏掉真问题', () => {
    expect(manifestEntryLanded('resources/runtime/audio/sfx/gone.wav', present)).toBe(false);
    expect(manifestEntryLanded('resources/runtime/images/gone.png', present)).toBe(false);
  });

  it('只对 .wav 放宽，别的扩展名不许换皮', () => {
    expect(manifestEntryLanded('resources/runtime/images/ui/frame.jpg', present)).toBe(false);
  });
});

describe('光照烘焙新鲜度', () => {
  // 真实形状：lighting.json 记短哈希，background.png 算出来是全长 SHA-1
  const FULL = '1c49a742e82fee8a9e5c5866d713194fc09c8e1e';

  it('**重烘之后必须通过** —— 这条是"重烘完还能不能打包"的保证', () => {
    expect(bakeFreshness(FULL.slice(0, 12), FULL).ok).toBe(true);
  });

  it('哈希长度不同也认（记多少位就比多少位）', () => {
    expect(bakeFreshness(FULL.slice(0, 8), FULL).ok).toBe(true);
    expect(bakeFreshness(FULL.slice(0, 16), FULL).ok).toBe(true);
    expect(bakeFreshness(FULL, FULL).ok).toBe(true);
  });

  it('背景重画了没重烘 —— 拦下来，并把两个哈希都报出来', () => {
    const v = bakeFreshness('c2e151bb1c0a', FULL);
    expect(v.ok).toBe(false);
    expect(v.baked).toBe('c2e151bb1c0a');
    expect(v.actual).toBe('1c49a742e82f');
  });

  it('没记哈希 = 无从比对，不算失败（老烘焙产物可能就没这个字段）', () => {
    expect(bakeFreshness(undefined, FULL).ok).toBeNull();
    expect(bakeFreshness('', FULL).ok).toBeNull();
    expect(bakeFreshness(FULL.slice(0, 12), '').ok).toBeNull();
  });
});

describe('wav → ogg 引用改写', () => {
  const renamed = new Set([
    'resources/runtime/audio/bgm/theme.wav',
    'resources/runtime/audio/BGS/SWDRSLGDIR_01.wav',
  ]);

  it('认完整相对路径', () => {
    expect(swapWavRef('resources/runtime/audio/bgm/theme.wav', renamed))
      .toBe('resources/runtime/audio/bgm/theme.ogg');
  });

  it('认短名（audio_config 里就是这么写的）', () => {
    expect(swapWavRef('audio/bgm/theme.wav', renamed)).toBe('audio/bgm/theme.ogg');
  });

  it('认带前导斜杠的绝对 URL', () => {
    expect(swapWavRef('/resources/runtime/audio/bgm/theme.wav', renamed))
      .toBe('/resources/runtime/audio/bgm/theme.ogg');
  });

  it('大写目录名逐字符匹配，不做大小写折叠', () => {
    expect(swapWavRef('audio/BGS/SWDRSLGDIR_01.wav', renamed))
      .toBe('audio/BGS/SWDRSLGDIR_01.ogg');
  });

  it('没转码的 wav 原样不动 —— 全文替换会误伤没进包的路径', () => {
    expect(swapWavRef('audio/sfx/never_packaged.wav', renamed))
      .toBe('audio/sfx/never_packaged.wav');
  });

  it('不是 wav 的一概不碰（包括文案里提到文件名的情况）', () => {
    expect(swapWavRef('这段用的是 theme.wav 那一版', renamed)).toBe('这段用的是 theme.wav 那一版');
    expect(swapWavRef('audio/bgm/theme.ogg', renamed)).toBe('audio/bgm/theme.ogg');
    expect(swapWavRef(42, renamed)).toBe(42);
    expect(swapWavRef(null, renamed)).toBe(null);
  });
});
